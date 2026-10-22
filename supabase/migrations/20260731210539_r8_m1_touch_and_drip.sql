-- 20260731210539_r8_m1_touch_and_drip — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R8-M1: annual-review call task (settings-gated) + review-request drip.
-- Function edits and one settings row only. No schema changes, no new enum values.

CREATE OR REPLACE FUNCTION public.queue_comms_extras()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n_birthday int := 0; n_anniv int := 0; n_annual int := 0;
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

  -- R8-M1: annual review touch. Twelve months after completion, and every year
  -- after, drop ONE call task on the case adviser's list. Deliberately no email:
  -- an annual-review email would need a new email_type enum value, which was not
  -- approved for this round.
  -- Idempotency without a schema change: the generated title is byte-identical
  -- every year (completion date and property never change), so an exact-title
  -- check would suppress every year after the first. Instead we look for an
  -- annual-review task on the same case created within the last 11 months --
  -- one anniversary is ~12 months apart, so last year's task never blocks this
  -- year's, while any re-run inside the same year is blocked.
  if get_setting('annual_review_enabled') = 'on' then
    with due as (
      select c.id, c.assigned_to,
             btrim(cl.first_name || ' ' || cl.last_name) as client_name,
             to_char(c.completed_at at time zone 'Europe/London','DD/MM/YYYY') as completed_label,
             coalesce(
               nullif(btrim(split_part(replace(coalesce(c.property_address,''), E'\\n', ','), ',', 1)), ''),
               nullif(btrim(coalesce(c.property_address,'')), '')
             ) as prop_label
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and to_char(c.completed_at at time zone 'Europe/London','MM-DD') = to_char(current_date,'MM-DD')
        and (c.completed_at at time zone 'Europe/London')::date <= (current_date - interval '12 months')::date
        and not exists (
          select 1 from case_tasks t
          where t.case_id = c.id
            and t.title like 'Annual review call — %'
            and t.created_at >= now() - interval '11 months')
    ), ins as (
      insert into case_tasks (case_id, title, due_date, assigned_to)
      select id,
             'Annual review call — ' || client_name || ' (completed ' || completed_label ||
             case when prop_label is not null then ', on ' || prop_label else '' end || ')',
             current_date, assigned_to
      from due
      returning 1
    )
    select count(*) into n_annual from ins;
  end if;

  return jsonb_build_object('birthday_queued', n_birthday, 'anniversary_queued', n_anniv,
                            'annual_review_tasks', n_annual);
end $function$;

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
  prop_full text;
  prop_label text;
  n_created int := 0;
  n_recovery int := 0;
  n_reviews int := 0;
  n_referrals int := 0;
begin
  for r in
    select c.id, c.client_id, c.case_kind, c.lender, c.rate_percent, c.rate_type,
           c.rate_end_date, c.rate_end_estimated, c.assigned_to, c.property_address,
           (c.rate_end_date < current_date) as rate_ended,
           cl.email, cl.phone, cl.sms_opt_out
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.rate_end_date is not null
      -- Forward window as before, plus a recovery lane for rates that have
      -- already ended (18 months back — beyond that the trail is cold).
      and c.rate_end_date >= current_date - interval '18 months'
      and c.rate_end_date <= current_date + (reminder_months || ' months')::interval
      and c.rate_reminder_queued_at is null
      and not exists (select 1 from cases rc where rc.retention_source_case_id = c.id)
  loop
    -- Property naming: full address for the note, first address line for the task title.
    prop_full := nullif(btrim(coalesce(r.property_address, '')), '');
    prop_label := coalesce(nullif(btrim(split_part(replace(prop_full, E'\\n', ','), ',', 1)), ''), prop_full);

    insert into cases (client_id, case_kind, stage, lender, rate_percent, rate_type,
                       rate_end_date, rate_end_estimated, retention_source_case_id, assigned_to,
                       property_address)
    values (r.client_id, r.case_kind, 'enquiry', r.lender, r.rate_percent, r.rate_type,
            r.rate_end_date, r.rate_end_estimated, r.id, r.assigned_to,
            r.property_address)
    returning id into new_case;

    if r.rate_ended then
      insert into case_notes (case_id, body)
      values (new_case, 'Retention recovery auto-created — ' || coalesce(r.lender,'') ||
              ' deal' || case when prop_full is not null then ' on ' || prop_full else '' end ||
              ' rate ended ' || to_char(r.rate_end_date, 'DD/MM/YYYY') || ' — client likely on SVR');
    else
      insert into case_notes (case_id, body)
      values (new_case, 'Retention opportunity auto-created — current ' || coalesce(r.lender,'') ||
              ' deal' || case when prop_full is not null then ' on ' || prop_full else '' end ||
              ' ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY'));
    end if;

    -- Rate-end emails only apply while the rate is still running. R7-M5: the
    -- recovery lane (rate already ended) queues nothing — "your rate is due to
    -- end" copy is wrong months after it ended. The call task created below is
    -- what drives a recovery conversation, by phone.
    if not r.rate_ended and r.email is not null and r.email <> '' then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new_case, r.client_id, 'rate_end_reminder', r.email);
      touch2_at := greatest(now() + interval '21 days', r.rate_end_date::timestamptz - interval '5 months');
      if touch2_at < r.rate_end_date::timestamptz - interval '14 days' then
        insert into email_queue (case_id, client_id, email_type, to_email, scheduled_for)
        values (new_case, r.client_id, 'rate_end_chase', r.email, touch2_at);
      end if;
    end if;

    -- Rate-end SMS (only when SMS enabled, phone present, not opted out).
    -- R7-M6: the recovery lane is excluded here for the same reason as the
    -- email above — "your rate is due to end" is the wrong tense once it has.
    if sms_on and not r.rate_ended and r.phone is not null and r.phone <> '' and not coalesce(r.sms_opt_out,false) then
      insert into sms_queue (case_id, client_id, sms_type, to_phone)
      values (new_case, r.client_id, 'rate_end', r.phone);
    end if;

    task_due := greatest(least(greatest(current_date + 35, r.rate_end_date - 120), r.rate_end_date - 14), current_date + 1);
    insert into case_tasks (case_id, title, due_date, assigned_to)
    values (new_case, 'Call client — rate' ||
            case when prop_label is not null then ' on ' || prop_label else '' end ||
            case when r.rate_ended
                 then ' ended ' || to_char(r.rate_end_date, 'DD/MM/YYYY') || ', likely on SVR'
                 else ' ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY') end ||
            case when r.email is null or r.email = '' then ' (no email on file!)' else '' end, task_due, r.assigned_to);

    update cases set rate_reminder_queued_at = now() where id = r.id;
    if r.rate_ended then
      n_recovery := n_recovery + 1;
    else
      n_created := n_created + 1;
    end if;
  end loop;

  -- Review requests (set an NPS token so the email's rating links are tamper-checked)
  if get_setting('nps_enabled') = 'on' then
    with due as (
      select c.id, c.client_id, cl.email
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and c.completed_at <= now() - (review_delay || ' days')::interval
        and c.review_requested_at is null
        and cl.email is not null and cl.email <> ''
      -- R8-M1: drip-feed the queue instead of blasting the whole backlog in one
      -- run. Oldest completion first; the remainder is picked up by subsequent
      -- nightly runs, 5 at a time.
      order by c.completed_at
      limit 5
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'review_request', email from due
      returning case_id
    )
    update cases set review_requested_at = now(),
                     nps_token = coalesce(nps_token, gen_random_uuid())
    where id in (select case_id from ins);
    get diagnostics n_reviews = row_count;
  end if;

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

  return jsonb_build_object('retention_created', n_created, 'retention_recovery', n_recovery,
                            'review_requests_queued', n_reviews,
                            'referral_requests_queued', n_referrals);
end $function$;

-- Toggle Daniel flips in the UI. Off by default.
insert into settings(key, value) values ('annual_review_enabled','off')
on conflict (key) do nothing;

-- Guards: the untouched regions of both functions must be byte-identical to the
-- pre-migration definitions. Any drift aborts the migration.
do $guard$
begin
  if md5(split_part(split_part(pg_get_functiondef('queue_comms_extras()'::regprocedure), 'if get_setting(''birthday_enabled'')', 2), 'get diagnostics n_anniv = row_count;', 1)) <> '620667f4ecea1e2ba1799aebfde4b243' then
    raise exception 'GUARD FAIL: queue_comms_extras birthday+anniversary block drifted';
  end if;
  if md5(split_part(pg_get_functiondef('queue_automated_emails()'::regprocedure), '  -- Review requests (set an NPS token', 1)) <> '4a4fa43d2db0806be3c5001adf22d4af' then
    raise exception 'GUARD FAIL: queue_automated_emails head (retention lane) drifted';
  end if;
  if md5(split_part(pg_get_functiondef('queue_automated_emails()'::regprocedure), '  -- Referral nudges', 2)) <> '1550c34ce5642b3dcad900db795d11c8' then
    raise exception 'GUARD FAIL: queue_automated_emails tail (referral lane + return) drifted';
  end if;
end $guard$;
