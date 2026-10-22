-- 20260731181825_r7_m5_money_rule_shaping — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- r7_m5_money_rule_shaping
-- 1) run_watchtower: fee_aging_60 per-case -> single aggregate alert
-- 2) queue_automated_emails: recovery lane queues no rate-end email

CREATE OR REPLACE FUNCTION public.run_watchtower()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  run_start timestamptz := clock_timestamp();
  n_new int; n_resolved int; n_open int;
begin
  -- Authorization: block signed-in non-staff. Null uid = service role / cron = allowed.
  if auth.uid() is not null
     and not exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff')) then
    return jsonb_build_object('error', 'forbidden');
  end if;

  -- Rule 1: offer expiry risk
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'offer_stale',
    case when c.offer_expiry_date is not null and c.offer_expiry_date - current_date <= 14 then 'crit' else 'warn' end,
    'Offer expiry risk: ' || btrim(cl.first_name||' '||cl.last_name),
    coalesce('Offer expires ' || to_char(c.offer_expiry_date,'DD Mon YYYY') || ' (' || (c.offer_expiry_date - current_date) || 'd)',
             'In offer stage since ' || to_char(c.updated_at,'DD Mon') || ' with no expiry date recorded'),
    c.id, c.client_id, 'offer_stale:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.stage = 'offer'
    and ((c.offer_expiry_date is not null and c.offer_expiry_date - current_date <= 30)
      or (c.offer_expiry_date is null and c.updated_at < now() - interval '30 days'))
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 2: application with no submitted date
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'app_not_submitted','warn',
    'Application not marked submitted: ' || btrim(cl.first_name||' '||cl.last_name),
    coalesce(c.lender,'—') || ' · in application since ' || to_char(c.updated_at,'DD Mon'),
    c.id, c.client_id, 'app_not_submitted:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.stage = 'application' and c.submitted_at is null and c.updated_at < now() - interval '3 days'
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 3: exchange with no live solicitor chase
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'exchange_no_chase','warn',
    'No solicitor chase: ' || btrim(cl.first_name||' '||cl.last_name),
    'In exchange with no open chase task and none completed in 14 days',
    c.id, c.client_id, 'exchange_no_chase:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.stage = 'exchange'
    and not exists (select 1 from case_tasks t where t.case_id = c.id and t.title like 'Chase solicitors%' and t.done_at is null)
    and not exists (select 1 from case_tasks t where t.case_id = c.id and t.title like 'Chase solicitors%' and t.done_at > now() - interval '14 days')
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 4: slow lead response — the speed-to-lead SLA (warn at 1h, crit at 24h).
  -- R7: a lead a human has already contacted is not an SLA breach even if the
  -- status has not been moved on yet, and the detail now shows whether the
  -- automatic acknowledgement went out.
  insert into watch_alerts (rule, severity, title, detail, lead_id, dedupe_key, last_seen_at)
  select 'lead_slow',
    case when l.created_at < now() - interval '24 hours' then 'crit' else 'warn' end,
    'Lead waiting: ' || l.name,
    'Website lead received ' || to_char(l.created_at at time zone 'Europe/London','DD Mon HH24:MI') || ' — not yet accepted or discarded' ||
      case when l.acknowledged_at is null then ''
           else ' (auto-acknowledged ' || to_char(l.acknowledged_at at time zone 'Europe/London','DD Mon HH24:MI') || ')' end,
    l.id, 'lead_slow:'||l.id, clock_timestamp()
  from leads l
  where l.status = 'new' and l.created_at < now() - interval '1 hour'
    and l.first_contact_at is null
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 5: client email unanswered 24h+
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(e.from_name,''), e.from_email),
    coalesce(e.subject,'(no subject)') || ' · received ' || to_char(e.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    e.case_id, e.client_id, 'email_unanswered:'||e.id, clock_timestamp()
  from case_emails e
  where e.triage_status = 'new' and e.received_at < now() - interval '24 hours'
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 6: fee ageing
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'fee_aging',
    case when c.fee_requested_at < now() - interval '30 days' then 'crit' else 'warn' end,
    'Fee outstanding: ' || btrim(cl.first_name||' '||cl.last_name),
    coalesce('£'||c.broker_fee::text,'') || ' · requested ' || to_char(c.fee_requested_at,'DD Mon'),
    c.id, c.client_id, 'fee_aging:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.fee_status = 'requested' and c.fee_requested_at < now() - interval '14 days'
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 7: adviser workload (5+ overdue tasks)
  insert into watch_alerts (rule, severity, title, detail, staff_id, dedupe_key, last_seen_at)
  select 'workload','warn',
    'Overdue tasks piling up: ' || coalesce(p.full_name, p.email),
    n || ' tasks overdue',
    p.id, 'workload:'||p.id, clock_timestamp()
  from (select assigned_to, count(*) n from case_tasks
        where done_at is null and due_date < current_date and assigned_to is not null
        group by assigned_to having count(*) >= 5) w
  join profiles p on p.id = w.assigned_to
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 8: retention coverage gap (aggregate)
  insert into watch_alerts (rule, severity, title, detail, dedupe_key, last_seen_at)
  select 'retention_gap','info',
    n || ' client' || case when n = 1 then '' else 's' end || ' with rates ending ≤90 days not yet contacted',
    'Rate-end reminders not queued — see the Rates panel / My Day',
    'retention_gap:global', clock_timestamp()
  from (select count(*) n from cases c
        where c.rate_end_date between current_date and current_date + 90
          and c.rate_reminder_queued_at is null
          and c.retention_source_case_id is null
          and c.stage <> 'not_proceeding') s
  where s.n > 0
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 9: money owed — fees still unpaid 60 days after completion (aggregate).
  -- "Unpaid" = an amount is recorded, no *_fee_paid_at stamp, and (for the
  -- broker fee, the only one carrying a status) not already paid or waived.
  -- R7-M5: was one alert per case, but no *_fee_paid_at stamp has ever been
  -- written in production, so every completed case older than 60 days with a
  -- fee recorded qualifies (111 of them) and per-case rows buried the panel.
  -- Now aggregated into a single alert, mirroring the retention_gap pattern:
  -- one dedupe_key, so the trailing auto-resolve sweep closes it the first run
  -- the balance clears.
  insert into watch_alerts (rule, severity, title, detail, dedupe_key, last_seen_at)
  select 'fee_aging_60','warn',
    'Unpaid fees ageing',
    s.n || ' completed case' || case when s.n = 1 then '' else 's' end ||
      ' with fees unpaid >60 days — £' || to_char(s.total,'FM999G999G990D00') || ' outstanding' ||
      ' (proc £' || to_char(s.proc_total,'FM999G999G990D00') ||
      ' · broker £' || to_char(s.broker_total,'FM999G999G990D00') ||
      ' · sols £' || to_char(s.sols_total,'FM999G999G990D00') || ')',
    'fee_aging_60', clock_timestamp()
  from (
    select count(*) n,
           sum(f.broker + f.proc + f.sols) as total,
           sum(f.broker) as broker_total,
           sum(f.proc) as proc_total,
           sum(f.sols) as sols_total
    from cases c
    join lateral (
      select (case when coalesce(c.broker_fee,0) > 0 and c.broker_fee_paid_at is null
                        and c.fee_status not in ('paid','waived') then c.broker_fee else 0 end) as broker,
             (case when coalesce(c.proc_fee,0) > 0 and c.proc_fee_paid_at is null then c.proc_fee else 0 end) as proc,
             (case when coalesce(c.sols_fee,0) > 0 and c.sols_fee_paid_at is null then c.sols_fee else 0 end) as sols
    ) f on true
    where c.stage = 'completed'
      and c.completed_at is not null
      and c.completed_at < now() - interval '60 days'
      and f.broker + f.proc + f.sols > 0
  ) s
  where s.n > 0
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 10: protection quote going cold (quote clock from R7-1)
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'protection_quote_stale','warn',
    'Protection quote going cold: ' || btrim(cl.first_name||' '||cl.last_name),
    case when c.protection_quoted_at is not null
         then 'Quoted ' || to_char(c.protection_quoted_at at time zone 'Europe/London','DD Mon YYYY') ||
              ' (' || (current_date - (c.protection_quoted_at at time zone 'Europe/London')::date) || 'd) with no outcome recorded'
         else 'Marked quoted with no quote date recorded · case completed ' ||
              coalesce(to_char(c.completed_at,'DD Mon YYYY'), to_char(c.updated_at,'DD Mon YYYY')) end,
    c.id, c.client_id, 'protection_quote_stale:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.protection_status = 'quoted'
    and ((c.protection_quoted_at is not null and c.protection_quoted_at < now() - interval '14 days')
      or (c.protection_quoted_at is null and c.stage = 'completed'))
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Auto-resolve anything no longer flagged this run
  update watch_alerts set resolved_at = now()
  where resolved_at is null and last_seen_at < run_start;
  get diagnostics n_resolved = row_count;

  select count(*) into n_new from watch_alerts where created_at >= run_start;
  select count(*) into n_open from watch_alerts where resolved_at is null;

  return jsonb_build_object('open', n_open, 'new', n_new, 'resolved', n_resolved);
end $function$
;

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

    -- Rate-end SMS (only when SMS enabled, phone present, not opted out)
    if sms_on and r.phone is not null and r.phone <> '' and not coalesce(r.sms_opt_out,false) then
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
