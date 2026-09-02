/* ==========================================================================
   WBA - can a client actually open their own preview, and only their own?

     node scripts/preview-e2e.mjs

   The browser half of previews (preview/sw.js) is tested by opening one. This
   tests the half a browser cannot: whether row-level security lets a
   signed-in client LIST their folder and SIGN every file in it, which is
   exactly what js/preview-open.js does on their behalf.

   That distinction matters. A client having read access to an object is not
   the same permission as being allowed to mint a signed URL for it, and
   "should be fine" is the reasoning that produced three broken previews.

   It creates a throwaway client, uploads a small site WITH AN IMAGE, signs in
   as them for real, and then tries the same thing against somebody else's
   folder. It cleans up after itself whatever happens, including a crash.

   No email is sent: auth.admin.generateLink mints the same six-digit code the
   mailer would have posted.

   CREDENTIALS
   Only the personal access token already in .env.supabase(.txt). The project
   API keys are fetched from the Management API at run time and held in memory
   - nothing new is written to disk.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const REF = 'lynzhiyvggqyplssrapi';
const URL_ = `https://${REF}.supabase.co`;

const HANDLE = 'pve2e';
const OTHER = 'pveother';
const EMAIL = 'preview-e2e@westonbusinessauthority.co.uk';

let pass = 0, fail = 0;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };

/* ------------------------------------------------------------------ token */
function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  for (const f of ['.env.supabase', '.env.supabase.txt']) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/SUPABASE_ACCESS_TOKEN\s*=\s*(\S+)/);
    if (m) return m[1].trim();
  }
  console.error('\nNo SUPABASE_ACCESS_TOKEN in .env.supabase(.txt).\n');
  process.exit(1);
}

async function keys() {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`, {
    headers: { Authorization: 'Bearer ' + token() }
  });
  if (!r.ok) {
    console.error('\nCould not read the project API keys: ' + r.status + ' ' +
                  (await r.text()).slice(0, 200) + '\n');
    process.exit(1);
  }
  const rows = await r.json();
  const find = (n) => {
    const row = rows.find((k) => k.name === n || k.type === n);
    return row && (row.api_key || row.key || row.secret);
  };
  const anon = find('anon'), service = find('service_role');
  if (!anon || !service) { console.error('\nUnexpected API-key response shape.\n'); process.exit(1); }
  return { anon, service };
}

/* --------------------------------------------------------- the same walk
   Deliberately a copy of the logic in js/preview-open.js rather than a call
   into it: the point is to prove that walking a folder this way returns what
   the portal expects, so it has to walk it the same way. If one changes and
   the other does not, this test is what says so. */
async function walk(sb, base, sub = '', out = []) {
  const path = sub ? `${base}/${sub}` : base;
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await sb.storage.from('previews')
      .list(path, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    const rows = data || [];
    for (const row of rows) {
      if (!row?.name || row.name === '.emptyFolderPlaceholder') continue;
      const rel = sub ? `${sub}/${row.name}` : row.name;
      if (row.id === null || row.id === undefined) await walk(sb, base, rel, out);
      else out.push(rel);
    }
    if (rows.length < 100) break;
  }
  return out;
}

/* A 1x1 PNG. Small, but genuinely binary - which is the point, because the
   thing that has failed before is a file that is not text. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const FILES = [
  ['index.html', '<!doctype html><meta charset="utf-8"><title>E2E</title>' +
                 '<link rel="stylesheet" href="style.css"><h1>Preview works</h1>' +
                 '<img src="img/logo.png" alt=""><a href="about/">About</a>', 'text/html'],
  ['style.css', 'h1{color:#f5c416}', 'text/css'],
  ['img/logo.png', PNG, 'image/png'],
  ['about/index.html', '<!doctype html><meta charset="utf-8"><h1>About</h1>', 'text/html']
];

let admin, clientId = null, userId = null;

async function main() {
  const k = await keys();
  admin = createClient(URL_, k.service, { auth: { persistSession: false } });
  const anon = createClient(URL_, k.anon, { auth: { persistSession: false } });

  console.log('\n1. A client with a login and a site');
  const { data: client, error: cErr } = await admin.from('clients')
    .insert([{ business: 'Preview E2E Co', status: 'lead' }]).select('id').single();
  if (cErr) { no('create client: ' + cErr.message); return finish(); }
  clientId = client.id;

  const { data: made, error: uErr } = await admin.auth.admin.createUser({
    email: EMAIL, email_confirm: true
  });
  if (uErr && !/already/i.test(uErr.message)) { no('create user: ' + uErr.message); return finish(); }
  if (made?.user) userId = made.user.id;
  else {
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    userId = list.users.find((u) => u.email === EMAIL)?.id;
  }
  if (!userId) { no('no user id'); return finish(); }

  const { error: lErr } = await admin.from('client_users')
    .upsert({ user_id: userId, client_id: clientId, handle: HANDLE, display_name: 'E2E' },
            { onConflict: 'user_id' });
  if (lErr) { no('link login: ' + lErr.message); return finish(); }
  ok('client, login and link created');

  for (const [name, body, type] of FILES) {
    const payload = Buffer.isBuffer(body) ? body : new Blob([body], { type });
    const { error } = await admin.storage.from('previews')
      .upload(`${HANDLE}/v1/${name}`, payload, { upsert: true, contentType: type });
    if (error) { no('upload ' + name + ': ' + error.message); return finish(); }
  }
  /* Somebody else's site, so the refusal check has something to fail against. */
  await admin.storage.from('previews').upload(
    `${OTHER}/v1/index.html`, new Blob(['<h1>Not yours</h1>'], { type: 'text/html' }),
    { upsert: true, contentType: 'text/html' });
  ok(FILES.length + ' files uploaded, including a binary image');

  console.log('\n2. Signing in as them');
  const { data: link, error: gErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email: EMAIL
  });
  if (gErr) { no('generate code: ' + gErr.message); return finish(); }
  const otp = link?.properties?.email_otp;
  if (!otp) { no('no code came back'); return finish(); }

  const { data: sess, error: vErr } = await anon.auth.verifyOtp({
    email: EMAIL, token: otp, type: 'email'
  });
  if (vErr || !sess?.session) { no('verify: ' + (vErr?.message || 'no session')); return finish(); }
  ok('signed in with a six-digit code');

  const as = createClient(URL_, k.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: 'Bearer ' + sess.session.access_token } }
  });

  console.log('\n3. What js/preview-open.js does, as the client');
  let rels;
  try { rels = await walk(as, `${HANDLE}/v1`); }
  catch (e) { no('the client cannot list their own folder: ' + e.message); return finish(); }

  const want = FILES.map((f) => f[0]).sort().join(', ');
  const got = rels.slice().sort().join(', ');
  if (got === want) ok('walked the folder: ' + got);
  else no('folder walk returned "' + got + '", expected "' + want + '"');

  /* The permission this whole design rests on. A client is allowed to READ
     their objects; being allowed to SIGN them is a separate question, and
     if the answer were no, every preview would be blank. */
  const full = rels.map((r) => `${HANDLE}/v1/${r}`);
  const { data: signed, error: sErr } = await as.storage.from('previews')
    .createSignedUrls(full, 3600);
  if (sErr) { no('the client cannot sign their own files: ' + sErr.message); return finish(); }

  const urls = {};
  (signed || []).forEach((row, i) => {
    const u = row && (row.signedUrl || row.signedURL || row.signed_url);
    if (u && !row.error) urls[rels[i]] = u.startsWith('/') ? URL_ + u : u;
  });
  if (Object.keys(urls).length === rels.length) ok('every file signed (' + rels.length + ')');
  else no('signed ' + Object.keys(urls).length + ' of ' + rels.length +
          ' - preview-open.js reads .signedUrl; check the response shape');

  console.log('\n4. Do the signed URLs actually return the bytes?');
  for (const rel of rels) {
    if (!urls[rel]) continue;
    const r = await fetch(urls[rel]);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!r.ok) { no(rel + ': HTTP ' + r.status); continue; }
    if (rel.endsWith('.png')) {
      /* Byte-for-byte, because a truncated or re-encoded image is the kind of
         failure that still renders "something" and passes a lazier check. */
      if (buf.equals(PNG)) ok(rel + ': ' + buf.length + ' bytes, identical to what went up');
      else no(rel + ': image came back altered (' + buf.length + ' bytes)');
    } else if (buf.length > 0) {
      ok(rel + ': ' + buf.length + ' bytes');
    } else no(rel + ': empty');
  }

  /* Storage's own Content-Type is wrong on purpose here - it is WHY the
     service worker sets its own. Recording it keeps the reason visible. */
  const probe = await fetch(urls['index.html']);
  console.log('        (storage calls index.html "' + probe.headers.get('content-type') +
              '" - the worker overrides this)');

  console.log('\n5. The check that matters');
  let leaked = null;
  try { leaked = await walk(as, `${OTHER}/v1`); } catch { leaked = []; }
  if (!leaked.length) ok("another client's folder lists as empty");
  else no("LEAK: listed " + leaked.length + " file(s) of another client - STOP");

  const { data: badSign } = await as.storage.from('previews')
    .createSignedUrls([`${OTHER}/v1/index.html`], 60);
  const bad = (badSign || []).find((r) => r && (r.signedUrl || r.signedURL) && !r.error);
  if (!bad) ok("another client's file cannot be signed");
  else no("LEAK: signed another client's file - STOP");

  await finish();
}

async function finish() {
  console.log('\n6. Cleaning up');
  try {
    for (const p of [`${HANDLE}/v1`, `${HANDLE}/v1/img`, `${HANDLE}/v1/about`, `${OTHER}/v1`]) {
      const { data } = await admin.storage.from('previews').list(p);
      const names = (data || []).filter((f) => f.id).map((f) => `${p}/${f.name}`);
      if (names.length) await admin.storage.from('previews').remove(names);
    }
    if (clientId) await admin.from('clients').delete().eq('id', clientId);
    if (userId) await admin.auth.admin.deleteUser(userId);
    console.log('  removed the test client, login and files');
  } catch (e) { console.log('  cleanup warning: ' + e.message); }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/* Whatever happens, the throwaway client does not survive this script. */
main().catch(async (e) => {
  no('ERROR ' + (e && e.message ? e.message : e));
  await finish();
});
