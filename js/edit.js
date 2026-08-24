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
  var NBSP = '\u00a0';   /* escape, not a literal: editors eat a stray nbsp */

  var state = {
    on: false,
    admin: false,
    fields: [],          // [{el, key, kind, page, original}]
    images: [],          // [{el, key, page, original}]
    links:  [],          // [{el, key, page, original}]
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

  function byKey(list, key) {
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return null;
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

  /* ======================================================================
     Images and link destinations.

     Text is edited in place. These two are not: an image is not text you can
     type into, and a URL is metadata rather than content. Both get a small
     panel instead, opened by a button that only exists while editing.

     Same storage, same allow-lists, same publish cycle as the text fields.
     ====================================================================== */

  var SAFE_LINK = /^(https?:\/\/|\/(?!\/)|mailto:|tel:|#)/i;
  var SAFE_SRC  = /^(\/(?!\/)|https:\/\/[a-z0-9.-]+\.supabase\.co\/storage\/v1\/object\/public\/)/i;

  /* Control characters are stripped before testing, because browsers ignore
     them mid-scheme: "java<TAB>script:" runs. Mirrors normaliseUrl() in
     scripts/lib/page-content.mjs — if these two drift, the editor will accept
     something the build then refuses, which is a confusing way to fail. */
  function cleanUrl(raw) {
    return String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  }
  function okLink(u) { u = cleanUrl(u); return SAFE_LINK.test(u) ? u : null; }
  function okSrc(u)  { u = cleanUrl(u); return SAFE_SRC.test(u)  ? u : null; }

  /* ---------------------------------------------------------- discovery -- */

  function collectMedia() {
    state.images = [].slice.call(document.querySelectorAll('[data-edit-img]'))
      .map(function (el) {
        return {
          el: el,
          key: el.getAttribute('data-edit-img'),
          page: el.getAttribute('data-edit-scope') === 'shared' ? SHARED : PAGE,
          original: { src: el.getAttribute('src'), alt: el.getAttribute('alt') || '' }
        };
      })
      .filter(function (f) { return f.key; });

    state.links = [].slice.call(document.querySelectorAll('[data-edit-href]'))
      .map(function (el) {
        return {
          el: el,
          key: el.getAttribute('data-edit-href'),
          page: el.getAttribute('data-edit-scope') === 'shared' ? SHARED : PAGE,
          original: el.getAttribute('href') || ''
        };
      })
      .filter(function (f) { return f.key; });

    return state.images.length + state.links.length;
  }

  /* Buttons appear only while editing, and are removed when it stops, so an
     admin reading the site sees the site. */
  function decorate(on) {
    state.images.forEach(function (f) { markable(f, on, 'img'); });
    state.links.forEach(function (f) { markable(f, on, 'href'); });
  }

  function markable(f, on, type) {
    var existing = f.el.__wbaBtn;
    if (!on) {
      if (existing) { existing.remove(); f.el.__wbaBtn = null; }
      if (f.el.__wbaRO) { f.el.__wbaRO.disconnect(); f.el.__wbaRO = null; }
      f.el.removeAttribute('data-edit-target');
      return;
    }
    if (existing) return;

    var host = f.el.parentElement;
    if (host && getComputedStyle(host).position === 'static') host.style.position = 'relative';

    if (type === 'img') {
      /* An image that sits behind editable text (a hero background) must not be
         covered by a full overlay — you'd lose the headline. Those get a small
         corner pill; ordinary content images get the full "Replace image"
         overlay you'd expect to click anywhere. */
      var behindText = imageIsBackdrop(f.el);
      var ov = document.createElement('button');
      ov.type = 'button';
      ov.className = 'wba-img-overlay' + (behindText ? ' wba-img-overlay-corner' : '');
      ov.setAttribute('aria-label', 'Replace this image');
      ov.innerHTML =
        '<span class="wba-img-overlay-in">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20"/></svg>' +
          '<span>Replace image</span>' +
        '</span>';
      ov.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openImagePanel(f); };
      (host || document.body).appendChild(ov);
      f.el.__wbaBtn = ov;
      f.el.__wbaCorner = behindText;
      f.el.__wbaReposition = function () { positionOverlay(ov, f.el); };
      positionOverlay(ov, f.el);

      /* An image far down the page may still be 0x0 when edit mode starts
         (not yet laid out), and it changes size when a new one is dropped in.
         A ResizeObserver keeps the overlay exactly over it in every case. */
      if (window.ResizeObserver) {
        var ro = new ResizeObserver(function () { positionOverlay(ov, f.el); });
        ro.observe(f.el);
        if (host) ro.observe(host);
        f.el.__wbaRO = ro;
      } else {
        f.el.addEventListener('load', f.el.__wbaReposition);
      }
    } else {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'wba-edit-pin wba-edit-pin-href';
      btn.textContent = 'Change link';
      btn.setAttribute('aria-label', 'Change where this link goes (' + f.key + ')');
      btn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); openLinkPanel(f); };
      (host || document.body).appendChild(btn);
      f.el.__wbaBtn = btn;
    }
    f.el.setAttribute('data-edit-target', '');
  }

  /* Lay the overlay directly over its image. Uses getBoundingClientRect on
     both and the difference, which is correct regardless of where the image's
     offsetParent actually is (offset* would be wrong when the image's nearest
     positioned ancestor isn't the host we appended to). Zero-size images —
     not yet laid out, or hidden at this breakpoint — get a hidden overlay
     rather than a stray 4px square; the ResizeObserver shows it when it grows. */
  function positionOverlay(ov, img) {
    var host = ov.parentElement;
    if (!host) return;
    var ir = img.getBoundingClientRect();
    if (ir.width < 8 || ir.height < 8) { ov.style.display = 'none'; return; }
    ov.style.display = '';
    var hr = host.getBoundingClientRect();
    var bl = parseFloat(getComputedStyle(host).borderLeftWidth) || 0;
    var bt = parseFloat(getComputedStyle(host).borderTopWidth) || 0;
    var top = ir.top - hr.top - bt, left = ir.left - hr.left - bl;

    if (ov.classList.contains('wba-img-overlay-corner')) {
      /* A compact pill in the image's top-right, so the hero text underneath
         stays clickable. Width/height are the pill's own (from CSS). */
      ov.style.top = (top + 12) + 'px';
      ov.style.left = 'auto';
      ov.style.right = (hr.right - ir.right) + 'px';
      ov.style.width = 'auto';
      ov.style.height = 'auto';
    } else {
      ov.style.top    = top + 'px';
      ov.style.left   = left + 'px';
      ov.style.right  = 'auto';
      ov.style.width  = ir.width + 'px';
      ov.style.height = ir.height + 'px';
    }
  }

  /* Does editable text sit on top of this image? If so it's a backdrop (a hero
     banner) and must not be covered by a full-image button. */
  function imageIsBackdrop(img) {
    var ir = img.getBoundingClientRect();
    if (ir.width < 8 || ir.height < 8) return false;
    var texts = document.querySelectorAll('[data-edit]');
    for (var i = 0; i < texts.length; i++) {
      var tr = texts[i].getBoundingClientRect();
      if (tr.width < 4 || tr.height < 4) continue;
      var cx = tr.left + tr.width / 2, cy = tr.top + tr.height / 2;
      if (cx > ir.left && cx < ir.right && cy > ir.top && cy < ir.bottom) return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- panel -- */

  function panel(title, bodyHTML, onSave) {
    closePanel();
    var wrap = document.createElement('div');
    wrap.className = 'wba-panel-back';
    wrap.id = 'wba-panel';
    wrap.innerHTML =
      '<div class="wba-panel" role="dialog" aria-modal="true" aria-label="' + title + '">' +
        '<div class="wba-panel-head"><strong>' + title + '</strong>' +
          '<button type="button" class="wba-eb-btn ghost" data-close aria-label="Close">&#215;</button></div>' +
        '<div class="wba-panel-body">' + bodyHTML + '</div>' +
        '<div class="wba-panel-foot">' +
          '<span class="wba-panel-msg" id="wba-panel-msg"></span>' +
          '<button type="button" class="wba-eb-btn ghost" data-close>Cancel</button>' +
          '<button type="button" class="wba-eb-btn solid" data-apply>Apply</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.hasAttribute('data-close')) closePanel();
      if (e.target.hasAttribute('data-apply')) onSave(wrap);
    });
    document.addEventListener('keydown', escClose);
    /* Focus the first control so the panel is usable from the keyboard. */
    var first = wrap.querySelector('input,button,select');
    if (first) first.focus();
    return wrap;
  }

  function escClose(e) { if (e.key === 'Escape') closePanel(); }

  function closePanel() {
    var p = document.getElementById('wba-panel');
    if (p) p.remove();
    document.removeEventListener('keydown', escClose);
  }

  function panelMsg(text, bad) {
    var m = document.getElementById('wba-panel-msg');
    if (m) { m.textContent = text || ''; m.className = 'wba-panel-msg' + (bad ? ' bad' : ''); }
  }

  /* --------------------------------------------------------- image panel -- */

  var photoCache = null;

  function loadPhotos() {
    if (photoCache) return Promise.resolve(photoCache);
    /* Two sources: photos committed to the repo (listed by a manifest the
       build writes, because a CDN folder has no index) and anything uploaded
       through Admin -> Photos. */
    var repo = fetch('/photos/manifest.json')
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });

    var uploaded = (window.WBAdb && WBAdb.listMedia)
      ? WBAdb.listMedia(200, 0).then(function (r) {
          return (r.data || [])
            .filter(function (o) { return o.name && o.name.charAt(0) !== '.'; })
            .map(function (o) { return { url: WBAdb.mediaUrl(o.name), name: o.name, w: null, h: null }; });
        }).catch(function () { return []; })
      : Promise.resolve([]);

    return Promise.all([repo, uploaded]).then(function (r) {
      photoCache = { repo: r[0] || [], uploaded: r[1] || [] };
      return photoCache;
    });
  }

  function openImagePanel(f) {
    var body =
      '<div class="wba-field">' +
        '<label for="wba-img-alt">Description (alt text)</label>' +
        '<input type="text" id="wba-img-alt" value="' + escAttr(f.el.getAttribute('alt') || '') + '" ' +
          'placeholder="What is in the picture?"/>' +
        '<p class="wba-hint">Read aloud by screen readers, and shown if the image fails to load.</p>' +
      '</div>' +
      '<div class="wba-field">' +
        '<label for="wba-img-url">Image</label>' +
        '<input type="text" id="wba-img-url" value="' + escAttr(f.el.getAttribute('src') || '') + '"/>' +
        '<p class="wba-hint">Pick one below, or paste a path. Uploads live in Admin &rarr; Photos.</p>' +
      '</div>' +
      '<div class="wba-picker" id="wba-picker"><p class="wba-hint">Loading images…</p></div>';

    var wrap = panel('Change image', body, function () {
      var url = okSrc(document.getElementById('wba-img-url').value);
      if (!url) {
        panelMsg('That address is not allowed. Use a path on this site, or an uploaded image.', true);
        return;
      }
      var alt = document.getElementById('wba-img-alt').value.slice(0, 300);
      applyImage(f, url, alt);
      closePanel();
    });

    loadPhotos().then(function (p) {
      var box = document.getElementById('wba-picker');
      if (!box) return;
      var section = function (title, list) {
        if (!list.length) return '';
        return '<h4>' + title + '</h4><div class="wba-thumbs">' + list.map(function (i) {
          return '<button type="button" class="wba-thumb" data-url="' + escAttr(i.url) + '" ' +
                 (i.w ? 'data-w="' + i.w + '" data-h="' + i.h + '" ' : '') +
                 'title="' + escAttr(i.name) + '">' +
                 '<img src="' + escAttr(i.url) + '" alt="" loading="lazy"/></button>';
        }).join('') + '</div>';
      };
      box.innerHTML = section('Uploaded', p.uploaded) + section('In the site', p.repo) ||
                      '<p class="wba-hint">No images found.</p>';

      box.addEventListener('click', function (e) {
        var t = e.target.closest('.wba-thumb');
        if (!t) return;
        document.getElementById('wba-img-url').value = t.getAttribute('data-url');
        [].forEach.call(box.querySelectorAll('.wba-thumb'), function (b) { b.classList.remove('on'); });
        t.classList.add('on');
        panelMsg('');
      });
    });

    return wrap;
  }

  /* Show the change immediately, and record the real pixel size so the build
     can write width/height back onto the tag. Without them the page reflows
     as the new image loads. */
  function applyImage(f, url, alt) {
    var probe = new Image();
    probe.onload = function () { commit(probe.naturalWidth, probe.naturalHeight); };
    probe.onerror = function () { commit(null, null); };
    probe.src = url;

    function commit(w, h) {
      f.el.setAttribute('src', url);
      if (alt !== null && alt !== undefined) f.el.setAttribute('alt', alt);
      if (w && h) { f.el.setAttribute('width', w); f.el.setAttribute('height', h); }
      else { f.el.removeAttribute('width'); f.el.removeAttribute('height'); }

      state.dirty['img:' + f.key] = JSON.stringify({ src: url, w: w, h: h, alt: alt });
      /* The new image may be a different height, so move the overlay back over it. */
      if (f.el.__wbaReposition) requestAnimationFrame(f.el.__wbaReposition);
      refreshCount();
      msg('Image changed — tick to save.');
    }
  }

  /* ---------------------------------------------------------- link panel -- */

  function openLinkPanel(f) {
    var current = f.el.getAttribute('href') || '';
    var body =
      '<div class="wba-field">' +
        '<label for="wba-href">Where should this go?</label>' +
        '<input type="text" id="wba-href" value="' + escAttr(current) + '"/>' +
        '<p class="wba-hint">A page on this site (<code>/sites/</code>), a full address ' +
          '(<code>https://…</code>), an email (<code>mailto:…</code>), a phone number ' +
          '(<code>tel:…</code>), or a spot on this page (<code>#start</code>).</p>' +
      '</div>' +
      '<div class="wba-field"><label>Quick pick</label><div class="wba-chips">' +
        ['/', '/sites/', '/services/', '/about/', '/feed/', '/contact/', '#start']
          .map(function (u) { return '<button type="button" class="wba-chip" data-url="' + u + '">' + u + '</button>'; })
          .join('') +
      '</div></div>';

    var wrap = panel('Change link', body, function () {
      var url = okLink(document.getElementById('wba-href').value);
      if (!url) {
        panelMsg('That address is not allowed. Links must be a path, https, mailto, tel or #.', true);
        return;
      }
      f.el.setAttribute('href', url);
      state.dirty['href:' + f.key] = url;
      refreshCount();
      msg('Link changed. Press Save to keep it.');
      closePanel();
    });

    wrap.addEventListener('click', function (e) {
      var c = e.target.closest('.wba-chip');
      if (c) document.getElementById('wba-href').value = c.getAttribute('data-url');
    });
    return wrap;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ------------------------------------------------------------------- UI - */

  function el(id) { return document.getElementById(id); }
  function pen() { return document.getElementById('wba-pen'); }

  /* The whole entry point is one floating button, only ever built for a
     signed-in admin. Idle it's a pen ("edit this page"); while editing it's a
     tick ("save"). No bar, no menu — click to edit, click to save. */
  var ICON_PEN  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  var ICON_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

  function buildPen() {
    if (pen()) return;
    var b = document.createElement('button');
    b.id = 'wba-pen';
    b.type = 'button';
    b.className = 'wba-pen';
    b.innerHTML = '<span class="wba-pen-ico">' + ICON_PEN + '</span>' +
                  '<span class="wba-pen-badge" id="wba-pen-badge" hidden></span>';
    b.setAttribute('aria-label', 'Edit this page');
    b.title = 'Edit this page';
    document.body.appendChild(b);
    document.body.classList.add('wba-has-pen');
    b.onclick = function () {
      if (state.on) save(true);        // tick -> save, then leave edit mode
      else setEditing(true);           // pen  -> enter edit mode
    };

    /* A small toast for feedback, separate from the button. */
    var t = document.createElement('div');
    t.id = 'wba-toast';
    t.className = 'wba-toast';
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    document.body.appendChild(t);
  }

  var toastTimer = null;
  function msg(text, tone) {
    var t = el('wba-toast');
    if (!t) return;
    if (!text) { t.classList.remove('show'); return; }
    t.textContent = text;
    t.className = 'wba-toast show' + (tone ? ' ' + tone : '');
    clearTimeout(toastTimer);
    /* Errors stay until dismissed by the next action; success fades. */
    if (tone !== 'bad') toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }

  function refreshCount() {
    var b = pen();
    if (!b) return;
    var d = Object.keys(state.dirty).length;

    b.classList.toggle('is-editing', state.on);
    b.classList.toggle('is-dirty', d > 0);
    b.querySelector('.wba-pen-ico').innerHTML = state.on ? ICON_TICK : ICON_PEN;
    b.setAttribute('aria-label', state.on ? 'Save changes' : 'Edit this page');
    b.title = state.on ? (d ? 'Save ' + d + ' change' + (d === 1 ? '' : 's') : 'Done — nothing to save') : 'Edit this page';

    var badge = el('wba-pen-badge');
    if (badge) { badge.hidden = !d; badge.textContent = d || ''; }
  }

  /* --------------------------------------------------------- editing mode - */

  function setEditing(on) {
    state.on = !!on;
    document.body.classList.toggle('wba-editing', state.on);

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

    decorate(state.on);
    if (!state.on) { closePanel(); state.dirty = {}; }
    msg(state.on ? 'Click the red text to change it, or an image to replace it. Tick to save.' : '');
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

  function save(exitAfter) {
    var keys = Object.keys(state.dirty);
    /* Clicking the tick with nothing changed just leaves edit mode. */
    if (!keys.length) { if (exitAfter) setEditing(false); return; }
    if (state.saving) return;
    state.saving = true;
    msg('Saving…');

    /* Dirty keys are namespaced so an image and a heading can share a name:
       "img:hero.photo", "href:cta.main", or a bare key for text. */
    var rows = keys.map(function (k) {
      if (k.indexOf('img:') === 0) {
        var im = byKey(state.images, k.slice(4));
        return { page: im ? im.page : PAGE, key: k.slice(4), value: state.dirty[k], kind: 'src' };
      }
      if (k.indexOf('href:') === 0) {
        var ln = byKey(state.links, k.slice(5));
        return { page: ln ? ln.page : PAGE, key: k.slice(5), value: state.dirty[k], kind: 'href' };
      }
      var f = fieldByKey(k);
      return { page: f ? f.page : PAGE, key: k, value: state.dirty[k], kind: f ? f.kind : 'text' };
    });

    WBAdb.savePageContent(rows).then(function (r) {
      state.saving = false;
      if (r && r.error) { msg('Could not save: ' + r.error.message, 'bad'); return; }

      keys.forEach(function (k) {
        state.pending[k] = state.dirty[k];
        var target = k.indexOf('img:') === 0  ? byKey(state.images, k.slice(4))
                   : k.indexOf('href:') === 0 ? byKey(state.links,  k.slice(5))
                   : fieldByKey(k);
        if (!target) return;
        if (target.kind) target.original = state.dirty[k];
        target.el.setAttribute('data-edit-pending', '');
      });
      state.dirty = {};
      msg('Saved — ' + keys.length + ' change' + (keys.length === 1 ? '' : 's') +
          ' will be live within a few minutes.', 'ok');
      if (exitAfter) setEditing(false);
      else refreshCount();
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
        if (row.kind === 'src') {
          var im = byKey(state.images, row.key);
          if (!im || im.page !== row.page) return;
          var v; try { v = JSON.parse(row.value); } catch (e) { v = { src: row.value }; }
          if (v && v.src && im.el.getAttribute('src') !== v.src) {
            im.el.setAttribute('src', v.src);
            if (v.alt != null) im.el.setAttribute('alt', v.alt);
            if (v.w && v.h) { im.el.setAttribute('width', v.w); im.el.setAttribute('height', v.h); }
            state.pending['img:' + row.key] = row.value;
            im.el.setAttribute('data-edit-pending', '');
          }
          return;
        }
        if (row.kind === 'href') {
          var ln = byKey(state.links, row.key);
          if (!ln || ln.page !== row.page) return;
          if (ln.el.getAttribute('href') !== row.value) {
            ln.el.setAttribute('href', row.value);
            state.pending['href:' + row.key] = row.value;
            ln.el.setAttribute('data-edit-pending', '');
          }
          return;
        }
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
    var n = collect() + collectMedia();
    if (!n) return;                         // nothing marked up on this page
    buildPen();
    refreshCount();
    applyPending();

    /* Unsaved changes are only ever in the DOM and in state.dirty — never
       written until the tick is pressed — so leaving the page simply discards
       them, which is exactly the intended behaviour. The native prompt just
       stops an accidental click from losing work. */
    window.addEventListener('beforeunload', function (e) {
      if (state.on && Object.keys(state.dirty).length) { e.preventDefault(); e.returnValue = ''; }
    });

    /* Image overlays are absolutely positioned, so keep them over their images
       as the layout reflows (resize, font load, an image swap changing height). */
    var reflow = function () {
      if (!state.on) return;
      state.images.forEach(function (f) { if (f.el.__wbaReposition) f.el.__wbaReposition(); });
    };
    window.addEventListener('resize', reflow, { passive: true });
  }

  function boot() {
    if (!window.WBAdb || !WBAdb.currentUser || !WBAdb.getPageContent) return;

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
