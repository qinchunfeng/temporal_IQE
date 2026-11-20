import fs from 'node:fs';
import path from 'node:path';

const HOUR_MS = 3_600_000;

function readLedger(file: string, nowMs: number): Array<{ ts: number; key: string }> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => nowMs - r.ts < HOUR_MS);
}

export function countLastHour(stateDir: string, nowMs: number): number {
  return readLedger(path.join(stateDir, 'rerun-ledger.jsonl'), nowMs).length;
}

export function recordTrigger(stateDir: string, key: string, nowMs: number): void {
  const file = path.join(stateDir, 'rerun-ledger.jsonl');
  const rows = readLedger(file, nowMs);
  rows.push({ ts: nowMs, key });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}