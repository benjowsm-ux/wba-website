/* ==========================================================================
   WBA — edit mode loader.

   Edit mode needs supabase-js (~40KB over the network) plus db.js and
   edit.js. A visitor gets no benefit from any of it. Putting those three
   tags on every page would tax every reader of the site so that one person
   can occasionally fix a typo, which is a bad trade and exactly the kind of
   thing that makes a CMS-backed site slow.

   So: this file is the only thing every page loads — about 800 bytes. It
   looks for a Supabase session in localStorage, and if there isn't one it
   returns immediately, having cost a visitor a single cached request and no
   parsing to speak of. Only a signed-in person pays for the editor.

   Finding a token is NOT authorisation. It only means "this browser has, at
   some point, signed in" — the token could be expired, or belong to a
   non-admin. edit.js still asks the server who you are, and row-level
   security still decides what you may write. This is a performance gate,
   nothing more.
   ========================================================================== */
(function () {
  'use strict';

  /* supabase-js v2 stores its session under sb-<project-ref>-auth-token. */
  function hasSession() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('sb-') === 0 && k.indexOf('-auth-token') > 0) return true;
      }
    } catch (e) {
      /* Storage can throw in private mode or when cookies are blocked.
         Treat that as "not signed in" rather than breaking the page. */
    }
    return false;
  }

  if (!hasSession()) return;

  var CHAIN = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    '/js/db.js',
    '/js/edit.js'
  ];

  /* In order: db.js needs the library, edit.js needs db.js. */
  (function next(i) {
    if (i >= CHAIN.length) return;
    var s = document.createElement('script');
    s.src = CHAIN[i];
    s.async = false;
    s.onload  = function () { next(i + 1); };
    s.onerror = function () {
      console.warn('[edit] could not load ' + CHAIN[i] + ' — edit mode unavailable.');
    };
    document.head.appendChild(s);
  })(0);
})();
