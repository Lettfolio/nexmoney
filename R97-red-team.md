# R97 · Red team — round report (3 Nov 2026)

Base: origin/main **146f827** (R96 SEO meta). Branch `r97-red-team`. Shape: five Opus reviewers on disjoint slices
(`R97-RT-sql/edge/client/site/supply.md`) → Fable verifier told to refute (`R97-VERIFY.md`) → Daniel's decisions →
four Opus builders on disjoint slices (S/E/C/D) → merge → suites → PR. Live facts probed read-only (`R97-LIVE-FACTS.md`).

## Result in one paragraph
42 reviewer findings + 1 live finding → after refutation and de-duplication **P1 0 · P2 10 · P3 19**. The one claimed
P1 (Vault values reaching the change log) is latent on the live book — 1 vault audit row, 0 plaintext — so P2. No
anonymous path reaches data: RLS held on every table, buckets private, every SECURITY DEFINER function pins
`search_path`, the public forms only talk to service-role edge functions. The real exposure is *inside the staff
boundary*: whole-book RLS by design + no adviser 2FA, a Vault `visible_to` rule that let a non-owner hide an entry
from the Owner, an unguarded `email_queue` (any staff row-write sends as a colleague once the hold lifts; "mark as
sent" forges the timeline), `process-emails` as the one signed-in function R86 left without `session_ok()`, and no
send-time re-check of the care/opt-out flags. Plus one operational finding from the live queue: **108 of 144 held
emails are >7 days past their send date (oldest 23 Aug)** — releasing the hold unguarded would send two months of
stale automation in one run.

## Daniel's decisions (3 Nov)
- Adviser 2FA: **YES** → `mfa_enforced_roles` gains `adviser` (in the migration). Wayne/Luke meet the enrol screen at next sign-in.
- Stale queue cut-off: **7 days** (one-off script + v23 send-time guard use the same N).
- `cases delete admin` policy: **DROP**. Site-page copy owner-only: **NO** (left as R93 built it).
- SheetJS self-host (C-1): **DEFERRED** — needs `admin/vendor/xlsx.full.min.js` 0.20.2 saved from his machine (neither sandbox can reach cdn.sheetjs.com). CSP keeps the CDN line until then.

## What shipped (by slice)
**S · SQL** — `supabase/migrations/20261103163000_r97_red_team.sql` (applied to production by the merge; replayed clean
after all 123 existing migrations on PG16, applies twice): S-1 vault WITH CHECK keeps the Owner; S-2 `audit_vault_row`
hides every value; S-3 vault audit rows Owner-only; S-4 `guard_email_queue_status()` (no signed-in sent/sending,
no rewrite/delete of sent rows; service role untouched); S-5 non-owners can't change own `full_name`/`email`;
S-6 unused client-docs UPDATE storage policy dropped; S-7 anon loses every table grant (keeps R93's column SELECT on
site_pages/site_posts); S-8 `cases delete admin` dropped; D1 adviser MFA. **`db/r97/01_stale_queue.sql`** — one-off for
Daniel: §A preview by type, §B cancel >7 days, §C care-flag sweep for release day. Mock mirrors + `tests/r97_sql.js` (48).

**E · edge** — `edge/process-emails-v23.ts` (v21/v22 removed): E-1 `session_ok()` gate + unscoped run owner/admin only
(advisers keep scoped sends; "Run now" as an adviser now toasts the 403); E-2 unscoped path re-reads
`suppress_automation`/`comms_optout` per row → cancel (`skipped_care`); E-3 unscoped path cancels rows
`scheduled_for < now()-7d` before picking the batch (`skipped_stale`); E-4 `custom` body escaped then `<p>/<br>`
re-allowed, recipient must equal the client's email. Cron path byte-compatible, two counters appended.
`tests/r97_edge.js` (42; mutation check: 21 fail against v22). **Deploy after merge: process-emails v23 via MCP.**

**C · client** — C-2 admin CSP jsDelivr entry = the exact SRI'd supabase-js file; C-3 `clientOpenSeq` guard in
`openClient` (A-then-B race repro now shows B); C-4 `feeEarned()`/`brokerFeeEarned()` — waived broker fees out of
"Fees earned", adviser month earned and YTD broker line (basis label says "(waived excluded)"); C-5 bulk task close
through `inChunks`; C-6 `vaultForget()` on `showLogin()`; C-7 introducer sign-out reloads; C-8 fact-find `mailto:`
encoded; C-9 contact form `method="post"`; C-10 `safeHref` strips control chars, refuses `//`/`/\`. Eight tags → **r97**.
`tests/r97_client.js` (19) + extensions to r74_numbers/r14/r95_kit/r93_data/r94_csp.

**D · docs/CI** — D-1 `db/_live_functions_snapshot.sql` refreshed from live (47 fns, carries the R86 gates) +
`check-schema-drift.js` fails a SECURITY DEFINER role-check without `session_ok`; D-2 README/HARNESS say the merge
applies `supabase/migrations/`; D-3 `.github/CODEOWNERS` → `@Lettfolio` (GitHub User, confirmed) for migrations/CI/build/
vercel/package/edge paths; D-4 `build.js` served-extension allow-list (planted .csv/.xlsx/.env stay out of dist),
`deploy.bat` removed; D-5 Vercel `npm ci`; D-6 six superseded edge sources removed, r82_correct reads the live file.
`tests/r97_docs.js` (35).

## Build hashes (merge 4bd367a)
boot 5f9df6 · core 66807f · reports-money eb1eb2 · diary cc6221 · import 14436a · vault e313f1 · site c44914 · app 97759b · admin.css 16cc68 (unchanged) · style e0b1d5 (unchanged) · enhance a4cda5 (unchanged).

## After the merge (in order)
1. Supabase integration applies the migration — verify: `select count(*) from information_schema.role_table_grants where grantee='anon' and table_schema='public'` = 0; `mfa_enforced_roles` = `owner,admin,adviser`; `guard_email_queue_status` trigger present; no `cases delete admin` policy.
2. Claude deploys **process-emails v23** (verify_jwt true) and reads the source back (sha256).
3. Daniel pastes `db/r97/01_stale_queue.sql` §A → §B (§C on release day).
4. Live-verify from Daniel's browser: eleven served hashes == build, eight r97 tags, `__errorLog 0` signed-out AND signed-in (S-7 changed anon's error shape: 42501 instead of empty), Vault opens, Today/Reports/Diary/Settings.
5. Daniel's clicks (D4): ruleset "Require review from Code Owners"; Vercel Git → Fork Protection ON, Deployment Protection on Preview; GitHub Actions "require approval for outside collaborators"; Supabase branching "PRs from this repo only".
6. Live-only checks from his browser (same-origin `fetch()` + `response.headers`): `/admin` vs `/admin/` vs `/%61dmin/` CSP; apex HSTS; storage `nosniff` on a client-docs download; `cf-connecting-ip` honoured by new-lead.

## Carried (not built, logged)
SheetJS self-host (C-1, waits on the file); mock `process-emails` handler still mirrors v22 bar the MFA gate (E's
one-line limit) → R98 mock parity; introducer-value sum (`reports-money.js:2876`) still counts waived fees (one line,
decide with Daniel); new-lead check-then-insert race (edge-1, design limit — global cap exhaustible anyway);
doc-upload Content-Length trust / parse-before-gate (edge-5); fact-find started rows never expire (edge-6);
outlook-sync Junk folder + From matching (edge-7); send-sms custom-body variant of E-4; email_queue INSERT straight to
`sent` (unguarded; app never does it); migrations folder has no order/pin test (supply-5); Playwright image by tag
(supply-7); reviewer-gate password hash in history — Daniel to confirm never reused (supply-11).

## Rules learned this round
- `visible_to` on a shared secret must always include the Owner — a restriction rule that lets a lower role
  exclude a higher one is a lock-out, not a restriction.
- A queue row is a send instruction: its status transitions need a guard as much as its content does.
- Every signed-in edge function path carries `session_ok()` — `check-schema-drift.js` now fails the SQL side of that;
  `MFA_GATED_EDGE` in the mock is the client-side list to keep complete.
- Reviewer worktrees: suites hard-code `REPO=/root/nx` + `PORT=8099` → run sed'd copies on 810x; never point two
  builders at /root/nx.
