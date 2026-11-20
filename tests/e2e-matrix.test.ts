import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeConnection, type Worker } from '@temporalio/worker';
import { Connection, Client, WorkflowIdReusePolicy } from '@temporalio/client';
import { createWorkers } from '../workers/src/worker';
import { createFakeCiServer } from '../simulator/fake-ci';
import { caseWorkflow } from '../workers/src/case.workflow';
import { cfg, workDir } from '../workers/src/config';
import { validateCaseClose } from '../workers/src/validate';
import type { CaseInput, CaseClose } from '../workers/src/types';

let workers: Worker[];
let runPromises: Promise<void>[];
let nativeConn: NativeConnection;
let client: Client;
let ci: ReturnType<typeof createFakeCiServer>;
let ciPort = 0;

async function startWorkers(): Promise<void> {
  workers = await createWorkers(nativeConn);
  runPromises = workers.map((w) => w.run());
}

beforeAll(async () => {
  process.env.IQE_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-m2-work-'));
  // matrix fires >10 triggers; cap guard is covered by the dedicated cap=0 test
  process.env.IQE_HOURLY_RERUN_CAP = '1000';
  // M2 baseline + degradation drill: unreachable endpoints force stub fallback; real LLM is covered by e2e-m3
  for (const r of ['ROUTER', 'TRIAGE', 'REPRO', 'TICKET', 'REVIEW', 'REPORTING']) {
    process.env[`${r}_MODEL_BASE_URL`] = 'http://127.0.0.1:9/v1';
  }
  ci = createFakeCiServer();
  ciPort = await ci.start(0);
  process.env.FAKE_CI_URL = `http://127.0.0.1:${ciPort}`;
  nativeConn = await NativeConnection.connect({ address: cfg.temporalAddress });
  await startWorkers();
  const conn = await Connection.connect({ address: cfg.temporalAddress });
  client = new Client({ connection: conn, namespace: cfg.namespace });
}, 120_000);

afterAll(async () => {
  delete process.env.IQE_FAULT_INJECT;
  await Promise.all(workers.map((w) => w.shutdown()));
  await Promise.all(runPromises);
  await nativeConn.close();
  await client.connection.close();
  await ci.close();
});

function makeInput(scenario: CaseInput['dry_run_scenario'], timeoutMinutes = 1, dag = 'test_flash_attention_flow'): CaseInput {
  return {
    schema_version: '3.0',
    incident_id: `m2-${scenario}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    source: 'simulator',
    ci: {
      provider: 'airflow',
      base_url: 'http://172.31.0.2:8080',
      dag_id: dag,
      run_ref: 'manual__2026-11-03T06:57:10.329997+00:00',
      failed_tasks: ['run_kernel_test'],
    },
    policy: { timeout_minutes: timeoutMinutes },
    dry_run_scenario: scenario,
    issued_at: new Date().toISOString(),
  };
}

async function runCase(input: CaseInput): Promise<CaseClose> {
  const handle = await client.workflow.start(caseWorkflow, {
    taskQueue: 'iqe.case',
    workflowId: input.incident_id,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    args: [input],
  });
  return (await handle.result()) as CaseClose;
}

async function withFault<T>(fault: string, fn: () => Promise<T>): Promise<T> {
  process.env.IQE_FAULT_INJECT = fault;
  try {
    return await fn();
  } finally {
    delete process.env.IQE_FAULT_INJECT;
  }
}

const stats = async (): Promise<{ creations: number; dedups: number }> =>
  (await fetch(`http://127.0.0.1:${ciPort}/stats`)).json() as any;

const notifications = (incident: string): Array<{ kind: string; detail: string }> =>
  fs
    .readFileSync(path.join(workDir(), 'notifications.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((n) => n.incident_id === incident);

describe('M2 dry_run full matrix', () => {
  it('wall-clock timeout (running run) -> inconclusive + abandoned', async () => {
    const input = makeInput('timeout', 0.1);
    const close = await runCase(input);
    expect(close.verdict).toBe('inconclusive');
    expect(validateCaseClose(close)).toBe(true);
    const repro = JSON.parse(fs.readFileSync(path.join(cfg.kbDir, 'cases', input.incident_id, 'repro.json'), 'utf8'));
    expect(repro.abandoned_run_refs.length).toBeGreaterThanOrEqual(1);
    expect(notifications(input.incident_id).some((n) => n.kind === 'case_inconclusive')).toBe(true);
  }, 90_000);

  it('router failure -> retry exhausted -> fastPath fallback completes', async () => {
    const close = await withFault('router_fail', () => runCase(makeInput('stable_fail')));
    expect(close.state).toBe('closed');
    expect(close.verdict).toBe('reproduced');
  }, 90_000);

  it('router mandate violation -> workflow rejects -> fastPath fallback', async () => {
    const close = await withFault('router_bad_mandate', () => runCase(makeInput('stable_fail')));
    expect(close.state).toBe('closed');
    expect(close.verdict).toBe('reproduced');
  }, 90_000);

  it('review reject once -> bounded rework -> approved', async () => {
    const input = makeInput('stable_fail');
    const close = await withFault('review_reject_once', () => runCase(input));
    expect(close.state).toBe('closed');
    expect(close.verdict).toBe('reproduced');
    const ticket = JSON.parse(fs.readFileSync(path.join(cfg.kbDir, 'cases', input.incident_id, 'ticket.json'), 'utf8'));
    expect(ticket.draft.title).toMatch(/rework/);
  }, 90_000);

  it('review reject always -> rework cap -> inconclusive + notification', async () => {
    const input = makeInput('stable_fail');
    const close = await withFault('review_reject_always', () => runCase(input));
    expect(close.verdict).toBe('inconclusive');
    expect(notifications(input.incident_id).some((n) => /review_rejected_exhausted/.test(n.detail))).toBe(true);
  }, 90_000);

  it('need_info timeout -> inconclusive + escalation notification', async () => {
    const input = makeInput('stable_fail', 0.1);
    const close = await withFault('review_need_info', () => runCase(input));
    expect(close.verdict).toBe('inconclusive');
    expect(notifications(input.incident_id).some((n) => n.detail === 'need_info_timeout')).toBe(true);
  }, 90_000);

  it('dag outside allowlist -> trigger rejected -> dead + notification', async () => {
    const input = makeInput('stable_fail', 1, 'not_allowed_dag');
    const close = await runCase(input);
    expect(close.state).toBe('dead');
    expect(close.verdict).toBe('error');
    expect(notifications(input.incident_id).some((n) => n.kind === 'case_dead')).toBe(true);
  }, 90_000);

  it('hourly rerun cap=0 -> trigger rejected -> dead', async () => {
    const prev = process.env.IQE_HOURLY_RERUN_CAP;
    process.env.IQE_HOURLY_RERUN_CAP = '0';
    try {
      const close = await runCase(makeInput('stable_fail'));
      expect(close.state).toBe('dead');
    } finally {
      if (prev === undefined) delete process.env.IQE_HOURLY_RERUN_CAP;
      else process.env.IQE_HOURLY_RERUN_CAP = prev;
    }
  }, 90_000);

  it('trigger crash after creation -> at-least-once retry dedups (G7)', async () => {
    const before = await stats();
    const input = makeInput('stable_fail');
    const close = await withFault('trigger_crash_once', () => runCase(input));
    expect(close.verdict).toBe('reproduced');
    const after = await stats();
    expect(after.creations - before.creations).toBe(2);
    expect(after.dedups - before.dedups).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('kill workers during CI wait -> resume without re-trigger (crash recovery)', async () => {
    const before = await stats();
    const input = makeInput('paused', 0.3);
    const handle = await client.workflow.start(caseWorkflow, {
      taskQueue: 'iqe.case',
      workflowId: input.incident_id,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      args: [input],
    });
    const deadline = Date.now() + 15_000;
    while ((await stats()).creations <= before.creations && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    expect((await stats()).creations).toBe(before.creations + 1);

    await Promise.all(workers.map((w) => w.shutdown()));
    await Promise.all(runPromises);
    await startWorkers();

    const close = (await handle.result()) as CaseClose;
    expect(close.verdict).toBe('inconclusive');
    expect((await stats()).creations).toBe(before.creations + 1);
  }, 120_000);
});