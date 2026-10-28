/** Build metadata injected at compile time by Vite `define`. */
export interface BuildInfo {
  readonly version: string;
  /** Short git commit the build was produced from; may carry a "-dirty" suffix. */
  readonly commit: string;
  /** ISO-8601 UTC timestamp of the build. */
  readonly builtAt: string;
  /** Canonical GitHub repo URL, or '' when unknown. */
  readonly repoUrl: string;
  /** GitHub release page for this version, or '' when the repo is unknown. */
  readonly releaseUrl: string;
  /** GitHub commit page for this build, or '' when the repo/commit is unknown. */
  readonly commitUrl: string;
}

function safe(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/** The raw commit without the "-dirty" working-tree marker. */
function cleanCommit(commit: string): string {
  return commit.replace(/-dirty$/, '');
}

export function getBuildInfo(): BuildInfo {
  const version = safe(typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined, '0.0.0');
  const commit = safe(typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : undefined, 'unknown');
  const builtAt = safe(typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : undefined, '');
  const repoUrl = safe(typeof __REPO_URL__ !== 'undefined' ? __REPO_URL__ : undefined, '');

  const sha = cleanCommit(commit);
  const releaseUrl = repoUrl ? `${repoUrl}/releases/tag/v${version}` : '';
  const commitUrl = repoUrl && sha !== 'unknown' ? `${repoUrl}/commit/${sha}` : '';

  return { version, commit, builtAt, repoUrl, releaseUrl, commitUrl };
}
