import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAccessDismissed, saveAccessDismissed } from './access-dismissal';

/**
 * One blanket grant instead of per-site ones. Browsers let the user withhold
 * site access (Chrome's "On click", Firefox's per-site menu), and a Firefox
 * MV3 content script only runs where the host permission is granted — a
 * sideloaded add-on starts with nothing and looks dead. The all-sites grant is
 * buried in about:addons, but `permissions.request` from a click asks for
 * every site at once.
 *
 * `<all_urls>` is declared in the manifest's required `host_permissions`, not
 * in `optional_host_permissions`, and asking for it this way is sound on both
 * engines:
 *  - Chrome documents `request` as taking permissions that are "defined in
 *    the optional_permissions field of the manifest or be required
 *    permissions that were withheld by the user". Verified against a real
 *    Chromium with site access set to "On click": `contains` turns false,
 *    `getAll().origins` turns `[]`, and `request({origins:['<all_urls>']})`
 *    from a click raises the browser's own grant dialog — where a genuinely
 *    undeclared permission is rejected at once with "Only permissions
 *    specified in the manifest may be requested."
 *  - Firefox MV3 treats host permissions as revocable, and builds the set
 *    `request` validates against from the manifest's optional permissions
 *    "including host permissions if originControls is true" (Firefox source
 *    docs, Extension.manifestOptionalPermissions), which MV3 switches on.
 * Which is a claim about two engines' current behaviour, so the banner does
 * not bet the user's time on it: a *rejected* request means this browser will
 * not let the extension ask, and then the banner stops offering a button that
 * does nothing and says where to grant it by hand instead.
 */
const ALL_URLS: chrome.permissions.Permissions = { origins: ['<all_urls>'] };

/**
 * How much of the web the extension may read.
 *  - 'unknown': the browser would not say. The banner stays silent.
 *  - 'all': every site, as declared.
 *  - 'some': a subset the user chose. Pages inside it do convert, so the
 *    banner must not claim otherwise (review r8 #7).
 *  - 'none': nothing. Select-to-convert is dead everywhere.
 */
type Access = 'unknown' | 'all' | 'some' | 'none';

/**
 * What we actually need from the permissions API, declared here because the
 * bundled @types/chrome does not match the runtime on two points: it types
 * `permissions` as always present (it is absent in the website build and under
 * jsdom), and it gives the events only `addListener`, though both browsers
 * support removing one.
 */
interface PermissionEvent {
  addListener(cb: () => void): void;
  removeListener?(cb: () => void): void;
}

interface PermissionsApi {
  contains(permissions: chrome.permissions.Permissions): Promise<boolean>;
  request?(permissions: chrome.permissions.Permissions): Promise<boolean>;
  getAll?(): Promise<chrome.permissions.Permissions>;
  onAdded?: PermissionEvent;
  onRemoved?: PermissionEvent;
}

/** Absent in the website build and under jsdom; then the banner stays away. */
function permissionsApi(): PermissionsApi | undefined {
  try {
    if (typeof chrome === 'undefined') return undefined;
    const api = chrome.permissions as unknown as PermissionsApi | undefined;
    return api && typeof api.contains === 'function' ? api : undefined;
  } catch {
    return undefined;
  }
}

/** Where the user can change their mind, named for the browser they are in. */
function laterHint(): string {
  const firefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
  return firefox
    ? 'You can allow it later in about:addons → this add-on → Permissions.'
    : 'You can allow it later from the extension’s Site access menu.';
}

/** Where to grant it by hand, when this browser will not let us ask. */
function manualHint(): string {
  const firefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
  return firefox
    ? 'This browser won’t let the extension ask. Open about:addons → this add-on → Permissions and allow access to all sites.'
    : 'This browser won’t let the extension ask. Open chrome://extensions → this extension → Details → Site access and choose “On all sites”.';
}

/**
 * Read how much access we have. `contains` answers the all-sites question;
 * `getAll` is what tells a user who allowed a few sites apart from one who
 * allowed none — on a real Chromium, withholding gives `origins: []` and a
 * per-site grant gives exactly those patterns.
 */
async function readAccess(api: PermissionsApi): Promise<Access> {
  if (await api.contains(ALL_URLS)) return 'all';
  if (typeof api.getAll !== 'function') return 'none';
  try {
    const all = await api.getAll();
    return (all?.origins?.length ?? 0) > 0 ? 'some' : 'none';
  } catch {
    // The all-sites answer was readable and said no; that much is honest.
    return 'none';
  }
}

export function AccessBanner(): JSX.Element | null {
  const api = permissionsApi();
  const [access, setAccess] = useState<Access>('unknown');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  /** This browser rejected the request outright: asking again is pointless. */
  const [cannotAsk, setCannotAsk] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // Only a grant that lands while the popup is open deserves a confirmation.
  const wasWithheld = useRef(false);

  const settle = useCallback((next: Access): void => {
    setAccess(next);
    if (next === 'all') {
      if (wasWithheld.current) setConfirm(true);
      setRefused(false);
      // Access is no longer withheld, so a later revoke should be able to say
      // so once more rather than being silenced by an old dismissal.
      setDismissed(false);
      void saveAccessDismissed(false);
    }
    wasWithheld.current = next === 'none' || next === 'some';
  }, []);

  useEffect(() => {
    let alive = true;
    void loadAccessDismissed().then((d) => {
      if (alive && d) setDismissed(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    const check = (): void => {
      void readAccess(api).then(
        (next) => {
          if (alive) settle(next);
        },
        () => {
          // Cannot tell: say nothing rather than nag.
          if (alive) setAccess('unknown');
        },
      );
    };
    check();
    // Firefox may close the popup to show the prompt, so the grant can land
    // while this popup is gone; a fresh mount re-checks. When the popup does
    // survive, these keep it honest.
    api.onAdded?.addListener(check);
    api.onRemoved?.addListener(check);
    return () => {
      alive = false;
      api.onAdded?.removeListener?.(check);
      api.onRemoved?.removeListener?.(check);
    };
  }, [api, settle]);

  function requestAccess(): void {
    if (!api || typeof api.request !== 'function') return;
    setBusy(true);
    // Must stay inside the click: the prompt needs the user gesture.
    void Promise.resolve(api.request(ALL_URLS)).then(
      (ok) => {
        setBusy(false);
        // The request is all-or-nothing, so a `true` means every site.
        if (ok) {
          settle('all');
          return;
        }
        setRefused(true);
        // A refusal may still leave a subset the user allowed earlier, so
        // re-read rather than assuming nothing is granted.
        void readAccess(api).then(settle, () => settle('none'));
      },
      () => {
        // Not a refusal: this browser would not even ask. Stop offering a
        // button that cannot work and point at the setting instead.
        setBusy(false);
        setCannotAsk(true);
      },
    );
  }

  function dismiss(): void {
    setDismissed(true);
    void saveAccessDismissed(true);
  }

  if (!api) return null;
  if (access === 'unknown') return null;
  if (access === 'all') {
    return confirm ? (
      <p className="tzx-access-ok" role="status">
        Access allowed — reading pages now.
      </p>
    ) : null;
  }
  if (dismissed) return null;

  const canAsk = typeof api.request === 'function' && !cannotAsk;
  return (
    <section className="tzx-access" aria-label="Site access">
      <p className="tzx-access-text">
        {access === 'some'
          ? 'Times convert on the sites you’ve allowed. On other pages they won’t, until you allow this extension to read them.'
          : 'Times on pages won’t convert until you allow this extension to read sites.'}
      </p>
      <div className="tzx-access-actions">
        {canAsk && (
          <button type="button" className="tzx-access-btn" onClick={requestAccess} disabled={busy}>
            Allow on all sites
          </button>
        )}
        <button type="button" className="tzx-access-dismiss" onClick={dismiss}>
          Don’t show again
        </button>
      </div>
      {cannotAsk && <p className="tzx-access-hint">{manualHint()}</p>}
      {refused && !cannotAsk && <p className="tzx-access-hint">{laterHint()}</p>}
    </section>
  );
}
