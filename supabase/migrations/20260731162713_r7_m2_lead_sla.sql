-- 20260731162713_r7_m2_lead_sla — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R7-2: speed-to-lead SLA plumbing.
-- (a) first-contact timestamps on leads, (b) an instant auto-acknowledgement
-- queued the moment a website lead lands (when it carries an email address).

alter table public.leads
  add column if not exists acknowledged_at timestamptz,
  add column if not exists first_contact_at timestamptz;

comment on column public.leads.acknowledged_at is 'When the automatic acknowledgement email was actually sent.';
comment on column public.leads.first_contact_at is 'When a human first made contact (drives time-to-first-contact reporting).';

-- New email type for the acknowledgement.
alter type public.email_type add value if not exists 'lead_ack';

-- The queue has no way to point at a lead (a lead is not yet a client or a
-- case), so give it one. Nullable, mirrors the existing child-reference style.
alter table public.email_queue
  add column if not exists lead_id uuid references public.leads(id) on delete set null;

create index if not exists email_queue_lead_id_idx on public.email_queue (lead_id);

-- Queue the acknowledgement on insert. Mirrors auto_stage_comms(): security
-- definer, fixed search_path, only fires when there is somewhere to send it.
create or replace function public.queue_lead_ack()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.email is not null and btrim(new.email) <> '' then
    insert into email_queue (lead_id, email_type, to_email)
    values (new.id, 'lead_ack', btrim(new.email));
  end if;
  return new;
end $function$;

revoke all on function public.queue_lead_ack() from public;
grant execute on function public.queue_lead_ack() to service_role;

drop trigger if exists leads_ack_email on public.leads;
create trigger leads_ack_email after insert on public.leads
  for each row execute function queue_lead_ack();
