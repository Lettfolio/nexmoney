-- 20260825122148_r55_perf_fk_indexes — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R55 F5: cover the two foreign keys the performance advisor flagged as unindexed.
create index if not exists idx_case_files_case_id on public.case_files (case_id);
create index if not exists idx_staff_absences_profile_id on public.staff_absences (profile_id);
