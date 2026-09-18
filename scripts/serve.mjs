/* ==========================================================================
   WBA - the site, locally.

     node scripts/serve.mjs          http://localhost:4321
     node scripts/serve.mjs 5000     somewhere else

   Why this exists rather than `npx serve`: it mirrors netlify.toml. A static
   server that does NOT know about the /preview/* fallback will happily 404 a
   preview URL that works perfectly in production, and a whole evening goes
   into debugging a bug that was never there.

   Service workers need a secure context. localhost counts as one, so the
   preview worker behaves here exactly as it does on the live site - which is
   the entire reason it is possible to test previews at all without a deploy.
   ========================================================================== */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The site root is the folder ABOVE this script, not the working directory.
   Launchers start servers from wherever they happen to be, and a dev server
   that silently serves the wrong folder looks exactly like a site with every
   file missing. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 4321;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm'
};

async function file(p) {
  try {
    const s = await stat(p);
    if (s.isDirectory()) return null;
    return await readFile(p);
  } catch { return null; }
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path;
  try { path=decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Invalid path'); return; }
  if (/^\/(?:\.|scripts(?:\/|$)|supabase(?:\/|$)|docs(?:\/|$)|node_modules(?:\/|$)|worker\.js|wrangler\.jsonc|package(?:-lock)?\.json)/i.test(path)) { res.writeHead(404).end('Not found'); return; }
  if (path.startsWith('/api/')) {
    const fn=path.slice(5);
    if (!['portal-login','portal-invite'].includes(fn)) { res.writeHead(404).end('Not found'); return; }
    if(req.method!=='POST'){res.writeHead(405).end('Method not allowed');return;}
    try {
      let chunks=[], size=0;
      for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413).end('Too large');return;}chunks.push(chunk);}
      const headers={'content-type':'application/json'};
      if(req.headers.authorization)headers.authorization=req.headers.authorization;
      const upstream=await fetch('https://lynzhiyvggqyplssrapi.supabase.co/functions/v1/'+fn,{method:'POST',headers,body:Buffer.concat(chunks),signal:AbortSignal.timeout(15000)});
      res.writeHead(upstream.status,{'content-type':'application/json','cache-control':'no-store'}).end(await upstream.text());
    } catch { res.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:'Connection unavailable. Try again shortly.'})); }
    return;
  }

  /* normalize() collapses ".." before it can climb out of the site root. A
     dev server is still a server. */
  let rel = normalize(path).replace(/^([/\\])+/, '');
  let full = join(ROOT, rel);
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('no'); return; }

  let body = await file(full);
  let sent = full;

  if (!body && (path.endsWith('/') || !extname(path))) {
    sent = join(full, 'index.html');
    body = await file(sent);
  }

  /* netlify.toml: /preview/* falls back to /preview/index.html, which puts
     an evicted service worker back and reloads. Not forced, so sw.js and
     index.html themselves are served as themselves - which the two lookups
     above have already done by the time we get here. */
  if (!body && path.startsWith('/preview/')) {
    sent = join(ROOT, 'preview', 'index.html');
    body = await file(sent);
  }

  if (!body) {
    const four = await file(join(ROOT, '404.html'));
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(four || 'Not found');
    return;
  }

  const headers = {
    'Content-Type': TYPES[extname(sent).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  };
  /* The one production header that changes behaviour rather than performance.
     Without it a worker script may be served from cache and a fix cannot
     reach the browser that needs it. */
  if (sent.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/preview/';

  res.writeHead(200, headers);
  res.end(body);
}).listen(PORT, () => {
  console.log('\n  WBA  http://localhost:' + PORT + '\n');
  console.log('  portal   http://localhost:' + PORT + '/portal/');
  console.log('  admin    http://localhost:' + PORT + '/admin/\n');
});
