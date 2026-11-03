# Publishing to the stores

Every merge to `main` that produces a release also submits that version to the
[Chrome Web Store](https://chromewebstore.google.com/detail/tz-converter-%E2%80%94-timezone-t/cokhjgalkhboifkgoomlbaigocjpmhkk)
and [Firefox Add-ons (AMO)](https://addons.mozilla.org/en-US/firefox/addon/tz-converter-timezone-tools/).
This page covers the one-time credential setup, local dry runs, and re-publishing.

Until a store's secrets exist, its publish step is skipped with a warning and the
release still succeeds.

## 1. Chrome Web Store credentials

The Chrome publisher uses the Chrome Web Store API v2 with an OAuth refresh token.
Your Google account needs 2-Step Verification turned on to publish.
Google's guide: [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api).

1. **Create a Google Cloud project.** Open the [Google Cloud Console](https://console.cloud.google.com/),
   create a project (e.g. `tz-extension-publish`) and select it.
2. **Enable the API.** Search for "Chrome Web Store API" and click **Enable**.
3. **Configure the OAuth consent screen** (APIs & Services → OAuth consent screen,
   called "Google Auth Platform" in newer consoles):
   - User type **External**. Fill in the app name, support email and developer contact.
   - Skip scopes. Add your own Google account under **Test users**.
   - Then **publish the app** (Audience → Publish app / "In production").
     While the app is in *Testing*, Google expires refresh tokens after 7 days and
     the CI job will start failing with `invalid_grant`. You don't need Google's
     verification for an app only you use; you'll just click through an
     "unverified app" warning once in step 5.
4. **Create an OAuth client** (Credentials → Create credentials → OAuth client ID):
   - Application type **Web application**.
   - Authorized redirect URI: `https://developers.google.com/oauthplayground`
   - Save the **client ID** and **client secret**.
5. **Get a refresh token** with the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - Gear icon (top right) → tick **Use your own OAuth credentials** → paste the client ID and secret.
   - In "Input your own scopes" enter `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs**.
   - Sign in with the account that owns the store item and allow access.
   - Click **Exchange authorization code for tokens** and copy the **refresh token**.
6. **Find your publisher ID.** In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
   open the publisher's **Settings / Account** page; the publisher ID is shown there.
   (It is not the extension id.)

The extension id `cokhjgalkhboifkgoomlbaigocjpmhkk` is built into the script.
Set `CWS_EXTENSION_ID` only if you ever need to target a different item.

Optional sanity check before adding the secrets: in the Playground, request
`GET https://chromewebstore.googleapis.com/v2/publishers/PUBLISHER_ID/items/cokhjgalkhboifkgoomlbaigocjpmhkk:fetchStatus`.
A JSON reply with `publishedItemRevisionStatus` means the credentials and publisher ID are right.

## 2. Firefox Add-ons credentials

1. Sign in to AMO with the account that owns the add-on and open
   [Manage API Keys](https://addons.mozilla.org/developers/addon/api/key/).
2. Click **Generate new credentials**.
3. Copy the **JWT issuer** (looks like `user:12345:67`) and the **JWT secret**.
   The secret is shown once; generate new credentials if you lose it.

## 3. GitHub secrets

In the repository: **Settings → Environments → New environment** named exactly
`store-publish`. Add these **environment secrets**:

| Secret | Value |
|---|---|
| `CWS_CLIENT_ID` | OAuth client ID from step 1.4 |
| `CWS_CLIENT_SECRET` | OAuth client secret from step 1.4 |
| `CWS_REFRESH_TOKEN` | Refresh token from step 1.5 |
| `CWS_PUBLISHER_ID` | Publisher ID from step 1.6 |
| `AMO_JWT_ISSUER` | JWT issuer from step 2.3 |
| `AMO_JWT_SECRET` | JWT secret from step 2.3 |

Or with the GitHub CLI (each command prompts for the value, so it stays out of your shell history):

```bash
for s in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID AMO_JWT_ISSUER AMO_JWT_SECRET; do
  gh secret set "$s" --env store-publish
done
```

Recommended environment settings:

- **Deployment branches and tags → Selected branches:** `main`. Both the release
  workflow and manual re-publishes run from `main`, so nothing else needs the secrets.
- **Required reviewers** (optional): add yourself if you want to approve each
  store submission by hand. The publish job then waits for your click.

You can add one store's secrets and not the other; the missing store is skipped.

## 4. Dry run locally

A dry run checks that the env vars are set, the zip exists, and its manifest
(version, MV3, Firefox gecko id) is right. It makes no network calls.

```bash
npm run zip:chrome && npm run zip:firefox && npm run zip:source

# Put the six values in .env.store (gitignored), one KEY=value per line, then
# (--env-file needs Node 20.6+):
node --env-file=.env.store scripts/publish-chrome.mjs --dry-run
node --env-file=.env.store scripts/publish-firefox.mjs --dry-run
```

To publish from your machine, drop `--dry-run`. Other options:

- `publish-chrome.mjs --skip-publish` uploads a draft without submitting it for review.
- `publish-chrome.mjs --cancel-pending` cancels a pending review of an older
  version and submits this one instead (see [section 5](#5-what-happens-on-a-release)).
- `--expect-version 1.2.3` (both scripts) fails if the zip holds a different version.
- `--zip <path>` (both) and `--source <path>` (Firefox) pick other files.
- `publish-chrome.mjs --timeout <seconds>` caps how long to wait for the store to process the upload (default 300).

`npm run publish:chrome` and `npm run publish:firefox` run the same scripts
(pass flags after `--`, e.g. `npm run publish:chrome -- --dry-run`).

## 5. What happens on a release

`.github/workflows/release.yml`, on every push to `main`:

1. Typecheck, lint and test.
2. Bump the version from Conventional Commits, commit, tag `vX.Y.Z`.
3. Build `tz-extension-chrome.zip`, `tz-extension-firefox.zip`, and
   `tz-extension-source.zip` (a `git archive` of the release commit, for AMO reviewers).
4. Create the GitHub release with all three zips attached, and save them as the
   `release-packages` workflow artifact.
5. Call `.github/workflows/publish-stores.yml`, which runs one job per store in
   the `store-publish` environment:
   - **Chrome:** `scripts/publish-chrome.mjs` exchanges the refresh token, uploads
     the zip, waits for processing, and submits it for review. The update goes
     live automatically once Google approves it.
   - **Firefox:** `scripts/publish-firefox.mjs` unpacks the zip and runs
     `web-ext sign --channel=listed`, attaching the source archive and reviewer
     notes with the build steps (`npm ci && npm run build:firefox`, Node 20+,
     output in `dist-firefox/`). web-ext is an exact-pinned devDependency
     (10.8.0), so the job runs `npm ci` and uses `node_modules/.bin/web-ext`;
     web-ext gets only `PATH`, `HOME`, the temp dir, `LANG`/`CI` and the AMO
     credentials from the environment. It does not wait for review; AMO
     publishes the version once a reviewer approves it.

The two store jobs are independent: one failing does not stop the other.
Submissions to the same store never overlap (concurrency groups
`store-publish-chrome` and `store-publish-firefox`). Only the release job is
serialized per branch, so a publish job that is waiting for approval or for the
store does not hold up the next release.

Re-runs are safe. If the Chrome Web Store already has this version published or
in review, or AMO says the version already exists, the job ends green with a notice.

**Chrome review still pending for an older version.** With a release per merge,
the previous version is often still in Chrome review when the next one is
released. The store will not take a new package then, so the Chrome job uploads
nothing and ends green with a warning naming the version under review. To get
the new version in:

- wait for the review to finish, then re-publish the tag (section 6) with
  `store=chrome`; or
- re-publish the tag with **cancel_pending** ticked. That cancels the pending
  review (the API's `cancelSubmission`) and submits the new version instead,
  which goes to the back of the review queue. You can also cancel the review by
  hand in the Developer Dashboard and then re-publish.

AMO has no such limit; each version is queued for review on its own.

## 6. Re-publish a tag

Use this after adding secrets for an existing release, or to retry a failed submission.

1. **Actions → Publish to stores → Run workflow** (on `main`).
2. Enter the tag and pick `both`, `chrome` or `firefox`. Any tag that has a
   GitHub release works; `gh release list` shows them.
3. Tick **cancel_pending** only if Chrome is still reviewing an older version
   and you want this one submitted instead (see section 5).

The job does not rebuild anything. It downloads the zips attached to that tag's
GitHub release, so the stores get the same bytes as the release. The publish
scripts come from `main`, not from the tag, so tags made before the scripts
existed work too. For Firefox, older releases without a
`tz-extension-source.zip` asset get one generated from the tag with
`git archive` (`scripts/source-archive.mjs --ref <tag>`). If the tag has no
GitHub release, the job fails with an error saying so. From the CLI
(replace `vX.Y.Z` with the tag):

```bash
gh workflow run publish-stores.yml -f tag=vX.Y.Z -f store=both
gh workflow run publish-stores.yml -f tag=vX.Y.Z -f store=chrome -f cancel_pending=true
```

A store only accepts a version higher than the one it already has, so
re-publishing an old tag is only useful for a version the store hasn't received yet.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `token refresh: HTTP 401` / `invalid_client` ("The OAuth client was not found") | `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` don't name an existing OAuth client, or not the one the refresh token was made with. Copy both from that client (step 1.4); if it no longer exists, make a new client and a new refresh token (step 1.5) and update all three. |
| `publish: HTTP 400` / `INVALID_ITEM_METADATA` ("does not meet the requirements to be published"), after `upload … succeeded` | The package is fine; the listing is incomplete. Usually a release added a permission or host access whose justification isn't in the dashboard's **Privacy** tab yet. The API can't edit the listing: paste the missing text from `STORE_LISTING.md`, save, fix anything else the dashboard flags, then submit the draft there or re-publish the tag (section 6). |
| `token refresh: HTTP 400` / `invalid_grant` | Refresh token expired or revoked. Make sure the OAuth app is "In production" (step 1.3), get a new token (step 1.5), and update `CWS_REFRESH_TOKEN`. |
| `fetchStatus: HTTP 403` / `404` | Wrong `CWS_PUBLISHER_ID`, or the token belongs to an account that doesn't own the item. |
| Chrome warning "still reviewing vX … was NOT submitted" | An older version is in review. Re-publish the tag after that review finishes, or re-publish with `cancel_pending` (section 5). |
| Chrome publish refuses because of visibility | If you changed visibility in the dashboard, publish once by hand there; after that the API works again. |
| `upload still processing after 300s` | The store is slow. Check the dashboard, then re-run; the version check makes it safe. |
| AMO `401` / `Unauthorized` | Regenerate the AMO API credentials and update both `AMO_*` secrets. |
| AMO validation errors | Run `npm run build:firefox && npm exec web-ext -- lint --source-dir dist-firefox` locally (uses the pinned devDependency) and fix what it reports. |
| `web-ext is not installed` | Run `npm ci` first; web-ext is a devDependency. |
| `No GitHub release found for vX.Y.Z` | Manual re-publish needs a GitHub release for the tag. Check the tag name, or create the release with its zips first. |
| A store step shows "publish skipped" | Its secrets aren't set in the `store-publish` environment. |
