-- R84 · S2-9 (P3) — revoke TRUNCATE / REFERENCES / TRIGGER from anon + authenticated
--
-- WHAT: Supabase's default `grant all on tables` left anon and authenticated with TRUNCATE,
-- REFERENCES and TRIGGER on every public table (and the v_alerts view). RLS does not gate
-- TRUNCATE, and none of the three is something the API roles should ever hold. Nothing in the
-- app uses them (PostgREST never issues TRUNCATE; creating FKs/triggers needs DDL anyway).
-- Also stops the default privileges re-granting them to future tables.
--
-- EXPECTED EFFECT: none functionally. Defence in depth.
--
-- VERIFY (after apply):
--   select count(*) from information_schema.role_table_grants
--    where table_schema='public' and grantee in ('anon','authenticated')
--      and privilege_type in ('TRUNCATE','REFERENCES','TRIGGER');        -- 0
--   select defaclrole::regrole, defaclobjtype, defaclacl from pg_default_acl
--    where defaclnamespace='public'::regnamespace;                        -- no r/x/t bits for anon/authenticated
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Future tables created by postgres (the role migrations run as): keep the same posture.
-- (supabase_admin also has a default ACL for public, but `alter default privileges for role
--  supabase_admin` needs membership of that role, which postgres does not have — left alone.)
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
