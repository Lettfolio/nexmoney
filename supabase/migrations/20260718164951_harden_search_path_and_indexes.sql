-- 20260718164951_harden_search_path_and_indexes — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Advisor 0011: pin search_path on the two functions flagged (both run inside SECURITY DEFINER contexts).
CREATE OR REPLACE FUNCTION public.get_setting(k text)
 RETURNS text LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$ select value from public.settings where key = k $function$;

CREATE OR REPLACE FUNCTION public.touch_case()
 RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
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
end $function$;

-- Advisor 0003: wrap auth.uid() in a scalar subquery so it is evaluated once, not per row.
DROP POLICY IF EXISTS "own profile" ON public.profiles;
CREATE POLICY "own profile" ON public.profiles FOR SELECT TO authenticated
  USING (id = (select auth.uid()));

-- Advisor 0001: covering indexes for foreign keys used in joins/filters.
CREATE INDEX IF NOT EXISTS idx_cases_client_id ON public.cases(client_id);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_to ON public.cases(assigned_to);
CREATE INDEX IF NOT EXISTS idx_cases_introducer_id ON public.cases(introducer_id);
CREATE INDEX IF NOT EXISTS idx_cases_retention_source ON public.cases(retention_source_case_id);
CREATE INDEX IF NOT EXISTS idx_case_notes_case_id ON public.case_notes(case_id);
CREATE INDEX IF NOT EXISTS idx_case_notes_created_by ON public.case_notes(created_by);
CREATE INDEX IF NOT EXISTS idx_case_tasks_case_id ON public.case_tasks(case_id);
CREATE INDEX IF NOT EXISTS idx_case_tasks_assigned_to ON public.case_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_case_tasks_open_due ON public.case_tasks(due_date) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_case_events_case_id ON public.case_events(case_id);
CREATE INDEX IF NOT EXISTS idx_email_queue_case_id ON public.email_queue(case_id);
CREATE INDEX IF NOT EXISTS idx_email_queue_client_id ON public.email_queue(client_id);
CREATE INDEX IF NOT EXISTS idx_email_queue_status_sched ON public.email_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_appointments_case_id ON public.appointments(case_id);
CREATE INDEX IF NOT EXISTS idx_appointments_client_id ON public.appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_id ON public.appointments(staff_id);
CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON public.appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_open ON public.watch_alerts(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cases_rate_end ON public.cases(rate_end_date) WHERE retention_source_case_id IS NULL;
