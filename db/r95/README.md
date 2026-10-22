# db/r95 — nothing to paste

R95's only DDL is `supabase/migrations/20261022090000_r95_introducer_rpcs.sql`: it creates
`get_introducer_cases()` / `get_introducer_clients(uuid[])` (SECURITY DEFINER, `session_ok()` +
`my_introducer_id()` scoped, execute to `authenticated` only) and drops the two owner-rights views
`v_introducer_cases` / `v_introducer_clients` (Security Advisor ERROR ×2).

**The merge applies it** (Supabase GitHub integration; the PR's Preview Branch replays it first).
Daniel does NOT paste it. `admin/introducer.html` / `admin/introducer.js` read the RPCs in the same PR.

Verify after merge (SQL editor):
- `select proname from pg_proc where proname like 'get_introducer_%';` → 2 rows
- `select count(*) from pg_views where viewname like 'v_introducer_%';` → 0
- Then sign in to `/admin/introducer.html` as an introducer: both lists render as before.
- Do not re-run section A of `db/r94/01_advisors.sql` after this: its `alter view` would fail.
