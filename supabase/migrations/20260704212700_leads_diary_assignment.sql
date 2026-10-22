-- 20260704212700_leads_diary_assignment — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Assignment / handoff
alter table public.cases add column if not exists assigned_to uuid references public.profiles;
alter table public.case_tasks add column if not exists assigned_to uuid references public.profiles;

-- Website leads inbox
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  enquiry_type text,
  property_value text,
  message text,
  source_page text,
  status text not null default 'new', -- new | converted | discarded
  converted_case_id uuid references public.cases on delete set null,
  created_at timestamptz not null default now()
);
alter table public.leads enable row level security;
create policy "staff all" on public.leads for all to authenticated using (is_staff()) with check (is_staff());

-- Diary
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  client_id uuid references public.clients on delete set null,
  case_id uuid references public.cases on delete set null,
  staff_id uuid references public.profiles,
  starts_at timestamptz not null,
  ends_at timestamptz,
  location text,
  notes text,
  created_at timestamptz not null default now()
);
create index on public.appointments (starts_at);
alter table public.appointments enable row level security;
create policy "staff all" on public.appointments for all to authenticated using (is_staff()) with check (is_staff());

-- Log assignment changes in the case event log
create or replace function public.log_case_event() returns trigger
language plpgsql security definer set search_path = public as $$
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
    values (new.id, 'fee_status_changed', old.fee_status || ' → ' || new.fee_status, auth.uid());
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
    values (new.id, 'protection_status_changed', old.protection_status || ' → ' || new.protection_status, auth.uid());
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    select coalesce(nullif(full_name,''), email) into who from profiles where id = new.assigned_to;
    insert into case_events (case_id, event, detail, actor)
    values (new.id, 'case_assigned', coalesce(who, 'unassigned'), auth.uid());
  end if;
  return new;
end $$;
