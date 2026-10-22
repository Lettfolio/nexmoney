-- 20260903191213_r82_get_staff_activity — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R82: the app can finally see sign-ins.
-- Until now the adoption panel had to say, honestly, "This app cannot see sign-ins:
-- that lives in the authentication service and is not readable from here." That
-- blind spot also meant leastLoadedAdviser() ranked colleagues who have never logged
-- in as the lightest desk — permanently, since they carry zero of everything — and
-- routed real client enquiries to them. This exposes the one auth fact the app needs,
-- guarded to signed-in staff, and nothing else about the auth record.
create or replace function public.get_staff_activity()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'has_signed_in', (u.last_sign_in_at is not null),
      'last_sign_in_at', u.last_sign_in_at,
      'invited_at', u.created_at
    ) order by p.full_name)
    from profiles p left join auth.users u on u.id = p.id
  ), '[]'::jsonb);
end;
$function$;

revoke all on function public.get_staff_activity() from public, anon;
grant execute on function public.get_staff_activity() to authenticated;
