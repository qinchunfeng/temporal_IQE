import type { CiFact } from './types';

const base = (): string => process.env.AIRFLOW_BASE_URL ?? '';
const enc = encodeURIComponent;

async function getToken(f: typeof fetch): Promise<string> {
  const res = await f(`${base()}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.AIRFLOW_USERNAME ?? '', password: process.env.AIRFLOW_PASSWORD ?? '' }),
  });
  if (!res.ok) throw new Error(`Airflow auth -> ${res.status}`);
  const d: any = await res.json();
  if (!d.access_token) throw new Error('Airflow auth: no access_token');
  return d.access_token;
}

export function mapAirflowState(s: string): CiFact['state'] {
  if (s === 'success') return 'success';
  if (s === 'failed') return 'failed';
  if (s === 'queued') return 'queued';
  return 'running';
}

export function extractLogTail(logsBody: any, maxLines = 40): string {
  const arr = Array.isArray(logsBody?.content) ? logsBody.content : Array.isArray(logsBody?.logs) ? logsBody.logs : [];
  const lines = arr.map((e: any) => (typeof e?.event === 'string' ? e.event : '')).filter(Boolean);
  return lines.slice(-maxLines).join('\n');
}

export async function airflowRunConf(dag_id: string, run_ref: string, f: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const t = await getToken(f);
  const res = await f(`${base()}/api/v2/dags/${enc(dag_id)}/dagRuns/${enc(run_ref)}`, { headers: { authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Airflow get conf -> ${res.status}`);
  const d: any = await res.json();
  return d.conf ?? {};
}

export async function airflowTrigger(
  dag_id: string,
  run_ref: string,
  conf: Record<string, unknown>,
  f: typeof fetch = fetch,
): Promise<{ run_ref: string; dedup: boolean }> {
  const t = await getToken(f);
  const res = await f(`${base()}/api/v2/dags/${enc(dag_id)}/dagRuns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
    body: JSON.stringify({ dag_run_id: run_ref, conf, logical_date: null }),
  });
  if (res.status === 409) return { run_ref, dedup: true };
  if (!res.ok) throw new Error(`Airflow trigger -> ${res.status}`);
  const d: any = await res.json();
  return { run_ref: d.dag_run_id ?? run_ref, dedup: false };
}

export async function airflowPoll(
  dag_id: string,
  run_ref: string,
  failedTasks: string[],
  f: typeof fetch = fetch,
): Promise<{ state: CiFact['state']; log_tail?: string }> {
  const t = await getToken(f);
  const res = await f(`${base()}/api/v2/dags/${enc(dag_id)}/dagRuns/${enc(run_ref)}`, { headers: { authorization: `Bearer ${t}` } });
  if (!res.ok) throw new Error(`Airflow poll -> ${res.status}`);
  const d: any = await res.json();
  const state = mapAirflowState(d.state);
  let log_tail: string | undefined;
  if ((state === 'failed' || state === 'success') && failedTasks.length > 0) {
    const task = failedTasks[0];
    let tryN = 1;
    const tiRes = await f(`${base()}/api/v2/dags/${enc(dag_id)}/dagRuns/${enc(run_ref)}/taskInstances/${enc(task)}`, { headers: { authorization: `Bearer ${t}` } });
    if (tiRes.ok) {
      const ti: any = await tiRes.json();
      tryN = ti.try_number ?? 1;
    }
    const logRes = await f(`${base()}/api/v2/dags/${enc(dag_id)}/dagRuns/${enc(run_ref)}/taskInstances/${enc(task)}/logs/${tryN}`, { headers: { authorization: `Bearer ${t}` } });
    if (logRes.ok) log_tail = extractLogTail(await logRes.json());
  }
  return { state, log_tail };
}