-- 20260705054600_lifecycle_email_types — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

alter type email_type add value if not exists 'welcome';
alter type email_type add value if not exists 'docs_request';
alter type email_type add value if not exists 'submitted_update';
alter type email_type add value if not exists 'offer_update';
alter type email_type add value if not exists 'completion_congrats';
alter type email_type add value if not exists 'referral_request';
