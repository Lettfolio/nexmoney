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

New DDL from here on: write `supabase/migrations/<yyyymmddhhmmss>_r<nn>_<name>.sql`
(idempotent, header comment, verify query at the end) AND Daniel pastes it in the SQL editor
(or applies it with `supabase db push`). Nobody applies DDL that is not in this folder.
