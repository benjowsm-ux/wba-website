/* ==========================================================================
   WBA — command palette.

   Press Ctrl+K (Cmd+K on a Mac) or / anywhere on the site and a search box
   opens over the page: type two or three letters, hit Enter, you are there.
   Every page, every article, and the handful of things people actually want
   to do — email us, ring us, start a free site — in one list.

   Why a marketing site has one at all: we sell websites and internal tools to
   local businesses, and the fastest way to show what "properly built" means
   is to have the site itself behave like a piece of software. It costs 6KB
   and it is the first thing anyone technical will try.

   How it is built, and why:

   - The button and the dialog are created here, in JavaScript, not in the
     markup of twenty pages. If scripting is off there is no palette, so
     there must be no button advertising one. Everything it can reach is
     reachable from the nav and the footer regardless.

   - The index is fetched once, on first open, from /search-index.json — the
     build writes it alongside the Feed. Nobody pays for it on page load, and
     a visitor who never opens the palette never downloads it. If the fetch
     fails the built-in page list still works.

   - Matching is subsequence-based, not substring: "bhap" finds "Back-of-house
     app". Scoring favours matches at word starts and in titles, which is what
     makes a two-letter query land on the right row.

   - Focus is trapped while it is open and restored to whatever opened it,
     the list is a real ARIA combobox/listbox, and Escape always closes.
   ========================================================================== */
(function () {
  'use strict';

  if (!document.body || !window.fetch) return;

  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

  /* The things that are always there, whether or not the index loads. Actions
     come last in the list but win ties on score, because someone typing
     "email" wants the mailto, not the contact page. */
  var BASE = [
    { t: 'Home',      s: 'The short version of everything', u: '/',          g: 'Pages' },
    { t: 'Sites',     s: 'Free build, £30 a month',          u: '/sites/',    g: 'Pages' },
    { t: 'Services',  s: 'Build, Create and Grow',           u: '/services/', g: 'Pages' },
    { t: 'About',     s: 'Who we are and where we are',      u: '/about/',    g: 'Pages' },
    { t: 'Feed',      s: 'Work finished and lessons learnt', u: '/feed/',     g: 'Pages' },
    { t: 'Contact',   s: 'Tell us what you are about',       u: '/contact/',  g: 'Pages' },
    { t: 'Terms of service', s: '', u: '/terms/',   g: 'Pages' },
    { t: 'Privacy notice',   s: '', u: '/privacy/', g: 'Pages' },
    { t: 'Free site terms',  s: 'What is included and what it costs', u: '/free-website-terms/', g: 'Pages' },

    { t: 'Start a free website', s: 'Straight to the form', u: '/contact/#talk', g: 'Do', i: 'spark' },
    { t: 'Email us',  s: 'info@westonbusinessauthority.co.uk', u: 'mailto:info@westonbusinessauthority.co.uk', g: 'Do', i: 'mail' },
    { t: 'Call us',   s: '07902 376369', u: 'tel:+447902376369', g: 'Do', i: 'phone' },
    { t: 'WhatsApp us', s: 'Usually the quickest', u: 'https://wa.me/447902376369', g: 'Do', i: 'chat' }
  ];

  var ICONS = {
    page:  '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    post:  '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    spark: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    mail:  '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    chat:  '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-4-1L3 20l1.1-4.9A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/>'
  };

  var items = BASE.slice(), loaded = false;
  var root, input, list, empty, opener, sel = 0, results = [];

  /* ------------------------------------------------------------------ index */
  function load() {
    if (loaded) return Promise.resolve();
    loaded = true;
    return fetch('/search-index.json', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!rows || !rows.length) return;
        rows.forEach(function (p) {
          items.push({
            t: p.title, s: p.excerpt || '', u: p.url,
            /* The slug is searchable as well as the tags. Somebody looking
               for the aparthotel piece types "harmony", which appears in the
               URL and nowhere in the title. */
            g: 'Feed', i: 'post',
            k: (p.tags || []).join(' ') + ' ' + p.url.replace(/[/-]/g, ' ')
          });
        });
      })
      .catch(function () { /* the base list still works */ });
  }

  /* ---------------------------------------------------------------- matching
     Returns a score, or -1 for no match. Higher is better.

     A subsequence match means every letter of the query appears in order,
     which is what lets "bhap" reach "Back-of-house app". Consecutive letters
     and letters at the start of a word score much higher than scattered ones,
     so a real word beats an accidental spelling every time. */
  function score(q, text, weight) {
    var t = text.toLowerCase(), qi = 0, s = 0, run = 0, prev = -2;
    for (var i = 0; i < t.length && qi < q.length; i++) {
      if (t.charAt(i) !== q.charAt(qi)) { run = 0; continue; }
      var wordStart = i === 0 || /[\s\-–—/·.,()]/.test(t.charAt(i - 1));
      s += wordStart ? 10 : 3;
      if (i === prev + 1) { run++; s += run * 4; } else { run = 0; }
      prev = i; qi++;
    }
    if (qi < q.length) return -1;
    /* Shorter targets are better matches for the same query. */
    return (s * weight) - Math.min(t.length, 90) * 0.12;
  }

  /* True when any WORD in `text` starts with `phrase`. No regular expression,
     deliberately: the query is user input, and building a regex out of it
     means escaping metacharacters correctly every time forever. A scan is
     three lines and cannot be broken by someone typing a bracket. */
  var BREAKS = ' \t-\u2013\u2014/(.,:;\u00b7';
  function startsWord(text, phrase) {
    if (!phrase) return false;
    for (var i = 0; i + phrase.length <= text.length; i++) {
      if (text.substr(i, phrase.length) !== phrase) continue;
      if (i === 0 || BREAKS.indexOf(text.charAt(i - 1)) >= 0) return true;
    }
    return false;
  }

  function search(raw) {
    var qs = raw.trim().toLowerCase().replace(/\s+/g, ' ');   /* as typed */
    var q  = qs.replace(/ /g, '');                            /* for subsequence */
    if (!q) {
      /* No query: the handful of things worth showing first, in a useful order. */
      return items.filter(function (it) { return it.g !== 'Feed'; }).slice(0, 7);
    }

    var out = [];
    items.forEach(function (it) {
      var title = it.t.toLowerCase();

      /* Subsequence matching runs against the TITLE ONLY. Let it loose on a
         120-character excerpt as well and almost everything matches almost
         everything — "seo" found "The Short version of Everything" — which
         buries the one row the person actually wanted. */
      var best = score(q, title, 1);

      /* Typing "fre" means the word "free", not f-somewhere, r-later,
         e-eventually. A word actually starting with the query is worth far
         more than any scattered subsequence, and this single bonus is what
         separates two good rows from eight mediocre ones. */
      if (startsWord(title, qs)) best += 45;
      else if (title.replace(/\s+/g, '').indexOf(q) >= 0) best += 18;

      /* Everything else — excerpt, tags, slug, group — has to contain the
         query outright. No fuzzy matching on secondary fields. */
      var sub = (it.s + ' ' + (it.k || '') + ' ' + it.g).toLowerCase().replace(/\s+/g, '');
      if (sub.indexOf(q) >= 0) best = Math.max(best, 22);

      if (best > 0) out.push({ it: it, n: best + (it.g === 'Do' ? 6 : 0) });
    });

    out.sort(function (a, b) { return b.n - a.n; });

    /* Drop the long tail. A match scoring under half the best one is noise,
       and a list that always returns eight rows teaches people not to trust
       the first. */
    var floor = out.length ? out[0].n * 0.45 : 0;
    return out.filter(function (r) { return r.n >= floor; })
              .slice(0, 8).map(function (r) { return r.it; });
  }

  /* ------------------------------------------------------------------- view */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function render() {
    if (!results.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var group = '', html = '';
    results.forEach(function (it, i) {
      if (it.g !== group) {
        group = it.g;
        html += '<li class="cp-group" role="presentation">' + esc(group) + '</li>';
      }
      var icon = ICONS[it.i] || (it.g === 'Feed' ? ICONS.post : ICONS.page);
      html +=
        '<li class="cp-item' + (i === sel ? ' is-sel' : '') + '"' +
          ' role="option" id="cp-o' + i + '" aria-selected="' + (i === sel) + '" data-i="' + i + '">' +
          '<svg class="cp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            icon + '</svg>' +
          '<span class="cp-txt"><span class="cp-t">' + esc(it.t) + '</span>' +
            (it.s ? '<span class="cp-s">' + esc(it.s) + '</span>' : '') + '</span>' +
          '<span class="cp-go" aria-hidden="true">&crarr;</span>' +
        '</li>';
    });
    list.innerHTML = html;
    input.setAttribute('aria-activedescendant', 'cp-o' + sel);
    var el = list.querySelector('.is-sel');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }

  function update() {
    results = search(input.value);
    sel = 0;
    render();
  }

  function go(it) {
    if (!it) return;
    close();
    if (/^(mailto:|tel:)/.test(it.u)) { window.location.href = it.u; return; }
    if (/^https?:/.test(it.u)) { window.open(it.u, '_blank', 'noopener'); return; }
    window.location.href = it.u;
  }

  /* ------------------------------------------------------------ open / close */
  function build() {
    root = document.createElement('div');
    root.className = 'cp';
    root.hidden = true;
    root.innerHTML =
      '<div class="cp-veil" data-close="1"></div>' +
      '<div class="win cp-win" role="dialog" aria-modal="true" aria-label="Search WBA">' +
        '<div class="win-bar">' +
          '<span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
          '<span class="win-title">Go to</span>' +
          '<span class="cp-hint" aria-hidden="true">esc</span>' +
        '</div>' +
        '<div class="cp-field">' +
          '<svg class="cp-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
            '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
          '<input type="text" id="cpInput" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search pages, articles, anything…" role="combobox" ' +
            'aria-expanded="true" aria-controls="cpList" aria-autocomplete="list"/>' +
        '</div>' +
        '<ul class="cp-list" id="cpList" role="listbox" aria-label="Results"></ul>' +
        '<p class="cp-empty" hidden>Nothing matches that. Try fewer letters.</p>' +
        '<div class="cp-foot">' +
          '<span><kbd>&uarr;</kbd><kbd>&darr;</kbd> move</span>' +
          '<span><kbd>&crarr;</kbd> open</span>' +
          '<span><kbd>esc</kbd> close</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    input = root.querySelector('#cpInput');
    list  = root.querySelector('#cpList');
    empty = root.querySelector('.cp-empty');

    input.addEventListener('input', update);

    root.addEventListener('click', function (e) {
      if (e.target.getAttribute('data-close')) { close(); return; }
      var li = e.target.closest ? e.target.closest('.cp-item') : null;
      if (li) go(results[+li.getAttribute('data-i')]);
    });

    list.addEventListener('mousemove', function (e) {
      var li = e.target.closest ? e.target.closest('.cp-item') : null;
      if (!li) return;
      var i = +li.getAttribute('data-i');
      if (i !== sel) { sel = i; render(); }
    });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
        e.preventDefault(); sel = (sel + 1) % Math.max(results.length, 1); render(); return;
      }
      if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
        e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(results.length, 1); render(); return;
      }
      if (e.key === 'Enter') { e.preventDefault(); go(results[sel]); return; }
      /* Nothing else may leave the dialog while it is open. */
      if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
    });
  }

  function open() {
    if (!root) build();
    opener = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add('cp-on');
    input.value = '';
    update();
    /* One frame so the opening transition has a start state to run from. */
    requestAnimationFrame(function () {
      root.classList.add('is-in');
      input.focus();
    });
    load().then(function () { if (!root.hidden) update(); });
  }

  function close() {
    if (!root || root.hidden) return;
    root.classList.remove('is-in');
    document.documentElement.classList.remove('cp-on');
    var done = function () { root.hidden = true; };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) done();
    else setTimeout(done, 160);
    if (opener && opener.focus) opener.focus();
  }

  /* ----------------------------------------------------------- the shortcut */
  document.addEventListener('keydown', function (e) {
    var openCombo = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey);
    var slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey;

    if (!openCombo && !slash) return;

    /* Never steal a keystroke from something the visitor is typing into —
       including the rich-text editor, which is a contenteditable div. */
    var a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
      if (!(openCombo && root && !root.hidden)) return;
    }
    /* Slash is a normal character; only claim it when nothing is focused. */
    if (slash && a && a !== document.body && a.tagName !== 'A') return;

    e.preventDefault();
    if (root && !root.hidden) close(); else open();
  });

  /* ------------------------------------------------------- the nav affordance
     Added last, and only if the nav exists. It advertises the shortcut, which
     is the only reason anyone would ever find it. */
  (function () {
    var links = document.getElementById('navLinks');
    if (!links) return;
    var cta = links.querySelector('.nav-cta');

    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'nav-find';
    b.setAttribute('aria-label', 'Search this site');
    b.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
        '<path d="m20 20-3.5-3.5"/></svg>' +
      '<span class="nav-find-label">Search</span>' +
      '<kbd aria-hidden="true">' + (MAC ? '⌘K' : 'Ctrl K') + '</kbd>';
    b.addEventListener('click', open);

    if (cta) links.insertBefore(b, cta); else links.appendChild(b);
  })();
})();
