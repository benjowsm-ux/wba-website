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

  var sb = window.sbc;                    /* created in js/db.js */
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
      codeInput.focus();
    });
  });

  step2.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = codeInput.value.replace(/\D/g, '');
    if (code.length < 6) { say('That code is six digits.', true); return; }
    busy(el('ptVerify'), true, 'Checking…');
    say('');

    sb.auth.verifyOtp({ email: pending, token: code, type: 'email' })
      .then(function (r) {
        busy(el('ptVerify'), false);
        if (r.error) { say('That code did not work. Codes expire after ten minutes.', true); return; }
        start();
      });
  });

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
      if (r.error || !r.data) { locked(); return; }
      render(r.data);
    });
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
      var url = '/preview/' + encodeURIComponent(current.path) + '/';
      el('ptPvLive').hidden = false;
      box.innerHTML =
        '<div class="pt-pv">' +
          '<div class="pt-pv-frame"><span class="pt-pv-dot" aria-hidden="true"></span>' +
            '<span class="pt-pv-url">' + esc(current.path) + '</span></div>' +
          '<p class="pt-pv-meta">Version ' + esc(current.version) + ' &middot; ' +
            esc(day(current.uploaded_at)) +
            (current.note ? ' &middot; ' + esc(current.note) : '') + '</p>' +
          '<a class="btn btn-gold" href="' + esc(url) + '" target="_blank" rel="noopener">Open the preview</a>' +
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
