-- 20260825122213_r55_perf_rls_consolidate — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R55 F6b: merge the doubled-up permissive SELECT/UPDATE policies the advisor flagged.
-- Permissive policies OR together, so each merged policy is the OR of the two it replaces,
-- with helper/auth calls wrapped as init-plans. Semantics are unchanged: is_staff() is false
-- for anon and introducers; my_introducer_id() is null for everyone but introducers.

-- cases SELECT: "cases read staff" (public) + "introducer cases" (authenticated)
drop policy if exists "cases read staff" on public.cases;
drop policy if exists "introducer cases" on public.cases;
create policy "cases read staff or introducer" on public.cases for select
  using (
    (select is_staff())
    or (introducer_id is not null and introducer_id = (select my_introducer_id()))
  );

-- clients SELECT: "clients read staff" + "introducer clients"
drop policy if exists "clients read staff" on public.clients;
drop policy if exists "introducer clients" on public.clients;
create policy "clients read staff or introducer" on public.clients for select
  using (
    (select is_staff())
    or exists (
      select 1 from public.cases c
      where c.client_id = clients.id and c.introducer_id = (select my_introducer_id())
    )
  );

-- profiles SELECT: "own profile" + "profiles read staff"
drop policy if exists "own profile" on public.profiles;
drop policy if exists "profiles read staff" on public.profiles;
create policy "profiles read staff or self" on public.profiles for select
  using ((select is_staff()) or (id = (select auth.uid())));

-- profiles UPDATE: "profiles edit owner" + "profiles self edit"
drop policy if exists "profiles edit owner" on public.profiles;
drop policy if exists "profiles self edit" on public.profiles;
create policy "profiles update owner or self" on public.profiles for update
  using ((select is_owner()) or (id = (select auth.uid())))
  with check ((select is_owner()) or (id = (select auth.uid())));
