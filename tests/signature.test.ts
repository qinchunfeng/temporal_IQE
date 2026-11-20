import { describe, it, expect } from 'vitest';
import { failureSignature, normalizeErrorFingerprint, signatureMatch } from '../shared/signature';

const A = '2026-11-03T06:58:01Z ERROR run_kernel_test: segfault at 0x7f3a in /opt/build/libflash.so exit code 139';
const B = '2026-11-19T10:00:00Z ERROR run_kernel_test: segfault at 0xdead in /home/other/libflash.so exit code 139';

describe('signature', () => {
  it('normalizes timestamps, hex addresses, paths and numbers', () => {
    expect(normalizeErrorFingerprint(A)).toBe(normalizeErrorFingerprint(B));
  });

  it('strips UUIDs', () => {
    const x = 'ERROR fail run 8f14e45f-ceea-467f-a9d2-3f21c0b9a111';
    const y = 'ERROR fail run 11111111-2222-3333-4444-555555555555';
    expect(normalizeErrorFingerprint(x)).toBe(normalizeErrorFingerprint(y));
  });

  it('is invariant to task ordering', () => {
    expect(failureSignature(['a', 'b'], A)).toBe(failureSignature(['b', 'a'], A));
  });

  it('matches same failure across noise', () => {
    expect(signatureMatch(failureSignature(['run_kernel_test'], A), failureSignature(['run_kernel_test'], B))).toBe(true);
  });

  it('differs for different errors', () => {
    const other = 'ERROR run_kernel_test: OOM killed process';
    expect(signatureMatch(failureSignature(['run_kernel_test'], A), failureSignature(['run_kernel_test'], other))).toBe(false);
  });

  it('differs for different task sets', () => {
    expect(failureSignature(['t1'], A)).not.toBe(failureSignature(['t2'], A));
  });

  it('ignores non-error lines', () => {
    expect(normalizeErrorFingerprint('INFO all good\njust noise')).toBe('');
  });
});