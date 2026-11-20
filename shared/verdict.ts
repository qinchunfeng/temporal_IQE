export type Verdict =
  | 'reproduced'
  | 'flaky'
  | 'not_reproduced'
  | 'inconclusive'
  | 'skipped'
  | 'error';

export interface RerunFact {
  state: 'failed' | 'success' | 'running' | 'queued' | 'abandoned';
  signature_match?: boolean;
}

export function fallbackVerdict(
  reruns: RerunFact[],
  opts: { infraBlocked?: boolean; qualifies?: boolean } = {},
): { verdict: Verdict; reason: string } {
  if (opts.qualifies === false) {
    return { verdict: 'skipped', reason: 'qualifies_for_reproduction=false' };
  }
  const effective = reruns.filter((r) => r.state === 'failed' || r.state === 'success');
  if (effective.length === 0) {
    return {
      verdict: 'inconclusive',
      reason: opts.infraBlocked ? 'infra blocked: no effective reruns' : 'no effective reruns',
    };
  }
  const failed = effective.filter((r) => r.state === 'failed');
  if (failed.length === 0) {
    return { verdict: 'not_reproduced', reason: `all ${effective.length} reruns succeeded` };
  }
  if (failed.length === effective.length) {
    const matched = failed.filter((r) => r.signature_match === true).length;
    if (matched === failed.length) {
      return { verdict: 'reproduced', reason: `${failed.length}/${effective.length} failed, signature fully matched` };
    }
    return { verdict: 'flaky', reason: 'all failed but signature mismatch' };
  }
  return { verdict: 'flaky', reason: 'mixed failed/success reruns' };
}