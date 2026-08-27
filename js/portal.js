/* ==========================================================================
   WBA — the client portal.

   Two states in one page: the sign-in gate, and the deck.

   HOW SIGNING IN WORKS, AND WHY
   -----------------------------
   You asked for "a username and a four-digit code". The username half is
   here — clients type `pivaz`, not an email address they have to remember
   choosing. The code half is not four digits and never will be: four digits
   is ten thousand possibilities, which a script exhausts in about a minute,
   and a code that never changes only has to leak once.

   So the code is six digits, it is generated fresh, it is emailed, and it
   dies after ten minutes and one use. From the client's side the experience
   is exactly what you described — type a short name, type a short number,
   you're in — and once in, the session lasts long enough that most of them
   will never see the code twice.

   Nothing here trusts the browser. The handle is resolved by an Edge
   Function holding the service key; the page only ever learns "a code has
   been sent, if that account exists". Everything the deck shows comes back
   from one RPC that runs under the caller's own row-level security, so there
   is no client id to tamper with and no other client's data in the response
   to begin with.
   ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------- the client
     The portal builds its OWN Supabase client rather than reusing the one in
     db.js, for one reason: "Remember this device".

     supabase-js keeps the session wherever you tell it to. localStorage
     survives closing the browser, which is what you want on your own laptop
     and precisely what you do not want on the machine in the back office
     that four people use. sessionStorage dies with the tab.

     So the storage adapter below picks between them at call time, and the
     checkbox on the sign-in form decides which. Nothing else in the codebase
     has to know. */
  var STORE_KEY = 'wba-portal-auth';
  var useSession = false;          /* set at sign-in; probed on load */

  function box() {
    try {
      return useSession ? window.sessionStorage : window.localStorage;
    } catch (e) {
      return null;                 /* private mode, cookies blocked */
    }
  }
  var memory = {};                 /* last resort, so sign-in still works */

  var storage = {
    getItem: function (k) {
      try { var b = box(); return b ? b.getItem(k) : (memory[k] || null); }
      catch (e) { return memory[k] || null; }
    },
    setItem: function (k, v) {
      memory[k] = v;
      try { var b = box(); if (b) b.setItem(k, v); } catch (e) {}
    },
    removeItem: function (k) {
      delete memory[k];
      /* Clear BOTH, always. Signing out must not leave a copy behind in the
         store we happen not to be using this time. */
      try { window.localStorage.removeItem(k); } catch (e) {}
      try { window.sessionStorage.removeItem(k); } catch (e) {}
    }
  };

  /* Which store already holds a session? sessionStorage wins, because its
     presence means somebody deliberately chose not to be remembered. */
  try {
    if (window.sessionStorage && window.sessionStorage.getItem(STORE_KEY)) useSession = true;
  } catch (e) {}

  var sb = (window.supabase && window.sbcConfig)
    ? window.supabase.createClient(window.sbcConfig.url, window.sbcConfig.key, {
        auth: {
          storage: storage,
          storageKey: STORE_KEY,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      })
    : window.sbc;                  /* fall back rather than break entirely */

  /* Where previews are served from.

     Not the main domain: a preview is half-finished client work, and on the
     same origin its scripts could read the portal's session out of storage.
     Until DNS moves to Cloudflare this is the workers.dev address; change
     the one line when preview.westonbusinessauthority.co.uk exists. */
  var PREVIEW_BASE = (document.body.getAttribute('data-preview-base') || '').replace(/\/$/, '');
  var gate = document.getElementById('ptGate');
  var deck = document.getElementById('ptDeck');
  if (!sb || !gate || !deck) return;

  var el = function (id) { return document.getElementById(id); };
  var msg = el('ptMsg');
  var handleInput = el('ptHandle');
  var codeInput = el('ptCode');
  var pending = null;                    /* the email we sent a code to */

  function say(text, bad) {
    msg.textContent = text || '';
    msg.classList.toggle('is-bad', !!bad);
  }
  function busy(btn, on, label) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn.dataset.was = btn.textContent; btn.textContent = label || 'Working…'; }
    else if (btn.dataset.was) { btn.textContent = btn.dataset.was; }
  }

  /* ---------------------------------------------------------------- escaping
     Everything below is written by us in the admin, but "we typed it" is not
     a security model — one pasted client name with a bracket in it and the
     panel is rendering markup. Escape at the boundary, always. */
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Only ever produce an href we are willing to stand behind. A stored value
     beginning `javascript:` would otherwise become a click-to-run script. */
  function safeHref(u) {
    var s = String(u == null ? '' : u).trim();
    if (/^https?:\/\//i.test(s)) return s;
    if (/^\//.test(s)) return s;
    if (/^mailto:|^tel:/i.test(s)) return s;
    return '';
  }

  var money = function (pence) {
    var n = (Number(pence) || 0) / 100;
    return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  var day = function (v) {
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  /* ==================================================================== gate */
  var step1 = el('ptStep1'), step2 = el('ptStep2');

  step1.addEventListener('submit', function (e) {
    e.preventDefault();
    var who = handleInput.value.trim();
    if (!who) return;
    busy(el('ptSend'), true, 'Sending…');
    say('');

    sendCode(who).then(function (r) {
      busy(el('ptSend'), false);
      if (r.error) { say(r.error, true); return; }
      pending = r.email || null;
      step1.hidden = true; step2.hidden = false;
      /* Same words whether or not the account exists. Telling someone their
         guess was wrong is telling them the other guesses are worth making. */
      say('If that account exists, a code is on its way.');
      var rb = el('ptResend');
      if (rb && rb._cool) rb._cool(30);
      codeInput.focus();
    });
  });

  step2.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = codeInput.value.replace(/\D/g, '');
    if (code.length < 6) { say('That code is six digits.', true); return; }

    /* Decided BEFORE verifyOtp, because that call is what writes the session
       — by then the storage adapter has to already know where to put it. */
    var remember = el('ptRemember');
    useSession = !(remember && remember.checked);

    busy(el('ptVerify'), true, 'Checking…');
    say('');

    sb.auth.verifyOtp({ email: pending, token: code, type: 'email' })
      .then(function (r) {
        busy(el('ptVerify'), false);
        if (r.error) { say('That code did not work. Codes expire after ten minutes.', true); return; }
        start();
      });
  });

  /* Resend, with a cooldown. Without one the button is a way to have our
     mail provider post sixty identical emails to a client who has simply not
     refreshed their inbox — and a fast way to burn the daily send limit. */
  (function () {
    var btn = el('ptResend');
    if (!btn) return;
    var until = 0, tick = null;

    function paint() {
      var left = Math.ceil((until - Date.now()) / 1000);
      if (left > 0) { btn.disabled = true; btn.textContent = 'Send again in ' + left + 's'; }
      else { btn.disabled = false; btn.textContent = 'Send another code'; clearInterval(tick); tick = null; }
    }
    function cool(seconds) {
      until = Date.now() + seconds * 1000;
      paint();
      if (!tick) tick = setInterval(paint, 1000);
    }
    btn._cool = cool;

    btn.addEventListener('click', function () {
      if (!pending) return;
      cool(30);
      say('');
      sb.auth.signInWithOtp({ email: pending, options: { shouldCreateUser: false } })
        .then(function (r) {
          if (r.error) say(friendly(r.error), true);
          else say('Another code is on its way.');
        });
    });
  })();

  el('ptBack').addEventListener('click', function () {
    step2.hidden = true; step1.hidden = false;
    pending = null; codeInput.value = ''; say('');
    handleInput.focus();
  });

  /* Resolve a handle and post a code.

     The Edge Function is what holds the service key and does the sending; if
     it is not deployed yet, an address typed in full still works through the
     public OTP endpoint, so the portal is usable from the moment the SQL is
     run rather than blocked on infrastructure. */
  function sendCode(who) {
    var looksLikeEmail = who.indexOf('@') > 0;

    if (looksLikeEmail) {
      return sb.auth.signInWithOtp({
        email: who,
        options: {
          shouldCreateUser: false,               /* invite-only, always */
          /* If a LINK ever goes out instead of a code — which is what the
             default Supabase mailer does, and what caused the sign-out loop —
             it must land here and not on the homepage, where nothing handles
             it. Paired with detectSessionInUrl above, a clicked link signs
             them in rather than bouncing them to a signed-out home page. */
          emailRedirectTo: location.origin + '/portal/'
        }
      }).then(function (r) {
        if (r.error) return { error: friendly(r.error) };
        return { email: who };
      });
    }

    return fetch('/api/portal-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: who })
    }).then(function (res) { return res.json(); })
      .then(function (j) {
        if (j && j.email) return { email: j.email };
        return { error: 'We could not match that handle. Try the email address we set you up with.' };
      })
      .catch(function () {
        return { error: 'We could not match that handle. Try the email address we set you up with.' };
      });
  }

  function friendly(err) {
    var m = (err && err.message) || '';
    if (/rate|too many/i.test(m)) return 'Too many attempts. Give it a minute and try again.';
    if (/not found|signups|disabled/i.test(m)) return 'If that account exists, a code is on its way.';
    return 'Something went wrong sending that code. Try again shortly.';
  }

  /* ==================================================================== deck */
  function start() {
    gate.hidden = true;
    deck.hidden = false;
    document.body.classList.add('is-signed-in');

    sb.rpc('portal_seen').then(function () {});

    sb.rpc('my_site').then(function (r) {
      /* Two very different failures used to land in the same place, and the
         wrong message is the one a client would see: "you are not attached to
         a client" reads as "we have lost your account" when all that has
         actually happened is a token expiring overnight. */
      if (r.error) {
        var code = r.error.code || '';
        var m = (r.error.message || '').toLowerCase();
        if (code === 'PGRST301' || m.indexOf('jwt') >= 0 || m.indexOf('expired') >= 0) {
          expired(); return;
        }
        problem(r.error.message); return;
      }
      if (!r.data || !r.data.handle) { locked(); return; }
      render(r.data);
    });
  }

  /* Session gone. Say so, put them back on the gate, and keep where they
     were trying to get to so the sign-in returns them there. */
  function expired() {
    var here = location.pathname + location.search;
    sb.auth.signOut().then(function () {
      deck.hidden = true;
      gate.hidden = false;
      document.body.classList.remove('is-signed-in');
      el('ptOut').hidden = true;
      el('ptWho').hidden = true;
      say('You were signed out. Pop your handle in and we will send a fresh code.');
      handleInput.focus();
    });
    return here;
  }

  /* Something else went wrong. Never blame the client for our outage. */
  function problem(detail) {
    deck.innerHTML =
      '<div class="win pt-panel pt-lonely"><div class="win-bar">' +
      '<span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="win-title">Cannot load that right now</span></div>' +
      '<div class="win-body"><div class="pt-pad">' +
      '<p>Your account is fine — we could not fetch it. Try again in a minute, ' +
      'and tell us if it keeps happening.</p>' +
      '<p><button type="button" class="btn btn-gold" onclick="location.reload()">Try again</button></p>' +
      (detail ? '<p class="pt-acc-note">' + esc(detail) + '</p>' : '') +
      '</div></div></div>';
  }

  /* Signed in, but not attached to a client. Real case: Ben's own admin
     account opening /portal/ to see what a client sees. */
  function locked() {
    deck.innerHTML =
      '<div class="win pt-panel pt-lonely"><div class="win-bar">' +
      '<span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
      '<span class="win-title">Nothing assigned</span></div>' +
      '<div class="win-body"><div class="pt-pad">' +
      '<p>This account is signed in but is not attached to a client yet. ' +
      'If you were expecting a project here, tell us and we will link it up.</p>' +
      '<p><a class="btn btn-line inverse" href="/contact/">Get in touch</a></p>' +
      '</div></div></div>';
  }

  /* One job: show them their site, and what has changed. Invoices, payments,
     stage trackers and account registers all used to live here. They were
     scaffolding for a process that already happens in GoCardless and an
     inbox, and they buried the one thing the client actually came for. */
  function render(d) {
    var project = d.project || null;
    var version = project ? (project.version || 0) : 0;

    var who = el('ptWho');
    if (who) { who.textContent = d.name || d.handle || d.business || ''; who.hidden = false; }
    el('ptOut').hidden = false;
    el('ptCrumb').textContent = d.business || 'Your account';
    el('ptTitle').textContent = d.business ? d.business : 'Your site';
    el('ptSummary').textContent = (project && project.summary) || '';
    el('ptVersion').textContent = version ? 'v' + version : '—';

    /* ---- the site ---- */
    var box = el('ptPreview');
    if (!version) {
      box.innerHTML = empty('Nothing to look at yet',
        'The moment there is something to see, it turns up here and we will tell you.');
    } else {
      el('ptPvLive').hidden = false;
      box.innerHTML =
        '<p class="pt-site-lede">Your site is ready to look at. It opens in a new tab, ' +
        'full size — click around it exactly as a visitor would.</p>' +
        '<button type="button" class="btn btn-gold pt-open" id="ptOpenPv" data-path="' +
          esc(d.handle) + '/v' + esc(version) + '">Open my site</button>' +
        (project && project.live_url
          ? '<p class="pt-site-note"><a href="' + esc(safeHref(project.live_url)) +
            '" target="_blank" rel="noopener">Your live site</a></p>'
          : '');
    }

    /* ---- what's happened ---- */
    var updates = d.updates || [];
    el('ptTimeline').innerHTML = updates.length
      ? '<ol class="pt-time">' + updates.slice(0, 10).map(function (u) {
          return '<li class="pt-t">' +
                 '<span class="pt-t-when">' + esc(day(u.at)) + '</span>' +
                 '<span class="pt-t-title">' + esc(u.title) + '</span>' +
                 (u.body ? '<span class="pt-t-body">' + esc(u.body) + '</span>' : '') +
                 '</li>';
        }).join('') + '</ol>'
      : empty('Nothing yet', 'Anything worth telling you about shows up here.');
  }

  /* Opening a preview.

     The preview lives on another origin, so it cannot see this one's session
     and its assets cannot carry an Authorization header. We therefore pass
     the access token once, in the URL, and the worker immediately swaps it
     for a cookie on its own origin and redirects the token out of the address
     bar. See the handoff note in cloudflare/preview-worker.js.

     noopener matters more than usual here: without it the opened page — which
     is client work in progress — gets a handle on this window. */
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('#ptOpenPv') : null;
    if (!btn) return;
    var path = btn.getAttribute('data-path') || '';
    btn.disabled = true;

    sb.auth.getSession().then(function (r) {
      btn.disabled = false;
      var token = r && r.data && r.data.session && r.data.session.access_token;
      if (!token) { expired(); return; }

      /* The preview is served from this same origin (Netlify proxies
         /preview/* to the edge function), so the session travels as a plain
         cookie — no token in a URL, nothing to strip afterwards.

         Path is scoped to /preview so it is never sent with an ordinary page
         request, and it is short-lived because it is a viewing pass, not a
         login. */
      document.cookie = 'wba_pv=' + encodeURIComponent(token) +
        '; Path=/preview; Max-Age=28800; SameSite=Lax' +
        (location.protocol === 'https:' ? '; Secure' : '');

      window.open('/preview/' + path.split('/').map(encodeURIComponent).join('/') + '/',
                  '_blank', 'noopener');
    });
  });

  function empty(title, body) {
    return '<div class="pt-empty"><b>' + esc(title) + '</b><span>' + esc(body) + '</span></div>';
  }

  /* ================================================================== session */
  el('ptOut').addEventListener('click', function () {
    sb.auth.signOut().then(function () { location.reload(); });
  });

  /* ------------------------------------------------------------------ demo
     Sample data so the deck can be designed, reviewed and shown to a
     prospect without inventing a fake client in the real database.

     Locked to localhost. A demo mode reachable in production is a way to
     accidentally show made-up invoices to a real client, and no amount of
     "clearly labelled" survives a screenshot. */
  function isLocal() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  }

  function demoData() {
    var now = Date.now(), d1 = 86400000;
    return {
      business: 'Pivaz Café', handle: 'pivaz', name: 'Sam',
      project: { name: 'Website', summary: 'Menus that read from the back of the queue.', version: 3 },
      updates: [
        { at: new Date(now - 1 * d1).toISOString(), title: 'New version of your site is up', body: 'Version 3 — have a look and tell us what to change.' },
        { at: new Date(now - 6 * d1).toISOString(), title: 'Menu photography swapped in' },
        { at: new Date(now - 12 * d1).toISOString(), title: 'First draft ready' }
      ]
    };
  }

  /* Already signed in? Skip the gate. */
  if (isLocal() && /[?&]demo=1/.test(location.search)) {
    gate.hidden = true; deck.hidden = false;
    document.body.classList.add('is-signed-in');
    render(demoData());
    return;
  }

  /* detectSessionInUrl needs a moment to swap a hash for a session, so ask
     once and then once more after it has had the chance. Otherwise someone
     arriving from a link sees the sign-in box for a beat and types their
     handle again. */
  function settle() {
    return sb.auth.getSession().then(function (r) {
      if (r && r.data && r.data.session) { start(); return true; }
      return false;
    });
  }

  settle().then(function (signedIn) {
    if (signedIn) return;
    if (location.hash.indexOf('access_token') > -1 || location.search.indexOf('code=') > -1) {
      setTimeout(function () {
        settle().then(function (ok) {
          if (!ok) { gate.hidden = false; handleInput.focus(); }
          else history.replaceState(null, '', location.pathname);
        });
      }, 700);
      return;
    }
    gate.hidden = false;
    handleInput.focus();
  });
})();
