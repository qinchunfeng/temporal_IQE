import { describe, it, expect } from 'vitest';
import { fallbackVerdict } from '../shared/verdict';

const fail = { state: 'failed' as const, signature_match: true };
const failMismatch = { state: 'failed' as const, signature_match: false };
const pass = { state: 'success' as const };

describe('verdict fallback table', () => {
  it('all failed + signature match -> reproduced', () => {
    expect(fallbackVerdict([fail, fail]).verdict).toBe('reproduced');
  });

  it('all failed + signature mismatch -> flaky', () => {
    expect(fallbackVerdict([fail, failMismatch]).verdict).toBe('flaky');
  });

  it('mixed failed/success -> flaky', () => {
    expect(fallbackVerdict([fail, pass]).verdict).toBe('flaky');
  });

  it('all success -> not_reproduced', () => {
    expect(fallbackVerdict([pass, pass]).verdict).toBe('not_reproduced');
  });

  it('no effective reruns -> inconclusive', () => {
    expect(fallbackVerdict([]).verdict).toBe('inconclusive');
    expect(fallbackVerdict([{ state: 'abandoned' }]).verdict).toBe('inconclusive');
  });

  it('infra blocked reason surfaced', () => {
    expect(fallbackVerdict([], { infraBlocked: true }).reason).toMatch(/infra blocked/);
  });

  it('qualifies=false -> skipped', () => {
    expect(fallbackVerdict([fail], { qualifies: false }).verdict).toBe('skipped');
  });
});