-- 20260806224104_r12b_m3_appointment_outcome — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R12b (W-17): appointments had no way to record that they happened. Nullable —
-- null means "not recorded", never guessed. Values the app writes: attended /
-- no_show / rearranged. No check constraint, matching this schema's convention
-- (fact_finds.status, protection_status are unconstrained text too).
alter table appointments add column if not exists outcome text;
