import { describe, it, expect } from 'vitest';
import { getBuildInfo } from '../src/lib/build-info';

describe('getBuildInfo', () => {
  it('returns safe fallbacks when build constants are undefined (vitest has no vite define)', () => {
    const info = getBuildInfo();
    // In the vitest runtime the __BUILD_*__ globals are undefined, so the
    // helper must not throw and must return non-empty, typed fallbacks.
    expect(typeof info.version).toBe('string');
    expect(typeof info.commit).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
    expect(info.commit.length).toBeGreaterThan(0);
  });
});
