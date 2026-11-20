export const ROLES = ['triage', 'repro', 'ticket', 'review', 'reporting'] as const;
export type Role = (typeof ROLES)[number];

export interface DispatchDecision {
  action: 'dispatch' | 'skip' | 'ask';
  target_role?: Role;
  skip_reason?: string;
  why: string;
  refs?: string[];
}

export function validateMandate(d: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (typeof d !== 'object' || d === null) return { ok: false, errors: ['decision must be an object'] };
  const o = d as Record<string, unknown>;
  if (!['dispatch', 'skip', 'ask'].includes(o.action as string)) errors.push(`illegal action: ${o.action}`);
  if (typeof o.why !== 'string' || o.why.length === 0) errors.push('why must be a non-empty string');
  if (o.action === 'dispatch') {
    if (!ROLES.includes(o.target_role as Role)) errors.push(`dispatch requires target_role in ${ROLES.join('|')}`);
  }
  if (o.action === 'skip') {
    if (o.target_role !== 'repro') errors.push('skip is only allowed for repro');
    if (typeof o.skip_reason !== 'string' || o.skip_reason.length === 0) errors.push('skip requires skip_reason');
    if (!Array.isArray(o.refs) || o.refs.length === 0) errors.push('skip requires at least one history case ref');
  }
  return { ok: errors.length === 0, errors };
}