/* ==========================================================================
   WBA — mobile audit.

     node scripts/audit.mjs [device] [baseUrl]

   Reports the things that make a site awkward on a phone and that a
   screenshot alone will not tell you reliably: text below 12px, tap targets
   under 44px, elements that overlap each other, contrast failures, and inputs
   that trigger the iOS zoom-on-focus behaviour.
   ========================================================================== */

import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DEVICE = process.argv[2] || 'iphone-390';
const BASE   = process.argv[3] || 'http://localhost:8093';

const DEVICES = {
  'iphone-390':  { w: 390, h: 844, mobile: true },
  'android-360': { w: 360, h: 800, mobile: true },
  'small-320':   { w: 320, h: 720, mobile: true },
  'tablet-768':  { w: 768, h: 1024, mobile: true },
  'desktop-1440':{ w: 1440, h: 900, mobile: false }
};
const d = DEVICES[DEVICE];

const PAGES = ['/', '/sites/', '/services/', '/about/', '/feed/',
               '/feed/back-of-house-app-harmony/', '/contact/', '/privacy/', '/404.html'];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
].find(p => p && existsSync(p));

const port = 9300 + (Date.now() % 400);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'wba-audit-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--disable-gpu'
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('no debugging port');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res); ws.addEventListener('error', rej);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    waiting.set(msg.id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
  return { ready, send, close: () => ws.close() };
}

/* Runs inside the page. Everything measured, nothing assumed. */
const PROBE = `(() => {
  /* Visible AND actually occupying space a finger could reach.

     getBoundingClientRect reports a box even for content clipped away by an
     overflow:hidden ancestor — which is exactly how the mobile nav is closed
     (max-height:0). Without this check the closed menu shows up as a dozen
     tiny tap targets overlapping the page, and every real finding drowns. */
  const vis = el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity <= 0.05) return false;
    if (r.width <= 0 || r.height <= 0) return false;
    let n = el.parentElement;
    while (n && n !== document.body) {
      const p = getComputedStyle(n);
      if ((p.overflow === 'hidden' || p.overflowY === 'hidden')) {
        const pr = n.getBoundingClientRect();
        if (pr.height < 2 || pr.width < 2) return false;
      }
      n = n.parentElement;
    }
    return true;
  };
  const label = el => el.tagName.toLowerCase() +
    (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '');
  const text = el => (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46);

  /* --- type that is too small to read comfortably on a phone --- */
  const tiny = [];
  document.querySelectorAll('p,li,a,span,div,label,td,th,figcaption,small').forEach(el => {
    if (el.childElementCount || !vis(el)) return;
    const t = text(el); if (t.length < 8) return;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size && size < 12) tiny.push({ el: label(el), size: +size.toFixed(1), text: t });
  });

  /* --- tap targets. 44px is Apple's guidance, 24px is the WCAG 2.2 floor. --- */
  const small = [];
  document.querySelectorAll('a,button,input,select,textarea,[role=button]').forEach(el => {
    if (!vis(el)) return;
    const r = el.getBoundingClientRect();
    /* An inline link inside a paragraph is expected to be short; only judge
       things that stand alone as controls. */
    const inline = el.tagName === 'A' && el.closest('p,li') && getComputedStyle(el).display === 'inline';
    if (inline) return;
    if (r.height < 44 || r.width < 44) {
      small.push({ el: label(el), w: Math.round(r.width), h: Math.round(r.height), text: text(el) });
    }
  });

  /* --- controls that overlap each other: the classic floating-button bug --- */
  const overlaps = [];
  const controls = [...document.querySelectorAll('a,button,input,textarea,select')].filter(vis);
  const fixed = controls.filter(el => {
    let n = el;
    while (n && n !== document.body) {
      const p = getComputedStyle(n).position;
      if (p === 'fixed' || p === 'sticky') return true;
      n = n.parentElement;
    }
    return false;
  });
  fixed.forEach(f => {
    const a = f.getBoundingClientRect();
    controls.forEach(c => {
      if (c === f || f.contains(c) || c.contains(f)) return;
      const b = c.getBoundingClientRect();
      const hit = !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      if (hit) overlaps.push({ floating: label(f), covers: label(c), text: text(c) });
    });
  });

  /* --- iOS zooms the whole page when a focused input is under 16px --- */
  const zoomy = [];
  const TYPES = ['text','email','tel','password','search','url','number','date',''];
  document.querySelectorAll('input,select,textarea').forEach(el => {
    if (!vis(el)) return;
    /* Only fields you type into. A checkbox has a font-size, but focusing one
       never zooms the page. */
    if (el.tagName === 'INPUT' && !TYPES.includes((el.type || '').toLowerCase())) return;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size && size < 16) zoomy.push({ el: label(el), size: +size.toFixed(1) });
  });

  /* --- contrast, composited properly through transparent ancestors --- */
  const L = c => { const f = c.map(v => { v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
                   return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2]; };
  const num = s => (s.match(/[\\d.]+/g) || []).map(Number);
  const bgOf = el => {
    let n = el;
    while (n) {
      const cs = getComputedStyle(n);
      const p = num(cs.backgroundColor);
      if (p.length >= 3 && (p.length < 4 || p[3] > 0.92)) return p.slice(0, 3);
      /* a gradient: sample its first colour rather than falling through */
      const gi = cs.backgroundImage;
      if (gi && gi !== 'none' && /rgb/.test(gi)) {
        const c = num(gi.slice(gi.indexOf('rgb')));
        if (c.length >= 3) return c.slice(0, 3);
      }
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const contrast = [];
  document.querySelectorAll('p,li,a,span,h1,h2,h3,h4,label,button,small,figcaption').forEach(el => {
    if (el.childElementCount || !vis(el)) return;
    const t = text(el); if (t.length < 6) return;
    const cs = getComputedStyle(el);
    const fg = num(cs.color); if (fg.length < 3) return;
    const alpha = fg.length > 3 ? fg[3] : 1;
    const bg = bgOf(el);
    const comp = [0,1,2].map(i => fg[i]*alpha + bg[i]*(1-alpha));
    const ratio = (Math.max(L(comp), L(bg)) + 0.05) / (Math.min(L(comp), L(bg)) + 0.05);
    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) contrast.push({ el: label(el), text: t, ratio: +ratio.toFixed(2), need, size: +size.toFixed(1) });
  });

  return JSON.stringify({ tiny, small, overlaps, zoomy, contrast });
})()`;

(async () => {
  const cdp = connect(await wsUrl());
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width: d.w, height: d.h, deviceScaleFactor: 1,
    mobile: d.mobile, screenWidth: d.w, screenHeight: d.h
  });
  await S('Emulation.setTouchEmulationEnabled', { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 1 });

  const all = {};
  for (const p of PAGES) {
    await S('Page.navigate', { url: BASE + p });
    await sleep(1300);
    await S('Runtime.evaluate', { expression: `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'));` });
    await sleep(400);
    const r = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true });
    all[p] = JSON.parse(r.result.value);
  }

  const uniq = (rows, keyFn) => {
    const seen = new Set(); const out = [];
    for (const r of rows) { const k = keyFn(r); if (seen.has(k)) continue; seen.add(k); out.push(r); }
    return out;
  };

  console.log(`\n=== ${DEVICE} (${d.w}x${d.h}) ===\n`);

  for (const [section, keyFn, fmt] of [
    ['Text under 12px', r => r.el + r.text, r => `${r.size}px  ${r.el}  "${r.text}"`],
    ['Tap targets under 44px', r => r.el + r.text, r => `${r.w}x${r.h}  ${r.el}  "${r.text}"`],
    ['Floating element covering a control', r => r.floating + r.covers + r.text, r => `${r.floating} covers ${r.covers} "${r.text}"`],
    ['Inputs under 16px (iOS zooms on focus)', r => r.el, r => `${r.size}px  ${r.el}`],
    ['Contrast below AA', r => r.el + r.text, r => `${r.ratio}:1 (needs ${r.need})  ${r.el}  "${r.text}"`]
  ]) {
    const field = { 'Text under 12px': 'tiny', 'Tap targets under 44px': 'small',
                    'Floating element covering a control': 'overlaps',
                    'Inputs under 16px (iOS zooms on focus)': 'zoomy',
                    'Contrast below AA': 'contrast' }[section];
    let printed = false;
    for (const [page, res] of Object.entries(all)) {
      const rows = uniq(res[field] || [], keyFn);
      if (!rows.length) continue;
      if (!printed) { console.log(section + ':'); printed = true; }
      console.log('  ' + page);
      rows.slice(0, 8).forEach(r => console.log('    ' + fmt(r)));
      if (rows.length > 8) console.log(`    …and ${rows.length - 8} more`);
    }
    if (printed) console.log('');
  }

  const totals = Object.values(all).reduce((a, r) => ({
    tiny: a.tiny + r.tiny.length, small: a.small + r.small.length,
    overlaps: a.overlaps + r.overlaps.length, zoomy: a.zoomy + r.zoomy.length,
    contrast: a.contrast + r.contrast.length
  }), { tiny: 0, small: 0, overlaps: 0, zoomy: 0, contrast: 0 });
  console.log('totals:', JSON.stringify(totals));

  cdp.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
