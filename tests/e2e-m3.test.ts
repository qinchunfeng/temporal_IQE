import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeConnection, type Worker } from '@temporalio/worker';
import { Connection, Client, WorkflowIdReusePolicy } from '@temporalio/client';
import { createWorkers } from '../workers/src/worker';
import { createFakeCiServer } from '../simulator/fake-ci';
import { caseWorkflow } from '../workers/src/case.workflow';
import { cfg } from '../workers/src/config';
import { validateCaseClose } from '../workers/src/validate';
import { failureSignature } from '../shared/signature';
import type { CaseInput, CaseClose } from '../workers/src/types';

let workers: Worker[];
let runPromises: Promise<void>[];
let nativeConn: NativeConnection;
let client: Client;
let ci: ReturnType<typeof createFakeCiServer>;
let ciPort = 0;
let signature = '';

beforeAll(async () => {
  process.env.IQE_WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-m3-work-'));
  process.env.IQE_HOURLY_RERUN_CAP = '1000';
  process.env.IQE_HISTORY_REUSE = 'off';
  ci = createFakeCiServer();
  ciPort = await ci.start(0);
  process.env.FAKE_CI_URL = `http://127.0.0.1:${ciPort}`;
  const log = await (await fetch(`${process.env.FAKE_CI_URL}/original-log`)).text();
  signature = failureSignature(['run_kernel_test'], log);
  nativeConn = await NativeConnection.connect({ address: cfg.temporalAddress });
  workers = await createWorkers(nativeConn);
  runPromises = workers.map((w) => w.run());
  const conn = await Connection.connect({ address: cfg.temporalAddress });
  client = new Client({ connection: conn, namespace: cfg.namespace });
}, 120_000);

afterAll(async () => {
  delete process.env.IQE_FAULT_INJECT;
  process.env.IQE_HISTORY_REUSE = 'off';
  await Promise.all(workers.map((w) => w.shutdown()));
  await Promise.all(runPromises);
  await nativeConn.close();
  await client.connection.close();
  await ci.close();
});

function makeInput(tag: string, withHistoryKeys = false): CaseInput {
  const input: CaseInput = {
    schema_version: '3.0',
    incident_id: `m3-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    source: 'simulator',
    ci: {
      provider: 'airflow',
      base_url: 'http://172.31.0.2:8080',
      dag_id: 'test_flash_attention_flow',
      run_ref: 'manual__2026-11-03T06:57:10.329997+00:00',
      failed_tasks: ['run_kernel_test'],
    },
    policy: { timeout_minutes: 3 },
    dry_run_scenario: 'stable_fail',
    issued_at: new Date().toISOString(),
  };
  if (withHistoryKeys) {
    input.signature = signature;
    input.evidence_refs = { config_rev: 'm3-test-rev-1' };
  }
  return input;
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

const slice = (incident: string, name: string): any =>
  JSON.parse(fs.readFileSync(path.join(cfg.kbDir, 'cases', incident, name), 'utf8'));

describe('M3 real-LLM dry_run', () => {
  it('stable_fail with real LLM roles -> reproduced, schema-valid, transcripts kept', async () => {
    const input = makeInput('llm');
    const close = await runCase(input);
    expect(close.state).toBe('closed');
    expect(close.verdict).toBe('reproduced');
    expect(validateCaseClose(close)).toBe(true);
    expect(slice(input.incident_id, 'triage.json').qualifies_for_reproduction).toBe(true);
    expect(slice(input.incident_id, 'review.json').decision).toBe('approve');
    const routerTranscript = path.join(cfg.kbDir, 'cases', input.incident_id, 'transcript', 'router.ndjson');
    expect(fs.existsSync(routerTranscript)).toBe(true);
    const lines = fs.readFileSync(routerTranscript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.session === 'router-global')).toBe(true);
    expect(fs.existsSync(path.join(cfg.kbDir, 'cases', input.incident_id, 'transcript', 'triage.ndjson'))).toBe(true);
    const llm = close.metrics.llm ?? [];
    const roles = llm.map((x) => x.role);
    for (const r of ['router', 'triage', 'ticket', 'review']) expect(roles).toContain(r);
    expect(llm.every((x) => typeof x.model === 'string' && x.model.length > 0)).toBe(true);
    expect(llm.find((x) => x.role === 'router')!.turns).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(path.join(cfg.kbDir, 'cases', input.incident_id, 'llm-usage.jsonl'))).toBe(true);
    const notifFile = path.join(process.env.IQE_WORK_DIR!, 'notifications.jsonl');
    const rejected = fs.existsSync(notifFile)
      ? fs.readFileSync(notifFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
          .some((n) => n.incident_id === input.incident_id && n.kind === 'acceptance_rejected')
      : false;
    expect(rejected).toBe(false);
  }, 240_000);

  it('router_bad_json -> extractJson fails -> fastPath fallback still closes', async () => {
    process.env.IQE_FAULT_INJECT = 'router_bad_json';
    try {
      const close = await runCase(makeInput('badjson'));
      expect(close.state).toBe('closed');
      expect(close.verdict).toBe('reproduced');
    } finally {
      delete process.env.IQE_FAULT_INJECT;
    }
  }, 240_000);

  it('history reuse OFF: identical signature+conf does NOT skip', async () => {
    const a = makeInput('hist-a', true);
    const closeA = await runCase(a);
    expect(closeA.verdict).toBe('reproduced');
    const b = makeInput('hist-b', true);
    const closeB = await runCase(b);
    expect(closeB.verdict).toBe('reproduced');
    expect(closeB.metrics.history_skip).toBe(false);
    expect(closeB.metrics.reruns_triggered).toBeGreaterThan(0);
    expect(slice(b.incident_id, 'repro.json').history_match ?? null).toBeNull();
  }, 300_000);

  it('history reuse ON: third identical case skips repro, code-verified refs', async () => {
    const seed = makeInput('hist-seed', true);
    const closeSeed = await runCase(seed);
    expect(closeSeed.verdict).toBe('reproduced');
    process.env.IQE_HISTORY_REUSE = 'on';
    try {
      const c = makeInput('hist-c', true);
      const closeC = await runCase(c);
      expect(closeC.state).toBe('closed');
      expect(closeC.verdict).toBe('skipped');
      expect(closeC.metrics.history_skip).toBe(true);
      expect(closeC.metrics.reruns_triggered).toBe(0);
      const repro = slice(c.incident_id, 'repro.json');
      expect(repro.history_match.reused_case_id).toBe(seed.incident_id);
      expect(repro.attempts).toBe(0);
    } finally {
      process.env.IQE_HISTORY_REUSE = 'off';
    }
  }, 300_000);
});