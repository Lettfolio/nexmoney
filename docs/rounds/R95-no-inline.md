# R95 · No inline — round report (22 Oct 2026)

Branch `r95-no-inline` on base `520c2eb` (R94 live). Five Opus builders, Fable verifier told to
refute (`R95-VERIFY.md`: no P1, fix-then-ship → two fixer commits). **No user-visible change**:
smoke 150/150; DOM oracle 40 snapshots and 30 interaction-parity probes identical to base;
`tests/r94_csp.js` 85/85 under the STRICT policies (the gate); lint 0; tsc 0.

## What changed

| Slice | Delivered |
|---|---|
| A — unsubscribe | `/unsubscribe` site page (`unsubscribe.html` + `unsubscribe.js`, no inline code, noindex, robots Disallow). `unsubscribe` **v4**: GET → 302 to `${site_url}/unsubscribe?c=&t=`; `format=json` side-effect-free check with one identical body for every failure; POST (JSON, form, RFC 8058 one-click) performs the opt-out. `process-emails` **v22**: footer link → the site page; List-Unsubscribe unchanged. `tests/r95_unsub.js` 32. |
| B — kit + app.js | Delegation kit in `core.js` (`data-act` / `data-args` with `$event`/`$this`, `data-on`, `data-stop`, `data-prevent`; `this` and `ev.currentTarget` = the element; unknown name logs once; `actAttr()`). app.js: 134 `actAttr` sites + 33 `act:` arrays, 4 `javascript:` anchors, the evidence-pack popup wired from the opener; `wireChipStripOverflow` + dead CSS removed; ~58 suites re-pointed. `tests/r95_kit.js` 33. |
| C — rest of admin | `admin/boot.js` first script (build tag, font media swap, SW registration — index.html has no inline script); index.html 8, reports-money 43, diary 3, import 2 converted; build.js minifies boot.js; r81/r90_carve/HARNESS: nine scripts, eleven hashes, eight tags. |
| D — site + CSP | 47 site handlers + 7 inline scripts → `enhance.js` kit and `js/<page>.js`; the `js`-class one-liner kept inline by hash. **`vercel.json`: `'unsafe-inline'` removed from both `script-src`s** (site: `'self' 'sha256-Du+OJ…'`; admin: `'self'` + the two pinned CDN paths). `tests/r94_csp.js` tightened: no unsafe-inline, zero `on*=` anywhere, A20 is the real gate (runtime walk only sees handlers that fire). |
| E — introducer RPCs | `supabase/migrations/20261022090000_r95_introducer_rpcs.sql`: `get_introducer_cases()` / `get_introducer_clients(p_ids)` (security definer, `session_ok()`, exact view columns, grants to authenticated only) then `drop view` both — **ships to production on merge** (first DDL through the integration; replayed on the Preview Branch first). `introducer.html` → `introducer.js` + two `db.rpc` calls. Clears the two advisor ERRORs. |

## Verifier findings fixed (fixer 2)
F1 Documents checklist buttons used `data-act` as a data attribute → kit logged 4 console errors
(`data-doc-act` now; `r95_kit` A0 asserts every literal `data-act` resolves). F2 `r93_data` C20 nine
hash files. F3 null `client_id` in the shared-property table would have opened a new client form
(guarded). F5 A20 regex covers single/unquoted handlers + note. F7 README nine scripts.
F8 `db/r94/01_advisors.sql` §A guarded with `to_regclass` (views gone after this merge).

## Rules this round establishes
- `data-act` is a handler name. Never use it as a data attribute; `r95_kit` A0 enforces it.
- The CSP runtime walk reports only handlers that fire; A20 (static) is the gate.
- `git stash` is shared across worktrees — never in a build round (two builders collided).

## Hashes (`node build.js --hash`, r95 tags)
boot 76bce1 · core 601f23 · reports-money c152fb · diary 84accd · import 4f5783 · vault 7a54d7 ·
site 93030d · app 6431e1 · admin.css 4c0462 · style.css 203deb · enhance.js e22a53.

## After merge (in order)
1. Merge applies the migration: verify `select proname from pg_proc where proname like 'get_introducer_%'` = 2 rows, `select count(*) from pg_views where viewname like 'v_introducer_%'` = 0; advisor security list loses both ERRORs.
2. Claude deploys `unsubscribe` v4 and `process-emails` v22 (site must be live first — it is, on merge).
3. Live-verify: eleven served hashes, eight `r95` tags, `__errorLog 0`, CSP header on /admin has NO
   `'unsafe-inline'`; sign in and click through Today / a case / Reports / Diary / Settings (the
   verifier did this on the mock; a real session is the final check); `/unsubscribe?c=<uuid>&t=<uuid>`
   shows "not recognised"; the function URL 302s to it.
4. Introducer portal: a real introducer login (none exist yet — Daniel's call) reads via the RPCs.
5. `email_hold` can now be released on Daniel's word — the unsubscribe path works end to end.

## R96 candidates
`style-src 'unsafe-inline'` (inline style attributes — r90_queues caps them per file, so a nonce/
class pass is bounded); `js/*.js` minify + cache rule; kit: reject native functions by name.
