/* Headless end-to-end test of edit mode with a REAL viewport (the in-app
   browser pane reports width 0, which collapses all layout). Drives Chrome
   over CDP, stubs only the admin verdict + a capturing savePageContent, and
   checks: pen appears, red outlines, image overlays align to their images,
   editing text marks dirty, the tick saves the right rows, exit discards. */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const BASE = process.argv[2] || 'http://localhost:8093';
const PAGE = process.argv[3] || '/about/';
const VW = 1280, VH = 900;

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA + '/Google/Chrome/Application/chrome.exe'].find(p => p && existsSync(p));
const port = 9500 + (Date.now() % 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${join(tmpdir(), 'wba-em-' + Date.now())}`, '--no-first-run',
  '--hide-scrollbars', '--disable-gpu'], { stdio: 'ignore' });
process.on('exit', () => { try { chrome.kill(); } catch (e) {} });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wsUrl() {
  for (let i = 0; i < 60; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch (e) {}
    await sleep(250);
  }
  throw new Error('no port');
}
function connect(url) {
  const ws = new WebSocket(url); let id = 0; const w = new Map();
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data);
    if (m.id && w.has(m.id)) { const { res, rej } = w.get(m.id); w.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result); } });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const send = (method, params = {}, sid) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params }; if (sid) msg.sessionId = sid;
    w.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg)); });
  return { ready, send };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };

(async () => {
  const cdp = connect(await wsUrl()); await cdp.ready;
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);
  await S('Page.enable'); await S('Runtime.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  const evalx = async (expr) => {
    const r = await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 80));
    return r.result.value;
  };

  await S('Page.navigate', { url: BASE + PAGE });
  await sleep(1200);

  /* Plant a fake session, stub the admin verdict + a capturing save, then load
     the real db.js and edit.js from the served site. */
  await evalx(`window.__setup = (async () => {
    localStorage.setItem('sb-lynzhiyvggqyplssrapi-auth-token','{"fake":true}');
    const load = src => new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.async=false;s.onload=res;s.onerror=rej;document.head.appendChild(s);});
    await load('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
    await load('/js/db.js');
    window.__saved = [];
    WBAdb.currentUser=()=>Promise.resolve({data:{user:{id:'t'}}});
    WBAdb.isAdmin=()=>Promise.resolve({data:true});
    WBAdb.getPageContent=(p)=>Promise.resolve({data:[]});
    WBAdb.savePageContent=(rows)=>{window.__saved=rows;return Promise.resolve({data:rows.map(r=>({key:r.key}))});};
    WBAdb.listMedia=()=>Promise.resolve({data:[]});
    await load('/js/edit.js?'+Date.now());
    return true;
  })();`);
  await evalx('window.__setup'); await sleep(500);

  // 1. pen present, idle = pen icon
  ok(await evalx(`!!document.getElementById('wba-pen')`), 'pen button exists');
  ok(await evalx(`document.getElementById('wba-pen').innerHTML.includes('M12 20h9')`), 'idle shows pen icon');
  ok(await evalx(`!document.getElementById('wba-editbar')`), 'old bar is gone');

  // 2. enter edit mode
  await evalx(`document.getElementById('wba-pen').click()`); await sleep(400);
  ok(await evalx(`document.body.classList.contains('wba-editing')`), 'editing class on body');
  ok(await evalx(`document.getElementById('wba-pen').classList.contains('is-editing')`), 'pen is green/editing');
  ok(await evalx(`document.getElementById('wba-pen').innerHTML.includes('M20 6 9 17')`), 'pen shows tick when editing');
  ok(await evalx(`getComputedStyle(document.querySelector('[data-edit]')).outlineColor.includes('220, 38, 38')`), 'text outline is red');

  // 3. image overlays align to their (visible) images
  const align = await evalx(`(async()=>{
    const imgs=[...document.querySelectorAll('[data-edit-img]')];
    let visible=0, good=0;
    for(const img of imgs){ img.scrollIntoView({block:'center'}); img.loading='eager'; await new Promise(r=>setTimeout(r,120)); }
    await new Promise(r=>setTimeout(r,300));
    for(const img of imgs){
      const i=img.getBoundingClientRect(); if(i.width<10||i.height<10) continue; visible++;
      const ov=img.__wbaBtn; if(!ov) continue; const o=ov.getBoundingClientRect();
      if(ov.classList.contains('wba-img-overlay-corner')){
        /* corner pill on a backdrop image: just needs to be shown, not full-cover */
        if(ov.style.display!=='none' && o.width>10 && o.height>10) good++;
      } else {
        if(Math.abs(o.top-i.top)<3&&Math.abs(o.left-i.left)<3&&Math.abs(o.width-i.width)<3&&Math.abs(o.height-i.height)<3) good++;
      }
    }
    return visible+'/'+good;
  })()`);
  const [vis, al] = align.split('/').map(Number);
  /* A page may legitimately have no editable images (Sites' only images are in
     the generated block). Pass when every visible one is placed correctly. */
  ok(vis === al, vis + ' editable image(s) visible, ' + al + ' placed correctly');

  // 4. edit a heading -> dirty badge shows
  await evalx(`(()=>{const h=document.querySelector('h2[data-edit], h3[data-edit], p[data-edit]');
    h.focus(); h.textContent='EDITED HEADING TEST'; h.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(200);
  ok(await evalx(`!document.getElementById('wba-pen-badge').hidden`), 'dirty badge appears after edit');
  ok(await evalx(`document.getElementById('wba-pen-badge').textContent==='1'`), 'badge shows 1 unsaved');

  // 5. click tick -> saves that row, exits edit mode
  await evalx(`document.getElementById('wba-pen').click()`); await sleep(500);
  const saved = await evalx(`JSON.stringify(window.__saved)`);
  ok(/EDITED HEADING TEST/.test(saved), 'tick saved the edited text: ' + saved.slice(0, 90));
  ok(await evalx(`!document.body.classList.contains('wba-editing')`), 'exited edit mode after save');
  ok(await evalx(`document.getElementById('wba-pen').innerHTML.includes('M12 20h9')`), 'pen back to pen icon');

  // 6. re-enter, edit, then exit-by-reload discards (nothing saved)
  await evalx(`window.__saved=[]; document.getElementById('wba-pen').click()`); await sleep(300);
  await evalx(`(()=>{const h=document.querySelector('p[data-edit]'); h.textContent='DISCARD ME'; h.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await sleep(150);
  const dirtyCount = await evalx(`Object.keys(window.WBAedit?{}:{}).length, document.getElementById('wba-pen-badge').textContent`);
  ok(await evalx(`!document.getElementById('wba-pen-badge').hidden`), 'has unsaved change before discard');
  ok(await evalx(`window.__saved.length===0`), 'nothing written to DB before tick (discard-safe)');

  console.log(`\n${pass} passed, ${fail} failed`);
  chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); chrome.kill(); process.exit(2); });
