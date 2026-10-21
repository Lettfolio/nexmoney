-- 20260902210058_r79_comms_optout_and_link_expiry — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R79 "Trust the send": PECR opt-out flag + per-client unsubscribe token; 30-day link expiry metadata.
alter table clients add column comms_optout boolean not null default false;
alter table clients add column comms_token uuid not null default gen_random_uuid();
alter table fact_finds add column expires_at timestamptz;
alter table cases add column doc_token_expires_at timestamptz;
-- Grace backfill: any already-minted link gets 30 days from now rather than retro-expiring.
update fact_finds set expires_at = now() + interval '30 days' where token is not null and expires_at is null;
update cases set doc_token_expires_at = now() + interval '30 days' where doc_token is not null and doc_token_expires_at is null;
