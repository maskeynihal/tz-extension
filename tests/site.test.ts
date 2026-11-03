import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readingLabel } from '../site/reading';
import { parseTimes } from '../src/lib/parse';
import type { ParsedTime } from '../src/types';

const root = resolve(__dirname, '..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');

/** Source with comments removed, then the first statement that is not an import. */
function firstStatement(src: string): string {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const withoutImports = code.replace(/^\s*import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '').replace(/^\s*import\s+['"][^'"]+['"];\s*$/gm, '');
  return withoutImports.trim().split('\n')[0] ?? '';
}

describe('website converter: day/month picker labels', () => {
  function at(text: string, order: 'dmy' | 'mdy'): ParsedTime {
    const [p] = parseTimes(text, { assumedZone: 'UTC', numericDateOrder: order } as Parameters<typeof parseTimes>[1]);
    if (!p) throw new Error(`no parse for ${text}`);
    return p;
  }

  it('labels both readings from the written calendar date, even with a label-only zone', () => {
    // "PDT" is a display label, not an IANA zone: the old code produced "Invalid Date".
    const p = at('03/04/2024 22:00 PDT', 'mdy');
    expect(readingLabel(p, 'mdy')).toBe('Mar 4, 2024');
    expect(readingLabel(p, 'dmy')).toBe('3 Apr 2024');
  });

  it('never shifts the date by the source zone offset', () => {
    // 00:30 CET is the previous day in UTC; the label must still be the written date.
    const p = at('03/04/2024 00:30 CET', 'dmy');
    expect(readingLabel(p, 'dmy')).toBe('3 Apr 2024');
    expect(readingLabel(p, 'mdy')).toBe('Mar 4, 2024');
  });

  it('is null for an unambiguous date', () => {
    expect(readingLabel(at('2024-03-04T10:00Z', 'dmy'), 'dmy')).toBeNull();
  });
});

describe('website storage opt-in', () => {
  it('both website entries opt in to localStorage before anything else', () => {
    for (const entry of ['site/demo.ts', 'site/clock.ts']) {
      const src = read(entry);
      expect(src).toMatch(/enableWebStorageBackend\b[\s\S]*from '\.\.\/src\/lib\/storage'/);
      expect(firstStatement(src)).toBe('enableWebStorageBackend();');
    }
  });

  it('the site build uses the website clock entry, not the extension one', () => {
    // The entries live in site-config.mjs, shared by build:site and dev:site.
    const config = read('scripts/site-config.mjs');
    expect(config).toContain("clock: resolve(siteDir, 'clock.ts')");
    expect(config).not.toContain('src/clock/main.tsx');
    expect(read('scripts/build-site.mjs')).toContain('siteBuildOptions(outDir)');
  });

  it('the extension clock page never opts in', () => {
    for (const f of readdirSync(resolve(root, 'src/clock'))) {
      if (!/\.(tsx?|html)$/.test(f)) continue;
      expect(read(`src/clock/${f}`), f).not.toMatch(/enableWebStorage/);
    }
  });
});

describe('website pages', () => {
  it('the home page and the privacy policy link to the terms', () => {
    for (const page of ['index.html', 'privacy.html']) {
      const footer = /<footer[\s\S]*?<\/footer>/.exec(read(`site/${page}`))?.[0] ?? '';
      expect(footer, page).toContain('href="./terms.html"');
    }
    expect(read('site/terms.html')).toContain('href="./privacy.html"');
  });

  it('every page footer links to the privacy policy', () => {
    for (const page of ['index.html', 'app.html', 'clock.html']) {
      const footer = /<footer[\s\S]*?<\/footer>/.exec(read(`site/${page}`))?.[0] ?? '';
      expect(footer, page).toContain('href="./privacy.html"');
    }
  });

  it('built pages and scripts only reference files that exist in docs/', () => {
    const docs = resolve(root, 'docs');
    const missing: string[] = [];
    for (const page of ['index.html', 'app.html', 'clock.html', 'privacy.html', 'terms.html']) {
      const html = readFileSync(resolve(docs, page), 'utf8');
      for (const m of html.matchAll(/(?:src|href)="(\.\/[^"#?]+)"/g)) {
        const ref = m[1] as string;
        if (!existsSync(resolve(docs, ref))) missing.push(`${page} -> ${ref}`);
      }
    }
    expect(missing).toEqual([]);
    // The two entries were actually built.
    expect(existsSync(resolve(docs, 'demo.js'))).toBe(true);
    expect(existsSync(resolve(docs, 'clock.js'))).toBe(true);
    expect(existsSync(resolve(docs, 'clock.css'))).toBe(true);
  });

  // Browsers block module scripts (and their imports) on file:// pages, which
  // left the converter and the clock blank when docs/*.html was opened from
  // disk. The site ships classic, self-contained scripts instead.
  it('pages load classic scripts that import nothing, so they also work from file://', () => {
    const docs = resolve(root, 'docs');
    for (const page of ['index.html', 'app.html', 'clock.html', 'privacy.html', 'terms.html']) {
      for (const dir of ['site', 'docs']) {
        expect(readFileSync(resolve(root, dir, page), 'utf8'), `${dir}/${page}`).not.toMatch(/<script[^>]*type=["']module["']/);
      }
    }
    for (const js of readdirSync(docs).filter((f) => f.endsWith('.js'))) {
      const src = readFileSync(resolve(docs, js), 'utf8');
      expect(src, js).not.toMatch(/(?:^|[;}\s])import\s*[\s{*("']|(?:^|[;}\s])export\s*[{*]/);
    }
    expect(existsSync(resolve(docs, 'chunks'))).toBe(false);
  });
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('popup / settings / clock contrast and layout CSS', () => {
  const tokens = read('src/styles/tokens.css');
  const popup = read('src/popup/popup.css');
  const clock = read('src/clock/clock.css');
  const darkBrand = /data-theme='dark'\][^{]*\{[^}]*--tz-brand:\s*(#[0-9a-f]{6})/i.exec(tokens)?.[1] ?? '';

  it('selected segmented buttons meet AA in dark mode', () => {
    expect(darkBrand).toMatch(/^#/);
    const accentFg = /:root\[data-theme='dark'\]\s*\{\s*--accent-fg:\s*(#[0-9a-f]{6})/i.exec(popup)?.[1] ?? '';
    expect(contrast(accentFg, darkBrand)).toBeGreaterThanOrEqual(4.5);
    // The old white text failed AA on the dark brand.
    expect(contrast('#ffffff', darkBrand)).toBeLessThan(4.5);
    expect(popup).toMatch(/\.tzx-seg-btn\.active[^{]*\{[^}]*color:\s*var\(--accent-fg\)/);
    expect(popup).toMatch(/prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme='light'\]\):not\(\[data-theme='dark'\]\)\s*\{\s*--accent-fg/);
    const clockFg = /data-theme='dark'\] \.tzc-seg-btn\[aria-pressed='true'\]\s*\{\s*color:\s*(#[0-9a-f]{6})/i.exec(clock)?.[1] ?? '';
    expect(contrast(clockFg, darkBrand)).toBeGreaterThanOrEqual(4.5);
  });

  it('format examples wrap as whole tokens', () => {
    expect(popup).toMatch(/\.tzx-format-ex code\s*\{[^}]*display:\s*inline-block[^}]*word-break:\s*normal/);
  });

  it('the clock header keeps full screen and settings together and compacts on phones', () => {
    expect(clock).toMatch(/\.tzc-actions\s*\{[^}]*flex:\s*none/);
    expect(clock).toMatch(/@media \(max-width: 480px\)/);
  });
});
