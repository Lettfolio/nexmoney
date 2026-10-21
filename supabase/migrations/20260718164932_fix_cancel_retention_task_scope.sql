-- 20260718164932_fix_cancel_retention_task_scope — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Bug: on completion this closed EVERY open task on the case, silently ticking off live
-- "Arrange buildings/GI cover", "Protection conversation" and "Chase solicitors" tasks that
-- must happen around completion. Now: completion closes only the retention call task; a case
-- going not_proceeding still closes everything (the case is dead).
CREATE OR REPLACE FUNCTION public.cancel_retention_touches()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.stage in ('completed','not_proceeding') and old.stage is distinct from new.stage then
    update email_queue set status = 'cancelled'
    where case_id = new.id and status = 'queued'
      and email_type in ('rate_end_reminder','rate_end_chase');

    if new.stage = 'not_proceeding' then
      update case_tasks set done_at = now()
      where case_id = new.id and done_at is null;
    else
      -- completed: only auto-close the retention "call client — rate ends" task,
      -- leave GI / protection / solicitor tasks live.
      update case_tasks set done_at = now()
      where case_id = new.id and done_at is null
        and title like 'Call client — rate ends%';
    end if;
  end if;
  return new;
end $function$;
