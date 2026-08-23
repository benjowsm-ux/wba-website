-- ==========================================================================
-- WBA — schema additions for the new Feed.
-- Run this ONCE in Supabase -> SQL Editor before using the new admin panel.
--
-- It is written to be safe on a database that already has the old blog
-- tables: everything is IF NOT EXISTS, so re-running it changes nothing.
-- ==========================================================================

-- 1) Pin a post to its pillar's slot on the home page.
--    Only one post per pillar should have this set; the admin enforces it.
alter table public.posts
  add column if not exists featured boolean not null default false;

-- 2) Slugs must be unique — the Feed builds one folder per slug, and the
--    seed script relies on this for its ON CONFLICT clause.
create unique index if not exists posts_slug_key on public.posts (slug);

-- 3) Useful indexes for the queries the site actually runs.
create index if not exists posts_status_published_idx
  on public.posts (status, published_at desc);

create index if not exists posts_category_idx
  on public.posts (category);

-- ==========================================================================
-- Pillars
-- --------------------------------------------------------------------------
-- The `category` column now carries the pillar. The site understands three
-- values, lower case:
--
--   'build'   Websites, apps & tools, systems & integrations, automations
--   'create'  Branding, graphic design, print, media
--   'grow'    SEO, PPC, email marketing, reporting & analytics
--
-- Anything else (including an empty string) is treated as a plain note: it
-- still appears in the Feed under "Everything", but it is never picked up
-- as featured work on the home page.
--
-- If you have older posts using the previous free-text categories, this maps
-- the obvious ones across. Review before running — it is commented out on
-- purpose so nothing changes without you deciding it should.
-- ==========================================================================

-- update public.posts set category = 'build'  where category in ('tutorial', 'guide');
-- update public.posts set category = 'grow'   where category in ('news', 'update');
-- update public.posts set category = 'create' where category in ('review');
