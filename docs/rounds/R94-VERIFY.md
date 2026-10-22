# R94 · Foundations — verifier report (adversarial)

Branch `r94-foundations` @ `554f7fe` (merge of A/B/C/D), base `fba26c6`. Everything below was run from
`/root/nx` (HEAD) and `/tmp/nx-base` (git worktree of `fba26c6`, node_modules symlinked). No git write
commands, no Supabase writes; `vercel.json` was mutated once for a test and restored byte-identical
(`cmp` against a copy + `git status` clean).

## What held up (claims I could not refute)

| Check | Result |
|---|---|
| `node smoke.js` | `SMOKE: 150 checks, 0 failures`; regenerated `admin/mock.html` is byte-identical to the base worktree's regeneration; `git status --short` empty afterwards (`shots/` ignored) |
| `npm run lint` / `npx tsc -p jsconfig.json --noEmit` | both rc=0, 0 problems |
| `node build.js --hash` HEAD vs base | ten lines each; only `reports-money.js` (f0bc03c7→0d24da88), `import.js` (a129603d→0121ba86), `app.js` (8acec4da→a1b02ddd) differ — exactly what R94-B.md says |
| Dead-code removal | every deleted identifier (`MATCH_CLIENT_COLS`, `fetchMatchClientsFromBook`, `autoDrawer`, `FIN_PROMO_TYPES`, `buildJumpNav`, `jumpNavActivePaint`, `protPhoneHtml`, `PROT_STAMP_COLS`, top-level `EMAIL_STATUSES`, `caseTlChip`, `createdClient` (acceptLead local), `BASIS_EARNED_MONTH`, `BASIS_OWED`, `miState`, `appAndCompleted`/`offerAndCompleted` (renderPipelineMI locals), `label`, `REV_CLIENT_DIFF`) grepped across tests/, smoke.js, admin/mock-supabase.js, admin/index.html, HARNESS.md: only prose/comment mentions remain; no `page.evaluate` reaches any of them. The surviving `EMAIL_STATUSES` (app.js:21664) and `appAndCompleted` (reports-money.js:1072) are different, function-local bindings |
| DOM oracle (lighter form — `panel-r87/dom-dump.js` is not in the clone) | Playwright walk of `mock.html?as=p1..p4` × every nav page + p4 case modal + client modal, on base (port 8098) and HEAD (8099): 40 views, `body.innerText` (clocks masked), element count, every `[id]` with visibility, `<main>` HTML length — **0 differences** |
| Full build | `NX_CONTENT_OPTIONAL=1 node build.js` rc=0 on both trees. `dist/` file list diff base→HEAD: only `-.github/workflows/battery.yml` and `-assets/hero-loop-original.mp4`. No docs/, supabase/, .md, eslint.config.js, jsconfig.json, tsconfig*; `dist/assets/hero-loop.mp4` (447 KB) and `hero-poster.jpg` present |
| `tests/r94_csp.js` | 61 passed, 0 failed |
| `tests/r82_correct.js` (slice A edited it) | 131 passed, 0 failed |
| battery.yml / dependabot.yml | both parse (PyYAML). `11d5960a…` = `actions/checkout` `refs/tags/v4` **and** `v4.4.0`; `ea165f8d…` = `actions/upload-artifact` `v4`/`v4.6.2` (git ls-remote). `permissions: contents: read` at top; `npm run lint` after `npm ci`; eslint/typescript/globals/espree all in package-lock |
| Docs moves | every moved file grepped by old name across tests/, smoke.js, build.js, HARNESS.md, README.md, GO-LIVE-RUNBOOK.md, admin/: only prose citations by name (tests/r8_rev.js, r93_content.js, mock-supabase.js comments); the one path link (HARNESS.md:677) re-pointed |
| edge/ | only the highest -vN per function remains (22 files). Each v<N+1> diffs from vN in exactly the stated places (header comment, ORIGINS/withCors/tooBig block, CORS ACAO line, `handle` wrapper + `Deno.serve` line, size-cap line; unsubscribe adds `uuidRe` + one check). All responses are `new Response(...)` (mutable headers) so `withCors` cannot throw on a redirect. No-Origin requests (email click, curl, cron) still work (ACAO falls back to www). OPTIONS preflight still returns 200 with ACAO via withCors. `Vary: Origin` set |
| `edge/doc-upload-v5.ts` vs live `doc-upload` (MCP, version 5) | 199 lines; header, `MAX_UPLOADS_PER_TOKEN_PER_HOUR = 20`, magic-byte checks, R79 expiry lines, trailer all identical (spot-check of 6 unique lines + line count) |
| db/r94/01_advisors.sql | `$$` balanced; no `drop extension`; `alter view … set (security_invoker=false, security_barrier=true)` valid and harmless; the four `drop table if exists` name exactly the four advisor backups. Live `cron.job`: jobs 1/3/6 have body `'{}'::jsonb`, no timeout; job 7 has `timeout_milliseconds := 60000` — the rewrite reproduces body, Bearer, `x-cron-key` header name and timeout. All four jobs run as `username = postgres`; `has_table_privilege('postgres','vault.decrypted_secrets','select')` = **true**, `vault.create_secret(text,text,text,uuid)` executable, vault 0.3.1, 0 secrets today. Vault block guarded by `if not exists (select 1 from vault.secrets where name = …)` so a second run creates no duplicate; second run re-parses the rewritten commands (Bearer + fn still present) to the same text |
| supabase/migrations | 122 files (live `schema_migrations` = 122 rows, so the contract's "123" was wrong, as R94-D.md says); first `20260704161623_initial_schema`, last `20260908191604_r86_03_get_team_mfa`. The three newest files hash-match the live `array_to_string(statements, E';\n\n')` exactly (md5 after the 3-line header + blank line). `cron_key` redacted in `20260718165010_…`; the live key (48 hex chars, md5 compared, never printed) appears nowhere in the tree nor in the last 400 commits' blobs |
| README.md | 52 lines; R94-A/B/C/D ≤ 80; supabase/README 17; db/r94/02 14 |
| Extra suites run one at a time (chosen by grepping tests/ for identifiers in the changed hunks) | r90_case_split 81/0 · r65_pipeline 127/0 · r76_intake 97/0 · r40 63/0 · r8_rev 176/0 · r85_book 97/0 · r34 60/0 · r89_reports 81/0 — all rc=0 |

## Findings

### P1 — none that I could demonstrate.

### P2 — fix before merge (or gate the merge on a check)

**1. `tests/r94_csp.js` does not catch `https://fonts.gstatic.com` missing from the ADMIN `font-src`.**
Evidence: edited `vercel.json` (admin entry only) to `font-src 'self'`, ran the suite → `r94_csp: 61 passed, 0 failed`;
restored from `git show HEAD:vercel.json`, `cmp` identical. Why: §A18 asserts `font-src` for the SITE policy only
(tests/r94_csp.js:136-137); at runtime the sandbox proxy 403s `fonts.googleapis.com`, so no `@font-face` request
is ever made and nothing can violate. R94-C.md's "every mutation caught" list did not include this directive.
In CI (network available) the runtime walk would probably catch it, but the suite's contract says it proves the
policy and it does not. Fix: add a static assertion mirroring A18 for `ADMIN`:
`allowed(ADMIN,"font-src","https://fonts.gstatic.com/s/inter/v1/x.woff2")`, and (cheap) assert the `preconnect`
hosts in admin/index.html / introducer.html are in font-src/style-src.

**2. Vercel same-key header precedence is asserted, not observed — and the failure mode is the admin login page.**
R94-C.md relies on "the later matching entry overrides for the same key". The Vercel docs returned by
`search_vercel_documentation` say only "continuing to match subsequent headers is the default behavior"; the
override statement comes from the Next.js `headers()` docs. I could not observe it live (proxy 403s
`nexmoney.co.uk`/`nexmoney-two.vercel.app`; the Vercel MCP bypass fetch is denied for this project). Before R94 the
site entry carried only `frame-ancestors 'none'`, so two enforced CSPs would have been invisible; after R94, if
both headers were sent, `/admin` would be enforced under `script-src 'self' 'unsafe-inline'` as well → the
supabase-js `<script>` from cdn.jsdelivr.net is blocked → no login. Vercel's `headers` compile to routes with
`continue:true` and a per-key `headers` object, so I believe the override claim is right, but it must be seen.
Fix (process, not code): on the PR's **preview deployment**, open `/admin` in DevTools → Network → the document
response must show exactly ONE `content-security-policy` header and it must be the admin one; only then merge.
If two appear, change the site source to exclude admin, e.g. `"/:path((?!admin).*)"` (path-to-regexp negative
lookahead, supported by Vercel), and re-verify. Also note `/admin/:path*` matches `/admin` itself (zero
segments) — this is the same pattern the pre-existing `X-Robots-Tag`/`Cache-Control` rules already rely on.

**3. (really P3 — a note, no defect) The vault secret block's "no-op when vault is absent" guard is fine, but the block will `raise exception`
(and roll back the whole file) on a second run if Daniel has rotated via E2 incorrectly** — i.e. the file is
idempotent only while `vault.decrypted_secrets` = `settings.cron_key`. That is documented at
db/r94/01_advisors.sql:122-125 and is the intended abort. Not a defect; recorded so the fixer does not "fix" it.
What IS missing: the VERIFY-E query (line 197-199) expects job 2 `uses_vault = f`; fine. But the E1 purge
(`delete from cron.job_run_details …`) is a comment Daniel will paste — it deletes rows by `command like
'%x-cron-key%'` which also matches the NEW commands' history rows unless they contain `vault.decrypted_secrets`
(they do) — OK. No action.

**4. `edge/*-v<N+1>.ts` size cap is Content-Length only.** `tooBig()` reads the header; a chunked or
header-less POST bypasses it and `req.json()`/`req.formData()` still buffers everything (R94-D.md calls it a
"body cap before req.json()" — it is a declared-length cap). Fix (small): after the header check, read via
`req.body` with a byte counter, or at minimum `const txt = await req.text(); if (txt.length > MAX_BODY) return 413;
JSON.parse(txt)` for the three JSON functions. Deno's edge runtime has its own limits, so this is defence in
depth, not an open hole → borderline P2/P3; listed as P2 because the report's wording overstates it.

### P3 — note for R95

**5. HARNESS.md stale after R94:** line 222 "`node build.js --hash` prints SEVEN admin hashes" (eight admin
files, ten lines incl. style.css/enhance.js); line 243 "the same seven hashes"; line 5566 "bumped in ALL
SEVEN places" (eight since R93); line 1257-1259 documents `buildJumpNav`/`jumpNavActivePaint` (deleted in
R94·B); line 5908 `protPhoneHtml` (deleted); lines 3934/3952/5181/5212 `autoDrawer` (deleted — and app.js
comments at 3394, 3410, 7450 still name it); line 1712 `wireChipStripOverflow` (kept but dead, R95 delete).
Also HARNESS.md:5590-5594 still says the mock files are kept out of the deploy by `.vercelignore` — the
mechanism is build.js SKIP_FILES/SKIP_DIRS (outputDirectory=dist). `.vercelignore` still lists the deleted
`hero-loop-original.mp4` (inert).

**6. `eslint.config.js` requires `espree` (line 20) which is not a declared devDependency** — it resolves
only because npm hoists eslint's transitive dep. A future eslint bump that changes its parser packaging breaks
`npm run lint` in CI with "Cannot find module 'espree'". Fix: `npm i -D espree@<the version in the lockfile>`.

**7. `tsc` is not run in CI.** build-check runs `npm run lint` but not `npx tsc -p jsconfig.json --noEmit`,
so the two `@ts-check` files can regress silently. Add the one line after lint.

**8. GO-LIVE-RUNBOOK.md §2.4 still says "git rm middleware.js gate.html"** but neither file is tracked
(`git ls-files | grep -i gate` → none) — pre-existing, now wrapped in R94's "merge Claude's PR" wording.
Reconcile with the live state of the reviewer gate.

**9. Shared-use lint rule is lenient by construction** (eslint.config.js:122-135): a top-level name counts as
"used" if the bare word appears in ANY string literal of ANY admin script or in index.html. Names like `label`
or `status` can never be reported dead. Fine for a zero-churn round; say so in the config header.

**10. `supabase/README.md` says "SQL pasted in the SQL editor records no row, so db/r85/02 … are NOT in
this folder"** — correct, but the contract's "verify count == 123" came from the same assumption being
wrong the other way. Nothing to fix; the number 122 is now in three places (README, R94-D, this file) and must
be bumped the day Daniel pastes r94 via `supabase db push` instead of the editor.

## Verdict

**fix-then-ship.** Nothing in the merge breaks the product (hashes, smoke, DOM oracle and 10 battery suites
prove the admin is byte-for-byte and DOM-for-DOM the same; dist/ loses only the two files it should). The two
things to do before merge are small: add the admin `font-src` static assertion to `tests/r94_csp.js` (P2-1) and
make the merge conditional on seeing exactly one CSP header on the preview deployment's `/admin` (P2-2) — the
latter is the only item with a prod-breaking failure mode and it is a five-minute browser check, not code.
P2-4 can ride along if the fixer is already in edge/. The SQL and edge files are not deployed by the merge, so
their items (P2-3 note, P2-4) do not gate it.
