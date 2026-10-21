-- 20260727073542_r5_m2_cases_lost_reason_and_fee_dates — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- M2 — cases: lost reasons + per-fee-type paid dates
alter table public.cases
  add column if not exists lost_reason text,
  add column if not exists lost_detail text,
  add column if not exists broker_fee_paid_at timestamptz,
  add column if not exists proc_fee_paid_at timestamptz,
  add column if not exists sols_fee_paid_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.cases'::regclass and conname = 'cases_lost_reason_chk'
  ) then
    alter table public.cases add constraint cases_lost_reason_chk check (lost_reason is null or lost_reason in
      ('went_direct','product_transfer_online','another_broker','staying_put','affordability',
       'rate_price','valuation','client_changed_mind','our_service','other'));
  end if;
end $$;

-- Backfill: the single legacy date stands in for each fee type that has an amount.
update public.cases set
  broker_fee_paid_at = case when coalesce(broker_fee,0) > 0 then fee_paid_at end,
  proc_fee_paid_at   = case when coalesce(proc_fee,0)   > 0 then fee_paid_at end,
  sols_fee_paid_at   = case when coalesce(sols_fee,0)   > 0 then fee_paid_at end
where fee_status = 'paid' and fee_paid_at is not null;
