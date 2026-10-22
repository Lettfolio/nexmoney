-- 20260828075304_advisor_fixes_security_hardening — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.
-- R94 · fixer: statement 2 made `if exists` so a data-less Preview Branch (which never had the
-- hand-pasted backup_* tables) can replay the chain; production already has this version and skips it.

-- 1) ERROR: v_alerts bypassed caller RLS (any signed-in user could read all client cases).
--    Make it run with the caller's permissions; staff keep access via their RLS policies.
alter view public.v_alerts set (security_invoker = true);

-- 2) ERROR: backup table exposed via PostgREST with no RLS. Enable (deny-all like its sibling backup tables).
alter table if exists public.backup_r70_retention_link enable row level security;

-- 3) WARN: audit_vault_row is a trigger function — API roles never need to call it directly.
revoke execute on function public.audit_vault_row() from anon, authenticated;

-- 4) WARN: mark_tour_seen is a no-op without auth.uid(); anon has no business calling it.
revoke execute on function public.mark_tour_seen() from anon;

-- 5) WARN: pin search_path on trigger function (body has no table references).
alter function public.touch_vault_updated() set search_path = '';

-- 6) PERF: consolidate the two permissive SELECT policies on introducers
drop policy "staff all" on public.introducers;
drop policy "own introducer row" on public.introducers;
create policy introducers_select on public.introducers for select to authenticated
  using (is_staff() or id = my_introducer_id());
create policy introducers_insert on public.introducers for insert to authenticated
  with check (is_staff());
create policy introducers_update on public.introducers for update to authenticated
  using (is_staff()) with check (is_staff());
create policy introducers_delete on public.introducers for delete to authenticated
  using (is_staff());
