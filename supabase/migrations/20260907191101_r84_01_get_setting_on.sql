-- 20260907191101_r84_01_get_setting_on — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

CREATE OR REPLACE FUNCTION public.get_setting_on(k text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- R84 (F5): 'on' / '1' / 'true' in any case or padding are ON; NULL / missing / anything else is OFF.
  select coalesce(lower(btrim((select value from public.settings where key = k))) in ('on','1','true'), false)
$function$;
revoke all on function public.get_setting_on(text) from public;
grant execute on function public.get_setting_on(text) to anon, authenticated, service_role;
