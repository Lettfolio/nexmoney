-- 20260726053514_roles_owner_admin_adviser — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- =====================================================================
-- Role tiers: owner / admin / adviser (+ existing introducer, none)
-- Safety: 'staff' is retained as a LEGACY ALIAS everywhere it is tested,
-- so no existing login can ever be locked out by this migration.
-- =====================================================================

-- 1. Allowed values ---------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('owner','admin','adviser','introducer','staff','none'));

alter table public.profiles alter column role set default 'none';

-- 2. Backfill the current team, by id (never by name) -----------------
update public.profiles set role = 'owner'   where id = 'b186e280-db11-4514-a8d1-cea2dad8fa50'; -- Daniel Potts
update public.profiles set role = 'admin'   where id = '4375068d-cdc8-49e1-8ae1-bd857eb8241f'; -- Kim Martin
update public.profiles set role = 'adviser' where id in (
  'b1c7823f-5d45-4bbd-bde3-41659483dec5',   -- Wayne Kellow
  '2fb1c283-dde7-4730-874f-180e4a1fb8ec'    -- Luke Richards
);
-- Any other legacy full-access account becomes an adviser.
update public.profiles set role = 'adviser' where role = 'staff';

-- 3. Role helpers -----------------------------------------------------
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path to 'public' as
$$ select exists (
     select 1 from profiles
     where id = auth.uid()
       and role in ('owner','admin','adviser','staff')
   ) $$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path to 'public' as
$$ select exists (select 1 from profiles where id = auth.uid() and role = 'owner') $$;

create or replace function public.is_admin_or_owner()
returns boolean language sql stable security definer set search_path to 'public' as
$$ select exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin')) $$;

create or replace function public.my_role()
returns text language sql stable security definer set search_path to 'public' as
$$ select role from profiles where id = auth.uid() $$;

grant execute on function public.is_owner(), public.is_admin_or_owner(), public.my_role() to authenticated;

-- 4. CRITICAL: six RPCs hardcode `role = 'staff'` inline instead of
--    calling is_staff(). Without this they return empty for every
--    non-'staff' account, silently blanking My Day, Reports, Watchtower,
--    Protection and Data health. Rewrite the guard in place, preserving
--    every other line of each function body verbatim.
do $rewrite$
declare r record; newdef text;
begin
  for r in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
      and p.proname in ('find_duplicate_clients','get_briefing','get_data_quality',
                        'get_protection_pipeline','get_reports','run_watchtower')
  loop
    newdef := replace(
      pg_get_functiondef(r.oid),
      'role = ''staff''',
      'role in (''owner'',''admin'',''adviser'',''staff'')'
    );
    execute newdef;
  end loop;
end
$rewrite$;

-- 5. Settings: everyone reads (the app needs reminder windows, adviser
--    name, targets); only the Owner writes. Bank details and the
--    financial-promotions switch live here.
drop policy if exists "staff all" on public.settings;
create policy "settings read staff"  on public.settings for select using (is_staff());
create policy "settings write owner" on public.settings for insert with check (is_owner());
create policy "settings edit owner"  on public.settings for update using (is_owner()) with check (is_owner());
create policy "settings del owner"   on public.settings for delete using (is_owner());

-- 6. Profiles: staff read (needed for adviser dropdowns and name
--    resolution); only the Owner creates, edits or removes.
drop policy if exists "staff all" on public.profiles;
create policy "profiles read staff"  on public.profiles for select using (is_staff());
create policy "profiles write owner" on public.profiles for insert with check (is_owner());
create policy "profiles edit owner"  on public.profiles for update using (is_owner()) with check (is_owner());
create policy "profiles del owner"   on public.profiles for delete using (is_owner());

-- 7. Deleting a client or a case is Owner/Administrator only.
--    Advisers keep full read/write on every case (deliberate: no
--    case-level visibility split was requested).
drop policy if exists "staff all" on public.clients;
create policy "clients read staff"   on public.clients for select using (is_staff());
create policy "clients insert staff" on public.clients for insert with check (is_staff());
create policy "clients update staff" on public.clients for update using (is_staff()) with check (is_staff());
create policy "clients delete admin" on public.clients for delete using (is_admin_or_owner());

drop policy if exists "staff all" on public.cases;
create policy "cases read staff"   on public.cases for select using (is_staff());
create policy "cases insert staff" on public.cases for insert with check (is_staff());
create policy "cases update staff" on public.cases for update using (is_staff()) with check (is_staff());
create policy "cases delete admin" on public.cases for delete using (is_admin_or_owner());

-- 8. Belt and braces on the role column itself: the firm can never be
--    left with no Owner, and nobody but an Owner can change a role
--    (even if a future policy is loosened by mistake).
create or replace function public.guard_role_change()
returns trigger language plpgsql security definer set search_path to 'public' as
$guard$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change a role';
    end if;
  end if;

  if (tg_op = 'UPDATE' and old.role = 'owner' and new.role is distinct from 'owner')
     or (tg_op = 'DELETE' and old.role = 'owner') then
    if (select count(*) from profiles where role = 'owner') <= 1 then
      raise exception 'Cannot remove the last Owner — promote someone else first';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$guard$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update or delete on public.profiles
  for each row execute function public.guard_role_change();
