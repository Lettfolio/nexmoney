-- 20260726053706_harden_new_function_grants — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Trigger functions must never be callable over the REST API, and the
-- role helpers must never be callable by anonymous visitors.
revoke all on function public.audit_row()          from anon, authenticated, public;
revoke all on function public.guard_role_change()  from anon, authenticated, public;
revoke all on function public.audit_actor_label()  from anon, authenticated, public;

revoke all on function public.is_owner()           from anon, public;
revoke all on function public.is_admin_or_owner()  from anon, public;
revoke all on function public.my_role()            from anon, public;

grant execute on function public.is_owner()          to authenticated;
grant execute on function public.is_admin_or_owner() to authenticated;
grant execute on function public.my_role()           to authenticated;
