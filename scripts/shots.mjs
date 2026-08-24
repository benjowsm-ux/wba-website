/* ==========================================================================
   WBA — full-page screenshots at real device sizes.

     node scripts/shots.mjs [outDir] [baseUrl]

   Drives the installed Chrome over the DevTools Protocol. No dependencies:
   the protocol is just a WebSocket, and Node has one built in.

   Why not a headless window at 375px wide: without device emulation Chrome
   ignores the viewport meta tag, so the page lays out as a narrow desktop and
   every mobile screenshot looks broken when the real thing is fine. This sets
   deviceScaleFactor and mobile:true through Emulation.setDeviceMetricsOverride,
   which is what an actual phone reports.
   ========================================================================== */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const OUT  = process.argv[2] || 'shots';
const BASE = process.argv[3] || 'http://localhost:8093';

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
].find(p => p && existsSync(p));

if (!CHROME) { console.error('No Chrome found.'); process.exit(1); }

/* iPhone 12/13/14 and a small Android, plus tablet and desktop. */
const DEVICES = [
  { name: 'iphone-390', w: 390, h: 844, dsf: 3, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'android-360', w: 360, h: 800, dsf: 3, mobile: true,
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  { name: 'small-320',   w: 320, h: 720, dsf: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
  { name: 'tablet-768',  w: 768, h: 1024, dsf: 2, mobile: true,
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
  { name: 'desktop-1440', w: 1440, h: 900, dsf: 1, mobile: false, ua: null }
];

const PAGES = [
  ['home',     '/'],
  ['sites',    '/sites/'],
  ['services', '/services/'],
  ['about',    '/about/'],
  ['feed',     '/feed/'],
  ['post',     '/feed/back-of-house-app-harmony/'],
  ['contact',  '/contact/'],
  ['admin',    '/admin/']
];

const port = 9222 + (Date.now() % 500);
const profile = join(tmpdir(), 'wba-shots-' + Date.now());

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=1',
  '--disable-gpu', '--disable-extensions'
], { stdio: 'ignore' });

process.on('exit', () => { try { chrome.kill(); } catch (e) {} });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch (e) { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not open a debugging port.');
}

/* Minimal CDP client. */
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const events = [];

  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const msg = { id: ++id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      waiting.set(msg.id, { resolve, reject });
      ws.send(JSON.stringify(msg));
    });
  }

  return { ready, send, events, close: () => ws.close() };
}

const results = [];

(async () => {
  mkdirSync(OUT, { recursive: true });
  const cdp = connect(await wsUrl());
  await cdp.ready;

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Console.enable');

  for (const d of DEVICES) {
    for (const [label, path] of PAGES) {
      await S('Emulation.setDeviceMetricsOverride', {
        width: d.w, height: d.h, deviceScaleFactor: 1,
        mobile: d.mobile, screenWidth: d.w, screenHeight: d.h
      });
      if (d.ua) await S('Emulation.setUserAgentOverride', { userAgent: d.ua });
      await S('Emulation.setTouchEmulationEnabled', { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 1 });

      await S('Page.navigate', { url: BASE + path });
      await sleep(1400);

      /* Reveal animations are IntersectionObserver-driven; a full-page capture
         would otherwise show everything below the fold still faded out. */
      await S('Runtime.evaluate', {
        expression: `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'));
                     document.querySelectorAll('img[loading=lazy]').forEach(i=>i.loading='eager');`
      });
      await sleep(700);

      const metrics = await S('Runtime.evaluate', {
        expression: `JSON.stringify({
          scrollW: document.documentElement.scrollWidth,
          clientW: document.documentElement.clientWidth,
          scrollH: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          offenders: [...document.querySelectorAll('*')]
            .filter(e => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
            .slice(0,4)
            .map(e => e.tagName + '.' + (typeof e.className === 'string' ? e.className.split(' ')[0] : '')),
          tinyText: [...document.querySelectorAll('p,li,a,span,div')]
            .filter(e => e.childElementCount === 0 && e.textContent.trim().length > 12)
            .map(e => parseFloat(getComputedStyle(e).fontSize))
            .filter(s => s && s < 12).length,
          smallTargets: [...document.querySelectorAll('a,button,input,select,[role=button]')]
            .filter(e => { const r = e.getBoundingClientRect();
                           return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); })
            .length
        })`, returnByValue: true
      });
      const m = JSON.parse(metrics.result.value);
      results.push({ device: d.name, page: label, ...m });

      const shot = await S('Page.captureScreenshot', {
        format: 'jpeg', quality: 72, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: d.w, height: Math.min(m.scrollH, 9000), scale: 1 }
      });
      writeFileSync(join(OUT, `${d.name}--${label}.jpg`), Buffer.from(shot.data, 'base64'));
      process.stdout.write(`${d.name}/${label} ${m.overflow ? 'OVERFLOW ' : ''}`);
    }
    process.stdout.write('\n');
  }

  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(results, null, 1));

  const bad = results.filter(r => r.overflow);
  console.log(`\n${results.length} captures in ${OUT}/`);
  console.log(bad.length ? 'HORIZONTAL OVERFLOW:\n' + bad.map(b =>
    `  ${b.device} ${b.page}: +${b.scrollW - b.clientW}px  ${b.offenders.join(', ')}`).join('\n')
    : 'No horizontal overflow anywhere.');

  const tiny = results.filter(r => r.tinyText > 0);
  if (tiny.length) console.log('Text under 12px:\n' + tiny.map(t => `  ${t.device} ${t.page}: ${t.tinyText}`).join('\n'));

  const taps = results.filter(r => r.device.startsWith('iphone') || r.device.startsWith('android') || r.device.startsWith('small'));
  const smallTap = taps.filter(t => t.smallTargets > 0);
  if (smallTap.length) console.log('Tap targets under 32px:\n' + smallTap.map(t => `  ${t.device} ${t.page}: ${t.smallTargets}`).join('\n'));

  cdp.close();
  chrome.kill();
  process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
