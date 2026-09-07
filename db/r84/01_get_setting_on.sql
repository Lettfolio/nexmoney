-- =============================================================================
-- R84 · 01 · get_setting_on(k) — ONE answer to "is this switch on?"  (finding F5)
--
-- WHAT: a boolean helper over settings that accepts every spelling the system
--       actually writes: the Settings form writes "1"/"0" for the bool10 keys
--       (app.js SETTING_FIELDS), the seeds and the selects write 'on'/'off', and
--       process-emails v21 trims + lower-cases before comparing. Absent row,
--       NULL, '' or anything else => false (fail closed, same as the app).
-- WHY:  queue_automated_emails tested `= 'on'` on auto_referral while prod holds
--       '1' (F1); queue_comms_extras tested `in ('on','1')` on one key and `= 'on'`
--       on four others. 02/03 replace every settings test in those two functions
--       with this helper. No other function is touched in this round.
-- EFFECT: none on its own. Behaviour changes land with 02 and 03.
-- SECURITY: SECURITY INVOKER (like get_setting) so RLS on settings applies to a
--       direct caller; the queue functions are SECURITY DEFINER and read it as
--       postgres exactly as they read get_setting today. EXECUTE granted to the
--       same roles as get_setting (postgres/anon/authenticated/service_role) so a
--       later app-side call needs no grant change; anon sees no rows -> false.
--
-- DRY RUN: this file is wrapped in BEGIN/COMMIT — replace the final COMMIT with
--          ROLLBACK to dry-run.
-- VERIFY (after apply):
--   select proname, prosecdef, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,
--          pg_get_functiondef(p.oid) like '%R84%' tagged
--     from pg_proc p where proname = 'get_setting_on' and pronamespace = 'public'::regnamespace;
--   -- expect: prosecdef=false, proconfig={search_path=public}, auth_exec=true, anon_exec=true, tagged=true
--   select public.get_setting_on('auto_referral') as should_be_true_in_prod;   -- prod holds '1'
-- =============================================================================
begin;

-- R84: new helper — the single settings-truthiness test used by the queue functions.
CREATE OR REPLACE FUNCTION public.get_setting_on(k text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- R84 (F5): 'on' / '1' / 'true' in any case or padding are ON; NULL / missing / anything else is OFF.
  select coalesce(lower(btrim((select value from public.settings where key = k))) in ('on','1','true'), false)
$function$;

-- R84: mirror get_setting's grant set (postgres, anon, authenticated, service_role).
revoke all on function public.get_setting_on(text) from public;
grant execute on function public.get_setting_on(text) to anon, authenticated, service_role;

commit;
