import { describe, it, expect } from 'vitest';
import { validateMandate } from '../workers/src/mandate';
import { fastPath } from '../workers/src/fastpath';

describe('mandate', () => {
  it('accepts fastPath dispatch', () => {
    expect(validateMandate(fastPath()).ok).toBe(true);
  });

  it('accepts dispatch to every role', () => {
    for (const r of ['triage', 'repro', 'ticket', 'review', 'reporting']) {
      expect(validateMandate({ action: 'dispatch', target_role: r, why: 'x' }).ok).toBe(true);
    }
  });

  it('rejects dispatch without/with illegal target_role', () => {
    expect(validateMandate({ action: 'dispatch', why: 'x' }).ok).toBe(false);
    expect(validateMandate({ action: 'dispatch', target_role: 'router', why: 'x' }).ok).toBe(false);
  });

  it('rejects unknown action', () => {
    expect(validateMandate({ action: 'execute', why: 'x' }).ok).toBe(false);
  });

  it('rejects empty why', () => {
    expect(validateMandate({ action: 'dispatch', target_role: 'triage', why: '' }).ok).toBe(false);
  });

  it('accepts legal skip (repro + reason + refs)', () => {
    expect(validateMandate({ action: 'skip', target_role: 'repro', skip_reason: 'history_match', why: 'x', refs: ['kb/cases/c1/card.json'] }).ok).toBe(true);
  });

  it('rejects skip without refs / reason / wrong role', () => {
    expect(validateMandate({ action: 'skip', target_role: 'repro', skip_reason: 'r', why: 'x' }).ok).toBe(false);
    expect(validateMandate({ action: 'skip', target_role: 'repro', why: 'x', refs: ['a'] }).ok).toBe(false);
    expect(validateMandate({ action: 'skip', target_role: 'ticket', skip_reason: 'r', why: 'x', refs: ['a'] }).ok).toBe(false);
  });

  it('accepts ask', () => {
    expect(validateMandate({ action: 'ask', why: 'need human decision' }).ok).toBe(true);
  });

  it('rejects non-object', () => {
    expect(validateMandate(null).ok).toBe(false);
    expect(validateMandate('dispatch').ok).toBe(false);
  });
});