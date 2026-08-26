/* ==========================================================================
   WBA — the preview worker.
   Deploy to Cloudflare. Serves client site previews out of R2, to the client
   they belong to and nobody else.

   THE PROBLEM THIS SOLVES
   A client needs to look at their site before it is live. The obvious answer
   — put it on a secret URL — is not access control, it is a URL nobody has
   guessed YET. Secret URLs end up in browser history, in a forwarded email,
   in a screenshot, in an analytics referrer header. For an in-progress site
   that is only embarrassing; for one with real prices or contact details in
   it, less so.

   So a preview is served only to a browser holding a valid Supabase session
   whose user is attached to that client. Same login as the portal, one
   identity, no second password to issue.

   HOW THE CHECK WORKS
   The browser sends the Supabase access token. We verify it against the
   project's JWKS — that is a signature check we can do here, in the edge,
   without a round trip to Supabase on every image. Then one call to the
   database asks the only question that matters: does this user own this
   prefix? That answer is cached for a minute, so a page of forty assets
   makes one query, not forty.

   WHAT IT DELIBERATELY DOES NOT DO
   - It does not trust anything in the path. `../` is normalised away before
     the key is built, so a request cannot climb out of its own folder into
     another client's.
   - It does not serve HTML from the same origin as the portal. Previews are
     client-written-ish content; on a shared origin a preview could read the
     portal's storage. Hence a separate hostname.

   SETUP
     wrangler deploy
     wrangler r2 bucket create wba-previews
   Bindings (wrangler.toml):
     [[r2_buckets]] binding = "PREVIEWS", bucket_name = "wba-previews"
   Secrets:
     wrangler secret put SUPABASE_URL
     wrangler secret put SUPABASE_ANON_KEY
   ========================================================================== */

const CACHE_TTL_MS = 60_000;
const access = new Map();          /* `${sub}:${prefix}` -> { ok, at } */
let jwks = null, jwksAt = 0;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* /<client>/<version>/rest/of/path */
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return html(400, 'Malformed preview address.');

    /* Normalise before anything else. A path segment of `..` must never
       survive into the object key — that is the whole ballgame. */
    const clean = [];
    for (const p of parts) {
      const d = decodeURIComponent(p);
      if (d === '..' || d === '.' || d.includes('\\') || d.includes('\0')) {
        return html(400, 'Malformed preview address.');
      }
      clean.push(d);
    }

    const prefix = `${clean[0]}/${clean[1]}`;
    const rest = clean.slice(2).join('/') || 'index.html';

    /* --------------------------------------------------------------- auth */
    const token = bearer(request);
    if (!token) return redirectToPortal(url);

    let claims;
    try {
      claims = await verify(token, env);
    } catch {
      return redirectToPortal(url);
    }

    const allowed = await maySee(claims.sub, token, prefix, env, ctx);
    if (!allowed) return html(403, 'This preview belongs to a different account.');

    /* --------------------------------------------------------------- serve */
    let key = `${prefix}/${rest}`;
    let obj = await env.PREVIEWS.get(key);

    /* A folder link (/about/) should land on its index, the same way the
       real site behaves — otherwise every preview looks broken the moment a
       client clicks an internal link. */
    if (!obj && !rest.includes('.')) {
      key = `${prefix}/${rest.replace(/\/$/, '')}/index.html`;
      obj = await env.PREVIEWS.get(key);
    }
    if (!obj) {
      const fallback = await env.PREVIEWS.get(`${prefix}/404.html`);
      if (fallback) return serve(fallback, `${prefix}/404.html`, 404);
      return html(404, 'Not in this preview.');
    }

    return serve(obj, key, 200);
  }
};

/* -------------------------------------------------------------------------- */

function bearer(request) {
  const h = request.headers.get('Authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  /* Sub-resources (images, CSS) cannot carry a header, so the portal sets a
     cookie scoped to this hostname when it hands the client the link. */
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wba_pv=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function verify(token, env) {
  const now = Date.now();
  if (!jwks || now - jwksAt > 3_600_000) {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
    if (!r.ok) throw new Error('jwks');
    jwks = await r.json();
    jwksAt = now;
  }

  const [h64, p64, s64] = token.split('.');
  if (!h64 || !p64 || !s64) throw new Error('shape');

  const header = JSON.parse(b64url(h64));
  const payload = JSON.parse(b64url(p64));

  /* Expiry is checked BEFORE the signature: a stale token is the common
     case and there is no reason to do elliptic-curve maths to reject it. */
  if (!payload.exp || payload.exp * 1000 < now) throw new Error('expired');
  if (!payload.sub) throw new Error('sub');

  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('kid');

  const alg = jwk.kty === 'RSA'
    ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
    : { name: 'ECDSA', namedCurve: 'P-256' };

  const key = await crypto.subtle.importKey('jwk', jwk, alg, false, ['verify']);
  const ok = await crypto.subtle.verify(
    jwk.kty === 'RSA' ? alg : { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bytes(s64),
    new TextEncoder().encode(`${h64}.${p64}`)
  );
  if (!ok) throw new Error('signature');

  return payload;
}

/* Ask the database once per user-and-prefix per minute. The query runs as
   the CLIENT, so row-level security answers it — this worker has no
   privileged key and could not read another client's row if it tried. */
async function maySee(sub, token, prefix, env, ctx) {
  const cacheKey = `${sub}:${prefix}`;
  const hit = access.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ok;

  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/previews?select=id&path=eq.${encodeURIComponent(prefix)}&limit=1`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`
    }
  });

  let ok = false;
  if (r.ok) {
    const rows = await r.json();
    ok = Array.isArray(rows) && rows.length > 0;
  }

  access.set(cacheKey, { ok, at: Date.now() });
  if (access.size > 500) access.clear();      /* it is a cache, not a store */
  return ok;
}

function serve(obj, key, status) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', obj.httpMetadata?.contentType || guess(key));
  headers.set('etag', obj.httpEtag);
  /* Private, and revalidated. A preview changes under the client's feet by
     design; a cached copy in a shared proxy would be both stale and leaky. */
  headers.set('Cache-Control', 'private, no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  /* Previews are not framed anywhere, including by us. */
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  return new Response(obj.body, { status, headers });
}

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif',
  gif: 'image/gif', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm'
};
function guess(key) {
  const ext = key.split('.').pop().toLowerCase();
  return TYPES[ext] || 'application/octet-stream';
}

function redirectToPortal(url) {
  const to = new URL('https://westonbusinessauthority.co.uk/portal/');
  to.searchParams.set('next', url.pathname);
  return Response.redirect(to.toString(), 302);
}

function html(status, message) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Preview</title>` +
    `<style>body{background:#060b16;color:#fff;font:16px/1.6 system-ui,sans-serif;` +
    `display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}` +
    `a{color:#f5c416}</style><div><p>${message}</p>` +
    `<p><a href="https://westonbusinessauthority.co.uk/portal/">Back to your portal</a></p></div>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
  );
}

function b64url(s) {
  return atob(s.replace(/-/g, '+').replace(/_/g, '/'));
}
function bytes(s) {
  const raw = b64url(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
