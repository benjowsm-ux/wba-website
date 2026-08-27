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
const ok = (m) => { console.log('  PASS  ' + m); pass++; };
const no = (m) => { console.log('  FAIL  ' + m); fail++; };

async function main() {
  console.log('\n1. A client, the way you would add one');
  const { data: client, error: cErr } = await admin.from('clients')
    .insert([{ business: 'E2E Test Co', status: 'lead' }]).select('id').single();
  if (cErr) { no('create client: ' + cErr.message); return finish(); }
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
  const base = URL + '/functions/v1/preview';
  const cookie = 'wba_pv=' + encodeURIComponent(token);

  const r1 = await fetch(`${base}/${HANDLE}/v1/`, { headers: { Cookie: cookie } });
  const b1 = await r1.text();
  if (r1.status === 200 && b1.includes('Preview works')) ok('index.html served');
  else no(`index.html: ${r1.status} ${b1.slice(0, 160)}`);

  const r2 = await fetch(`${base}/${HANDLE}/v1/style.css`, { headers: { Cookie: cookie } });
  if (r2.status === 200 && (r2.headers.get('content-type') || '').includes('css')) ok('stylesheet served with the right type');
  else no(`style.css: ${r2.status} ${r2.headers.get('content-type')}`);

  const r3 = await fetch(`${base}/${HANDLE}/v1/about/`, { headers: { Cookie: cookie } });
  const b3 = await r3.text();
  if (r3.status === 200 && b3.includes('About page')) ok('a folder link lands on its index');
  else no(`about/: ${r3.status} ${b3.slice(0, 120)}`);

  console.log('\n7. The checks that matter');
  const r4 = await fetch(`${base}/${OTHER}/v1/`, { headers: { Cookie: cookie } });
  if (r4.status === 403) ok("another client's site is refused");
  else no(`another client's site returned ${r4.status} — THIS IS A LEAK`);

  const r5 = await fetch(`${base}/${HANDLE}/v1/`);
  if (r5.status === 401) ok('no session, no preview');
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

main();
