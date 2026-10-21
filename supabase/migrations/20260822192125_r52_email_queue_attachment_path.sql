-- 20260822192125_r52_email_queue_attachment_path — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

alter table public.email_queue add column if not exists attachment_path text;
comment on column public.email_queue.attachment_path is 'R52 — storage path (offers bucket) of a document to attach when this email is sent, e.g. a mortgage offer PDF. Null for plain template emails.';
