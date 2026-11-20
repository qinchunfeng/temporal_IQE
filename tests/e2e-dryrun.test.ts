import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeConnection, type Worker } from '@temporalio/worker';
import { Connection, Client, WorkflowIdReusePolicy, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { createWorkers } from '../workers/src/worker';
import { createFakeCiServer } from '../simulator/fake-ci';
import { caseWorkflow } from '../workers/src/case.workflow';
import { cfg } from '../workers/src/config';
import { validateCaseClose } from '../workers/src/validate';
import type { CaseInput, CaseClose } from '../workers/src/types';

let workers: Worker[];
let runPromises: Promise<void>[];
let nativeConn: NativeConnection;
let client: Client;
let ci: ReturnType<typeof createFakeCiServer>;

beforeAll(async () => {
  process.env.IQE_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-m1-work-'));
  // M1/M2 baseline runs roles degraded (unreachable endpoint -> stub fallback); real LLM is covered by e2e-m3
  for (const r of ['ROUTER', 'TRIAGE', 'REPRO', 'TICKET', 'REVIEW', 'REPORTING']) {
    process.env[`${r}_MODEL_BASE_URL`] = 'http://127.0.0.1:9/v1';
  }
  ci = createFakeCiServer();
  const port = await ci.start(0);
  process.env.FAKE_CI_URL = `http://127.0.0.1:${port}`;
  nativeConn = await NativeConnection.connect({ address: cfg.temporalAddress });
  workers = await createWorkers(nativeConn);
  runPromises = workers.map((w) => w.run());
  const conn = await Connection.connect({ address: cfg.temporalAddress });
  client = new Client({ connection: conn, namespace: cfg.namespace });
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((w) => w.shutdown()));
  await Promise.all(runPromises);
  await nativeConn.close();
  await client.connection.close();
  await ci.close();
});

function makeInput(scenario: CaseInput['dry_run_scenario'], timeoutMinutes = 1): CaseInput {
  return {
    schema_version: '3.0',
    incident_id: `e2e-${scenario}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    source: 'simulator',
    ci: {
      provider: 'airflow',
      base_url: 'http://172.31.0.2:8080',
      dag_id: 'test_flash_attention_flow',
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

describe('M1 e2e dry_run', () => {
  it('stable_fail -> reproduced, closed, schema-valid, KB persisted', async () => {
    const input = makeInput('stable_fail');
    const close = await runCase(input);
    expect(close.verdict).toBe('reproduced');
    expect(close.state).toBe('closed');
    expect(validateCaseClose(close)).toBe(true);
    expect(close.metrics.reruns_triggered).toBe(2);
    const dir = path.join(cfg.kbDir, 'cases', input.incident_id);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).state).toBe('closed');
    for (const f of ['triage.json', 'repro.json', 'ticket.json', 'review.json']) {
      expect(fs.existsSync(path.join(dir, f))).toBe(true);
    }
    const repro = JSON.parse(fs.readFileSync(path.join(dir, 'repro.json'), 'utf8'));
    expect(repro.signature_match_count).toBe(2);
    expect(close.lesson_ref).toBeTruthy();
  }, 90_000);

  it('all_pass -> not_reproduced', async () => {
    const close = await runCase(makeInput('all_pass'));
    expect(close.verdict).toBe('not_reproduced');
    expect(close.state).toBe('closed');
    expect(validateCaseClose(close)).toBe(true);
  }, 90_000);

  it('flaky -> flaky', async () => {
    const close = await runCase(makeInput('flaky'));
    expect(close.verdict).toBe('flaky');
    expect(validateCaseClose(close)).toBe(true);
  }, 90_000);

  it('paused + short wall clock -> inconclusive with abandoned refs', async () => {
    const input = makeInput('paused', 0.1);
    const close = await runCase(input);
    expect(close.verdict).toBe('inconclusive');
    expect(validateCaseClose(close)).toBe(true);
    const repro = JSON.parse(fs.readFileSync(path.join(cfg.kbDir, 'cases', input.incident_id, 'repro.json'), 'utf8'));
    expect(repro.abandoned_run_refs.length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('duplicate incident_id is rejected (workflowId dedup)', async () => {
    const input = makeInput('stable_fail');
    const first = await client.workflow.start(caseWorkflow, {
      taskQueue: 'iqe.case',
      workflowId: input.incident_id,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      args: [input],
    });
    await expect(
      client.workflow.start(caseWorkflow, {
        taskQueue: 'iqe.case',
        workflowId: input.incident_id,
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        args: [input],
      }),
    ).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);
    await first.result();
  }, 90_000);
});