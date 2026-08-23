# Edit mode

Change the words on any page by clicking them, the way you would in WordPress —
without WordPress. The site stays static HTML on a CDN.

This is written to be lifted into the next site as-is. Nothing in it is specific
to WBA except the Supabase project URL and the list of pages.

---

## Using it

1. Sign in at `/admin/`.
2. Go to any page on the site. A dark bar appears at the bottom: **Edit mode**.
3. Press **Start editing**. Every editable piece of copy gets a dashed blue
   outline.
4. Click one, type, press **Save** (or `Ctrl`/`Cmd + S`).
5. The bar then says *"N awaiting publish"*, and the changed text is outlined in
   orange with a small **awaiting publish** tag.

That last state is the one worth understanding.

### Saved is not the same as live

An edit is written to the database the moment you press Save. It reaches
visitors when the site is next built — within five minutes, or immediately if
you press **Publish now** in **Admin → Pages**, which opens the build and lets
you run it.

That gap is deliberate, and it is the whole trick:

```
you type          ->  page_content row saved      (instant)
build runs        ->  the words are written INTO the .html file
visitor arrives   ->  plain static HTML, no database, no JavaScript
```

A conventional CMS asks the database on every page view. This asks it never. The
database is the edit log; the HTML is what ships. Visitors get a file off a CDN,
search engines see the final text in the source, and there is no flash of the old
copy while JavaScript catches up.

The cost is those few minutes. It is a real cost and the bar says so rather than
pretending otherwise.

---

## What you can and cannot change

**Can:** headings, paragraphs, list items, the nav and footer wording.

**Cannot:** images, links' destinations, buttons, prices in the pricing card,
layout, or anything with its own styling inside it.

That second list is on purpose. An element whose children carry classes — a
button, a gold `accent` span, an icon — is left alone, because editing it would
flatten the styling that makes it work. `scripts/annotate.py` decides this
automatically and prints what it skipped and why.

The nav and footer are shared. Editing the footer on one page changes it on all
of them, because those rows are stored against the page `*`.

---

## Security

The short version: **the editor is not the boundary. Row-level security is.**

Deleting the toolbar's `hidden` attribute, or calling `save()` from the console,
gets an anonymous visitor a 401 from Postgres. There is nothing to bypass in the
UI because the UI was never what was stopping anyone.

| Layer | What it does |
|---|---|
| `js/edit-boot.js` | Loads the editor only if a session token exists. A *performance* gate — not authorisation. |
| `js/edit.js` | Asks the server `is_admin()` before showing anything. |
| `page_content` RLS | Public read, `is_admin()` write. This is the real boundary. |
| `is_admin()` | `SECURITY DEFINER` with a pinned `search_path`, so the client cannot vote itself in. |

### Untrusted input, sanitised twice

`contenteditable` will accept anything pasted into it, so nothing typed is
trusted. Rich fields are run through a small allow-list — `b`, `strong`, `i`,
`em`, `a[href]`, `br`, `span`, plus `class="accent"` and nothing else — **once in
the browser on save, and again in the build on output.**

Twice, because they are different trust boundaries. The browser pass protects
against a careless paste from Word. The build pass protects against anything that
reached the table by another route: a stolen admin token, a direct REST call, a
future bug in the editor. Sanitising in one place only is how stored XSS gets in.

`scripts/test-page-content.mjs` holds 73 cases for that allow-list — script tags,
event handlers, `javascript:` and `data:` URLs, quote-escape attempts inside an
`href`, mis-nested tags, unclosed tags, double-escaped entities. The build runs
them before it will publish anything.

```bash
node scripts/test-page-content.mjs
```

### One thing that surprised us

When row-level security refuses an `UPDATE`, PostgREST does **not** return an
error. The policy matches no rows, so you get `HTTP 200` and `[]`.

```
PATCH /posts?id=eq.<id>   ->   200   []   and the row is untouched
```

Any code checking only `if (error)` therefore reports **"Saved"** while nothing
whatsoever has changed. Every write in `js/db.js` now ends in `.select()`, and
`wbaWroteNothing()` is what tells "saved" apart from "silently refused".

---

## Adding editable copy to a page

Mark it in the HTML:

```html
<h1 data-edit="hero.h1">We'll build your site. Free.</h1>
<p  data-edit="intro.body" data-edit-kind="rich">Some <strong>prose</strong>.</p>
<h4 data-edit="footer.h4" data-edit-scope="shared">Site</h4>
```

| Attribute | Meaning |
|---|---|
| `data-edit` | The key. Unique per page. Stable — renaming it orphans the saved edit. |
| `data-edit-kind` | `rich` keeps inline formatting. Omit for plain text. |
| `data-edit-scope` | `shared` stores it once for every page (nav, footer). |

Or let the script work them out:

```bash
python scripts/annotate.py list  sites/index.html
python scripts/annotate.py apply sites/index.html
```

`list` shows every candidate, the key it would get, and what it skipped.
`apply` writes the attributes in. It is safe to re-run — it will not duplicate
attributes, and it repairs a missing `scope`.

**Never annotate generated markup.** Anything between `<!-- WBA:…:START -->` and
`<!-- WBA:…:END -->`, or anywhere under `/feed/`, is rewritten by the build; an
override there would be wiped on the next run. The script already skips those.

---

## Setup on a new site

1. Run `supabase/rls.sql` (defines `is_admin()`).
2. Run `supabase/page-content.sql`.
3. Copy `js/edit.js`, `js/edit-boot.js`, `scripts/lib/page-content.mjs`,
   `scripts/annotate.py`, `scripts/test-page-content.mjs`, and CSS section 18.
4. Add `<script src="/js/edit-boot.js" defer></script>` to every page.
5. Call `bakePageContent()` at the end of the build.
6. Annotate the pages.

**Admin → Checks** verifies every one of those in one click, as you, right now —
and prints the exact SQL for whatever is missing.

---

## Cost to a visitor

`edit-boot.js` is 2.2 KB, cached for a year, and returns immediately when there
is no session. Supabase, `db.js` and `edit.js` are fetched **only** for someone
already signed in.

A reader of the site downloads 2.2 KB and runs about ten lines of JavaScript.
That was the point of not using a CMS.
