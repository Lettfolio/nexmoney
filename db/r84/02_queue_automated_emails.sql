-- =============================================================================
-- R84 · 02 · queue_automated_emails — findings F1, F2, F3, F4, F5
--
-- WHAT / WHY (each change tagged `-- R84 (Fn)` in the body):
--   F1  auto_referral was tested `= 'on'` but the Settings form writes "1"/"0", so the
--       referral lane could never fire (prod: auto_referral=1). Now get_setting_on(), plus
--       `order by review_requested_at limit 5` so the 42-case backlog drips out like reviews.
--   F2  The rate-end email/chase and rate-end SMS ignored clients.suppress_automation and
--       clients.comms_optout — the only automated lane that did. Both now gate the email and
--       the SMS; the successor case, note and adviser call task are still created.
--   F3  pg_advisory_xact_lock(hashtext('nexmoney.queue_comms')) at the top: concurrent runs
--       (cron + "Run now", or two staff) could both pass the null-stamp guards and queue
--       duplicate cases/emails. Second caller now waits and then sees the stamps.
--   F4  Successor case + call task assignee resolved at creation: r.assigned_to is kept while
--       that profile is still owner/admin/adviser, else the first Owner (by created_at). The
--       completed source case is never re-pointed; reassign_holdings is unchanged.
--   F5  Every settings truth test uses get_setting_on() (file 01 must be applied first).
--   Everything else is byte-identical to the production definition read on 2026-09-07
--   (md5 282b477fc8e28000212c10a121080611 of pg_get_functiondef output).
--
-- EXPECTED EFFECT (prod today: financial_promotions_approved=off, so F1 still queues
--   nothing until the owner approves promotions; then <=5 referral_request rows per run.
--   F2: 0 suppressed clients today, so no change until one is flagged. F3: none visible.)
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select (pg_get_functiondef(p.oid) like '%R84 (F1)%') f1,
--          (pg_get_functiondef(p.oid) like '%R84 (F2)%') f2,
--          (pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock%') f3,
--          (pg_get_functiondef(p.oid) like '%R84 (F4)%' and pg_get_functiondef(p.oid) not like '%r.id, r.assigned_to,%') f4,
--          (pg_get_functiondef(p.oid) not like '%get_setting(''auto_referral'')%') f5,
--          prosecdef, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec  -- expect false
--     from pg_proc p where proname='queue_automated_emails' and pronamespace='public'::regnamespace;
-- =============================================================================
begin;

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
  promo_ok boolean := get_setting_on('financial_promotions_approved');  -- R84 (F5): tolerant on/1/true test
  sms_on boolean := get_setting_on('sms_enabled') and get_setting_on('auto_sms_rate_end');  -- R84 (F5)
  r record;
  new_case uuid;
  owner_id uuid := (select id from profiles where role = 'owner' order by created_at limit 1);  -- R84 (F4): fallback assignee
  assignee uuid;  -- R84 (F4): resolved owner of the successor + its call task
  touch2_at timestamptz;
  task_due date;
  prop_full text;
  prop_label text;
  n_created int := 0;
  n_recovery int := 0;
  n_reviews int := 0;
  n_referrals int := 0;
begin
  -- R84 (F3): serialise runs. Cron (08:00 UTC) and a human pressing "Run now" — or two humans —
  -- used to race under READ COMMITTED: both saw rate_reminder_queued_at / review_requested_at
  -- as null and both inserted, giving duplicate successor cases and duplicate client emails.
  -- The same lock key is taken by queue_comms_extras so the pair runs as one critical section.
  perform pg_advisory_xact_lock(hashtext('nexmoney.queue_comms'));  -- R84 (F3)
  for r in
    select c.id, c.client_id, c.case_kind, c.lender, c.rate_percent, c.rate_type,
           c.rate_end_date, c.rate_end_estimated, c.assigned_to, c.property_address,
           (c.rate_end_date < current_date) as rate_ended,
           cl.email, cl.phone, cl.sms_opt_out,
           cl.suppress_automation, cl.comms_optout  -- R84 (F2): care flags, read once per case
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.rate_end_date is not null
      -- Forward window as before, plus a recovery lane for rates that have
      -- already ended (18 months back — beyond that the trail is cold).
      and c.rate_end_date >= current_date - interval '18 months'
      and c.rate_end_date <= current_date + (reminder_months || ' months')::interval
      and c.rate_reminder_queued_at is null
      -- R58: only a successor for THIS product cycle (same rate_end_date) blocks.
      and not exists (select 1 from cases rc where rc.retention_source_case_id = c.id
                        and rc.rate_end_date is not distinct from c.rate_end_date)
  loop
    -- Property naming: full address for the note, first address line for the task title.
    prop_full := nullif(btrim(coalesce(r.property_address, '')), '');
    prop_label := coalesce(nullif(btrim(split_part(replace(prop_full, E'\\n', ','), ',', 1)), ''), prop_full);

    -- R84 (F4): a completed case keeps its historical adviser (per-adviser history is never
    -- rewritten), but a successor + call task must land with someone who still works here. Keep
    -- r.assigned_to only while that profile is live staff; otherwise hand it to the first Owner.
    assignee := case when exists (select 1 from profiles p where p.id = r.assigned_to
                                    and p.role in ('owner','admin','adviser','staff'))
                     then r.assigned_to else owner_id end;  -- R84 (F4)

    insert into cases (client_id, case_kind, stage, lender, rate_percent, rate_type,
                       rate_end_date, rate_end_estimated, retention_source_case_id, assigned_to,
                       property_address)
    values (r.client_id, r.case_kind, 'enquiry', r.lender, r.rate_percent, r.rate_type,
            r.rate_end_date, r.rate_end_estimated, r.id, assignee,  -- R84 (F4)
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
    -- R84 (F2): suppress_automation (Consumer Duty care flag) and comms_optout (unsubscribe link)
    -- now gate the rate-end email + chase exactly as they gate every other automated lane. The
    -- successor case, its note and the adviser's call task are still created — the human follow-up
    -- is precisely what a suppressed client should get instead of automated mail.
    if not r.rate_ended and r.email is not null and r.email <> ''
       and not coalesce(r.suppress_automation,false) and not coalesce(r.comms_optout,false) then  -- R84 (F2)
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
    if sms_on and not r.rate_ended and r.phone is not null and r.phone <> '' and not coalesce(r.sms_opt_out,false)
       and not coalesce(r.suppress_automation,false) and not coalesce(r.comms_optout,false) then  -- R84 (F2): same care gate for SMS
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
            case when r.email is null or r.email = '' then ' (no email on file!)' else '' end, task_due, assignee);  -- R84 (F4)

    update cases set rate_reminder_queued_at = now() where id = r.id;
    if r.rate_ended then
      n_recovery := n_recovery + 1;
    else
      n_created := n_created + 1;
    end if;
  end loop;

  -- Review requests (set an NPS token so the email's rating links are tamper-checked)
  if get_setting_on('nps_enabled') then  -- R84 (F5)
    with due as (
      select c.id, c.client_id, cl.email
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and c.completed_at <= now() - (review_delay || ' days')::interval
        and c.review_requested_at is null and not coalesce(cl.comms_optout,false)
        and cl.email is not null and cl.email <> '' and not coalesce(cl.suppress_automation,false)
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
  -- R84 (F1): the Settings form writes auto_referral as "1"/"0" (bool10); the old `= 'on'` test
  -- meant this lane could never fire. Now tolerant, AND drip-fed 5 per run like review requests —
  -- 42 completed cases were eligible on the day of the fix and must not all leave in one run.
  if get_setting_on('auto_referral') and promo_ok then  -- R84 (F1/F5)
    with due as (
      select c.id, c.client_id, cl.email
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed'
        and c.review_requested_at is not null
        and c.review_requested_at <= now() - (referral_delay || ' days')::interval
        and c.referral_requested_at is null
        and c.completed_at >= now() - interval '12 months'
        and cl.email is not null and cl.email <> '' and not coalesce(cl.marketing_opt_out,false) and not coalesce(cl.comms_optout,false)
        and not coalesce(cl.suppress_automation,false)
      order by c.review_requested_at  -- R84 (F1): oldest review request first
      limit 5                         -- R84 (F1): drip, matching the review-request lane
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

commit;
