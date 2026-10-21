-- 20260718214457_lockdown_new_report_rpcs — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

REVOKE EXECUTE ON FUNCTION public.find_duplicate_clients() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_data_quality() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_reports() FROM anon, public;
