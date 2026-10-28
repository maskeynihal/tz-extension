#!/usr/bin/env node
/**
 * Generate playful, Slack-channel-style release notes from the Conventional
 * Commits since the previous v* tag. Writes RELEASE_NOTES.md at the repo root
 * and prints the path. Usage: node scripts/release-notes.mjs <version>
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2] || '0.0.0';

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
}

function prevTag() {
  try {
    // The tag BEFORE the current HEAD's tag (the one we are releasing).
    const tags = sh('git tag --sort=-creatordate --merged HEAD')
      .split('\n')
      .filter((t) => /^v\d/.test(t));
    // tags[0] is the just-created release tag; tags[1] is the previous one.
    return tags[1] || '';
  } catch {
    return '';
  }
}

function commits(range) {
  const raw = sh(`git log ${range} --format=%s%x1f%h%x1e`);
  if (!raw) return [];
  return raw
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject = '', short = ''] = r.split('\x1f');
      return { subject: subject.trim(), short: short.trim() };
    })
    .filter((c) => !/^chore\(release\)/.test(c.subject))
    .filter((c) => !/^Merge (pull request|branch|remote)/.test(c.subject));
}

const TYPES = [
  { re: /^feat(\(|!|:)/, key: 'feat', heading: '✨ New stuff that works (probably)' },
  { re: /^fix(\(|!|:)/, key: 'fix', heading: '🧯 Bugs we pretended never existed' },
  { re: /^perf(\(|!|:)/, key: 'perf', heading: '🏎️ Now slightly less slow' },
  { re: /^(refactor|style)(\(|!|:)/, key: 'refactor', heading: '🧹 Moved furniture around' },
  { re: /^(docs)(\(|!|:)/, key: 'docs', heading: '📚 Words. So many words.' },
  { re: /^(test)(\(|!|:)/, key: 'test', heading: '🧪 Tests, because trust issues' },
];

function classify(subject) {
  for (const t of TYPES) if (t.re.test(subject)) return t.key;
  return 'other';
}

function clean(subject) {
  // Strip the conventional prefix for readability: "feat(ui): x" -> "x".
  return subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '');
}

const OPENERS = [
  `:rocket: *tz-extension v${version} just shipped* — someone finally hit merge.`,
  `:tada: *v${version} is live!* Reload your extension before you @ me about the old bug.`,
  `:ship: *v${version} has left the harbor.* No takebacks.`,
];
const CLOSERS = [
  `_Reload at \`chrome://extensions\` → ⟳, or \`about:debugging\` for Firefox. You know the drill._ :coffee:`,
  `_Shipped on a Wednesday. Living dangerously._ :sunglasses:`,
  `_If something broke, it's a feature now. File an issue anyway._ :bug:`,
];
// Deterministic pick from the version so notes are stable per release.
const seed = version.split('.').reduce((a, n) => a + (parseInt(n, 10) || 0), 0);
const pick = (arr) => arr[seed % arr.length];

const range = prevTag() ? `${prevTag()}..HEAD` : 'HEAD';
const all = commits(range);
const grouped = new Map();
for (const c of all) {
  const k = classify(c.subject);
  if (!grouped.has(k)) grouped.set(k, []);
  grouped.get(k).push(c);
}

let md = `${pick(OPENERS)}\n\n`;
if (all.length === 0) {
  md += `Nothing but vibes in this one. :shrug:\n\n`;
}
for (const t of TYPES) {
  const items = grouped.get(t.key);
  if (!items || items.length === 0) continue;
  md += `### ${t.heading}\n`;
  for (const c of items) md += `- ${clean(c.subject)} (\`${c.short}\`)\n`;
  md += `\n`;
}
const other = grouped.get('other');
if (other && other.length) {
  md += `### :card_index_dividers: Everything else\n`;
  for (const c of other) md += `- ${clean(c.subject)} (\`${c.short}\`)\n`;
  md += `\n`;
}
md += `---\n\n`;
md += `**Downloads:** grab \`tz-extension-chrome.zip\` or \`tz-extension-firefox.zip\` below. :point_down:\n\n`;
md += `${pick(CLOSERS)}\n`;

writeFileSync(resolve(root, 'RELEASE_NOTES.md'), md);
console.log(resolve(root, 'RELEASE_NOTES.md'));
