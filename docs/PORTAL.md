# The client portal

Clients sign in at `/portal/` and see their project, their preview, their
invoices and the accounts their site depends on. You put all of it there from
**Admin → Portal**.

Nothing in here is live until you do the steps below. They take about half an
hour, and about ten minutes of that is waiting for DNS.

---

## What it costs

**£0 today**, and the first thing you should pay for is backups, not capacity.

| Piece | Free tier | What actually breaks it |
|---|---|---|
| Supabase (database, auth) | 500 MB DB · 50,000 monthly users | Nothing at your scale. The 7-day pause never fires because the Feed workflow pings it every 5 minutes. |
| Cloudflare R2 (preview files) | 10 GB · **zero egress, ever** | ~200 site previews. |
| Cloudflare Workers (serving) | 100,000 requests/day | Not you. |
| Resend (the login emails) | 3,000/month · 100/day | Not you. |

The first real bill is **Supabase Pro, $25/month**, and the reason to pay it is
daily backups. A portal holding client invoices with no backups is a bad look
for a company that sells reliability. Everything is built so that upgrade is a
billing toggle, not a migration.

---

## Why the login works the way it does

You asked for a username and a four-digit code. You got the username. You did
not get four digits, and here is the reason in one line: **four digits is ten
thousand possibilities and a script tries all of them in under a minute.** A
fixed code is also permanent — it only has to leak once, and you would never
know it had.

So: the client types their handle (`pivaz`), we email a **six-digit code that
expires in ten minutes and works once**, they type it in. Same two steps they
imagined. Afterwards the session lasts long enough that most clients never see
a second code.

The nice side effect is that **there is no password anywhere in this system.**
Not stored, not hashed, not emailed, not chosen. There is nothing to steal,
nothing to reuse on another site, and nothing for a client to write on a note
by the till.

---

## Why there is no password field for *their* accounts

`project_accounts` records that an account exists — what it is for, the
address, the username, and who holds the secret. It does not, and will not,
store the secret.

An agency holding its clients' passwords is the single most valuable target
connected to all of them, with none of a real vault's protections: no
rotation, no per-secret audit trail, no SOC 2, no breach playbook. If we were
ever read, every client is compromised at once and it is our fault in writing.

**What to do instead:** a shared vault. [Bitwarden](https://bitwarden.com) is
free for two people and has proper organisation sharing; 1Password Teams is
about £16/month if you want audit logs. Put the secret there, paste the vault
item link into the "vault link" box, and the client gets a **Password** button
that takes them to it.

This is also the answer you give clients when they ask how to handle their own
passwords — which is the point. We should not tell them to do something we do
not do.

---

## Setup, in order

### 1. The database (5 minutes)

Supabase → SQL Editor → paste `supabase/portal.sql` → Run.

Safe to re-run; everything is `if not exists`.

### 2. Email that actually sends (10 minutes)

**This one is not optional.** Supabase's built-in mailer allows **two auth
emails per hour** across the whole project. Your third client of the morning
would simply not receive a code.

1. Sign up at [resend.com](https://resend.com) — free, 3,000/month.
2. Add `westonbusinessauthority.co.uk` and put the DNS records they give you
   into Cloudflare. (This also improves deliverability for the contact form.)
3. Supabase → Authentication → Emails → SMTP Settings:
   - Host `smtp.resend.com`, Port `587`
   - User `resend`, Password: your Resend API key
   - Sender: `portal@westonbusinessauthority.co.uk`, name `WBA`
4. Authentication → Rate Limits → raise "emails per hour" to something sane
   like 60.

Then send yourself a code from `/portal/` and check it arrives.

### 3. The two functions (5 minutes)

```bash
npx supabase login
npx supabase link --project-ref lynzhiyvggqyplssrapi
npx supabase secrets set SB_URL=https://lynzhiyvggqyplssrapi.supabase.co
npx supabase secrets set SB_SERVICE_KEY=<service_role key from Settings → API>
npx supabase functions deploy portal-login --no-verify-jwt
npx supabase functions deploy portal-invite
```

`--no-verify-jwt` is correct on `portal-login` **only** — it is the one
endpoint someone uses before they have a token. `portal-invite` verifies the
caller is a signed-in admin, twice: once by the platform and once against the
`admins` table.

> The **service_role key is not the publishable key.** It bypasses row-level
> security entirely. It goes in Supabase secrets and nowhere else — never in
> `js/`, never in the repo, never in a browser.

### 4. Previews on Cloudflare R2 (15 minutes)

```bash
npx wrangler login
npx wrangler r2 bucket create wba-previews
cd cloudflare
npx wrangler secret put SUPABASE_URL        # https://lynzhiyvggqyplssrapi.supabase.co
npx wrangler secret put SUPABASE_ANON_KEY   # the publishable key
npx wrangler deploy
```

Then add a DNS record for `preview.westonbusinessauthority.co.uk` pointing at
the worker (Cloudflare → Workers → Triggers → Custom Domains).

**Previews live on their own hostname on purpose.** A preview is a page we are
still working on; if it were served from the main domain it could read the
portal's storage, including the client's session token. A separate origin
makes that impossible rather than unlikely.

To put a build in front of a client:

```bash
npx wrangler r2 object put wba-previews/pivaz/v3 --file=./dist --recursive
```

…then in **Admin → Portal**, post an update of kind `preview`. (A drag-and-drop
uploader in the admin is the next job; the CLI works today.)

### 5. Make yourself a test client (2 minutes)

Admin → Clients → add one. Admin → Portal → pick it → **Who can sign in** →
your own email, handle `test`. Sign out, go to `/portal/`, sign in as `test`,
and look at what a client sees.

---

## Checking it is actually private

Run this after setup. The first two must fail and the third must succeed.

```bash
curl -s "https://lynzhiyvggqyplssrapi.supabase.co/rest/v1/invoices?select=*" -H "apikey: sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K"
```

Signed out, that returns `[]` — no rows, because there is no policy granting
anonymous reads on any portal table. `scripts/pentest.mjs` covers the same
ground automatically and should be extended as tables are added.

The real test is two clients: sign in as one, and confirm `my_portal()`
returns only their rows. It cannot do otherwise — the function takes no
arguments, so there is no id to tamper with — but check anyway.

---

## Tools this consolidates

Before: Netlify, Supabase, GitHub, Formspree, jsDelivr.
After the steps above: Netlify, Supabase, GitHub, **Cloudflare**, Resend.

That is one more, not one fewer — but it buys client logins, private previews
and reliable email. The genuine cleanups available next, in order of value:

1. **Drop Formspree.** Submissions already go to Supabase; Resend is now set
   up. One Edge Function on insert replaces it, and the contact form stops
   depending on a third party's free tier.
2. **Self-host `supabase-js`** instead of pulling it from jsDelivr. Removes a
   third-party script from the admin and portal, and makes a strict
   Content-Security-Policy possible.
3. **Consider moving hosting to Cloudflare Pages** once previews have proved
   themselves. That collapses Netlify into an account you already have. Not
   before — there is no reason to disturb something that works.
