/* ==========================================================================
   WBA — screenshot a page in a particular STATE.

     node scripts/state-shot.mjs <outFile.jpg> <path> "<js to run first>" [device] [baseUrl]

   slices.mjs captures a page as it loads. Plenty of what we build only exists
   after an interaction — the command palette, an open menu, a hovered card,
   the pointer light on the hero — and none of it can be judged without a
   picture of it. This loads the page, runs one expression, waits, and shoots
   the viewport.

   Device names match slices.mjs.
   ========================================================================== */
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';

const OUT    = process.argv[2] || 'state.jpg';
const PATH   = process.argv[3] || '/';
const RUN    = process.argv[4] || '';
const DEVICE = process.argv[5] || 'desktop-1440';
const BASE   = process.argv[6] || 'http://localhost:8093';

const DEVICES = {
  'iphone-390':   { w: 390,  h: 844,  mobile: true },
  'android-360':  { w: 360,  h: 800,  mobile: true },
  'small-320':    { w: 320,  h: 720,  mobile: true },
  'tablet-768':   { w: 768,  h: 1024, mobile: true },
  'desktop-1440': { w: 1440, h: 900,  mobile: false },
  'desktop-1280': { w: 1280, h: 820,  mobile: false }
};
const d = DEVICES[DEVICE];
if (!d) { console.error('Unknown device: ' + DEVICE); process.exit(1); }

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'
].find(p => p && existsSync(p));
if (!CHROME) { console.error('No Chrome found.'); process.exit(1); }

const port = 9300 + (Date.now() % 400);
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'wba-state-' + Date.now())}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--disable-extensions'
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
  mkdirSync(dirname(OUT), { recursive: true });
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
  await sleep(1600);

  /* html{scroll-behavior:smooth} turns any scrollTo in RUN into an animation
     that is still running when the screenshot fires — which produces a
     picture of nothing and half an hour looking for a bug that is not there. */
  await S('Runtime.evaluate', { expression: "document.documentElement.style.scrollBehavior='auto'" });

  if (RUN) {
    const r = await S('Runtime.evaluate', { expression: RUN, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) console.warn('! ' + (r.exceptionDetails.exception || {}).description);
    else if (r.result && r.result.value !== undefined) console.log('→ ' + JSON.stringify(r.result.value));
  }
  await sleep(900);

  const shot = await S('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('Wrote ' + OUT);

  cdp.close(); chrome.kill(); process.exit(0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });
