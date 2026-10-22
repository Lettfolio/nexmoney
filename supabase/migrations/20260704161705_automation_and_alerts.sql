-- 20260704161705_automation_and_alerts — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Alerts view: rate/ERC intelligence per case
create or replace view public.v_alerts
with (security_invoker = true) as
select
  c.id as case_id,
  c.client_id,
  cl.first_name || ' ' || cl.last_name as client_name,
  cl.email as client_email,
  c.lender, c.product_name, c.rate_percent, c.rate_end_date, c.erc_end_date,
  c.fee_status, c.broker_fee, c.stage,
  (c.rate_end_date - current_date) as days_to_rate_end,
  (c.erc_end_date is not null and c.rate_end_date is not null and c.erc_end_date > c.rate_end_date) as erc_outlasts_rate,
  c.rate_reminder_queued_at,
  c.review_requested_at
from public.cases c
join public.clients cl on cl.id = c.client_id
where c.stage = 'completed' and c.rate_end_date is not null;

-- Helper to read a setting
create or replace function public.get_setting(k text) returns text
language sql stable as $$ select value from public.settings where key = k $$;

-- Queue automated emails (run daily)
create or replace function public.queue_automated_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  reminder_months int := coalesce(nullif(get_setting('rate_reminder_months'),'')::int, 6);
  review_delay int := coalesce(nullif(get_setting('review_delay_days'),'')::int, 3);
  n_reminders int := 0;
  n_reviews int := 0;
begin
  -- Rate-end reminders
  with due as (
    select c.id, c.client_id, cl.email
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.rate_end_date is not null
      and c.rate_reminder_queued_at is null
      and cl.email is not null and cl.email <> ''
      and c.rate_end_date >= current_date
      and c.rate_end_date <= current_date + (reminder_months || ' months')::interval
  ), ins as (
    insert into email_queue (case_id, client_id, email_type, to_email)
    select id, client_id, 'rate_end_reminder', email from due
    returning case_id
  )
  update cases set rate_reminder_queued_at = now()
  where id in (select case_id from ins);
  get diagnostics n_reminders = row_count;

  -- Review requests after completion
  with due as (
    select c.id, c.client_id, cl.email
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.completed_at is not null
      and c.completed_at <= now() - (review_delay || ' days')::interval
      and c.review_requested_at is null
      and cl.email is not null and cl.email <> ''
  ), ins as (
    insert into email_queue (case_id, client_id, email_type, to_email)
    select id, client_id, 'review_request', email from due
    returning case_id
  )
  update cases set review_requested_at = now()
  where id in (select case_id from ins);
  get diagnostics n_reviews = row_count;

  return jsonb_build_object('rate_reminders_queued', n_reminders, 'review_requests_queued', n_reviews);
end $$;

-- Scheduling: pg_cron calls the process-emails edge function every morning at 8am
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'nexmoney-process-emails',
  '0 8 * * *',
  $$
  select net.http_post(
    url := 'https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/process-emails',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjbGdoa212enB3dG1uemJrYW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNzI1MDEsImV4cCI6MjA5ODc0ODUwMX0.LNm4vE071b359t8ACq459nVmQCUkk7BSVeGjddqNztg'
    ),
    body := '{}'::jsonb
  );
  $$
);
