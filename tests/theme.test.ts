import { describe, it, expect, afterEach, vi } from 'vitest';
import { resolveTheme } from '../src/lib/theme';
import { sanitize } from '../src/lib/storage';

function mockMatchMedia(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

describe('resolveTheme', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the explicit theme regardless of the OS', () => {
    mockMatchMedia(true); // OS = dark
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('follows the OS when system (dark)', () => {
    mockMatchMedia(true);
    expect(resolveTheme('system')).toBe('dark');
  });

  it('follows the OS when system (light)', () => {
    mockMatchMedia(false);
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('sanitize theme', () => {
  it('defaults to system when absent', () => {
    expect(sanitize({}).theme).toBe('system');
  });

  it('accepts light and dark', () => {
    expect(sanitize({ theme: 'light' }).theme).toBe('light');
    expect(sanitize({ theme: 'dark' }).theme).toBe('dark');
  });

  it('rejects an unknown value back to system', () => {
    expect(sanitize({ theme: 'neon' }).theme).toBe('system');
  });
});
