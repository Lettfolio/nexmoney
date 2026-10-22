-- 20260727073509_r5_m1_profiles_adviser_identity — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- M1 — profiles: per-adviser identity (phone + email sign-off)
alter table public.profiles
  add column if not exists phone text,
  add column if not exists email_signoff text;

-- Self-service edit of own contact/sign-off.
-- Role changes remain blocked by trigger guard_role_change (authoritative).
drop policy if exists "profiles self edit" on public.profiles;
create policy "profiles self edit" on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));
