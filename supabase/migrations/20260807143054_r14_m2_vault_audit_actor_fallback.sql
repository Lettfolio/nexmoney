-- 20260807143054_r14_m2_vault_audit_actor_fallback — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- audit_log.actor_label is NOT NULL; a service-role write (import/cron) has no
-- auth.uid(), so give the label an honest fallback instead of null.
create or replace function public.audit_vault_row()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  redact jsonb;
  actor_label text;
begin
  select coalesce(full_name, email) into actor_label from profiles where id = auth.uid();
  if actor_label is null then actor_label := 'System / import'; end if;
  redact := (
    select coalesce(jsonb_agg(
      case when coalesce((f->>'secret')::boolean, true)
           then jsonb_build_object('label', f->>'label', 'value', '(hidden)')
           else f end), '[]'::jsonb)
    from jsonb_array_elements(coalesce(case when TG_OP='DELETE' then OLD.fields else NEW.fields end, '[]'::jsonb)) f
  );
  insert into audit_log (actor, actor_label, action, table_name, row_id, summary, changes)
  values (
    auth.uid(), actor_label,
    lower(TG_OP), 'vault_entries',
    coalesce(NEW.id, OLD.id)::text,
    coalesce(NEW.name, OLD.name) || ' (' || coalesce(NEW.category, OLD.category) || ')',
    jsonb_build_object('name', coalesce(NEW.name, OLD.name),
                       'owner', coalesce(NEW.owner_label, OLD.owner_label),
                       'fields', redact)
  );
  return coalesce(NEW, OLD);
end $$;
