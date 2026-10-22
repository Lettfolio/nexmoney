-- 20260718213126_sms_queue_and_settings — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Outbound SMS queue (mirrors email_queue; provider-agnostic).
CREATE TABLE IF NOT EXISTS public.sms_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid REFERENCES public.cases(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  sms_type text NOT NULL,
  status public.email_status NOT NULL DEFAULT 'queued',
  to_phone text,
  body text,
  scheduled_for timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  claimed_at timestamptz,
  provider_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sms_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sms_queue_staff" ON public.sms_queue;
CREATE POLICY "sms_queue_staff" ON public.sms_queue FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
CREATE INDEX IF NOT EXISTS idx_sms_queue_status_sched ON public.sms_queue(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_sms_queue_case ON public.sms_queue(case_id);

-- Comms settings (all default OFF / empty so nothing sends until configured & approved).
insert into public.settings(key, value) values
  ('sms_enabled','off'),
  ('sms_provider','twilio'),
  ('sms_from',''),
  ('auto_sms_rate_end','off'),
  ('auto_sms_appointment','off'),
  ('birthday_enabled','off'),
  ('anniversary_enabled','off'),
  ('nps_enabled','off'),
  ('review_platform_link',''),
  ('site_url','https://nexmoney.co.uk')
on conflict (key) do nothing;
