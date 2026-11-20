import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countLastHour, recordTrigger } from '../workers/src/budget';
import { ciTrigger } from '../workers/src/activities';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-budget-'));

describe('hourly rerun ledger', () => {
  it('counts only entries within the last hour', () => {
    const dir = tmp();
    const t0 = 1_000_000_000_000;
    recordTrigger(dir, 'a:1', t0 - 3_700_000);
    recordTrigger(dir, 'a:2', t0 - 1000);
    expect(countLastHour(dir, t0)).toBe(1);
  });

  it('prunes old entries on write', () => {
    const dir = tmp();
    const t0 = 1_000_000_000_000;
    recordTrigger(dir, 'old', t0 - 3_700_000);
    recordTrigger(dir, 'new', t0);
    const lines = fs.readFileSync(path.join(dir, 'rerun-ledger.jsonl'), 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
  });
});

describe('G1 trigger guards (direct activity calls)', () => {
  it('rejects dag outside allowlist', async () => {
    await expect(
      ciTrigger({ incident_id: 'x', dag_id: 'not_allowed_dag', attempt: 1, max_reruns: 2 }),
    ).rejects.toThrow(/allowlist/);
  });

  it('rejects attempt over max_reruns', async () => {
    await expect(
      ciTrigger({ incident_id: 'x', dag_id: 'test_flash_attention_flow', attempt: 3, max_reruns: 2 }),
    ).rejects.toThrow(/exceeds max_reruns/);
  });

  it('rejects attempt < 1', async () => {
    await expect(
      ciTrigger({ incident_id: 'x', dag_id: 'test_flash_attention_flow', attempt: 0, max_reruns: 2 }),
    ).rejects.toThrow(/exceeds max_reruns/);
  });
});