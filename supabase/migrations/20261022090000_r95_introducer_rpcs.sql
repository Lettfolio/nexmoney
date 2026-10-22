-- =============================================================================
-- R95 · E · introducer portal reads through two RPCs; the two owner-rights views go
--
-- WHAT: (1) public.get_introducer_cases() returns exactly the columns and rows of
--       v_introducer_cases (id, client_id, introducer_id, stage, case_kind, created_at,
--       completed_at — scoped to introducer_id = my_introducer_id());
--       (2) public.get_introducer_clients(p_ids uuid[]) returns exactly v_introducer_clients'
--       columns (id, first_name, last_name) for the ids asked for, still only clients with a
--       case of the caller's introducer; (3) both drop to execute-by-authenticated only;
--       (4) the two views are dropped.
-- WHY:  the views had to run as their owner (R84: cases/clients reads are staff-only, so an
--       invoker view shows an introducer 0 rows — see docs/rounds/R94-D.md), which is the
--       Security Advisor ERROR "security definer view". A SECURITY DEFINER function with a
--       fixed search_path and its own scope predicate is the supported shape for the same read.
--       Both also require public.session_ok() (R86 rule). 'introducer' is not in
--       settings.mfa_enforced_roles (owner,admin on 22 Oct 2026), so introducers pass at aal1.
--       Anyone who is not an introducer gets my_introducer_id() = NULL → zero rows, as before.
-- SHIPS: on the merge of the R95 PR, via the Supabase GitHub integration (replayed first on the
--       PR's data-less Preview Branch). Daniel does NOT paste it. admin/introducer.html switches
--       to db.rpc(...) in the same PR. Idempotent: re-running it is a no-op.
-- (no BEGIN/COMMIT — the migration runner wraps each file in its own transaction)
-- =============================================================================

create or replace function public.get_introducer_cases()
returns table (
  id            uuid,
  client_id     uuid,
  introducer_id uuid,
  stage         public.case_stage,
  case_kind     public.case_kind,
  created_at    timestamptz,
  completed_at  timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.client_id, c.introducer_id, c.stage, c.case_kind, c.created_at, c.completed_at
    from public.cases c
   where (select public.session_ok())   -- R95 · E1: R86 rule, every new RPC guard carries it
     and c.introducer_id is not null
     and c.introducer_id = (select public.my_introducer_id())
   order by c.created_at desc;
$$;

create or replace function public.get_introducer_clients(p_ids uuid[])
returns table (
  id         uuid,
  first_name text,
  last_name  text
)
language sql
stable
security definer
set search_path = ''
as $$
  select cl.id, cl.first_name, cl.last_name
    from public.clients cl
   where (select public.session_ok())   -- R95 · E1
     and cl.id = any (p_ids)
     and exists (select 1 from public.cases c
                  where c.client_id = cl.id
                    and c.introducer_id is not null
                    and c.introducer_id = (select public.my_introducer_id()));
$$;

-- R95 · E2: the project's default ACL hands new functions to anon as well — take it back.
revoke all on function public.get_introducer_cases()             from public, anon;
revoke all on function public.get_introducer_clients(uuid[])     from public, anon;
grant execute on function public.get_introducer_cases()          to authenticated;
grant execute on function public.get_introducer_clients(uuid[])  to authenticated;

comment on function public.get_introducer_cases()         is 'R95: introducer-portal read (replaces v_introducer_cases). Scoped by my_introducer_id(), gated by session_ok().';
comment on function public.get_introducer_clients(uuid[]) is 'R95: introducer-portal read, names only (replaces v_introducer_clients). Scoped by my_introducer_id(), gated by session_ok().';

-- Functions first, then the views (nothing else depends on them; checked via pg_depend 22 Oct).
drop view if exists public.v_introducer_cases;
drop view if exists public.v_introducer_clients;

-- VERIFY (after merge):
--   select proname, prosecdef, proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec,   -- true
--          has_function_privilege('anon', p.oid, 'EXECUTE')          anon_exec,   -- false
--          (prosrc like '%session_ok()%') gated                                    -- true
--     from pg_proc p where pronamespace = 'public'::regnamespace
--      and proname like 'get_introducer_%' order by 1;
--   -- expect 2 rows: get_introducer_cases, get_introducer_clients; prosecdef true; {search_path=""}
--   select count(*) from pg_views where viewname like 'v_introducer_%';           -- 0
--   -- as postgres in the SQL editor auth.uid() is null, so session_ok() is false:
--   select count(*) from public.get_introducer_cases();                           -- 0 (guard working)
--   -- then sign in to /admin/introducer.html as an introducer: both lists render as before.
