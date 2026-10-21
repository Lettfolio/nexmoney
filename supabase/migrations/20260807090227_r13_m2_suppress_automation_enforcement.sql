-- 20260807090227_r13_m2_suppress_automation_enforcement — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R13 (M-30): suppress_automation enforced where emails are QUEUED. Three
-- functions queue automated client emails. The two RPCs are patched mechanically
-- (their guard is uniform and counted; abort on drift). auto_stage_comms is
-- replaced explicitly because its guard is a plpgsql VARIABLE (cl_email), not a
-- joined column — a regex there would be guesswork.

do $$
declare
  fn record;
  def text;
  newdef text;
  hits int;
begin
  for fn in
    select p.oid, p.proname,
           case p.proname when 'queue_automated_emails' then 2 else 4 end as want
    from pg_proc p
    where p.proname in ('queue_automated_emails','queue_comms_extras')
  loop
    def := pg_get_functiondef(fn.oid);
    if def like '%suppress_automation%' then
      raise notice 'R13 m2: % already patched, skipping', fn.proname;
      continue;
    end if;
    hits := (select count(*) from regexp_matches(def, 'cl\.email is not null and cl\.email <> ''''', 'g'));
    if hits <> fn.want then
      raise exception 'R13 m2 aborted: % has % uniform email guards, expected % — patch by hand',
        fn.proname, hits, fn.want;
    end if;
    newdef := replace(def,
      'cl.email is not null and cl.email <> ''''',
      'cl.email is not null and cl.email <> '''' and not coalesce(cl.suppress_automation,false)');
    execute newdef;
    raise notice 'R13 m2: % patched (% guards)', fn.proname, fn.want;
  end loop;
end $$;

-- auto_stage_comms, replaced whole. Identical to the deployed version except:
-- cl_suppress is fetched alongside the email, and every email-queueing branch
-- (docs_request / submitted_update / offer_update / completion_congrats) now
-- refuses when the client is suppressed. The exchange CHASE TASK branch is
-- deliberately NOT gated — it is an internal task for staff, not client contact.
create or replace function public.auto_stage_comms()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  cl_email text;
  cl_suppress boolean;
  chase_days int := coalesce(nullif(get_setting('solicitor_chase_days'),'')::int, 7);
begin
  if new.stage is not distinct from old.stage then return new; end if;
  select email, coalesce(suppress_automation,false) into cl_email, cl_suppress
    from clients where id = new.client_id;

  -- Document request when fact find starts
  if new.stage = 'fact_find' and get_setting('auto_docs_request') = 'on'
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'docs_request') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'docs_request', cl_email);
  end if;

  -- Application submitted update
  if new.stage = 'application' and get_setting('auto_submitted_update') = 'on'
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'submitted_update') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'submitted_update', cl_email);
  end if;

  -- Offer received update
  if new.stage = 'offer' and get_setting('auto_offer_update') = 'on'
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'offer_update') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'offer_update', cl_email);
  end if;

  -- Exchange: solicitor chase task cadence (internal — not suppressed)
  if new.stage = 'exchange'
     and not exists (select 1 from case_tasks where case_id = new.id and title like 'Chase solicitors%' and done_at is null) then
    insert into case_tasks (case_id, title, due_date, assigned_to)
    values (new.id, 'Chase solicitors for completion date', current_date + chase_days, new.assigned_to);
  end if;

  -- Completion congratulations (review request follows automatically after the delay)
  if new.stage = 'completed' and get_setting('auto_completion_email') = 'on'
     and cl_email is not null and cl_email <> '' and not cl_suppress
     and not exists (select 1 from email_queue where case_id = new.id and email_type = 'completion_congrats') then
    insert into email_queue (case_id, client_id, email_type, to_email) values (new.id, new.client_id, 'completion_congrats', cl_email);
  end if;

  return new;
end $function$;
