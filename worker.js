/* ==========================================================================
   WBA — the only server-side code on the site, and it does two small things.

   Everything else is a static file served straight from Cloudflare's edge
   without this script running at all (see run_worker_first in
   wrangler.jsonc). That is deliberate: static asset requests are free and
   uncapped, Worker invocations are not, so the Worker is kept off the hot
   path entirely.

   WHAT IT DOES

   1. /api/portal-login and /api/portal-invite are proxied to the Supabase
      Edge Functions. Proxied rather than called directly from the browser so
      the request is same-origin: no CORS preflight on every sign-in, and the
      Supabase project URL is not sitting in the page for someone to poke at.
      This replaces the two [[redirects]] that did the same job on Netlify.

   2. /preview/* is normally answered by preview/sw.js, a service worker
      running in the client's own browser. If it has been evicted — a long
      gap between visits, cleared site data — the request reaches the network
      instead, and this hands back the page that reinstalls it and reloads.
      This replaces the /preview/* fallback rule from netlify.toml.

   Both were configuration on Netlify. Neither can be configuration here,
   because Cloudflare's _redirects cannot proxy to another origin — so they
   are fifteen lines of code instead, which is also easier to read.
   ========================================================================== */

const SUPABASE = 'https://lynzhiyvggqyplssrapi.supabase.co';
const PROXIED = ['portal-login', 'portal-invite'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------------------------------------------------------- the API -- */
    if (url.pathname.startsWith('/api/')) {
      const fn = url.pathname.slice(5);
      /* An allow-list, not a pass-through. `/api/<anything>` forwarding to
         Supabase would make this an open proxy to every function in the
         project, including any added later without thinking about this file. */
      if (!PROXIED.includes(fn)) {
        return new Response('Not found', { status: 404 });
      }

      /* Rebuild the headers rather than forwarding them. Passing the original
         Host through makes Supabase answer for the wrong domain, and cookies
         for this site have no business being sent to theirs. */
      const headers = new Headers();
      const ct = request.headers.get('content-type');
      const auth = request.headers.get('authorization');
      if (ct) headers.set('content-type', ct);
      if (auth) headers.set('authorization', auth);
      /* The caller's IP, so portal-login's per-IP throttle throttles THEM and
         not this Worker — without it every sign-in in the country shares one
         bucket and the first few lock out the rest. */
      const ip = request.headers.get('cf-connecting-ip');
      if (ip) headers.set('x-forwarded-for', ip);

      const upstream = await fetch(`${SUPABASE}/functions/v1/${fn}`, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual'
      });

      const out = new Headers(upstream.headers);
      out.set('cache-control', 'no-store');
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    /* ------------------------------------------------------- the previews -- */
    if (url.pathname.startsWith('/preview/')) {
      const direct = await env.ASSETS.fetch(request);
      if (direct.status !== 404) return direct;

      /* Not a real file, so it is a preview path the service worker should
         have answered. Serve the page that puts the worker back.

         Fetch '/preview/' and not '/preview/index.html': Cloudflare's asset
         server answers the second with a 307 to the first, and returning that
         redirect sends the browser to /preview/ — where the healing page can
         no longer read which preview was wanted out of the address bar, and
         says "open this from your portal" about a preview that was fine.

         The BODY is returned at the ORIGINAL url, status 200. That is the
         whole point: the address bar still says /preview/pivaz/v3/, so the
         page can reinstall the worker and reload straight back into it. */
      const heal = await env.ASSETS.fetch(new Request(new URL('/preview/', url), { method: 'GET' }));
      return new Response(heal.body, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow'
        }
      });
    }

    return env.ASSETS.fetch(request);
  }
};
