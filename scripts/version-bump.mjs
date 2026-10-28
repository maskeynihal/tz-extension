#!/usr/bin/env node
/**
 * Decide the next semantic version from Conventional Commits since the last
 * v* tag, bump package.json, and emit outputs for the release workflow.
 *
 * Bump rules (Conventional Commits):
 *   - any commit with "!" after type/scope, or a "BREAKING CHANGE" footer -> major
 *   - any "feat:" commit                                                  -> minor
 *   - otherwise (fix/docs/chore/style/refactor/test/...)                  -> patch
 * With no commits since the last tag, exits without releasing.
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

function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  // %s subject \x1f unit sep \x1e record sep, so bodies survive newlines.
  const raw = sh(`git log ${range} --format=%s%x1f%b%x1e`);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject = '', body = ''] = r.split('\x1f');
      return { subject: subject.trim(), body: body.trim() };
    });
}

function decideBump(commits) {
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

function nextVersion(current, bump) {
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

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const tag = lastTag();
const commits = commitsSince(tag);

if (commits.length === 0) {
  out({ released: 'false', version: pkg.version, tag: tag || '', bump: 'none' });
  process.exit(0);
}

const bump = decideBump(commits);
const version = nextVersion(pkg.version, bump);

pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

out({ released: 'true', version, tag: `v${version}`, bump });
