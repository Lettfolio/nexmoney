-- 20260704190923_role_based_rls — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- Role helpers (security definer avoids RLS recursion on profiles)
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from profiles where id = auth.uid() and role = 'staff') $$;

create or replace function public.my_introducer_id() returns uuid
language sql stable security definer set search_path = public as
$$ select introducer_id from profiles where id = auth.uid() and role = 'introducer' $$;

-- Replace blanket authenticated policies with role-aware ones
drop policy "auth all" on public.profiles;
drop policy "auth all" on public.clients;
drop policy "auth all" on public.cases;
drop policy "auth all" on public.case_notes;
drop policy "auth all" on public.email_queue;
drop policy "auth all" on public.settings;
drop policy "auth all" on public.case_tasks;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "staff all" on public.profiles for all to authenticated using (is_staff()) with check (is_staff());

create policy "staff all" on public.clients for all to authenticated using (is_staff()) with check (is_staff());
create policy "introducer clients" on public.clients for select to authenticated
  using (exists (select 1 from cases c where c.client_id = clients.id and c.introducer_id = my_introducer_id()));

create policy "staff all" on public.cases for all to authenticated using (is_staff()) with check (is_staff());
create policy "introducer cases" on public.cases for select to authenticated
  using (introducer_id is not null and introducer_id = my_introducer_id());

create policy "staff all" on public.case_notes for all to authenticated using (is_staff()) with check (is_staff());
create policy "staff all" on public.email_queue for all to authenticated using (is_staff()) with check (is_staff());
create policy "staff all" on public.settings for all to authenticated using (is_staff()) with check (is_staff());
create policy "staff all" on public.case_tasks for all to authenticated using (is_staff()) with check (is_staff());

alter table public.introducers enable row level security;
create policy "staff all" on public.introducers for all to authenticated using (is_staff()) with check (is_staff());
create policy "own introducer row" on public.introducers for select to authenticated using (id = my_introducer_id());

alter table public.case_events enable row level security;
create policy "staff read" on public.case_events for select to authenticated using (is_staff());

-- Tighten offer document storage to staff
drop policy "auth offers select" on storage.objects;
drop policy "auth offers insert" on storage.objects;
drop policy "auth offers update" on storage.objects;
create policy "staff offers select" on storage.objects for select to authenticated using (bucket_id = 'offers' and public.is_staff());
create policy "staff offers insert" on storage.objects for insert to authenticated with check (bucket_id = 'offers' and public.is_staff());
create policy "staff offers update" on storage.objects for update to authenticated using (bucket_id = 'offers' and public.is_staff()) with check (bucket_id = 'offers' and public.is_staff());
