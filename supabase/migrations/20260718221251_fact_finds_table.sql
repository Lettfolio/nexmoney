-- 20260718221251_fact_finds_table — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

CREATE TABLE IF NOT EXISTS public.fact_finds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'sent',      -- sent | started | submitted
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  submitted_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_finds_token ON public.fact_finds(token);
CREATE INDEX IF NOT EXISTS idx_fact_finds_case ON public.fact_finds(case_id);
CREATE INDEX IF NOT EXISTS idx_fact_finds_client ON public.fact_finds(client_id);

ALTER TABLE public.fact_finds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "fact_finds_staff" ON public.fact_finds;
CREATE POLICY "fact_finds_staff" ON public.fact_finds FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- log a case_event when a fact-find is submitted (reuses the append-only audit trail idea)
CREATE OR REPLACE FUNCTION public.log_fact_find_submit()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if new.status = 'submitted' and old.status is distinct from 'submitted' and new.case_id is not null then
    insert into case_events (case_id, event, detail) values (new.case_id, 'fact_find_submitted', 'Client submitted their online fact-find');
    insert into case_notes (case_id, body) values (new.case_id, 'Client submitted their online fact-find — review in the Fact-find tab.');
    insert into case_tasks (case_id, title, due_date, assigned_to)
      select new.case_id, 'Review submitted fact-find', current_date, c.assigned_to from cases c where c.id = new.case_id;
  end if;
  return new;
end $function$;
DROP TRIGGER IF EXISTS fact_finds_log_submit ON public.fact_finds;
CREATE TRIGGER fact_finds_log_submit AFTER UPDATE ON public.fact_finds
  FOR EACH ROW EXECUTE FUNCTION public.log_fact_find_submit();
REVOKE EXECUTE ON FUNCTION public.log_fact_find_submit() FROM anon, authenticated, public;
