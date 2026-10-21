-- 20260704190903_protection_introducers_events — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Protection cross-sell + lead source
alter table public.cases add column if not exists protection_status text not null default 'not_discussed';
alter table public.cases add column if not exists lead_source text;

-- Introducers
create table public.introducers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  created_at timestamptz not null default now()
);
alter table public.cases add column if not exists introducer_id uuid references public.introducers on delete set null;

-- Roles
alter table public.profiles add column if not exists role text not null default 'staff';
alter table public.profiles add column if not exists introducer_id uuid references public.introducers on delete set null;

-- New self-signups get NO access until approved (invited users get a role set explicitly)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''), 'none')
  on conflict (id) do nothing;
  return new;
end $$;

-- Append-only case event log
create table public.case_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  event text not null,
  detail text,
  actor uuid,
  created_at timestamptz not null default now()
);
create index on public.case_events (case_id, created_at);

create or replace function public.log_case_event() returns trigger
language plpgsql security definer set search_path = public as $$
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
  return new;
end $$;
create trigger cases_log_insert after insert on public.cases for each row execute function public.log_case_event();
create trigger cases_log_update after update on public.cases for each row execute function public.log_case_event();

create or replace function public.log_email_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' and new.case_id is not null then
    insert into case_events (case_id, event, detail)
    values (new.case_id, 'email_sent', new.email_type || ' to ' || coalesce(new.to_email,'') || coalesce(' — "' || new.subject || '"', ''));
  end if;
  return new;
end $$;
create trigger email_log_sent after update on public.email_queue for each row execute function public.log_email_event();

-- Ensure Daniel's profile exists and is staff
insert into public.profiles (id, email, full_name, role)
select id, email, 'Daniel Potts', 'staff' from auth.users where email = 'daniel@nexmoney.co.uk'
on conflict (id) do update set role = 'staff';
