/* ==========================================================================
   WBA — first-party analytics. Free forever, no third party, no cookies.

   Writes anonymous events straight to our own Supabase `events` table.
   No cookies. No IP logging. No user-agent string. No cross-site anything.
   Nothing here identifies a person, so it needs no consent banner.

   Load on every page, AFTER main.js:
       <script src="js/analytics.js" defer></script>

   Requires: wba-app/analytics.sql to have been run in Supabase.
   ========================================================================== */
(function () {
  'use strict';

  var SB_URL = 'https://lynzhiyvggqyplssrapi.supabase.co';
  var SB_KEY = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';
  var ENDPOINT = SB_URL + '/rest/v1/events';

  /* Set to false for a zero-storage mode: every pageview stands alone and
     nothing is written to the browser at all. You lose the ability to link
     a lead back to the visit that produced it, which is most of the value. */
  var SESSION_STITCHING = true;

  /* Don't record your own visits. Add ?wba_ignore=1 to any page once. */
  try {
    if (location.search.indexOf('wba_ignore=1') > -1) localStorage.setItem('wba_ignore', '1');
    if (localStorage.getItem('wba_ignore') === '1') return;
  } catch (e) { /* storage blocked — carry on */ }

  /* ---------------------------------------------------------------- session */
  function sessionId() {
    if (!SESSION_STITCHING) return null;
    try {
      var s = sessionStorage.getItem('wba_sid');
      if (!s) {
        s = (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        sessionStorage.setItem('wba_sid', s);
      }
      return s;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ attribution */
  /* Captured once on landing, then remembered for the whole visit so a form
     submit five pages later still knows which ad or post sent them. */
  function attribution() {
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var out = {};
    try {
      var p = new URLSearchParams(location.search);
      var found = false;
      keys.forEach(function (k) { if (p.get(k)) { out[k] = p.get(k).slice(0, 120); found = true; } });

      if (found && SESSION_STITCHING) sessionStorage.setItem('wba_attr', JSON.stringify(out));
      if (!found && SESSION_STITCHING) {
        var saved = sessionStorage.getItem('wba_attr');
        if (saved) out = JSON.parse(saved);
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ----------------------------------------------------------------- device */
  function device() {
    var w = window.innerWidth || 0;
    if (w < 768) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  /* Only keep the referrer host, never the full URL with its query string. */
  function referrerHost() {
    try {
      if (!document.referrer) return '';
      var h = new URL(document.referrer).hostname;
      return h === location.hostname ? '' : h;
    } catch (e) { return ''; }
  }

  /* ------------------------------------------------------------------ send */
  var SID = sessionId();
  var ATTR = attribution();
  var REF = referrerHost();

  function send(name, label, value) {
    var row = {
      name: name,
      path: location.pathname.replace(/index\.html$/, '').replace(/(.)\/$/, '$1') || '/',
      label: label ? String(label).slice(0, 120) : null,
      referrer: REF || null,
      utm_source: ATTR.utm_source || null,
      utm_medium: ATTR.utm_medium || null,
      utm_campaign: ATTR.utm_campaign || null,
      utm_content: ATTR.utm_content || null,
      utm_term: ATTR.utm_term || null,
      device: device(),
      viewport_w: window.innerWidth || null,
      session_id: SID,
      value: (typeof value === 'number') ? value : null
    };

    var body = JSON.stringify([row]);

    /* fetch + keepalive, NOT navigator.sendBeacon.
       sendBeacon cannot perform a CORS preflight, and PostgREST needs
       Content-Type: application/json, which is not a "simple" content type —
       so every beacon gets blocked by CORS before it leaves the browser.
       (Verified against the live endpoint: beacon = CORS blocked,
       fetch = clean response.)
       keepalive lets the request survive the page being closed, which is the
       only thing sendBeacon was buying us. Payload limit is 64KB; ours is ~300 bytes. */
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: {
        apikey: SB_KEY,
        Authorization: 'Bearer ' + SB_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: body
    }).catch(function () { /* analytics must never break the page */ });
  }

  /* Expose for manual events elsewhere in the site */
  window.wbaTrack = send;

  /* --------------------------------------------------------------- pageview */
  send('pageview');

  /* ----------------------------------------------------------- scroll depth */
  var marks = [25, 50, 75, 100];
  var hit = {};
  var scrollTimer = null;
  function checkScroll() {
    scrollTimer = null;
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return;
    var pct = Math.round(((window.scrollY || doc.scrollTop) / scrollable) * 100);
    for (var i = 0; i < marks.length; i++) {
      if (pct >= marks[i] && !hit[marks[i]]) {
        hit[marks[i]] = true;
        send('scroll', null, marks[i]);
      }
    }
  }
  /* Throttled with setTimeout rather than requestAnimationFrame on purpose:
     rAF does not fire in background tabs or when the page isn't compositing,
     which would silently lose scroll events. 150ms is plenty here. */
  window.addEventListener('scroll', function () {
    if (scrollTimer === null) scrollTimer = setTimeout(checkScroll, 150);
  }, { passive: true });

  /* --------------------------------------------------------------- engaged */
  /* Fires once at 20 seconds. A visitor who stays 20s is a real reader, not a
     bounce, and this is the denominator worth measuring conversion against. */
  var engagedSent = false;
  setTimeout(function () {
    if (!engagedSent && !document.hidden) { engagedSent = true; send('engaged'); }
  }, 20000);

  /* ------------------------------------------------------------ click types */
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a, button');
    if (!a) return;

    var href = a.getAttribute('href') || '';
    var text = (a.innerText || a.textContent || '').trim().slice(0, 80);

    /* WhatsApp — the money click on this site */
    if (/wa\.me|whatsapp/i.test(href)) { send('whatsapp', text || href); return; }

    /* Phone and email */
    if (href.indexOf('tel:') === 0) { send('cta', 'phone: ' + text); return; }
    if (href.indexOf('mailto:') === 0) { send('cta', 'email: ' + text); return; }

    /* Anything explicitly marked up: <a data-track="hero-cta"> */
    var tag = a.getAttribute('data-track');
    if (tag) { send('cta', tag); return; }

    /* Primary buttons anywhere on the site */
    if (a.className && /btn-primary|btn-gold|btn-white/.test(a.className)) {
      send('cta', text || href);
      return;
    }

    /* Outbound links */
    if (href.indexOf('http') === 0) {
      try {
        var h = new URL(href, location.href).hostname;
        if (h && h !== location.hostname) send('outbound', h);
      } catch (err) { /* ignore */ }
    }
  }, true);

  /* ------------------------------------------------------------- form usage */
  /* form_start fires on first interaction with any enquiry field — the gap
     between form_start and form_submit is your abandonment rate, which tells
     you whether the form is the problem or the page above it is. */
  var formStarted = false;
  document.addEventListener('focusin', function (e) {
    if (formStarted) return;
    var el = e.target;
    if (!el || !el.tagName) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(el.tagName) === -1) return;
    formStarted = true;
    send('form_start', el.id || el.name || el.type);
  }, true);

  /* form_submit is fired from main.js on genuine success — see install notes. */

  /* --------------------------------------------------------- time on page */
  var start = Date.now();
  var timeSent = false;
  function sendTime() {
    if (timeSent) return;
    timeSent = true;
    var secs = Math.round((Date.now() - start) / 1000);
    if (secs > 2 && secs < 3600) send('time', null, secs);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendTime();
  });
  window.addEventListener('pagehide', sendTime);
})();
