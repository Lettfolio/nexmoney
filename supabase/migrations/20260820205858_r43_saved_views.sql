-- 20260820205858_r43_saved_views — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R43 §2 — saved filter views move server-side so they follow the user across devices.
-- Personal data, per-user only: nobody reads or writes anybody else's views, staff-gated on write.
-- scope '_meta' holds the one marker row ("starters seeded") so deleting every starter view does
-- not look like a virgin store and trigger a re-seed — the same rule R37 enforced with the
-- ABSENCE-OF-KEY test on localStorage.
create table public.saved_views (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  scope text not null check (scope in ('pipeline','clients','_meta')),
  name text not null check (char_length(name) between 1 and 120),
  filters jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, scope, name)
);
alter table public.saved_views enable row level security;
create policy saved_views_select on public.saved_views for select to authenticated
  using (user_id = auth.uid());
create policy saved_views_insert on public.saved_views for insert to authenticated
  with check (user_id = auth.uid() and is_staff());
create policy saved_views_update on public.saved_views for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and is_staff());
create policy saved_views_delete on public.saved_views for delete to authenticated
  using (user_id = auth.uid());
grant select, insert, update, delete on public.saved_views to authenticated;
