import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cfg } from './config';

export interface LlmMetric {
  role: string;
  model: string;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

interface UsageRow {
  role: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

const SEP = '@@';

function readUsage(file: string): UsageRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function sumTokens(rows: UsageRow[], key: 'input_tokens' | 'output_tokens'): number | null {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0);
}

export function aggregateCaseUsage(caseDir: string): LlmMetric[] {
  const rows = readUsage(path.join(caseDir, 'llm-usage.jsonl'));
  const groups = new Map<string, UsageRow[]>();
  for (const r of rows) {
    const k = r.role + SEP + r.model;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  const out: LlmMetric[] = [];
  for (const [k, g] of groups) {
    const [role, model] = k.split(SEP);
    out.push({ role, model, turns: g.length, input_tokens: sumTokens(g, 'input_tokens'), output_tokens: sumTokens(g, 'output_tokens') });
  }
  return out;
}

export interface ModelMetric {
  model: string;
  turns: number;
  input_tokens: number | null;
  output_tokens: number | null;
  roles: string[];
  cases: number;
}

export function aggregateByModel(kbDir: string): ModelMetric[] {
  const casesDir = path.join(kbDir, 'cases');
  if (!fs.existsSync(casesDir)) return [];
  const byModel = new Map<string, { rows: UsageRow[]; roles: Set<string>; cases: Set<string> }>();
  for (const incident of fs.readdirSync(casesDir)) {
    const rows = readUsage(path.join(casesDir, incident, 'llm-usage.jsonl'));
    for (const r of rows) {
      let e = byModel.get(r.model);
      if (!e) {
        e = { rows: [], roles: new Set(), cases: new Set() };
        byModel.set(r.model, e);
      }
      e.rows.push(r);
      e.roles.add(r.role);
      e.cases.add(incident);
    }
  }
  const out: ModelMetric[] = [];
  for (const [model, e] of byModel) {
    out.push({
      model,
      turns: e.rows.length,
      input_tokens: sumTokens(e.rows, 'input_tokens'),
      output_tokens: sumTokens(e.rows, 'output_tokens'),
      roles: [...e.roles].sort(),
      cases: e.cases.size,
    });
  }
  return out.sort((a, b) => b.turns - a.turns);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = aggregateByModel(cfg.kbDir);
  console.log(JSON.stringify(report, null, 2));
}