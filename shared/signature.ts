import { createHash } from 'node:crypto';

const NOISE = [
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /(?:\/[\w.\-]+)+\/?/g,
  /0x[0-9a-f]+/gi,
  /\b\d+\b/g,
];

const ERROR_LINE = /ERROR|Error|Traceback|FAILED|segfault|exit code/i;

export function normalizeErrorFingerprint(logTail: string): string {
  const lines = logTail
    .split('\n')
    .filter((l) => ERROR_LINE.test(l))
    .map((l) => {
      let s = l;
      for (const re of NOISE) s = s.replace(re, '');
      return s.replace(/\s+/g, ' ').trim();
    })
    .filter((l) => l.length > 0);
  return [...new Set(lines)].sort().join('\n');
}

export function failureSignature(failedTasks: string[], logTail: string): string {
  const tasks = [...failedTasks].sort().join(',');
  const fingerprint = normalizeErrorFingerprint(logTail);
  return 'sig:sha256:' + createHash('sha256').update(tasks + '\n' + fingerprint).digest('hex');
}

export function signatureMatch(a: string, b: string): boolean {
  return a === b;
}