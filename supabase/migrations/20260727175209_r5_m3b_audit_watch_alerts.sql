-- 20260727175209_r5_m3b_audit_watch_alerts — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Round 5 follow-up (G1N-5): watchtower snoozes/dismissals must leave an audit trail,
-- matching the trigger pattern on the other audited tables.
create trigger audit_watch_alerts
  after insert or update or delete on public.watch_alerts
  for each row execute function public.audit_row();
