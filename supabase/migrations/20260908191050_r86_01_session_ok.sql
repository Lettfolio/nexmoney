-- 20260908191050_r86_01_session_ok — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- (1) the enforcement list — one row, never overwritten (already seeded as '' = OFF until the client ships)
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

-- (3) the three RLS helpers: role AND session_ok().
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

grant execute on function public.is_staff() to authenticated, service_role;
grant execute on function public.is_admin_or_owner() to authenticated, service_role;
grant execute on function public.is_owner() to authenticated, service_role;
