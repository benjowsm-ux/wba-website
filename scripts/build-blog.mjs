/* ==========================================================================
   WBA — Blog static-page generator.
   Runs in GitHub Actions. Pulls published Blogs from Supabase and writes:
     - /blog/<slug>/index.html   (a real, crawlable, SEO'd page per Blog)
     - /blog.html                (the index, with real links)
     - /sitemap.xml              (static pages + every Blog URL)
   No secrets needed — the Supabase publishable key is public-safe.
   ========================================================================== */
import { marked } from 'marked';
import { writeFileSync, mkdirSync } from 'fs';

const SUPABASE_URL = 'https://lynzhiyvggqyplssrapi.supabase.co';
const KEY = 'sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K';
const SITE = 'https://westonbusinessauthority.co.uk';
const LOGO = 'https://res.cloudinary.com/du3psvz2u/image/upload/v1776177977/Logo_4_zfjgwh.png';
const DEFAULT_OG = 'https://res.cloudinary.com/du3psvz2u/image/upload/v1780318572/20260525_113222_r4wxwu.jpg';
const FAV = 'https://res.cloudinary.com/du3psvz2u/image/upload/v1780318702/android-chrome-512x512_nzg5wu.png';

/* ---- fetch published posts ---- */
const url = `${SUPABASE_URL}/rest/v1/posts?status=eq.published&select=slug,title,excerpt,cover_image,category,tags,body,published_at,author&order=published_at.desc`;
const res = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
if(!res.ok){ console.error('Supabase fetch failed:', res.status, await res.text()); process.exit(1); }
const posts = (await res.json()).filter(p => p.slug && p.title);
console.log(`Fetched ${posts.length} published Blog(s).`);

/* ---- block render (Node port of blocks.js) ---- */
const esc = s => (s==null?'':String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const md = s => s ? marked.parse(String(s)) : '';
function textOn(hex){ try{ let c=hex.replace('#',''); if(c.length===3) c=c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);
  return ((r*299+g*587+b*114)/1000)>150 ? '#1a1f2e' : '#ffffff'; }catch(e){ return '#1a1f2e'; } }
function wrap(b, inner){ if(!inner) return ''; let cls='blk-wrap', style=''; const preset=['cream','white','navy','gold'];
  if(b.bg){ cls+=' has-bg'; if(preset.includes(b.bg)) cls+=' bg-'+b.bg; else style=` style="background:${esc(b.bg)};color:${textOn(b.bg)}"`; }
  if(b.pad==='sm') cls+=' pad-sm'; else if(b.pad==='lg') cls+=' pad-lg';
  if(cls==='blk-wrap' && !style) return inner; return `<div class="${cls}"${style}>${inner}</div>`; }
function renderBlocks(body){
  let blocks; try{ blocks = typeof body==='string' ? JSON.parse(body) : body; }catch(e){ return md(String(body||'')); }
  if(!Array.isArray(blocks)) return md(String(body||''));
  return blocks.map(b => { if(!b || !b.type) return ''; let inner='';
    switch(b.type){
      case 'header': { const lv = b.level===3?'h3':'h2'; inner = `<${lv}>${esc(b.text)}</${lv}>`; break; }
      case 'body': inner = `<div class="blk-body">${md(b.text)}</div>`; break;
      case 'image': if(!b.url) break; inner = `<figure class="blk-image"><img src="${esc(b.url)}" alt="${esc(b.alt)}" loading="lazy"/>${b.caption?`<figcaption>${esc(b.caption)}</figcaption>`:''}</figure>`; break;
      case 'imagetext': { const im = b.url?`<div class="blk-it-img"><img src="${esc(b.url)}" alt="${esc(b.alt)}" loading="lazy"/></div>`:''; inner = `<div class="blk-imagetext${b.side==='right'?' img-right':''}">${im}<div class="blk-it-text">${md(b.text)}</div></div>`; break; }
      case 'button': inner = `<div class="blk-button"><a class="btn-primary" href="${esc(b.url||'#')}">${esc(b.label||'Button')}</a></div>`; break;
      case 'link': inner = `<p class="blk-link"><a href="${esc(b.url||'#')}">${esc(b.text||b.url||'Link')} &rarr;</a></p>`; break;
      case 'section': inner = (b.heading?`<h2>${esc(b.heading)}</h2>`:'') + (b.text?md(b.text):''); break;
      default: return '';
    }
    return wrap(b, inner);
  }).join('\n');
}

/* ---- shared chrome (root-absolute links so nested pages work) ---- */
const NAV = `<nav>
  <a href="/index.html" class="nav-logo"><img src="${LOGO}" alt="Weston Business Authority"/></a>
  <button class="nav-toggle" aria-label="Open menu" onclick="toggleNav()"><span></span><span></span><span></span></button>
  <div class="nav-links" id="navLinks">
    <a href="/services.html">Services</a><a href="/pricing.html">Pricing</a><a href="/work.html">Work</a><a href="/weston.html">Weston Guide</a><a href="/blog.html">Blog</a><a href="/contact.html">Contact</a>
    <a href="https://wa.me/447902376369" class="nav-wa" target="_blank">WhatsApp</a>
  </div>
</nav>`;
const FOOTER = `<footer>
  <div class="footer-grid">
    <div class="footer-brand"><img src="${LOGO}" alt="WBA"/>
      <p>Your local creative &amp; tech team in Weston-Super-Mare. We build websites, apps &amp; systems, create photography, design, print &amp; media, and grow your business online. Serving our town since 2023.</p></div>
    <div class="footer-col"><h4>Navigate</h4>
      <a href="/services.html">Services</a><a href="/pricing.html">Pricing</a><a href="/work.html">Work</a><a href="/weston.html">Weston Guide</a><a href="/blog.html">Blog</a><a href="/about.html">About</a><a href="/contact.html">Contact</a></div>
    <div class="footer-col"><h4>Get in Touch</h4>
      <a href="https://wa.me/447902376369" target="_blank">💬 WhatsApp: 07902 376369</a>
      <a href="mailto:support@westonbusinessauthority.co.uk">✉️ support@westonbusinessauthority.co.uk</a>
      <a href="https://www.facebook.com/WestonMarketing/" target="_blank">🔵 Facebook</a></div>
  </div>
  <div class="footer-bottom"><span>© 2026 Weston Business Authority. Weston-Super-Mare, Somerset.</span>
    <span><a href="/privacy.html">Privacy</a> · <a href="/terms.html">Terms</a> · 07902 376369 · westonbusinessauthority.co.uk</span></div>
</footer>`;

function fmtDate(iso){ try{ return new Date(iso).toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}); }catch(e){ return ''; } }
function cap(s){ return s?s.charAt(0).toUpperCase()+s.slice(1):'Blog'; }

/* ---- a single Blog page ---- */
function postPage(p){
  const u = `${SITE}/blog/${p.slug}/`;
  const desc = esc(p.excerpt || `${p.title} — a guide from Weston Business Authority.`);
  const ogImg = p.cover_image || DEFAULT_OG;
  const ld = { "@context":"https://schema.org","@type":"BlogPosting","headline":p.title,"description":p.excerpt||'',
    "image": ogImg, "datePublished": p.published_at || new Date().toISOString(),
    "author": {"@type":"Organization","name":"Weston Business Authority"},
    "publisher": {"@type":"Organization","name":"Weston Business Authority","logo":{"@type":"ImageObject","url":LOGO}},
    "mainEntityOfPage": u };
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${esc(p.title)} | Weston Business Authority — Weston-super-Mare</title>
<meta name="description" content="${desc}"/>
<link rel="canonical" href="${u}"/>
<meta property="og:type" content="article"/><meta property="og:title" content="${esc(p.title)}"/>
<meta property="og:description" content="${desc}"/><meta property="og:image" content="${esc(ogImg)}"/><meta property="og:url" content="${u}"/>
<meta name="twitter:card" content="summary_large_image"/>
<link rel="icon" type="image/png" sizes="512x512" href="${FAV}"/><meta name="theme-color" content="#00224d"/>
<link rel="preconnect" href="https://res.cloudinary.com"/>
<link rel="stylesheet" href="/css/styles.css"/>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head><body>
${NAV}
<header class="page-hero"><div class="inner">
  <p class="crumb"><a href="/index.html">Home</a> · <a href="/blog.html">Blog</a> · ${esc(cap(p.category))}</p>
  <h1 id="postTitle">${esc(p.title)}</h1>
</div></header>
<section class="s-white on-light reveal"><div class="inner"><article class="article">
  ${p.cover_image?`<img class="article-cover" src="${esc(p.cover_image)}" alt="${esc(p.title)}"/>`:''}
  <p class="article-meta">${esc(p.author||'WBA')} · ${fmtDate(p.published_at)}</p>
  <div class="article-body">${renderBlocks(p.body)}</div>
</article></div></section>
<section class="cta-band reveal"><div class="inner">
  <h2>Rather we did it for you?</h2>
  <p>We're the local team behind these guides — happy to just take it off your plate.</p>
  <a href="/contact.html" class="btn-primary">Book a Free Visit →</a>
</div></section>
${FOOTER}
<script src="/js/main.js" defer></script>
</body></html>`;
}

/* ---- the Blog index ---- */
function blogIndex(){
  const cards = posts.length ? posts.map(p => `<a class="blog-card" href="/blog/${esc(p.slug)}/">${p.cover_image?`<div class="blog-card-img"><img src="${esc(p.cover_image)}" alt=""/></div>`:''}<div class="blog-card-body">${p.category?`<div class="blog-cat">${esc(p.category)}</div>`:''}<h3>${esc(p.title)}</h3><p>${esc(p.excerpt||'')}</p><span class="blog-read">Read →</span></div></a>`).join('\n')
    : `<p class="blog-empty">No guides published yet — the first ones are on their way. Check back soon!</p>`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Guides &amp; Insight | Weston Business Authority</title>
<meta name="description" content="Free, practical guides for local businesses from Weston Business Authority — marketing, design, tech and more."/>
<link rel="canonical" href="${SITE}/blog.html"/>
<meta property="og:title" content="Guides &amp; Insight | Weston Business Authority"/>
<meta property="og:description" content="Free, practical guides for Weston-super-Mare businesses."/>
<meta property="og:type" content="website"/><meta property="og:url" content="${SITE}/blog.html"/>
<link rel="icon" type="image/png" sizes="512x512" href="${FAV}"/><meta name="theme-color" content="#00224d"/>
<link rel="preconnect" href="https://res.cloudinary.com"/>
<link rel="stylesheet" href="/css/styles.css"/>
</head><body>
${NAV}
<header class="page-hero"><div class="inner">
  <p class="crumb"><a href="/index.html">Home</a> · Blog</p>
  <h1>Guides<br><em>&amp; Insight.</em></h1>
  <p>Free, practical guides for local businesses — no jargon, no gatekeeping. Written by the team that does this every day.</p>
</div></header>
<section class="s-paper on-light reveal"><div class="inner"><div class="blog-grid">
${cards}
</div></div></section>
<section class="cta-band reveal"><div class="inner">
  <h2>Want us to just handle it?</h2>
  <p>Guides are the DIY route. If you'd rather hand it over, that's what we're here for.</p>
  <a href="/contact.html" class="btn-primary">Book a Free Visit →</a>
</div></section>
${FOOTER}
<script src="/js/main.js" defer></script>
</body></html>`;
}

/* ---- sitemap ---- */
function sitemap(){
  const staticPages = [
    ['/',            '1.0','weekly'], ['/services.html','0.9','monthly'], ['/pricing.html','0.9','monthly'],
    ['/work.html','0.8','monthly'], ['/about.html','0.7','monthly'], ['/weston.html','0.8','monthly'],
    ['/blog.html','0.9','weekly'], ['/news.html','0.7','weekly'], ['/submit.html','0.5','monthly'],
    ['/contact.html','0.9','monthly'], ['/privacy.html','0.3','yearly'], ['/terms.html','0.3','yearly']
  ];
  const rows = staticPages.map(([loc,pri,freq]) => `  <url><loc>${SITE}${loc}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`);
  posts.forEach(p => rows.push(`  <url><loc>${SITE}/blog/${p.slug}/</loc>${p.published_at?`<lastmod>${new Date(p.published_at).toISOString().slice(0,10)}</lastmod>`:''}<changefreq>monthly</changefreq><priority>0.8</priority></url>`));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join('\n')}\n</urlset>\n`;
}

/* ---- write everything ---- */
posts.forEach(p => { mkdirSync(`blog/${p.slug}`, { recursive: true }); writeFileSync(`blog/${p.slug}/index.html`, postPage(p)); });
writeFileSync('blog.html', blogIndex());
writeFileSync('sitemap.xml', sitemap());
console.log(`Wrote ${posts.length} Blog page(s), blog.html and sitemap.xml.`);
