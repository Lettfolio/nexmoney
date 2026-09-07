-- =============================================================================
-- R84 · 06 · get_briefing — Europe/London calendar day (S4 finding)
--
-- WHAT: every `current_date` in the body becomes `today`, a single variable declared as
--       (now() at time zone 'Europe/London')::date. Eleven occurrences, each tagged `-- R84`.
-- WHY:  the database runs in UTC. From 00:00 to 01:00 BST, current_date was still the previous
--       day, so "due today" tasks, today's appointments (whose date IS already London-local in
--       the comparison) and the "Nd" rate-end counters were off by one for early/late users.
--       Everything else byte-identical to production (md5 fefb134f6320b8056565089c4ced3d31).
-- EFFECT: identical output outside that BST hour; correct inside it. No API/shape change.
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select (pg_get_functiondef(p.oid) not like '%current_date%') no_utc_date,
--          (pg_get_functiondef(p.oid) like '%Europe/London'')::date%') london_today,
--          prosecdef, proconfig
--     from pg_proc p where proname='get_briefing' and pronamespace='public'::regnamespace;
-- =============================================================================
begin;

CREATE OR REPLACE FUNCTION public.get_briefing(p_scope text DEFAULT 'mine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  items jsonb := '[]'::jsonb;
  -- R84: "today" is the firm's calendar day, not the UTC one. current_date is UTC on this
  -- instance, so between 00:00 and 01:00 BST it was still yesterday: tasks due today, today's
  -- appointments and the rate-end day counts were all a day out for anyone working late/early.
  today date := (now() at time zone 'Europe/London')::date;  -- R84
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return '[]'::jsonb;
  end if;

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind', case when t.due_date < today then 'task_overdue' else 'task_today' end,  -- R84: London day
      'pri',  case when t.due_date < today then 10 else 20 end,  -- R84: London day
      'title', t.title,
      'sub', btrim(cl.first_name || ' ' || cl.last_name) || coalesce(' · ' || c.lender, ''),
      'case_id', t.case_id, 'task_id', t.id, 'due', t.due_date, 'owner', t.assigned_to) as x
    from case_tasks t
    join cases c on c.id = t.case_id
    join clients cl on cl.id = c.client_id
    where t.done_at is null and t.due_date <= today  -- R84: London day
      and (p_scope = 'all' or t.assigned_to = uid or t.assigned_to is null)
    order by t.due_date limit 20) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','lead_new','pri',15,
      'title','New lead: ' || l.name,
      'sub', coalesce(l.enquiry_type,'enquiry') || coalesce(' · ' || l.email, ''),
      'lead_id', l.id, 'due', l.created_at::date) as x
    from leads l where l.status = 'new'
    order by l.created_at limit 20) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','email_new','pri',18,
      'title','Email from ' || coalesce(nullif(e.from_name,''), e.from_email, 'client'),
      'sub', coalesce(e.subject,'(no subject)'),
      'email_id', e.id, 'case_id', e.case_id, 'client_id', e.client_id,
      'due', e.received_at::date, 'owner', c.assigned_to) as x
    from case_emails e
    left join cases c on c.id = e.case_id
    where e.triage_status = 'new'
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by e.received_at desc limit 20) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','appt_today','pri',25,
      'title', to_char(a.starts_at at time zone 'Europe/London','HH24:MI') || ' — ' || a.title,
      'sub', coalesce(btrim(cl.first_name || ' ' || cl.last_name), ''),
      'appt_id', a.id, 'case_id', a.case_id, 'client_id', a.client_id) as x
    from appointments a
    left join clients cl on cl.id = a.client_id
    where (a.starts_at at time zone 'Europe/London')::date = today  -- R84: London day
      and (p_scope = 'all' or a.staff_id = uid or a.staff_id is null)
    order by a.starts_at limit 20) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','rate_urgent',
      'pri', case when c.rate_end_date < today then 12 else 30 end,  -- R84: London day
      'title', case when c.rate_end_date < today then 'Rate ended ' else 'Rate ends ' end  -- R84: London day
               || to_char(c.rate_end_date, case when extract(year from c.rate_end_date) <> extract(year from today) then 'DD Mon YYYY' else 'DD Mon' end)  -- R84: London day
               || ' — ' || btrim(cl.first_name || ' ' || cl.last_name),
      'sub', coalesce(c.lender,'') || ' · ' || (c.rate_end_date - today) || 'd'  -- R84: London day
             || case when c.rate_reminder_queued_at is null then ' · not contacted' else '' end,
      'case_id', c.id, 'client_id', c.client_id,
      'days', c.rate_end_date - today, 'owner', c.assigned_to) as x  -- R84: London day
    from cases c join clients cl on cl.id = c.client_id
    where c.rate_end_date is not null
      -- R43: a LIVE successor is still the ongoing answer and stays silent; once it completes it
      -- is a normal book case whose own rate end may alert again.
      and (c.retention_source_case_id is null or c.stage = 'completed')
      and c.stage <> 'not_proceeding'
      and c.rate_end_date - today <= 60  -- R84: London day
      -- R47: and not so long ago that it is history, not a today-action. Matches the email
      -- recovery lane's own 18-month horizon; the full lapsed book stays on the Retention page.
      and c.rate_end_date >= today - interval '18 months'  -- R84: London day
      -- R43: the source stops nagging while a LIVE successor is handling exactly this rate end.
      and not exists (select 1 from cases rc
                      where rc.retention_source_case_id = c.id
                        and rc.stage not in ('completed','not_proceeding'))
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by c.rate_end_date limit 15) s), '[]'::jsonb);

  -- Protection gaps at the hottest selling moment (offer/exchange)
  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','protection_hot','pri',35,
      'title','Protection gap: ' || btrim(cl.first_name || ' ' || cl.last_name) || ' (' || replace(c.stage::text,'_',' ') || ')',
      'sub', coalesce(c.lender,'—') || coalesce(' · £' || to_char(c.loan_amount,'FM999,999,999'),'')
             || ' · ' || replace(c.protection_status,'_',' '),
      'case_id', c.id, 'client_id', c.client_id, 'owner', c.assigned_to) as x
    from cases c join clients cl on cl.id = c.client_id
    where c.stage in ('offer','exchange')
      and c.protection_status in ('not_discussed','discussed')
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by coalesce(c.loan_amount,0) desc limit 10) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','stalled','pri',40,
      'title','Stalled: ' || btrim(cl.first_name || ' ' || cl.last_name) || ' (' || replace(c.stage::text,'_',' ') || ')',
      'sub', coalesce(c.lender,'—') || ' · last activity ' || to_char(coalesce(ev.last_ev, c.updated_at),'DD Mon'),
      'case_id', c.id, 'client_id', c.client_id, 'owner', c.assigned_to) as x
    from cases c
    join clients cl on cl.id = c.client_id
    left join lateral (select max(created_at) as last_ev from case_events where case_id = c.id) ev on true
    where c.stage in ('fact_find','decision_in_principle','application','offer','exchange')
      and coalesce(ev.last_ev, c.updated_at) < now() - interval '10 days'
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by coalesce(ev.last_ev, c.updated_at) limit 10) s), '[]'::jsonb);

  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','fee_chase','pri',45,
      'title','Fee unpaid: ' || btrim(cl.first_name || ' ' || cl.last_name),
      'sub', coalesce('£' || c.broker_fee::text,'') || ' · requested ' || to_char(c.fee_requested_at,'DD Mon'),
      'case_id', c.id, 'client_id', c.client_id, 'owner', c.assigned_to) as x
    from cases c join clients cl on cl.id = c.client_id
    where c.fee_status = 'requested'
      and c.fee_requested_at < now() - interval '7 days'
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by c.fee_requested_at limit 10) s), '[]'::jsonb);

  return (select coalesce(jsonb_agg(e order by (e->>'pri')::int, e->>'due'), '[]'::jsonb)
          from jsonb_array_elements(items) e);
end $function$;

commit;
