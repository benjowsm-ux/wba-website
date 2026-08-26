/* ==========================================================================
   WBA — portal-invite.  Admin-only. Creates a client's portal login.

     supabase functions deploy portal-invite
     supabase secrets set SB_URL=... SB_SERVICE_KEY=...

   Note there is NO --no-verify-jwt here. This endpoint must only ever be
   reachable by a signed-in admin, so the platform checks the token before
   our code runs, and then we check that the token belongs to an ADMIN —
   because "has a valid token" is true of every client too.

   WHAT IT DOES
   Creates the auth user with a confirmed email and no password, links it to
   a client, and stores the handle. No password is generated, mailed or
   stored: the account is reached with an emailed six-digit code and nothing
   else, so there is no credential in existence for anyone to lose.
   ========================================================================== */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SB_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': 'https://westonbusinessauthority.co.uk',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);

  const auth = req.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return json({ error: 'unauthorised' }, 401);
  const token = auth.slice(7);

  const admin = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } });

  /* Who is asking? */
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return json({ error: 'unauthorised' }, 401);

  /* Are they an admin? Asked of the database, not of the token — a claim in
     a JWT is whatever the issuer put there, and we do not put roles in ours. */
  const { data: isAdmin } = await admin
    .from('admins').select('user_id').eq('user_id', who.user.id).maybeSingle();
  if (!isAdmin) return json({ error: 'forbidden' }, 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return json({ error: 'bad body' }, 400); }

  const email = String(body.email || '').trim().toLowerCase();
  const handle = String(body.handle || '').trim().toLowerCase();
  const clientId = String(body.client_id || '').trim();
  const displayName = String(body.display_name || '').trim() || null;

  if (!email.includes('@')) return json({ error: 'That email does not look right.' }, 400);
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(handle)) {
    return json({ error: 'Handles are lower case letters, numbers, dot, dash, underscore.' }, 400);
  }
  if (!/^[0-9a-f-]{36}$/.test(clientId)) return json({ error: 'Pick a client.' }, 400);

  /* Reuse the auth user if this address already has one — a client with two
     projects should not end up with two logins. */
  let userId: string | null = null;
  const { data: existing } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const found = existing?.users?.find((u) => u.email?.toLowerCase() === email);

  if (found) {
    userId = found.id;
  } else {
    const { data: made, error: makeErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,     /* we vouch for it; they prove it with the code */
      user_metadata: { handle, display_name: displayName }
    });
    if (makeErr || !made?.user) return json({ error: makeErr?.message || 'Could not create that user.' }, 400);
    userId = made.user.id;
  }

  const { error: linkErr } = await admin.from('client_users').upsert({
    user_id: userId,
    client_id: clientId,
    handle,
    display_name: displayName
  }, { onConflict: 'user_id' });

  if (linkErr) {
    /* The most likely one by far, and worth saying plainly. */
    const dupe = /duplicate|unique/i.test(linkErr.message);
    return json({ error: dupe ? 'That handle is already taken.' : linkErr.message }, 400);
  }

  return json({ ok: true, handle });
});
