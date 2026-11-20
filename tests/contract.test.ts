import { describe, it, expect } from 'vitest';
import {
  validateCaseInput, validateDispatch, validateTriage, validateRepro, validateTicket, validateReview, validateCaseClose,
} from '../workers/src/validate';
import type { CaseInput } from '../workers/src/types';

const baseInput: CaseInput = {
  schema_version: '3.0',
  incident_id: 'inc-test-0001',
  source: 'simulator',
  ci: {
    provider: 'airflow',
    base_url: 'http://172.31.0.2:8080',
    dag_id: 'test_flash_attention_flow',
    run_ref: 'manual__2026-11-03T06:57:10.329997+00:00',
    failed_tasks: ['run_kernel_test'],
  },
  issued_at: '2026-11-19T08:00:00Z',
};

describe('case-input schema', () => {
  it('accepts the canonical example', () => expect(validateCaseInput(baseInput)).toBe(true));
  it('accepts optional policy/scenario/signature', () =>
    expect(validateCaseInput({ ...baseInput, policy: { max_reruns: 2, timeout_minutes: 0.1 }, dry_run_scenario: 'flaky', signature: 'sig:sha256:abc' })).toBe(true));
  it('rejects wrong schema_version', () => expect(validateCaseInput({ ...baseInput, schema_version: '2.0' })).toBe(false));
  it('rejects missing ci', () => {
    const { ci: _ci, ...rest } = baseInput;
    expect(validateCaseInput(rest)).toBe(false);
  });
  it('rejects unknown provider', () => expect(validateCaseInput({ ...baseInput, ci: { ...baseInput.ci, provider: 'bamboo' } })).toBe(false));
  it('rejects extra fields', () => expect(validateCaseInput({ ...baseInput, cwd: '/tmp' })).toBe(false));
  it('rejects out-of-range policy', () => expect(validateCaseInput({ ...baseInput, policy: { max_reruns: 99 } })).toBe(false));
});

describe('dispatch-decision schema', () => {
  it('accepts dispatch', () => expect(validateDispatch({ action: 'dispatch', target_role: 'triage', why: 'x' })).toBe(true));
  it('rejects dispatch without target_role', () => expect(validateDispatch({ action: 'dispatch', why: 'x' })).toBe(false));
  it('accepts skip with refs', () => expect(validateDispatch({ action: 'skip', target_role: 'repro', skip_reason: 'r', why: 'x', refs: ['kb/cases/c1/card.json'] })).toBe(true));
  it('rejects skip without refs', () => expect(validateDispatch({ action: 'skip', target_role: 'repro', skip_reason: 'r', why: 'x' })).toBe(false));
});

describe('slice schemas', () => {
  it('triage valid/invalid', () => {
    expect(validateTriage({ classification: 'test', confidence: 0.8, summary: 's', qualifies_for_reproduction: true })).toBe(true);
    expect(validateTriage({ classification: 'magic', confidence: 0.8, summary: 's', qualifies_for_reproduction: true })).toBe(false);
    expect(validateTriage({ classification: 'test', confidence: 2, summary: 's', qualifies_for_reproduction: true })).toBe(false);
  });
  it('repro valid/invalid', () => {
    const ok = { verdict: 'reproduced', verdict_reason: 'r', attempts: 2, failed_attempts: 2, signature_match_count: 2, reruns: [{ attempt: 1, run_ref: 'repro__x__1', state: 'failed' }] };
    expect(validateRepro(ok)).toBe(true);
    expect(validateRepro({ ...ok, verdict: 'maybe' })).toBe(false);
    expect(validateRepro({ ...ok, verdict_reason: '' })).toBe(false);
  });
  it('ticket valid/invalid', () => {
    expect(validateTicket({ draft: { title: 't', priority: 'high', component: 'c' } })).toBe(true);
    expect(validateTicket({ draft: { title: 't', priority: 'urgent', component: 'c' } })).toBe(false);
  });
  it('review valid/invalid', () => {
    expect(validateReview({ decision: 'approve', reason: 'ok' })).toBe(true);
    expect(validateReview({ decision: 'lgtm', reason: 'ok' })).toBe(false);
  });
});

describe('case-close schema', () => {
  const close = {
    schema_version: '3.0',
    incident_id: 'inc-test-0001',
    verdict: 'reproduced',
    state: 'closed',
    evidence_dir: 'kb/cases/inc-test-0001/',
    metrics: { tat_seconds: 10, stages: { triage: 1 }, reruns_triggered: 2, history_skip: false },
  };
  it('accepts canonical close', () => expect(validateCaseClose(close)).toBe(true));
  it('accepts llm null tokens (M1 stub)', () =>
    expect(validateCaseClose({ ...close, metrics: { ...close.metrics, llm: [{ role: 'repro', model: 'stub-m1', turns: null, input_tokens: null, output_tokens: null }] } })).toBe(true));
  it('rejects unknown verdict', () => expect(validateCaseClose({ ...close, verdict: 'unknown' })).toBe(false));
  it('rejects missing metrics', () => {
    const { metrics: _m, ...rest } = close;
    expect(validateCaseClose(rest)).toBe(false);
  });
});