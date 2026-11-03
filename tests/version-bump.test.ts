import { describe, it, expect } from 'vitest';
// @ts-expect-error -- a plain .mjs build script, no type declarations
import { decideBump, nextVersion, parseLog, releasable, shipsInExtension } from '../scripts/version-bump.mjs';

interface Commit {
  subject: string;
  body: string;
  files: string[];
}

/** Build `git log --name-only --format=%x1e%s%x1f%b%x1f` output. */
function log(...commits: Array<[subject: string, files: string[], body?: string]>): string {
  return commits.map(([s, files, body = '']) => `\x1e${s}\x1f${body}\x1f\n\n${files.join('\n')}\n`).join('');
}

describe('release: what ships in the extension', () => {
  it('counts the extension sources and its build inputs', () => {
    for (const f of [
      'src/content/index.ts',
      'src/popup/App.tsx',
      'src/lib/tz.ts',
      'src/manifest.ts',
      'public/icons/icon128.png',
      'package-lock.json',
      'vite.config.ts',
      'scripts/firefox-manifest.mjs',
    ]) {
      expect(shipsInExtension(f), f).toBe(true);
    }
  });

  it('leaves out the website, the docs, tests and CI', () => {
    for (const f of [
      'src/clock/Clock.tsx', // only the website imports it
      'site/guide.html',
      'docs/clock.js',
      'README.md',
      'tests/site.test.ts',
      'e2e/site.spec.ts',
      '.github/workflows/release.yml',
      'scripts/build-site.mjs',
      'package.json', // its version is ours to bump; deps move the lockfile
      'srcfoo/x.ts',
    ]) {
      expect(shipsInExtension(f), f).toBe(false);
    }
  });
});

describe('release: which commits count', () => {
  it('parses subjects, bodies and files, and a merge commit with no files', () => {
    const commits = parseLog(
      log(['Merge pull request #29', []], ['docs(site): a guide', ['site/guide.html', 'docs/guide.html'], 'Body\nline']),
    ) as Commit[];
    expect(commits).toEqual([
      { subject: 'Merge pull request #29', body: '', files: [] },
      { subject: 'docs(site): a guide', body: 'Body\nline', files: ['site/guide.html', 'docs/guide.html'] },
    ]);
  });

  it('a website-only merge releases nothing', () => {
    const commits = parseLog(
      log(['Merge pull request #29', []], ['feat(site): a guide', ['site/guide.html', 'docs/guide.html', 'README.md']]),
    );
    expect(releasable(commits)).toEqual([]);
  });

  it('a clock-only change releases nothing, since the clock lives on the website', () => {
    expect(releasable(parseLog(log(['feat(clock): card sliders', ['src/clock/Clock.tsx', 'docs/clock.js']])))).toEqual([]);
  });

  it('only extension commits decide the bump: a site feat beside an extension fix is a patch', () => {
    const commits = releasable(
      parseLog(log(['feat(site): a guide', ['site/guide.html']], ['fix: card position', ['src/content/index.ts']])),
    );
    expect((commits as Commit[]).map((c) => c.subject)).toEqual(['fix: card position']);
    expect(decideBump(commits)).toBe('patch');
  });

  it('a commit touching both counts, and its type decides', () => {
    const commits = releasable(
      parseLog(log(['feat: author links', ['site/index.html', 'src/popup/App.tsx']])),
    );
    expect(decideBump(commits)).toBe('minor');
    expect(nextVersion('0.8.1', 'minor')).toBe('0.9.0');
  });
});
