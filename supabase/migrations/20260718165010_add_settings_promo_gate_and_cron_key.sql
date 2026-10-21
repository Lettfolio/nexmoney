-- 20260718165010_add_settings_promo_gate_and_cron_key — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Master financial-promotions approval gate (FCA appointed-rep requirement). Default OFF so no
-- promotional email can go out until the network has approved the templates.
insert into public.settings(key, value) values ('financial_promotions_approved','off')
  on conflict (key) do nothing;

-- Shared secret so pg_cron can authenticate to the privileged edge functions without relying on
-- the public anon key alone. Staff-only readable via RLS.
insert into public.settings(key, value) values
  ('cron_key','<cron_key REDACTED at export — R94 · D: secret never committed>')
  on conflict (key) do nothing;
