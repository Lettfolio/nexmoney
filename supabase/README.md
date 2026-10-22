# supabase/

`migrations/` is the rebuild record of the live project `sclghkmvzpwtmnzbkaoe` (eu-west-2):
one file per row of `supabase_migrations.schema_migrations`, exported 2026-10-21 (R94 · D),
122 files, `20260704161623_initial_schema` … `20260908191604_r86_03_get_team_mfa`.
Statements are verbatim except one redaction: the `cron_key` literal in
`20260718165010_add_settings_promo_gate_and_cron_key.sql` (secrets never enter git).

SQL pasted in the SQL editor records no row, so `db/r85/02_clients_updated_at_idx.sql`,
`db/r93/*` and `db/r94/*` are NOT in this folder — `db/` is their record (see `db/README.md`).

Re-fetch: once the CLI is linked (`supabase link --project-ref sclghkmvzpwtmnzbkaoe`),
`supabase migration fetch` rewrites this folder from the live table; diff before committing.

**The Supabase GitHub integration applies this folder to PRODUCTION when a PR merges to
`main`** (branching enabled on the project 21 Oct 2026; every PR also gets a data-less Preview
Branch, the "Supabase Preview" check). Files whose version is already in the live
`schema_migrations` table are skipped, so the R94 export is a no-op on merge.

New DDL from here on: write `supabase/migrations/<yyyymmddhhmmss>_r<nn>_<name>.sql`
(idempotent, header comment, verify query at the end), open the PR, and the merge applies it —
**Daniel does NOT paste it as well** (that would run it twice). One-off operational scripts that
touch secrets, cron jobs or data (e.g. `db/r94/01_advisors.sql`) stay in `db/` and are pasted by
hand; they never go in this folder. Nothing else applies DDL.
