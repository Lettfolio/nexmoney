-- 20260718165041_wire_financial_promotions_gate — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Gate referral nudges behind the master financial-promotions approval switch.
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
  r record;
  new_case uuid;
  touch2_at timestamptz;
  task_due date;
  n_created int := 0;
  n_reviews int := 0;
  n_referrals int := 0;
begin
  -- 1. Retention sweep
  for r in
    select c.id, c.client_id, c.case_kind, c.lender, c.rate_percent, c.rate_type,
           c.rate_end_date, c.rate_end_estimated, c.assigned_to, cl.email
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

    task_due := greatest(least(greatest(current_date + 35, r.rate_end_date - 120), r.rate_end_date - 14), current_date + 1);
    insert into case_tasks (case_id, title, due_date, assigned_to)
    values (new_case, 'Call client — rate ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY') ||
            case when r.email is null or r.email = '' then ' (no email on file!)' else '' end, task_due, r.assigned_to);

    update cases set rate_reminder_queued_at = now() where id = r.id;
    n_created := n_created + 1;
  end loop;

  -- 2. Review requests
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
  update cases set review_requested_at = now() where id in (select case_id from ins);
  get diagnostics n_reviews = row_count;

  -- 3. Referral nudges after reviews (financial promotion — gated)
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

-- Gate protection_offer + gi_exchange auto emails behind the same master switch.
CREATE OR REPLACE FUNCTION public.auto_protection_triggers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cl_email text;
  promo_ok boolean := get_setting('financial_promotions_approved') = 'on';
begin
  if new.stage is not distinct from old.stage then return new; end if;
  select email into cl_email from clients where id = new.client_id;

  -- Offer issued: the natural protection moment
  if new.stage = 'offer' and coalesce(new.protection_status,'not_discussed') in ('not_discussed','discussed') then
    if not exists (select 1 from case_tasks where case_id = new.id
                   and title = 'Protection conversation — mortgage agreed' and done_at is null) then
      insert into case_tasks (case_id, title, due_date, assigned_to)
      values (new.id, 'Protection conversation — mortgage agreed', current_date + 2, new.assigned_to);
    end if;
    if get_setting('auto_protection_email') = 'on' and promo_ok
       and cl_email is not null and cl_email <> ''
       and not exists (select 1 from email_queue where case_id = new.id and email_type = 'protection_offer') then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new.id, new.client_id, 'protection_offer', cl_email);
    end if;
  end if;

  -- Exchange on a purchase: buildings insurance is required
  if new.stage = 'exchange' and new.case_kind in ('purchase','first_time_buyer')
     and coalesce(new.gi_status,'not_discussed') = 'not_discussed' then
    if not exists (select 1 from case_tasks where case_id = new.id
                   and title = 'Arrange buildings/GI cover before completion' and done_at is null) then
      insert into case_tasks (case_id, title, due_date, assigned_to)
      values (new.id, 'Arrange buildings/GI cover before completion', current_date + 3, new.assigned_to);
    end if;
    if get_setting('auto_gi_email') = 'on' and promo_ok
       and cl_email is not null and cl_email <> ''
       and not exists (select 1 from email_queue where case_id = new.id and email_type = 'gi_exchange') then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new.id, new.client_id, 'gi_exchange', cl_email);
    end if;
  end if;

  return new;
end $function$;
