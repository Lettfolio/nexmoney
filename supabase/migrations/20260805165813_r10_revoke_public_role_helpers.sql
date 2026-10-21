-- 20260805165813_r10_revoke_public_role_helpers — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- BE-5 (completion): EXECUTE was also granted to PUBLIC on these role-helpers, so
-- anon still inherited it after the anon-specific revoke. Revoke from PUBLIC too.
-- The explicit `authenticated` grant is retained, so signed-in access is unaffected.
REVOKE EXECUTE ON FUNCTION public.is_staff() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_introducer_id() FROM PUBLIC;
