-- 20260805164536_r10_index_hygiene — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- BE-9 (safe subset): drop the confirmed-identical duplicate indexes, keeping the
-- Postgres-conventional <table>_<cols>_idx name in each pair. Dropping
-- idx_email_queue_status_sched also clears an "unused index" advisory.
DROP INDEX IF EXISTS public.idx_appointments_starts_at;      -- dup of appointments_starts_at_idx (starts_at)
DROP INDEX IF EXISTS public.idx_email_queue_status_sched;    -- dup of email_queue_status_scheduled_for_idx (status, scheduled_for)

-- Covering indexes for the unindexed foreign-key columns the advisor flagged.
CREATE INDEX IF NOT EXISTS idx_assistant_actions_staff_id       ON public.assistant_actions (staff_id);
CREATE INDEX IF NOT EXISTS idx_case_tasks_created_by            ON public.case_tasks (created_by);
CREATE INDEX IF NOT EXISTS idx_cases_protection_quoted_by       ON public.cases (protection_quoted_by);
CREATE INDEX IF NOT EXISTS idx_duplicate_dismissals_dismissed_by ON public.duplicate_dismissals (dismissed_by);
CREATE INDEX IF NOT EXISTS idx_leads_converted_case_id          ON public.leads (converted_case_id);
CREATE INDEX IF NOT EXISTS idx_profiles_introducer_id           ON public.profiles (introducer_id);
CREATE INDEX IF NOT EXISTS idx_sms_queue_client_id              ON public.sms_queue (client_id);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_case_id             ON public.watch_alerts (case_id);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_client_id           ON public.watch_alerts (client_id);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_lead_id             ON public.watch_alerts (lead_id);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_snoozed_by          ON public.watch_alerts (snoozed_by);
CREATE INDEX IF NOT EXISTS idx_watch_alerts_staff_id            ON public.watch_alerts (staff_id);
