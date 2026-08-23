-- ==========================================================================
-- WBA — Row Level Security.
--
-- READ THIS FIRST
-- ---------------
-- The repo is public and so is the key in js/db.js. That is by design: the
-- `sb_publishable_...` key is an identifier, not a password. It says "I am an
-- anonymous visitor", nothing more. Anyone who finds the repo has that key.
--
-- So the ONLY thing standing between a stranger and your data is this file.
-- Hiding admin.html would achieve nothing — the browser talks to the REST API
-- directly, and so can anyone with curl.
--
-- The rule below is deliberately tight: the anonymous role may
--   * read published posts (that's the Feed)
--   * insert an enquiry
--   * insert an analytics event
--   * register a helpful vote
-- and nothing else. It cannot read enquiries, cannot read clients, cannot
-- write a post, and cannot make itself an admin.
--
-- Run this once in Supabase -> SQL Editor. It is idempotent.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 0.  RLS on, everywhere. A table without RLS is fully open to the anon key.
-- --------------------------------------------------------------------------
alter table public.posts       enable row level security;
alter table public.submissions enable row level security;
alter table public.clients     enable row level security;
alter table public.settings    enable row level security;
alter table public.events      enable row level security;
alter table public.admins      enable row level security;

-- Belt and braces: force RLS even for the table owner.
alter table public.clients     force row level security;
alter table public.submissions force row level security;

-- --------------------------------------------------------------------------
-- 1.  Who is an admin?
--     SECURITY DEFINER so the check itself can read `admins` while the anon
--     role cannot. search_path is pinned — without that, a hostile search_path
--     could point `admins` at a different table.
-- --------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.admins a where a.user_id = auth.uid()
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- --------------------------------------------------------------------------
-- 2.  posts
--     Public: published rows only. Drafts stay invisible.
--     Admin:  everything.
-- --------------------------------------------------------------------------
drop policy if exists posts_public_read on public.posts;
create policy posts_public_read on public.posts
  for select to anon, authenticated
  using (status = 'published');

drop policy if exists posts_admin_all on public.posts;
create policy posts_admin_all on public.posts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 3.  submissions  (enquiries, suggest-an-update, report-an-issue)
--     Public: INSERT only. No select — these contain names, emails and phone
--     numbers, and a public select policy here would be a data breach.
--     The WITH CHECK stops anyone posting a row that is already "approved".
-- --------------------------------------------------------------------------
drop policy if exists submissions_public_insert on public.submissions;
create policy submissions_public_insert on public.submissions
  for insert to anon, authenticated
  with check (
    coalesce(status, 'pending') = 'pending'
    and coalesce(type, 'enquiry') in ('enquiry', 'article_update', 'article_report', 'suggestion')
    and length(coalesce(description, '')) <= 5000
    and length(coalesce(title, ''))       <= 300
  );

drop policy if exists submissions_admin_all on public.submissions;
create policy submissions_admin_all on public.submissions
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Only let the anonymous role set the columns the forms actually use, so a
-- crafted request can't populate reviewer fields or anything added later.
revoke insert on public.submissions from anon;
grant insert (type, title, description, submitter_name, submitter_email, location, image_url)
  on public.submissions to anon;

-- --------------------------------------------------------------------------
-- 4.  events  (first-party analytics)
--     Public: INSERT only, so nobody can mine the traffic log.
-- --------------------------------------------------------------------------
drop policy if exists events_public_insert on public.events;
create policy events_public_insert on public.events
  for insert to anon, authenticated
  with check (
    length(coalesce(name, '')) <= 60
    and length(coalesce(path, '')) <= 300
    and length(coalesce(label, '')) <= 200
  );

drop policy if exists events_admin_read on public.events;
create policy events_admin_read on public.events
  for select to authenticated
  using (public.is_admin());

-- --------------------------------------------------------------------------
-- 5.  clients, settings  — admin only, no public access of any kind.
--     `clients` is the most sensitive table you have: names, emails, phone
--     numbers, domains and fees.
-- --------------------------------------------------------------------------
drop policy if exists clients_admin_all on public.clients;
create policy clients_admin_all on public.clients
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists settings_admin_all on public.settings;
create policy settings_admin_all on public.settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on public.clients  from anon;
revoke all on public.settings from anon;

-- --------------------------------------------------------------------------
-- 6.  admins — nobody writes to this from the browser. Ever.
--     Add an admin from the SQL editor by hand, never through the app.
-- --------------------------------------------------------------------------
drop policy if exists admins_self_read on public.admins;
create policy admins_self_read on public.admins
  for select to authenticated
  using (user_id = auth.uid());

revoke all on public.admins from anon, authenticated;
grant select on public.admins to authenticated;

-- --------------------------------------------------------------------------
-- 7.  vote_helpful — anonymous readers bump a counter without being able to
--     UPDATE posts. SECURITY DEFINER does the write on their behalf, and the
--     function can only ever touch those two columns.
-- --------------------------------------------------------------------------
create or replace function public.vote_helpful(post_slug text, up boolean)
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.posts
     set helpful_yes = coalesce(helpful_yes, 0) + (case when up then 1 else 0 end),
         helpful_no  = coalesce(helpful_no,  0) + (case when up then 0 else 1 end)
   where slug = post_slug
     and status = 'published';
$$;

revoke all on function public.vote_helpful(text, boolean) from public;
grant execute on function public.vote_helpful(text, boolean) to anon, authenticated;

-- ==========================================================================
-- Checking it worked
-- --------------------------------------------------------------------------
-- From any terminal, with the PUBLIC key — this is exactly what a stranger
-- who found the repo can do. Both should come back empty / refused:
--
--   curl "https://<project>.supabase.co/rest/v1/clients?select=*" \
--        -H "apikey: <publishable key>"
--   -> []
--
--   curl -X POST "https://<project>.supabase.co/rest/v1/admins" \
--        -H "apikey: <publishable key>" -H "Content-Type: application/json" \
--        -d '{"user_id":"00000000-0000-0000-0000-000000000000"}'
--   -> 401, "new row violates row-level security policy"
--
-- And this SHOULD work, because the Feed depends on it:
--
--   curl "https://<project>.supabase.co/rest/v1/posts?status=eq.published&select=slug" \
--        -H "apikey: <publishable key>"
--   -> your published posts
-- ==========================================================================
