/* ==========================================================================
   WBA - unlocking a preview.

   One file, used by two pages that used to do this differently and therefore
   used to be broken in two different ways: the client portal, and the Portal
   tab in the admin. Everything either of them needs to turn "a folder in a
   private bucket" into "a website you can click around" is here.

   WHAT IT DOES, IN ORDER
     1. Registers preview/sw.js and waits until it is genuinely ACTIVATED.
        Not "registered" - a registered-but-not-yet-active worker does not
        intercept anything, and the first click lands on a 404.
     2. Walks the client's folder, subfolders and all.
     3. Asks Supabase for a signed URL for every file, in batches.
     4. Writes that map to IndexedDB, where the worker reads it.

   WHY IT RUNS BEFORE THE CLICK, NOT ON IT
   All of the above is asynchronous, and a window.open() at the end of an
   async chain is not a user gesture any more - every browser blocks it as a
   popup. So the page prepares the preview as soon as it knows which one it
   is, and the button is a plain <a target="_blank" rel="noopener"> that
   simply becomes clickable when it is ready. No popup blocker, no opener
   handle back into the portal, and by the time anyone reaches for it the
   work is already done.

   PERMISSION
   Nothing here has any authority of its own. The listing and the signing both
   run as whoever is signed in, so row-level security decides what comes back:
   a client sees their own folder, an admin sees any. If somebody tampers with
   the prefix they get an empty list, not somebody else's site.
   ========================================================================== */
(function () {
  'use strict';

  var BUCKET = 'previews';
  var DB = 'wba-preview';
  var STORE = 'sites';
  var HOURS = 8;
  var TTL = HOURS * 3600;              /* seconds, for the signature */
  var PAGE = 100;                      /* list page size, and sign batch size */

  /* ------------------------------------------------------------------ store */
  function openDb() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('no-idb')); return; }
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'prefix' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error || new Error('idb')); };
    });
  }

  function put(record) {
    return openDb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(record);
        tx.oncomplete = function () { res(record); };
        tx.onerror = function () { rej(tx.error || new Error('idb-write')); };
      });
    });
  }

  /* ------------------------------------------------------------------ worker
     scope:'/preview/' is allowed from any page on the origin because the
     SCRIPT lives at /preview/sw.js - the restriction is on where the script
     sits, not on where register() was called from. That is why the file is
     under /preview/ and not in /js/ with everything else. */
  var registered = null;

  function worker() {
    if (registered) return registered;

    registered = new Promise(function (res, rej) {
      if (!('serviceWorker' in navigator)) {
        rej(new Error('This browser cannot show previews. Private windows in ' +
                      'Firefox switch the feature off - try an ordinary window.'));
        return;
      }
      navigator.serviceWorker.register('/preview/sw.js', { scope: '/preview/' })
        .then(function (reg) {
          /* navigator.serviceWorker.ready is the obvious call here and the
             wrong one: it resolves for the registration matching THIS page,
             and this page is /portal/ or /admin/, which is outside the
             worker's scope. It would never settle. Watch the registration
             we were actually handed instead. */
          function settled() {
            return reg.active && reg.active.state === 'activated';
          }
          if (settled()) { res(reg); return; }

          var w = reg.installing || reg.waiting || reg.active;
          if (!w) { res(reg); return; }         /* nothing to wait for */

          var done = false;
          function check() {
            if (done || !settled()) return;
            done = true; res(reg);
          }
          w.addEventListener('statechange', check);
          reg.addEventListener('updatefound', function () {
            if (reg.installing) reg.installing.addEventListener('statechange', check);
          });
          /* A belt-and-braces timeout. Better a preview that opens than a
             button that says "Preparing" until the end of time. */
          setTimeout(function () { if (!done) { done = true; res(reg); } }, 8000);
        })
        .catch(function (e) {
          rej(new Error('Could not start the preview service (' +
                        (e && e.message ? e.message : 'unknown') + ').'));
        });
    });

    return registered;
  }

  /* ----------------------------------------------------------------- listing
     list() returns one page at a time and mixes files with folders: a folder
     comes back with id === null. Supabase also drops a hidden
     .emptyFolderPlaceholder into empty folders, which is not a file anyone
     asked for and must not end up in the map. */
  function walk(sb, base, sub, out) {
    out = out || [];
    var path = sub ? base + '/' + sub : base;

    function pageFrom(offset) {
      return sb.storage.from(BUCKET)
        .list(path, { limit: PAGE, offset: offset, sortBy: { column: 'name', order: 'asc' } })
        .then(function (r) {
          if (r.error) throw r.error;
          var rows = r.data || [];
          var deeper = [];

          rows.forEach(function (row) {
            if (!row || !row.name) return;
            if (row.name === '.emptyFolderPlaceholder') return;
            var rel = sub ? sub + '/' + row.name : row.name;
            if (row.id === null || row.id === undefined) deeper.push(rel);
            else out.push(rel);
          });

          return Promise.all(deeper.map(function (d) { return walk(sb, base, d, out); }))
            .then(function () {
              return rows.length === PAGE ? pageFrom(offset + PAGE) : out;
            });
        });
    }

    return pageFrom(0);
  }

  /* ----------------------------------------------------------------- signing
     One request per hundred files rather than one per file. A forty-file site
     is a single round trip; the old per-file version was forty, and on a
     phone that was the difference between instant and "is it broken?". */
  function sign(sb, prefix, rels) {
    var files = {};
    var chunks = [];
    for (var i = 0; i < rels.length; i += PAGE) chunks.push(rels.slice(i, i + PAGE));

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        var full = chunk.map(function (r) { return prefix + '/' + r; });
        return sb.storage.from(BUCKET).createSignedUrls(full, TTL).then(function (r) {
          if (r.error) throw r.error;
          (r.data || []).forEach(function (row, n) {
            /* v2 says signedUrl, v1 said signedURL, and some builds hand back
               a path rather than an absolute URL. Accept all three: getting
               this wrong produces a map full of undefined and a preview where
               every single file 404s. */
            var u = row && (row.signedUrl || row.signedURL || row.signed_url);
            if (!u || row.error) return;
            if (u.charAt(0) === '/') u = sbBase(sb) + u;
            files[chunk[n]] = u;
          });
        });
      });
    }, Promise.resolve()).then(function () { return files; });
  }

  function sbBase(sb) {
    try {
      return (sb.storageUrl || sb.supabaseUrl || (window.sbcConfig && window.sbcConfig.url) || '')
        .replace(/\/storage\/v1\/?$/, '').replace(/\/$/, '');
    } catch (e) { return ''; }
  }

  /* -------------------------------------------------------------------- api */
  var jobs = {};

  /* prefix is "<handle>/v<n>". Resolves with {count, exp, url}. */
  function prepare(sb, prefix) {
    /* A cached job whose signatures have since run out is worse than no
       cache at all: the button says "Open my site" and the tab it opens says
       "expired". Re-sign instead, silently. */
    if (jobs[prefix]) {
      return jobs[prefix].then(function (r) {
        if (r && r.exp && Date.now() > r.exp) { delete jobs[prefix]; return prepare(sb, prefix); }
        return r;
      });
    }

    var job = worker()
      .then(function () { return walk(sb, prefix, ''); })
      .then(function (rels) {
        if (!rels.length) {
          throw new Error('That folder is empty - nothing has been uploaded for this version yet.');
        }
        return sign(sb, prefix, rels).then(function (files) {
          var got = Object.keys(files).length;
          if (!got) throw new Error('None of those files could be opened. Are you still signed in?');
          var exp = Date.now() + (TTL - 60) * 1000;   /* a minute of headroom */
          return put({ prefix: prefix, files: files, exp: exp, at: Date.now() })
            .then(function () { return { count: got, missing: rels.length - got, exp: exp, url: url(prefix) }; });
        });
      });

    /* A failed attempt must not be cached, or the only way to retry is a
       reload - which is exactly what somebody does NOT want to do when the
       failure was a dropped connection. */
    job.catch(function () { delete jobs[prefix]; });
    jobs[prefix] = job;
    return job;
  }

  function url(prefix) {
    return '/preview/' + String(prefix).split('/').map(encodeURIComponent).join('/') + '/';
  }

  /* Wire an <a> to a preview: disabled and honest while it prepares, a plain
     link the moment it is ready. Used identically by the portal and the
     admin, which is the point of this file. */
  function attach(a, sb, prefix, opts) {
    opts = opts || {};
    var ready = opts.ready || 'Open my site';
    var busy = opts.busy || 'Preparing your site...';

    a.setAttribute('href', url(prefix));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    a.setAttribute('aria-disabled', 'true');
    a.classList.add('is-preparing');
    a.textContent = busy;

    return prepare(sb, prefix).then(function (r) {
      a.removeAttribute('aria-disabled');
      a.classList.remove('is-preparing');
      a.textContent = ready;
      if (opts.onReady) opts.onReady(r);
      return r;
    }).catch(function (e) {
      a.classList.remove('is-preparing');
      a.setAttribute('aria-disabled', 'true');
      a.textContent = 'Preview unavailable';
      if (opts.onError) opts.onError(e);
      throw e;
    });
  }

  /* A disabled anchor is still an anchor. Without this, a click during the
     couple of seconds it takes to prepare opens a tab on a preview whose map
     has not been written yet - the "open this from your portal" page, from
     inside the portal. */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[aria-disabled="true"]') : null;
    if (a) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  /* NOT `wbaPreview`. The admin page already has a global function by that
     name for previewing a blog post, declared in an inline script that runs
     after this file loads — so it won. The symptom was the admin's Open
     button sitting on "Preparing..." forever while the console said nothing,
     because a function is truthy and the guard above it passed. */
  window.wbaSitePreview = { prepare: prepare, attach: attach, url: url };
})();
