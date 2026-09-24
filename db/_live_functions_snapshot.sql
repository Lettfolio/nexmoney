-- db/_live_functions_snapshot.sql — every function in production public schema (Supabase project sclghkmvzpwtmnzbkaoe),
-- as pg_get_functiondef() prints it. Snapshot taken 24 Sep 2026 (R91 tidy; R90 took the 17 the app probes, R91 added the
-- other 23 incl. the R86 pair get_team_mfa/session_ok). Evidence for the retired migration layer (HARNESS.md, R90 · A);
-- not applied by anything. Refresh: select proname, prosecdef, pg_get_functiondef(oid) from pg_proc where pronamespace =
-- (select oid from pg_namespace where nspname = 'public') order by proname.

-- ===== ai_usage_bump (secdef=True) =====
CREATE OR REPLACE FUNCTION public.ai_usage_bump(p_uid uuid, p_fn text, p_bytes bigint)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  insert into public.ai_usage as u (uid, day, fn, calls, bytes)
  values (p_uid, (now() at time zone 'Europe/London')::date, p_fn, 1, greatest(p_bytes, 0))
  on conflict (uid, day, fn) do update
    set calls = u.calls + 1,
        bytes = u.bytes + greatest(excluded.bytes, 0),
        updated_at = now()
  returning calls;
$function$


-- ===== audit_actor_label (secdef=True) =====
CREATE OR REPLACE FUNCTION public.audit_actor_label()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select coalesce(
     (select nullif(trim(coalesce(full_name,'')),'') from profiles where id = auth.uid()),
     (select email from profiles where id = auth.uid()),
     case when auth.uid() is null then 'System (automation)' else 'Unknown user' end
   ) $function$


-- ===== audit_row (secdef=True) =====
CREATE OR REPLACE FUNCTION public.audit_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  j_old      jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  j_new      jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  rec        jsonb := case when tg_op = 'DELETE' then j_old else j_new end;
  diff       jsonb := '{}'::jsonb;
  k          text;
  v_old      jsonb;
  v_new      jsonb;
  -- Columns that change on every write and carry no meaning on their own.
  noise      text[] := array['updated_at','last_seen_at','claimed_at'];
  -- Settings keys whose values must never be copied in clear into a
  -- second table. We record THAT they changed, not what to.
  sensitive  boolean := false;
  fields     text[] := '{}';
  label      text;
  v_case     uuid;
  v_client   uuid;
  v_rowid    text;
  human      text;
begin
  if tg_table_name = 'settings' then
    sensitive := (rec->>'key') ~* '(bank|account|sort_code|secret|token|api|key|password)';
  end if;

  -- Build the field-level diff.
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(j_new) loop
      if k = any(noise) then continue; end if;
      v_old := j_old -> k;
      v_new := j_new -> k;
      if v_old is distinct from v_new then
        fields := fields || k;
        diff := diff || jsonb_build_object(k, jsonb_build_object(
          'old', case when sensitive then to_jsonb('(hidden)'::text) else v_old end,
          'new', case when sensitive then to_jsonb('(hidden)'::text) else v_new end
        ));
      end if;
    end loop;
    -- Nothing of substance changed (e.g. an upsert that rewrote identical
    -- values) — do not manufacture an audit entry.
    if diff = '{}'::jsonb then
      return new;
    end if;
  else
    if sensitive then
      diff := jsonb_build_object('value', to_jsonb('(hidden)'::text));
    else
      diff := rec;
    end if;
  end if;

  -- Identify the row and hang it off a case / client where we can.
  v_rowid := coalesce(rec->>'id', rec->>'key');
  v_case := case when tg_table_name = 'cases' then (rec->>'id')::uuid
                 else nullif(rec->>'case_id','')::uuid end;
  v_client := case when tg_table_name = 'clients' then (rec->>'id')::uuid
                   else nullif(rec->>'client_id','')::uuid end;

  -- A readable one-liner, so the history is legible without tooling.
  label := case tg_table_name
    when 'clients'      then trim(coalesce(rec->>'first_name','') || ' ' || coalesce(rec->>'last_name',''))
    when 'cases'        then coalesce(rec->>'lender','case') || ' · ' || coalesce(rec->>'stage','')
    when 'case_tasks'   then coalesce(rec->>'title','task')
    when 'case_notes'   then left(coalesce(rec->>'body','note'), 60)
    when 'appointments' then coalesce(rec->>'title','appointment')
    when 'settings'     then coalesce(rec->>'key','setting')
    when 'profiles'     then coalesce(nullif(rec->>'full_name',''), rec->>'email', 'user')
    when 'introducers'  then coalesce(rec->>'name','introducer')
    else tg_table_name end;

  human := audit_actor_label() || ' ' ||
           case tg_op when 'INSERT' then 'created' when 'UPDATE' then 'changed' else 'deleted' end ||
           ' ' || replace(tg_table_name, '_', ' ') || ' "' || coalesce(label,'') || '"' ||
           case when tg_op = 'UPDATE' and array_length(fields,1) is not null
                then ' (' || array_to_string(fields, ', ') || ')' else '' end;

  insert into public.audit_log
    (actor, actor_label, action, table_name, row_id, case_id, client_id, summary, changes)
  values
    (auth.uid(), audit_actor_label(), lower(tg_op), tg_table_name, v_rowid,
     v_case, v_client, human, diff);

  return case when tg_op = 'DELETE' then old else new end;
end
$function$


-- ===== audit_vault_row (secdef=True) =====
CREATE OR REPLACE FUNCTION public.audit_vault_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  redact jsonb;
  actor_label text;
begin
  select coalesce(full_name, email) into actor_label from profiles where id = auth.uid();
  if actor_label is null then actor_label := 'System / import'; end if;
  redact := (
    select coalesce(jsonb_agg(
      case when coalesce((f->>'secret')::boolean, true)
           then jsonb_build_object('label', f->>'label', 'value', '(hidden)')
           else f end), '[]'::jsonb)
    from jsonb_array_elements(coalesce(case when TG_OP='DELETE' then OLD.fields else NEW.fields end, '[]'::jsonb)) f
  );
  insert into audit_log (actor, actor_label, action, table_name, row_id, summary, changes)
  values (
    auth.uid(), actor_label,
    lower(TG_OP), 'vault_entries',
    coalesce(NEW.id, OLD.id)::text,
    coalesce(NEW.name, OLD.name) || ' (' || coalesce(NEW.category, OLD.category) || ')',
    jsonb_build_object('name', coalesce(NEW.name, OLD.name),
                       'owner', coalesce(NEW.owner_label, OLD.owner_label),
                       'fields', redact)
  );
  return coalesce(NEW, OLD);
end $function$


-- ===== auto_protection_triggers (secdef=True) =====
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
end $function$


-- ===== auto_stage_comms (secdef=True) =====
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
end $function$


-- ===== cancel_retention_touches (secdef=True) =====
CREATE OR REPLACE FUNCTION public.cancel_retention_touches()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.stage in ('completed','not_proceeding') and old.stage is distinct from new.stage then
    update email_queue set status = 'cancelled'
    where case_id = new.id and status = 'queued'
      and email_type in ('rate_end_reminder','rate_end_chase');

    if new.stage = 'not_proceeding' then
      update case_tasks set done_at = now()
      where case_id = new.id and done_at is null;
    else
      -- completed: only auto-close the retention "call client — rate ends" task,
      -- leave GI / protection / solicitor tasks live.
      update case_tasks set done_at = now()
      where case_id = new.id and done_at is null
        and title like 'Call client — rate ends%';
    end if;
  end if;
  return new;
end $function$


-- ===== find_duplicate_clients (secdef=True) =====
CREATE OR REPLACE FUNCTION public.find_duplicate_clients()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
end $function$


-- ===== get_briefing (secdef=True) =====
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
end $function$


-- ===== get_dashboard_counts (secdef=True) =====
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
    select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')
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
$function$


-- ===== get_data_quality (secdef=True) =====
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
end $function$


-- ===== get_protection_pipeline (secdef=True) =====
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
end $function$


-- ===== get_protection_pipeline_total (secdef=True) =====
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
end $function$


-- ===== get_reports (secdef=True) =====
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin')) then
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
end $function$


-- ===== get_setting (secdef=False) =====
CREATE OR REPLACE FUNCTION public.get_setting(k text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$ select value from public.settings where key = k $function$


-- ===== get_setting_on (secdef=False) =====
CREATE OR REPLACE FUNCTION public.get_setting_on(k text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- R84 (F5): 'on' / '1' / 'true' in any case or padding are ON; NULL / missing / anything else is OFF.
  select coalesce(lower(btrim((select value from public.settings where key = k))) in ('on','1','true'), false)
$function$


-- ===== get_staff_activity (secdef=True) =====
CREATE OR REPLACE FUNCTION public.get_staff_activity()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
$function$


-- ===== get_team_mfa (secdef=True) =====
CREATE OR REPLACE FUNCTION public.get_team_mfa()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  -- R86: Owner/Administrator only, and only from a session that has verified its second factor.
  if uid is null or not exists (
    select 1 from profiles where id = uid and role in ('owner','admin') and public.session_ok()
  ) then
    raise exception 'permission denied: get_team_mfa is for the Owner and Administrators' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',          p.id,
      'full_name',   p.full_name,
      'role',        p.role,
      'mfa_on',      (f.enrolled_at is not null),
      'enrolled_at', f.enrolled_at
    ) order by p.full_name)
    from profiles p
    left join lateral (
      select min(m.created_at) as enrolled_at
        from auth.mfa_factors m
       where m.user_id = p.id and m.status = 'verified'
    ) f on true
    where p.role in ('owner','admin','adviser','staff')
  ), '[]'::jsonb);
end;
$function$


-- ===== guard_role_change (secdef=True) =====
CREATE OR REPLACE FUNCTION public.guard_role_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change a role';
    end if;
  end if;

  -- R11 BE-2: an introducer login must not be able to repoint itself at a
  -- different introducer (tenant isolation).
  if tg_op = 'UPDATE' and new.introducer_id is distinct from old.introducer_id then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change which introducer a login belongs to';
    end if;
  end if;

  if (tg_op = 'UPDATE' and old.role = 'owner' and new.role is distinct from 'owner')
     or (tg_op = 'DELETE' and old.role = 'owner') then
    if (select count(*) from profiles where role = 'owner') <= 1 then
      raise exception 'Cannot remove the last Owner — promote someone else first';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$function$


-- ===== handle_new_user (secdef=True) =====
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''), 'none')
  on conflict (id) do nothing;
  return new;
end $function$


-- ===== has_bank_details (secdef=True) =====
CREATE OR REPLACE FUNCTION public.has_bank_details()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select coalesce(
     (select value from settings where key = 'bank_account_name'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_sort_code'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_account_number'), '') <> '' $function$


-- ===== is_admin_or_owner (secdef=True) =====
CREATE OR REPLACE FUNCTION public.is_admin_or_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin'))
     and public.session_ok()   -- R86
$function$


-- ===== is_owner (secdef=True) =====
CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner'))
     and public.session_ok()   -- R86
$function$


-- ===== is_staff (secdef=True) =====
CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff'))
     and public.session_ok()   -- R86
$function$


-- ===== log_case_event (secdef=True) =====
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
end $function$


-- ===== log_email_event (secdef=True) =====
CREATE OR REPLACE FUNCTION public.log_email_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and new.case_id is not null then
    insert into case_events (case_id, event, detail)
    values (new.case_id, 'email_sent', new.email_type || ' to ' || coalesce(new.to_email,'') || coalesce(' — "' || new.subject || '"', ''));
  end if;
  return new;
end $function$


-- ===== log_fact_find_submit (secdef=True) =====
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
end $function$


-- ===== mark_tour_seen (secdef=True) =====
CREATE OR REPLACE FUNCTION public.mark_tour_seen()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update profiles set tour_seen_at = now()
  where id = auth.uid() and tour_seen_at is null;
$function$


-- ===== my_introducer_id (secdef=True) =====
CREATE OR REPLACE FUNCTION public.my_introducer_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select introducer_id from profiles where id = auth.uid() and role = 'introducer' $function$


-- ===== my_role (secdef=True) =====
CREATE OR REPLACE FUNCTION public.my_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select role from profiles where id = auth.uid() $function$


-- ===== queue_appointment_sms (secdef=True) =====
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
    where cl.phone is not null and cl.phone <> '' and not coalesce(cl.sms_opt_out,false) and not coalesce(cl.suppress_automation,false)
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
end $function$


-- ===== queue_automated_emails (secdef=True) =====
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
end $function$


-- ===== queue_comms_extras (secdef=True) =====
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
end $function$


-- ===== queue_lead_ack (secdef=True) =====
CREATE OR REPLACE FUNCTION public.queue_lead_ack()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.email is not null and btrim(new.email) <> '' then
    insert into email_queue (lead_id, email_type, to_email)
    values (new.id, 'lead_ack', btrim(new.email));
  end if;
  return new;
end $function$


-- ===== reassign_holdings (secdef=True) =====
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
  if not public.is_owner() then
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
$function$


-- ===== run_watchtower (secdef=True) =====
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
end $function$


-- ===== session_ok (secdef=True) =====
CREATE OR REPLACE FUNCTION public.session_ok()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r text := (select role from profiles where id = auth.uid());
  enforced boolean;
begin
  -- R86: no profile (signed out, unknown login) → never ok
  if r is null then
    return false;
  end if;
  -- R86: is this role in settings.mfa_enforced_roles? (comma list; each element trimmed;
  -- compared lower-cased; '' or a missing row = nobody enforced = the break-glass)
  enforced := lower(btrim(r)) = any (
    select lower(btrim(x))
      from unnest(string_to_array(coalesce((select value from settings where key = 'mfa_enforced_roles'), ''), ',')) as x
  );
  if not enforced then
    return true;
  end if;
  -- R86: enforced → only a session that verified its second factor (JWT aal = 'aal2')
  return coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
end
$function$


-- ===== touch_case (secdef=False) =====
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
end $function$


-- ===== touch_client (secdef=False) =====
CREATE OR REPLACE FUNCTION public.touch_client()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  return new;
end $function$


-- ===== touch_vault_updated (secdef=False) =====
CREATE OR REPLACE FUNCTION public.touch_vault_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$ begin new.updated_at := now(); return new; end $function$
