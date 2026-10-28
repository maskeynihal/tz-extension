import type { Theme } from '../types';

/** The concrete, resolved theme after collapsing `system` to light/dark. */
export type ResolvedTheme = 'light' | 'dark';

function prefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Collapse a theme preference to the concrete theme to paint right now. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersDark() ? 'dark' : 'light';
}

/**
 * Apply a theme preference to a document root (popup / options page).
 * - `light` / `dark` set `data-theme` explicitly so the CSS overrides win.
 * - `system` removes the attribute so the `prefers-color-scheme` media query
 *   drives the palette.
 */
export function applyThemeToDocument(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'light' || theme === 'dark') {
    root.setAttribute('data-theme', theme);
  } else {
    root.removeAttribute('data-theme');
  }
}

/**
 * Watch the OS color-scheme and invoke `cb` when it flips. Only meaningful
 * while the theme is `system`; returns a no-op unsubscribe otherwise.
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(cb: (resolved: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const listener = (): void => cb(mql.matches ? 'dark' : 'light');
  // addEventListener is the modern API; older Safari used addListener.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  mql.addListener(listener);
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return () => mql.removeListener(listener);
}
