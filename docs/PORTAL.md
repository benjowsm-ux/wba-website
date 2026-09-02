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
| Supabase Storage (preview files) | 1 GB · 5 GB egress/month | ~20 site previews. Moving to Cloudflare R2 (10 GB, zero egress) is a bucket copy and one line in `js/preview-open.js`. |
| Serving those previews | — | Nothing. It runs in the client's browser, so there is no per-request cost and nothing to cap. |
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
   - **Username: the literal word `resend`.** Not your email, not the API
     key, not the key's name. This is the single most common cause of
     "Not authenticated" — SMTP auth fails and every other setting looks fine.
   - **Password: a Resend API key**, the long string starting `re_`. Create it
     under Resend → API Keys with **Sending access**; a key scoped to
     read-only will authenticate and then refuse to send.
   - Sender: `portal@westonbusinessauthority.co.uk`, name `WBA`
   - The sender domain must be **Verified** in Resend first. A domain still
     showing "Pending" is rejected even with perfect credentials.
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

### 4. Previews (nothing to do)

There is no step here any more, and that is the fix rather than a shortcut.

Previews used to need a server, and every server we tried failed:

| Attempt | What happened |
|---|---|
| Supabase Storage direct | Returns `index.html` as `text/plain`. Not a setting — it rewrites the type. Every page rendered as visible source. |
| Supabase Edge Function | Proxied the file; Supabase rewrote the header again. |
| Netlify Edge Function | Would have worked. Never deployed — the account ran out of credits first. |

So previews are now served **in the browser** by `preview/sw.js`, a service
worker. The portal lists the client's folder, asks Supabase for a signed URL
for every file in it, and stores that map; the worker intercepts `/preview/*`
and serves each file with a `Content-Type` **it** chooses, from the file
extension.

That last part is the whole trick. Storage can call `index.html` whatever it
likes — the header the browser sees is written on our side, so the failure
that killed all three previous attempts cannot recur.

Consequences worth knowing:

- **No hosting cost and no deploy budget.** It is two static files.
- **No rewriting of the client's HTML.** The URLs are real, so relative links,
  stylesheets, scripts and images resolve on their own. The site behaves
  exactly as it will on its own domain.
- **Signed URLs last eight hours.** After that the worker says so plainly and
  the client opens it again from the portal.
- **Permission is not the worker's to give.** It holds no key. The listing and
  the signing both run as whoever is signed in, under the same policies as
  everything else.

> **The one trade.** Previews are served from the main origin, so a preview's
> scripts share it with the portal. These are sites we built, so that is
> first-party code — but it is a real trade. When
> `preview.westonbusinessauthority.co.uk` exists, `preview/sw.js` moves there
> unchanged and the trade goes away.

To put a build in front of a client: **Admin → Portal**, pick the client, drop
the folder on the upload box. Each upload becomes a new version, and the
client keeps seeing the old one until the new one is completely in place.

Test the whole path without touching a browser:

```bash
node scripts/preview-e2e.mjs
```

It creates a throwaway client, uploads a site with a real image, signs in as
them, lists and signs every file, checks the bytes come back byte-identical,
confirms another client's folder is refused, and cleans up after itself.

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
