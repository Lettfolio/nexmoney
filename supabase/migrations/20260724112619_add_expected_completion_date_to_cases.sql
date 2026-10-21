-- 20260724112619_add_expected_completion_date_to_cases — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Additive, nullable: settable at Offer/Exchange, powers the proc-fee income forecast buckets
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS expected_completion_date date;
