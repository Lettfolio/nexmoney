-- 20260808085640_r18_m1_scale_indexes — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R18: additive indexes for the genuine gaps found in the scale review.
-- Pipeline board sorts cases by updated_at desc with no existing index.
create index if not exists cases_updated_at_idx on public.cases (updated_at desc);
-- Reports/velocity scan filters case_events by event type then orders by created_at.
create index if not exists case_events_event_created_at_idx on public.case_events (event, created_at);
-- The unactioned radar + last-contact reads will be bounded by created_at across
-- the whole firm (no case filter), so a leading created_at index serves them.
create index if not exists case_events_created_at_idx on public.case_events (created_at);
create index if not exists case_notes_created_at_idx on public.case_notes (created_at);
