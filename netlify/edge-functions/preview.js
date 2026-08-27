/* ==========================================================================
   WBA — preview.  Serves a client's site to that client, and nobody else.

   A NETLIFY EDGE FUNCTION, not a Netlify Function. The classic
   netlify/functions/ build never produced anything — /.netlify/functions/
   stayed a 404 through several deploys on a site that has never had a build
   step. Edge functions need no bundler and are routed from netlify.toml, so
   there is nothing to infer and nothing to go quietly missing.

   WHY THIS IS HERE AND NOT A SUPABASE EDGE FUNCTION
   Because Supabase will not serve HTML. Measured, not assumed: the same
   bucket returns style.css as `text/css` and index.html as `text/plain`, and
   an edge function that explicitly sets `text/html` has it rewritten on the
   way out. That is a sensible policy on their part — nobody should be able to
   host a web page on *.supabase.co — and it is completely fatal to serving a
   client's site from there. Every page rendered as visible source.

   Netlify has no such rule, and this runs on westonbusinessauthority.co.uk,
   which brings two more things for free:

     · The wba_pv cookie the portal sets is same-origin, so it simply arrives.
       No token in a URL, no handoff, nothing to strip.
     · No new vendor and no new secret.

   THE AUTHORISATION IS NOT DONE HERE
   This does not check who owns what. It forwards the CLIENT'S OWN token to
   Supabase Storage and lets the `previews_read_own` policy answer — the same
   policy that guards the bucket from every other direction. A request for
   another client's folder comes back empty because the database refused it,
   not because this file remembered to ask.

   That is deliberate. Authorisation written twice is authorisation that can
   disagree with itself.
   ========================================================================== */

const SUPABASE_URL = 'https://lynzhiyvggqyplssrapi.supabase.co';
const ANON = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';
const PORTAL = 'https://westonbusinessauthority.co.uk/portal/';

/* Supabase reports text/plain for HTML, so the type comes from the extension
   rather than from what storage claims. */
const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', map: 'application/json',
  webmanifest: 'application/manifest+json'
};

function page(status, message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Preview</title>` +
    `<style>body{background:#060b16;color:#fff;font:16px/1.6 system-ui,sans-serif;` +
    `display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}` +
    `a{color:#f5c416}</style><div><p>${message}</p>` +
    `<p><a href="${PORTAL}">Back to your portal</a></p></div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
  );
}

export default async (req, context) => {
  const url = new URL(req.url);

  /* /preview/<handle>/v<n>/rest/of/path */
  let path = url.pathname
    .replace(/^\/\.netlify\/functions\/preview/, '')
    .replace(/^\/preview/, '')
    .replace(/^\/+/, '');

  const segments = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });

  /* Nothing that could climb out of its own folder. Storage would refuse it
     too, but a request like this is never innocent and should not travel. */
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0'))) {
    return page(400, 'That address is not valid.');
  }
  if (!segments.length) return page(400, 'Nothing to show at that address.');

  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wba_pv=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;

  /* Not signed in is a wrong turn, not an error. Send them where it can be
     fixed, and remember where they were going. */
  if (!token) {
    return Response.redirect(PORTAL + '?next=' + encodeURIComponent(url.pathname), 302);
  }

  /* A folder should land on its index, exactly as the real site does, or
     every internal link in the preview looks broken. */
  const clean = segments.join('/');
  const keys = /\.[a-z0-9]+$/i.test(clean)
    ? [clean]
    : [clean.replace(/\/$/, '') + '/index.html', clean];

  for (const key of keys) {
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/previews/${key.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { Authorization: `Bearer ${token}`, apikey: ANON } }
    );

    if (res.status === 401 || res.status === 403) {
      return Response.redirect(PORTAL + '?next=' + encodeURIComponent(url.pathname), 302);
    }
    if (!res.ok) continue;

    const ext = (key.split('.').pop() || '').toLowerCase();
    return new Response(res.body, {
      status: 200,
      headers: {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        /* A preview changes under the client by design, and it is theirs
           alone — never let a shared cache hold a copy. */
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer'
      }
    });
  }

  /* Their own 404 page if they built one, ours if not. */
  const own = await fetch(
    `${SUPABASE_URL}/storage/v1/object/previews/${segments.slice(0, 2).join('/')}/404.html`,
    { headers: { Authorization: `Bearer ${token}`, apikey: ANON } }
  );
  if (own.ok) {
    return new Response(own.body, {
      status: 404,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow'
      }
    });
  }

  return page(404, 'That page is not in this preview.');
};

/* The route is declared in netlify.toml under [[edge_functions]] rather
   than here, so there is exactly one place to look when it stops firing. */
