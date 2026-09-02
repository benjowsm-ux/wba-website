/* ==========================================================================
   WBA - the preview server. There isn't one.

   THE PROBLEM THIS SOLVES
   -----------------------
   A client preview is a folder of HTML, CSS, JS and images that has to render
   as a website. Three attempts failed, each for the same reason: they all
   needed a server.

     Supabase Storage       returns index.html as text/plain. Not a setting -
                            it rewrites the type. Every page showed as source.
     Supabase Edge Function proxied it, and Supabase rewrote the header again.
     Netlify Edge Function  would have worked, and never deployed: the account
                            ran out of credits before it ever built.

   So this serves previews with NO server, NO function and NO deploy budget.
   A service worker sits on /preview/ and answers the requests itself.

   HOW
   ---
   1. The portal (or the admin) lists the client's folder, asks Supabase for a
      signed URL for every file in it, and writes that map into IndexedDB.
      That happens as the signed-in user, so row-level security decides what
      they are allowed to sign. Nothing here can widen it.
   2. This worker intercepts every request under /preview/, looks the path up
      in that map, fetches the bytes from the signed URL, and returns them
      with a Content-Type WE choose, from the file extension.

   That last sentence is the whole trick. Supabase can call index.html
   whatever it likes - we throw its Content-Type away and set our own. The bug
   that killed the last three attempts cannot happen here, because the header
   the browser sees is written on this side.

   And because the URLs the browser asks for are real
   (/preview/pivaz/v3/img/logo.png), relative links, stylesheets, scripts and
   images all resolve on their own. No HTML rewriting, no blob URLs, no
   rebasing. The client's site behaves exactly as it will on its own domain.

   WHAT THIS WORKER CAN AND CANNOT REACH
   -------------------------------------
   It holds no token and no key. All it has is a list of signed URLs somebody
   already had permission to create, each expiring in eight hours. If the map
   is missing or stale it can serve nothing at all - it cannot go and ask for
   more. That is deliberate: the security lives in the page where the session
   is, not in here.

   THE ONE TRADE
   -------------
   Previews are served from this origin, so a preview's scripts share it with
   the portal. These are sites we built ourselves, so that is first-party
   code - but it is a real trade and worth knowing. When a second origin
   exists (preview.westonbusinessauthority.co.uk), this file moves there
   unchanged and the trade goes away.
   ========================================================================== */
'use strict';

var ROOT = '/preview/';
var DB = 'wba-preview';
var STORE = 'sites';

/* A new worker should take over immediately. The alternative is a client
   sitting on last week's copy of this file until every preview tab is
   closed, which is indistinguishable from "previews are broken". */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

/* ------------------------------------------------------------------- store
   The page writes, this reads. Same database, one object store, keyed by the
   folder prefix so several clients (and several versions) can be open at once
   without touching each other. */
function openDb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB, 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'prefix' });
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}

function site(prefix) {
  return openDb().then(function (db) {
    return new Promise(function (res) {
      var q = db.transaction(STORE, 'readonly').objectStore(STORE).get(prefix);
      q.onsuccess = function () { res(q.result || null); };
      q.onerror = function () { res(null); };
    });
  }).catch(function () { return null; });
}

/* -------------------------------------------------------------------- mime
   Derived from the extension, every time, and never from what the store says.
   Getting this wrong is not a small bug: text/plain on an HTML file shows the
   markup, and the wrong type on a stylesheet makes the browser ignore it
   silently - the page renders, unstyled, with nothing in the console. */
var TYPES = {
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', map: 'application/json', xml: 'application/xml',
  txt: 'text/plain', md: 'text/plain', csv: 'text/csv',
  webmanifest: 'application/manifest+json', wasm: 'application/wasm',

  /* Images. Called out because "as well as images" is half the job, and
     because svg and ico are the two the browser is fussiest about. */
  svg: 'image/svg+xml', png: 'image/png', apng: 'image/apng',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', pjpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', cur: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',

  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  otf: 'font/otf', eot: 'application/vnd.ms-fontobject',

  mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',

  pdf: 'application/pdf', zip: 'application/zip'
};
var TEXTY = /^(text\/|application\/(json|xml|javascript|manifest))/;

function typeOf(path) {
  var m = /\.([a-z0-9]+)$/i.exec(path);
  var t = m ? TYPES[m[1].toLowerCase()] : null;
  if (!t) return 'application/octet-stream';
  return TEXTY.test(t) ? t + '; charset=utf-8' : t;
}

/* ------------------------------------------------------------------- pages
   Always text/html. An error page served as text/plain renders its own markup
   on screen, which is how a broken preview used to look like a broken site. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(status, title, body) {
  var html =
    '<!doctype html><html lang="en"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + esc(title) + '</title><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1220;' +
    'color:#e8edf7;font:16px/1.6 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif;padding:2rem}' +
    '.c{max-width:32rem;text-align:center}' +
    'h1{font-size:1.35rem;margin:0 0 .6rem;color:#fff}' +
    'p{margin:0 0 1.4rem;color:#9fb0cc}' +
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;color:#f5c416}' +
    'a{display:inline-block;padding:.7rem 1.2rem;border-radius:.5rem;background:#f5c416;' +
    'color:#0b1220;font-weight:600;text-decoration:none}' +
    '</style><div class="c"><h1>' + esc(title) + '</h1><p>' + body + '</p>' +
    '<a href="/portal/">Back to your portal</a></div></html>';

  return new Response(html, {
    status: status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/* ------------------------------------------------------------------- serve */
self.addEventListener('fetch', function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf(ROOT) !== 0) return;

  var rest = url.pathname.slice(ROOT.length);
  /* The worker's own file, and the landing page, are real files on the host.
     Answering them from here would mean it could never be updated. */
  if (!rest || rest === 'sw.js' || rest === 'index.html') return;

  e.respondWith(serve(rest));
});

function serve(rest) {
  var parts = rest.split('/').map(function (s) {
    try { return decodeURIComponent(s); } catch (err) { return s; }
  });

  /* <handle>/v<n>/... - the first two segments say which site. */
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return Promise.resolve(page(404, 'Nothing here',
      'That address is missing the site it belongs to.'));
  }
  var prefix = parts[0] + '/' + parts[1];
  var rel = parts.slice(2).join('/');

  return site(prefix).then(function (s) {
    if (!s || !s.files) {
      return page(409, 'Open this from your portal',
        'Previews are unlocked by signing in, so this address cannot be opened on ' +
        'its own. Sign in and press <b>Open my site</b>.');
    }
    if (s.exp && Date.now() > s.exp) {
      return page(410, 'This preview has expired',
        'Preview links last eight hours. Open it again from your portal and it ' +
        'will pick up where it left off.');
    }

    /* What did they actually ask for?
         /pivaz/v3/        ->  index.html
         /pivaz/v3/about/  ->  about/index.html
         /pivaz/v3/about   ->  about/index.html, then about.html
       The middle one is how nearly every link in a hand-built site is
       written, and getting it wrong is what makes the front page work and
       nothing else. */
    var tries = [];
    var last = rel.split('/').pop();
    if (!rel || rel.slice(-1) === '/') {
      tries.push(rel + 'index.html');
    } else if (/\.[a-z0-9]+$/i.test(last)) {
      tries.push(rel);
    } else {
      tries.push(rel + '/index.html', rel + '.html', rel);
    }

    var hit = null;
    for (var i = 0; i < tries.length; i++) {
      if (Object.prototype.hasOwnProperty.call(s.files, tries[i])) { hit = tries[i]; break; }
    }

    /* A site of its own may ship a 404 page. Theirs beats ours. */
    if (!hit && Object.prototype.hasOwnProperty.call(s.files, '404.html')) {
      return send(s.files['404.html'], '404.html', 404);
    }
    if (!hit) {
      return page(404, 'That page is not in this preview',
        'The folder we were sent does not contain <code>' + esc(tries[0]) + '</code>.');
    }
    return send(s.files[hit], hit, 200);
  }).catch(function () {
    return page(500, 'Something went wrong',
      'The preview could not be read. Open it again from your portal.');
  });
}

/* Fetch the bytes, keep the bytes, throw the headers away. */
function send(signed, name, status) {
  return fetch(signed, { redirect: 'follow' }).then(function (r) {
    if (!r.ok) {
      /* Storage answers an expired or revoked signature with 400/401/403.
         That is not "missing", it is "your eight hours are up", and saying
         so is the difference between a client waiting and a client ringing. */
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return page(410, 'This preview has expired',
          'Open it again from your portal for a fresh link.');
      }
      return page(502, 'Could not load that file',
        'The file is there, but fetching it failed. Try again in a moment.');
    }
    return r.blob().then(function (b) {
      return new Response(b, {
        status: status,
        headers: {
          'Content-Type': typeOf(name),
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow'
        }
      });
    });
  }).catch(function () {
    return page(502, 'Could not load that file', 'Check the connection and try again.');
  });
}
