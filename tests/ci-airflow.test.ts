import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mapAirflowState, extractLogTail, airflowTrigger, airflowPoll, airflowRunConf } from '../workers/src/ci-airflow';

const savedBase = process.env.AIRFLOW_BASE_URL;
beforeAll(() => {
  process.env.AIRFLOW_BASE_URL = 'http://airflow.mock';
  process.env.AIRFLOW_USERNAME = 'u';
  process.env.AIRFLOW_PASSWORD = 'p';
});
afterAll(() => {
  if (savedBase === undefined) delete process.env.AIRFLOW_BASE_URL;
  else process.env.AIRFLOW_BASE_URL = savedBase;
});

type Route = (url: string, method: string, body: any) => { status: number; body: any } | undefined;
function mockFetch(route: Route, calls: Array<{ url: string; method: string; body?: any }> = []): typeof fetch {
  return (async (url: any, init: any = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    if (String(url).endsWith('/auth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok' }) };
    const r = route(String(url), method, body) ?? { status: 404, body: { detail: 'not found' } };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
}

describe('mapAirflowState', () => {
  it('maps terminal and non-terminal states', () => {
    expect(mapAirflowState('success')).toBe('success');
    expect(mapAirflowState('failed')).toBe('failed');
    expect(mapAirflowState('queued')).toBe('queued');
    expect(mapAirflowState('running')).toBe('running');
    expect(mapAirflowState('restarting')).toBe('running');
  });
});

describe('extractLogTail', () => {
  it('joins event text from Airflow v2 content array', () => {
    const body = { content: [{ event: 'a' }, { event: 'b' }, { event: 'c' }] };
    expect(extractLogTail(body)).toBe('a\nb\nc');
  });
  it('keeps only the last maxLines', () => {
    const body = { content: Array.from({ length: 50 }, (_, i) => ({ event: `l${i}` })) };
    const tail = extractLogTail(body, 5);
    expect(tail).toBe('l45\nl46\nl47\nl48\nl49');
  });
  it('falls back to legacy logs key', () => {
    expect(extractLogTail({ logs: [{ event: 'x' }, { event: 'y' }] })).toBe('x\ny');
  });
  it('filters non-string events and handles empty body', () => {
    expect(extractLogTail({ content: [{ event: 'x' }, { event: 123 }, {}] })).toBe('x');
    expect(extractLogTail({})).toBe('');
    expect(extractLogTail(null)).toBe('');
  });
});

describe('airflowTrigger', () => {
  it('posts dag_run_id+conf and returns run_ref', async () => {
    const calls: any[] = [];
    const f = mockFetch((url, method, body) => {
      if (method === 'POST' && url.endsWith('/dagRuns')) {
        expect(body.dag_run_id).toBe('repro__inc__1');
        expect(body.conf).toEqual({ RESIZE: true });
        return { status: 200, body: { dag_run_id: 'repro__inc__1', state: 'queued' } };
      }
    }, calls);
    const r = await airflowTrigger('D', 'repro__inc__1', { RESIZE: true }, f);
    expect(r).toEqual({ run_ref: 'repro__inc__1', dedup: false });
    expect(calls.some((c) => c.url.endsWith('/auth/token'))).toBe(true);
  });
  it('409 -> dedup true (idempotent re-trigger)', async () => {
    const f = mockFetch((_u, method) => (method === 'POST' ? { status: 409, body: {} } : undefined));
    const r = await airflowTrigger('D', 'repro__inc__1', {}, f);
    expect(r.dedup).toBe(true);
  });
  it('non-ok -> throws', async () => {
    const f = mockFetch((_u, method) => (method === 'POST' ? { status: 500, body: {} } : undefined));
    await expect(airflowTrigger('D', 'r', {}, f)).rejects.toThrow(/Airflow trigger -> 500/);
  });
});

describe('airflowRunConf', () => {
  it('returns original run conf', async () => {
    const f = mockFetch((url) => (url.endsWith('/dagRuns/orig') ? { status: 200, body: { conf: { OS_IMAGE: 'x' } } } : undefined));
    expect(await airflowRunConf('D', 'orig', f)).toEqual({ OS_IMAGE: 'x' });
  });
});

describe('airflowPoll', () => {
  it('failed run fetches task try_number then log tail', async () => {
    const calls: any[] = [];
    const f = mockFetch((url) => {
      if (url.endsWith('/dagRuns/R')) return { status: 200, body: { state: 'failed' } };
      if (url.endsWith('/taskInstances/run_4-wait-ready')) return { status: 200, body: { try_number: 2 } };
      if (url.endsWith('/taskInstances/run_4-wait-ready/logs/2')) return { status: 200, body: { content: [{ event: 'boom' }, { timestamp: 't', event: 'exit 1' }] } };
    }, calls);
    const r = await airflowPoll('D', 'R', ['run_4-wait-ready'], f);
    expect(r.state).toBe('failed');
    expect(r.log_tail).toBe('boom\nexit 1');
    expect(calls.some((c) => c.url.endsWith('/logs/2'))).toBe(true);
  });
  it('running run does not fetch logs', async () => {
    const calls: any[] = [];
    const f = mockFetch((url) => (url.endsWith('/dagRuns/R') ? { status: 200, body: { state: 'running' } } : undefined), calls);
    const r = await airflowPoll('D', 'R', ['t'], f);
    expect(r.state).toBe('running');
    expect(r.log_tail).toBeUndefined();
    expect(calls.some((c) => c.url.includes('/logs/'))).toBe(false);
  });
  it('success run with no failed tasks skips log fetch', async () => {
    const f = mockFetch((url) => (url.endsWith('/dagRuns/R') ? { status: 200, body: { state: 'success' } } : undefined));
    const r = await airflowPoll('D', 'R', [], f);
    expect(r.state).toBe('success');
    expect(r.log_tail).toBeUndefined();
  });
});

describe('airflow auth failures', () => {
  it('auth non-ok throws', async () => {
    const f = (async (url: any) => {
      if (String(url).endsWith('/auth/token')) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await expect(airflowTrigger('D', 'r', {}, f)).rejects.toThrow(/Airflow auth -> 401/);
  });
});