-- 20260805164519_r10_audit_triggers_sms_leads_factfinds — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- BE-8: add the standard generic audit_row() trigger to sms_queue, leads and
-- fact_finds, ALONGSIDE their existing purpose-built triggers (queue_lead_ack on
-- leads, log_fact_find_submit on fact_finds). Same AFTER INSERT OR UPDATE OR DELETE
-- FOR EACH ROW form used by audit_clients on public.clients.
DROP TRIGGER IF EXISTS audit_sms_queue ON public.sms_queue;
CREATE TRIGGER audit_sms_queue
  AFTER INSERT OR UPDATE OR DELETE ON public.sms_queue
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS audit_leads ON public.leads;
CREATE TRIGGER audit_leads
  AFTER INSERT OR UPDATE OR DELETE ON public.leads
  FOR EACH ROW EXECUTE FUNCTION audit_row();

DROP TRIGGER IF EXISTS audit_fact_finds ON public.fact_finds;
CREATE TRIGGER audit_fact_finds
  AFTER INSERT OR UPDATE OR DELETE ON public.fact_finds
  FOR EACH ROW EXECUTE FUNCTION audit_row();
