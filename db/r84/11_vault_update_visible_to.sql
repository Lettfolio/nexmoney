-- R84 · S2-2 (P1) — vault_entries UPDATE must honour visible_to
--
-- WHAT: "staff update vault" was `using is_staff() with check is_staff()`. Read visibility is
-- narrowed by visible_to, but any staff member could UPDATE any entry — including a blind,
-- unfiltered PATCH that sets visible_to = NULL on rows they cannot see, which then makes the
-- owner-only secrets readable. The admin app hides the control from advisers (app.js ~36726) —
-- that guard was client-side only.
--
-- FIX: the UPDATE policy uses the same predicate as "staff read vault" (via my_role(), which is
-- SECURITY DEFINER and reads the caller's own profile), for BOTH the existing row (USING) and the
-- new row (WITH CHECK). WITH CHECK also means a caller cannot re-scope an entry to a set of roles
-- that excludes their own role (they could not read it back afterwards, and an adviser could not
-- "hide from owner" either — owner is the only role that may narrow to owner-only).
--
-- EXPECTED EFFECT: advisers can still edit every entry they can see; entries restricted to
-- roles they are not in are untouchable (UPDATE affects 0 rows). Currently 0 restricted rows in
-- production, so no visible change today.
--
-- VERIFY (after apply):
--   select policyname, qual, with_check from pg_policies
--    where tablename='vault_entries' and cmd='UPDATE';
--     -- one row, both expressions mention visible_to and my_role()
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

drop policy if exists "staff update vault" on public.vault_entries;
create policy "staff update vault" on public.vault_entries
  for update to public
  using (
    (select public.is_staff())
    and (visible_to is null or cardinality(visible_to) = 0
         or (select public.my_role()) = any (visible_to))
  )
  with check (
    (select public.is_staff())
    and (visible_to is null or cardinality(visible_to) = 0
         or (select public.my_role()) = any (visible_to))
  );
