/* ==========================================================================
   WBA — walk the client's whole journey, for real, against the live project.

     node scripts/portal-e2e.mjs

   Creates a throwaway client, gives them a login, uploads a two-file site,
   signs in AS THEM, opens the preview, and then tries to open somebody
   else's. Cleans up after itself.

   It never sends an email. auth.admin.generateLink mints the same six-digit
   code the mailer would have posted, so the login can be tested end to end
   while SMTP is still being sorted — and so this can be re-run any time
   without filling an inbox.

   The last check is the one that matters: a signed-in client asking for
   another client's folder must be refused. If that ever passes, stop.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const REF = 'lynzhiyvggqyplssrapi';
const URL = `https://${REF}.supabase.co`;

/* The project keys used to come from a keys.json sitting in the repo. One of
   them is service_role, which bypasses every policy in the database, so the
   safest place for that file is nowhere. They are fetched at run time with
   the personal access token instead, held in memory, and never written down. */
function pat() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN.trim();
  for (const f of ['.env.supabase', '.env.supabase.txt']) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/SUPABASE_ACCESS_TOKEN\s*=\s*(\S+)/);
    if (m) return m[1].trim();
  }
  console.error('\nNo SUPABASE_ACCESS_TOKEN in .env.supabase(.txt).\n');
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/api-keys?reveal=true`,
  { headers: { Authorization: 'Bearer ' + pat() } });
if (!res.ok) {
  console.error('\nCould not read project API keys: ' + res.status + '\n');
  process.exit(1);
}
const rows = await res.json();
const keyOf = (n) => { const r = rows.find(k => k.name === n || k.type === n); return r && (r.api_key || r.key); };
const KEYS = { anon: keyOf('anon'), service_role: keyOf('service_role') };

const admin = createClient(URL, KEYS.service_role, { auth: { persistSession: false } });
const anon = createClient(URL, KEYS.anon, { auth: { persistSession: false } });

const HANDLE = 'e2etest';
const OTHER = 'e2eother';
const EMAIL = 'e2e-portal-test@westonbusinessauthority.co.uk';

let pass = 0, fail = 0;
let lastClient = null, lastUser = null;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };

async function main() {
  console.log('\n1. A client, the way you would add one');
  const { data: client, error: cErr } = await admin.from('clients')
    .insert([{ business: 'E2E Test Co', status: 'lead' }]).select('id').single();
  if (cErr) { no('create client: ' + cErr.message); return finish(); }
  lastClient = client.id;
  ok('client created');

  console.log('\n2. Their login');
  /* Same call portal-invite makes. */
  let userId;
  const { data: made, error: uErr } = await admin.auth.admin.createUser({
    email: EMAIL, email_confirm: true
  });
  if (uErr && !/already/i.test(uErr.message)) { no('create user: ' + uErr.message); return finish(client.id); }
  if (made?.user) userId = made.user.id;
  else {
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    userId = list.users.find(u => u.email === EMAIL)?.id;
  }
  if (!userId) { no('no user id'); return finish(client.id); }

  const { error: lErr } = await admin.from('client_users')
    .upsert({ user_id: userId, client_id: client.id, handle: HANDLE, display_name: 'E2E' },
            { onConflict: 'user_id' });
  if (lErr) { no('link user: ' + lErr.message); return finish(client.id); }
  lastUser = userId;
  ok('login created and linked to the client');

  console.log('\n3. A site, uploaded');
  const { data: proj, error: pErr } = await admin.from('projects')
    .insert([{ client_id: client.id, name: 'Website' }]).select('*').single();
  if (pErr) { no('create project: ' + pErr.message); return finish(client.id, userId); }

  const files = [
    ['index.html', '<!doctype html><meta charset="utf-8"><title>E2E</title>' +
                   '<link rel="stylesheet" href="style.css"><h1>Preview works</h1>' +
                   '<p><a href="about/">About</a></p>', 'text/html'],
    ['style.css', 'h1{color:#f5c416;font-family:system-ui}', 'text/css'],
    ['about/index.html', '<!doctype html><meta charset="utf-8"><h1>About page</h1>', 'text/html']
  ];
  for (const [name, body, type] of files) {
    const { error } = await admin.storage.from('previews')
      .upload(`${HANDLE}/v1/${name}`, new Blob([body], { type }), { upsert: true, contentType: type });
    if (error) { no('upload ' + name + ': ' + error.message); return finish(client.id, userId); }
  }
  await admin.from('projects').update({ preview_version: 1, preview_path: `${HANDLE}/v1` }).eq('id', proj.id);
  ok('3 files uploaded, version set to 1');

  /* Somebody else's site, so the last check has something to fail against. */
  await admin.storage.from('previews')
    .upload(`${OTHER}/v1/index.html`, new Blob(['<h1>Not yours</h1>'], { type: 'text/html' }),
            { upsert: true, contentType: 'text/html' });

  console.log('\n4. Signing in as them');
  /* generateLink returns the code the mailer would have sent. No email, same
     code path — verifyOtp cannot tell the difference. */
  const { data: link, error: gErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email: EMAIL
  });
  if (gErr) { no('generate code: ' + gErr.message); return finish(client.id, userId); }
  const otp = link?.properties?.email_otp;
  if (!otp) { no('no code came back'); return finish(client.id, userId); }
  ok('six-digit code minted: ' + otp.length + ' digits');
  if (otp.length !== 6) no('code is ' + otp.length + ' digits but the portal asks for 6');

  const { data: sess, error: vErr } = await anon.auth.verifyOtp({
    email: EMAIL, token: otp, type: 'email'
  });
  if (vErr || !sess?.session) { no('verify code: ' + (vErr?.message || 'no session')); return finish(client.id, userId); }
  ok('signed in, session issued');
  const token = sess.session.access_token;

  console.log('\n5. What the portal shows them');
  const asClient = createClient(URL, KEYS.anon, {
    auth: { persistSession: false },
    global: { headers: { Authorization: 'Bearer ' + token } }
  });
  const { data: site, error: sErr } = await asClient.rpc('my_site');
  if (sErr) { no('my_site: ' + sErr.message); return finish(client.id, userId); }
  if (site?.business === 'E2E Test Co') ok('their business name'); else no('business name: ' + JSON.stringify(site?.business));
  if (site?.handle === HANDLE) ok('their handle'); else no('handle: ' + JSON.stringify(site?.handle));
  if (site?.project?.version === 1) ok('version 1 showing'); else no('version: ' + JSON.stringify(site?.project));

  console.log('\n6. Opening the preview');
  /* Previews are no longer fetched over HTTP from a server, because there is
     no server: preview/sw.js serves them in the browser from signed URLs.
     That path is tested end to end by scripts/preview-e2e.mjs, which checks
     the two permissions this one cannot see from here — whether a client may
     LIST their folder and SIGN every file in it.

     What is still worth asserting HERE is that the files exist and that the
     version the portal will ask for is the version that was uploaded. */
  const { data: listed, error: lsErr } = await asClient.storage.from('previews')
    .list(`${HANDLE}/v1`, { limit: 100 });
  if (lsErr) no('the client cannot list their own preview: ' + lsErr.message);
  else if ((listed || []).some(f => f.name === 'index.html')) ok('their folder has an index.html in it');
  else no('no index.html in their folder — the preview would open on "not found"');

  console.log('\n7. The checks that matter');
  const { data: nosy } = await asClient.storage.from('previews').list(`${OTHER}/v1`, { limit: 100 });
  if (!nosy || !nosy.length) ok("another client's folder lists as empty");
  else no('LEAK: listed ' + nosy.length + " file(s) of another client — STOP");

  const { data: leak } = await anon.from('previews').select('*');
  if (!leak || !leak.length) ok('previews table refuses an anonymous read');
  else no('previews table leaked ' + leak.length + ' row(s)');

  const { data: other } = await asClient.from('clients').select('id');
  if (!other || other.length === 0) ok('a client cannot list clients');
  else no('client could read ' + other.length + ' client row(s)');

  await finish(client.id, userId);
}

async function finish(clientId, userId) {
  console.log('\n8. Cleaning up');
  try {
    for (const p of [`${HANDLE}/v1`, `${OTHER}/v1`]) {
      const { data } = await admin.storage.from('previews').list(p);
      if (data?.length) await admin.storage.from('previews').remove(data.map(f => `${p}/${f.name}`));
    }
    const { data: sub } = await admin.storage.from('previews').list(`${HANDLE}/v1/about`);
    if (sub?.length) await admin.storage.from('previews').remove(sub.map(f => `${HANDLE}/v1/about/${f.name}`));
    if (clientId) await admin.from('clients').delete().eq('id', clientId);
    if (userId) await admin.auth.admin.deleteUser(userId);
    console.log('  removed the test client, login and files');
  } catch (e) { console.log('  cleanup warning: ' + e.message); }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

/* Whatever happens — assertion failure, network drop, a thrown promise —
   the throwaway client, login and files must not survive this script. */
main().catch(async (e) => {
  console.log('  ERROR  ' + (e && e.message ? e.message : e));
  fail++;
  await finish(lastClient, lastUser);
});
