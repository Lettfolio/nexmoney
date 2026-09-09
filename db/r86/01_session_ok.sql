-- =============================================================================
-- R86 · 01 · session_ok() — the second-factor gate every RLS policy now calls
--
-- WHAT: (1) seeds `settings.mfa_enforced_roles = 'owner,admin'` (insert … on conflict
--       do nothing — a value already set by hand is never overwritten);
--       (2) creates `public.session_ok()`: TRUE for a signed-in profile whose role is
--       NOT in that comma list, and for an enforced role ONLY when the session's JWT
--       carries `aal = 'aal2'` (a verified TOTP factor this session); FALSE for a
--       missing profile;
--       (3) re-creates the three RLS helpers `is_staff()`, `is_admin_or_owner()`,
--       `is_owner()` with `and public.session_ok()` — every one of the 63 policies
--       (R84 initplan form `(select fn())`) calls one of these, so ONE change gates
--       the whole book. `my_role()` is deliberately UNCHANGED: the app must be able to
--       learn the role at aal1 to decide whether to show the enrolment screen.
-- WHY:  every account is password-only and the vault holds ~200 real logins. A phished
--       or reused owner/admin password today = the whole client book. After this file an
--       owner/admin session without a verified authenticator reads NOTHING server-side;
--       advisers (the optional role) are unaffected until they opt in.
-- NOTE: an enforced user with NO verified factor can never reach aal2, so they read
--       nothing until they enrol — that is the point. Enrolment needs only the auth
--       endpoints (no REST tables), so they can still enrol.
-- BREAK-GLASS (enforcement off, every session reads as before this file):
--       update settings set value = '' where key = 'mfa_enforced_roles';
--       NOTE it unblocks users WITHOUT a factor only: a user who already holds a verified factor is
--       still challenged at every sign-in (GoTrue's aal rule, not ours) until the factor is removed
--       in the dashboard. Removing a factor does NOT revoke an existing aal2 JWT — for a compromised
--       device also "Sign out user from all sessions" in the dashboard.
-- DEPLOY ORDER: the client (admin/app.js with the challenge/enrol screens) goes live FIRST, then
--       this file — the other way round every owner/admin sees an empty app with no enrolment
--       screen. Safest: apply with the value '' (enforcement off), push the client, then flip the
--       row to 'owner,admin'.
-- GRANTS: session_ok() execute → authenticated + service_role; revoked from anon/public.
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select key, value from settings where key = 'mfa_enforced_roles';        -- owner,admin
--   -- R86 · V: the PARSED list, exactly as session_ok() reads it — a typo in the value fails
--   -- OPEN for the misspelt role (it is simply "not enforced"), so read this back, not the raw row:
--   select array_agg(lower(btrim(x))) filter (where btrim(x) <> '') as enforced_roles
--     from unnest(string_to_array(coalesce((select value from settings where key = 'mfa_enforced_roles'), ''), ',')) as x;
--   -- expect {owner,admin}; an empty/NULL array = enforcement OFF for everyone (the break-glass)
--   select proname, prosecdef, provolatile, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,   -- true
--          has_function_privilege('service_role', p.oid, 'EXECUTE') svc_exec,     -- true
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,            -- false for session_ok
--          (prosrc like '%session_ok()%') gated                                   -- true for the three helpers
--     from pg_proc p where pronamespace = 'public'::regnamespace
--      and proname in ('session_ok','is_staff','is_admin_or_owner','is_owner') order by 1;
--   -- as postgres in the SQL editor auth.uid() is null, so:
--   select public.session_ok();   -- false (no profile) — the guard working, not a fault
--   -- from the app, signed in as an owner who has verified this session: true; at aal1: false.
-- =============================================================================
begin;

-- (1) the enforcement list — one row, never overwritten
insert into public.settings (key, value)
values ('mfa_enforced_roles', 'owner,admin')
on conflict (key) do nothing;

-- (2) the gate
CREATE OR REPLACE FUNCTION public.session_ok()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r text := (select role from profiles where id = auth.uid());
  enforced boolean;
begin
  -- R86: no profile (signed out, unknown login) → never ok
  if r is null then
    return false;
  end if;
  -- R86: is this role in settings.mfa_enforced_roles? (comma list; each element trimmed;
  -- compared lower-cased; '' or a missing row = nobody enforced = the break-glass)
  enforced := lower(btrim(r)) = any (
    select lower(btrim(x))
      from unnest(string_to_array(coalesce((select value from settings where key = 'mfa_enforced_roles'), ''), ',')) as x
  );
  if not enforced then
    return true;
  end if;
  -- R86: enforced → only a session that verified its second factor (JWT aal = 'aal2')
  return coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
end
$function$;

revoke all on function public.session_ok() from public;
revoke all on function public.session_ok() from anon;
grant execute on function public.session_ok() to authenticated, service_role;

-- (3) the three RLS helpers: role AND session_ok(). Attributes unchanged (STABLE SECURITY
--     DEFINER, search_path = public, language sql); only `and public.session_ok()` is new.
CREATE OR REPLACE FUNCTION public.is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin','adviser','staff'))
     and public.session_ok()   -- R86
$function$;

CREATE OR REPLACE FUNCTION public.is_admin_or_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner','admin'))
     and public.session_ok()   -- R86
$function$;

CREATE OR REPLACE FUNCTION public.is_owner()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles where id = auth.uid() and role in ('owner'))
     and public.session_ok()   -- R86
$function$;

-- The helpers keep the grants they had (CREATE OR REPLACE preserves ACLs); stated anyway so
-- the file is the whole truth: policies evaluate them as the table owner, RPCs call them as
-- the caller.
grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.is_admin_or_owner() to authenticated, service_role;
grant execute on function public.is_owner() to authenticated, service_role;

commit;
