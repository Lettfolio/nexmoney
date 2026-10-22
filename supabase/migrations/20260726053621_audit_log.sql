-- 20260726053621_audit_log — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- =====================================================================
-- audit_log — a complete, append-only, database-written record of who
-- changed what and when. Written by triggers, so it captures every
-- write path: the back office UI, edge functions, the cron automation,
-- a direct SQL correction, or any future integration.
--
-- case_events remains the curated human timeline shown on a case.
-- audit_log is the forensic record underneath it.
-- =====================================================================

create table if not exists public.audit_log (
  id            bigint generated always as identity primary key,
  happened_at   timestamptz not null default now(),
  actor         uuid,                 -- auth.uid(); null = automation/service role
  actor_label   text not null,        -- name snapshot, survives the profile being deleted
  action        text not null check (action in ('insert','update','delete')),
  table_name    text not null,
  row_id        text,                 -- text so it covers uuid PKs and settings' text key
  -- Denormalised for fast lookups. DELIBERATELY NOT foreign keys: an audit
  -- row must outlive the record it describes.
  case_id       uuid,
  client_id     uuid,
  summary       text not null,
  changes       jsonb not null default '{}'::jsonb
);

create index if not exists audit_log_happened_idx on public.audit_log (happened_at desc);
create index if not exists audit_log_row_idx      on public.audit_log (table_name, row_id, happened_at desc);
create index if not exists audit_log_case_idx     on public.audit_log (case_id, happened_at desc) where case_id is not null;
create index if not exists audit_log_client_idx   on public.audit_log (client_id, happened_at desc) where client_id is not null;
create index if not exists audit_log_actor_idx    on public.audit_log (actor, happened_at desc);

alter table public.audit_log enable row level security;

-- Read: staff see the operational history. Changes to settings and
-- profiles (bank details, the promotions switch, who has access, who
-- holds which role) are Owner-only.
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select using (
  case when table_name in ('settings','profiles') then is_owner() else is_staff() end
);

-- No insert / update / delete policy exists, so under RLS nobody can
-- forge, amend or erase an entry. Rows arrive only via the SECURITY
-- DEFINER trigger below.
revoke insert, update, delete on public.audit_log from authenticated, anon;

-- ---------------------------------------------------------------------
-- Who is acting
-- ---------------------------------------------------------------------
create or replace function public.audit_actor_label()
returns text language sql stable security definer set search_path to 'public' as
$$ select coalesce(
     (select nullif(trim(coalesce(full_name,'')),'') from profiles where id = auth.uid()),
     (select email from profiles where id = auth.uid()),
     case when auth.uid() is null then 'System (automation)' else 'Unknown user' end
   ) $$;

-- ---------------------------------------------------------------------
-- Generic row auditor
-- ---------------------------------------------------------------------
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path to 'public' as
$audit$
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
$audit$;

-- ---------------------------------------------------------------------
-- Attach. Everything an administrator or adviser can change by hand.
-- ---------------------------------------------------------------------
drop trigger if exists audit_clients      on public.clients;
drop trigger if exists audit_cases        on public.cases;
drop trigger if exists audit_case_tasks   on public.case_tasks;
drop trigger if exists audit_case_notes   on public.case_notes;
drop trigger if exists audit_appointments on public.appointments;
drop trigger if exists audit_settings     on public.settings;
drop trigger if exists audit_profiles     on public.profiles;
drop trigger if exists audit_introducers  on public.introducers;

create trigger audit_clients      after insert or update or delete on public.clients      for each row execute function public.audit_row();
create trigger audit_cases        after insert or update or delete on public.cases        for each row execute function public.audit_row();
create trigger audit_case_tasks   after insert or update or delete on public.case_tasks   for each row execute function public.audit_row();
create trigger audit_case_notes   after insert or update or delete on public.case_notes   for each row execute function public.audit_row();
create trigger audit_appointments after insert or update or delete on public.appointments for each row execute function public.audit_row();
create trigger audit_settings     after insert or update or delete on public.settings     for each row execute function public.audit_row();
create trigger audit_profiles     after insert or update or delete on public.profiles     for each row execute function public.audit_row();
create trigger audit_introducers  after insert or update or delete on public.introducers  for each row execute function public.audit_row();
