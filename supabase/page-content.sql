-- ==========================================================================
-- WBA — editable page content ("Edit mode").
--
-- Run supabase/rls.sql FIRST — the policies here call public.is_admin().
-- Then paste this into Supabase -> SQL Editor -> Run. Safe to re-run.
--
-- ---------------------------------------------------------------------------
-- How this works, in one paragraph
-- ---------------------------------------------------------------------------
-- Every editable piece of copy on the site carries a `data-edit="key"`
-- attribute in the HTML. This table stores an override for any of those keys.
-- The Feed generator bakes the overrides back into the static HTML at build
-- time, so visitors get plain pre-rendered pages: no flash of old copy, no
-- extra request, and search engines see the final text. The database is the
-- edit log; the HTML is what ships.
--
-- That means an edit is saved instantly but goes live on the next build.
-- The admin bar shows a pending count and a Publish button for exactly that
-- reason -- see docs/EDIT-MODE.md.
-- ==========================================================================

create table if not exists public.page_content (
  id          uuid primary key default gen_random_uuid(),
  page        text not null,               -- '/', '/sites/', '/about/' ...
  key         text not null,               -- 'hero.title', 'intro.body' ...
  value       text not null default '',
  -- 'text'  = escaped on output, newlines become <br>
  -- 'rich'  = a narrow inline whitelist (b/strong/i/em/a/br) survives
  kind        text not null default 'text',
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- One row per key per page. The admin upserts on this pair.
create unique index if not exists page_content_page_key_uidx
  on public.page_content (page, key);

create index if not exists page_content_updated_idx
  on public.page_content (updated_at desc);

-- Keep the sizes sane so a runaway paste can't fill the table.
alter table public.page_content drop constraint if exists page_content_sane;
alter table public.page_content add constraint page_content_sane check (
  length(page)  between 1 and 200
  and length(key)   between 1 and 120
  and length(value) <= 20000
  and kind in ('text', 'rich')
);

-- --------------------------------------------------------------------------
-- Row-level security
--
-- Read is public. This is website copy -- it is on the page for anyone to
-- read the moment it is published, so there is nothing to protect, and the
-- build reads it with the publishable key.
--
-- Write is admins only. `to authenticated` on its own would not be enough:
-- anyone can create an account. is_admin() is what actually holds the door.
-- --------------------------------------------------------------------------
alter table public.page_content enable row level security;

drop policy if exists page_content_public_read on public.page_content;
create policy page_content_public_read on public.page_content
  for select to anon, authenticated
  using (true);

drop policy if exists page_content_admin_write on public.page_content;
create policy page_content_admin_write on public.page_content
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- The anon role must never write here, whatever a future policy says.
revoke insert, update, delete on public.page_content from anon;
grant  select on public.page_content to anon, authenticated;
grant  insert, update, delete on public.page_content to authenticated;

-- --------------------------------------------------------------------------
-- Stamp who changed what, without trusting the client to say.
-- --------------------------------------------------------------------------
create or replace function public.page_content_touch()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists page_content_touch_trg on public.page_content;
create trigger page_content_touch_trg
  before insert or update on public.page_content
  for each row execute function public.page_content_touch();

-- ==========================================================================
-- Checking it worked
-- --------------------------------------------------------------------------
--   curl "https://<project>.supabase.co/rest/v1/page_content?select=page,key" \
--        -H "apikey: <publishable key>"
--   -> [] (or your edits). Reading is fine.
--
--   curl -X POST "https://<project>.supabase.co/rest/v1/page_content" \
--        -H "apikey: <publishable key>" -H "Content-Type: application/json" \
--        -d '{"page":"/","key":"x","value":"hacked"}'
--   -> 401, "violates row-level security policy". This one MUST fail.
-- ==========================================================================
