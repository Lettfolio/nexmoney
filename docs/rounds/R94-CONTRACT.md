# R94 · Foundations — shared contract

Base: origin/main `fba26c6` (R93 merged). Branch `r94-foundations`. Four builders on disjoint
slices in worktrees `/root/nx-A` … `/root/nx-D` (branches `r94-A` … `r94-D`), then merge →
verifier → fixer → tag bump → PR. **Daniel merges; nobody pushes main.**

Why this round: the CTO review (21 Oct 2026) found the code sound and the risk in *where the
truth lives and who can act on it*: schema only inside Supabase, deploy path through Daniel's
Windows tree, no linter on 26k lines of shared-global JS, CSP that only sets frame-ancestors,
advisor errors left open, and a root directory of 13 reports. R94 fixes those without touching
product behaviour. **No user-visible change** to the back office or the site is the acceptance
bar (DOM oracle applies; `smoke.js` 150/150; `node build.js --hash` still prints eight hashes).

## House rules (all slices)

- Daniel wants simplification: no new pages, panels, prose or settings. Docs you write are
  short; README ≤ 60 lines.
- Comment rules: WHY comments ≤ 6 lines, `"R94 · <slice><n>: <why>"` one-liners, no tombstones.
  Comments the suites read (kit fences, LOAD-ORDER notes, openCase end marker) must stay.
- Definition-time rule: a page file's top-level statements may not reference anything from a
  LATER script (`core.js → reports-money.js → diary.js → import.js → vault.js → site.js → app.js`).
- Never edit `admin/mock.html` by hand; after any `admin/index.html` change run `node smoke.js`.
- Never commit `dist/`, `node_modules/`, `.vercel/`.
- Secrets: never print, never commit. The anon key in `app.js` is public by design.
- Do NOT bump the eight build tags — the CTO bumps them once at merge.
- Before you finish: `node smoke.js` passes 150/150 in your worktree; `node build.js --hash`
  prints eight hashes; `git status` shows only your files; commit on your branch with a message
  starting `R94 · <slice>:`. Write `R94-<slice>.md` at the repo root (≤ 80 lines): what changed,
  what you verified, what you deliberately left alone and why.

## Ownership (disjoint — do not edit another slice's files)

| Slice | Owns | Must not touch |
|---|---|---|
| A — hygiene, docs, deploy flow, CI | `README.md` (new), `docs/**` (new), `.github/**`, `HARNESS.md`, `GO-LIVE-RUNBOOK.md`, `edge/*` **deletions only**, `assets/hero-loop-original.mp4` deletion, `.gitignore` | `package.json`, `build.js`, anything in `admin/`, `vercel.json`, `db/` |
| B — lint, types, build env | `package.json`, `package-lock.json`, `eslint.config.js` (new), `jsconfig.json` (new), `build.js`, `admin/*.js` (edits for lint/@ts-check), `db/check-schema-drift.js` | `admin/index.html`, `vercel.json`, `.github/**`, `tests/**` (except adding `tests/r94_lint.js` if useful) |
| C — CSP | `vercel.json` (headers only), `tests/r94_csp.js` (new), `tests/run-battery.sh` (register the new suite only) | `admin/*`, `*.html`, `.github/**` |
| D — Supabase | `db/r94/**` (new), `supabase/migrations/**` (new), `edge/*-v<N+1>.ts` **additions only**, `db/README.md` (new, short) | `admin/*`, `vercel.json`, `build.js`, `.github/**` |

Cross-slice facts each builder relies on:
- A moves the root reports to `docs/`; **B adds `"docs"` and `"supabase"` to `SKIP_DIRS` in build.js** so
  nothing new ships to dist.
- A adds a `- run: npm run lint` step to `build-check` in `battery.yml`; **B defines
  `"lint": "eslint ."` in package.json** and makes it pass. A pins the step even though B's
  script lands in a sibling branch — at merge both exist.
- A deletes every `edge/<fn>-vN.ts` except the highest N per function; D only ADDS `v<N+1>` files.
- `HARNESS.md` and `GO-LIVE-RUNBOOK.md` stay at the root (the skill and runbooks link them).

## Slice A — hygiene, docs, deploy flow, CI

1. `README.md` (≤ 60 lines): what the repo is, the one-paragraph architecture (static site +
   `admin/` back office → Supabase `sclghkmvzpwtmnzbkaoe` eu-west-2 → Vercel project `nexmoney`),
   how to run (`npm ci`, `node smoke.js`, `node build.js --hash`, `bash tests/run-battery.sh 1 4`),
   **the deploy rule: every change is a PR → CI battery → Daniel merges; nobody pushes main**,
   where the docs are (`HARNESS.md`, `GO-LIVE-RUNBOOK.md`, `docs/rounds/`, `db/README.md`).
2. Move to `docs/rounds/`: every `R*.md` at the root. Move to `docs/`: `FIXTURES-R7.md`,
   `MOBILE-COMPAT-AUDIT.md`, `RED-TEAM-STATE.md`, `SEO-AEO-Audit.md`, the two `.docx`, the `.pdf`.
   **First `grep -rn` tests/, smoke.js, build.js, HARNESS.md for each filename** and fix any
   reference (git mv so history follows).
3. Delete `assets/hero-loop-original.mp4` (1.5 MB, unreferenced — confirm with grep before deleting).
4. `edge/`: keep only the highest-numbered `-vN.ts` per function (git history keeps the rest).
   Confirm each kept version's hash matches the deployed `ezbr_sha256` is NOT required (they are
   source, not bundles) — just keep the highest N.
5. `.github/workflows/battery.yml`: pin every `uses:` to a full commit SHA with a `# vX` comment
   (look up the current tags for `actions/checkout@v4` and `actions/upload-artifact@v4` with
   `gh api` if available, else `git ls-remote https://github.com/actions/checkout`). Add
   `- run: npm run lint` to `build-check` after `npm ci`. Set `permissions: contents: read` at the
   top. Add `.github/dependabot.yml` (npm weekly, github-actions weekly, grouped).
6. `HARNESS.md`: replace the deploy/“who can do what” prose with the PR rule (≤ 25 lines):
   Claude pushes a branch via its GitHub route and opens a PR; the ruleset requires the battery;
   Daniel merges; Vercel deploys main; live-verify eight hashes + `__errorLog 0`. State that
   `device_commit_files` / GitHub web upload / `git` in Daniel's folder are **retired** for code.
   Also move the "repository layout" paragraph to match the new `docs/` tree.
7. `GO-LIVE-RUNBOOK.md`: add the three Vercel/GitHub settings Daniel should flip (ruleset: require
   PR + battery, no bypass; Dependabot alerts + secret scanning on; Vercel "notify on failed
   production build"). Three bullets, no essay.

## Slice B — lint, types, build env

1. `npm i -D eslint@9 globals` (exact versions, lockfile updated). `eslint.config.js` (flat):
   - targets `admin/core.js, reports-money.js, diary.js, import.js, vault.js, site.js, app.js,
     sw.js, sw-kill.js, enhance.js, build.js, smoke.js, db/*.js`; ignores `admin/mock-supabase.js`,
     `admin/mock.html`, `dist/`, `tests/**`, `node_modules/`, `docs/`.
   - rules: `no-undef`, `no-redeclare`, `no-dupe-keys`, `no-unreachable`, `no-unused-vars`
     (`{ vars: "all", args: "none", caughtErrors: "none" }`), `no-implicit-globals: off` (classic
     scripts), `eqeqeq: off` (don't churn), everything else off. Browser + ES2022 globals for the
     admin files, node globals for build/smoke/db.
   - **The load-order globals problem is the point of this slice.** Each classic script declares
     top-level `function`/`const`/`let` that LATER scripts use. Generate the shared-global list
     mechanically (a small `scripts/globals-from-load-order.js` is fine, or do it once and commit
     the list in the config with a comment saying how it was produced). Lint must FAIL if a file
     references a symbol defined only in a LATER script — that is the definition-time rule; if
     ESLint cannot express it exactly, approximate per-file `globals` as "everything defined in
     EARLIER files + window.* assignments" and document the gap.
2. Make `npm run lint` pass with **zero** warnings. Fix real defects (true undefined references,
   dead variables); for intentional patterns use the narrowest `// eslint-disable-next-line`
   with a 1-line why. Keep the diff minimal — this is not a style pass. Report every real defect
   found in `R94-B.md`.
3. `jsconfig.json` (`checkJs: false`, `target: es2022`, `lib: dom`) and `// @ts-check` at the top of
   `admin/core.js` and `admin/site.js` only, with the handful of `/** @type */` annotations needed
   to make `npx tsc -p jsconfig.json --noEmit` (install `typescript` as devDependency) clean for
   those two files. If a file needs > 15 annotations, stop and report instead.
4. `build.js`: read `SUPABASE_URL` / `SUPABASE_ANON_KEY` from `process.env` first and fall back to
   the regex on `admin/app.js` (keep the fallback, log which source was used — never log the key).
   Add `"docs"` and `"supabase"` to `SKIP_DIRS`. Add `"package.json"`-adjacent new files
   (`eslint.config.js`, `jsconfig.json`, `tsconfig*.json`) to `SKIP_FILES`. `node build.js --hash`
   must print the **same eight hashes** as before your change (record before/after in `R94-B.md`).

## Slice C — CSP

Facts: `/admin` CSP today is `frame-ancestors 'none'; script-src 'self' 'unsafe-inline'
https://cdn.jsdelivr.net https://cdn.sheetjs.com`; site-wide only `frame-ancestors 'none'`.
The admin JS emits ~185 inline `on*=` handlers, so `'unsafe-inline'` for **script-src stays this
round** (R95 candidate: event delegation). Everything else gets locked down.

1. `vercel.json` `/admin/:path*` CSP — propose and verify:
   `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.sheetjs.com;
   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
   img-src 'self' data: blob: https://www.google.com https://*.gstatic.com; connect-src 'self'
   https://sclghkmvzpwtmnzbkaoe.supabase.co wss://sclghkmvzpwtmnzbkaoe.supabase.co <any other origin
   the admin JS fetches — grep admin/*.js for https:// and fetch(/XMLHttpRequest/EventSource>;
   worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
   frame-ancestors 'none'; upgrade-insecure-requests`. Check `admin/*.webmanifest`, the service
   worker, blob/PDF viewers (`parse-offer` previews, evidence pack print), `introducer.html`.
2. Site-wide `/(.*)` CSP: same shape; inventory `*.html` + `enhance.js` for every external origin
   (fonts, hero video, Trustpilot, analytics, maps, the Supabase edge `new-lead`/`nps-capture`/
   `fact-find`/`doc-upload` calls, Google Fonts `onload=` handler). Use `'unsafe-inline'` for
   script-src only if a hash set is impractical; say which in `R94-C.md`. `/admin` rule must come
   AFTER the site rule in `vercel.json` so it wins (Vercel applies the last match — verify in the
   Vercel docs and state what you found).
3. `tests/r94_csp.js`: Playwright suite in the house style (REPO=/root/nx, PORT=8099, `rc=` line).
   For each policy, load the page with the policy injected as `<meta http-equiv=
   "Content-Security-Policy">` (strip `frame-ancestors`/`upgrade-insecure-requests`, which meta
   ignores) — for the admin use `admin/mock.html?as=p1..p4` walking every nav page the way
   `smoke.js` does; for the site load `index.html`, `contact.html`, `calculators.html`,
   `factfind.html`, `docs.html`, `feedback.html`. Collect `securitypolicyviolation` events and
   console CSP errors; assert zero (allow-list the sandbox's known CDN 403s exactly as `smoke.js`
   does). Register it in `tests/run-battery.sh` the way sibling suites are registered.
4. Report in `R94-C.md`: the final policies, every origin and why, the inline-handler counts per
   file (`grep -cE 'on(click|change|input|submit|key[a-z]+)="'`) as the R95 scope.

## Slice D — Supabase

You have the Supabase MCP (read-only in practice: the session guard cancels writes — **do not try
to apply anything; produce SQL for Daniel to paste**). Project ref `sclghkmvzpwtmnzbkaoe`.

1. `supabase/migrations/`: export every row of `supabase_migrations.schema_migrations`
   (`version`, `name`, `statements`) to `supabase/migrations/<version>_<name>.sql` — one file per
   migration, statements joined with `;\n\n`, a 3-line header comment saying it was exported
   from the live project on 2026-10-21 and is the rebuild record. Verify count == 123 and that
   `cat supabase/migrations/*.sql | grep -c 'create table'` is plausible. Add `supabase/README.md`
   (≤ 20 lines): how to re-fetch (`supabase migration fetch` once the CLI is linked), and that
   new DDL goes in `supabase/migrations/` as `<ts>_r<nn>_<name>.sql` AND is pasted by Daniel.
2. `db/r94/01_advisors.sql` — one idempotent script:
   - `v_introducer_cases`, `v_introducer_clients`: fetch the live definitions (`pg_get_viewdef`),
     recreate with `security_invoker = true` IF the introducer RLS policies make that safe —
     read the policies on the underlying tables and the view's grants first; if not safe, leave
     the view and write why in the SQL header.
   - Drop `backup_case_notes_pre_sb1`, `backup_cases_pre_sb1`, `backup_clients_pre_sb1`,
     `backup_r70_retention_link` (Daniel's own housekeeping list; confirm row counts in a
     comment so he sees what goes).
   - `pg_net` out of `public`: investigate (`\dx`-equivalent: `select extname, extnamespace::regnamespace,
     extrelocatable from pg_extension`; where do `net.http_post`'s functions live?). If the
     extension is NOT relocatable, do NOT write a drop/recreate — write the finding and the
     Supabase-recommended path in a comment only. Five cron jobs call `net.http_post`; breaking
     them is not acceptable.
   - Gates: read `run_watchtower`, `reassign_holdings`, `find_duplicate_clients` bodies; confirm
     each calls `session_ok()`/`is_staff()`/`is_admin_or_owner()` before doing work. If one
     doesn't, add `if not public.is_staff() then raise exception ... end if;` (match the house
     pattern in `db/r86/02_rpc_guards.sql`) — as `create or replace` of the full function.
   - `settings.cron_key` → Supabase Vault: write the SQL to create the vault secret and rewrite
     the five `cron.job` commands to read it (`vault.decrypted_secrets`), guarded so it is a
     no-op if `vault` isn't available. Keep the plaintext row until Daniel confirms the jobs ran.
   - Unused-index drops: list the 19 from the advisor as COMMENTED statements only (indexes
     created in R18/R55 for scale; dropping is Daniel's call).
3. `db/r94/02_auth_settings.md` (≤ 15 lines): the dashboard toggles Daniel flips — sign-ups OFF,
   min password 12, Auth DB connections → percentage, confirm daily backups / consider PITR.
4. Public edge functions review — read `edge/new-lead-v4.ts`, `nps-capture-v4.ts`, `fact-find-v4.ts`,
   `unsubscribe-v2.ts`, and the deployed `doc-upload` (no source in repo: fetch it with the MCP
   `get_edge_function` and save it as `edge/doc-upload-v5.ts` verbatim first, commit that, THEN
   patch as v6). For each: body-size cap, MIME allow-list on uploads, per-IP rate cap, input
   length caps, CORS origin restricted to `https://www.nexmoney.co.uk` + `https://nexmoney.co.uk`
   (+ `https://nexmoney-two.vercel.app` for a week — say so), no secrets in error bodies. Write
   `v<N+1>.ts` ONLY for functions with a real gap; copy verbatim and change the minimum. Table of
   findings in `R94-D.md`. Do not deploy — the CTO deploys via MCP after the verifier.

## Verifier (after merge) — told to refute

Checks it must run, at minimum: smoke 150/150; eight hashes unchanged vs base except where a
slice says otherwise and why; `npm run lint` clean; `tsc` clean on the two files; `node
build.js` (full, with `NX_CONTENT_FIXTURE`) writes dist/ with NO `docs/`, `supabase/`, `.md`,
`.mp4-original`; `tests/r94_csp.js` passes; every moved doc still has no dangling reference;
`battery.yml` parses (`node -e` YAML or `yq`), pinned SHAs resolve to the stated tags;
migrations count 123 and the last file matches `r86_03_get_team_mfa`; each `db/r94` script
parses (`psql --dry`-equivalent: at least balanced `$$`, `create or replace` only, no
`drop extension`); edge v<N+1> files diff from v<N> only in the stated places; DOM oracle — no
user-visible change on any admin page across p1–p4.
