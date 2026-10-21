-- 20260806223934_r12b_m1_retention_pack_tour — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R12b (broker panel flow round)
-- 1. Retention call-pack fields: the retention pitch is "you're paying £X/month
--    more than you need to" and none of its inputs were storable (W-15).
--    All nullable — absence renders as absence in the app, never as zero.
alter table cases
  add column if not exists current_balance numeric,
  add column if not exists reversion_rate numeric,
  add column if not exists monthly_payment numeric,
  add column if not exists erc_amount numeric;

-- 2. First-run tour flag. profiles writes are Owner-only by policy (r4), so a
--    user marks their own tour seen through a narrow SECURITY DEFINER RPC that
--    can touch exactly one column of exactly their own row and nothing else.
alter table profiles add column if not exists tour_seen_at timestamptz;

create or replace function public.mark_tour_seen()
returns void
language sql
security definer
set search_path to 'public'
as $$
  update profiles set tour_seen_at = now()
  where id = auth.uid() and tour_seen_at is null;
$$;
revoke all on function public.mark_tour_seen() from public;
grant execute on function public.mark_tour_seen() to authenticated;
