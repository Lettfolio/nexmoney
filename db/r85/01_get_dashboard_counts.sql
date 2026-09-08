-- =============================================================================
-- R85 · 01 · get_dashboard_counts() — ONE round trip for the Today chrome
--
-- WHAT: a new SECURITY DEFINER RPC returning the nine scalars app.js's dashboard
--       chrome fetched with NINE requests per Today load: five `head:true` count
--       probes (renderOpsStrip), two reads of the caller's own profiles row
--       (maybeStartTour + renderWhatsNewBand), the two-key heartbeat settings read
--       (refreshHeartbeatKeys) and the watchtower's open-alerts count
--       (loadWatchtower). Each field keeps the EXACT predicate of the read it
--       replaces — see the body; app.js consumers keep their old reads as the
--       fallback when this function is absent (42883) or refuses.
-- WHY:  nine ~75 ms round trips for nine numbers, on the screen every member of
--       staff opens first, every time. One call.
-- SHAPE (jsonb):
--       { queued_emails, failed_emails, queued_sms, new_leads, docs_overdue_tasks,
--         open_watch_alerts, tour_seen_at, heartbeat: { key: value, ... } }
--       `heartbeat` carries ONLY the settings rows that exist for the two keys —
--       key PRESENCE is the signal app.js reads (absent key = un-migrated
--       heartbeat = no banner; present-but-empty = "never confirmed a run").
--       `open_watch_alerts` counts snoozed rows too, exactly as the head:true
--       `resolved_at is null` count did (the app's list filters snoozes itself).
-- SECURITY: SECURITY DEFINER, search_path pinned to public, guarded to signed-in
--       staff by the SAME profiles-role test get_briefing uses — but this one
--       RAISES 42501 to a non-staff caller rather than answering an empty
--       structure (an empty count object would read as "nothing stuck", which
--       is a false fact, not a refusal). EXECUTE: authenticated + service_role
--       only — never anon (the R82 hardening rule).
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select proname, prosecdef, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,   -- expect true
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,             -- expect false
--          (pg_get_functiondef(p.oid) like '%R85%') tagged
--     from pg_proc p where proname = 'get_dashboard_counts' and pronamespace = 'public'::regnamespace;
--   -- and, as a staff user (SQL editor runs as postgres, whose auth.uid() is null, so this
--   -- raises 42501 there — which is itself the guard working; call it from the app instead):
--   select public.get_dashboard_counts();
--   -- cross-check one field against its old read:
--   select count(*) from email_queue where status = 'queued';
-- =============================================================================
begin;

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

commit;
