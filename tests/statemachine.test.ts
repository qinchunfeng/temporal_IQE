import { describe, it, expect } from 'vitest';
import { canTransition, assertTransition, isTerminal, STATES } from '../shared/statemachine';

describe('statemachine', () => {
  it('allows the happy path', () => {
    const path = ['new', 'triaged', 'reproducing', 'ticketed', 'reviewing', 'closed'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i], path[i + 1])).toBe(true);
  });

  it('allows skip-repro and saga rework', () => {
    expect(canTransition('triaged', 'ticketed')).toBe(true);
    expect(canTransition('reviewing', 'ticketed')).toBe(true);
  });

  it('allows dead from any non-terminal state', () => {
    for (const s of STATES) {
      if (!isTerminal(s)) expect(canTransition(s, 'dead')).toBe(true);
    }
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('new', 'reviewing')).toBe(false);
    expect(canTransition('closed', 'triaged')).toBe(false);
    expect(canTransition('dead', 'new')).toBe(false);
    expect(canTransition('reproducing', 'triaged')).toBe(false);
    expect(() => assertTransition('closed', 'new')).toThrow(/illegal state transition/);
  });

  it('terminal states have no exits', () => {
    expect(isTerminal('closed')).toBe(true);
    expect(isTerminal('dead')).toBe(true);
    expect(isTerminal('reviewing')).toBe(false);
  });
});