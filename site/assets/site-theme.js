/*
 * Site theme: System, Light or Dark, chosen with the header's theme button.
 *
 * The choice is the same `theme` field the world clock's own System / Light /
 * Dark control writes: the website keeps its settings as one JSON item in
 * localStorage (PREFS_KEY in src/lib/storage.ts), so one choice applies to
 * every page. Loaded in <head> as a plain classic script, before the page is
 * painted, so a stored Light never flashes Dark first (and the other way).
 *
 * `data-theme` on <html> is what the pages' CSS reads: 'light' or 'dark'
 * overrides the system, no attribute follows it.
 */
(function () {
  var KEY = 'tz-extension-prefs';
  var ORDER = ['system', 'light', 'dark'];
  var NAMES = { system: 'System', light: 'Light', dark: 'Dark' };
  var root = document.documentElement;

  function readPrefs() {
    try {
      var raw = window.localStorage.getItem(KEY);
      var obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function storedTheme() {
    var t = readPrefs().theme;
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  function apply(theme) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }

  /** What is on screen now: the attribute, which the clock app also sets. */
  function shownTheme() {
    var t = root.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  }

  function save(theme) {
    var prefs = readPrefs();
    prefs.theme = theme;
    var value = JSON.stringify(prefs);
    try {
      window.localStorage.setItem(KEY, value);
    } catch (e) {
      return; // private mode or storage off: the choice lasts for this page only
    }
    // The storage event reaches other tabs on its own. Tell this tab too, so
    // the world clock (which listens for it) takes the new theme at once
    // instead of writing its old one back on its next save.
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: value, storageArea: window.localStorage }));
    } catch (e) {
      /* an old browser without the StorageEvent constructor: other tabs still follow */
    }
  }

  apply(storedTheme());

  function wire() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    if (!buttons.length) return;

    function render() {
      var now = shownTheme();
      var next = ORDER[(ORDER.indexOf(now) + 1) % ORDER.length];
      for (var i = 0; i < buttons.length; i++) {
        var b = buttons[i];
        b.setAttribute('data-theme-shown', now);
        b.setAttribute('aria-label', 'Theme: ' + NAMES[now] + '. Switch to ' + NAMES[next]);
        b.setAttribute('title', 'Theme: ' + NAMES[now] + ' (click for ' + NAMES[next] + ')');
      }
    }

    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var next = ORDER[(ORDER.indexOf(shownTheme()) + 1) % ORDER.length];
        apply(next);
        save(next);
        render();
      });
    }

    // Another tab changed it, or the clock's own control did: follow along.
    window.addEventListener('storage', function (e) {
      if (e.key !== KEY) return;
      apply(storedTheme());
      render();
    });
    if (typeof MutationObserver === 'function') {
      new MutationObserver(render).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
