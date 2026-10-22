-- 20260908071425_r85_01_get_dashboard_counts — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

CREATE OR REPLACE FUNCTION public.get_dashboard_counts()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  out jsonb;
begin
  -- R85: the house staff guard (get_briefing's test), raising rather than returning empty.
  if uid is null or not exists (
    select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')
  ) then
    raise exception 'permission denied: get_dashboard_counts is for staff' using errcode = '42501';
  end if;

  select jsonb_build_object(
    -- renderOpsStrip: email_queue status = 'queued'
    'queued_emails',      (select count(*) from email_queue where status = 'queued'),
    -- renderOpsStrip: email_queue status = 'failed'
    'failed_emails',      (select count(*) from email_queue where status = 'failed'),
    -- renderOpsStrip: sms_queue status = 'queued'
    'queued_sms',         (select count(*) from sms_queue where status = 'queued'),
    -- renderOpsStrip: leads status = 'new'
    'new_leads',          (select count(*) from leads where status = 'new'),
    -- renderOpsStrip: the doc-chase's terminal call task, still open (DOC_OVERDUE_TITLE prefix)
    'docs_overdue_tasks', (select count(*) from case_tasks
                             where done_at is null and title like 'Documents overdue — call %'),
    -- loadWatchtower: every unresolved alert (snoozed included)
    'open_watch_alerts',  (select count(*) from watch_alerts where resolved_at is null),
    -- maybeStartTour / renderWhatsNewBand: the caller's own flag
    'tour_seen_at',       (select p.tour_seen_at from profiles p where p.id = uid),
    -- refreshHeartbeatKeys: HEARTBEAT_KEYS, presence-keyed
    'heartbeat',          coalesce((select jsonb_object_agg(s.key, s.value) from settings s
                                     where s.key in ('last_cron_run_at', 'last_full_export_at')), '{}'::jsonb)
  ) into out;
  return out;
end;
$function$;

-- R85: staff-only surface — authenticated + service_role, never anon (R82 hardening rule).
revoke all on function public.get_dashboard_counts() from public;
revoke all on function public.get_dashboard_counts() from anon;
grant execute on function public.get_dashboard_counts() to authenticated, service_role;
