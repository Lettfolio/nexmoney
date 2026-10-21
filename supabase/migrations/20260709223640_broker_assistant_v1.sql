-- 20260709223640_broker_assistant_v1 — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Broker Assistant v1: case_emails, assistant_actions, sync_state, get_briefing RPC

create table if not exists public.case_emails (
  id uuid primary key default gen_random_uuid(),
  graph_id text unique,
  mailbox text not null,
  client_id uuid references public.clients(id) on delete set null,
  case_id uuid references public.cases(id) on delete set null,
  direction text not null default 'inbound' check (direction in ('inbound','outbound')),
  from_email text,
  from_name text,
  subject text,
  snippet text,
  received_at timestamptz,
  web_link text,
  triage_status text not null default 'new' check (triage_status in ('new','handled','ignored')),
  created_at timestamptz not null default now()
);
create index if not exists case_emails_triage_idx on public.case_emails (triage_status, received_at desc);
create index if not exists case_emails_client_idx on public.case_emails (client_id);
create index if not exists case_emails_case_idx on public.case_emails (case_id);
alter table public.case_emails enable row level security;
drop policy if exists case_emails_staff on public.case_emails;
create policy case_emails_staff on public.case_emails
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create table if not exists public.assistant_actions (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.profiles(id),
  kind text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
alter table public.assistant_actions enable row level security;
drop policy if exists assistant_actions_staff on public.assistant_actions;
create policy assistant_actions_staff on public.assistant_actions
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

create table if not exists public.sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table public.sync_state enable row level security;
drop policy if exists sync_state_staff_read on public.sync_state;
create policy sync_state_staff_read on public.sync_state
  for select to authenticated using (public.is_staff());

insert into public.settings(key, value) values ('outlook_enabled','0'), ('outlook_mailboxes','')
on conflict (key) do nothing;

create or replace function public.get_briefing(p_scope text default 'mine')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  items jsonb := '[]'::jsonb;
begin
  if not exists (select 1 from profiles where id = uid and role = 'staff') then
    return '[]'::jsonb;
  end if;

  -- Tasks due/overdue
  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind', case when t.due_date < current_date then 'task_overdue' else 'task_today' end,
      'pri',  case when t.due_date < current_date then 10 else 20 end,
      'title', t.title,
      'sub', btrim(cl.first_name || ' ' || cl.last_name) || coalesce(' · ' || c.lender, ''),
      'case_id', t.case_id, 'task_id', t.id, 'due', t.due_date, 'owner', t.assigned_to) as x
    from case_tasks t
    join cases c on c.id = t.case_id
    join clients cl on cl.id = c.client_id
    where t.done_at is null and t.due_date <= current_date
      and (p_scope = 'all' or t.assigned_to = uid or t.assigned_to is null)
    order by t.due_date limit 20) s), '[]'::jsonb);

  -- New website leads (always shown to all staff)
  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','lead_new','pri',15,
      'title','New lead: ' || l.name,
      'sub', coalesce(l.enquiry_type,'enquiry') || coalesce(' · ' || l.email, ''),
      'lead_id', l.id, 'due', l.created_at::date) as x
    from leads l where l.status = 'new'
    order by l.created_at limit 20) s), '[]'::jsonb);

  -- Untriaged client emails
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

  -- Today's appointments
  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','appt_today','pri',25,
      'title', to_char(a.starts_at at time zone 'Europe/London','HH24:MI') || ' — ' || a.title,
      'sub', coalesce(btrim(cl.first_name || ' ' || cl.last_name), ''),
      'appt_id', a.id, 'case_id', a.case_id, 'client_id', a.client_id) as x
    from appointments a
    left join clients cl on cl.id = a.client_id
    where (a.starts_at at time zone 'Europe/London')::date = current_date
      and (p_scope = 'all' or a.staff_id = uid or a.staff_id is null)
    order by a.starts_at limit 20) s), '[]'::jsonb);

  -- Rate ends within 60 days (or already ended)
  items := items || coalesce((select jsonb_agg(x) from (
    select jsonb_build_object(
      'kind','rate_urgent',
      'pri', case when c.rate_end_date < current_date then 12 else 30 end,
      'title','Rate ends ' || to_char(c.rate_end_date,'DD Mon') || ' — ' || btrim(cl.first_name || ' ' || cl.last_name),
      'sub', coalesce(c.lender,'') || ' · ' || (c.rate_end_date - current_date) || 'd'
             || case when c.rate_reminder_queued_at is null then ' · not contacted' else '' end,
      'case_id', c.id, 'client_id', c.client_id,
      'days', c.rate_end_date - current_date, 'owner', c.assigned_to) as x
    from cases c join clients cl on cl.id = c.client_id
    where c.rate_end_date is not null
      and c.retention_source_case_id is null
      and c.stage <> 'not_proceeding'
      and c.rate_end_date - current_date <= 60
      and (p_scope = 'all' or c.assigned_to = uid or c.assigned_to is null)
    order by c.rate_end_date limit 15) s), '[]'::jsonb);

  -- Stalled active cases (no activity for 10+ days)
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

  -- Fee chases (requested 7+ days ago, still unpaid)
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
end $$;

revoke all on function public.get_briefing(text) from public;
grant execute on function public.get_briefing(text) to authenticated;
