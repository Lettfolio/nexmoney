-- 20260710103320_protection_phase_one — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Phase one: protection & GI sales engine

alter table public.cases add column if not exists protection_commission numeric;
alter table public.cases add column if not exists gi_status text not null default 'not_discussed';

insert into public.settings(key, value) values
  ('protection_gate','on'),
  ('auto_protection_email',''),
  ('auto_gi_email',''),
  ('protection_avg_commission','850')
on conflict (key) do nothing;

-- Ranked protection/GI opportunity pipeline
create or replace function public.get_protection_pipeline(p_scope text default 'all')
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  uid uuid := auth.uid();
  avg_comm numeric := coalesce(nullif(get_setting('protection_avg_commission'),'')::numeric, 850);
begin
  if not exists (select 1 from profiles where id = uid and role = 'staff') then
    return '[]'::jsonb;
  end if;

  return coalesce((select jsonb_agg(x order by (x->>'score')::numeric desc) from (
    select jsonb_build_object(
      'case_id', c.id,
      'client_id', c.client_id,
      'client_name', btrim(cl.first_name || ' ' || cl.last_name),
      'has_email', (cl.email is not null and cl.email <> ''),
      'stage', c.stage,
      'case_kind', c.case_kind,
      'lender', c.lender,
      'loan_amount', c.loan_amount,
      'protection_status', c.protection_status,
      'gi_status', c.gi_status,
      'live', (c.stage not in ('completed','not_proceeding')),
      'owner', c.assigned_to,
      'est_commission', round(avg_comm * case
          when coalesce(c.loan_amount,0) < 100000 then 0.7
          when c.loan_amount < 250000 then 1.0
          when c.loan_amount < 500000 then 1.3
          else 1.6 end),
      'score',
        -- stage urgency
        case c.stage
          when 'offer' then 100 when 'exchange' then 95 when 'application' then 90
          when 'decision_in_principle' then 80 when 'fact_find' then 70
          when 'enquiry' then 50 when 'completed' then 30 else 0 end
        -- warm quotes float up
        + case when c.protection_status = 'quoted' then 15
               when c.protection_status = 'discussed' then 5 else 0 end
        -- bigger loans first (0..20)
        + least(coalesce(c.loan_amount,0) / 50000, 20)
        -- contactable clients first
        + case when cl.email is not null and cl.email <> '' then 3 else 0 end
    ) as x
    from cases c
    join clients cl on cl.id = c.client_id
    where c.protection_status in ('not_discussed','discussed','quoted')
      and c.stage <> 'not_proceeding'
      and c.retention_source_case_id is null
      and (p_scope <> 'mine' or c.assigned_to = uid or c.assigned_to is null)
    limit 250) s), '[]'::jsonb);
end $$;
revoke all on function public.get_protection_pipeline(text) from public;
grant execute on function public.get_protection_pipeline(text) to authenticated;

-- Stage-triggered selling moments (separate trigger, coexists with auto_stage_comms)
create or replace function public.auto_protection_triggers()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  cl_email text;
begin
  if new.stage is not distinct from old.stage then return new; end if;
  select email into cl_email from clients where id = new.client_id;

  -- Offer issued: the natural protection moment
  if new.stage = 'offer' and coalesce(new.protection_status,'not_discussed') in ('not_discussed','discussed') then
    if not exists (select 1 from case_tasks where case_id = new.id
                   and title = 'Protection conversation — mortgage agreed' and done_at is null) then
      insert into case_tasks (case_id, title, due_date, assigned_to)
      values (new.id, 'Protection conversation — mortgage agreed', current_date + 2, new.assigned_to);
    end if;
    if get_setting('auto_protection_email') = 'on'
       and cl_email is not null and cl_email <> ''
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
      values (new.id, 'Arrange buildings/GI cover before completion', current_date + 3, new.assigned_to);
    end if;
    if get_setting('auto_gi_email') = 'on'
       and cl_email is not null and cl_email <> ''
       and not exists (select 1 from email_queue where case_id = new.id and email_type = 'gi_exchange') then
      insert into email_queue (case_id, client_id, email_type, to_email)
      values (new.id, new.client_id, 'gi_exchange', cl_email);
    end if;
  end if;

  return new;
end $$;

drop trigger if exists cases_protection_triggers on public.cases;
create trigger cases_protection_triggers
  after update on public.cases
  for each row execute function public.auto_protection_triggers();
