import fs from 'node:fs';
import path from 'node:path';
import { cfg, workDir, roleModel } from './config';

export interface LlmResult {
  text: string;
  model: string;
  usage: { input_tokens: number | null; output_tokens: number | null };
}

const MAX_SESSION_MESSAGES = 20;

export async function callLLM(opts: {
  role: string;
  session: string;
  resume: boolean;
  system: string;
  user: string;
  incident_id?: string;
  fetchImpl?: typeof fetch;
}): Promise<LlmResult> {
  const { baseUrl, apiKey, model } = roleModel(opts.role);
  const sessDir = path.join(workDir(), 'sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  const sessFile = path.join(sessDir, `${opts.session}.json`);

  let history: Array<{ role: string; content: string }> = [];
  if (opts.resume && fs.existsSync(sessFile)) {
    history = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  }
  const messages = [
    { role: 'system', content: opts.system },
    ...history.slice(-MAX_SESSION_MESSAGES),
    { role: 'user', content: opts.user },
  ];

  const res = await (opts.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`LLM ${opts.role} HTTP ${res.status}`);
  const d: any = await res.json();
  const text = d.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`LLM ${opts.role}: empty completion`);

  const usage = {
    input_tokens: d.usage?.prompt_tokens ? d.usage.prompt_tokens : null,
    output_tokens: d.usage?.completion_tokens ? d.usage.completion_tokens : null,
  };

  if (opts.resume) {
    history.push({ role: 'user', content: opts.user }, { role: 'assistant', content: text });
    fs.writeFileSync(sessFile, JSON.stringify(history.slice(-MAX_SESSION_MESSAGES)));
  }

  const ts = new Date().toISOString();
  const tDir = opts.incident_id
    ? path.join(cfg.kbDir, 'cases', opts.incident_id, 'transcript')
    : path.join(workDir(), 'transcripts');
  fs.mkdirSync(tDir, { recursive: true });
  fs.appendFileSync(
    path.join(tDir, `${opts.role}.ndjson`),
    JSON.stringify({ ts, role: opts.role, session: opts.session, model, usage, response: text }) + '\n',
  );
  if (opts.incident_id) {
    fs.appendFileSync(
      path.join(cfg.kbDir, 'cases', opts.incident_id, 'llm-usage.jsonl'),
      JSON.stringify({ ts, role: opts.role, model, session: opts.session, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens }) + '\n',
    );
  }

  return { text, model, usage };
}