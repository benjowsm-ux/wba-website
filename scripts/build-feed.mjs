/* ==========================================================================
   WBA — Feed generator.

   Reads published posts (Supabase, or a local JSON file in test mode) and
   writes real, crawlable HTML:

     /feed/<slug>/   one page per post
     /feed/          the index, with search + pillar filters
     /sitemap.xml    static pages + every post URL
     /blog.html      redirect stub, so old links keep working

   Every public URL is extensionless: pages live as <name>/index.html so the
   address bar reads /sites/ rather than /sites.html.

   It also injects generated markup back into the hand-written pages,
   between HTML comment markers:

     index.html          WBA:PILLARMEDIA:BUILD  the pillar's featured image
     services/index.html WBA:PILLAR:BUILD etc.  latest posts for that pillar
     sites/index.html    WBA:EXPLORE            related reading

   Fail-soft by design. If Supabase is unreachable the script keeps the
   existing pages and exits 0, so a transient network blip never turns the
   scheduled build red or wipes the site.

   Local test run (no network, no database):
     WBA_POSTS_FILE=scripts/seed-posts.json node scripts/build-feed.mjs
   ========================================================================== */

import { createHash } from 'crypto';
import { marked } from 'marked';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { replaceEditable, renderValue, declaredKeys, pagePathFor,
         replaceAttrs, declaredAttrKeys, parseImage, safeLink } from './lib/page-content.mjs';

const SUPABASE_URL = process.env.WBA_SUPABASE_URL || 'https://lynzhiyvggqyplssrapi.supabase.co';
const KEY  = process.env.WBA_SUPABASE_KEY || 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';
const SITE = 'https://westonbusinessauthority.co.uk';
const LOGO = '/img/wba-logo.png';
const FAV  = '/img/wba-icon.png';
const DEFAULT_OG = `${SITE}/photos/seafront-pier.jpg`;

const PILLARS = ['build', 'create', 'grow'];
const PILLAR_BLURB = {
  build:  'Tech that powers your business.',
  create: 'The identity your audience remembers.',
  grow:   'Unrestrained growth.'
};

/* ==========================================================================
   Helpers
   ========================================================================== */
const esc = s => (s == null ? '' : String(s))
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const md = s => (s ? marked.parse(String(s)) : '');
const cleanSlug = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

function fmtDate(iso){
  try{ return new Date(iso).toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' }); }
  catch(e){ return ''; }
}

function pillarOf(p){
  const c = String(p.category || '').toLowerCase().trim();
  return PILLARS.includes(c) ? c : '';
}

/* Resilient fetch — retries, then gives up quietly. */
async function fetchRetry(url, opts = {}, tries = 3){
  for(let i = 0; i < tries; i++){
    try{
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
      if(r.ok) return r;
      console.warn(`fetch attempt ${i + 1}: HTTP ${r.status}`);
    }catch(e){ console.warn(`fetch attempt ${i + 1}: ${e.message}`); }
    if(i < tries - 1) await new Promise(res => setTimeout(res, 2000 * (i + 1)));
  }
  return null;
}

/* --------------------------------------------------------------------------
   Intrinsic image size, straight out of the JPEG/PNG header.

   Article-body images have no fixed aspect-ratio in CSS (they're whatever
   shape they are), so without width/height the page reflows as each one
   loads. For anything served from /photos/ we can just read the real numbers.
   -------------------------------------------------------------------------- */
const dimCache = new Map();

function imageSize(url){
  if(typeof url !== 'string' || !url.startsWith('/photos/')) return null;
  if(dimCache.has(url)) return dimCache.get(url);

  let out = null;
  try{
    const buf = readFileSync('.' + url);

    if(buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47){
      /* PNG: IHDR is always the first chunk */
      out = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }else if(buf[0] === 0xff && buf[1] === 0xd8){
      /* JPEG: walk the markers to the start-of-frame */
      let i = 2;
      while(i < buf.length - 9){
        if(buf[i] !== 0xff){ i++; continue; }
        const m = buf[i + 1];
        if(m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)){ i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        /* SOF0-SOF15, excluding the non-frame markers DHT/JPG/DAC */
        if(m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc){
          out = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
          break;
        }
        i += 2 + len;
      }
    }
  }catch(e){ /* not local, or unreadable — fall through to null */ }

  dimCache.set(url, out);
  return out;
}

/* ` width="1600" height="720"`, or '' when we can't tell. */
function dimAttrs(url){
  const d = imageSize(url);
  return d ? ` width="${d.w}" height="${d.h}"` : '';
}

function parseBlocks(body){
  if(Array.isArray(body)) return body;
  if(typeof body !== 'string' || !body.trim()) return [];
  try{ const j = JSON.parse(body); return Array.isArray(j) ? j : []; }catch(e){ return []; }
}

/* Reading time from the block text, ~200wpm, minimum 1. */
function readMins(body){
  const blocks = parseBlocks(body);
  if(!blocks.length) return 1;
  const words = blocks
    .map(b => [b.text, b.heading, b.caption, b.label].filter(Boolean).join(' '))
    .join(' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

/* Up to `n` image URLs from a post: the cover first, then body images.
   This is what gives each card its little 2–3 image stack. */
function postImages(p, n = 3){
  const out = [];
  if(p.cover_image) out.push(p.cover_image);
  for(const b of parseBlocks(p.body)){
    if(out.length >= n) break;
    if((b.type === 'image' || b.type === 'imagetext') && b.url && !out.includes(b.url)) out.push(b.url);
  }
  return out.slice(0, n);
}

/* "More like this" — shared tags score 2, same pillar scores 1, newest wins ties. */
function related(p, all){
  return all
    .filter(o => o.slug !== p.slug)
    .map(o => {
      let s = 0;
      (p.tags || []).forEach(t => {
        if(t && (o.tags || []).some(x => x && String(x).toLowerCase() === String(t).toLowerCase())) s += 2;
      });
      if(pillarOf(o) && pillarOf(o) === pillarOf(p)) s += 1;
      return { o, s };
    })
    .sort((a, b) => b.s - a.s || new Date(b.o.published_at || 0) - new Date(a.o.published_at || 0))
    .slice(0, 3)
    .map(r => r.o);
}

/* ==========================================================================
   Block renderer — Node port of js/blocks.js. Keep the two in step.
   ========================================================================== */
function textOn(hex){
  try{
    let c = String(hex).replace('#', '');
    if(c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
    const r = parseInt(c.slice(0,2),16), g = parseInt(c.slice(2,4),16), b = parseInt(c.slice(4,6),16);
    return ((r*299 + g*587 + b*114) / 1000) > 150 ? '#161d2b' : '#ffffff';
  }catch(e){ return '#161d2b'; }
}

const BG_PRESETS = ['mist','white','ink','gold'];

function wrap(b, inner){
  if(!inner) return '';
  let cls = 'blk-wrap', style = '';
  if(b.bg){
    cls += ' has-bg';
    if(BG_PRESETS.includes(b.bg)) cls += ' bg-' + b.bg;
    else style = ` style="background:${esc(b.bg)};color:${textOn(b.bg)}"`;
  }
  if(b.pad === 'sm') cls += ' pad-sm';
  else if(b.pad === 'lg') cls += ' pad-lg';
  if(cls === 'blk-wrap' && !style) return inner;
  return `<div class="${cls}"${style}>${inner}</div>`;
}

function renderBlocks(body){
  const blocks = parseBlocks(body);
  if(!blocks.length) return md(String(body || ''));
  return blocks.map(b => {
    if(!b || !b.type) return '';
    let inner = '';
    switch(b.type){
      case 'header': {
        const lv = b.level === 3 ? 'h3' : 'h2';
        inner = `<${lv}>${esc(b.text)}</${lv}>`;
        break;
      }
      case 'body':
        inner = `<div class="blk-body">${md(b.text)}</div>`;
        break;
      case 'image':
        if(!b.url) break;
        inner = `<figure class="blk-image"><img src="${esc(b.url)}" alt="${esc(b.alt)}"${dimAttrs(b.url)} loading="lazy"/>`
              + ((b.caption && b.capOn !== false) ? `<figcaption>${esc(b.caption)}</figcaption>` : '')
              + `</figure>`;
        break;
      case 'imagetext': {
        const im = b.url
          ? `<div class="blk-it-img"><img src="${esc(b.url)}" alt="${esc(b.alt)}"${dimAttrs(b.url)} loading="lazy"/></div>`
          : '';
        inner = `<div class="blk-imagetext${b.side === 'right' ? ' img-right' : ''}">${im}`
              + `<div class="blk-it-text">${md(b.text)}</div></div>`;
        break;
      }
      case 'button':
        inner = `<div class="blk-button"><a class="btn btn-primary" href="${esc(b.url || '#')}">${esc(b.label || 'Button')}</a></div>`;
        break;
      case 'link':
        inner = `<p class="blk-link"><a class="link-go" href="${esc(b.url || '#')}">${esc(b.text || b.url || 'Link')}</a></p>`;
        break;
      case 'section':
        inner = (b.heading ? `<h2>${esc(b.heading)}</h2>` : '') + (b.text ? md(b.text) : '');
        break;
      default:
        return '';
    }
    return wrap(b, inner);
  }).join('\n');
}

/* ==========================================================================
   Shared chrome — must match the hand-written pages
   ========================================================================== */
function nav(active){
  const link = (href, label, key) =>
    `<a href="${href}"${active === key ? ' class="active"' : ''}>${label}</a>`;
  return `<nav class="nav">
  <div class="nav-inner">
    <a href="/" class="nav-logo" aria-label="WBA home"><img src="${LOGO}" alt="WBA" width="438" height="248"/></a>
    <button class="nav-toggle" aria-label="Menu" aria-expanded="false" onclick="toggleNav()"><span></span><span></span><span></span></button>
    <div class="nav-links" id="navLinks">
      ${link('/','Home','home')}
      ${link('/sites/','Sites','sites')}
      ${link('/services/','Services','services')}
      ${link('/about/','About','about')}
      ${link('/feed/','Feed','feed')}
      <a href="/contact/" class="nav-cta">Contact</a>
    </div>
  </div>
</nav>`;
}

const FOOTER = `<footer>
  <div class="footer-grid">
    <div class="footer-brand">
      <img src="${LOGO}" alt="WBA" width="438" height="248"/>
      <p data-edit="footer.body" data-edit-kind="rich" data-edit-scope="shared">Everyone needs a good tech guy.</p>
    </div>
    <div class="footer-col">
      <h4 data-edit="footer.h4" data-edit-scope="shared">Site</h4>
      <a href="/">Home</a><a href="/sites/">Sites</a><a href="/services/">Services</a><a href="/about/">About</a><a href="/feed/">Feed</a>
    </div>
    <div class="footer-col">
      <h4 data-edit="footer.h4-2" data-edit-scope="shared">What we do</h4>
      <a href="/services/#build">Build</a><a href="/services/#create">Create</a><a href="/services/#grow">Grow</a><a href="/contact/">Contact</a>
    </div>
    <div class="footer-col">
      <h4 data-edit="footer.h4-3" data-edit-scope="shared">Get in touch</h4>
      <a href="https://wa.me/447902376369" target="_blank" rel="noopener">WhatsApp 07902 376369</a>
      <a href="mailto:info@westonbusinessauthority.co.uk">info@westonbusinessauthority.co.uk</a>
      <a href="/contact/">Contact</a>
    </div>
  </div>
  <div class="footer-bottom">
    <span>© 2026 Weston Business Authority — Weston-super-Mare, Somerset.</span>
    <span><a href="/privacy/">Privacy</a> · <a href="/terms/">Terms</a> · westonbusinessauthority.co.uk</span>
  </div>
</footer>`;

const SCRIPTS = `<script src="/js/main.js" defer></script>
<script src="/js/analytics.js" defer></script>
<script src="/js/edit-boot.js" defer></script>`;

function head(opts){
  const { title, desc, url, image = DEFAULT_OG, type = 'website', ld = null } = opts;
  return `<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<link rel="canonical" href="${url}"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<meta property="og:image" content="${esc(image)}"/>
<meta property="og:url" content="${url}"/>
<meta property="og:type" content="${type}"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="icon" type="image/png" sizes="512x512" href="${FAV}"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link rel="manifest" href="/site.webmanifest"/>
<meta name="theme-color" content="#0b1220"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="/css/styles.css"/>
<noscript><style>.reveal{opacity:1!important;transform:none!important;}</style></noscript>${ld ? `\n<script type="application/ld+json">${JSON.stringify(ld)}</script>` : ''}`;
}

/* ==========================================================================
   Cards
   ========================================================================== */

/* Feed index card. */
function postCard(p){
  const pillar = pillarOf(p);
  const imgs = postImages(p, 1);
  const tags = (p.tags || []).slice(0, 3).map(t => `<span class="post-tag">${esc(t)}</span>`).join('');
  return `<a class="post-card" data-slug="${esc(p.slug)}" href="/feed/${esc(p.slug)}/">
  ${imgs[0] ? `<div class="post-card-media"><img src="${esc(imgs[0])}" alt=""${dimAttrs(imgs[0])} loading="lazy"/></div>` : ''}
  <div class="post-card-body">
    <div class="post-meta">${pillar ? esc(cap(pillar)) : 'Note'}<span class="dot"></span><span class="muted">${readMins(p.body)} min read</span></div>
    <h3>${esc(p.title)}</h3>
    <p>${esc(p.excerpt || '')}</p>
    ${tags ? `<div class="post-tags">${tags}</div>` : ''}
    <span class="link-go">Read</span>
  </div>
</a>`;
}

/* The picture at the top of a home-page pillar: that pillar's featured work,
   linked straight to the write-up. This is where the proof lives now. */
function pillarMedia(p, fallbackImage){
  const img = p ? (postImages(p, 1)[0] || fallbackImage) : fallbackImage;
  if(!img) return '';
  if(!p) return `<div class="pillar-media"><img src="${esc(img)}" alt=""${dimAttrs(img)} loading="lazy"/></div>`;
  return `<a class="pillar-media" href="/feed/${esc(p.slug)}/">
          <img src="${esc(img)}" alt="${esc(p.title)}"${dimAttrs(img)} loading="lazy"/>
          <span class="pm-label">${esc(p.title)}</span>
        </a>`;
}

/* ==========================================================================
   Page builders
   ========================================================================== */
function postPage(p, all){
  const url = `${SITE}/feed/${p.slug}/`;
  const pillar = pillarOf(p);
  const rel = related(p, all);
  const desc = p.excerpt || `${p.title} — from Weston Business Authority.`;
  const ogImg = p.cover_image || DEFAULT_OG;

  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: p.title,
    description: p.excerpt || '',
    image: ogImg,
    datePublished: p.published_at || new Date().toISOString(),
    author: { '@type': 'Organization', name: 'Weston Business Authority' },
    publisher: { '@type': 'Organization', name: 'Weston Business Authority', logo: { '@type': 'ImageObject', url: LOGO } },
    mainEntityOfPage: url
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head({ title: `${p.title} | WBA Weston-super-Mare`, desc, url, image: ogImg, type: 'article', ld })}
</head>
<body>
${nav('feed')}

<header class="page-hero">
  <div class="inner">
    <p class="crumb"><a href="/">Home</a> · <a href="/feed/">Feed</a>${pillar ? ` · <a href="/feed/?pillar=${pillar}">${esc(cap(pillar))}</a>` : ''}</p>
    <h1 class="h-lg">${esc(p.title)}</h1>
    ${p.excerpt ? `<p class="lede">${esc(p.excerpt)}</p>` : ''}
  </div>
</header>

<section class="section section-white reveal">
  <div class="inner">
    <article class="article">
      ${p.cover_image ? `<img class="article-cover" src="${esc(p.cover_image)}" alt="${esc(p.title)}"${dimAttrs(p.cover_image)}/>` : ''}
      <div class="byline">
        <span class="byline-ico"><img src="${FAV}" alt=""/></span>
        <span class="byline-txt">
          <b>${esc(p.author || 'WBA')}</b>
          <span>${fmtDate(p.published_at)} · ${readMins(p.body)} min read${pillar ? ` · ${esc(cap(pillar))}` : ''}</span>
        </span>
      </div>

      <div class="article-body">${renderBlocks(p.body)}</div>

      <div class="article-foot">
        <div class="helpful" data-slug="${esc(p.slug)}" data-title="${esc(p.title)}">
          <p class="helpful-q">Was this useful?</p>
          <div class="helpful-btns">
            <button type="button" data-vote="yes">Yes, cheers</button>
            <button type="button" data-vote="no">Not really</button>
          </div>
          <p class="helpful-thanks" hidden>Thanks — good to know.</p>
          <p class="helpful-count" aria-live="polite"></p>
        </div>
        <div class="article-actions">
          <button type="button" data-act="update">Suggest an update</button>
          <button type="button" data-act="report">Report an issue</button>
          <button type="button" data-act="copy">Copy link</button>
        </div>
        <div class="act-form" id="actForm" hidden>
          <p class="act-form-label" id="actLabel"></p>
          <textarea id="actMsg"></textarea>
          <input type="text" id="actName" placeholder="Your name (optional)"/>
          <div><button type="button" class="btn btn-primary" id="actSend">Send</button> <span class="send-status" id="actStatus"></span></div>
        </div>
      </div>
    </article>
  </div>
</section>

${rel.length ? `<section class="section section-mist reveal">
  <div class="inner">
    <div class="section-head">
      <p class="eyebrow">Keep reading</p>
      <h2 class="h-lg">More like this.</h2>
    </div>
    <div class="feed-grid">
${rel.map(postCard).join('\n')}
    </div>
  </div>
</section>` : ''}

<section class="cta-band reveal">
  <div class="inner">
    <h2 class="h-md">Want one of these?</h2>
    <div class="cta-actions">
      <a href="/sites/" class="btn btn-gold">Get a free site</a>
      <a href="/contact/" class="btn btn-line inverse">Get in touch</a>
    </div>
  </div>
</section>

${FOOTER}
${SCRIPTS}
</body>
</html>`;
}

function feedIndex(posts){
  const cards = posts.map(postCard).join('\n');

  const index = JSON.stringify(posts.map(p => ({
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt || '',
    tags: p.tags || [],
    pillar: pillarOf(p)
  }))).replace(/</g, '\\u003c');

  const counts = { all: posts.length };
  PILLARS.forEach(k => { counts[k] = posts.filter(p => pillarOf(p) === k).length; });

  const filters = ['all', ...PILLARS].map(k =>
    `<button type="button" data-pillar="${k}"${k === 'all' ? ' class="on"' : ''}>${k === 'all' ? 'Everything' : cap(k)}${counts[k] ? ` <span style="opacity:.6">${counts[k]}</span>` : ''}</button>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
${head({
  title: 'Feed — Insight, Projects & Notes | WBA Weston-super-Mare',
  desc: 'Work we have finished, and what we learned doing it. From WBA, a design and technology agency in Weston-super-Mare.',
  url: `${SITE}/feed/`
})}
</head>
<body>
${nav('feed')}

<header class="page-hero">
  <div class="inner">
    <p class="crumb"><a href="/">Home</a> · Feed</p>
    <h1 class="h-lg">The Feed.</h1>
    <p class="lede">Work we've finished, and what we learned doing it.</p>
  </div>
</header>

<section class="section section-mist reveal">
  <div class="inner">
    <div class="feed-bar">
      <div class="feed-filters">${filters}</div>
      <div class="feed-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>
        <label for="feedSearch" class="skip-link">Search the Feed</label>
        <input id="feedSearch" type="search" placeholder="Search the Feed…" autocomplete="off"/>
        <div class="search-drop" id="searchDrop"></div>
      </div>
    </div>

    <div class="feed-grid" id="feedGrid">
${cards}
      <p class="feed-empty" id="feedEmpty"${posts.length ? ' style="display:none"' : ''}>${posts.length ? 'Nothing matches that — try another word or pillar.' : 'Nothing published yet. The first write-ups are on their way.'}</p>
    </div>
  </div>
</section>

<script id="feedIndexData" type="application/json">${index}</script>

${FOOTER}
${SCRIPTS}
</body>
</html>`;
}

/* Old /blog URLs keep working. */
function redirectStub(to){
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta http-equiv="refresh" content="0; url=${to}"/>
<link rel="canonical" href="${SITE}${to}"/>
<meta name="robots" content="noindex"/>
<title>Moved — WBA</title>
</head>
<body><p>The blog is now the <a href="${to}">Feed</a>.</p>
<script>location.replace('${to}');</script>
</body>
</html>`;
}

function sitemap(posts){
  const pages = [
    ['/', '1.0', 'weekly'],
    ['/sites/', '1.0', 'monthly'],
    ['/services/', '0.9', 'monthly'],
    ['/about/', '0.7', 'monthly'],
    ['/feed/', '0.9', 'weekly'],
    ['/contact/', '0.8', 'monthly'],
    ['/free-website-terms/', '0.4', 'yearly'],
    ['/privacy/', '0.3', 'yearly'],
    ['/terms/', '0.3', 'yearly']
  ];
  const rows = pages.map(([loc, pri, freq]) =>
    `  <url><loc>${SITE}${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`);
  posts.forEach(p => rows.push(
    `  <url><loc>${SITE}/feed/${p.slug}/</loc>` +
    (p.published_at ? `<lastmod>${new Date(p.published_at).toISOString().slice(0, 10)}</lastmod>` : '') +
    `<changefreq>monthly</changefreq><priority>0.8</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

/* ==========================================================================
   Injection into the hand-written pages
   ========================================================================== */
function injectBetween(file, marker, html){
  if(!existsSync(file)){ console.warn(`inject: ${file} not found, skipped.`); return false; }
  const src = readFileSync(file, 'utf8');
  const start = `<!-- WBA:${marker}:START`;
  const end = `<!-- WBA:${marker}:END -->`;
  const i = src.indexOf(start);
  const j = src.indexOf(end);
  if(i === -1 || j === -1 || j < i){
    console.warn(`inject: markers for ${marker} missing in ${file}, skipped.`);
    return false;
  }
  /* Keep the opening marker line intact, replace everything up to the closing one. */
  const startLineEnd = src.indexOf('\n', i);
  /* A start marker whose comment runs onto a second line would leave the
     injected markup inside an unclosed <!-- ... -->: invisible in the browser,
     and the generator would still report success. Refuse instead. */
  if(src.slice(i, startLineEnd).indexOf('-->') === -1){
    console.warn(`inject: ${marker} start marker in ${file} does not close its comment on one line - skipped.`);
    return false;
  }
  const out = src.slice(0, startLineEnd + 1) + html + '\n    ' + src.slice(j);
  writeFileSync(file, out);
  return true;
}

/* One card per pillar for the home page: the flagged post, else the newest. */
function featuredForPillar(posts, pillar){
  const inPillar = posts.filter(p => pillarOf(p) === pillar);
  return inPillar.find(p => p.featured) || inPillar[0] || null;
}

/* Used when a pillar has no published post yet, so the card still has a face. */
const PILLAR_FALLBACK = {
  build:  '/photos/town-fountains.jpg',
  create: '/photos/mural-you-are-loved.jpg',
  grow:   '/photos/high-street.jpg'
};

/* One article, laid out sideways, filling the space under the intro. Renders
   nothing at all while the Feed is empty — an empty box is worse than none. */
function injectSpotlight(posts){
  const p = posts.find(x => x.featured) || posts[0];
  if(!p){
    injectBetween('index.html', 'SPOTLIGHT', '');
    console.log('Home: no posts yet, spotlight left empty.');
    return;
  }
  const img = postImages(p, 1)[0];
  /* A compact, centred card: cover image, then the byline every post already
     carries (author, date, reading time). Which post appears here is the one
     ticked "Featured" in Admin -> Feed. */
  const when = p.published_at ? fmtDate(p.published_at) : '';
  const html = `    <a class="spotlight" href="/feed/${esc(p.slug)}/">
      ${img ? `<span class="spotlight-media"><img src="${esc(img)}" alt=""${dimAttrs(img)} loading="lazy"/></span>` : ''}
      <span class="spotlight-body">
        <span class="spotlight-kicker">${pillarOf(p) ? esc(cap(pillarOf(p))) : 'From the Feed'}</span>
        <span class="spotlight-title">${esc(p.title)}</span>
        <span class="spotlight-by">
          <span class="sb-ico" aria-hidden="true">${esc((p.author || 'WBA').trim().charAt(0).toUpperCase())}</span>
          <span class="sb-meta"><b>${esc(p.author || 'WBA')}</b><span>${esc(when)}${when ? ' &middot; ' : ''}${readMins(p.body)} min read</span></span>
        </span>
      </span>
    </a>`;
  injectBetween('index.html', 'SPOTLIGHT', html);
  console.log(`Home: spotlight -> ${p.slug}`);
}

function injectPillarMedia(posts){
  let n = 0;
  PILLARS.forEach(k => {
    const pick = featuredForPillar(posts, k);
    if(pick) n++;
    const html = '        ' + pillarMedia(pick, PILLAR_FALLBACK[k]);
    injectBetween('index.html', `PILLARMEDIA:${k.toUpperCase()}`, html);
  });
  console.log(`Home: pillar images set (${n} of ${PILLARS.length} from a featured post).`);
}

/* Related reading at the foot of the Sites page. */
/* Related reading under the Sites page.

   "Newest three" was handing whoever reads about a free website a post about
   reporting metrics. Score each post against what that page is actually about
   - how a site gets designed and built - and fall back to recency only when
   nothing scores. Tags and slug both count, so a post stays relevant after
   its title gets rewritten in the admin. */
const SITES_TOPICS = [
  'website', 'websites', 'web', 'design', 'branding', 'brand', 'seo',
  'performance', 'free', 'build', 'process', 'template', 'copywriting'
];

function relevance(post){
  const hay = [...(post.tags || []), post.slug || '', post.title || '']
    .join(' ').toLowerCase();
  let score = SITES_TOPICS.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  if(pillarOf(post) === 'build')  score += 2;
  if(pillarOf(post) === 'create') score += 1;
  return score;
}

function injectExplore(posts){
  const ranked = posts
    .map((p, i) => ({ p, score: relevance(p), i }))
    /* recency breaks ties, so the block still turns over as he publishes */
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const scored = ranked.filter(r => r.score > 0);
  const picks = (scored.length ? scored : ranked).slice(0, 3).map(r => r.p);

  const html = picks.length
    ? `    <p class="eyebrow">Related reading</p>
    <h2>How the work actually gets done</h2>
    <div class="feed-grid" style="margin-top:2.2rem;">\n${picks.map(postCard).join('\n')}\n    </div>
    <p style="margin-top:2.2rem;"><a class="link-go" href="/feed/">Everything in the Feed</a></p>`
    : '';
  injectBetween('sites/index.html', 'EXPLORE', html);
}

function injectPillarRows(posts){
  PILLARS.forEach(k => {
    const list = posts.filter(p => pillarOf(p) === k).slice(0, 3);
    const html = list.length
      ? `    <div style="margin-top:clamp(3.5rem,7vw,5.5rem);">
      <p class="eyebrow">${esc(cap(k))} in the Feed</p>
      <div class="feed-grid" data-count="${list.length}">
${list.map(postCard).join('\n')}
      </div>
      <div style="margin-top:2rem;"><a href="/feed/?pillar=${k}" class="link-go">All ${esc(cap(k))} posts</a></div>
    </div>`
      : '';
    injectBetween('services/index.html', `PILLAR:${k.toUpperCase()}`, html);
  });
  console.log('Services: pillar rows updated.');
}

/* ==========================================================================
   Run
   ========================================================================== */
let posts = null;

if(process.env.WBA_POSTS_FILE){
  posts = JSON.parse(readFileSync(process.env.WBA_POSTS_FILE, 'utf8'));
  console.log(`(test mode: ${posts.length} post(s) from ${process.env.WBA_POSTS_FILE})`);
}else{
  const url = `${SUPABASE_URL}/rest/v1/posts?status=eq.published`
    + `&select=slug,title,excerpt,cover_image,category,tags,body,featured,published_at,author`
    + `&order=published_at.desc`;
  const res = await fetchRetry(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if(res){
    try{ posts = await res.json(); }
    catch(e){ console.warn('Posts JSON parse failed:', e.message); }
  }
}

if(!posts){
  console.warn('Feed: source unreachable — keeping the existing pages unchanged (green run).');
  process.exit(0);
}

/* An empty result is NOT the same as "there are no posts".
   A broken row-level-security policy returns HTTP 200 with `[]`, which looks
   exactly like an empty blog — and would quietly delete every published page
   on the next scheduled run. If we already have post pages on disk and the
   database suddenly claims there are none, assume the database is wrong and
   leave the site alone. Set WBA_ALLOW_EMPTY=1 to genuinely empty the Feed. */
if(posts.length === 0 && !process.env.WBA_ALLOW_EMPTY){
  const existing = existsSync('feed')
    ? readdirSync('feed', { withFileTypes: true }).filter(d => d.isDirectory()).length
    : 0;
  if(existing > 0){
    console.warn(`Feed: source returned 0 posts but ${existing} page(s) exist on disk.`);
    console.warn('Feed: refusing to wipe them. Check the RLS policy on `posts`, or set WBA_ALLOW_EMPTY=1.');
    process.exit(0);
  }
}

posts = posts
  .map(p => ({ ...p, slug: cleanSlug(p.slug) }))
  .filter(p => p.slug && p.title);

/* Rebuild /feed from scratch so deleted posts really disappear. */
rmSync('feed', { recursive: true, force: true });
mkdirSync('feed', { recursive: true });

posts.forEach(p => {
  mkdirSync(`feed/${p.slug}`, { recursive: true });
  writeFileSync(`feed/${p.slug}/index.html`, postPage(p, posts));
});

const indexHTML = feedIndex(posts);
writeFileSync('feed/index.html', indexHTML);

/* Old URLs -> new ones. */
writeFileSync('blog.html', redirectStub('/feed/'));
mkdirSync('blog', { recursive: true });
writeFileSync('blog/index.html', redirectStub('/feed/'));

writeFileSync('sitemap.xml', sitemap(posts));

injectPillarMedia(posts);
injectSpotlight(posts);
injectPillarRows(posts);
injectExplore(posts);

console.log(`Feed: wrote ${posts.length} post page(s), feed/index.html and sitemap.xml.`);

/* ==========================================================================
   Edit mode — bake page_content overrides into the static HTML.

   This runs LAST, after every injector, so it also covers markup the
   generator itself just wrote. Overrides are applied to the file on disk;
   the database stays the edit log and the HTML stays what ships.
   ========================================================================== */
async function bakePageContent(){
  /* Test mode has no database. Skip quietly rather than failing the build. */
  if(process.env.WBA_POSTS_FILE && !process.env.WBA_PAGE_CONTENT_FILE){
    console.log('Edit mode: skipped (test build, no database).');
    return;
  }

  let rows = null;
  if(process.env.WBA_PAGE_CONTENT_FILE){
    rows = JSON.parse(readFileSync(process.env.WBA_PAGE_CONTENT_FILE, 'utf8'));
  }else{
    const url = `${SUPABASE_URL}/rest/v1/page_content?select=page,key,value,kind`;
    const res = await fetchRetry(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    if(!res){
      console.warn('Edit mode: page_content unreachable — leaving the HTML as built.');
      return;
    }
    try{ rows = await res.json(); }
    catch(e){ console.warn('Edit mode: page_content JSON parse failed:', e.message); return; }
  }

  if(!Array.isArray(rows)){
    /* A 404 here means the table does not exist yet, which is a normal state
       before supabase/page-content.sql has been run. Say so once, plainly. */
    const hint = rows && rows.message ? ` (${rows.message})` : '';
    console.warn(`Edit mode: no page_content table yet${hint} — run supabase/page-content.sql.`);
    return;
  }
  if(!rows.length){
    console.log('Edit mode: no overrides saved.');
    return;
  }

  /* page -> [row] */
  const byPage = new Map();
  for(const r of rows){
    if(!byPage.has(r.page)) byPage.set(r.page, []);
    byPage.get(r.page).push(r);
  }

  /* Every HTML file the site ships, mapped to the path edit.js would report. */
  const files = [];
  (function scan(dir){
    for(const e of readdirSync(dir, { withFileTypes: true })){
      const full = dir === '.' ? e.name : `${dir}/${e.name}`;
      if(e.isDirectory()){
        if(['node_modules','.git','.github','scripts','supabase','photos','img','css','js','.claude'].includes(e.name)) continue;
        scan(full);
      }else if(/\.html?$/i.test(e.name)){
        files.push(full);
      }
    }
  })('.');

  let applied = 0, skipped = 0, orphaned = 0;
  const problems = [];
  const sharedSeen = new Map();   // shared key -> how many pages it landed on

  /* '*' holds the nav and footer — copy that lives on every page, so one edit
     has to reach all of them. Applied to every file, before the page's own
     rows, so a page-specific override still wins if the keys ever collide. */
  const shared = byPage.get('*') || [];
  byPage.delete('*');

  for(const file of files){
    const page = pagePathFor(file);
    const own  = byPage.get(page) || [];
    const overrides = shared.concat(own);
    if(!overrides.length) continue;

    let html = readFileSync(file, 'utf8');
    const declared     = new Set(declaredKeys(html));
    const declaredImg  = new Set(declaredAttrKeys(html, 'data-edit-img'));
    const declaredHref = new Set(declaredAttrKeys(html, 'data-edit-href'));
    let touched = false;

    for(const row of overrides){
      const isShared = row.page === '*';

      /* ---- an image ---- */
      if(row.kind === 'src'){
        if(!declaredImg.has(row.key)){
          if(!isShared){ orphaned++; problems.push(`  ${page} ${row.key}: image no longer in the markup`); }
          continue;
        }
        const img = parseImage(row.value);
        if(!img){
          skipped++;
          problems.push(`  ${page} ${row.key}: image source refused by the allow-list`);
          continue;
        }
        const out = replaceAttrs(html, 'data-edit-img', row.key, {
          src: img.src,
          /* No dimensions means we genuinely do not know them. Removing the
             stale pair beats keeping numbers that describe a different
             picture — a wrong width is a guaranteed layout shift. */
          width:  img.w,
          height: img.h,
          ...(img.alt === null ? {} : { alt: img.alt })
        });
        if(out.status === 'ok'){ html = out.html; touched = true; applied++; }
        else { skipped++; problems.push(`  ${page} ${row.key}: ${out.status}`); }
        continue;
      }

      /* ---- a link destination ---- */
      if(row.kind === 'href'){
        if(!declaredHref.has(row.key)){
          if(!isShared){ orphaned++; problems.push(`  ${page} ${row.key}: link no longer in the markup`); }
          continue;
        }
        const href = safeLink(row.value);
        if(!href){
          skipped++;
          problems.push(`  ${page} ${row.key}: link refused by the allow-list`);
          continue;
        }
        const out = replaceAttrs(html, 'data-edit-href', row.key, { href });
        if(out.status === 'ok'){ html = out.html; touched = true; applied++; }
        else { skipped++; problems.push(`  ${page} ${row.key}: ${out.status}`); }
        continue;
      }

      /* ---- text ---- */
      if(!declared.has(row.key)){
        /* A shared key simply isn't on this page — the admin panel has no
           footer, for one — which is normal and not worth reporting. A
           page's OWN key going missing means the markup changed under it,
           and that is worth naming: the row is otherwise invisibly dead. */
        if(!isShared){
          orphaned++;
          problems.push(`  ${page} ${row.key}: no longer in the markup`);
        }else{
          sharedSeen.set(row.key, sharedSeen.get(row.key) || 0);
        }
        continue;
      }

      const out = replaceEditable(html, row.key, renderValue(row.value, row.kind));
      if(out.status === 'ok'){
        html = out.html; touched = true; applied++;
        if(isShared) sharedSeen.set(row.key, (sharedSeen.get(row.key) || 0) + 1);
      }else{
        skipped++;
        problems.push(`  ${page} ${row.key}: ${out.status}`);
      }
    }

    if(touched) writeFileSync(file, html);
    byPage.delete(page);
  }

  /* A shared key that matched nothing anywhere really is dead. */
  for(const [key, hits] of sharedSeen){
    if(hits === 0){
      orphaned++;
      problems.push(`  * ${key}: shared key found on no page`);
    }
  }

  /* Overrides whose page no longer exists at all. */
  for(const [page, list] of byPage){
    orphaned += list.length;
    problems.push(`  ${page}: page not found (${list.length} override(s))`);
  }

  console.log(`Edit mode: applied ${applied} override(s)` +
              (skipped ? `, ${skipped} failed` : '') +
              (orphaned ? `, ${orphaned} orphaned` : '') + '.');
  if(problems.length) console.warn(problems.join('\n'));
}

/* ==========================================================================
   A manifest of the photos already in the repo.

   The Edit-mode image picker can list what has been uploaded to Supabase
   Storage, because Storage has an API. It cannot list /photos/ — that is just
   a folder on a CDN with no directory index. So the build writes one, with
   real dimensions, and the picker offers both sources side by side.
   ========================================================================== */
function writePhotoManifest(){
  if(!existsSync('photos')) return;
  const files = readdirSync('photos', { withFileTypes: true })
    .filter(e => e.isFile() && /\.(jpe?g|png|webp|avif)$/i.test(e.name))
    .map(e => {
      const url = '/photos/' + e.name;
      const d = imageSize(url);
      return { url, name: e.name, w: d ? d.w : null, h: d ? d.h : null };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  writeFileSync('photos/manifest.json', JSON.stringify(files, null, 1));
  console.log(`Photos: manifest lists ${files.length} image(s).`);
}

writePhotoManifest();

/* ==========================================================================
   Cache-busting for CSS and JS.

   THE BUG THIS FIXES, so nobody removes it:
   netlify.toml caches /css/* and /js/* for a week. The HTML is served with
   max-age=0, so a returning visitor gets BRAND NEW MARKUP against a SEVEN DAY
   OLD STYLESHEET. Every new component renders unstyled — unsized SVGs blowing
   up to full width, bare <li> bullets where a card should be, images stretched
   because the rule that fixed them is not in the copy their browser kept. It
   looks exactly like the deploy failed, and no amount of re-deploying helps.

   Appending a content hash to the URL means a changed file is a changed URL,
   so the browser is obliged to fetch it, while unchanged files stay cached.
   ========================================================================== */
function stampAssets(){
  const hashOf = file => {
    try { return createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10); }
    catch (e) { return null; }
  };

  /* Every asset the pages reference, with its current content hash. */
  const versions = new Map();
  const add = f => { const h = hashOf(f); if (h) versions.set('/' + f, h); };
  add('css/styles.css');
  if (existsSync('js')) {
    for (const e of readdirSync('js', { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) add('js/' + e.name);
    }
  }
  if (!versions.size) return;

  const files = [];
  (function scan(dir){
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = dir === '.' ? e.name : dir + '/' + e.name;
      if (e.isDirectory()) {
        if (['node_modules','.git','.github','scripts','supabase','photos','img','css','js','.claude'].includes(e.name)) continue;
        scan(full);
      } else if (/\.html?$/i.test(e.name)) {
        files.push(full);
      }
    }
  })('.');

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let touched = 0;
  for (const file of files) {
    let html = readFileSync(file, 'utf8');
    const before = html;
    for (const [path, hash] of versions) {
      /* Match the path with or without an existing ?v=, so re-running the
         build replaces the stamp rather than stacking another one on. */
      const re = new RegExp('(["\'(])' + escapeRe(path) + '(?:\\?v=[a-f0-9]+)?(["\')])', 'g');
      html = html.replace(re, '$1' + path + '?v=' + hash + '$2');
    }
    if (html !== before) { writeFileSync(file, html); touched++; }
  }
  console.log('Assets: stamped ' + versions.size + ' file version(s) across ' + touched + ' page(s).');
}

stampAssets();

await bakePageContent();
