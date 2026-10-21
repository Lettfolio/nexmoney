-- 20260704172435_estimated_flag_and_offer_docs_v3 — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

alter table public.cases add column if not exists rate_end_estimated boolean not null default false;
alter table public.cases add column if not exists offer_doc_path text;

update public.cases set rate_end_estimated = true
where rate_end_date is not null
  and id in (select case_id from public.case_notes where body like '%Rate end date estimated%');

insert into storage.buckets (id, name, public) values ('offers', 'offers', false)
on conflict (id) do nothing;
create policy "auth offers select" on storage.objects for select to authenticated using (bucket_id = 'offers');
create policy "auth offers insert" on storage.objects for insert to authenticated with check (bucket_id = 'offers');
create policy "auth offers update" on storage.objects for update to authenticated using (bucket_id = 'offers') with check (bucket_id = 'offers');

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
where c.stage = 'completed' and c.rate_end_date is not null;
