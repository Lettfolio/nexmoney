-- 20260718165126_email_queue_claim_support — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

ALTER TYPE public.email_status ADD VALUE IF NOT EXISTS 'sending';
ALTER TABLE public.email_queue ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
