import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aggregateCaseUsage, aggregateByModel } from '../workers/src/metrics';

let root: string;

function seedUsage(kb: string, incident: string, rows: Array<Record<string, unknown>>): void {
  const dir = path.join(kb, 'cases', incident);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llm-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

const row = (role: string, model: string, input: number | null, output: number | null) => ({ role, model, input_tokens: input, output_tokens: output });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-metrics-'));
});

describe('aggregateCaseUsage', () => {
  it('groups by role+model, counts turns, sums numeric tokens', () => {
    const dir = path.join(root, 'cases', 'c1');
    seedUsage(root, 'c1', [
      row('router', 'flash', 10, 5),
      row('router', 'flash', 20, 7),
      row('triage', 'flash', 30, 9),
      row('review', 'pro', 40, 11),
    ]);
    const m = aggregateCaseUsage(dir);
    const router = m.find((x) => x.role === 'router')!;
    expect(router.turns).toBe(2);
    expect(router.input_tokens).toBe(30);
    expect(router.output_tokens).toBe(12);
    expect(m.find((x) => x.role === 'review')!.model).toBe('pro');
    expect(m.length).toBe(3);
  });

  it('null tokens stay null when upstream reports none (proxy zeros)', () => {
    seedUsage(root, 'c2', [row('router', 'flash', null, null), row('triage', 'flash', null, null)]);
    const m = aggregateCaseUsage(path.join(root, 'cases', 'c2'));
    expect(m.every((x) => x.input_tokens === null && x.output_tokens === null)).toBe(true);
    expect(m.find((x) => x.role === 'router')!.turns).toBe(1);
  });

  it('partial nulls sum only the numeric values', () => {
    seedUsage(root, 'c3', [row('ticket', 'flash', null, null), row('ticket', 'flash', 12, 4)]);
    const t = aggregateCaseUsage(path.join(root, 'cases', 'c3')).find((x) => x.role === 'ticket')!;
    expect(t.input_tokens).toBe(12);
    expect(t.output_tokens).toBe(4);
    expect(t.turns).toBe(2);
  });

  it('empty/missing ledger yields empty array', () => {
    expect(aggregateCaseUsage(path.join(root, 'cases', 'ghost'))).toEqual([]);
  });
});

describe('aggregateByModel', () => {
  it('rolls up across cases by model with roles and case count', () => {
    seedUsage(root, 'a', [row('router', 'flash', 10, 5), row('review', 'pro', 40, 11)]);
    seedUsage(root, 'b', [row('router', 'flash', null, null), row('triage', 'flash', 20, 6)]);
    const report = aggregateByModel(root);
    const flash = report.find((x) => x.model === 'flash')!;
    expect(flash.turns).toBe(3);
    expect(flash.input_tokens).toBe(30);
    expect(flash.output_tokens).toBe(11);
    expect(flash.cases).toBe(2);
    expect(flash.roles).toEqual(['router', 'triage']);
    const pro = report.find((x) => x.model === 'pro')!;
    expect(pro.turns).toBe(1);
    expect(pro.cases).toBe(1);
    expect(report[0].model).toBe('flash');
  });

  it('empty kb yields empty report', () => {
    expect(aggregateByModel(root)).toEqual([]);
  });
});