-- 20260819091107_r30_error_events — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R30: persisted, sanitised client-error fingerprints (cross-session diagnostics).
-- Privacy by construction: the app NEVER writes a message, stack, URL query, record id, name
-- or email here — only a coarse error type, a code location (file:line), the base page route,
-- and the role of the staff member who hit it. Owner/admin read; any staff insert; nobody updates.
create table if not exists public.error_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  error_type text,
  location text,
  page text,
  role text
);

alter table public.error_events enable row level security;

-- Any signed-in staff member logs their own errors (mirrors duplicate_dismissals / vault insert).
create policy "error events insert staff" on public.error_events
  for insert with check (is_staff());

-- Only owner/admin can read or clear — same audience as the in-app diagnostics panel (isAdminOrOwner).
create policy "error events read admin" on public.error_events
  for select using (is_admin_or_owner());

create policy "error events delete admin" on public.error_events
  for delete using (is_admin_or_owner());

-- No UPDATE policy: the log is append-only and immutable.

grant select, insert, delete on public.error_events to authenticated;

create index if not exists error_events_created_idx on public.error_events (created_at desc);
