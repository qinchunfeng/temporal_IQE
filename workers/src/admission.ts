import fs from 'node:fs';
import path from 'node:path';

export interface AdmissionResult {
  ok: boolean;
  reason?: string;
}

export function checkSource(source: string, allowlist: string[]): AdmissionResult {
  if (!allowlist.includes(source)) {
    return { ok: false, reason: `G8: source not in allowlist: ${source}` };
  }
  return { ok: true };
}

export function checkIngestRate(
  stateDir: string,
  hourlyCap: number,
  nowMs: number,
): AdmissionResult {
  const file = path.join(stateDir, 'admission-state.json');
  let state = { window_start: nowMs, count: 0 };
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (nowMs - state.window_start >= 3_600_000) state = { window_start: nowMs, count: 0 };
  }
  if (state.count >= hourlyCap) {
    return { ok: false, reason: `G8: ingest hourly cap reached (${hourlyCap}/h)` };
  }
  state.count += 1;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
  return { ok: true };
}