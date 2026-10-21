-- 20260807142638_r14_m1_vault — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R14: company password safe (vault). Replaces the shared Passwords MASTER.xlsx.
-- One entry = one login/record (a lender portal, an admin system, a BDM contact).
-- Its fields (username / password / memorable word / security answers / phone /
-- email …) live in a jsonb array so the wildly-varying real-world shapes all fit
-- one table: [{label, value, secret}] — secret=true fields are the ones the UI
-- masks by default and the audit trigger never records the value of.
create table if not exists vault_entries (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'other',   -- lender | protection | gi | admin | contact | other
  name text not null,                        -- "Accord Mortgages", "Revolution", "Barclays BDM"
  owner_label text,                          -- whose credential: 'Daniel' | 'Luke' | 'Wayne' | 'Shared' | null
  fields jsonb not null default '[]'::jsonb, -- [{label:text, value:text, secret:bool}]
  note text,
  -- Gating hook for "the option to gate these in the future": null/empty = every
  -- staff member can see it (today's rule). Later, populate with role names or
  -- profile ids and tighten the SELECT policy — the column is here so that change
  -- is a policy edit, not a migration.
  visible_to text[],
  sort_order int not null default 0,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vault_entries_category_idx on vault_entries(category, sort_order);

alter table vault_entries enable row level security;

-- TODAY: all staff read + write everything (Daniel's "all staff access all of
-- them for the time being"). The visible_to column is the future gate: when it's
-- non-empty the row is limited to the named roles; while it's null/empty it's
-- open to all staff. Written now so enabling gating never touches this policy's
-- write side, only its read predicate.
create policy "staff read vault" on vault_entries for select
  using (is_staff() and (
    visible_to is null or cardinality(visible_to) = 0
    or (select role from profiles where id = auth.uid()) = any(visible_to)
  ));
create policy "staff insert vault" on vault_entries for insert with check (is_staff());
create policy "staff update vault" on vault_entries for update using (is_staff()) with check (is_staff());
-- Delete is Owner/Admin only — a vault is easy to gut by accident.
create policy "admin delete vault" on vault_entries for delete using (is_admin_or_owner());

-- Audit WITHOUT the secret values. The generic audit_row() trigger would copy the
-- whole fields jsonb (passwords and all) into audit_log.changes. This dedicated
-- trigger records that an entry changed, by whom, and which field LABELS moved —
-- never a secret value. Non-secret fields (phone, email, agency number) are kept
-- in the clear so the log stays useful.
create or replace function public.audit_vault_row()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare
  redact jsonb;
  actor_label text;
begin
  select coalesce(full_name, email) into actor_label from profiles where id = auth.uid();
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
create trigger vault_entries_audit
  after insert or update or delete on vault_entries
  for each row execute function audit_vault_row();

-- keep updated_at honest
create or replace function public.touch_vault_updated() returns trigger
  language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger vault_entries_touch before update on vault_entries
  for each row execute function touch_vault_updated();
