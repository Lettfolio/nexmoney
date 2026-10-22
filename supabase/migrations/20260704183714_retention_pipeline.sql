-- 20260704183714_retention_pipeline — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Link retention opportunities to the completed case they came from
alter table public.cases add column if not exists retention_source_case_id uuid references public.cases on delete set null;
create index on public.cases (retention_source_case_id) where retention_source_case_id is not null;

-- Simple case tasks (call reminders etc.)
create table public.case_tasks (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases on delete cascade,
  title text not null,
  due_date date,
  done_at timestamptz,
  created_by uuid references public.profiles,
  created_at timestamptz not null default now()
);
create index on public.case_tasks (done_at, due_date);
alter table public.case_tasks enable row level security;
create policy "auth all" on public.case_tasks for all to authenticated using (true) with check (true);

-- When a retention case is won or lost, cancel outstanding touches
create or replace function public.cancel_retention_touches() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.stage in ('completed','not_proceeding') and old.stage is distinct from new.stage then
    update email_queue set status = 'cancelled'
    where case_id = new.id and status = 'queued'
      and email_type in ('rate_end_reminder','rate_end_chase');
    update case_tasks set done_at = now()
    where case_id = new.id and done_at is null;
  end if;
  return new;
end $$;
create trigger cases_cancel_retention after update on public.cases
for each row execute function public.cancel_retention_touches();

-- Rewritten daily automation: retention sweep + review requests
create or replace function public.queue_automated_emails() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  reminder_months int := coalesce(nullif(get_setting('rate_reminder_months'),'')::int, 6);
  review_delay int := coalesce(nullif(get_setting('review_delay_days'),'')::int, 3);
  r record;
  new_case uuid;
  touch2_at timestamptz;
  task_due date;
  n_created int := 0;
  n_reviews int := 0;
begin
  -- 1. Retention sweep: completed cases whose rate end has entered the window
  for r in
    select c.id, c.client_id, c.case_kind, c.lender, c.rate_percent, c.rate_type,
           c.rate_end_date, c.rate_end_estimated, cl.email
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.rate_end_date is not null
      and c.rate_end_date >= current_date
      and c.rate_end_date <= current_date + (reminder_months || ' months')::interval
      and c.rate_reminder_queued_at is null
      and not exists (select 1 from cases rc where rc.retention_source_case_id = c.id)
  loop
    insert into cases (client_id, case_kind, stage, lender, rate_percent, rate_type,
                       rate_end_date, rate_end_estimated, retention_source_case_id)
    values (r.client_id, r.case_kind, 'enquiry', r.lender, r.rate_percent, r.rate_type,
            r.rate_end_date, r.rate_end_estimated, r.id)
    returning id into new_case;

    insert into case_notes (case_id, body)
    values (new_case, 'Retention opportunity auto-created — current ' || coalesce(r.lender,'') ||
            ' deal ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY'));

    if r.email is not null and r.email <> '' then
      -- touch 1: reminder now
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new_case, r.client_id, 'rate_end_reminder', r.email);
      -- touch 2: chase, roughly a month before the 5-months-to-go mark, only if sensibly before rate end
      touch2_at := greatest(now() + interval '21 days', r.rate_end_date::timestamptz - interval '5 months');
      if touch2_at < r.rate_end_date::timestamptz - interval '14 days' then
        insert into email_queue (case_id, client_id, email_type, to_email, scheduled_for)
        values (new_case, r.client_id, 'rate_end_chase', r.email, touch2_at);
      end if;
    end if;

    -- touch 3: call task
    task_due := greatest(least(greatest(current_date + 35, r.rate_end_date - 120), r.rate_end_date - 14), current_date + 1);
    insert into case_tasks (case_id, title, due_date)
    values (new_case, 'Call client — rate ends ' || to_char(r.rate_end_date, 'DD/MM/YYYY') ||
            case when r.email is null or r.email = '' then ' (no email on file!)' else '' end, task_due);

    update cases set rate_reminder_queued_at = now() where id = r.id;
    n_created := n_created + 1;
  end loop;

  -- 2. Review requests after completion (unchanged)
  with due as (
    select c.id, c.client_id, cl.email
    from cases c join clients cl on cl.id = c.client_id
    where c.stage = 'completed'
      and c.completed_at is not null
      and c.completed_at <= now() - (review_delay || ' days')::interval
      and c.review_requested_at is null
      and cl.email is not null and cl.email <> ''
  ), ins as (
    insert into email_queue (case_id, client_id, email_type, to_email)
    select id, client_id, 'review_request', email from due
    returning case_id
  )
  update cases set review_requested_at = now()
  where id in (select case_id from ins);
  get diagnostics n_reviews = row_count;

  return jsonb_build_object('retention_created', n_created, 'review_requests_queued', n_reviews);
end $$;
