-- 20260825140258_r57_case_objective — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R57: the pinned one-line "why" of a case (Revolution's "Summary of customer objectives and
-- goals"). Nullable, no backfill; covered by the existing cases RLS policies and audit trigger.
alter table public.cases add column if not exists objective text;
