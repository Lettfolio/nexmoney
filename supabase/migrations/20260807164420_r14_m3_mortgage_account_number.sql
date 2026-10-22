-- 20260807164420_r14_m3_mortgage_account_number — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R14 follow-up: the lender security-check card needs the client's mortgage /
-- account (roll) number — the thing a lender asks for to pull up the case.
-- Nullable text; absence renders "—" on the card, never fabricated.
alter table cases add column if not exists mortgage_account_number text;
