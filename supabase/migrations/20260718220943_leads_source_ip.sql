-- 20260718220943_leads_source_ip — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS source_ip text;
CREATE INDEX IF NOT EXISTS idx_leads_source_ip_created ON public.leads(source_ip, created_at);
