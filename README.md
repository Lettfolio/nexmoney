# NexMoney

The public website for NexMoney Ltd (an FCA-regulated mortgage brokerage) and `admin/`, the
broker back office its advisers, administrators and owner work in every day.

## Architecture

A static site (root `*.html`, `style.css`, `enhance.js`) and a single-page back office (`admin/`:
nine classic scripts (boot.js + core.js … app.js) sharing one global scope, loaded in the order
`core.js → reports-money.js → diary.js → import.js → vault.js → site.js → app.js`). Both talk
to one Supabase project, `sclghkmvzpwtmnzbkaoe` (eu-west-2): Postgres with RLS, Auth, Storage,
cron and edge functions (source in `edge/`). Vercel project `nexmoney` builds `main` with
`node build.js` (esbuild minify into `dist/`) and serves it. No framework, no server of our own.

## Run it

```
npm ci                          # esbuild, marked, xlsx, eslint
node smoke.js                   # regenerates admin/mock.html, 150 checks on the mocked back office
node build.js --hash            # SHA-256 of every built file (what live must serve)
bash tests/run-battery.sh 1 4   # shard 1 of 4 of the Playwright battery (CI runs all four)
```

The harness serves the repo on port 8099 against `admin/mock-supabase.js` (synthetic data only);
the suites expect the checkout at `/root/nx`. Playwright 1.56.0 is installed by CI, not the lockfile.

## The deploy rule

**Every change is a pull request → the CI battery passes → Daniel merges. Nobody pushes `main`.**
Vercel deploys `main`; the change is then live-verified (served hashes, build tags, error log).
Edge functions and SQL are not deployed by a merge: edge is deployed from `edge/` by the CTO,
SQL in `db/` is pasted by Daniel. Details: `HARNESS.md` › "Deploy — every change is a PR".

## Where things are

| Path | What |
|---|---|
| `HARNESS.md` | the test harness, battery, CI and every round's rules — read before changing code |
| `GO-LIVE-RUNBOOK.md` | moving nexmoney.co.uk onto this site, step by step |
| `db/README.md` | the hand-applied SQL by round, and the schema-drift check |
| `supabase/migrations/` | the migration record exported from the live project |
| `docs/` | audits and reference papers |
| `docs/rounds/` | closed rounds' contracts, slice reports and verifier notes |
| `.github/workflows/battery.yml` | the CI battery every PR must pass |

## Rules that bite

- Never commit `dist/`, `node_modules/`, `.vercel/` or real client data (fixtures are synthetic).
- Never hand-edit `admin/mock.html`; `node smoke.js` regenerates it from `admin/index.html`.
- Editing any admin script means bumping the build tag in all eight places (`HARNESS.md`).
- The Supabase anon key in `admin/app.js` is public by design; every other secret lives in
  Supabase or Vercel, never here.
