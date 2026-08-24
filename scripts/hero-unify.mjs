/* ==========================================================================
   WBA — bring every sub-page hero up to the homepage treatment.

   Home had a photograph, a scrim, a coordinate grid and a pulse. Every other
   page had a flat navy rectangle with a blue blob behind it. That difference
   is the main reason the site read as "homepage, then some pages".

   This rewrites the <header class="page-hero"> block on each page into the
   same three-layer structure the homepage uses:

     .hero-media   the photograph
     .hero-scrim   the readability wash, which also carries the grid overlay
                   and the pointer light as pseudo-elements
     .inner        crumb / .hero-copy (beacon + h1 + lede) / optional panel

   Run it once. It is idempotent: a hero that already has .hero-media is
   skipped, so re-running after editing copy will not double up the layers.
   ========================================================================== */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/* The photograph for each page, plus the one fact worth putting in a panel.
   Pages not listed here still get a photograph — see FALLBACK — but no panel,
   because a legal page with a stats card on it is just noise. */
const PAGES = {
  'about/index.html': {
    photo: 'promenade-town.jpg', w: 1800, h: 810,
    alt: 'Weston-super-Mare promenade',
    panel: {
      title: 'Studio',
      live: 'Open',
      rows: [
        ['Based', 'Weston-super-Mare', 'BS22 · Somerset'],
        ['Covering', 'Weston, Worle', 'Clevedon &amp; Nailsea'],
        ['Founded', '2024', null],
        ['Answer in', '&lt; 24 hours', 'Weekdays']
      ]
    }
  },
  'services/index.html': {
    photo: 'high-street.jpg', w: 1600, h: 720,
    alt: 'Weston-super-Mare high street',
    panel: {
      title: 'Three pillars',
      rows: [
        ['01 — Build', 'Sites, apps, systems', 'The thing that runs'],
        ['02 — Create', 'Brand, print, media', 'The way it looks'],
        ['03 — Grow', 'SEO, ads, reporting', 'How it gets found']
      ]
    }
  },
  'sites/index.html': {
    photo: 'seafront-terraces.jpg', w: 1600, h: 720,
    alt: 'Seafront terraces, Weston-super-Mare',
    panel: {
      title: 'What it costs',
      live: 'Taking work',
      rows: [
        ['Design &amp; build', '<em>£0</em>', 'No setup fee'],
        ['Monthly', '£30', 'Hosting, changes, support'],
        ['Contract', 'None', 'Leave whenever'],
        ['You own', 'Everything', 'Domain, content, site']
      ]
    }
  },
  'contact/index.html': {
    photo: 'marine-lake-monument.jpg', w: 1600, h: 720,
    alt: 'Marine Lake, Weston-super-Mare',
    panel: {
      title: 'Reach us',
      live: 'Replying',
      rows: [
        ['Email', 'info@westonbusiness<wbr>authority.co.uk', null],
        ['Phone', '07902 376369', 'Mon–Fri, 9–6'],
        ['Typical reply', 'Same day', null],
        ['First call', 'Free', 'No pitch deck']
      ]
    }
  },
  'feed/index.html': {
    photo: 'mural-weston-letters.jpg', w: 1600, h: 720,
    alt: 'Weston lettering mural',
    panel: {
      title: 'The Feed',
      live: 'Updated',
      rows: [
        ['Writing about', 'Build · Create · Grow', null],
        ['Cadence', 'When there is something', 'Not on a schedule'],
        ['Written by', 'The people building it', null]
      ]
    }
  }
};

/* Everything else with a .page-hero: a photograph, no panel. Legal pages and
   articles want the same frame around them, not the same furniture. */
const FALLBACK = { photo: 'beach-wide.jpg', w: 1800, h: 810, alt: '' };
const ARTICLE  = { photo: 'marine-lake-reeds.jpg', w: 1400, h: 630, alt: '' };

function panelHTML(p) {
  const rows = p.rows.map(([k, v, sub]) =>
    '        <div class="hp-row">\n' +
    '          <span class="hp-k">' + k + '</span>\n' +
    '          <span class="hp-v">' + v +
      (sub ? '<span class="sub">' + sub + '</span>' : '') + '</span>\n' +
    '        </div>'
  ).join('\n');

  return [
    '    <aside class="win hero-panel" aria-label="' + p.title + '">',
    '      <div class="win-bar">',
    '        <span class="win-dots" aria-hidden="true"><i></i><i></i><i></i></span>',
    '        <span class="win-title">' + p.title + '</span>',
    (p.live
      ? '        <span class="hp-live"><i aria-hidden="true"></i>' + p.live + '</span>'
      : ''),
    '      </div>',
    '      <div class="win-body">',
    '        <div class="hp-rows">',
    rows,
    '        </div>',
    '      </div>',
    '    </aside>'
  ].filter(Boolean).join('\n');
}

/* Find every index.html that has a .page-hero. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', '.github', 'scripts', 'supabase', 'photos', 'img', 'css', 'js'].includes(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.html?$/i.test(name)) out.push(full);
  }
  return out;
}

let done = 0, skipped = 0;

for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length + 1).split('\\').join('/');
  let html = readFileSync(file, 'utf8');
  if (!html.includes('class="page-hero"')) continue;
  if (html.includes('page-hero')  && /page-hero[\s\S]{0,400}hero-media/.test(html)) { skipped++; continue; }

  const cfg = PAGES[rel]
    || (rel.startsWith('feed/') || rel.startsWith('post/') ? ARTICLE : FALLBACK);

  /* Grab the whole header so we can rebuild it rather than patch it. */
  const m = html.match(/<header class="page-hero">([\s\S]*?)<\/header>/);
  if (!m) { console.warn('! could not parse hero in ' + rel); continue; }
  const body = m[1];

  const crumb = (body.match(/<p[^>]*class="crumb"[^>]*>[\s\S]*?<\/p>/) || [''])[0];
  const h1    = (body.match(/<h1[\s\S]*?<\/h1>/) || [''])[0];

  /* Everything after the h1 that is not the crumb: the lede, and on Sites a
     block of buttons. Keep it in document order. */
  const afterH1 = body.slice(body.indexOf(h1) + h1.length);
  const rest = afterH1
    .replace(/<\/div>\s*$/, '')
    .replace(/^\s+|\s+$/g, '');

  const media = cfg.photo
    ? '  <div class="hero-media"><img src="/photos/' + cfg.photo + '" width="' + cfg.w +
      '" height="' + cfg.h + '" alt="' + cfg.alt + '" fetchpriority="high"/></div>\n' +
      '  <div class="hero-scrim"></div>\n'
    : '';

  const out = [
    '<header class="page-hero">',
    media.trimEnd(),
    '  <div class="inner">',
    crumb ? '    ' + crumb : '',
    '    <div class="hero-copy">',
    '      <div class="hero-lead">',
    '        <span class="beacon" aria-hidden="true"></span>',
    '        ' + h1,
    '      </div>',
    rest ? '      ' + rest.split('\n').map(l => l.trim()).filter(Boolean).join('\n      ') : '',
    '    </div>',
    cfg.panel ? panelHTML(cfg.panel) : '',
    '  </div>',
    '</header>'
  ].filter(l => l !== '').join('\n');

  html = html.replace(m[0], out);
  writeFileSync(file, html);
  console.log('· ' + rel + (cfg.panel ? '  (+ panel)' : ''));
  done++;
}

console.log('\nHeroes rebuilt: ' + done + (skipped ? ', already done: ' + skipped : ''));
