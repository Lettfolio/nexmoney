-- 20260903191237_r82_revoke_anon_execute — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R82 hardening: two SECURITY DEFINER functions were executable by the anon role.
-- Neither is a live hole (audit_vault_row is a trigger function that errors if called
-- directly; get_protection_pipeline_total carries the house staff guard and returns 0
-- to a stranger) — but neither has any business being reachable unauthenticated.
revoke all on function public.audit_vault_row() from public, anon;
revoke all on function public.get_protection_pipeline_total(text) from public, anon;
grant execute on function public.get_protection_pipeline_total(text) to authenticated;
