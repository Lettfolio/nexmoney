-- 20260827190721_r70_reminder_guard_flag — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R70 · H1 — the R45 import guard stamped rate_reminder_queued_at on the imported back book so the
-- 08:00 cron would not auto-create retention cases or queue reminders for 1,700 clients at once.
-- The app rendered that stamp as "Reminder sent" and hid the manual retention path. This flag says
-- WHICH stamps are the guard (no email ever existed for the case) so the app can show the truth and
-- let a human work those rows, while the cron keeps honouring rate_reminder_queued_at unchanged.
alter table cases add column if not exists reminder_guarded boolean not null default false;
comment on column cases.reminder_guarded is 'R45 import guard: rate_reminder_queued_at was stamped to stop the cron, no reminder was ever queued or sent. Cleared by the app when a human queues a reminder or starts a retention case.';

update cases c set reminder_guarded = true
 where c.rate_reminder_queued_at is not null
   and not exists (select 1 from email_queue q where q.case_id = c.id and q.email_type = 'rate_end_reminder')
   and exists (select 1 from case_notes n where n.case_id = c.id and n.body like 'SB-IMPORT-1%');

create or replace view v_alerts as
 SELECT c.id AS case_id,
    c.client_id,
    btrim((cl.first_name || ' '::text) || cl.last_name) AS client_name,
    cl.email AS client_email,
    c.lender,
    c.product_name,
    c.rate_percent,
    c.rate_end_date,
    c.erc_end_date,
    c.rate_end_estimated,
    c.fee_status,
    c.broker_fee,
    c.stage,
    c.rate_end_date - CURRENT_DATE AS days_to_rate_end,
    c.erc_end_date IS NOT NULL AND c.rate_end_date IS NOT NULL AND c.erc_end_date > c.rate_end_date AS erc_outlasts_rate,
    c.rate_reminder_queued_at,
    c.review_requested_at,
    c.reminder_guarded
   FROM cases c
     JOIN clients cl ON cl.id = c.client_id
  WHERE c.rate_end_date IS NOT NULL AND c.retention_source_case_id IS NULL AND c.stage <> 'not_proceeding'::case_stage;
