import { ApplicationFailure } from '@temporalio/activity';
import fs from 'node:fs';
import path from 'node:path';
import { cfg, effectivePolicy, fakeCiUrl, workDir, hourlyRerunCap, faultInject, historyReuse, historyWindowDays } from './config';
import { countLastHour, recordTrigger } from './budget';
import { callLLM } from './harness';
import { extractJson } from './json';
import { findHistoryMatch, type HistoryMatch } from './history';
import { aggregateCaseUsage } from './metrics';
import { airflowRunConf, airflowTrigger, airflowPoll } from './ci-airflow';
import { ROUTER_SYSTEM, TRIAGE_SYSTEM, TICKET_SYSTEM, REVIEW_SYSTEM } from './prompts';
import { assertValid, validateCaseInput, validateDispatch, validateTriage, validateRepro, validateTicket, validateReview, validateCaseClose } from './validate';
import * as kb from './kb';
import { validateMandate, type DispatchDecision } from './mandate';
import { fastPath } from './fastpath';
import { failureSignature, signatureMatch } from '../../shared/signature';
import { fallbackVerdict } from '../../shared/verdict';
import type { State } from '../../shared/statemachine';
import type { CaseInput, CaseClose, EffectivePolicy, TriageSlice, ReproSlice, TicketSlice, ReviewSlice, CiFact } from './types';

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${url} -> ${res.status}`);
  return res.json();
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

export async function initCase(input: CaseInput): Promise<EffectivePolicy> {
  assertValid(validateCaseInput, input, 'case-input');
  kb.ensureCase(input.incident_id, input);
  return effectivePolicy(input.policy);
}

export async function setState(id: string, to: State): Promise<void> {
  kb.setState(id, to);
}

export async function historyCandidate(input: CaseInput): Promise<HistoryMatch | null> {
  if (historyReuse() !== 'on') return null;
  return findHistoryMatch(cfg.kbDir, input, Date.now(), historyWindowDays());
}

export async function routerDispatch(input: CaseInput, candidate: HistoryMatch | null): Promise<DispatchDecision> {
  const fault = faultInject();
  if (fault === 'router_fail') throw new Error('simulated router failure (bad JSON / unavailable)');
  if (fault === 'router_bad_mandate') {
    return { action: 'execute', why: 'simulated mandate violation' } as unknown as DispatchDecision;
  }
  let text: string;
  if (fault === 'router_bad_json') {
    text = 'sorry, I cannot answer in JSON';
  } else {
    const practicesDir = path.join(cfg.kbDir, 'best-practices');
    const practices = fs.existsSync(practicesDir) ? fs.readdirSync(practicesDir).slice(-5) : [];
    const r = await callLLM({
      role: 'router',
      session: 'router-global',
      resume: true,
      system: ROUTER_SYSTEM,
      incident_id: input.incident_id,
      user: JSON.stringify({
        task: 'entry_dispatch',
        input: { incident_id: input.incident_id, ci: input.ci, signature: input.signature, scenario: input.dry_run_scenario },
        history_candidate: candidate,
        best_practices: practices,
      }),
    });
    text = r.text;
  }
  const parsed = extractJson(text) as DispatchDecision;
  assertValid(validateDispatch, parsed, 'dispatch-decision');
  const m = validateMandate(parsed);
  if (!m.ok) throw new Error(`mandate violation: ${m.errors.join('; ')}`);
  if (parsed.action === 'skip') {
    if (historyReuse() !== 'on') return fastPath();
    const verified = findHistoryMatch(cfg.kbDir, input, Date.now(), historyWindowDays());
    if (!verified) return fastPath();
    parsed.refs = [`kb/cases/${verified.reused_case_id}/card.json`];
    parsed.skip_reason = `history_match: ${verified.reused_case_id} reproduced within ${historyWindowDays()}d (code-verified)`;
  }
  return parsed;
}

export async function triageRun(input: CaseInput): Promise<TriageSlice> {
  let slice: TriageSlice;
  try {
    let logTail: string;
    if (cfg.mode === 'live' && input.ci.dag_id) {
      logTail = (await airflowPoll(input.ci.dag_id, input.ci.run_ref, input.ci.failed_tasks)).log_tail ?? '';
    } else {
      logTail = (await getJson(`${fakeCiUrl()}/original-log?dag_id=${encodeURIComponent(input.ci.dag_id ?? '')}`)).log_tail;
    }
    const r = await callLLM({
      role: 'triage',
      session: `triage-${input.incident_id}`,
      resume: true,
      system: TRIAGE_SYSTEM,
      user: JSON.stringify({ failed_tasks: input.ci.failed_tasks, log_tail: logTail }),
      incident_id: input.incident_id,
    });
    const p = extractJson(r.text) as TriageSlice;
    slice = { ...p, confidence: Math.min(1, Math.max(0, Number(p.confidence) || 0)) };
    assertValid(validateTriage, slice, 'triage slice');
  } catch {
    slice = {
      classification: 'test',
      confidence: 0.9,
      summary: `[fallback] ${input.ci.dag_id ?? input.ci.job_id} failed tasks: ${input.ci.failed_tasks.join(', ')}`,
      suspected_root_cause: 'unknown (triage degraded)',
      qualifies_for_reproduction: true,
    };
  }
  kb.writeSlice('triage', input.incident_id, 'triage.json', slice);
  return slice;
}

const crashedKeys = new Set<string>();

export async function ciTrigger(a: {
  incident_id: string;
  dag_id: string;
  attempt: number;
  max_reruns: number;
  scenario?: string;
  original_run_ref?: string;
}): Promise<{ run_ref: string }> {
  if (!cfg.ciAllowlist.includes(a.dag_id)) {
    throw ApplicationFailure.nonRetryable(`G1: dag not in allowlist: ${a.dag_id}`);
  }
  if (a.attempt < 1 || a.attempt > a.max_reruns) {
    throw ApplicationFailure.nonRetryable(`attempt ${a.attempt} exceeds max_reruns ${a.max_reruns}`);
  }
  const key = `${a.incident_id}:${a.attempt}`;
  if (countLastHour(workDir(), Date.now()) >= hourlyRerunCap()) {
    throw ApplicationFailure.nonRetryable(`G-budget: hourly rerun cap reached (${hourlyRerunCap()}/h)`);
  }
  const run_ref = `repro__${a.incident_id}__${a.attempt}`;
  if (cfg.mode === 'live') {
    const conf = a.original_run_ref ? await airflowRunConf(a.dag_id, a.original_run_ref) : {};
    const lr = await airflowTrigger(a.dag_id, run_ref, conf);
    if (!lr.dedup) recordTrigger(workDir(), key, Date.now());
    return { run_ref: lr.run_ref };
  }
  const r = await postJson(fakeCiUrl() + '/trigger', {
    dag_id: a.dag_id,
    run_ref,
    attempt: a.attempt,
    scenario: a.scenario ?? 'stable_fail',
    idempotency_key: key,
  });
  if (!r.dedup) recordTrigger(workDir(), key, Date.now());
  if (faultInject() === 'trigger_crash_once' && !crashedKeys.has(key)) {
    crashedKeys.add(key);
    throw new Error('simulated worker crash after trigger (at-least-once retry expected)');
  }
  return { run_ref: r.run_ref };
}

export async function ciPoll(run_ref: string, dag_id?: string, failedTasks?: string[]): Promise<{ state: CiFact['state']; log_tail?: string }> {
  if (cfg.mode === 'live' && dag_id) return airflowPoll(dag_id, run_ref, failedTasks ?? []);
  return getJson(`${fakeCiUrl()}/runs/${encodeURIComponent(run_ref)}`);
}

export async function reproFinalize(
  input: CaseInput,
  facts: CiFact[],
  abandoned: string[],
  qualifies = true,
): Promise<ReproSlice> {
  let baseline: string | undefined;
  if (facts.some((f) => f.state === 'failed')) {
    if (cfg.mode === 'live' && input.ci.dag_id) {
      const orig = await airflowPoll(input.ci.dag_id, input.ci.run_ref, input.ci.failed_tasks);
      baseline = failureSignature(input.ci.failed_tasks, orig.log_tail ?? '');
    } else {
      const orig = await getJson(`${fakeCiUrl()}/original-log?dag_id=${encodeURIComponent(input.ci.dag_id ?? '')}`);
      baseline = failureSignature(input.ci.failed_tasks, orig.log_tail);
    }
  }
  const reruns: ReproSlice['reruns'] = facts.map((f) => ({
    attempt: f.attempt,
    run_ref: f.run_ref,
    state: f.state,
    signature_match: f.state === 'failed' && baseline !== undefined
      ? signatureMatch(baseline, failureSignature(input.ci.failed_tasks, f.log_tail ?? ''))
      : undefined,
    duration_seconds: f.duration_seconds,
  }));
  for (const ref of abandoned) {
    reruns.push({ attempt: reruns.length + 1, run_ref: ref, state: 'abandoned' });
  }
  const failed = facts.filter((f) => f.state === 'failed');
  const effective = facts.filter((f) => f.state === 'failed' || f.state === 'success');
  const matched = reruns.filter((r) => r.signature_match === true).length;
  const fv = fallbackVerdict(reruns, { infraBlocked: abandoned.length > 0, qualifies });
  const slice: ReproSlice = {
    verdict: fv.verdict,
    verdict_reason: fv.reason + (abandoned.length > 0 ? `; abandoned: ${abandoned.join(', ')}` : ''),
    attempts: facts.length + abandoned.length,
    failed_attempts: failed.length,
    signature_match_count: matched,
    rate: effective.length > 0 ? failed.length / effective.length : undefined,
    reruns,
    abandoned_run_refs: abandoned.length > 0 ? abandoned : undefined,
  };
  assertValid(validateRepro, slice, 'repro slice');
  kb.writeSlice('repro', input.incident_id, 'repro.json', slice);
  return slice;
}

export async function writeReproSlice(input: CaseInput, slice: ReproSlice): Promise<void> {
  assertValid(validateRepro, slice, 'repro slice');
  kb.writeSlice('repro', input.incident_id, 'repro.json', slice);
}

export async function ticketRun(
  input: CaseInput,
  triage: TriageSlice,
  repro: ReproSlice,
  review?: ReviewSlice,
): Promise<TicketSlice> {
  const component = input.ci.dag_id ?? input.ci.job_id ?? 'unknown';
  const reworkSuffix = review ? ` (rework: ${review.reason})` : '';
  let draft: TicketSlice['draft'];
  try {
    const r = await callLLM({
      role: 'ticket',
      session: `ticket-${input.incident_id}`,
      resume: true,
      system: TICKET_SYSTEM,
      user: JSON.stringify({ component, triage, repro: { verdict: repro.verdict, verdict_reason: repro.verdict_reason, attempts: repro.attempts }, reviewer_rejection: review?.reason ?? null }),
      incident_id: input.incident_id,
    });
    const p = extractJson(r.text) as { title?: string; priority?: string; component?: string; assignee_hint?: string };
    draft = {
      title: (p.title ?? `[IQE] ${component}: ${repro.verdict}`) + reworkSuffix,
      priority: (['low', 'medium', 'high'].includes(p.priority ?? '') ? p.priority : repro.verdict === 'reproduced' ? 'high' : 'medium') as TicketSlice['draft']['priority'],
      component: p.component ?? component,
      assignee_hint: p.assignee_hint || undefined,
    };
  } catch {
    draft = {
      title: `[IQE] ${component}: ${repro.verdict}${reworkSuffix}`,
      priority: repro.verdict === 'reproduced' ? 'high' : 'medium',
      component,
    };
  }
  const slice: TicketSlice = {
    draft,
    duplicate_of_case: null,
    external_ticket_ref: cfg.ticketSink === 'mock' ? `mock-ticket://${input.incident_id}` : undefined,
  };
  assertValid(validateTicket, slice, 'ticket slice');
  kb.writeSlice('ticket', input.incident_id, 'ticket.json', slice);
  return slice;
}

const reviewFaultSeen = new Set<string>();

export async function reviewRun(
  input: CaseInput,
  _slices: { triage: TriageSlice; repro: ReproSlice; ticket: TicketSlice },
  round = 0,
): Promise<ReviewSlice> {
  const fault = faultInject();
  let slice: ReviewSlice;
  if (fault === 'review_reject_always' || (fault === 'review_reject_once' && !reviewFaultSeen.has(input.incident_id))) {
    reviewFaultSeen.add(input.incident_id);
    slice = { decision: 'reject', checks: { diagnosis: true, evidence: true, reproducibility: true, duplicate: true }, reason: 'simulated reviewer rejection' };
  } else if (fault === 'review_need_info') {
    slice = { decision: 'need_info', checks: { diagnosis: true, evidence: true, reproducibility: true, duplicate: true }, reason: 'simulated reviewer request for more info' };
  } else {
    try {
      const r = await callLLM({
        role: 'review',
        session: `review-${input.incident_id}-${round}`,
        resume: false,
        system: REVIEW_SYSTEM,
        user: JSON.stringify(_slices),
        incident_id: input.incident_id,
      });
      slice = extractJson(r.text) as ReviewSlice;
      assertValid(validateReview, slice, 'review slice');
    } catch {
      slice = { decision: 'approve', checks: { diagnosis: true, evidence: true, reproducibility: true, duplicate: true }, reason: '[fallback] review degraded, evidence chain present' };
    }
  }
  assertValid(validateReview, slice, 'review slice');
  kb.writeSlice('review', input.incident_id, 'review.json', slice);
  return slice;
}

export async function notify(a: { incident_id: string; kind: string; detail: string }): Promise<void> {
  fs.mkdirSync(workDir(), { recursive: true });
  fs.appendFileSync(
    path.join(workDir(), 'notifications.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...a }) + '\n',
  );
}

export async function routerAccept(a: {
  incident_id: string;
  verdict: string;
  repro_reason: string;
  evidence?: {
    attempts: number;
    failed_attempts: number;
    signature_match_count: number;
    reruns: Array<{ run_ref: string; state: string; signature_match?: boolean }>;
    baseline_source: string;
  };
}): Promise<{ accepted: boolean; why: string }> {
  try {
    if (faultInject() === 'router_fail') throw new Error('simulated router failure');
    const r = await callLLM({
      role: 'router',
      session: 'router-global',
      resume: true,
      system: ROUTER_SYSTEM,
      incident_id: a.incident_id,
      user: JSON.stringify({ task: 'close_acceptance', incident_id: a.incident_id, verdict: a.verdict, repro_reason: a.repro_reason, evidence: a.evidence ?? null }),
    });
    const p = extractJson(r.text) as { accepted?: boolean; why?: string };
    if (typeof p.accepted !== 'boolean') throw new Error('acceptance missing boolean');
    if (!p.accepted) {
      await notify({ incident_id: a.incident_id, kind: 'acceptance_rejected', detail: p.why ?? 'no reason' });
    }
    return { accepted: p.accepted, why: p.why ?? '' };
  } catch {
    return { accepted: true, why: 'degraded: acceptance unavailable, code verdict stands' };
  }
}

export async function distillLesson(input: CaseInput, repro: ReproSlice): Promise<{ lesson_ref: string }> {
  const text = [
    `# Lesson: ${input.incident_id}`,
    `- signature: ${input.signature ?? '(computed at repro)'}`,
    `- classification: see triage.json`,
    `- verdict: ${repro.verdict} (${repro.verdict_reason})`,
    `- reruns: ${repro.attempts}, failed: ${repro.failed_attempts}, signature matches: ${repro.signature_match_count}`,
  ].join('\n');
  return { lesson_ref: kb.writeLesson(input.incident_id, text) };
}

export async function closeCase(a: {
  input: CaseInput;
  verdict: ReproSlice['verdict'];
  state: 'closed' | 'dead';
  ticket_ref?: string;
  metrics: CaseClose['metrics'];
  lesson_ref?: string;
}): Promise<CaseClose> {
  const close: CaseClose = {
    schema_version: '3.0',
    incident_id: a.input.incident_id,
    verdict: a.verdict,
    state: a.state,
    ticket_ref: a.ticket_ref,
    evidence_dir: `kb/cases/${a.input.incident_id}/`,
    metrics: { ...a.metrics, llm: aggregateCaseUsage(path.join(cfg.kbDir, 'cases', a.input.incident_id)) },
    lesson_ref: a.lesson_ref,
  };
  assertValid(validateCaseClose, close, 'case-close');
  kb.setState(a.input.incident_id, a.state);
  kb.appendIndex(close);
  return close;
}