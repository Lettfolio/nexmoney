-- =============================================================================
-- R86 · 03 · get_team_mfa() — who on the team has an authenticator
--
-- WHAT: a new SECURITY DEFINER RPC for the Settings "Security" card's team column: one
--       entry per STAFF profile (owner / admin / adviser / staff — never the introducer
--       logins), `mfa_on` = at least one VERIFIED row in auth.mfa_factors for that user,
--       `enrolled_at` = the earliest verified factor's created_at (null when off).
-- WHY:  `auth.mfa_factors` is not readable through the REST API and the Owner needs to
--       see who has enrolled without opening the Supabase dashboard.
-- SHAPE (jsonb array, ordered by full_name):
--       [{ id, full_name, role, mfa_on: boolean, enrolled_at: timestamptz|null }]
-- SECURITY: SECURITY DEFINER (it reads the auth schema), search_path pinned to public,
--       guarded to the Owner and Administrators AND public.session_ok() — the round's rule
--       for every guard. A refusal RAISES 42501 (an empty roster would read as "nobody has
--       enrolled", a false fact). EXECUTE: authenticated + service_role, never anon.
--       No secrets leave: the row says whether a factor exists and when — never the
--       secret, never the factor id.
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select proname, prosecdef, provolatile, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,   -- true
--          has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,            -- false
--          (prosrc like '%session_ok()%') gated                                   -- true
--     from pg_proc p where proname = 'get_team_mfa' and pronamespace = 'public'::regnamespace;
--   -- as postgres (auth.uid() null) this raises 42501 — the guard working; call it from the
--   -- app as the Owner. Cross-check one row:
--   select p.full_name, exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified') mfa_on
--     from profiles p where p.role in ('owner','admin','adviser','staff') order by 1;
-- =============================================================================
begin;

CREATE OR REPLACE FUNCTION public.get_team_mfa()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
begin
  -- R86: Owner/Administrator only, and only from a session that has verified its second factor.
  if uid is null or not exists (
    select 1 from profiles where id = uid and role in ('owner','admin') and public.session_ok()
  ) then
    raise exception 'permission denied: get_team_mfa is for the Owner and Administrators' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',          p.id,
      'full_name',   p.full_name,
      'role',        p.role,
      'mfa_on',      (f.enrolled_at is not null),
      'enrolled_at', f.enrolled_at
    ) order by p.full_name)
    from profiles p
    left join lateral (
      select min(m.created_at) as enrolled_at
        from auth.mfa_factors m
       where m.user_id = p.id and m.status = 'verified'
    ) f on true
    where p.role in ('owner','admin','adviser','staff')
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_team_mfa() from public;
revoke all on function public.get_team_mfa() from anon;
grant execute on function public.get_team_mfa() to authenticated, service_role;

commit;
