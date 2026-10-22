-- 20260704222834_submissions_and_fees — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

alter table public.cases add column if not exists submitted_at date;
alter table public.cases add column if not exists proc_fee numeric;
alter table public.cases add column if not exists sols_fee numeric;
create index on public.cases (submitted_at);

-- Auto-stamp submitted date when a case reaches Application
create or replace function public.touch_case() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if new.stage = 'completed' and old.stage is distinct from 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  if new.stage in ('application','offer','exchange','completed') and new.submitted_at is null
     and old.stage in ('enquiry','fact_find','decision_in_principle') then
    new.submitted_at := current_date;
  end if;
  return new;
end $$;
