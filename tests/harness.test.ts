import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callLLM } from '../workers/src/harness';

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

function mockFetch(capture: Array<any>, content = '{"ok":true}', usage = { prompt_tokens: 0, completion_tokens: 0 }) {
  return (async (_url: string, init: any) => {
    capture.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], usage }) };
  }) as unknown as typeof fetch;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-harness-'));
  process.env.IQE_WORK_DIR = tmp;
  for (const k of ['TRIAGE_MODEL_BASE_URL', 'TRIAGE_MODEL_API_KEY', 'TRIAGE_MODEL_ID']) {
    savedEnv[k] = process.env[k];
  }
  process.env.TRIAGE_MODEL_BASE_URL = 'http://mock.local/v1';
  process.env.TRIAGE_MODEL_API_KEY = 'test-key';
  process.env.TRIAGE_MODEL_ID = 'test-model';
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.IQE_WORK_DIR;
});

const base = { role: 'triage', system: 'sys', user: 'u1' };

describe('callLLM harness', () => {
  it('returns text/model, maps zero usage to null, writes transcript', async () => {
    const cap: any[] = [];
    const r = await callLLM({ ...base, session: 's-basic', resume: false, fetchImpl: mockFetch(cap) });
    expect(r.text).toBe('{"ok":true}');
    expect(r.model).toBe('test-model');
    expect(r.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(cap[0].model).toBe('test-model');
    expect(cap[0].messages[0]).toEqual({ role: 'system', content: 'sys' });
    const t = fs.readFileSync(path.join(tmp, 'transcripts', 'triage.ndjson'), 'utf8').trim().split('\n');
    expect(JSON.parse(t[t.length - 1]).session).toBe('s-basic');
  });

  it('keeps real token counts when upstream reports them', async () => {
    const r = await callLLM({ ...base, session: 's-usage', resume: false, fetchImpl: mockFetch([], 'x', { prompt_tokens: 11, completion_tokens: 7 }) });
    expect(r.usage).toEqual({ input_tokens: 11, output_tokens: 7 });
  });

  it('resume=true persists history and replays it on next call', async () => {
    const cap: any[] = [];
    await callLLM({ ...base, session: 's-resume', resume: true, user: 'first', fetchImpl: mockFetch(cap, 'a1') });
    await callLLM({ ...base, session: 's-resume', resume: true, user: 'second', fetchImpl: mockFetch(cap, 'a2') });
    const msgs = cap[1].messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[1].content).toBe('first');
    expect(msgs[2].content).toBe('a1');
    expect(msgs[3].content).toBe('second');
    const sess = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 's-resume.json'), 'utf8'));
    expect(sess.length).toBe(4);
  });

  it('resume=false neither loads nor saves session', async () => {
    const cap: any[] = [];
    await callLLM({ ...base, session: 's-noresume', resume: false, user: 'first', fetchImpl: mockFetch(cap, 'a1') });
    await callLLM({ ...base, session: 's-noresume', resume: false, user: 'second', fetchImpl: mockFetch(cap, 'a2') });
    expect(cap[1].messages.length).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'sessions', 's-noresume.json'))).toBe(false);
  });

  it('caps stored session at 20 messages', async () => {
    for (let i = 0; i < 12; i++) {
      await callLLM({ ...base, session: 's-cap', resume: true, user: `u${i}`, fetchImpl: mockFetch([], `a${i}`) });
    }
    const sess = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions', 's-cap.json'), 'utf8'));
    expect(sess.length).toBe(20);
    expect(sess[0].content).toBe('u2');
  });

  it('throws on HTTP error', async () => {
    const bad = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(callLLM({ ...base, session: 's-err', resume: false, fetchImpl: bad })).rejects.toThrow(/HTTP 401/);
  });

  it('throws on empty completion', async () => {
    const empty = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })) as unknown as typeof fetch;
    await expect(callLLM({ ...base, session: 's-empty', resume: false, fetchImpl: empty })).rejects.toThrow(/empty completion/);
  });
});