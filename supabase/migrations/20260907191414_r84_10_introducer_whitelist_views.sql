-- 20260907191414_r84_10_introducer_whitelist_views — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

create or replace view public.v_introducer_cases as
  select c.id, c.client_id, c.introducer_id, c.stage, c.case_kind, c.created_at, c.completed_at
    from public.cases c
   where c.introducer_id is not null
     and c.introducer_id = (select public.my_introducer_id());
create or replace view public.v_introducer_clients as
  select cl.id, cl.first_name, cl.last_name
    from public.clients cl
   where exists (select 1 from public.cases c
                  where c.client_id = cl.id
                    and c.introducer_id is not null
                    and c.introducer_id = (select public.my_introducer_id()));
alter view public.v_introducer_cases   set (security_invoker = false);
alter view public.v_introducer_clients set (security_invoker = false);
revoke all on public.v_introducer_cases   from anon, authenticated, public;
revoke all on public.v_introducer_clients from anon, authenticated, public;
grant select on public.v_introducer_cases   to authenticated;
grant select on public.v_introducer_clients to authenticated;
comment on view public.v_introducer_cases   is 'R84: introducer-portal whitelist. Scoped by my_introducer_id(); owner-rights view, do NOT set security_invoker.';
comment on view public.v_introducer_clients is 'R84: introducer-portal whitelist (names only). Scoped by my_introducer_id(); owner-rights view.';
drop policy if exists "cases read staff or introducer" on public.cases;
drop policy if exists "cases read staff" on public.cases;
create policy "cases read staff" on public.cases for select to public using ((select public.is_staff()));
drop policy if exists "clients read staff or introducer" on public.clients;
drop policy if exists "clients read staff" on public.clients;
create policy "clients read staff" on public.clients for select to public using ((select public.is_staff()));
