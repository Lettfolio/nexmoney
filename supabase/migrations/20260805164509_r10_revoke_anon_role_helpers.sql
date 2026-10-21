-- 20260805164509_r10_revoke_anon_role_helpers — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- BE-5: role-helper SECURITY DEFINER functions should not be callable by anon.
-- Revoke anon EXECUTE; the authenticated grant is left intact.
REVOKE EXECUTE ON FUNCTION public.is_staff() FROM anon;
REVOKE EXECUTE ON FUNCTION public.my_introducer_id() FROM anon;
