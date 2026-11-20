import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface HistoryMatch {
  reused_case_id: string;
  matched_at: string;
  original_verdict: string;
}

export function confHash(configRev?: string): string | null {
  if (!configRev) return null;
  return 'sha256:' + createHash('sha256').update(configRev).digest('hex');
}

export function findHistoryMatch(
  kbDir: string,
  input: { incident_id?: string; signature?: string; ci: { provider: string }; evidence_refs?: { config_rev?: string } },
  nowMs: number,
  windowDays = 7,
): HistoryMatch | null {
  if (!input.signature) return null;
  const ch = confHash(input.evidence_refs?.config_rev);
  if (!ch) return null;
  const indexFile = path.join(kbDir, 'index.jsonl');
  if (!fs.existsSync(indexFile)) return null;
  const windowMs = windowDays * 86_400_000;
  const rows = fs.readFileSync(indexFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const row of rows.reverse()) {
    if (row.verdict !== 'reproduced') continue;
    if (row.incident_id === input.incident_id) continue;
    const caseFile = path.join(kbDir, 'cases', row.incident_id, 'case.json');
    if (!fs.existsSync(caseFile)) continue;
    if (nowMs - fs.statSync(caseFile).mtimeMs > windowMs) continue;
    const orig = JSON.parse(fs.readFileSync(caseFile, 'utf8')).input;
    if (!orig) continue;
    if (orig.ci?.provider !== input.ci.provider) continue;
    if (orig.signature !== input.signature) continue;
    if (confHash(orig.evidence_refs?.config_rev) !== ch) continue;
    return { reused_case_id: row.incident_id, matched_at: new Date(nowMs).toISOString(), original_verdict: row.verdict };
  }
  return null;
}