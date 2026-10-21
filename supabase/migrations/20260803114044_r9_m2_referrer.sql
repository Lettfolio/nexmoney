-- 20260803114044_r9_m2_referrer — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R9-M2: advocacy. Which existing client referred this case, so thank-you tasks
-- and the advocacy dashboard have a real edge to follow. Set null on delete so
-- removing a client never cascades into losing a case.
alter table public.cases
  add column referrer_client_id uuid references public.clients(id) on delete set null;

create index cases_referrer_client_id_idx on public.cases (referrer_client_id);
