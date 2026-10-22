-- 20260731162635_r7_m1_protection_quote_clock — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R7-1: protection quote clock.
-- Columns only: the UI stamps them when a protection quote goes out, and
-- audit_row() already records the change generically.
alter table public.cases
  add column if not exists protection_quoted_at timestamptz,
  add column if not exists protection_quoted_by uuid references public.profiles(id);

comment on column public.cases.protection_quoted_at is 'When a protection quote was sent to the client (drives the quote-ageing clock).';
comment on column public.cases.protection_quoted_by is 'Adviser who sent the protection quote.';
