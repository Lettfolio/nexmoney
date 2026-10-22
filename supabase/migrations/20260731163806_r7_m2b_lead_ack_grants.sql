-- 20260731163806_r7_m2b_lead_ack_grants — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- The project's default privileges grant EXECUTE on new public functions to
-- anon/authenticated; "revoke ... from public" does not remove those explicit
-- grants. Match every other trigger function (postgres + service_role only).
revoke all on function public.queue_lead_ack() from anon, authenticated, public;
grant execute on function public.queue_lead_ack() to service_role;
