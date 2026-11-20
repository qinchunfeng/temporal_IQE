import type { DispatchDecision } from './mandate';

export function fastPath(): DispatchDecision {
  return { action: 'dispatch', target_role: 'triage', why: 'fastpath: deterministic default entry' };
}