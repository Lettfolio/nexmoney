-- 20260704214936_alerts_include_all_rate_ends — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Rates-ending alerts now cover ANY case with a known rate end date (completed clients,
-- imported enquiry chases, live cases) — excluding retention children (their source carries the date)
-- and closed-out cases.
drop view public.v_alerts;
create view public.v_alerts
with (security_invoker = true) as
select
  c.id as case_id,
  c.client_id,
  btrim(cl.first_name || ' ' || cl.last_name) as client_name,
  cl.email as client_email,
  c.lender, c.product_name, c.rate_percent, c.rate_end_date, c.erc_end_date,
  c.rate_end_estimated,
  c.fee_status, c.broker_fee, c.stage,
  (c.rate_end_date - current_date) as days_to_rate_end,
  (c.erc_end_date is not null and c.rate_end_date is not null and c.erc_end_date > c.rate_end_date) as erc_outlasts_rate,
  c.rate_reminder_queued_at,
  c.review_requested_at
from public.cases c
join public.clients cl on cl.id = c.client_id
where c.rate_end_date is not null
  and c.retention_source_case_id is null
  and c.stage <> 'not_proceeding';
