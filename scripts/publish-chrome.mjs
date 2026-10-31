#!/usr/bin/env node
/**
 * Upload a zip to the Chrome Web Store and submit it for publishing,
 * using the Chrome Web Store API v2. Zero dependencies (Node 20+, global fetch).
 *
 *   node scripts/publish-chrome.mjs [--zip tz-extension-chrome.zip]
 *                                   [--dry-run] [--skip-publish] [--cancel-pending]
 *                                   [--expect-version X.Y.Z] [--timeout 300]
 *
 * Env (required unless noted):
 *   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN  OAuth client + refresh token
 *   CWS_PUBLISHER_ID                                    Developer Dashboard > Account
 *   CWS_EXTENSION_ID   (optional) default cokhjgalkhboifkgoomlbaigocjpmhkk
 *
 * Steps: refresh token -> access token; fetchStatus (idempotency check);
 * POST the zip to :upload; poll :fetchStatus while the upload is processing;
 * POST :publish. If the store already has this version published or under
 * review, exits 0 with a notice so re-runs are safe.
 *
 * If an OLDER version is still in review, the store will not take a new
 * package, so the script uploads nothing and exits 0 with a warning. Pass
 * --cancel-pending to cancel that review (:cancelSubmission) and submit this
 * version instead.
 *
 * Exit codes: 0 success / nothing to do, 1 store or network failure,
 * 2 usage or configuration error.
 *
 * API reference: https://developer.chrome.com/docs/webstore/api/reference/rest
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PublishError,
  packageVersion,
  readManifestFromZip,
  registerSecret,
  runMain,
  sleep,
} from './lib/store-common.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_EXTENSION_ID = 'cokhjgalkhboifkgoomlbaigocjpmhkk';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://chromewebstore.googleapis.com';
const REQUEST_TIMEOUT_MS = 120_000;

// States from the v2 ItemState enum that mean "this version is already with the store".
const IN_REVIEW_STATES = new Set(['PENDING_REVIEW', 'STAGED']);
const LIVE_STATES = new Set(['PUBLISHED', 'PUBLISHED_TO_TESTERS']);
// The v2 UploadState enum uses IN_PROGRESS; the guide also mentions UPLOAD_IN_PROGRESS.
const UPLOAD_IN_PROGRESS = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);

function usage(msg) {
  return new PublishError(
    `${msg}\nusage: node scripts/publish-chrome.mjs [--zip <path>] [--dry-run] [--skip-publish] [--cancel-pending] [--expect-version X.Y.Z] [--timeout <seconds>]`,
    { exitCode: 2 },
  );
}

function parseCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        zip: { type: 'string', default: 'tz-extension-chrome.zip' },
        'dry-run': { type: 'boolean', default: false },
        'skip-publish': { type: 'boolean', default: false },
        'cancel-pending': { type: 'boolean', default: false },
        'expect-version': { type: 'string' },
        timeout: { type: 'string', default: '300' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    throw usage(err.message);
  }
  if (values.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(0);
  }
  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw usage(`--timeout must be a positive number of seconds`);
  return {
    zip: resolve(process.cwd(), values.zip),
    dryRun: values['dry-run'],
    skipPublish: values['skip-publish'],
    cancelPending: values['cancel-pending'],
    expectVersion: values['expect-version'],
    timeoutMs: timeoutSec * 1000,
  };
}

function readEnv() {
  const env = {
    clientId: process.env.CWS_CLIENT_ID ?? '',
    clientSecret: process.env.CWS_CLIENT_SECRET ?? '',
    refreshToken: process.env.CWS_REFRESH_TOKEN ?? '',
    publisherId: process.env.CWS_PUBLISHER_ID ?? '',
    extensionId: process.env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID,
  };
  registerSecret(env.clientSecret);
  registerSecret(env.refreshToken);
  registerSecret(env.clientId);
  const missing = [
    ['CWS_CLIENT_ID', env.clientId],
    ['CWS_CLIENT_SECRET', env.clientSecret],
    ['CWS_REFRESH_TOKEN', env.refreshToken],
    ['CWS_PUBLISHER_ID', env.publisherId],
  ]
    .filter(([, v]) => !v.trim())
    .map(([k]) => k);
  if (missing.length) throw new PublishError(`missing required env: ${missing.join(', ')}`, { exitCode: 2 });
  if (!/^[a-p]{32}$/.test(env.extensionId)) {
    throw new PublishError(`CWS_EXTENSION_ID "${env.extensionId}" is not a valid 32-char extension id`, { exitCode: 2 });
  }
  return env;
}

/** Validate the zip and return its manifest version. */
function inspectZip(zipPath, expectVersion, log) {
  if (!existsSync(zipPath)) throw new PublishError(`zip not found: ${zipPath} (run npm run zip:chrome)`, { exitCode: 2 });
  const size = statSync(zipPath).size;
  const manifest = readManifestFromZip(zipPath);
  if (manifest.manifest_version !== 3) {
    throw new PublishError(`manifest_version is ${manifest.manifest_version}, expected 3`, { exitCode: 2 });
  }
  if (typeof manifest.version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new PublishError(`manifest version "${manifest.version}" is not a valid Chrome version`, { exitCode: 2 });
  }
  if (manifest.background?.scripts) {
    throw new PublishError('manifest has background.scripts; this looks like the Firefox build', { exitCode: 2 });
  }
  if (expectVersion && manifest.version !== expectVersion) {
    throw new PublishError(`zip version ${manifest.version} does not match --expect-version ${expectVersion}`, {
      exitCode: 2,
    });
  }
  const pkgVersion = packageVersion(root);
  if (!expectVersion && pkgVersion !== manifest.version) {
    log.warn(`zip version ${manifest.version} differs from package.json ${pkgVersion}; is the zip stale?`);
  }
  log.info(`zip ${zipPath} (${(size / 1024).toFixed(1)} KiB), "${manifest.name}" v${manifest.version}`);
  return manifest.version;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function request(what, url, { method = 'GET', headers = {}, body, retries = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt < retries) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      throw new PublishError(`${what}: network error: ${err.cause?.message ?? err.message}`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        throw new PublishError(`${what}: response was not JSON (HTTP ${res.status})`, { details: text.slice(0, 4000) });
      }
    }
    const transient = res.status === 429 || res.status >= 500;
    if (transient && attempt < retries) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const err = new PublishError(`${what}: HTTP ${res.status} ${res.statusText}`, { details: text.slice(0, 8000) });
    err.status = res.status;
    err.body = text;
    throw err;
  }
}

async function getAccessToken(env) {
  const form = new URLSearchParams({
    client_id: env.clientId,
    client_secret: env.clientSecret,
    refresh_token: env.refreshToken,
    grant_type: 'refresh_token',
  });
  let data;
  try {
    data = await request('token refresh', TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      retries: 2,
    });
  } catch (err) {
    if (err.status === 400 || err.status === 401) {
      err.message +=
        ' (check CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN; refresh tokens from an OAuth app in "Testing" status expire after 7 days)';
    }
    throw err;
  }
  if (!data.access_token) throw new PublishError('token refresh: response had no access_token');
  registerSecret(data.access_token);
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function versionsOf(revision) {
  return (revision?.distributionChannels ?? []).map((c) => c.crxVersion).filter(Boolean);
}

/** Compare dotted numeric versions: -1, 0, 1. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function describeStatus(s) {
  const pub = s.publishedItemRevisionStatus;
  const sub = s.submittedItemRevisionStatus;
  return [
    `published: ${pub ? `${pub.state} v${versionsOf(pub).join(',') || '?'}` : 'none'}`,
    `submitted: ${sub ? `${sub.state} v${versionsOf(sub).join(',') || '?'}` : 'none'}`,
    `lastAsyncUpload: ${s.lastAsyncUploadState ?? 'n/a'}`,
  ].join(' | ');
}

/**
 * Returns a reason string when `version` is already live or under review
 * (nothing to do), or null when an upload is needed.
 */
function alreadyHandled(status, version) {
  const sub = status.submittedItemRevisionStatus;
  if (sub && IN_REVIEW_STATES.has(sub.state) && versionsOf(sub).includes(version)) {
    return `v${version} is already submitted (${sub.state})`;
  }
  const pub = status.publishedItemRevisionStatus;
  if (pub && LIVE_STATES.has(pub.state) && versionsOf(pub).includes(version)) {
    return `v${version} is already ${pub.state}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await runMain('chrome', async (log) => {
  const args = parseCli();
  const version = inspectZip(args.zip, args.expectVersion, log);
  const env = readEnv();
  const item = `publishers/${encodeURIComponent(env.publisherId)}/items/${env.extensionId}`;
  log.info(`target item ${env.extensionId} (publisher id set, ${env.publisherId.length} chars)`);

  if (args.dryRun) {
    log.info(
      `dry run OK: env present, zip valid, would ${args.cancelPending ? 'cancel any pending review of an older version, then ' : ''}upload v${version}${args.skipPublish ? ' (upload only)' : ' and publish'}. No network calls made.`,
    );
    return;
  }

  const token = await getAccessToken(env);
  const auth = { Authorization: `Bearer ${token}` };
  const fetchStatus = () =>
    request('fetchStatus', `${API}/v2/${item}:fetchStatus`, { headers: auth, retries: 3 });

  // 1. Idempotency: is this version already with the store?
  const before = await fetchStatus();
  log.info(`store status: ${describeStatus(before)}`);
  if (before.takenDown) throw new PublishError('item is taken down for a policy violation; see the Developer Dashboard');
  if (before.warned) log.warn('item has a policy warning; see the Developer Dashboard');
  const handled = alreadyHandled(before, version);
  if (handled) {
    log.notice(`${handled}; nothing to do.`);
    return;
  }
  const live = versionsOf(before.publishedItemRevisionStatus);
  const newer = live.find((v) => cmpVersion(v, version) > 0);
  if (newer) {
    throw new PublishError(`store already has v${newer} published, newer than this zip's v${version}`, { exitCode: 2 });
  }

  // 2. Another version in review? The store will not accept a new package
  //    until that review ends (alreadyHandled() covered our own version).
  const sub = before.submittedItemRevisionStatus;
  if (sub && IN_REVIEW_STATES.has(sub.state)) {
    const pending = versionsOf(sub);
    const pendingNewer = pending.find((v) => cmpVersion(v, version) > 0);
    if (pendingNewer) {
      throw new PublishError(`store is reviewing v${pendingNewer}, newer than this zip's v${version}`, { exitCode: 2 });
    }
    const pendingLabel = pending.length ? `v${pending.join(', v')}` : 'an earlier version';
    if (!args.cancelPending) {
      log.warn(
        `the Chrome Web Store is still reviewing ${pendingLabel} (${sub.state}), so v${version} was NOT submitted. ` +
          `To submit it later, re-run the "Publish to stores" workflow for tag v${version} once that review finishes, ` +
          `or cancel the pending review (Developer Dashboard, or re-run with cancel_pending / --cancel-pending) and submit v${version} instead.`,
      );
      return;
    }
    log.info(`cancelling the pending review of ${pendingLabel} (${sub.state}) because --cancel-pending was given...`);
    await request('cancelSubmission', `${API}/v2/${item}:cancelSubmission`, { method: 'POST', headers: auth });
    log.notice(`cancelled the pending review of ${pendingLabel}; submitting v${version} instead.`);
  }

  // 3. Upload.
  log.info(`uploading v${version}...`);
  let upload;
  try {
    upload = await request('upload', `${API}/upload/v2/${item}:upload`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/zip' },
      body: readFileSync(args.zip),
    });
  } catch (err) {
    if (err instanceof PublishError && /version/i.test(err.body ?? '')) {
      err.message +=
        ' (the store rejected the version; the manifest version must be higher than the published one. If this version was uploaded in an earlier run but not submitted, submit it from the Developer Dashboard)';
    }
    throw err;
  }
  let state = upload.uploadState;
  log.info(`upload response: ${state}${upload.crxVersion ? ` v${upload.crxVersion}` : ''}`);

  // 4. Poll while the store processes the package.
  if (UPLOAD_IN_PROGRESS.has(state)) {
    const deadline = Date.now() + args.timeoutMs;
    let delay = 2000;
    let last;
    // Keep polling through IN_PROGRESS, and through NOT_FOUND / unset, which can
    // briefly appear before the async upload is registered.
    while (state !== 'SUCCEEDED' && state !== 'FAILED') {
      if (Date.now() + delay > deadline) {
        throw new PublishError(
          `upload still processing after ${args.timeoutMs / 1000}s (last state ${state ?? 'unset'}); check the Developer Dashboard, then re-run (re-runs are safe)`,
          { details: last ? JSON.stringify(last, null, 2) : undefined },
        );
      }
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.6), 30_000);
      last = await fetchStatus();
      state = last.lastAsyncUploadState;
      log.info(`upload state: ${state ?? 'unset'}`);
    }
    if (state === 'FAILED') {
      throw new PublishError('upload FAILED while processing', { details: JSON.stringify(last, null, 2) });
    }
  } else if (state === 'FAILED') {
    throw new PublishError('upload FAILED', { details: JSON.stringify(upload, null, 2) });
  } else if (state !== 'SUCCEEDED') {
    throw new PublishError(`unexpected upload state ${state}`, { details: JSON.stringify(upload, null, 2) });
  }
  if (upload.crxVersion && upload.crxVersion !== version) {
    log.warn(`store reports uploaded version ${upload.crxVersion}, expected ${version}`);
  }
  log.info(`upload of v${version} succeeded`);

  if (args.skipPublish) {
    log.notice(`v${version} uploaded as a draft (--skip-publish); submit it from the Developer Dashboard.`);
    return;
  }

  // 5. Submit for review / publish.
  let published;
  try {
    published = await request('publish', `${API}/v2/${item}:publish`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    });
  } catch (err) {
    // A concurrent or earlier run may have submitted this exact version already.
    const after = await fetchStatus().catch(() => null);
    const reason = after && alreadyHandled(after, version);
    if (reason) {
      log.notice(`${reason}; treating publish as done.`);
      return;
    }
    if (after) err.message += ` (store status: ${describeStatus(after)})`;
    throw err;
  }
  for (const w of published.warningInfo?.warnings ?? []) {
    log.warn(`publish warning ${w.reason}: ${w.description}`);
  }
  log.notice(`v${version} submitted to the Chrome Web Store: ${published.state ?? 'state unknown'}`);
});
