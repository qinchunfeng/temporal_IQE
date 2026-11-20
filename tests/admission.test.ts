import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSource, checkIngestRate } from '../workers/src/admission';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'iqe-admission-'));

describe('G8 admission', () => {
  it('accepts whitelisted sources', () => {
    expect(checkSource('simulator', ['simulator', 'monitor']).ok).toBe(true);
    expect(checkSource('monitor', ['simulator', 'monitor']).ok).toBe(true);
  });

  it('rejects non-whitelisted source', () => {
    const r = checkSource('evil', ['simulator', 'monitor']);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/allowlist/);
  });

  it('counts within the hour window and caps', () => {
    const dir = tmp();
    const t0 = 1_000_000_000_000;
    expect(checkIngestRate(dir, 2, t0).ok).toBe(true);
    expect(checkIngestRate(dir, 2, t0 + 1000).ok).toBe(true);
    const blocked = checkIngestRate(dir, 2, t0 + 2000);
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/cap/);
  });

  it('resets after the window rolls over', () => {
    const dir = tmp();
    const t0 = 1_000_000_000_000;
    checkIngestRate(dir, 1, t0);
    expect(checkIngestRate(dir, 1, t0 + 1000).ok).toBe(false);
    expect(checkIngestRate(dir, 1, t0 + 3_600_000).ok).toBe(true);
  });
});