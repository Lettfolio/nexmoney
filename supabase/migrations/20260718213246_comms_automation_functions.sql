-- 20260718213246_comms_automation_functions — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- queue_automated_emails: unchanged email logic + (a) NPS token on review_request,
-- (b) rate-end SMS queued alongside the retention email when SMS is enabled.
CREATE OR REPLACE FUNCTION public.queue_automated_emails()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  reminder_months int := coalesce(nullif(get_setting('rate_reminder_months'),'')::int, 6);
  review_delay int := coalesce(nullif(get_setting('review_delay_days'),'')::int, 3);
  referral_delay int := coalesce(nullif(get_setting('referral_delay_days'),'')::int, 21);
  promo_ok boolean := get_setting('financial_promotions_approved') = 'on';
  sms_on boolean := get_setting('sms_enabled') = 'on' and get_setting('auto_sms_rate_end') = 'on';
  r record;
  new_case uuid;
  touch2_at timestamptz;
  task_due date;
  n_created int := 0;
  n_reviews int := 0;
  n_referrals int := 0;
begin
  for r in
    select c.id, c.client_id, c.case_kind, c.lender, c.rate_percent, c.rate_type,
           c.rate_end_date, c.rate_end_estimated, c.assigned_to, cl.email, cl.phone, cl.sms_opt_out
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.rate_end_date is not null
      and c.rate_end_date >= current_date
      and c.rate_end_date <= current_date + (reminder_months || ' months')::interval
      and c.rate_reminder_queued_at is null
      and not exists (select 1 from cases rc where rc.retention_source_case_id = c.id)
  loop
    insert into cases (client_id, case_kind, stage, lender, rate_percent, rate_type,
                       rate_end_date, rate_end_estimated, retention_source_case_id, assigned_to)
    values (r.client_id, r.case_kind, 'enquiry', r.lender, r.rate_percent, r.rate_type,
            r.rate_end_date, r.rate_end_estimated, r.id, r.assigned_to)
    returning id into new_case;

    insert into case_notes (case_id, body)
    values (new_case, 'Retention opportunity auto-created — current ' || coalesce(r.lender,'') ||
            ' deal ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY'));

    if r.email is not null and r.email <> '' then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new_case, r.client_id, 'rate_end_reminder', r.email);
      touch2_at := greatest(now() + interval '21 days', r.rate_end_date::timestamptz - interval '5 months');
      if touch2_at < r.rate_end_date::timestamptz - interval '14 days' then
        insert into email_queue (case_id, client_id, email_type, to_email, scheduled_for)
        values (new_case, r.client_id, 'rate_end_chase', r.email, touch2_at);
      end if;
    end if;

    -- Rate-end SMS (only when SMS enabled, phone present, not opted out)
    if sms_on and r.phone is not null and r.phone <> '' and not coalesce(r.sms_opt_out,false) then
      insert into sms_queue (case_id, client_id, sms_type, to_phone)
      values (new_case, r.client_id, 'rate_end', r.phone);
    end if;

    task_due := greatest(least(greatest(current_date + 35, r.rate_end_date - 120), r.rate_end_date - 14), current_date + 1);
    insert into case_tasks (case_id, title, due_date, assigned_to)
    values (new_case, 'Call client — rate ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY') ||
            case when r.email is null or r.email = '' then ' (no email on file!)' else '' end, task_due, r.assigned_to);

    update cases set rate_reminder_queued_at = now() where id = r.id;
    n_created := n_created + 1;
  end loop;

  -- Review requests (set an NPS token so the email's rating links are tamper-checked)
  with due as (
    select c.id, c.client_id, cl.email
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed' and c.completed_at is not null
      and c.completed_at <= now() - (review_delay || ' days')::interval
      and c.review_requested_at is null
      and cl.email is not null and cl.email <> ''
  ), ins as (
    insert into email_queue (case_id, client_id, email_type, to_email)
    select id, client_id, 'review_request', email from due
    returning case_id
  )
  update cases set review_requested_at = now(),
                   nps_token = coalesce(nps_token, gen_random_uuid())
  where id in (select case_id from ins);
  get diagnostics n_reviews = row_count;

  -- Referral nudges (financial promotion — gated)
  if get_setting('auto_referral') = 'on' and promo_ok then
    with due as (
      select c.id, c.client_id, cl.email
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed'
        and c.review_requested_at is not null
        and c.review_requested_at <= now() - (referral_delay || ' days')::interval
        and c.referral_requested_at is null
        and c.completed_at >= now() - interval '12 months'
        and cl.email is not null and cl.email <> ''
        and not coalesce(cl.marketing_opt_out,false)
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'referral_request', email from due
      returning case_id
    )
    update cases set referral_requested_at = now() where id in (select case_id from ins);
    get diagnostics n_referrals = row_count;
  end if;

  return jsonb_build_object('retention_created', n_created, 'review_requests_queued', n_reviews,
                            'referral_requests_queued', n_referrals);
end $function$;

-- Birthday + completion-anniversary email sweeps. Called daily by process-emails.
CREATE OR REPLACE FUNCTION public.queue_comms_extras()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n_birthday int := 0; n_anniv int := 0;
begin
  if get_setting('birthday_enabled') = 'on' then
    with due as (
      select cl.id, cl.email from clients cl
      where cl.date_of_birth is not null
        and to_char(cl.date_of_birth,'MM-DD') = to_char(current_date,'MM-DD')
        and cl.email is not null and cl.email <> ''
        and not coalesce(cl.marketing_opt_out,false)
        and not exists (select 1 from email_queue e where e.client_id = cl.id
                        and e.email_type = 'birthday_greeting'
                        and e.created_at >= date_trunc('year', now()))
    ), ins as (
      insert into email_queue (client_id, email_type, to_email)
      select id, 'birthday_greeting', email from due
      returning 1
    )
    select count(*) into n_birthday from ins;
  end if;

  if get_setting('anniversary_enabled') = 'on' then
    with due as (
      select c.id, c.client_id, cl.email from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and to_char(c.completed_at at time zone 'Europe/London','MM-DD') = to_char(current_date,'MM-DD')
        and c.completed_at < date_trunc('year', now())
        and (c.anniversary_sent_at is null or c.anniversary_sent_at < date_trunc('year', now()))
        and cl.email is not null and cl.email <> ''
        and not coalesce(cl.marketing_opt_out,false)
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'completion_anniversary', email from due
      returning case_id
    )
    update cases set anniversary_sent_at = now() where id in (select case_id from ins);
    get diagnostics n_anniv = row_count;
  end if;

  return jsonb_build_object('birthday_queued', n_birthday, 'anniversary_queued', n_anniv);
end $function$;

-- Appointment-reminder SMS: for appts starting tomorrow (London day). Called by send-sms.
CREATE OR REPLACE FUNCTION public.queue_appointment_sms()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int := 0; company text := coalesce(get_setting('company_name'),'NexMoney');
begin
  if get_setting('sms_enabled') <> 'on' or get_setting('auto_sms_appointment') <> 'on' then
    return jsonb_build_object('appointment_sms_queued', 0);
  end if;
  with due as (
    select a.id, a.client_id, a.case_id, a.starts_at, cl.phone, cl.first_name
    from appointments a join clients cl on cl.id = a.client_id
    where cl.phone is not null and cl.phone <> '' and not coalesce(cl.sms_opt_out,false)
      and (a.starts_at at time zone 'Europe/London')::date = (current_date + 1)
      and not exists (select 1 from sms_queue s where s.case_id = a.case_id
                      and s.sms_type = 'appointment'
                      and s.created_at >= current_date::timestamptz)
  ), ins as (
    insert into sms_queue (case_id, client_id, sms_type, to_phone, body)
    select case_id, client_id, 'appointment', phone,
      'Hi ' || coalesce(nullif(btrim(first_name),''),'there') || ', a reminder of your appointment with ' || company ||
      ' tomorrow at ' || to_char(starts_at at time zone 'Europe/London','HH24:MI') || '. Reply to rearrange. Txt STOP to opt out.'
    from due
    returning 1
  )
  select count(*) into n from ins;
  return jsonb_build_object('appointment_sms_queued', n);
end $function$;

REVOKE EXECUTE ON FUNCTION public.queue_comms_extras() FROM anon, authenticated, public;
REVOKE EXECUTE ON FUNCTION public.queue_appointment_sms() FROM anon, authenticated, public;
