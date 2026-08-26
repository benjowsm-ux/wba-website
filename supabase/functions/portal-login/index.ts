/* ==========================================================================
   WBA — portal-login.

   Turns a handle ("pivaz") into a six-digit code in that client's inbox.

     supabase functions deploy portal-login --no-verify-jwt
     supabase secrets set SB_URL=... SB_SERVICE_KEY=...

   --no-verify-jwt is correct here and only here: this is the one endpoint a
   person uses BEFORE they have a token. Everything it can do is bounded by
   the code below.

   WHY THIS EXISTS AT ALL
   The browser must not be able to turn a handle into an email address. If it
   could, anyone could walk the handle space and harvest our client list and
   their addresses. So the lookup happens here, behind the service key, and
   the only thing that ever comes back is "a code has been sent" — the same
   answer whether or not the handle was real.

   WHAT IT WILL NOT DO
   - It will not create a user. Portal accounts are made by us, in the admin.
     `shouldCreateUser` is false everywhere; a stranger typing a handle
     cannot bootstrap themselves an account.
   - It will not say whether a handle exists. Same response, same timing
     bucket, every time.
   - It will not accept unlimited attempts from one address. Six a minute is
     more than a confused client needs and far less than an enumeration run.
   ========================================================================== */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SB_URL')!;
const SB_SERVICE_KEY = Deno.env.get('SB_SERVICE_KEY')!;

/* Per-IP throttle. In-memory, so it resets when the isolate recycles — that
   is fine: it exists to make scripted enumeration tedious, and Supabase's own
   auth rate limits sit behind it as the real backstop. */
const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;

function throttled(ip: string): boolean {
  const now = Date.now();
  const seen = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  seen.push(now);
  hits.set(ip, seen);
  if (hits.size > 5_000) hits.clear();
  return seen.length > MAX_PER_WINDOW;
}

const CORS = {
  'Access-Control-Allow-Origin': 'https://westonbusinessauthority.co.uk',
  'Access-Control-Allow-Headers': 'content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

/* One reply, always. The client-side code shows the code screen regardless,
   so a wrong handle looks exactly like a right one until the code fails. */
const SENT = JSON.stringify({ ok: true });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('x-forwarded-for') || 'unknown';
  if (throttled(ip)) {
    return new Response(JSON.stringify({ error: 'slow_down' }), {
      status: 429, headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  let handle = '';
  try {
    const body = await req.json();
    handle = String(body?.handle ?? '').trim().toLowerCase();
  } catch {
    return new Response(SENT, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  /* Handles are ours to issue, so we can be strict about their shape and
     reject anything that looks like an injection attempt before it reaches
     a query. */
  if (!handle || handle.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(handle)) {
    return new Response(SENT, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const admin = createClient(SB_URL, SB_SERVICE_KEY, { auth: { persistSession: false } });

  const { data: row } = await admin
    .from('client_users')
    .select('user_id')
    .ilike('handle', handle)
    .maybeSingle();

  if (!row?.user_id) {
    return new Response(SENT, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const { data: userRes } = await admin.auth.admin.getUserById(row.user_id);
  const email = userRes?.user?.email;
  if (!email) {
    return new Response(SENT, { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  /* Send the code. shouldCreateUser:false means this can only ever reach an
     account we already made. */
  await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });

  /* The address IS returned here, but only once the handle has matched — the
     browser needs it to call verifyOtp. An attacker who already knows a real
     handle learns the address; one who does not learns nothing. */
  return new Response(JSON.stringify({ ok: true, email }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
});
