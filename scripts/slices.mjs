/* ==========================================================================
   WBA — viewport-sized screenshot slices.

     node scripts/slices.mjs <outDir> <path> [device] [baseUrl]

   A full-page capture of a 6000px page has to be scaled down so far that you
   cannot judge spacing or type. This scrolls the page one screen at a time and
   captures each screen at its real size, which is what you actually look at on
   a phone anyway.
   ========================================================================== */

import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const OUT    = process.argv[2] || 'slices';
const PATH   = process.argv[3] || '/';
const DEVICE = process.argv[4] || 'iphone-390';
const BASE   = process.argv[5] || 'http://localhost:8093';

const DEVICES = {
  'iphone-390':   { w: 390,  h: 844,  mobile: true },
  'android-360':  { w: 360,  h: 800,  mobile: true },
  'small-320':    { w: 320,  h: 720,  mobile: true },
  'tablet-768':   { w: 768,  h: 1024, mobile: true },
  'desktop-1440': { w: 1440, h: 900,  mobile: false }
};
const d = DEVICES[DEVICE];
if (!d) { console.error('Unknown device: ' + DEVICE); process.exit(1); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
].find(p => p && existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(1); }

const port = 9800 + (Date.now() % 400);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'wba-slice-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--disable-gpu', '--disable-extensions'
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
  throw new Error('Chrome did not open a debugging port.');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
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

(async () => {
  mkdirSync(OUT, { recursive: true });
  const cdp = connect(await wsUrl());
  await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  await S('Page.enable');
  await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', {
    width: d.w, height: d.h, deviceScaleFactor: 1,
    mobile: d.mobile, screenWidth: d.w, screenHeight: d.h
  });
  await S('Emulation.setTouchEmulationEnabled', { enabled: d.mobile, maxTouchPoints: d.mobile ? 5 : 1 });

  await S('Page.navigate', { url: BASE + PATH });
  await sleep(1500);
  await S('Runtime.evaluate', {
    expression: `document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in'));
                 document.querySelectorAll('img[loading=lazy]').forEach(i=>i.loading='eager');`
  });
  await sleep(900);

  const hRes = await S('Runtime.evaluate', {
    expression: 'document.documentElement.scrollHeight', returnByValue: true
  });
  const total = hRes.result.value;
  const slug = PATH.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
  const screens = Math.min(Math.ceil(total / d.h), 14);

  for (let i = 0; i < screens; i++) {
    const y = i * d.h;
    await S('Runtime.evaluate', { expression: `window.scrollTo(0, ${y});` });
    await sleep(450);
    const shot = await S('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
    writeFileSync(join(OUT, `${DEVICE}--${slug}--${String(i + 1).padStart(2, '0')}.jpg`),
                  Buffer.from(shot.data, 'base64'));
  }

  console.log(`${screens} slice(s) of ${PATH} at ${DEVICE} (page is ${total}px tall)`);
  cdp.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
