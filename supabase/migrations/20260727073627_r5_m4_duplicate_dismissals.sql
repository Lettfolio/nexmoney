-- 20260727073627_r5_m4_duplicate_dismissals — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- M4 — duplicate_dismissals ("not a duplicate" that sticks)
create table if not exists public.duplicate_dismissals (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'client',
  a_id uuid not null, b_id uuid not null,   -- store sorted: a_id < b_id
  reason text, dismissed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  constraint dup_pair_sorted check (a_id < b_id),
  constraint dup_pair_unique unique (kind, a_id, b_id)
);

alter table public.duplicate_dismissals enable row level security;

drop policy if exists "dup dismiss read staff"   on public.duplicate_dismissals;
drop policy if exists "dup dismiss insert staff" on public.duplicate_dismissals;
drop policy if exists "dup dismiss delete admin" on public.duplicate_dismissals;

create policy "dup dismiss read staff"   on public.duplicate_dismissals for select using (is_staff());
create policy "dup dismiss insert staff" on public.duplicate_dismissals for insert with check (is_staff());
create policy "dup dismiss delete admin" on public.duplicate_dismissals for delete using (is_admin_or_owner());

-- audit_log is append-only; the new table joins the audited set per round-4 rule.
drop trigger if exists audit_duplicate_dismissals on public.duplicate_dismissals;
create trigger audit_duplicate_dismissals
  after insert or update or delete on public.duplicate_dismissals
  for each row execute function audit_row();
