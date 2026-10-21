-- 20260807211412_r16_m1_btl_icr_and_lender_tracker — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

alter table public.cases
  add column if not exists monthly_rent numeric,
  add column if not exists icr_stress_rate numeric,
  add column if not exists icr_required_pct numeric,
  add column if not exists lender_reference text,
  add column if not exists application_status text,
  add column if not exists application_status_at timestamptz;

comment on column public.cases.monthly_rent is 'R16: BTL expected monthly rental income (GBP).';
comment on column public.cases.icr_stress_rate is 'R16: BTL ICR stress interest rate percent. UI defaults 5.5 when null.';
comment on column public.cases.icr_required_pct is 'R16: BTL ICR required coverage percent. UI defaults 145 when null.';
comment on column public.cases.lender_reference is 'R16: lender application reference for the submitted case.';
comment on column public.cases.application_status is 'R16: submit-to-lender sub-status: submitted|underwriting|valuation|offer_issued (null=not yet submitted).';
comment on column public.cases.application_status_at is 'R16: when application_status last changed (drives the chase nudge).';
