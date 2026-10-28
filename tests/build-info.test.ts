import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBuildInfo } from '../src/lib/build-info';

describe('getBuildInfo', () => {
  it('returns safe fallbacks when build constants are undefined', () => {
    const info = getBuildInfo();
    expect(typeof info.version).toBe('string');
    expect(info.version.length).toBeGreaterThan(0);
    expect(typeof info.commit).toBe('string');
  });
});

describe('getBuildInfo GitHub links', () => {
  const g = globalThis as unknown as Record<string, string>;
  beforeEach(() => {
    g.__APP_VERSION__ = '0.1.0';
    g.__BUILD_COMMIT__ = 'abc1234-dirty';
    g.__BUILD_TIME__ = '2026-10-28T00:00:00Z';
    g.__REPO_URL__ = 'https://github.com/maskeynihal/tz-extension';
  });
  afterEach(() => {
    delete g.__APP_VERSION__;
    delete g.__BUILD_COMMIT__;
    delete g.__BUILD_TIME__;
    delete g.__REPO_URL__;
    vi.restoreAllMocks();
  });

  it('builds a release URL from the version', () => {
    expect(getBuildInfo().releaseUrl).toBe(
      'https://github.com/maskeynihal/tz-extension/releases/tag/v0.1.0',
    );
  });

  it('builds a commit URL with the -dirty suffix stripped', () => {
    expect(getBuildInfo().commitUrl).toBe(
      'https://github.com/maskeynihal/tz-extension/commit/abc1234',
    );
  });

  it('exposes the repo URL', () => {
    expect(getBuildInfo().repoUrl).toBe('https://github.com/maskeynihal/tz-extension');
  });

  it('yields empty link URLs when no repo is known', () => {
    delete g.__REPO_URL__;
    const b = getBuildInfo();
    expect(b.releaseUrl).toBe('');
    expect(b.commitUrl).toBe('');
  });
});
