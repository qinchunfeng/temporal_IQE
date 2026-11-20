import { proxyActivities, sleep, condition, setHandler, defineSignal } from '@temporalio/workflow';
import type * as activities from './activities';
import { validateMandate } from './mandate';
import { fastPath } from './fastpath';
import type { CaseInput, CaseClose, EffectivePolicy, TriageSlice, ReproSlice, TicketSlice, CiFact } from './types';

const { initCase, setState, closeCase } = proxyActivities<typeof activities>({
  taskQueue: 'iqe.case',
  startToCloseTimeout: '1 minute',
});
const { routerDispatch, routerAccept, historyCandidate } = proxyActivities<typeof activities>({
  taskQueue: 'iqe.router',
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 2 },
});
const { triageRun } = proxyActivities<typeof activities>({ taskQueue: 'iqe.triage', startToCloseTimeout: '5 minutes' });
const { ciTrigger, ciPoll, reproFinalize, writeReproSlice } = proxyActivities<typeof activities>({
  taskQueue: 'iqe.repro',
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});
const { ticketRun } = proxyActivities<typeof activities>({ taskQueue: 'iqe.ticket', startToCloseTimeout: '5 minutes' });
const { reviewRun } = proxyActivities<typeof activities>({ taskQueue: 'iqe.review', startToCloseTimeout: '5 minutes' });
const { distillLesson, notify } = proxyActivities<typeof activities>({ taskQueue: 'iqe.reporting', startToCloseTimeout: '2 minutes' });

export const needInfoSignal = defineSignal<[string]>('need_info');

const HOPS_CAP = 8;
const POLL_INTERVAL_MS = 1000;
// Date.now() is deterministic inside the Temporal workflow sandbox
const now = (): number => Date.now();

export async function caseWorkflow(input: CaseInput): Promise<CaseClose> {
  const start = now();
  const policy: EffectivePolicy = await initCase(input);
  const deadline = start + policy.timeout_minutes * 60_000;
  const stages: Record<string, number> = {};
  let hops = 0;
  const hop = (): void => {
    hops += 1;
    if (hops > HOPS_CAP) throw new Error(`hops budget exceeded (${HOPS_CAP})`);
  };
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = now();
    const r = await fn();
    stages[name] = (now() - t) / 1000;
    return r;
  };

  let infoArrived: string | undefined;
  setHandler(needInfoSignal, (s: string) => {
    infoArrived = s;
  });

  let repro: ReproSlice | undefined;
  let ticket: TicketSlice | undefined;
  let historySkip = false;

  const finish = async (state: 'closed' | 'dead', verdict: ReproSlice['verdict'], lessonRef?: string, reason?: string): Promise<CaseClose> => {
    if (state === 'dead' || verdict === 'inconclusive') {
      await notify({ incident_id: input.incident_id, kind: state === 'dead' ? 'case_dead' : 'case_inconclusive', detail: reason ?? verdict });
    }
    return closeCase({
      input,
      verdict,
      state,
      ticket_ref: ticket?.external_ticket_ref,
      lesson_ref: lessonRef,
      metrics: {
        tat_seconds: (now() - start) / 1000,
        stages,
        reruns_triggered: repro?.attempts ?? 0,
        history_skip: historySkip,
      },
    });
  };

  try {
    hop();
    let candidate = null;
    try {
      candidate = await historyCandidate(input);
    } catch {
      candidate = null;
    }
    let dispatch;
    try {
      dispatch = await routerDispatch(input, candidate);
    } catch {
      dispatch = fastPath();
    }
    if (!validateMandate(dispatch).ok) dispatch = fastPath();

    if (dispatch.action === 'skip') {
      historySkip = true;
      const ref = dispatch.refs?.[0] ?? '';
      const reusedId = ref.match(/kb\/cases\/([^/]+)\//)?.[1] ?? 'unknown';
      repro = {
        verdict: 'skipped',
        verdict_reason: dispatch.skip_reason ?? 'history match',
        attempts: 0,
        failed_attempts: 0,
        signature_match_count: 0,
        reruns: [],
        history_match: { reused_case_id: reusedId },
      };
      await writeReproSlice(input, repro);
      return await finish('closed', 'skipped');
    }
    if (dispatch.action === 'ask') {
      const ok = await condition(() => infoArrived !== undefined, Math.max(1000, Math.min(60_000, deadline - now())));
      if (!ok) dispatch = fastPath();
    }

    hop();
    const triage: TriageSlice = await stage('triage', () => triageRun(input));
    await setState(input.incident_id, 'triaged');

    hop();
    if (triage.qualifies_for_reproduction) {
      await setState(input.incident_id, 'reproducing');
      repro = await stage('repro', () => runRepro(input, policy, deadline));
    } else {
      repro = await reproFinalize(input, [], [], false);
    }

    hop();
    ticket = await stage('ticket', () => ticketRun(input, triage, repro!));
    await setState(input.incident_id, 'ticketed');

    let rework = 0;
    let reviewRound = 0;
    for (;;) {
      hop();
      await setState(input.incident_id, 'reviewing');
      const review = await stage('review', () => reviewRun(input, { triage, repro: repro!, ticket: ticket! }, reviewRound));
      reviewRound += 1;
      if (review.decision === 'approve') break;
      if (review.decision === 'reject' && rework < policy.max_rework) {
        rework += 1;
        hop();
        ticket = await stage('ticket', () => ticketRun(input, triage, repro!, review));
        await setState(input.incident_id, 'ticketed');
        continue;
      }
      if (review.decision === 'need_info') {
        const ok = await condition(() => infoArrived !== undefined, Math.max(1000, Math.min(60_000, deadline - now())));
        if (!ok) return await finish('closed', 'inconclusive', undefined, 'need_info_timeout');
        infoArrived = undefined;
        continue;
      }
      return await finish('closed', 'inconclusive', undefined, `review_rejected_exhausted: ${review.reason}`);
    }

    hop();
    await routerAccept({
      incident_id: input.incident_id,
      verdict: repro.verdict,
      repro_reason: repro.verdict_reason,
      evidence: {
        attempts: repro.attempts,
        failed_attempts: repro.failed_attempts,
        signature_match_count: repro.signature_match_count,
        reruns: repro.reruns.map((r) => ({ run_ref: r.run_ref, state: r.state, signature_match: r.signature_match })),
        baseline_source: 'original CI run log fetched at reproFinalize',
      },
    });
    const lesson = await distillLesson(input, repro);
    return await finish('closed', repro.verdict, lesson.lesson_ref);
  } catch {
    return await finish('dead', 'error', undefined, 'unrecoverable failure (see workflow history)');
  }

  async function runRepro(inp: CaseInput, pol: EffectivePolicy, dl: number): Promise<ReproSlice> {
    const facts: CiFact[] = [];
    const abandoned: string[] = [];
    for (let attempt = 1; attempt <= pol.max_reruns; attempt++) {
      if (now() >= dl) break;
      const t = now();
      const { run_ref } = await ciTrigger({
        incident_id: inp.incident_id,
        dag_id: inp.ci.dag_id ?? inp.ci.job_id ?? '',
        attempt,
        max_reruns: pol.max_reruns,
        scenario: inp.dry_run_scenario,
        original_run_ref: inp.ci.run_ref,
      });
      let terminal = false;
      while (now() < dl) {
        await sleep(POLL_INTERVAL_MS);
        const r = await ciPoll(run_ref, inp.ci.dag_id ?? inp.ci.job_id ?? '', inp.ci.failed_tasks);
        if (r.state === 'failed' || r.state === 'success') {
          facts.push({ attempt, run_ref, state: r.state, log_tail: r.log_tail, duration_seconds: (now() - t) / 1000 });
          terminal = true;
          break;
        }
      }
      if (!terminal) {
        abandoned.push(run_ref);
        break;
      }
    }
    return reproFinalize(inp, facts, abandoned);
  }
}