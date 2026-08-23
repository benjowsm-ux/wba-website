-- ==========================================================================
-- WBA — storage policies for the `media` bucket (the admin Photos tab).
--
-- Run supabase/rls.sql FIRST — this file depends on public.is_admin().
-- Then paste this into Supabase -> SQL Editor -> Run.
--
-- The shape we want:
--   anyone            can READ  (photos appear on the public site)
--   signed-in admins  can WRITE (upload, overwrite, delete)
--   everyone else     can do nothing
--
-- Note the asymmetry: the bucket is public for reads because a visitor's
-- browser fetches these images with no session at all. That is fine — they
-- are photographs meant to be seen. What must never be public is the ability
-- to PUT something into the bucket, which is what the three policies below
-- lock to is_admin().
-- ==========================================================================

-- 1. The bucket itself. `public = true` only affects reads.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media', 'media', true,
  10485760,                                   -- 10 MB ceiling; the admin
                                              -- downscales before upload, so
                                              -- this is a backstop, not a limit
                                              -- you should ever hit
  array['image/jpeg','image/png','image/webp','image/gif','image/avif','image/svg+xml']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2. Policies. Dropped first so this file is safe to re-run.
drop policy if exists "media public read"    on storage.objects;
drop policy if exists "media admin insert"   on storage.objects;
drop policy if exists "media admin update"   on storage.objects;
drop policy if exists "media admin delete"   on storage.objects;

-- Read: anyone, including logged-out visitors loading a post's cover image.
create policy "media public read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'media');

-- Write: admins only. `to authenticated` alone is not enough — anyone can
-- create an account, so is_admin() is what actually holds the door.
create policy "media admin insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'media' and public.is_admin());

create policy "media admin update"
  on storage.objects for update
  to authenticated
  using       (bucket_id = 'media' and public.is_admin())
  with check  (bucket_id = 'media' and public.is_admin());

create policy "media admin delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'media' and public.is_admin());

-- ==========================================================================
-- Checking it worked
-- --------------------------------------------------------------------------
-- A stranger with the publishable key must NOT be able to upload. From any
-- terminal:
--
--   curl -X POST "https://<project>.supabase.co/storage/v1/object/media/test.txt" \
--        -H "apikey: <publishable key>" --data "hello"
--   -> 400 / 403, "new row violates row-level security policy"
--
-- And in the admin, signed in as you: open Photos, drop in an image, and it
-- should appear in the grid within a second. If it fails with "violates row
-- level security", your account is missing a row in public.admins.
-- ==========================================================================
