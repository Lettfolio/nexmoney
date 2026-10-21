# R94 · Foundations — round report (21 Oct 2026)

Branch `r94-foundations` on base `fba26c6` (R93 merged). Four Opus builders on disjoint slices,
Fable verifier told to refute (`R94-VERIFY.md`: no P1, fix-then-ship), fixer commit `369706b`.
**No user-visible change**: smoke 150/150, DOM oracle 40 views × p1–p4 identical to base,
ten suites green, dist/ loses only `.github/workflows/battery.yml` and `hero-loop-original.mp4`.

## What changed

| Slice | Delivered |
|---|---|
| A — hygiene, deploy flow, CI | `README.md`; root reports → `docs/rounds/`, audits/docx/pdf → `docs/`; 1.5 MB unused video deleted; `edge/` pruned to the current version of each function; `battery.yml` pinned by SHA (`checkout` v4.4.0, `upload-artifact` v4.6.2), `permissions: contents: read`, `npm run lint` + `tsc` in build-check; `.github/dependabot.yml`; HARNESS "Deploy — every change is a PR"; runbook §1.5 (ruleset: PR + battery, no bypass; Dependabot alerts + secret scanning; Vercel failed-build notification). |
| B — lint, types, build | `eslint.config.js` (flat; `no-undef`/`no-redeclare`/`no-unused-vars` + a load-order rule that fails a definition-time reference to a LATER script, globals derived from the seven scripts on every run); `npm run lint` = 0. **No runtime defect found**; 25 dead names (~105 lines) removed — see `R94-B.md`. `jsconfig.json` + `@ts-check` on `core.js`/`site.js`. `build.js` reads `SUPABASE_URL`/`SUPABASE_ANON_KEY` from env first (regex fallback), skips `docs/`, `supabase/`, `.github/` and the new configs. |
| C — CSP | Full policies for the site and `/admin` (default-src 'self', path-narrowed CDN script sources, connect-src = the Supabase host only, object-src 'none', base-uri, form-action, upgrade-insecure-requests). `script-src 'unsafe-inline'` stays: 185 inline `on*=` handlers (app.js 137, reports-money.js 43, diary.js 3, import.js 2) + site handlers = **R95 scope**. `tests/r94_csp.js` (63 checks: static coverage of every external URL + runtime walk of p1–p4, introducer.html and 18 public pages with the header injected). Fixer: site CSP on source `/((?!admin).*)` so only ONE CSP header can ever reach the back office. |
| D — Supabase | `supabase/migrations/` = all **122** live migrations (rebuild record; cron key redacted). `db/r94/01_advisors.sql`: introducer views `security_barrier` (SECURITY DEFINER kept — invoker would show introducers zero rows; RPC replacement is R95), four `backup_*` tables dropped, gates re-asserted (all three already call `session_ok()`), **cron key → Vault** (jobs rewritten by name; body/Bearer/x-cron-key/60 s timeout preserved), 19 unused-index drops as comments (`idx_leads_source_ip_created` must stay — new-lead rate limit). `db/r94/02_auth_settings.md`: sign-ups OFF, min password 12, Auth connections → %, backups/PITR. Edge: `doc-upload` source captured (v5) and five public functions get an origin allow-list (www/apex/nexmoney-two, `Vary: Origin`, no-Origin email clicks unaffected) + body caps (fixer: real length cap on the three JSON bodies) + uuid-shaped unsubscribe ids. |

## Findings worth knowing
- **The cron key was in plaintext** in one migration record, three `cron.job` commands and ~285
  `cron.job_run_details` rows (never in git). `01_advisors.sql` §E moves the jobs to Vault; §E1
  purges the history; §E2 is the rotation — do all three.
- Edge file suffixes are source revisions, not Supabase deploy numbers (new-lead/nps/fact-find
  live v6 = repo v4; unsubscribe live v4 = repo v2).
- `pg_net` cannot be relocated; the advisor WARN stays (comment in the SQL explains).
- Vercel same-key header precedence is unverified on this project — made moot by the fixer.

## Hashes (`node build.js --hash`, r94 tags)
core e8fdeb · reports-money 8658c5 · diary 2f8561 · import d11625 · vault 9c7a44 · site f75812 ·
app 3e8017 · admin.css 4b40f7 · style.css 203deb · enhance.js bd7db0.

## After merge (in order)
1. Daniel: dashboard toggles (`db/r94/02_auth_settings.md`); paste `db/r94/01_advisors.sql`
   outside 02:25–02:35 / 06:10–06:35 / 07:55–08:10 UTC; run the VERIFY queries at its foot.
2. Claude: deploy `new-lead` v5, `nps-capture` v5, `fact-find` v5, `doc-upload` v6, `unsubscribe` v3
   (`verify_jwt: false`); test contact / fact-find / docs / feedback forms on www + an unsubscribe link.
3. Live-verify: ten served hashes, eight `r94` tags, `__errorLog 0`; `curl -sI https://www.nexmoney.co.uk/admin/ | grep -i content-security` shows exactly one CSP (the admin one).
4. Next morning: cron runs succeeded → §E1 purge → §E2 rotate.
5. Daniel: runbook §1.5 (ruleset no-bypass, Dependabot alerts, secret scanning, Vercel notify).
6. A week after: remove `nexmoney-two.vercel.app` from the edge allow-lists and the Auth redirects.

## R95 candidates
Event delegation for the 185 inline handlers → drop `'unsafe-inline'`; introducer views → RPCs
(clears the advisor ERROR); `wireChipStripOverflow` + its CSS; HARNESS narrative tidy.
