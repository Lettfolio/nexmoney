-- 20260908191604_r86_03_get_team_mfa — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

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
