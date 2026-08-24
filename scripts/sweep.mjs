/* ==========================================================================
   WBA — the cheap sweep.

     node scripts/sweep.mjs [baseUrl]

   Loads every page at four widths and reports the three things that are
   invisible in a screenshot but obvious to a visitor:

     · console errors and failed requests
     · horizontal overflow, and which element causes it
     · missing pieces — no hero photo, no scrim, an unstamped stylesheet

   It is deliberately fast and dumb. audit.mjs handles type size, tap targets
   and contrast; this one answers "is anything actually broken".
   ========================================================================== */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = process.argv[2] || 'http://localhost:8093';

const PAGES = ['/', '/sites/', '/services/', '/about/', '/feed/',
               '/feed/back-of-house-app-harmony/', '/contact/',
               '/terms/', '/privacy/', '/free-website-terms/', '/404.html'];

const WIDTHS = [
  { w: 320,  h: 720,  mobile: true  },
  { w: 390,  h: 844,  mobile: true  },
  { w: 768,  h: 1024, mobile: true  },
  { w: 1440, h: 900,  mobile: false }
];

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
].find(p => p && existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(1); }

const port = 9500 + (Date.now() % 200);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'wba-sweep-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars'
], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error('Chrome did not open a debugging port.');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const waiting = new Map(); const handlers = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id); waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) handlers.forEach(h => h(m));
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
    waiting.set(msg.id, { resolve, reject }); ws.send(JSON.stringify(msg));
  });
  return { ready, send, on: h => handlers.push(h), close: () => ws.close() };
}

/* Runs in the page. Walks every element and returns the ones whose box
   extends past the document width — the actual cause of a sideways scroll,
   which is never the <body> the scrollbar appears on. */
const PROBE = `(() => {
  const dw = document.documentElement.clientWidth;
  const over = [];
  document.querySelectorAll('body *').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > dw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden' || cs.opacity === '0') return;
      over.push(el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : '') +
        ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
    }
  });
  const hero = document.querySelector('.hero, .page-hero');
  return {
    scrollW: document.documentElement.scrollWidth,
    clientW: dw,
    over: over.slice(0, 5),
    heroPhoto: !!(hero && hero.querySelector('.hero-media img')),
    heroScrim: !!(hero && hero.querySelector('.hero-scrim')),
    beacon: !!(hero && hero.querySelector('.beacon')),
    stamped: [...document.querySelectorAll('link[rel=stylesheet]')]
      .filter(l => (l.getAttribute('href') || '').charAt(0) === '/')
      .every(l => /\\?v=/.test(l.getAttribute('href'))),
    palette: !!document.querySelector('.nav-find')
  };
})()`;

(async () => {
  const cdp = connect(await wsUrl());
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable'); await S('Runtime.enable'); await S('Log.enable'); await S('Network.enable');

  let issues = [];
  let bucket = [];
  cdp.on(m => {
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      bucket.push('console: ' + m.params.args.map(a => a.value || a.description || '?').join(' '));
    if (m.method === 'Runtime.exceptionThrown')
      bucket.push('exception: ' + (m.params.exceptionDetails.exception || {}).description);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error')
      bucket.push('log: ' + m.params.entry.text);
    /* ERR_ABORTED is what a navigation looks like from the previous page's
       point of view — the sweep causes one on every hop and it means nothing.
       Anything else is a real failed request. */
    if (m.method === 'Network.loadingFailed' && m.params.errorText !== 'net::ERR_ABORTED')
      bucket.push('request failed: ' + m.params.errorText);
  });

  for (const d of WIDTHS) {
    await S('Emulation.setDeviceMetricsOverride', {
      width: d.w, height: d.h, deviceScaleFactor: 1, mobile: d.mobile
    });
    for (const path of PAGES) {
      bucket = [];
      await S('Page.navigate', { url: BASE + path });
      await sleep(1100);
      const r = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true });
      const v = r.result.value || {};
      const line = [];
      if (v.scrollW > v.clientW + 1) line.push('overflow ' + v.scrollW + ' > ' + v.clientW + ' :: ' + v.over.join(' | '));
      if (!v.heroPhoto)  line.push('no hero photo');
      if (!v.heroScrim)  line.push('no hero scrim');
      if (!v.beacon)     line.push('no beacon');
      if (!v.stamped)    line.push('stylesheet not stamped');
      if (!v.palette)    line.push('no palette button');
      bucket.forEach(b => line.push(b));
      if (line.length) {
        issues.push(d.w + 'px ' + path);
        line.forEach(l => issues.push('    ' + l));
      }
    }
  }

  if (issues.length) { console.log('ISSUES\n' + issues.join('\n')); }
  else console.log('Clean: ' + PAGES.length + ' pages x ' + WIDTHS.length + ' widths, nothing to report.');

  cdp.close(); chrome.kill(); process.exit(issues.length ? 1 : 0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
