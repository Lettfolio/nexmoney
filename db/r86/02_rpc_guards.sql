-- =============================================================================
-- R86 · 02 · every SECURITY DEFINER RPC with a caller path now requires session_ok()
--
-- WHAT: fourteen CREATE OR REPLACE statements, each body copied VERBATIM from the live
--       definition (pg_get_functiondef, snapshot 2026-09-08) with ONLY the caller guard changed
--       (tagged `-- R86`). A diff of this file against the live bodies shows only those lines.
--       Each function keeps its own refusal shape:
--         get_briefing / get_protection_pipeline / get_staff_activity /
--         find_duplicate_clients ..... return '[]'::jsonb
--         get_reports / get_data_quality ............ return '{}'::jsonb
--         get_protection_pipeline_total ............. return {"total": 0}
--         get_dashboard_counts ...................... RAISE 42501
--         reassign_holdings ......................... RAISE 42501 (is_owner() already carries
--                                                     session_ok() after 01; stated here too so
--                                                     the guard reads whole)
--         run_watchtower ............................ {"error":"forbidden"} — ONLY on the
--                                                     signed-in-caller branch; the cron /
--                                                     service-role path (auth.uid() null) is
--                                                     byte-for-byte as today
--         has_bank_details .......................... false (a boolean, not an error)
--         mark_tour_seen ............................ no-op (the UPDATE matches no row)
--         queue_automated_emails / queue_comms_extras (R86 · V, P2) ... had NO caller guard: they
--                                                     gain the run_watchtower-pattern guard as
--                                                     their FIRST statement — a signed-in caller
--                                                     who is not verified staff gets '{}'::jsonb
--                                                     (both RETURN jsonb); cron (uid null) untouched
-- WHY:  RLS (01) covers every table read through PostgREST, but a SECURITY DEFINER function
--       reads as its owner: without this file an owner at aal1 could still pull the briefing,
--       the reports and the pipeline through the RPC door — or queue a night's emails.
-- RULE FROM HERE ON (HARNESS.md R86): any NEW RPC guard must include public.session_ok().
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select proname from pg_proc
--    where pronamespace = 'public'::regnamespace and prosrc like '%session_ok()%' order by 1;
--   -- expect exactly these 18 rows (01 + this file + 03; session_ok itself does not name
--   -- itself in its body, so it is NOT in the list):
--   --   find_duplicate_clients, get_briefing, get_dashboard_counts, get_data_quality,
--   --   get_protection_pipeline, get_protection_pipeline_total, get_reports,
--   --   get_staff_activity, get_team_mfa, has_bank_details, is_admin_or_owner, is_owner,
--   --   is_staff, mark_tour_seen, queue_automated_emails, queue_comms_extras,
--   --   reassign_holdings, run_watchtower
--   -- and the cron paths are intact (all three keep the null-uid short-circuit):
--   select proname, (pg_get_functiondef(p.oid) like '%if auth.uid() is not null%') cron_branch_kept
--     from pg_proc p where pronamespace = 'public'::regnamespace
--      and proname in ('run_watchtower','queue_automated_emails','queue_comms_extras');
-- =============================================================================
begin;

-- ----- get_briefing (live body, guard line tagged R86) -----
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
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

-- ----- get_reports (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_reports()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  yr int := extract(year from current_date);
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin') and public.session_ok()) then  -- R86
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    -- Weighted pipeline: expected fee income from live cases by stage probability.
    'forecast', (
      select jsonb_build_object(
        'weighted_total', coalesce(round(sum((coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)) * p.prob)),0),
        'gross_total', coalesce(round(sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0))),0),
        'by_stage', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'stage', s.stage, 'cases', s.n,
            'gross', round(s.gross), 'weighted', round(s.weighted)) order by s.ord), '[]'::jsonb)
          from (
            select c2.stage,
                   case c2.stage when 'enquiry' then 1 when 'fact_find' then 2 when 'decision_in_principle' then 3
                        when 'application' then 4 when 'offer' then 5 when 'exchange' then 6 end as ord,
                   count(*) n,
                   sum(coalesce(c2.broker_fee,0)+coalesce(c2.proc_fee,0)) gross,
                   sum((coalesce(c2.broker_fee,0)+coalesce(c2.proc_fee,0)) *
                       case c2.stage when 'enquiry' then 0.10 when 'fact_find' then 0.20 when 'decision_in_principle' then 0.35
                            when 'application' then 0.60 when 'offer' then 0.85 when 'exchange' then 0.95 else 0 end) weighted
            from cases c2
            where c2.stage in ('enquiry','fact_find','decision_in_principle','application','offer','exchange')
            group by c2.stage
          ) s
        )
      )
      from cases c
      join (values ('enquiry',0.10),('fact_find',0.20),('decision_in_principle',0.35),
                   ('application',0.60),('offer',0.85),('exchange',0.95)) as p(stage,prob)
        on p.stage = c.stage::text
    ),

    -- Per-adviser scoreboard.
    'advisers', (
      select coalesce(jsonb_agg(x order by (x->>'fees_banked_ytd')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'staff_id', pr.id,
          'name', coalesce(nullif(pr.full_name,''), pr.email),
          'open_cases', (select count(*) from cases c where c.assigned_to = pr.id and c.stage not in ('completed','not_proceeding')),
          'completions_ytd', (select count(*) from cases c where c.assigned_to = pr.id and c.stage='completed' and extract(year from c.completed_at)=yr),
          'fees_banked_ytd', (select coalesce(round(sum(coalesce(c.broker_fee,0))),0) from cases c where c.assigned_to = pr.id and extract(year from coalesce(c.broker_fee_paid_at, c.fee_paid_at))=yr),
          'proc_ytd', (select coalesce(round(sum(coalesce(c.proc_fee,0))),0) from cases c where c.assigned_to = pr.id and c.stage='completed' and extract(year from c.completed_at)=yr),
          'overdue_tasks', (select count(*) from case_tasks t where t.assigned_to = pr.id and t.done_at is null and t.due_date < current_date),
          'avg_days_to_complete', (select round(avg(extract(epoch from (c.completed_at - c.created_at))/86400)) from cases c where c.assigned_to = pr.id and c.stage='completed' and c.completed_at is not null)
        ) as x
        from profiles pr where pr.role in ('owner','admin','adviser','staff')
      ) q
    ),

    -- Lead-source ROI: which sources actually produce completed revenue.
    'lead_sources', (
      select coalesce(jsonb_agg(x order by (x->>'revenue')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'source', src,
          'cases', count(*),
          'completed', count(*) filter (where stage='completed'),
          'conversion', case when count(*)>0 then round(100.0*count(*) filter (where stage='completed')/count(*)) else 0 end,
          'revenue', coalesce(round(sum((coalesce(broker_fee,0)+coalesce(proc_fee,0)) ) filter (where stage='completed')),0)
        ) as x
        from (select coalesce(nullif(btrim(lead_source),''),'(not set)') src, stage, broker_fee, proc_fee from cases) c
        group by src
      ) q
    ),

    -- Client lifetime value: total fees + commission across all a client's cases.
    'client_ltv', (
      select coalesce(jsonb_agg(x order by (x->>'ltv')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'client_id', cl.id,
          'name', btrim(cl.first_name||' '||cl.last_name),
          'cases', count(c.id),
          'ltv', coalesce(round(sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)+coalesce(c.protection_commission,0))),0)
        ) as x
        from clients cl join cases c on c.client_id = cl.id
        where c.stage = 'completed'
        group by cl.id, cl.first_name, cl.last_name
        having sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)+coalesce(c.protection_commission,0)) > 0
        -- R84 (F6): was `order by 1 desc` = ordering the jsonb OBJECT, which only matched ltv by the
        -- accident of 'ltv' being the shortest key. Order by the number the limit is meant to cut on.
        order by sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)+coalesce(c.protection_commission,0)) desc  -- R84 (F6)
        limit 20
      ) q
    )
  );
end $function$;

-- ----- get_protection_pipeline (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_protection_pipeline(p_scope text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  avg_comm numeric := coalesce(nullif(get_setting('protection_avg_commission'),'')::numeric, 850);
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '[]'::jsonb;
  end if;
  if not is_admin_or_owner() then
    p_scope := 'mine';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'case_id', s.id, 'client_id', s.client_id, 'client_name', s.client_name,
      'has_email', s.has_email, 'stage', s.stage, 'case_kind', s.case_kind,
      'lender', s.lender, 'loan_amount', s.loan_amount,
      'protection_status', s.protection_status, 'gi_status', s.gi_status,
      'live', s.live, 'owner', s.owner, 'est_commission', s.est_commission, 'score', s.score
    ) order by s.score desc) from (
    select c.id, c.client_id,
      btrim(cl.first_name || ' ' || cl.last_name) as client_name,
      (cl.email is not null and cl.email <> '') as has_email,
      c.stage, c.case_kind, c.lender, c.loan_amount, c.protection_status, c.gi_status,
      (c.stage not in ('completed','not_proceeding')) as live,
      c.assigned_to as owner,
      round(avg_comm * case
          when coalesce(c.loan_amount,0) < 100000 then 0.7
          when c.loan_amount < 250000 then 1.0
          when c.loan_amount < 500000 then 1.3
          else 1.6 end) as est_commission,
      (case c.stage
          when 'offer' then 100 when 'exchange' then 95 when 'application' then 90
          when 'decision_in_principle' then 80 when 'fact_find' then 70
          when 'enquiry' then 50 when 'completed' then 30 else 0 end
        + case when c.protection_status = 'quoted' then 15
               when c.protection_status = 'discussed' then 5 when c.protection_status = 'referred' then 10 else 0 end
        + least(coalesce(c.loan_amount,0) / 50000, 20)
        + case when cl.email is not null and cl.email <> '' then 3 else 0 end) as score
    from cases c
    join clients cl on cl.id = c.client_id
    where c.protection_status in ('not_discussed','discussed','quoted','referred')
      and c.stage <> 'not_proceeding'
      and c.retention_source_case_id is null
      and (p_scope <> 'mine' or c.assigned_to = uid or c.assigned_to is null)
    order by (case c.stage
          when 'offer' then 100 when 'exchange' then 95 when 'application' then 90
          when 'decision_in_principle' then 80 when 'fact_find' then 70
          when 'enquiry' then 50 when 'completed' then 30 else 0 end
        + case when c.protection_status = 'quoted' then 15
               when c.protection_status = 'discussed' then 5 when c.protection_status = 'referred' then 10 else 0 end
        + least(coalesce(c.loan_amount,0) / 50000, 20)
        + case when cl.email is not null and cl.email <> '' then 3 else 0 end) desc
    limit 250) s), '[]'::jsonb);
end $function$;

-- ----- get_protection_pipeline_total (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_protection_pipeline_total(p_scope text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  n bigint;
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return jsonb_build_object('total', 0);
  end if;
  if not is_admin_or_owner() then
    p_scope := 'mine';
  end if;
  select count(*) into n
  from cases c join clients cl on cl.id = c.client_id
  where c.protection_status in ('not_discussed','discussed','quoted','referred')
    and c.stage <> 'not_proceeding'
    and c.retention_source_case_id is null
    and (p_scope <> 'mine' or c.assigned_to = uid or c.assigned_to is null);
  return jsonb_build_object('total', n);
end $function$;

-- ----- get_data_quality (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_data_quality()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  sent_ever boolean;
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '{}'::jsonb;
  end if;
  select exists(select 1 from email_queue where status = 'sent') into sent_ever;

  return jsonb_build_object(
    'clients_total', (select count(*) from clients),
    'missing_email', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', btrim(first_name||' '||last_name)) order by last_name), '[]'::jsonb)
                      from (select id, first_name, last_name from clients where (email is null or email = '')
                            and exists (select 1 from cases c where c.client_id = clients.id and c.stage <> 'not_proceeding')
                            limit 300) q),
    'missing_email_count', (select count(*) from clients where (email is null or email = '')),
    'missing_phone_count', (select count(*) from clients where (phone is null or phone = '')),
    'missing_both_count', (select count(*) from clients where (email is null or email = '') and (phone is null or phone = '')),
    'live_unassigned', (select coalesce(jsonb_agg(jsonb_build_object('case_id', c.id, 'name', btrim(cl.first_name||' '||cl.last_name), 'stage', c.stage) order by c.updated_at desc), '[]'::jsonb)
                        from cases c join clients cl on cl.id = c.client_id
                        where c.assigned_to is null and c.stage not in ('completed','not_proceeding')),
    'completed_missing_fee', (select coalesce(jsonb_agg(jsonb_build_object('case_id', c.id, 'name', btrim(cl.first_name||' '||cl.last_name)) order by c.completed_at desc), '[]'::jsonb)
                        from cases c join clients cl on cl.id = c.client_id
                        where c.stage = 'completed' and coalesce(c.broker_fee,0) = 0 and coalesce(c.proc_fee,0) = 0 and c.fee_status <> 'waived'
                        limit 200),
    'completed_missing_rate_end', (select count(*) from cases c
                        where c.stage = 'completed' and c.rate_end_date is null
                          and coalesce(c.rate_type,'') not in ('tracker','variable')
                          and c.retention_source_case_id is null
                          -- R45 (a): not a mortgage record at all
                          and not (c.loan_amount is null and c.mortgage_account_number is null)
                          -- R45 (b): superseded by a newer completed deal on the same property
                          and not exists (select 1 from cases n
                                          where n.client_id = c.client_id and n.stage = 'completed' and n.id <> c.id
                                            and n.property_address is not null and c.property_address is not null
                                            and lower(regexp_replace(n.property_address,'[^a-zA-Z0-9]','','g'))
                                              = lower(regexp_replace(c.property_address,'[^a-zA-Z0-9]','','g'))
                                            and n.completed_at > c.completed_at)),
    'emails_stuck', (select count(*) from email_queue where status = 'queued' and scheduled_for < now() - interval '2 hours'),
    'emails_sending_live', sent_ever,
    'emails_failed', (select count(*) from email_queue where status = 'failed')
  );
end $function$;

-- ----- get_staff_activity (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_staff_activity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'has_signed_in', (u.last_sign_in_at is not null),
      'last_sign_in_at', u.last_sign_in_at,
      'invited_at', u.created_at
    ) order by p.full_name)
    from profiles p left join auth.users u on u.id = p.id
  ), '[]'::jsonb);
end;
$function$;

-- ----- get_dashboard_counts (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.get_dashboard_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  out jsonb;
begin
  -- R85: the house staff guard (get_briefing's test), raising rather than returning empty.
  if uid is null or not exists (
    select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()  -- R86
  ) then
    raise exception 'permission denied: get_dashboard_counts is for staff' using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- renderOpsStrip: email_queue status = 'queued'
    'queued_emails',      (select count(*) from email_queue where status = 'queued'),
    -- renderOpsStrip: email_queue status = 'failed'
    'failed_emails',      (select count(*) from email_queue where status = 'failed'),
    -- renderOpsStrip: sms_queue status = 'queued'
    'queued_sms',         (select count(*) from sms_queue where status = 'queued'),
    -- renderOpsStrip: leads status = 'new'
    'new_leads',          (select count(*) from leads where status = 'new'),
    -- renderOpsStrip: the doc-chase's terminal call task, still open (DOC_OVERDUE_TITLE prefix)
    'docs_overdue_tasks', (select count(*) from case_tasks
                             where done_at is null and title like 'Documents overdue — call %'),
    -- loadWatchtower: every unresolved alert (snoozed included)
    'open_watch_alerts',  (select count(*) from watch_alerts where resolved_at is null),
    -- maybeStartTour / renderWhatsNewBand: the caller's own flag
    'tour_seen_at',       (select p.tour_seen_at from profiles p where p.id = uid),
    -- refreshHeartbeatKeys: HEARTBEAT_KEYS, presence-keyed
    'heartbeat',          coalesce((select jsonb_object_agg(s.key, s.value) from settings s
                                     where s.key in ('last_cron_run_at', 'last_full_export_at')), '{}'::jsonb)
  ) into out;
  return out;
end;
$function$;

-- ----- find_duplicate_clients (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.find_duplicate_clients()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'score')::numeric desc)
    from (
      select jsonb_build_object(
        'a_id', a.id, 'a_name', btrim(a.first_name||' '||a.last_name), 'a_email', a.email,
        'b_id', b.id, 'b_name', btrim(b.first_name||' '||b.last_name), 'b_email', b.email,
        'reason', case when a.email is not null and lower(a.email) = lower(b.email) then 'same email' else 'similar name' end,
        'score', round(greatest(
          case when a.email is not null and lower(a.email) = lower(b.email) then 1 else 0 end,
          similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name)))
        )::numeric, 2)
      ) as x
      from clients a
      join clients b on a.id < b.id
      where (a.email is not null and b.email is not null and lower(a.email) = lower(b.email))
         or (lower(btrim(a.first_name||' '||a.last_name)) % lower(btrim(b.first_name||' '||b.last_name))
             and similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name))) > 0.6)
      limit 100
    ) s), '[]'::jsonb);
end $function$;

-- ----- reassign_holdings (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.reassign_holdings(p_from uuid, p_to uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_cases int := 0;
  v_tasks int := 0;
  v_appts int := 0;
  v_now   timestamptz := now();
begin
  if not public.is_owner() or not public.session_ok() then  -- R86
    raise exception 'Only an Owner can hand over a colleague''s work'
      using errcode = '42501';
  end if;

  if p_from is null or p_to is null then
    raise exception 'Both the person leaving and the person receiving the work are required'
      using errcode = '22004';
  end if;

  if p_from = p_to then
    raise exception 'Cannot hand work over to the same person'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'The person receiving the work has no profile'
      using errcode = '23503';
  end if;

  update public.cases
     set assigned_to = p_to
   where assigned_to = p_from
     and stage not in ('completed', 'not_proceeding');
  get diagnostics v_cases = row_count;

  update public.case_tasks
     set assigned_to = p_to
   where assigned_to = p_from
     and done_at is null;
  get diagnostics v_tasks = row_count;

  update public.appointments
     set staff_id = p_to
   where staff_id = p_from
     and starts_at >= v_now;
  get diagnostics v_appts = row_count;

  return jsonb_build_object('cases', v_cases, 'tasks', v_tasks, 'appointments', v_appts);
end;
$function$;

-- ----- run_watchtower (live body, guard line tagged R86) -----
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
     and not exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
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

  -- Rule 5 (R65): client email unanswered 24h+ — ONE alert per CLIENT, not per message.
  -- Three emails from one client used to be three rows; now one row counts them and names the
  -- latest. Emails with no client_id keep the old per-email key so they still surface.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(l.from_name,''), l.from_email, '(unknown sender)'),
    g.n || case when g.n = 1 then ' message' else ' messages' end || ' waiting · latest "'
      || coalesce(l.subject,'(no subject)') || '" received '
      || to_char(l.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    l.case_id, g.client_id, 'email_unanswered:c:'||g.client_id, clock_timestamp()
  from (select client_id, count(*) n, max(received_at) latest
        from case_emails
        where triage_status = 'new' and received_at < now() - interval '24 hours' and client_id is not null
        group by client_id) g
  join lateral (select * from case_emails e
                where e.client_id = g.client_id and e.triage_status = 'new'
                  and e.received_at < now() - interval '24 hours'
                order by e.received_at desc limit 1) l on true
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(e.from_name,''), e.from_email, '(unknown sender)'),
    '1 message waiting · latest "' || coalesce(e.subject,'(no subject)') || '" received '
      || to_char(e.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    e.case_id, null, 'email_unanswered:'||e.id, clock_timestamp()
  from case_emails e
  where e.triage_status = 'new' and e.received_at < now() - interval '24 hours' and e.client_id is null
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
    n || ' task' || case when n = 1 then '' else 's' end || ' overdue',
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

  -- Rule 11 (R65): the offer runs out before the date the client was told they would complete.
  -- The single most avoidable re-application in the business; both dates are already on the case.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'offer_before_completion',
    case when (c.offer_expiry_date - current_date) <= 30 then 'crit' else 'warn' end,
    'Offer expires before completion: ' || btrim(cl.first_name||' '||cl.last_name),
    'Offer expires ' || to_char(c.offer_expiry_date,'DD Mon YYYY')
      || ' · completion expected ' || to_char(c.expected_completion_date,'DD Mon YYYY')
      || ' — ' || (c.expected_completion_date - c.offer_expiry_date)
      || case when (c.expected_completion_date - c.offer_expiry_date) = 1 then ' day' else ' days' end || ' short',
    c.id, c.client_id, 'offer_before_completion:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.stage in ('offer','exchange')
    and c.offer_expiry_date is not null and c.expected_completion_date is not null
    and c.offer_expiry_date < c.expected_completion_date
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 12 (R65): a retention successor completing while the OLD rate's ERC still runs — the
  -- client pays the charge nobody budgeted for. The source case carries the ERC date.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'erc_before_completion','warn',
    'Completing inside the old rate''s ERC: ' || btrim(cl.first_name||' '||cl.last_name),
    'Old rate''s ERC runs until ' || to_char(s.erc_end_date,'DD Mon YYYY')
      || ' · completion expected ' || to_char(c.expected_completion_date,'DD Mon YYYY')
      || ' — ' || (s.erc_end_date - c.expected_completion_date)
      || case when (s.erc_end_date - c.expected_completion_date) = 1 then ' day' else ' days' end || ' early',
    c.id, c.client_id, 'erc_before_completion:'||c.id, clock_timestamp()
  from cases c
  join cases s on s.id = c.retention_source_case_id
  join clients cl on cl.id = c.client_id
  where c.stage not in ('completed','not_proceeding')
    and c.expected_completion_date is not null
    and s.erc_end_date is not null
    and c.expected_completion_date < s.erc_end_date
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

-- ----- has_bank_details (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.has_bank_details()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select public.session_ok() and coalesce(  -- R86
     (select value from settings where key = 'bank_account_name'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_sort_code'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_account_number'), '') <> '' $function$;

-- ----- mark_tour_seen (live body, guard line tagged R86) -----
CREATE OR REPLACE FUNCTION public.mark_tour_seen()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update profiles set tour_seen_at = now()
  where id = auth.uid() and tour_seen_at is null and public.session_ok();  -- R86
$function$;

-- ----- queue_automated_emails (live body, guard line tagged R86) -----
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
  -- R86 · V (P2): the run_watchtower guard — a SIGNED-IN caller who is not verified staff gets an
  -- empty result; the cron / service-role path (auth.uid() null) is untouched.
  if auth.uid() is not null
     and not exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '{}'::jsonb;
  end if;
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

-- ----- queue_comms_extras (live body, guard line tagged R86) -----
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
  -- R86 · V (P2): the run_watchtower guard — a SIGNED-IN caller who is not verified staff gets an
  -- empty result; the cron / service-role path (auth.uid() null) is untouched.
  if auth.uid() is not null
     and not exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff') and public.session_ok()) then  -- R86
    return '{}'::jsonb;
  end if;
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
