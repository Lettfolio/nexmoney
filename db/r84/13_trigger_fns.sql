-- R84 · S2-3 (P1) + S2-7/8 (P3) — trigger functions
--
-- WHAT / WHY
--  1. auto_protection_triggers: queued the protection_offer / gi_exchange emails (financial
--     promotions) without checking clients.suppress_automation — auto_stage_comms already did.
--     Now also honours marketing_opt_out and comms_optout (a promotion is marketing, and a
--     client who has opted out of all comms must not get it). Tasks are internal, unaffected.
--     Masked today (financial_promotions_approved='off', both auto_*_email blank) — latent.
--  2. London dates: touch_case wrote submitted_at := current_date (server = UTC), and the
--     task due dates in auto_stage_comms / auto_protection_triggers / log_fact_find_submit used
--     current_date + N. Between 00:00 and 01:00 BST that is yesterday. All now use
--     (now() at time zone 'Europe/London')::date.
--  3. log_case_event: `old.fee_status || ' → ' || new.fee_status` (and protection_status) yield a
--     NULL detail when one side is NULL (first assignment). Wrapped in coalesce like the
--     rate_end_date branch already was.
--
-- Bodies copied from pg_get_functiondef on 2026-09-07 (re-read immediately before editing);
-- SECURITY DEFINER and SET search_path preserved verbatim. Every changed line is tagged -- R84.
--
-- EXPECTED EFFECT: no visible change today; correct gating once promotions are switched on;
-- date-stamps match the London calendar day.
--
-- VERIFY (after apply):
--   select proname from pg_proc where pronamespace='public'::regnamespace
--     and proname in ('auto_protection_triggers','auto_stage_comms','log_fact_find_submit','touch_case','log_case_event')
--     and pg_get_functiondef(oid) like '%R84%';                      -- 5 rows
--   select proname, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace
--     and proname in ('auto_protection_triggers','auto_stage_comms','log_fact_find_submit','log_case_event');
--     -- prosecdef = t, proconfig = {search_path=public} for all four; touch_case stays prosecdef = f
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

CREATE OR REPLACE FUNCTION public.auto_protection_triggers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cl_email text;
  cl_suppress boolean;                                                            -- R84: same gate as auto_stage_comms + opt-outs
  today date := (now() at time zone 'Europe/London')::date;                       -- R84: London calendar day, not UTC
  promo_ok boolean := get_setting('financial_promotions_approved') = 'on';
begin
  if new.stage is not distinct from old.stage then return new; end if;
  select email,
         coalesce(suppress_automation,false) or coalesce(marketing_opt_out,false) or coalesce(comms_optout,false)   -- R84
    into cl_email, cl_suppress                                                    -- R84
    from clients where id = new.client_id;                                        -- R84

  -- Offer issued: the natural protection moment
  if new.stage = 'offer' and coalesce(new.protection_status,'not_discussed') in ('not_discussed','discussed') then
    if not exists (select 1 from case_tasks where case_id = new.id
                   and title = 'Protection conversation — mortgage agreed' and done_at is null) then
      insert into case_tasks (case_id, title, due_date, assigned_to)
      values (new.id, 'Protection conversation — mortgage agreed', today + 2, new.assigned_to);   -- R84
    end if;
    if get_setting('auto_protection_email') = 'on' and promo_ok
       and cl_email is not null and cl_email <> '' and not cl_suppress             -- R84
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
      values (new.id, 'Arrange buildings/GI cover before completion', today + 3, new.assigned_to);   -- R84
    end if;
    if get_setting('auto_gi_email') = 'on' and promo_ok
       and cl_email is not null and cl_email <> '' and not cl_suppress             -- R84
       and not exists (select 1 from email_queue where case_id = new.id and email_type = 'gi_exchange') then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new.id, new.client_id, 'gi_exchange', cl_email);
    end if;
  end if;

  return new;
end $function$;


CREATE OR REPLACE FUNCTION public.auto_stage_comms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cl_email text;
  cl_suppress boolean;
  chase_days int := coalesce(nullif(get_setting('solicitor_chase_days'),'')::int, 7);
  today date := (now() at time zone 'Europe/London')::date;                       -- R84: London calendar day, not UTC
begin
  if new.stage is not distinct from old.stage then return new; end if;
  select email, coalesce(suppress_automation,false) into cl_email, cl_suppress
    from clients where id = new.client_id;

  -- Document request when fact find starts
  if new.stage = 'fact_find' and get_setting('auto_docs_request') in ('on','1')
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'docs_request') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'docs_request', cl_email);
  end if;

  -- Application submitted update
  if new.stage = 'application' and get_setting('auto_submitted_update') in ('on','1')
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'submitted_update') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'submitted_update', cl_email);
  end if;

  -- Offer received update
  if new.stage = 'offer' and get_setting('auto_offer_update') in ('on','1')
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'offer_update') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'offer_update', cl_email);
  end if;

  -- Exchange: solicitor chase task cadence (internal — not suppressed)
  if new.stage = 'exchange'
     and not exists (select 1 from case_tasks where case_id = new.id and title like 'Chase solicitors%' and done_at is null) then
    insert into case_tasks (case_id, title, due_date, assigned_to)
    values (new.id, 'Chase solicitors for completion date', today + chase_days, new.assigned_to);   -- R84
  end if;

  -- Completion congratulations (review request follows automatically after the delay)
  if new.stage = 'completed' and get_setting('auto_completion_email') in ('on','1')
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'completion_congrats') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'completion_congrats', cl_email);
  end if;

  return new;
end $function$;


CREATE OR REPLACE FUNCTION public.log_fact_find_submit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted' and new.case_id is not null then
    insert into case_events (case_id, event, detail) values (new.case_id, 'fact_find_submitted', 'Client submitted their online fact-find');
    insert into case_notes (case_id, body) values (new.case_id, 'Client submitted their online fact-find — review in the Fact-find tab.');
    insert into case_tasks (case_id, title, due_date, assigned_to)
      select new.case_id, 'Review submitted fact-find', (now() at time zone 'Europe/London')::date, c.assigned_to from cases c where c.id = new.case_id;   -- R84: London date
  end if;
  return new;
end $function$;


CREATE OR REPLACE FUNCTION public.touch_case()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  if new.stage = 'completed' and old.stage is distinct from 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  if new.stage in ('application','offer','exchange','completed') and new.submitted_at is null
     and old.stage in ('enquiry','fact_find','decision_in_principle') then
    new.submitted_at := (now() at time zone 'Europe/London')::date;               -- R84: London date, not UTC current_date
  end if;
  return new;
end $function$;


CREATE OR REPLACE FUNCTION public.log_case_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare who text;
begin
  if tg_op = 'INSERT' then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'case_created', 'Stage: ' || new.stage, auth.uid());
    return new;
  end if;
  if new.stage is distinct from old.stage then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'stage_changed', old.stage || ' → ' || new.stage, auth.uid());
  end if;
  if new.fee_status is distinct from old.fee_status then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'fee_status_changed', coalesce(old.fee_status::text,'—') || ' → ' || coalesce(new.fee_status::text,'—'), auth.uid());   -- R84: never a NULL detail
  end if;
  if new.offer_doc_path is distinct from old.offer_doc_path and new.offer_doc_path is not null then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'offer_document_uploaded', new.offer_doc_path, auth.uid());
  end if;
  if new.rate_end_date is distinct from old.rate_end_date then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'rate_end_date_changed', coalesce(old.rate_end_date::text,'—') || ' → ' || coalesce(new.rate_end_date::text,'—'), auth.uid());
  end if;
  if new.protection_status is distinct from old.protection_status then
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'protection_status_changed', coalesce(old.protection_status::text,'—') || ' → ' || coalesce(new.protection_status::text,'—'), auth.uid());   -- R84: never a NULL detail
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    select coalesce(nullif(full_name,''), email) into who from profiles where id = new.assigned_to;
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'case_assigned', coalesce(who, 'unassigned'), auth.uid());
  end if;
  return new;
end $function$;
