-- 20260806002748_r11_introducer_id_guard — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R11 BE-2: introducer tenant isolation.
-- profiles.introducer_id was self-editable: the "profiles self edit" RLS policy
-- lets any signed-in user UPDATE their own row, and `authenticated` holds
-- UPDATE on every profiles column. An introducer could therefore repoint their
-- own introducer_id and read another introducer's clients/cases once the
-- introducer portal ships.
--
-- Trigger, not REVOKE UPDATE(introducer_id): the Owner UI updates profiles as
-- the `authenticated` role via the "profiles edit owner" policy, so a column
-- REVOKE would break the Owner's own user-management screen. The guard mirrors
-- the existing role guard exactly: signed-in non-owners are blocked, while
-- auth.uid() IS NULL (service_role — e.g. invite-user, which upserts
-- introducer_id with the service key) and SECURITY DEFINER paths keep working.
--
-- Everything else in guard_role_change is unchanged.
create or replace function public.guard_role_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change a role';
    end if;
  end if;

  -- R11 BE-2: an introducer login must not be able to repoint itself at a
  -- different introducer (tenant isolation).
  if tg_op = 'UPDATE' and new.introducer_id is distinct from old.introducer_id then
    if auth.uid() is not null and not is_owner() then
      raise exception 'Only an Owner can change which introducer a login belongs to';
    end if;
  end if;

  if (tg_op = 'UPDATE' and old.role = 'owner' and new.role is distinct from 'owner')
     or (tg_op = 'DELETE' and old.role = 'owner') then
    if (select count(*) from profiles where role = 'owner') <= 1 then
      raise exception 'Cannot remove the last Owner — promote someone else first';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end
$function$;
