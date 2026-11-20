import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config';
import { assertTransition, type State } from '../../shared/statemachine';
import type { CaseInput } from './types';

export const caseDir = (id: string): string => path.join(cfg.kbDir, 'cases', id);

const SLICE_WRITERS: Record<string, string> = {
  'triage.json': 'triage',
  'repro.json': 'repro',
  'ticket.json': 'ticket',
  'review.json': 'review',
};

export function ensureCase(id: string, input: CaseInput): void {
  const dir = caseDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'case.json');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify({ incident_id: id, state: 'new', input, created_at: new Date().toISOString() }, null, 2));
  }
}

export function readState(id: string): State {
  return JSON.parse(fs.readFileSync(path.join(caseDir(id), 'case.json'), 'utf8')).state as State;
}

export function setState(id: string, to: State): void {
  const file = path.join(caseDir(id), 'case.json');
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertTransition(cur.state as State, to);
  cur.state = to;
  cur.stage_updated_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
}

export function writeSlice(role: string, id: string, name: string, data: unknown): void {
  if (SLICE_WRITERS[name] !== role) {
    throw new Error(`single-writer violation: role ${role} cannot write ${name}`);
  }
  fs.writeFileSync(path.join(caseDir(id), name), JSON.stringify(data, null, 2));
}

export function appendIndex(row: unknown): void {
  fs.mkdirSync(cfg.kbDir, { recursive: true });
  fs.appendFileSync(path.join(cfg.kbDir, 'index.jsonl'), JSON.stringify(row) + '\n');
}

export function writeLesson(id: string, text: string): string {
  const dir = path.join(cfg.kbDir, 'best-practices');
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join('kb', 'best-practices', `${id}.md`);
  fs.writeFileSync(path.join(cfg.kbDir, 'best-practices', `${id}.md`), text);
  return rel;
}