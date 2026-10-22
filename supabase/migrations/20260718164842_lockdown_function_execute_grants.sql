-- 20260718164842_lockdown_function_execute_grants — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Round 1 security: stop anon/authenticated from calling privileged SECURITY DEFINER RPCs.
-- Trigger + helper functions never need a direct-call grant (triggers invoke them regardless).
REVOKE EXECUTE ON FUNCTION public.queue_automated_emails() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.auto_stage_comms() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.auto_protection_triggers() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.cancel_retention_touches() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.log_case_event() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.log_email_event() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.touch_case() FROM anon, authenticated, public;

-- Watchtower + read RPCs: keep for signed-in staff (frontend calls them), block anon/public.
REVOKE EXECUTE ON FUNCTION public.run_watchtower() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_briefing(text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_protection_pipeline(text) FROM anon, public;
