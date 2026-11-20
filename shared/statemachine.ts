export const STATES = [
  'new',
  'triaged',
  'reproducing',
  'ticketed',
  'reviewing',
  'closed',
  'dead',
] as const;

export type State = (typeof STATES)[number];

const TRANSITIONS: Record<State, readonly State[]> = {
  new: ['triaged', 'closed', 'dead'],
  triaged: ['reproducing', 'ticketed', 'closed', 'dead'],
  reproducing: ['ticketed', 'closed', 'dead'],
  ticketed: ['reviewing', 'dead'],
  reviewing: ['ticketed', 'closed', 'dead'],
  closed: [],
  dead: [],
};

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal state transition: ${from} -> ${to}`);
  }
}

export function isTerminal(s: State): boolean {
  return s === 'closed' || s === 'dead';
}