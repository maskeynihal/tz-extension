#!/usr/bin/env node
/**
 * Decide the next semantic version from Conventional Commits since the last
 * v* tag, bump package.json, and emit outputs for the release workflow.
 *
 * Bump rules (Conventional Commits):
 *   - any commit with "!" after type/scope, or a "BREAKING CHANGE" footer -> major
 *   - any "feat:" commit                                                  -> minor
 *   - otherwise (fix/docs/chore/style/refactor/test/...)                  -> patch
 * Only commits that change what ships in the extension count (see
 * EXTENSION_PATHS): a release goes to both stores, and a change to the website,
 * the docs or CI alone would only resubmit an identical extension for review.
 * With no such commits since the last tag, exits without releasing; they are
 * picked up by the next release that does change the extension.
 *
 * Writes to $GITHUB_OUTPUT (when present): released, version, tag, bump.
 * Prints the same as JSON to stdout for local runs.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = resolve(root, 'package.json');

/**
 * What ends up in the extension zips. Everything under src/ is bundled by
 * the extension build except src/clock/, which only the website imports
 * (site/clock.ts); public/ holds the icons; the lockfile pins every bundled
 * dependency; vite.config.ts and firefox-manifest.mjs shape the build.
 * package.json is left out on purpose: its version field is ours to bump,
 * and a dependency change also changes the lockfile.
 */
export const EXTENSION_PATHS = [
  'src/',
  'public/',
  'package-lock.json',
  'vite.config.ts',
  'scripts/firefox-manifest.mjs',
];
const NOT_EXTENSION_PATHS = ['src/clock/'];

/** True when a repo-relative path is part of what the extension ships. */
export function shipsInExtension(file) {
  if (NOT_EXTENSION_PATHS.some((p) => file.startsWith(p))) return false;
  return EXTENSION_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
}

function lastTag() {
  try {
    return sh('git describe --tags --abbrev=0 --match "v*"');
  } catch {
    return '';
  }
}

/**
 * Commits since the tag, each with the files it changed. A merge commit lists
 * no files of its own (git log shows no diff for it), so it never counts by
 * itself; the commits it brings in do.
 */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  // \x1e starts a record; \x1f separates subject, body and the file list.
  const raw = sh(`git log ${range} --name-only --format=%x1e%s%x1f%b%x1f`);
  return parseLog(raw);
}

/** Parse `git log --name-only --format=%x1e%s%x1f%b%x1f` output. */
export function parseLog(raw) {
  if (!raw) return [];
  return raw
    .split('\x1e')
    .filter((r) => r.trim())
    .map((r) => {
      const [subject = '', body = '', names = ''] = r.split('\x1f');
      const files = names.split('\n').map((f) => f.trim()).filter(Boolean);
      return { subject: subject.trim(), body: body.trim(), files };
    });
}

/** The commits that change the shipped extension. */
export function releasable(commits) {
  return commits.filter((c) => c.files.some(shipsInExtension));
}

export function decideBump(commits) {
  let bump = 'patch';
  for (const c of commits) {
    const text = `${c.subject}\n${c.body}`;
    const header = c.subject;
    // Breaking: "feat!:", "fix(scope)!:", or a BREAKING CHANGE footer.
    if (/^[a-z]+(\([^)]*\))?!:/.test(header) || /BREAKING CHANGE/.test(text)) {
      return 'major';
    }
    if (/^feat(\([^)]*\))?:/.test(header)) {
      bump = bump === 'patch' ? 'minor' : bump;
    }
  }
  return bump;
}

export function nextVersion(current, bump) {
  const [maj, min, pat] = current.split('.').map((n) => parseInt(n, 10) || 0);
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function out(obj) {
  const gh = process.env.GITHUB_OUTPUT;
  if (gh) {
    for (const [k, v] of Object.entries(obj)) appendFileSync(gh, `${k}=${v}\n`);
  }
  console.log(JSON.stringify(obj));
}

function main() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const tag = lastTag();
  const commits = releasable(commitsSince(tag));

  if (commits.length === 0) {
    console.error('No commits since the last tag change the extension (see EXTENSION_PATHS); not releasing.');
    out({ released: 'false', version: pkg.version, tag: tag || '', bump: 'none' });
    return;
  }

  const bump = decideBump(commits);
  const version = nextVersion(pkg.version, bump);

  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  out({ released: 'true', version, tag: `v${version}`, bump });
}

// Run only as a script, so the tests can import the rules above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
