import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { confHash, findHistoryMatch } from '../workers/src/history';

const SIG = 'sig:sha256:deadbeef';
let kb: string;

function seedCase(id: string, opts: { verdict?: string; provider?: string; signature?: string; configRev?: string; ageDays?: number } = {}): void {
  const dir = path.join(kb, 'cases', id);
  fs.mkdirSync(dir, { recursive: true });
  const input = {
    incident_id: id,
    ci: { provider: opts.provider ?? 'airflow' },
    signature: opts.signature ?? SIG,
    evidence_refs: opts.configRev === undefined ? { config_rev: 'rev-1' } : opts.configRev === null ? {} : { config_rev: opts.configRev },
  };
  const caseFile = path.join(dir, 'case.json');
  fs.writeFileSync(caseFile, JSON.stringify({ input }));
  if (opts.ageDays) {
    const t = (Date.now() - opts.ageDays * 86_400_000) / 1000;
    fs.utimesSync(caseFile, t, t);
  }
  fs.appendFileSync(path.join(kb, 'index.jsonl'), JSON.stringify({ incident_id: id, verdict: opts.verdict ?? 'reproduced' }) + '\n');
}

const query = (over: Record<string, unknown> = {}) => ({
  incident_id: 'new-case',
  signature: SIG,
  ci: { provider: 'airflow' },
  evidence_refs: { config_rev: 'rev-1' },
  ...over,
});

beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-history-'));
});

describe('confHash', () => {
  it('hashes deterministically, null when absent', () => {
    expect(confHash('rev-1')).toBe(confHash('rev-1'));
    expect(confHash('rev-1')).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(confHash(undefined)).toBeNull();
    expect(confHash('')).toBeNull();
  });
});

describe('findHistoryMatch', () => {
  it('matches reproduced case with same signature+conf+provider', () => {
    seedCase('case-a');
    const m = findHistoryMatch(kb, query(), Date.now());
    expect(m?.reused_case_id).toBe('case-a');
    expect(m?.original_verdict).toBe('reproduced');
  });

  it('returns null without signature or config_rev', () => {
    seedCase('case-a');
    expect(findHistoryMatch(kb, query({ signature: undefined }), Date.now())).toBeNull();
    expect(findHistoryMatch(kb, query({ evidence_refs: {} }), Date.now())).toBeNull();
  });

  it('rejects non-reproduced verdicts', () => {
    seedCase('case-a', { verdict: 'flaky' });
    seedCase('case-b', { verdict: 'not_reproduced' });
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
  });

  it('rejects signature / conf / provider mismatch', () => {
    seedCase('case-a', { signature: 'sig:sha256:other' });
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
    seedCase('case-b', { configRev: 'rev-2' });
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
    seedCase('case-c', { provider: 'jenkins' });
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
  });

  it('rejects cases older than the window', () => {
    seedCase('case-a', { ageDays: 8 });
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
    seedCase('case-b', { ageDays: 6 });
    expect(findHistoryMatch(kb, query(), Date.now())?.reused_case_id).toBe('case-b');
  });

  it('never matches itself; prefers newest eligible row', () => {
    seedCase('new-case');
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
    seedCase('case-old');
    seedCase('case-new');
    expect(findHistoryMatch(kb, query(), Date.now())?.reused_case_id).toBe('case-new');
  });

  it('returns null when index or case file missing', () => {
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
    fs.writeFileSync(path.join(kb, 'index.jsonl'), JSON.stringify({ incident_id: 'ghost', verdict: 'reproduced' }) + '\n');
    expect(findHistoryMatch(kb, query(), Date.now())).toBeNull();
  });
});