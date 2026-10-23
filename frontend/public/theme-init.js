// Theme preference (light / dark / system) — the ONLY implementation, shared by the first paint and React.
// Loaded as a same-origin classic script in <head> (no inline script: CSP `default-src 'self'` stays intact), so the
// saved theme is applied before anything is drawn. React reads and changes the theme only through `window.ncTheme`.
//
// - The preference lives only in this browser (localStorage key below); nothing is sent to the server.
// - Default and every unreadable / unknown value: "system" (the OS setting; CSS media query decides).
// - An explicit choice sets <html data-theme="light|dark">, which wins over the OS setting; "system" removes it.
// - Without localStorage (blocked, private mode) the choice still works in the current tab, it is just not kept.
(function () {
  'use strict';
  var KEY = 'nc-theme';
  var VALUES = ['system', 'light', 'dark'];
  function valid(v) { return VALUES.indexOf(v) >= 0; }
  function read() {
    try {
      var v = window.localStorage.getItem(KEY);
      return valid(v) ? v : 'system';
    } catch (e) {
      return 'system';
    }
  }
  function apply(pref) {
    var root = document.documentElement;
    if (pref === 'light' || pref === 'dark') root.setAttribute('data-theme', pref);
    else root.removeAttribute('data-theme');
  }
  /** Returns false when the choice could not be stored (it still applies to this tab). */
  function save(pref) {
    if (!valid(pref)) return false;
    try {
      if (pref === 'system') window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, pref);
      return true;
    } catch (e) {
      return false;
    }
  }
  apply(read());
  window.ncTheme = Object.freeze({ KEY: KEY, values: VALUES.slice(), valid: valid, read: read, apply: apply, save: save });
})();
