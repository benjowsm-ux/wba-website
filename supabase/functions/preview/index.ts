/* ==========================================================================
   WBA — preview.  Serves a client's site to that client, and nobody else.

   Deploy in the dashboard exactly like the other two:
     Edge Functions → Deploy a new function → Via Editor
     Name it:  preview
     Verify JWT: OFF        (the session arrives as a cookie, not a header)

   HOW IT WORKS
   The portal drops a short-lived cookie on westonbusinessauthority.co.uk
   before opening the tab. Netlify proxies /preview/* to this function, so the
   cookie comes along — which is the whole reason this runs behind the proxy
   rather than on its own domain.

   Then: verify the session, ask the database who they are, and only serve
   files whose first folder is that client's handle. A client cannot read
   another client's site because the storage policy would not return it even
   if this function asked wrongly — two locks, one key.

   WHY NOT ITS OWN DOMAIN, AS ORIGINALLY BUILT
   Because that needed Cloudflare, R2, wrangler and a DNS move to solve a
   problem that only exists for UNTRUSTED content. These previews are sites
   we build ourselves. Same-origin is a real trade — a preview's scripts can
   see the portal's storage — and it is an acceptable one when we wrote the
   scripts. If we ever host a site somebody else authored, this moves back
   out to its own hostname; cloudflare/preview-worker.js is still in the repo
   for that day.
   ========================================================================== */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SB_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY')!;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', avif: 'image/avif', gif: 'image/gif', ico: 'image/x-icon',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8', xml: 'application/xml', pdf: 'application/pdf',
  mp4: 'video/mp4', webm: 'video/webm', map: 'application/json'
};

/* A string body comes back out of the edge runtime as text/plain no matter
   what Content-Type is set on it — which is why the "please sign in" page
   rendered as visible source in the browser. A Blob carries its own type and
   survives, which is the same reason the actual site files were always fine. */
function page(status: number, message: string) {
  const body = `<!doctype html><meta charset="utf-8"><title>Preview</title>` +
    `<style>body{background:#060b16;color:#fff;font:16px/1.6 system-ui,sans-serif;` +
    `display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:2rem}` +
    `a{color:#f5c416}</style><div><p>${message}</p>` +
    `<p><a href="https://westonbusinessauthority.co.uk/portal/">Back to your portal</a></p></div>`;
  return new Response(new Blob([body], { type: 'text/html; charset=utf-8' }), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' }
  });
}

/* Not signed in is not an error page, it is a wrong turn. Send them to the
   place that can fix it rather than to a dead end with a link on it. */
function toPortal(path: string) {
  const to = 'https://westonbusinessauthority.co.uk/portal/?next=' + encodeURIComponent(path);
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  /* Netlify forwards the whole path. Everything after /preview/ is the file. */
  let path = url.pathname.replace(/^\/functions\/v1\/preview/, '').replace(/^\/preview/, '');
  path = path.replace(/^\/+/, '');

  /* Nothing that could climb out of its own folder. Checked before the key is
     built, not after — and the storage policy would refuse it anyway, which
     is the point of having both. */
  const segments = path.split('/').map(decodeURIComponent);
  if (segments.some((s) => s === '..' || s === '.' || s.includes('\\') || s.includes('\0'))) {
    return page(400, 'That address is not valid.');
  }
  if (!segments[0]) return page(400, 'Nothing to show at that address.');

  /* The session, from the cookie the portal set. */
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(/(?:^|;\s*)wba_pv=([^;]+)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  if (!token) return toPortal(url.pathname);

  const admin = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } });

  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return toPortal(url.pathname);

  /* Which client is this, and is this their folder? */
  const { data: link } = await admin
    .from('client_users').select('handle').eq('user_id', who.user.id).maybeSingle();
  const { data: isAdmin } = await admin
    .from('admins').select('user_id').eq('user_id', who.user.id).maybeSingle();

  const handle = (link?.handle || '').toLowerCase();
  if (!isAdmin && (!handle || handle !== segments[0].toLowerCase())) {
    return page(403, 'That preview belongs to a different account.');
  }

  /* A folder link should land on its index, exactly as the real site does —
     otherwise every internal link in the preview looks broken. */
  const clean = segments.join('/');
  const candidates: string[] = /\.[a-z0-9]+$/i.test(clean)
    ? [clean]
    : [clean.replace(/\/$/, '') + '/index.html', clean];

  for (const key of candidates) {
    const { data, error } = await admin.storage.from('previews').download(key);
    if (error || !data) continue;

    const ext = (key.split('.').pop() || '').toLowerCase();
    return new Response(data, {
      headers: {
        'Content-Type': TYPES[ext] || 'application/octet-stream',
        /* A preview changes under the client by design; a cached copy would
           be both stale and, in a shared proxy, leaky. */
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer'
      }
    });
  }

  return page(404, 'That page is not in this preview.');
});
