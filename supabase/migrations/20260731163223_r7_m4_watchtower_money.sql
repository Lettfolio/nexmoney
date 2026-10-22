-- 20260731163223_r7_m4_watchtower_money — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R7-4: Watchtower money rules.
--  * Rule 4 (lead_slow) already implemented the speed-to-lead SLA thresholds
--    (warn 1h / crit 24h), so it is EXTENDED, not duplicated: it now ignores
--    leads a human has already contacted and shows the acknowledgement time.
--  * Rule 9  fee_aging_60         — fees unpaid 60 days after completion.
--  * Rule 10 protection_quote_stale — quotes going cold.

create or replace function public.run_watchtower()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

  -- Rule 9: money owed — fees still unpaid 60 days after completion.
  -- "Unpaid" = an amount is recorded, no *_fee_paid_at stamp, and (for the
  -- broker fee, the only one carrying a status) not already paid or waived.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'fee_aging_60','warn',
    'Fees unpaid 60 days after completion: ' || btrim(cl.first_name||' '||cl.last_name),
    array_to_string(f.parts, ', ') || ' · £' || to_char(f.total,'FM999G999G990D00') ||
      ' outstanding · completed ' || to_char(c.completed_at,'DD Mon YYYY') ||
      ' (' || (current_date - c.completed_at::date) || 'd)',
    c.id, c.client_id, 'fee_aging_60:'||c.id, clock_timestamp()
  from cases c
  join clients cl on cl.id = c.client_id
  join lateral (
    select array_remove(array[
             case when coalesce(c.broker_fee,0) > 0 and c.broker_fee_paid_at is null
                       and c.fee_status not in ('paid','waived')
                  then 'broker £' || to_char(c.broker_fee,'FM999G999G990D00') end,
             case when coalesce(c.proc_fee,0) > 0 and c.proc_fee_paid_at is null
                  then 'proc £' || to_char(c.proc_fee,'FM999G999G990D00') end,
             case when coalesce(c.sols_fee,0) > 0 and c.sols_fee_paid_at is null
                  then 'sols £' || to_char(c.sols_fee,'FM999G999G990D00') end
           ], null) as parts,
           (case when coalesce(c.broker_fee,0) > 0 and c.broker_fee_paid_at is null
                      and c.fee_status not in ('paid','waived') then c.broker_fee else 0 end)
         + (case when coalesce(c.proc_fee,0) > 0 and c.proc_fee_paid_at is null then c.proc_fee else 0 end)
         + (case when coalesce(c.sols_fee,0) > 0 and c.sols_fee_paid_at is null then c.sols_fee else 0 end) as total
  ) f on true
  where c.stage = 'completed'
    and c.completed_at is not null
    and c.completed_at < now() - interval '60 days'
    and coalesce(array_length(f.parts,1),0) > 0
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
end $function$;

revoke all on function public.run_watchtower() from public;
grant execute on function public.run_watchtower() to authenticated, service_role;
