-- 20260825122202_r55_perf_rls_initplan — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R55 F6a: wrap auth.uid()/helper calls in scalar subselects so they evaluate once per
-- statement (init-plan) instead of once per row. Expressions are otherwise IDENTICAL to
-- the policies they replace — no access change.

-- saved_views (4 policies)
drop policy if exists saved_views_select on public.saved_views;
create policy saved_views_select on public.saved_views for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists saved_views_insert on public.saved_views;
create policy saved_views_insert on public.saved_views for insert to authenticated
  with check ((user_id = (select auth.uid())) and (select is_staff()));
drop policy if exists saved_views_update on public.saved_views;
create policy saved_views_update on public.saved_views for update to authenticated
  using (user_id = (select auth.uid()))
  with check ((user_id = (select auth.uid())) and (select is_staff()));
drop policy if exists saved_views_delete on public.saved_views;
create policy saved_views_delete on public.saved_views for delete to authenticated
  using (user_id = (select auth.uid()));

-- staff_absences (3 policies; the plain staff-read one is already a bare helper call)
drop policy if exists "own or admin insert absences" on public.staff_absences;
create policy "own or admin insert absences" on public.staff_absences for insert
  with check ((select is_staff()) and ((profile_id = (select auth.uid())) or (select is_admin_or_owner())));
drop policy if exists "own or admin update absences" on public.staff_absences;
create policy "own or admin update absences" on public.staff_absences for update
  using ((select is_staff()) and ((profile_id = (select auth.uid())) or (select is_admin_or_owner())))
  with check ((select is_staff()) and ((profile_id = (select auth.uid())) or (select is_admin_or_owner())));
drop policy if exists "own or admin delete absences" on public.staff_absences;
create policy "own or admin delete absences" on public.staff_absences for delete
  using ((select is_staff()) and ((profile_id = (select auth.uid())) or (select is_admin_or_owner())));

-- vault_entries read: the per-row profiles.role subquery becomes an init-plan once
-- auth.uid() inside it is wrapped (the subquery is uncorrelated with the row).
drop policy if exists "staff read vault" on public.vault_entries;
create policy "staff read vault" on public.vault_entries for select
  using (
    (select is_staff())
    and (
      visible_to is null
      or cardinality(visible_to) = 0
      or ((select p.role from public.profiles p where p.id = (select auth.uid())) = any (visible_to))
    )
  );
