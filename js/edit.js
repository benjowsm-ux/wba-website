/* ==========================================================================
   WBA — Edit mode.

   Click into the page and change the words, the way you would in WordPress,
   but without WordPress: the site stays static HTML on a CDN, and the copy
   you type is baked into that HTML by the next build.

   ---------------------------------------------------------------------------
   The shape of it
   ---------------------------------------------------------------------------
   1. Mark anything editable in the HTML:  <h1 data-edit="hero.title">
   2. Sign in at /admin/. Edit mode then offers itself on every page.
   3. Turn it on, click the text, type. Saving writes one row per key to
      public.page_content — it does NOT rewrite the HTML file.
   4. The build reads page_content and bakes the overrides into the HTML.
      Visitors get a plain pre-rendered page: no flash of old copy, no extra
      request, no JavaScript needed to see the right words.

   So an edit is saved instantly and goes live at the next build. The bar
   shows how many edits are waiting, because that gap is real and pretending
   otherwise would be worse than explaining it.

   ---------------------------------------------------------------------------
   Why it is safe
   ---------------------------------------------------------------------------
   * This file does nothing at all unless Supabase reports a signed-in user
     whose id is in public.admins. The check is server-side (is_admin(), a
     SECURITY DEFINER function); the client cannot vote itself in.
   * Row-level security is the real boundary, not this UI. Deleting the
     `hidden` attribute on the toolbar, or calling save() from the console,
     gets an anonymous visitor a 401 from Postgres.
   * contenteditable will happily accept pasted markup, so nothing typed here
     is trusted. Text fields are stored as plain text. Rich fields are run
     through a small allow-list (b, strong, i, em, a[href], br) on save AND
     again on output, because sanitising in one place only is how stored XSS
     gets in.
   ========================================================================== */
(function () {
  'use strict';

  var PAGE = normalisePath(location.pathname);
  var SHARED = '*';               /* nav + footer: one row, every page */
  var BAR_ID = 'wba-editbar';
  var NBSP = '\u00a0';   /* escape, not a literal: editors eat a stray nbsp */

  var state = {
    on: false,
    admin: false,
    fields: [],          // [{el, key, kind, original}]
    dirty: {},           // key -> value typed but not saved
    pending: {},         // key -> value saved but not yet built
    saving: false
  };

  /* ---------------------------------------------------------------- utils - */

  /* '/sites/index.html' and '/sites' both mean '/sites/'. */
  function normalisePath(p) {
    p = (p || '/').replace(/index\.html?$/i, '');
    if (p.charAt(0) !== '/') p = '/' + p;
    if (p.length > 1 && p.charAt(p.length - 1) !== '/') p += '/';
    return p;
  }

  /* The only markup a rich field may keep. Everything else is unwrapped,
     keeping its text. Built with the DOM rather than a regex, because a
     regex over HTML loses to the first nested or malformed tag. */
  var ALLOWED = { B: 1, STRONG: 1, I: 1, EM: 1, A: 1, BR: 1, SPAN: 1 };
  var SAFE_HREF = /^(https?:\/\/|\/|mailto:|tel:|#)/i;

  /* The only class values that survive an edit. Every big heading sets its
     second line in <em class="accent">; flattening that on the first edit
     would quietly undo the design. Kept identical to the allow-list in
     scripts/lib/page-content.mjs — if these two ever disagree, the build
     silently changes what the editor showed. */
  var ALLOWED_CLASS = { accent: 1 };

  function keepClasses(node) {
    var raw = node.getAttribute('class') || '';
    var kept = raw.split(/\s+/).filter(function (c) { return ALLOWED_CLASS[c]; });
    return kept.length ? kept.join(' ') : null;
  }

  function sanitiseRich(html) {
    var box = document.createElement('div');
    box.innerHTML = String(html == null ? '' : html);

    (function walk(node) {
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;

        if (child.nodeType === 1) {
          if (!ALLOWED[child.tagName]) {
            /* unwrap: keep the words, drop the element */
            while (child.firstChild) node.insertBefore(child.firstChild, child);
            node.removeChild(child);
          } else {
            var href = child.tagName === 'A' ? child.getAttribute('href') : null;
            var cls  = keepClasses(child);

            /* strip every attribute, then put back only what we allow */
            for (var i = child.attributes.length - 1; i >= 0; i--) {
              child.removeAttribute(child.attributes[i].name);
            }
            if (cls) child.setAttribute('class', cls);

            if (child.tagName === 'A') {
              if (href && SAFE_HREF.test(href.trim())) {
                child.setAttribute('href', href.trim());
              } else {
                /* javascript:, data:, or no href at all — unwrap it */
                while (child.firstChild) node.insertBefore(child.firstChild, child);
                node.removeChild(child);
                child = null;
              }
            } else if (child.tagName === 'SPAN' && !cls) {
              /* a bare span carries no meaning — unwrap, keep the words */
              while (child.firstChild) node.insertBefore(child.firstChild, child);
              node.removeChild(child);
              child = null;
            }

            if (child) walk(child);
          }
        } else if (child.nodeType !== 3) {
          node.removeChild(child);          // comments, CDATA, anything else
        }

        child = next;
      }
    })(box);

    return box.innerHTML.trim();
  }

  function readField(f) {
    if (f.kind === 'rich') return sanitiseRich(f.el.innerHTML);
    /* textContent, NOT innerText.
       innerText returns the *rendered* text, so a footer heading styled with
       text-transform:uppercase reads back as "PAGES" — and that shouting
       would be saved to the database and baked into the HTML for good, even
       though nobody typed it. textContent reads the source. */
    return (f.el.textContent || '').split(NBSP).join(' ').replace(/\s+/g, ' ').trim();
  }

  function writeField(f, value) {
    if (f.kind === 'rich') f.el.innerHTML = sanitiseRich(value);
    else f.el.textContent = value;
  }

  function fieldByKey(key) {
    for (var i = 0; i < state.fields.length; i++) {
      if (state.fields[i].key === key) return state.fields[i];
    }
    return null;
  }

  /* ------------------------------------------------------------- discovery - */

  function collect() {
    state.fields = [].slice.call(document.querySelectorAll('[data-edit]'))
      .map(function (el) {
        var kind = el.getAttribute('data-edit-kind') === 'rich' ? 'rich' : 'text';
        /* The nav and footer are copied into every page. Storing those against
           this page would mean fixing the same typo six times, so they live
           under the page "*" and the build applies them everywhere. */
        var page = el.getAttribute('data-edit-scope') === 'shared' ? SHARED : PAGE;
        return { el: el, key: el.getAttribute('data-edit'), kind: kind, page: page, original: null };
      })
      .filter(function (f) { return f.key; });

    state.fields.forEach(function (f) { f.original = readField(f); });

    /* A duplicated key means two elements fight over one row. Say so loudly
       here rather than letting the build pick an arbitrary winner. */
    var seen = {}, dupes = [];
    state.fields.forEach(function (f) {
      if (seen[f.key]) dupes.push(f.key);
      seen[f.key] = 1;
    });
    if (dupes.length) {
      console.warn('[edit] duplicate data-edit keys on ' + PAGE + ': ' + dupes.join(', '));
    }

    return state.fields.length;
  }

  /* ------------------------------------------------------------------- UI - */

  function bar() { return document.getElementById(BAR_ID); }
  function el(id) { return document.getElementById(id); }

  function buildBar() {
    if (bar()) return;
    var b = document.createElement('div');
    b.id = BAR_ID;
    b.setAttribute('role', 'region');
    b.setAttribute('aria-label', 'Edit mode');
    b.innerHTML =
      '<div class="wba-eb-in">' +
        '<span class="wba-eb-dot" aria-hidden="true"></span>' +
        '<strong class="wba-eb-title">Edit mode</strong>' +
        '<span class="wba-eb-count" id="wba-eb-count"></span>' +
        '<span class="wba-eb-spacer"></span>' +
        '<button type="button" class="wba-eb-btn" id="wba-eb-toggle">Start editing</button>' +
        '<button type="button" class="wba-eb-btn solid" id="wba-eb-save" hidden>Save</button>' +
        '<button type="button" class="wba-eb-btn ghost" id="wba-eb-revert" hidden>Discard</button>' +
        '<a class="wba-eb-btn ghost" href="/admin/">Admin</a>' +
        '<button type="button" class="wba-eb-btn ghost wba-eb-x" id="wba-eb-hide" ' +
          'title="Hide the bar until you next sign in" aria-label="Hide edit bar">&#215;</button>' +
      '</div>' +
      '<div class="wba-eb-msg" id="wba-eb-msg" role="status" aria-live="polite"></div>';
    document.body.appendChild(b);
    document.body.classList.add('wba-has-editbar');

    el('wba-eb-toggle').onclick = function () { setEditing(!state.on); };
    el('wba-eb-save').onclick   = save;
    el('wba-eb-revert').onclick = revert;
    el('wba-eb-hide').onclick   = function () {
      if (Object.keys(state.dirty).length &&
          !confirm('You have unsaved changes. Hide the bar and lose them?')) return;
      try { sessionStorage.setItem('wba-editbar-hidden', '1'); } catch (e) {}
      setEditing(false);
      b.remove();
      document.body.classList.remove('wba-has-editbar');
    };
  }

  function msg(text, tone) {
    var m = el('wba-eb-msg');
    if (!m) return;
    m.textContent = text || '';
    m.className = 'wba-eb-msg' + (tone ? ' ' + tone : '');
  }

  function refreshCount() {
    var c = el('wba-eb-count');
    if (!c) return;

    var d = Object.keys(state.dirty).length;
    var p = Object.keys(state.pending).length;
    var bits = [];
    if (d) bits.push(d + ' unsaved');
    if (p) bits.push(p + ' awaiting publish');
    if (!d && !p) bits.push(state.fields.length + ' editable here');
    c.textContent = bits.join(' · ');

    el('wba-eb-save').hidden   = !d;
    el('wba-eb-revert').hidden = !d;
    var b = bar();
    if (b) b.classList.toggle('is-dirty', !!d);
  }

  /* --------------------------------------------------------- editing mode - */

  function setEditing(on) {
    state.on = !!on;
    document.body.classList.toggle('wba-editing', state.on);
    var t = el('wba-eb-toggle');
    if (t) t.textContent = state.on ? 'Stop editing' : 'Start editing';

    state.fields.forEach(function (f) {
      if (state.on) {
        f.el.setAttribute('contenteditable', 'true');
        f.el.setAttribute('spellcheck', 'true');
        f.el.setAttribute('data-edit-on', '');
        f.el.addEventListener('input', onInput);
        f.el.addEventListener('paste', onPaste);
        f.el.addEventListener('keydown', onKeydown);
      } else {
        f.el.removeAttribute('contenteditable');
        f.el.removeAttribute('spellcheck');
        f.el.removeAttribute('data-edit-on');
        f.el.removeEventListener('input', onInput);
        f.el.removeEventListener('paste', onPaste);
        f.el.removeEventListener('keydown', onKeydown);
      }
    });

    msg(state.on ? 'Click any highlighted text to change it.' : '');
    refreshCount();
  }

  function fieldFor(node) {
    for (var i = 0; i < state.fields.length; i++) {
      if (state.fields[i].el === node) return state.fields[i];
    }
    return null;
  }

  function onInput(e) {
    var f = fieldFor(e.currentTarget);
    if (!f) return;
    var now = readField(f);
    if (now === f.original) delete state.dirty[f.key];
    else state.dirty[f.key] = now;
    refreshCount();
  }

  /* Paste as plain text. Word and Google Docs paste a wall of markup, and a
     text field holding <span style="mso-..."> would be nonsense. */
  function onPaste(e) {
    e.preventDefault();
    var cb = e.clipboardData || window.clipboardData;
    var text = cb ? cb.getData('text/plain') : '';
    if (!text) return;
    if (document.execCommand) document.execCommand('insertText', false, text);
  }

  function onKeydown(e) {
    var f = fieldFor(e.currentTarget);
    if (!f) return;
    /* Enter in a heading should not create a nest of <div>s. */
    if (e.key === 'Enter' && f.kind !== 'rich') { e.preventDefault(); e.currentTarget.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.blur(); }
    if ((e.metaKey || e.ctrlKey) && String(e.key).toLowerCase() === 's') {
      e.preventDefault(); save();
    }
  }

  function revert() {
    state.fields.forEach(function (f) {
      if (state.dirty[f.key] !== undefined) writeField(f, f.original);
    });
    state.dirty = {};
    msg('Changes discarded.', 'ok');
    refreshCount();
  }

  /* ------------------------------------------------------------------ io - */

  function save() {
    var keys = Object.keys(state.dirty);
    if (!keys.length || state.saving) return;
    state.saving = true;
    msg('Saving…');

    var rows = keys.map(function (k) {
      var f = fieldByKey(k);
      return {
        page:  f ? f.page : PAGE,
        key:   k,
        value: state.dirty[k],
        kind:  f ? f.kind : 'text'
      };
    });

    WBAdb.savePageContent(rows).then(function (r) {
      state.saving = false;
      if (r && r.error) { msg('Could not save: ' + r.error.message, 'bad'); return; }

      keys.forEach(function (k) {
        state.pending[k] = state.dirty[k];
        var f = fieldByKey(k);
        if (f) { f.original = state.dirty[k]; f.el.setAttribute('data-edit-pending', ''); }
      });
      state.dirty = {};
      msg('Saved. ' + keys.length + ' change' + (keys.length === 1 ? '' : 's') +
          ' will reach visitors at the next publish.', 'ok');
      refreshCount();
    }).catch(function (e) {
      state.saving = false;
      msg('Could not save: ' + ((e && e.message) || e), 'bad');
    });
  }

  /* An admin has to see the true current state: the HTML as built, plus any
     edit saved since that build. Visitors never run this. */
  function applyPending() {
    return WBAdb.getPageContent([PAGE, SHARED]).then(function (r) {
      if (!r || r.error || !r.data) return;
      r.data.forEach(function (row) {
        var f = fieldByKey(row.key);
        /* a shared row must not overwrite a same-named page field */
        if (!f || f.page !== row.page) return;
        if (readField(f) !== row.value) {
          writeField(f, row.value);
          f.original = row.value;
          state.pending[row.key] = row.value;
          f.el.setAttribute('data-edit-pending', '');
        }
      });
      refreshCount();
    }).catch(function () { /* the page still works without this */ });
  }

  /* ----------------------------------------------------------------- boot - */

  function start() {
    if (!collect()) return;                 // nothing marked up on this page
    buildBar();
    refreshCount();
    applyPending();

    window.addEventListener('beforeunload', function (e) {
      if (Object.keys(state.dirty).length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function boot() {
    if (!window.WBAdb || !WBAdb.currentUser || !WBAdb.getPageContent) return;
    try {
      if (sessionStorage.getItem('wba-editbar-hidden') === '1') return;
    } catch (e) {}

    WBAdb.currentUser().then(function (u) {
      if (!u || !u.data || !u.data.user) return;      // signed out: nothing happens
      return WBAdb.isAdmin().then(function (r) {
        if (!r || r.error || r.data !== true) return; // signed in, not an admin
        state.admin = true;
        start();
      });
    }).catch(function () { /* offline or misconfigured: stay invisible */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Exposed for the admin panel's diagnostics, not for driving the UI. */
  window.WBAedit = {
    page: PAGE,
    fields: function () {
      return state.fields.map(function (f) { return { key: f.key, kind: f.kind }; });
    },
    sanitiseRich: sanitiseRich
  };
})();
