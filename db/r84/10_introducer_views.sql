-- R84 · S2-1 (P1) — INTRODUCER DATA MINIMISATION
--
-- WHAT: the introducer branch of the `cases` / `clients` SELECT policies handed an introducer
-- login the WHOLE row (clients.date_of_birth, address, is_vulnerable, vulnerability_note, notes,
-- comms_token; cases.mortgage_account_number, loan_amount, broker_fee, proc_fee, lost_detail,
-- doc_token, nps_token …). introducer.html only asks for five columns, but nothing stopped
-- `select=*` via the REST API. doc_token is the bearer for the client document portal.
--
-- FIX: two whitelist views scoped to the caller's introducer, then the introducer branch is
-- removed from both table policies so the base tables are staff-only again.
--
-- NOTE ON security_invoker: the views MUST NOT be security_invoker — once the table policies are
-- staff-only, an invoker view would see nothing for an introducer. They run as their owner
-- (postgres, table owner ⇒ bypasses RLS) and carry the scope predicate themselves:
--   introducer_id = (select my_introducer_id())
-- my_introducer_id() returns NULL for anyone whose profile role is not 'introducer', and the
-- predicate also requires introducer_id IS NOT NULL, so staff / 'none' users get zero rows.
-- Staff never use these views (admin app reads the tables), so that is the intended result.
--
-- EXPECTED EFFECT: introducer portal keeps working (introducer.html patched in the same round to
-- read the views); an introducer selecting from cases/clients directly gets 0 rows.
--
-- VERIFY (after apply):
--   select c.relname, c.relkind, c.reloptions from pg_class c
--    where c.relname in ('v_introducer_cases','v_introducer_clients');      -- 2 rows, reloptions {security_invoker=false}
--   select policyname, qual from pg_policies where tablename in ('cases','clients') and cmd='SELECT';
--     -- both quals must be exactly "( SELECT is_staff() AS is_staff)"
--   select has_table_privilege('authenticated','public.v_introducer_cases','select');   -- t
--   select has_table_privilege('anon','public.v_introducer_cases','select');            -- f

-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

create or replace view public.v_introducer_cases as
  select c.id,
         c.client_id,
         c.introducer_id,
         c.stage,
         c.case_kind,
         c.created_at,
         c.completed_at
    from public.cases c
   where c.introducer_id is not null
     and c.introducer_id = (select public.my_introducer_id());

create or replace view public.v_introducer_clients as
  select cl.id,
         cl.first_name,
         cl.last_name
    from public.clients cl
   where exists (select 1 from public.cases c
                  where c.client_id = cl.id
                    and c.introducer_id is not null
                    and c.introducer_id = (select public.my_introducer_id()));

-- Owner-rights views (NOT security_invoker) — see header. Make the intent explicit and idempotent.
alter view public.v_introducer_cases   set (security_invoker = false);
alter view public.v_introducer_clients set (security_invoker = false);

revoke all on public.v_introducer_cases   from anon, authenticated, public;   -- R84 verifier: default ACL grants authenticated write on new relations
revoke all on public.v_introducer_clients from anon, authenticated, public;
grant select on public.v_introducer_cases   to authenticated;
grant select on public.v_introducer_clients to authenticated;

comment on view public.v_introducer_cases   is 'R84: introducer-portal whitelist. Scoped by my_introducer_id(); owner-rights view, do NOT set security_invoker.';
comment on view public.v_introducer_clients is 'R84: introducer-portal whitelist (names only). Scoped by my_introducer_id(); owner-rights view.';

-- Base tables back to staff-only reads (initplan form — see 12_policy_initplan.sql for the rest).
drop policy if exists "cases read staff or introducer" on public.cases;
drop policy if exists "cases read staff" on public.cases;   -- re-run safe
create policy "cases read staff" on public.cases
  for select to public
  using ((select public.is_staff()));

drop policy if exists "clients read staff or introducer" on public.clients;
drop policy if exists "clients read staff" on public.clients;   -- re-run safe
create policy "clients read staff" on public.clients
  for select to public
  using ((select public.is_staff()));

