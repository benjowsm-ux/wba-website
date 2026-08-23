# Deploying

## How this site is actually hosted

Not GitHub Pages — **Netlify**, connected to `benjowsm-ux/wba-website`.

```
you push to main  →  Netlify sees the commit  →  site rebuilds  →  live
```

Verified: `westonbusinessauthority.co.uk` answers with `Server: Netlify`, and
`benjowsm-ux.github.io/wba-website` returns 404, so Pages isn't even switched on.

Two consequences worth knowing:

- **There is no `CNAME` file and there shouldn't be.** That's a GitHub Pages
  convention; Netlify holds the domain in its own dashboard and ignores the file.
- **`google969e9bae2b563155.html` must stay in the repo.** It's the Google Search
  Console verification file. Delete it and Search Console silently unverifies.
  It's carried over.

---

## The fast way — one command

A commit replacing the whole site is already staged and committed in
`Desktop\Claude Stuff\_wba-deploy`. It clones the live repo, removes every old
file, and adds the new one. All that's left is to send it:

```bash
cd "C:\Users\Benjamin\Desktop\Claude Stuff\_wba-deploy" && git push
```

Git Credential Manager is installed, so the first push opens a browser window to
sign in to GitHub. Netlify picks the commit up within a minute or two.

That commit removes, in the same change: `about.html`, `services.html`,
`contact.html`, `privacy.html`, `terms.html`, `free-website-terms.html`,
`free-websites.html`, `post.html`, `admin.html`, `pricing.html`, `work.html`,
`weston.html`, `submit.html`, `news.html`, `news.json`, `serve.json`,
`scripts/build-blog.mjs`, and replaces `.github/workflows/blog.yml` with
`feed.yml`.

**Why not the web uploader:** it adds and overwrites but never deletes, so all
nineteen of those old files would stay live and indexed, and `blog.yml` would keep
running alongside `feed.yml` — two schedulers committing to `main` every thirty
minutes, fighting each other.

### If you'd rather look before you leap

```bash
cd "C:\Users\Benjamin\Desktop\Claude Stuff\_wba-deploy"
git show --stat HEAD
```

To abandon it entirely, just delete that folder. Nothing has left your machine
until you push.

---

## Before or straight after the push

**Run `supabase/rls.sql`** in Supabase → SQL Editor. This is not optional: without
it the contact forms and analytics silently fail to write and the admin Inbox
stays empty. Formspree still emails you, so you won't lose leads — but you'll have
no record in the database.

Then, in order:

1. `supabase/schema.sql` — adds the `featured` column and indexes
2. `supabase/rls.sql` — the security policies
3. `supabase/seed-posts.sql` — optional, the seven placeholder posts
4. `supabase/storage.sql` — the media bucket behind Admin → Photos
5. `supabase/page-content.sql` — the table behind Edit mode
6. **GitHub → Actions → Build feed → Run workflow** — regenerates `/feed/` from
   the database. Until it runs, the Feed shows the placeholder build.

---

## Checking it worked

Click through Home, Sites, Services, About, Feed, Contact. The address bar should
read `/sites/`, `/about/` — no `.html` anywhere.

Then confirm the security, from any terminal. First two must fail, third must
succeed:

```bash
curl -s "https://lynzhiyvggqyplssrapi.supabase.co/rest/v1/clients?select=*" -H "apikey: sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K"
```

Expect `[]` — a stranger who finds the repo cannot read your client list.

```bash
curl -s -X POST "https://lynzhiyvggqyplssrapi.supabase.co/rest/v1/admins" -H "apikey: sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K" -H "Content-Type: application/json" -d "{\"user_id\":\"00000000-0000-0000-0000-000000000000\"}"
```

Expect `401 … violates row-level security policy`.

```bash
curl -s "https://lynzhiyvggqyplssrapi.supabase.co/rest/v1/posts?status=eq.published&select=slug" -H "apikey: sb_publishable_j_RkzVTMyM-QtmFnLsf_Vw_ulanlx9K"
```

Expect your published posts — the Feed build depends on this working.

Finally, send yourself a test enquiry through the site and check it appears in
**Admin → Inbox**. If it doesn't, `rls.sql` didn't run.

---

## netlify.toml

New file, headers only — security headers plus long cache lifetimes on
`/photos/`, `/css/` and `/js/`. Deliberately **no `[build]` block**, because your
publish directory is already set in the Netlify dashboard and a build block here
would override it.

There's a ready-made Content-Security-Policy in there, commented out, with every
origin this site actually uses. Switch it on when you have ten minutes to click
through the pages with the console open — a wrong CSP fails silently.

---

## Rolling back

```bash
cd "C:\Users\Benjamin\Desktop\Claude Stuff\_wba-deploy"
git revert HEAD && git push
```

Netlify also keeps every previous deploy — **Deploys → pick the last good one →
Publish deploy** restores the old site in seconds without touching git at all.
That's the fastest undo if something looks wrong.

The old site is also intact locally at `Desktop\Claude Stuff\WBA-Site\`.

---

## The Photos tab (added after launch)

**Admin → Photos.** Drag photos in, or click to pick them. They land in the
Supabase `media` bucket and appear in the grid, newest first. Each one gives you
three buttons:

- **Cover** — sets it as the cover image of whatever post is open in the Feed tab
- **Copy URL** — puts the public URL on your clipboard, to paste into an image block
- **Delete** — removes it from storage permanently

### It resizes before uploading

A photo off a phone or a camera is routinely 4000–6000px wide and 6–12MB.
Uploading that as-is would make it the slowest thing on the page. So the browser
resizes every image to a **1920px longest edge** and re-encodes it as WebP at
quality 0.82 before a single byte reaches Supabase. Measured on a 4032×3024
test image: **9.6× smaller**, in under half a second, with no visible difference
at screen sizes.

Portrait shots keep their orientation (EXIF is applied on decode, so nothing
uploads sideways) and their aspect ratio. SVGs pass through untouched.

### One-time setup

Run **`supabase/storage.sql`** in the SQL Editor. It creates the `media` bucket
and locks writes to admins — reads stay public, because a visitor's browser
fetches these images with no session at all. Run `supabase/rls.sql` first; the
storage policies call `public.is_admin()`.

If uploads fail with *"violates row level security"*, your account is missing a
row in `public.admins`.

---

## The logo is now served from this repo

It used to load from Cloudinary on every page. It's now `img/wba-logo.png` and
`img/wba-icon.png`, with explicit `width`/`height` so the header can't reflow
while it loads. Nothing external is fetched any more except Google Fonts (and
jsdelivr on the admin page).

Don't delete `img/` — every page references it.


---

## Edit mode

Sign in at `/admin/`, then open any page: a bar appears at the bottom letting you
click into the copy and change it. Full write-up in
[docs/EDIT-MODE.md](docs/EDIT-MODE.md).

Two things to know:

- **Saved is not live.** An edit is stored instantly and baked into the static
  HTML by the next build — every 5 minutes, or press **Publish now** in
  **Admin → Pages**. The bar shows a count of what is waiting.
- **Run `supabase/page-content.sql`** or nothing saves.

## Admin → Checks

One click, and it tells you exactly what is and is not wired up — signed in,
recognised as an admin, can read posts, can save posts, edit storage, photo
storage — by making each request for real and printing the SQL for whatever is
missing. Start there whenever something "doesn't work".

It also catches a trap worth knowing about: when row-level security refuses an
UPDATE, PostgREST returns **200 with an empty array, not an error**. Code that
only checks for an error reports "Saved" while nothing changed. Every write now
verifies that a row actually came back.
