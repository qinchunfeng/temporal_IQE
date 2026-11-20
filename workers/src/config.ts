import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { EffectivePolicy } from './types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
loadEnv({ path: path.join(ROOT, 'workers', '.env') });

const num = (k: string, d: number): number => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : Number(v);
};

export const cfg = {
  temporalAddress: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'iqe-v3',
  mode: (process.env.IQE_EXECUTION_MODE ?? 'dry_run') as 'dry_run' | 'live',
  ciAllowlist: (process.env.IQE_CI_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  maxReruns: num('IQE_MAX_RERUNS', 2),
  timeoutMinutes: num('IQE_TIMEOUT_MINUTES', 30),
  hourlyRerunCap: num('IQE_HOURLY_RERUN_CAP', 10),
  maxRework: num('IQE_MAX_REWORK', 1),
  historyReuse: process.env.IQE_HISTORY_REUSE ?? 'off',
  ciProvider: process.env.CI_PROVIDER ?? 'airflow',
  ticketSink: process.env.IQE_TICKET_SINK ?? 'mock',
  kbDir: path.join(ROOT, 'kb'),
  workDir: path.join(ROOT, 'work'),
  sourceAllowlist: (process.env.IQE_SOURCE_ALLOWLIST ?? 'simulator,monitor').split(',').map((s) => s.trim()).filter(Boolean),
  ingestHourlyCap: num('IQE_INGEST_HOURLY_CAP', 60),
};

export const fakeCiUrl = (): string => process.env.FAKE_CI_URL ?? 'http://127.0.0.1:8200';
export const workDir = (): string => process.env.IQE_WORK_DIR ?? cfg.workDir;
export const hourlyRerunCap = (): number => num('IQE_HOURLY_RERUN_CAP', cfg.hourlyRerunCap);
export const faultInject = (): string => (cfg.mode === 'dry_run' ? process.env.IQE_FAULT_INJECT ?? '' : '');
export const historyReuse = (): string => process.env.IQE_HISTORY_REUSE ?? cfg.historyReuse;
export const historyWindowDays = (): number => num('IQE_HISTORY_WINDOW_DAYS', 7);

export function roleModel(role: string): { baseUrl: string; apiKey: string; model: string } {
  const p = role.toUpperCase();
  return {
    baseUrl: process.env[`${p}_MODEL_BASE_URL`] ?? 'http://127.0.0.1:3000/v1',
    apiKey: process.env[`${p}_MODEL_API_KEY`] ?? '',
    model: process.env[`${p}_MODEL_ID`] ?? (role === 'review' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'),
  };
}

export function effectivePolicy(p?: CaseInputPolicy): EffectivePolicy {
  return {
    max_reruns: Math.min(p?.max_reruns ?? cfg.maxReruns, cfg.maxReruns),
    timeout_minutes: Math.min(p?.timeout_minutes ?? cfg.timeoutMinutes, cfg.timeoutMinutes),
    hourly_rerun_cap: Math.min(p?.hourly_rerun_cap ?? cfg.hourlyRerunCap, cfg.hourlyRerunCap),
    max_rework: cfg.maxRework,
  };
}

type CaseInputPolicy = { max_reruns?: number; timeout_minutes?: number; hourly_rerun_cap?: number };