-- ==========================================================================
-- WBA — the client portal.
--
-- Run this ONCE in Supabase → SQL Editor. Everything is IF NOT EXISTS, so
-- re-running it changes nothing.
--
-- WHAT THIS ADDS
--   client_users       which signed-in person belongs to which client
--   projects           one build, with the stage it has reached
--   project_updates    the timeline the client reads
--   previews           versions of the site we have put in front of them
--   invoices           what we billed
--   payments           what arrived
--   project_accounts   WHICH accounts exist. Never a password. See below.
--
-- THE ONE RULE THIS FILE ENFORCES
--   A signed-in client can read their own rows and nothing else. Every write
--   is admin-only. There is no policy anywhere that lets one client see
--   another, and no client-writable table — so nothing a client sends can
--   change what anybody sees.
--
-- WHY THERE IS NO PASSWORD COLUMN ANYWHERE
--   An agency that keeps its clients' passwords in its own database becomes
--   the single most valuable target connected to all of them, with none of
--   the protections a real vault has: no rotation, no per-secret audit trail,
--   no SOC 2, no breach playbook. If we were ever read, every client we have
--   is compromised at once and it is our fault in writing.
--
--   So project_accounts records that an account EXISTS — what it is for, its
--   address, the username, and who holds the secret — and the secret itself
--   lives in a shared password-manager vault. That is what we would tell a
--   client to do, which makes it the only defensible thing for us to do.
--
--   If you ever feel tempted to add a `password` column here: the reason it
--   feels tempting is that it would be convenient, and convenience is exactly
--   what the attacker is relying on.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1.  Who is this person, and whose account are they on?
--
--     One auth user maps to exactly one client. `handle` is the short name
--     you type when you create them ("pivaz"), so a client can sign in with
--     something memorable instead of hunting for which address they used.
-- --------------------------------------------------------------------------
create table if not exists public.client_users (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  client_id    uuid not null references public.clients(id) on delete cascade,
  handle       text unique,
  display_name text,
  is_primary   boolean not null default true,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create index if not exists client_users_client_idx on public.client_users (client_id);

-- Handles are matched case-insensitively and must not collide.
create unique index if not exists client_users_handle_lower_idx
  on public.client_users (lower(handle));

-- --------------------------------------------------------------------------
-- 2.  The helper every policy below leans on.
--
--     SECURITY DEFINER so the check can read client_users while the caller
--     cannot read the whole table. search_path is pinned: without it a
--     hostile search_path could point `client_users` at a different table and
--     the function would happily authorise against it.
-- --------------------------------------------------------------------------
create or replace function public.my_client_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cu.client_id from public.client_users cu where cu.user_id = auth.uid();
$$;

revoke all on function public.my_client_id() from public;
grant execute on function public.my_client_id() to authenticated;

-- --------------------------------------------------------------------------
-- 3.  Projects
--
--     `stage` uses the same five words as the build map on /sites/, so the
--     client sees the process they were shown before they signed.
-- --------------------------------------------------------------------------
create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  name         text not null,
  stage        text not null default 'talk'
               check (stage in ('talk','design','build','live','grow')),
  status       text not null default 'active'
               check (status in ('active','paused','done','cancelled')),
  summary      text,
  live_url     text,
  preview_path text,          -- object-store prefix, e.g. previews/pivaz/v7
  started_on   date,
  target_on    date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists projects_client_idx on public.projects (client_id);

-- --------------------------------------------------------------------------
-- 4.  The timeline the client actually reads
-- --------------------------------------------------------------------------
create table if not exists public.project_updates (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  happened_at timestamptz not null default now(),
  title      text not null,
  body       text,
  kind       text not null default 'note'
             check (kind in ('note','milestone','preview','invoice')),
  created_at timestamptz not null default now()
);

create index if not exists project_updates_project_idx
  on public.project_updates (project_id, happened_at desc);

-- --------------------------------------------------------------------------
-- 5.  Preview versions
--
--     The files live in object storage; this is the index of what was put up
--     and when, so a client can see "v7, Tuesday" rather than a bare link
--     that silently changes under them.
-- --------------------------------------------------------------------------
create table if not exists public.previews (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  version     integer not null default 1,
  path        text not null,
  note        text,
  file_count  integer,
  bytes       bigint,
  is_current  boolean not null default false,
  uploaded_at timestamptz not null default now()
);

create index if not exists previews_project_idx
  on public.previews (project_id, version desc);

-- --------------------------------------------------------------------------
-- 6.  Money
--
--     Amounts are INTEGER PENCE. Never float — 0.1 + 0.2 is not 0.3 in
--     binary floating point, and an invoice that is a penny out is an
--     invoice someone has to ring you about.
-- --------------------------------------------------------------------------
create table if not exists public.invoices (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete set null,
  number       text not null,
  issued_on    date not null default current_date,
  due_on       date,
  amount_pence integer not null default 0 check (amount_pence >= 0),
  status       text not null default 'draft'
               check (status in ('draft','sent','paid','overdue','void')),
  pdf_path     text,
  note         text,
  created_at   timestamptz not null default now()
);

create index if not exists invoices_client_idx on public.invoices (client_id, issued_on desc);
create unique index if not exists invoices_number_key on public.invoices (number);

create table if not exists public.payments (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  invoice_id   uuid references public.invoices(id) on delete set null,
  paid_on      date not null default current_date,
  amount_pence integer not null check (amount_pence > 0),
  method       text,
  reference    text,
  created_at   timestamptz not null default now()
);

create index if not exists payments_client_idx on public.payments (client_id, paid_on desc);

-- --------------------------------------------------------------------------
-- 7.  Account references — WHICH accounts exist, never the secrets.
--     Read the header of this file before adding a column here.
-- --------------------------------------------------------------------------
create table if not exists public.project_accounts (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.clients(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  label      text not null,
  url        text,
  username   text,
  holder     text not null default 'shared'
             check (holder in ('wba','client','shared')),
  vault_url  text,
  note       text,
  created_at timestamptz not null default now()
);

create index if not exists project_accounts_client_idx on public.project_accounts (client_id);

comment on table public.project_accounts is
  'References to accounts, never credentials. No password column, deliberately — see supabase/portal.sql.';

-- ==========================================================================
-- ROW LEVEL SECURITY
--
-- Default deny. Every table below is enabled with no permissive policy for
-- `anon`, so the publishable key in js/db.js reads nothing here at all.
-- ==========================================================================
alter table public.client_users     enable row level security;
alter table public.projects         enable row level security;
alter table public.project_updates  enable row level security;
alter table public.previews         enable row level security;
alter table public.invoices         enable row level security;
alter table public.payments         enable row level security;
alter table public.project_accounts enable row level security;

-- A client may read the row that says who THEY are, and nothing about anyone
-- else. Admins see all of it.
drop policy if exists client_users_self_read on public.client_users;
create policy client_users_self_read on public.client_users
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists client_users_admin_all on public.client_users;
create policy client_users_admin_all on public.client_users
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- The rest follow one shape: read your own, admins do everything.
drop policy if exists projects_client_read on public.projects;
create policy projects_client_read on public.projects
  for select to authenticated
  using (client_id = public.my_client_id());

drop policy if exists projects_admin_all on public.projects;
create policy projects_admin_all on public.projects
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists invoices_client_read on public.invoices;
create policy invoices_client_read on public.invoices
  for select to authenticated
  using (client_id = public.my_client_id()
         and status in ('sent','paid','overdue'));   -- drafts are ours

drop policy if exists invoices_admin_all on public.invoices;
create policy invoices_admin_all on public.invoices
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists payments_client_read on public.payments;
create policy payments_client_read on public.payments
  for select to authenticated
  using (client_id = public.my_client_id());

drop policy if exists payments_admin_all on public.payments;
create policy payments_admin_all on public.payments
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists accounts_client_read on public.project_accounts;
create policy accounts_client_read on public.project_accounts
  for select to authenticated
  using (client_id = public.my_client_id());

drop policy if exists accounts_admin_all on public.project_accounts;
create policy accounts_admin_all on public.project_accounts
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- These two hang off a project rather than a client, so the check walks up
-- one level. EXISTS rather than IN: it stops at the first match.
drop policy if exists updates_client_read on public.project_updates;
create policy updates_client_read on public.project_updates
  for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_updates.project_id
      and p.client_id = public.my_client_id()
  ));

drop policy if exists updates_admin_all on public.project_updates;
create policy updates_admin_all on public.project_updates
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists previews_client_read on public.previews;
create policy previews_client_read on public.previews
  for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = previews.project_id
      and p.client_id = public.my_client_id()
  ));

drop policy if exists previews_admin_all on public.previews;
create policy previews_admin_all on public.previews
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 8.  What the portal actually asks for.
--
--     One round trip instead of seven, and — because it is SECURITY INVOKER —
--     every policy above still applies inside it. A client calling this gets
--     their own row or nothing; there is no way to pass someone else's id.
-- --------------------------------------------------------------------------
create or replace function public.my_portal()
returns json
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select json_build_object(
    'client', (
      select json_build_object('id', c.id, 'business', c.business,
                               'contact', c.contact, 'domain', c.domain,
                               'status', c.status, 'monthly_fee', c.monthly_fee)
      from public.clients c where c.id = public.my_client_id()
    ),
    'me', (
      select json_build_object('handle', cu.handle, 'name', cu.display_name)
      from public.client_users cu where cu.user_id = auth.uid()
    ),
    'projects', coalesce((
      select json_agg(row_to_json(p) order by p.created_at)
      from public.projects p where p.client_id = public.my_client_id()
    ), '[]'::json),
    'updates', coalesce((
      select json_agg(row_to_json(u) order by u.happened_at desc)
      from public.project_updates u
      join public.projects p on p.id = u.project_id
      where p.client_id = public.my_client_id()
    ), '[]'::json),
    'previews', coalesce((
      select json_agg(row_to_json(v) order by v.version desc)
      from public.previews v
      join public.projects p on p.id = v.project_id
      where p.client_id = public.my_client_id()
    ), '[]'::json),
    'invoices', coalesce((
      select json_agg(row_to_json(i) order by i.issued_on desc)
      from public.invoices i where i.client_id = public.my_client_id()
    ), '[]'::json),
    'payments', coalesce((
      select json_agg(row_to_json(pm) order by pm.paid_on desc)
      from public.payments pm where pm.client_id = public.my_client_id()
    ), '[]'::json),
    'accounts', coalesce((
      select json_agg(row_to_json(a) order by a.label)
      from public.project_accounts a where a.client_id = public.my_client_id()
    ), '[]'::json)
  );
$$;

revoke all on function public.my_portal() from public;
grant execute on function public.my_portal() to authenticated;

-- --------------------------------------------------------------------------
-- 9.  Handle → is there an account?  (deliberately says almost nothing)
--
--     The sign-in box takes a handle like "pivaz". Before we can email a
--     code we have to turn that into an address, and doing the lookup in the
--     browser would hand anyone a way to enumerate our client list.
--
--     So this returns TRUE or FALSE and never the address, the login page
--     shows the same message either way, and the actual email is sent by an
--     Edge Function holding the service key. Worst case someone learns that
--     a handle exists, which they could guess from the client's own website.
-- --------------------------------------------------------------------------
create or replace function public.handle_exists(h text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.client_users cu where lower(cu.handle) = lower(trim(h))
  );
$$;

revoke all on function public.handle_exists(text) from public;
grant execute on function public.handle_exists(text) to anon, authenticated;

-- --------------------------------------------------------------------------
-- 10.  Touch last_seen_at so the admin can see who has actually logged in.
-- --------------------------------------------------------------------------
create or replace function public.portal_seen()
returns void
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.client_users set last_seen_at = now() where user_id = auth.uid();
$$;

revoke all on function public.portal_seen() from public;
grant execute on function public.portal_seen() to authenticated;
