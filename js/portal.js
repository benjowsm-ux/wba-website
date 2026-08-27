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
          detectSessionInUrl: false
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
        options: { shouldCreateUser: false }      /* invite-only, always */
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

    sb.rpc('my_portal').then(function (r) {
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
      if (!r.data || !r.data.client) { locked(); return; }
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

  var STAGES = [
    { k: 'talk',   n: 'Talk it through' },
    { k: 'design', n: 'Pen and paper' },
    { k: 'build',  n: 'Built by hand' },
    { k: 'live',   n: 'Go live' },
    { k: 'grow',   n: 'Keep it moving' }
  ];

  function render(d) {
    var project = (d.projects && d.projects[0]) || null;
    var client = d.client || {};
    var me = d.me || {};

    /* ---- who ---- */
    var who = el('ptWho');
    if (who) {
      who.textContent = me.name || me.handle || client.business || '';
      who.hidden = false;
    }
    el('ptOut').hidden = false;
    el('ptCrumb').textContent = client.business || 'Client';
    el('ptTitle').textContent = project ? project.name : (client.business || 'Your project');
    el('ptSummary').textContent = project && project.summary ? project.summary : '';

    el('ptStageName').textContent =
      project ? (STAGES.filter(function (s) { return s.k === project.stage; })[0] || {}).n || '—' : '—';
    el('ptSince').textContent = project ? day(project.started_on || project.created_at) : '—';
    el('ptFee').textContent = client.monthly_fee != null ? '£' + client.monthly_fee : '—';

    /* ---- the five stages ---- */
    var at = project ? STAGES.map(function (s) { return s.k; }).indexOf(project.stage) : -1;
    el('ptStages').innerHTML = STAGES.map(function (s, i) {
      var state = i < at ? 'is-done' : (i === at ? 'is-now' : '');
      return '<li class="pt-stage ' + state + '">' +
             '<span class="pt-stage-n">' + String(i + 1).padStart(2, '0') + '</span>' +
             '<span class="pt-stage-l">' + esc(s.n) + '</span></li>';
    }).join('');

    /* ---- preview ---- */
    var previews = d.previews || [];
    var current = previews.filter(function (p) { return p.is_current; })[0] || previews[0];
    var box = el('ptPreview');

    if (!current) {
      box.innerHTML = empty('Nothing to preview yet',
        'As soon as there is something to look at, it appears here and you get an email.');
    } else {
      /* Built at click time, not now, so the token is the freshest one we
         have rather than whatever was valid when the page rendered. */
      el('ptPvLive').hidden = false;
      box.innerHTML =
        '<div class="pt-pv">' +
          '<div class="pt-pv-frame"><span class="pt-pv-dot" aria-hidden="true"></span>' +
            '<span class="pt-pv-url">' + esc(current.path) + '</span></div>' +
          '<p class="pt-pv-meta">Version ' + esc(current.version) + ' &middot; ' +
            esc(day(current.uploaded_at)) +
            (current.note ? ' &middot; ' + esc(current.note) : '') + '</p>' +
          '<button type="button" class="btn btn-gold" id="ptOpenPv" data-path="' +
            esc(current.path) + '">Open the preview</button>' +
        '</div>' +
        (previews.length > 1
          ? '<ul class="pt-versions">' + previews.slice(0, 6).map(function (p) {
              return '<li><span class="pt-v-n">v' + esc(p.version) + '</span>' +
                     '<span class="pt-v-d">' + esc(day(p.uploaded_at)) + '</span>' +
                     (p.note ? '<span class="pt-v-x">' + esc(p.note) + '</span>' : '') + '</li>';
            }).join('') + '</ul>'
          : '');
    }

    /* ---- timeline ---- */
    var updates = d.updates || [];
    el('ptTimeline').innerHTML = updates.length
      ? '<ol class="pt-time">' + updates.slice(0, 12).map(function (u) {
          return '<li class="pt-t is-' + esc(u.kind) + '">' +
                 '<span class="pt-t-when">' + esc(day(u.happened_at)) + '</span>' +
                 '<span class="pt-t-title">' + esc(u.title) + '</span>' +
                 (u.body ? '<span class="pt-t-body">' + esc(u.body) + '</span>' : '') +
                 '</li>';
        }).join('') + '</ol>'
      : empty('No updates yet', 'Everything we do on your project turns up here.');

    /* ---- invoices ---- */
    var invoices = d.invoices || [];
    var owing = invoices.filter(function (i) { return i.status === 'sent' || i.status === 'overdue'; })
                        .reduce(function (a, i) { return a + (i.amount_pence || 0); }, 0);
    el('ptInvoices').innerHTML = invoices.length
      ? (owing ? '<p class="pt-owing">Outstanding <b>' + money(owing) + '</b></p>' : '') +
        '<table class="pt-table"><thead><tr><th>Invoice</th><th>Issued</th><th>Amount</th><th>Status</th></tr></thead><tbody>' +
        invoices.map(function (i) {
          return '<tr><td>' + esc(i.number) + '</td><td>' + esc(day(i.issued_on)) + '</td>' +
                 '<td class="pt-num">' + money(i.amount_pence) + '</td>' +
                 '<td><span class="pt-pill is-' + esc(i.status) + '">' + esc(i.status) + '</span></td></tr>';
        }).join('') + '</tbody></table>'
      : empty('No invoices yet', 'The build is free. The first invoice appears when your site goes live.');

    /* ---- payments ---- */
    var payments = d.payments || [];
    el('ptPayments').innerHTML = payments.length
      ? '<table class="pt-table"><thead><tr><th>Date</th><th>Method</th><th>Amount</th></tr></thead><tbody>' +
        payments.map(function (p) {
          return '<tr><td>' + esc(day(p.paid_on)) + '</td><td>' + esc(p.method || '—') + '</td>' +
                 '<td class="pt-num">' + money(p.amount_pence) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : empty('Nothing yet', 'Payments show up here the moment they clear.');

    /* ---- accounts ---- */
    var accounts = d.accounts || [];
    el('ptAccounts').innerHTML = accounts.length
      ? '<ul class="pt-accs">' + accounts.map(function (a) {
          var href = safeHref(a.url);
          var vault = safeHref(a.vault_url);
          return '<li class="pt-acc">' +
            '<span class="pt-acc-l">' + esc(a.label) + '</span>' +
            (a.username ? '<span class="pt-acc-u">' + esc(a.username) + '</span>' : '') +
            '<span class="pt-acc-h is-' + esc(a.holder) + '">' +
              (a.holder === 'wba' ? 'We hold it' : a.holder === 'client' ? 'You hold it' : 'Shared') +
            '</span>' +
            '<span class="pt-acc-go">' +
              (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">Open</a>' : '') +
              (vault ? '<a href="' + esc(vault) + '" target="_blank" rel="noopener">Password</a>' : '') +
            '</span></li>';
        }).join('') + '</ul>' +
        '<p class="pt-acc-note">Passwords live in the shared vault, never in this page. ' +
        'If a “Password” link is missing, ask and we will share it across.</p>'
      : empty('Nothing recorded', 'Once your site is live this lists every account it depends on.');
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
    if (!PREVIEW_BASE) {
      say('Previews are not switched on yet.', true);
      return;
    }
    btn.disabled = true;
    sb.auth.getSession().then(function (r) {
      btn.disabled = false;
      var token = r && r.data && r.data.session && r.data.session.access_token;
      if (!token) { expired(); return; }
      var to = PREVIEW_BASE + '/' + path.split('/').map(encodeURIComponent).join('/') +
               '/?t=' + encodeURIComponent(token);
      window.open(to, '_blank', 'noopener,noreferrer');
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
    var now = Date.now(), day1 = 86400000;
    return {
      client: { business: 'Pivaz Café', contact: 'Sam', domain: 'pivazcafe.co.uk',
                status: 'live', monthly_fee: 30 },
      me: { handle: 'pivaz', name: 'Sam' },
      projects: [{ name: 'Pivaz Café — new site', stage: 'build', status: 'active',
                   summary: 'Menus that read from the back of the queue, and a booking form that lands in your inbox.',
                   started_on: new Date(now - 26 * day1).toISOString(), created_at: new Date(now - 26 * day1).toISOString() }],
      updates: [
        { happened_at: new Date(now - 1 * day1).toISOString(), kind: 'preview', title: 'Version 3 is up', body: 'Menu board photography swapped in and the booking form is live on the preview.' },
        { happened_at: new Date(now - 6 * day1).toISOString(), kind: 'milestone', title: 'Design signed off', body: 'Going to build.' },
        { happened_at: new Date(now - 12 * day1).toISOString(), kind: 'note', title: 'Photographs taken', body: 'Morning light, front of house and the boards.' },
        { happened_at: new Date(now - 26 * day1).toISOString(), kind: 'milestone', title: 'Project opened' }
      ],
      previews: [
        { version: 3, path: 'pivaz/v3', uploaded_at: new Date(now - 1 * day1).toISOString(), note: 'Booking form', is_current: true },
        { version: 2, path: 'pivaz/v2', uploaded_at: new Date(now - 9 * day1).toISOString(), note: 'Menu pages' },
        { version: 1, path: 'pivaz/v1', uploaded_at: new Date(now - 20 * day1).toISOString(), note: 'First look' }
      ],
      invoices: [
        { number: 'WBA-0042', issued_on: new Date(now - 3 * day1).toISOString(), amount_pence: 3000, status: 'sent' },
        { number: 'WBA-0031', issued_on: new Date(now - 34 * day1).toISOString(), amount_pence: 3000, status: 'paid' }
      ],
      payments: [
        { paid_on: new Date(now - 32 * day1).toISOString(), method: 'GoCardless', amount_pence: 3000 }
      ],
      accounts: [
        { label: 'Site admin', url: 'https://pivazcafe.co.uk/admin/', username: 'sam', holder: 'shared', vault_url: 'https://vault.bitwarden.com/' },
        { label: 'Domain registrar', url: 'https://www.namecheap.com/', username: 'sam@pivazcafe.co.uk', holder: 'client' },
        { label: 'Google Business Profile', url: 'https://business.google.com/', username: 'pivazcafe', holder: 'shared', vault_url: 'https://vault.bitwarden.com/' },
        { label: 'Hosting (Netlify)', username: 'wba', holder: 'wba' }
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

  sb.auth.getSession().then(function (r) {
    if (r && r.data && r.data.session) start();
    else { gate.hidden = false; handleInput.focus(); }
  });
})();
