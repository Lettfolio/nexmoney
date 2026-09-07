-- =============================================================================
-- R84 · 03 · queue_comms_extras — findings F3, F5
--
-- WHAT / WHY (each change tagged `-- R84 (Fn)` in the body):
--   F3  pg_advisory_xact_lock(hashtext('nexmoney.queue_comms')) at the top — the same key as
--       queue_automated_emails (02), so process-emails' back-to-back pair of RPC calls and any
--       overlapping cron/"Run now" caller serialise instead of double-queueing.
--   F5  All five settings switches (birthday_enabled, anniversary_enabled,
--       annual_review_enabled, doc_chase_enabled, nps_enabled) now use get_setting_on()
--       (file 01), replacing a mix of `= 'on'` and `in ('on','1')`.
--   Everything else is byte-identical to the production definition read on 2026-09-07
--   (md5 b922fb39e93fe3e20b4a3f235e719a19 of pg_get_functiondef output).
--
-- EXPECTED EFFECT: none today — every one of those switches currently holds 'on' or 'off',
--   which both spellings read identically. Protects the day one is saved as "1".
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select (pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock%') f3,
--          (pg_get_functiondef(p.oid) not like '%= ''on''%') f5,
--          prosecdef, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec  -- expect false
--     from pg_proc p where proname='queue_comms_extras' and pronamespace='public'::regnamespace;
-- =============================================================================
begin;

CREATE OR REPLACE FUNCTION public.queue_comms_extras()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n_birthday int := 0; n_anniv int := 0; n_annual int := 0;
        n_doc_chase int := 0; n_doc_tasks int := 0;
        n_review_reminders int := 0; n_recent_reviews int := 0;
        -- R63: the chase interval is the Settings "Document chase interval" (doc_chase_days), default 3.
        chase_days int := case when coalesce(get_setting('doc_chase_days'),'') ~ '^[0-9]+$'
                               and get_setting('doc_chase_days')::int > 0
                               then get_setting('doc_chase_days')::int else 3 end;
begin
  -- R84 (F3): same advisory lock key as queue_automated_emails — the two functions form one
  -- critical section per transaction, so an overlapping cron/"Run now" pair cannot both pass the
  -- count/exists guards below and queue duplicate birthday, anniversary, chase or reminder rows.
  perform pg_advisory_xact_lock(hashtext('nexmoney.queue_comms'));  -- R84 (F3)
  if get_setting_on('birthday_enabled') then  -- R84 (F5)
    with due as (
      select cl.id, cl.email from clients cl
      where cl.date_of_birth is not null
        and to_char(cl.date_of_birth,'MM-DD') = to_char(current_date,'MM-DD')
        and cl.email is not null and cl.email <> '' and not coalesce(cl.suppress_automation,false)
        and not coalesce(cl.marketing_opt_out,false) and not coalesce(cl.comms_optout,false)
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

  if get_setting_on('anniversary_enabled') then  -- R84 (F5)
    with due as (
      select c.id, c.client_id, cl.email from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and to_char(c.completed_at at time zone 'Europe/London','MM-DD') = to_char(current_date,'MM-DD')
        and c.completed_at < date_trunc('year', now())
        and (c.anniversary_sent_at is null or c.anniversary_sent_at < date_trunc('year', now()))
        and cl.email is not null and cl.email <> '' and not coalesce(cl.suppress_automation,false)
        and not coalesce(cl.marketing_opt_out,false) and not coalesce(cl.comms_optout,false)
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
  if get_setting_on('annual_review_enabled') then  -- R84 (F5)
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

  -- R9-M3 / R12b: document chase. A LIVE case with items still outstanding gets
  -- nudged every three days — R12b widened this from fact_find/application to
  -- every live stage (W-24: a case parked at DIP waiting on payslips got no
  -- chase at all). There is no new email type: process-emails composes
  -- docs_request from the checklist, naming ONLY the missing items, so the same
  -- type carries the first ask and every chase.
  -- Cap: at most four docs_request emails per case in total (the original from
  -- auto_stage_comms plus three chases). After that the client is left alone and
  -- the adviser gets a task to phone instead -- an unanswered email chain is not
  -- fixed by a fifth email.
  -- Gated on auto_docs_request, the switch that already governs whether this
  -- firm sends document requests automatically at all.
  if get_setting_on('doc_chase_enabled') then  -- R84 (F5) · R63: chasing is its own switch (Settings > Documents), not the first-request switch
    with base as (
      select c.id, c.client_id, cl.email,
             (select count(*) from email_queue e
               where e.case_id = c.id and e.email_type = 'docs_request'
                 and e.status <> 'cancelled') as sent_count,
             (select max(e.created_at) from email_queue e
               where e.case_id = c.id and e.email_type = 'docs_request'
                 and e.status <> 'cancelled') as last_queued
      from cases c join clients cl on cl.id = c.client_id
      where c.stage in ('enquiry','fact_find','decision_in_principle','application','offer','exchange')
        and cl.email is not null and cl.email <> '' and not coalesce(cl.suppress_automation,false)
        and exists (select 1 from case_documents d
                     where d.case_id = c.id and d.status = 'requested')
        -- Never stack a second request behind one that has not gone out yet
        -- (e.g. RESEND_API_KEY unset): that is how you end up sending four
        -- identical emails the minute sending is restored.
        and not exists (select 1 from email_queue e
                         where e.case_id = c.id and e.email_type = 'docs_request'
                           and e.status in ('queued','sending'))
    ), chase as (
      select id, client_id, email from base
      where sent_count <= 3
        and (last_queued is null or last_queued <= now() - (chase_days || ' days')::interval)
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'docs_request', email from chase
      returning 1
    )
    select count(*) into n_doc_chase from ins;

    -- Chase budget spent -> hand it to a human, once, while it stays open.
    with overdue as (
      select c.id, c.assigned_to,
             btrim(cl.first_name || ' ' || cl.last_name) as client_name
      from cases c join clients cl on cl.id = c.client_id
      where c.stage in ('enquiry','fact_find','decision_in_principle','application','offer','exchange')
        and exists (select 1 from case_documents d
                     where d.case_id = c.id and d.status = 'requested')
        and (select count(*) from email_queue e
              where e.case_id = c.id and e.email_type = 'docs_request'
                and e.status <> 'cancelled') >= 4
        and not exists (select 1 from case_tasks t
                         where t.case_id = c.id
                           and t.title like 'Documents overdue — %'
                           and t.done_at is null)
    ), ins2 as (
      insert into case_tasks (case_id, title, due_date, assigned_to)
      select id, 'Documents overdue — call ' || client_name, current_date, assigned_to
      from overdue
      returning 1
    )
    select count(*) into n_doc_tasks from ins2;
  end if;

  -- R9-M3: one gentle reminder about seven days after a review request that went
  -- unanswered (no score recorded). It reuses the review_request type rather than
  -- adding an enum value: process-emails v11 sees that the case already has an
  -- earlier review_request row and switches to reminder wording. The "exactly one
  -- prior row" test is therefore also the thing that guarantees a single reminder
  -- and never a third email.
  if get_setting_on('nps_enabled') then  -- R84 (F5)
    -- Share the 5-per-run drip with the initial review requests that
    -- queue_automated_emails queued moments ago -- process-emails calls it
    -- immediately before this function, so anything created in the last five
    -- minutes belongs to this run. If runs are closer together than that we
    -- over-count, which only slows the drip; it can never exceed five.
    select count(*) into n_recent_reviews from email_queue
     where email_type = 'review_request' and created_at >= now() - interval '5 minutes';

    if n_recent_reviews < 5 then
      with due as (
        select c.id, c.client_id, cl.email
        from cases c join clients cl on cl.id = c.client_id
        where c.stage = 'completed'
          and c.review_requested_at is not null
          and c.review_requested_at <= now() - interval '7 days'
          and c.nps_score is null and not coalesce(cl.comms_optout,false)
          and cl.email is not null and cl.email <> '' and not coalesce(cl.suppress_automation,false)
          and (select count(*) from email_queue e
                where e.case_id = c.id and e.email_type = 'review_request'
                  and e.status <> 'cancelled') = 1
          and not exists (select 1 from email_queue e
                           where e.case_id = c.id and e.email_type = 'review_request'
                             and e.status in ('queued','sending'))
        order by c.review_requested_at
        limit (5 - n_recent_reviews)
      ), ins as (
        insert into email_queue (case_id, client_id, email_type, to_email)
        select id, client_id, 'review_request', email from due
        returning 1
      )
      select count(*) into n_review_reminders from ins;
    end if;
  end if;

  return jsonb_build_object('birthday_queued', n_birthday, 'anniversary_queued', n_anniv,
                            'annual_review_tasks', n_annual,
                            'doc_chases_queued', n_doc_chase,
                            'doc_overdue_tasks', n_doc_tasks,
                            'review_reminders_queued', n_review_reminders);
end $function$;

commit;
