-- 20260704161623_initial_schema — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- NexMoney Back Office: initial schema

create type case_stage as enum ('enquiry','fact_find','decision_in_principle','application','offer','exchange','completed','not_proceeding');
create type case_kind as enum ('purchase','remortgage','product_transfer','buy_to_let','first_time_buyer','other');
create type fee_status as enum ('not_requested','requested','paid','waived');
create type email_type as enum ('rate_end_reminder','review_request','fee_request');
create type email_status as enum ('queued','sent','failed','cancelled');

-- Profiles (one per auth user)
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  full_name text,
  email text,
  created_at timestamptz not null default now()
);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  address text,
  notes text,
  created_at timestamptz not null default now()
);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients on delete cascade,
  case_kind case_kind not null default 'remortgage',
  stage case_stage not null default 'enquiry',
  lender text,
  product_name text,
  loan_amount numeric,
  property_value numeric,
  rate_percent numeric,
  rate_type text default 'fixed',
  rate_end_date date,
  erc_end_date date,
  term_years int,
  broker_fee numeric,
  fee_status fee_status not null default 'not_requested',
  fee_requested_at timestamptz,
  fee_paid_at timestamptz,
  review_requested_at timestamptz,
  rate_reminder_queued_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.cases (stage);
create index on public.cases (rate_end_date);

create table public.case_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  body text not null,
  created_by uuid references public.profiles,
  created_at timestamptz not null default now()
);

create table public.email_queue (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.cases on delete set null,
  client_id uuid references public.clients on delete set null,
  email_type email_type not null,
  status email_status not null default 'queued',
  to_email text,
  subject text,
  body_html text,
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index on public.email_queue (status, scheduled_for);

create table public.settings (
  key text primary key,
  value text not null default ''
);

insert into public.settings (key, value) values
 ('company_name','NexMoney'),
 ('from_email','NexMoney <onboarding@resend.dev>'),
 ('reply_to_email','danielpotts@live.com'),
 ('bank_account_name','NexMoney'),
 ('bank_sort_code',''),
 ('bank_account_number',''),
 ('google_review_link',''),
 ('rate_reminder_months','6'),
 ('review_delay_days','3'),
 ('adviser_name','Daniel'),
 ('adviser_phone','');

-- updated_at + completed_at maintenance
create or replace function public.touch_case() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.stage = 'completed' and old.stage is distinct from 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;
create trigger cases_touch before update on public.cases
for each row execute function public.touch_case();

-- Auto-create profile on signup
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- RLS: authenticated users have full access (small trusted team)
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.cases enable row level security;
alter table public.case_notes enable row level security;
alter table public.email_queue enable row level security;
alter table public.settings enable row level security;

create policy "auth all" on public.profiles for all to authenticated using (true) with check (true);
create policy "auth all" on public.clients for all to authenticated using (true) with check (true);
create policy "auth all" on public.cases for all to authenticated using (true) with check (true);
create policy "auth all" on public.case_notes for all to authenticated using (true) with check (true);
create policy "auth all" on public.email_queue for all to authenticated using (true) with check (true);
create policy "auth all" on public.settings for all to authenticated using (true) with check (true);
