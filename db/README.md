# db/

The SQL record of the live Supabase project `sclghkmvzpwtmnzbkaoe` (eu-west-2).

- `supabase/migrations/` (repo root) — every migration the project recorded, exported
  2026-10-21; the rebuild record up to R86.
- `db/r<NN>/` — the files of each round that Daniel pastes in the SQL editor. The editor records
  no migration row, so these folders are the only record of what was pasted (R85-02, R93, R94…).
- `_live_functions_snapshot.sql`, `columns.json` / `columns.sql`, `check-schema-drift.js` — the
  schema-drift check the battery runs against the app's column use.

House style for a `db/r<NN>/` file (see `r86/01_session_ok.sql`, `r93/01_site_tables.sql`):
a header saying WHAT and WHY, idempotent statements (`create or replace`, `if not exists`,
`drop policy if exists`), `begin; … commit;` so a dry run is a ROLLBACK, and a VERIFY block of
queries with their expected answers. Function rewrites copy the live body verbatim and tag only
the changed lines. New RPC guards include `public.session_ok()` (R86 rule). Never a secret value:
read it at run time (Vault / settings) or copy it from the live object inside the script.

Paste order inside a round is the file number order. Nobody applies SQL from a chat or a
branch that is not merged: the PR carries the file; after the merge Daniel pastes the `db/`
scripts and the verify queries go in the PR thread. From R95, plain DDL goes in
`supabase/migrations/` instead and ships on the merge itself (see `supabase/README.md`); `db/`
keeps the one-off operational scripts (secrets, cron, data fixes) that are pasted by hand.
