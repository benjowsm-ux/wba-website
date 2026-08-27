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
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const URL = 'https://lynzhiyvggqyplssrapi.supabase.co';
const KEYS = JSON.parse(readFileSync(process.argv[2] || 'keys.json', 'utf8'));
const admin = createClient(URL, KEYS.service_role, { auth: { persistSession: false } });
const anon = createClient(URL, KEYS.anon, { auth: { persistSession: false } });

const HANDLE = 'e2etest';
const OTHER = 'e2eother';
const EMAIL = 'e2e-portal-test@westonbusinessauthority.co.uk';

let pass = 0, fail = 0;
let lastClient = null, lastUser = null;
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
/* One retry, then give up gracefully rather than throwing. */
async function tryFetch(url, opts) {
  for (let i = 0; i < 2; i++) {
    try { return await fetch(url, opts); }
    catch (e) { if (i) console.log('        (network: ' + e.message + ')'); }
  }
  return null;
}
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
  /* The LIVE path a client actually uses: Netlify's function on our own
     domain. Testing the Supabase function instead is what let "serves HTML as
     text/plain" go unnoticed — it passed a test that never looked. */
  const base = (process.env.WBA_BASE || 'https://westonbusinessauthority.co.uk') + '/preview';
  const cookie = 'wba_pv=' + encodeURIComponent(token);

  const r1 = await tryFetch(`${base}/${HANDLE}/v1/`, { headers: { Cookie: cookie } });
  const b1 = r1 ? await r1.text() : '';
  if (r1 && r1.status === 200 && b1.includes('Preview works')) ok('index.html served');
  else no(`index.html: ${r1 ? r1.status : 'network'} ${b1.slice(0, 160)}`);
  const ct1 = r1 ? (r1.headers.get('content-type') || '') : '';
  if (ct1.includes('text/html')) ok('index.html served AS HTML'); else no('index.html content-type is "' + ct1 + '" — the browser will show source');

  const r2 = await tryFetch(`${base}/${HANDLE}/v1/style.css`, { headers: { Cookie: cookie } });
  if (r2 && r2.status === 200 && (r2.headers.get('content-type') || '').includes('css')) ok('stylesheet served with the right type');
  else no(`style.css: ${r2 ? r2.status : 'network'} ${r2 ? r2.headers.get('content-type') : ''}`);

  const r3 = await tryFetch(`${base}/${HANDLE}/v1/about/`, { headers: { Cookie: cookie } });
  const b3 = r3 ? await r3.text() : '';
  if (r3 && r3.status === 200 && b3.includes('About page')) ok('a folder link lands on its index');
  else no(`about/: ${r3 ? r3.status : 'network'} ${b3.slice(0, 120)}`);

  /* The error pages used to come back as text/plain and render as visible
     markup in the browser. A signed-in request for a file that is not there
     is the only way to see one, so it is checked here. */
  const r6 = await tryFetch(`${base}/${HANDLE}/v1/definitely-not-here.html`, { headers: { Cookie: cookie } });
  const ct6 = r6 ? (r6.headers.get('content-type') || '') : '';
  if (r6 && r6.status === 404 && ct6.includes('text/html')) ok('a missing page renders as HTML, not source');
  else no(`404 page: ${r6 ? r6.status : 'network'} content-type "${ct6}"`);

  console.log('\n7. The checks that matter');
  const r4 = await tryFetch(`${base}/${OTHER}/v1/`, { headers: { Cookie: cookie } });
  if (r4 && r4.status === 403) ok("another client's site is refused");
  else no(`another client's site returned ${r4 ? r4.status : 'network error'} — CHECK THIS`);

  /* Every network call from here on is wrapped. A dropped TLS handshake used
     to throw straight past the cleanup, leaving a test client, a test login
     and a bucket full of test files behind in the live project. A flaky
     connection is not a reason to litter. */
  /* redirect:'manual' or fetch follows the 302 to /portal/, gets a perfectly
     good 200 back, and the test concludes the preview was served to a
     signed-out stranger. It was not — but a test that cannot tell the
     difference is worse than no test. */
  const r5 = await tryFetch(`${base}/${HANDLE}/v1/`, { redirect: 'manual' });
  if (!r5) no('signed-out check: network failed, could not test');
  else if (r5.status === 302 || r5.status === 401) ok('no session, sent back to sign in (' + r5.status + ')');
  else no(`signed out returned ${r5.status}`);

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
