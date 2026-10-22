-- 20260718213112_comms_schema — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- New automated email types
ALTER TYPE public.email_type ADD VALUE IF NOT EXISTS 'birthday_greeting';
ALTER TYPE public.email_type ADD VALUE IF NOT EXISTS 'completion_anniversary';

-- Client comms fields: DOB for birthday touch, consent flags, referral code
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS sms_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS marketing_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS referral_code text;

-- NPS capture on the case (review_request routes through here)
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS nps_token uuid;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS nps_score int;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS nps_score_at timestamptz;
ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS anniversary_sent_at timestamptz;
