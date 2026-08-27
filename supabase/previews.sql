-- ==========================================================================
-- WBA — previews, the simple version.
--
-- Run this in Supabase → SQL Editor AFTER portal.sql.
--
-- WHAT CHANGED AND WHY
-- The first cut had invoices, payments, trials, monthly fees and account
-- registers. None of that is what the portal is for. The portal is for one
-- thing: the client logs in and looks at their site.
--
-- Those tables are NOT dropped — deleting data is not reversible and they
-- cost nothing sitting there. They are simply no longer shown to anyone.
-- If billing ever earns its place back, the shape is still here.
--
-- WHERE THE FILES LIVE
-- Supabase Storage, private bucket `previews`, keyed `<handle>/v<n>/...`.
-- Not Cloudflare R2: that meant a second account, a second CLI and a second
-- place for things to be wrong, to solve a storage problem 1 GB already
-- solves. When a client's previews outgrow that, moving is a bucket copy.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1.  The bucket. Private — every byte goes through the check below.
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('previews', 'previews', false, 26214400)   -- 25 MB a file is plenty
on conflict (id) do update set public = false;

-- --------------------------------------------------------------------------
-- 2.  Who may read a file?
--
--     The first path segment is the client's handle. So "does this signed-in
--     person own this file" is "is the first folder their handle" — one
--     string comparison, no joins, and impossible to get subtly wrong.
-- --------------------------------------------------------------------------
create or replace function public.my_handle()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select lower(cu.handle) from public.client_users cu where cu.user_id = auth.uid();
$$;

revoke all on function public.my_handle() from public;
grant execute on function public.my_handle() to authenticated;

drop policy if exists previews_read_own on storage.objects;
create policy previews_read_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'previews'
    and (
      public.is_admin()
      or lower((storage.foldername(name))[1]) = public.my_handle()
    )
  );

-- Only we upload. A client can look at their site; they cannot replace it.
drop policy if exists previews_admin_write on storage.objects;
create policy previews_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'previews' and public.is_admin())
  with check (bucket_id = 'previews' and public.is_admin());

-- --------------------------------------------------------------------------
-- 3.  Projects get simpler too: a client has ONE site.
--     No stage tracker, no target dates, no fee. Just where the files are.
-- --------------------------------------------------------------------------
alter table public.projects add column if not exists preview_version integer not null default 0;

-- --------------------------------------------------------------------------
-- 4.  What the portal asks for now. Two things: who you are, and your site.
-- --------------------------------------------------------------------------
-- SECURITY DEFINER, not INVOKER, and the reason is worth writing down.
--
-- As INVOKER the `clients` subquery ran as the client — and there is no
-- policy letting a client read the clients table, deliberately, because that
-- table also holds our notes and their GoCardless reference. So the business
-- name came back NULL and the portal greeted people with a blank heading.
--
-- Adding a read policy to `clients` would have fixed the symptom and opened
-- the whole row. DEFINER fixes it without widening anything: this function
-- picks the four fields a client may see, and nothing else can read that
-- table through it.
--
-- THE RULE THAT KEEPS THIS SAFE: every subquery below is filtered by
-- my_client_id() or auth.uid(). If you add one, filter it the same way. A
-- DEFINER function with an unfiltered subquery hands every client the lot.
create or replace function public.my_site()
returns json
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'business', (select to_jsonb(c)->>'business' from public.clients c where c.id = public.my_client_id()),
    'handle',   (select cu.handle from public.client_users cu where cu.user_id = auth.uid()),
    'name',     (select cu.display_name from public.client_users cu where cu.user_id = auth.uid()),
    'project',  (select json_build_object('id', p.id, 'name', p.name, 'summary', p.summary,
                                          'live_url', p.live_url, 'version', p.preview_version)
                 from public.projects p where p.client_id = public.my_client_id()
                 order by p.created_at limit 1),
    'updates',  coalesce((
                  select json_agg(json_build_object('at', u.happened_at, 'title', u.title, 'body', u.body)
                                  order by u.happened_at desc)
                  from public.project_updates u
                  join public.projects p on p.id = u.project_id
                  where p.client_id = public.my_client_id()
                ), '[]'::json)
  );
$$;

revoke all on function public.my_site() from public;
grant execute on function public.my_site() to authenticated;
