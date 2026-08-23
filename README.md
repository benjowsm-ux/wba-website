# WBA — Design & Tech Agency

The rebuilt site. `WBA-Site` (the old one) is untouched — this is a separate,
self-contained folder.

---

## The shape of it

**Nav:** Home · Sites · Services · About · Feed

URLs are extensionless. Every page is a folder containing `index.html`, so the
address bar reads `/sites/` rather than `/sites.html`. That works on any static
host, GitHub Pages included, with no configuration.

| URL | File | What it does |
|---|---|---|
| `/` | `index.html` | Free-sites hero → intro → three pillars → contact |
| `/sites/` | `sites/index.html` | The free site offer, in full |
| `/services/` | `services/index.html` | Build / Create / Grow, one section each |
| `/about/` | `about/index.html` | Position and locality |
| `/feed/` | `feed/index.html` | Every post, filterable by pillar — **generated** |
| `/feed/<slug>/` | `feed/<slug>/index.html` | One page per post — **generated** |
| `/contact/` | `contact/index.html` | Enquiry form |
| `/admin/` | `admin/index.html` | Write the Feed, read the inbox, track clients |

Legal: `/privacy/`, `/terms/`, `/free-website-terms/`. Plus `/post/` — the
preview and fallback viewer, which readers don't normally land on.

Three things must stay at the repo root: `index.html`, `404.html` (GitHub Pages
only looks for it there) and `CNAME` (the custom domain — deleting it breaks
westonbusinessauthority.co.uk).

`/blog.html` and `/blog/` are redirect stubs to `/feed/`, so any link already
out in the world still works.

---

## Deploying

See **`DEPLOY.md`**. Read the first section before uploading — a GitHub web-UI
upload never deletes, so the old site's pages survive unless you remove them by
hand.


## Pillars

Everything hangs off three words. A post's **pillar** is stored in the `category`
column and must be one of `build`, `create`, `grow` — or empty, for a plain note.

| Pillar | Promise | Covers |
|---|---|---|
| Build | Tech that powers your business | Websites · Apps & tools · Systems & integrations · Automations |
| Create | The identity your audience remembers | Branding · Graphic design · Print · Media |
| Grow | Unrestrained growth | SEO · PPC · Email marketing · Reporting & analytics |

The pillar decides where a post shows up: the Feed filters, the "in the Feed"
row on the matching Services section, and the featured slot on the home page.

**Featured work.** Each pillar gets one card on the home page. It's the post with
`featured` ticked, or the newest in that pillar if none is ticked. The admin tells
you which post currently holds each slot, and ticking the box takes it over.

---

## First-time setup

Run once, in Supabase → SQL Editor:

1. **`supabase/schema.sql`** — adds the `featured` column, a unique index on
   `slug`, and a couple of query indexes. Safe to re-run.
2. **`supabase/rls.sql`** — the security policies. **Not optional:** without it
   the contact forms and analytics silently fail to write and the admin Inbox
   stays empty. Read the comment at the top of the file.
3. **`supabase/seed-posts.sql`** — the seven placeholder posts. Safe to re-run:
   it matches on slug and updates rather than duplicating.

The placeholders each open with a line saying they're placeholders. Rewrite them
in the admin, or delete them — the last line of `seed-posts.sql` has the
`delete` statement ready to copy.

---

## Building the Feed

`scripts/build-feed.mjs` reads published posts and writes:

- `feed/<slug>/` — one real page per post
- `feed.html` and `feed/` — the index
- `sitemap.xml`
- `blog.html`, `blog/` — redirect stubs
- the featured image on each pillar card in `index.html`
- the pillar post rows inside `services/index.html`
- the related-reading row in `sites/index.html`

The last three are written **between HTML comment markers**
(`<!-- WBA:PILLARMEDIA:BUILD:START -->`, `<!-- WBA:PILLAR:BUILD:START -->`,
`<!-- WBA:EXPLORE:START -->`). Leave the markers alone; edit anything outside
them freely. Re-running is idempotent.

It **fails soft**: if Supabase can't be reached it leaves every page as-is and
exits 0, so a network blip never blanks the site or turns the run red.

```bash
npm install --no-save marked@12
node scripts/build-feed.mjs
```

GitHub Actions runs this every 30 minutes (`.github/workflows/feed.yml`), and you
can force it from the repo's **Actions → Build feed → Run workflow**.

### Testing without touching the database

```bash
WBA_POSTS_FILE=scripts/seed-posts.json node scripts/build-feed.mjs
```

Builds the whole site from `scripts/seed-posts.json` — no network, no database.
That JSON is also the source for the seed SQL; after editing it run:

```bash
node scripts/make-seed-sql.mjs
```

which regenerates `supabase/seed-posts.sql` so the two can't drift apart.

---

## Running it locally

```bash
npx -y http-server . -p 8093 -c-1 --ext html
```

Port matters: Chrome blocks a handful of ports outright (5060 is one — it's the
SIP port), and a blocked port looks exactly like a dead server. 8093 is fine.

---

## Writing a post

In the admin: title, slug (auto-filled from the title until you edit it), a short
summary, a pillar, a cover image, tags. Then stack the body from blocks —
header, text, image, image & text, section, button, link. Each block can take a
background and padding via the ◧ button.

**Preview** opens the draft in a new tab without saving. **Save** writes to the
database immediately; the public pages catch up on the next build.

Three starter layouts are in the "Start from a layout" dropdown: guide,
project write-up, short note. They're skeletons — headings and prompts, no copy.

---

## Files

```
css/styles.css        The whole design system. Tokens at the top.
CNAME                 The custom domain. Deleting it breaks the domain.
js/main.js            Reveal, nav, FAQ, forms, Feed search/filter, post widgets
js/blocks.js          Block renderer (browser) + starter layouts
js/db.js              Supabase client and data helpers
js/analytics.js       First-party, cookieless, no third party
js/consent.js         Gate for third-party tools. Nothing configured = no banner.
scripts/build-feed.mjs   The generator. Contains a Node port of the block renderer —
                         if you add a block type, add it in both files.
photos/               Town photography and client work
```

---

## Things worth knowing

- **The site is not a marketing agency.** No social media management, no Meta
  ads, no reviews carousel, no client logo wall. That was deliberate — don't let
  it creep back in.
- **`js/analytics.js` is cookieless** and needs no consent banner. `consent.js`
  only exists to gate a third-party tool if one is ever added; with nothing
  configured it renders nothing, which is correct rather than broken.
- **Images:** give every `<img>` `width`/`height` attributes that match the real
  file. The base stylesheet sets `height:auto` so a wrong attribute can't
  override a component's aspect ratio, but wrong numbers still cost you the
  layout-shift protection the attributes are there for.
