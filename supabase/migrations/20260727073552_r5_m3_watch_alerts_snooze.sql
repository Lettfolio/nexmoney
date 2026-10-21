-- 20260727073552_r5_m3_watch_alerts_snooze — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- M3 — watch_alerts: snooze columns.
-- No run_watchtower change: its ON CONFLICT (dedupe_key) DO UPDATE sets only
-- severity/title/detail/last_seen_at/resolved_at, so snoozes persist across runs.
alter table public.watch_alerts
  add column if not exists snoozed_until timestamptz,
  add column if not exists snooze_note text,
  add column if not exists snoozed_by uuid references public.profiles(id);
