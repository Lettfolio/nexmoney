# R95 · No inline — shared contract

Base: origin/main `520c2eb` (R94 merged, live). Branch `r95-no-inline`. Five builders on disjoint
slices in worktrees `/root/nx-A` … `/root/nx-E` (branches `r95-A` … `r95-E`), then merge →
Fable verifier → fixer → tag bump (nine tags: boot.js joins) → PR → Daniel merges.

Goal: (1) a working unsubscribe page before marketing emails are released; (2) ZERO inline event
handlers and inline scripts in the back office and the site, so `'unsafe-inline'` leaves
`script-src` in both CSPs; (3) the introducer portal reads through RPCs so the two SECURITY
DEFINER views (advisor ERROR) can be dropped — the first DDL to ship as a migration file.
Acceptance: `node smoke.js` 150/150; `tests/r94_csp.js` green with the STRICT policies (it injects
the policy as a header on every page, so any surviving inline handler fails it); DOM oracle —
no user-visible change on any admin page across p1–p4; `npm run lint` 0; `npx tsc` 0.

## House rules (all slices)

- Daniel wants simplification: no new back-office pages, panels, prose or settings. The one new
  public page (`/unsubscribe`) is client-facing and required.
- Comments: WHY ≤ 6 lines, `"R95 · <slice><n>: <why>"` one-liners, no tombstones. Comments the
  suites read (kit fences, LOAD-ORDER notes, openCase end marker, inline-style ceilings per
  `r90_queues`) must stay. `npm run lint` must stay at 0 — the load-order rule applies.
- Definition-time rule: a page file's top-level statements may not reference a LATER script
  (`boot.js → core.js → reports-money.js → diary.js → import.js → vault.js → site.js → app.js`).
- Never edit `admin/mock.html` by hand; after any `admin/index.html` change run smoke.
- Do NOT bump build tags; the CTO does at merge. Never print secrets.
- Run smoke/suites from your worktree with a sed'd copy (REPO path + a private port, see your
  brief). Before you finish: smoke 150/150, lint 0, `git status` shows only your files, commits
  start `R95 · <slice>:`, report `R95-<slice>.md` at the repo root (≤ 80 lines).

## The delegation kit (B writes it in core.js; C and B use it; D writes its own for the site)

```html
<button data-act="openCase" data-args='["c-123"]'>…</button>
<h3 data-act="toggleDrawer" data-args='["$event","rateerc"]'>…</h3>
<select data-act="setScope" data-on="change" data-args='["$this"]'>
<form data-act="saveClient" data-on="submit">
```
- One listener per event type on `document` (click, change, input, submit, keydown), installed by
  core.js at definition time (`document.addEventListener`, capture = false).
- Target = `ev.target.closest('[data-act]')` whose `data-on` (default `click`) matches the event.
- `data-args` is a JSON array; the string tokens `"$event"` and `"$this"` are replaced by the
  event and the element. Missing `data-args` → `[]`. The handler is `window[name]`; if it is not
  a function, `console.error` once per name and return (never throw).
- Click on `<a href="#" data-act>` and on `[data-act][data-on="submit"]` calls `ev.preventDefault()`
  BEFORE dispatch; nothing else is prevented (so `openCase` on a row still bubbles as today).
- Helper for generated HTML: `actAttr(name, ...args)` → the two attributes, JSON-escaped for an
  attribute (`&quot;` safe). Put `actAttr` in core.js next to `esc()`.
- Functions referenced by `data-act` MUST be globals: a top-level `function` declaration in a
  classic script already is; a `const fn = () =>` is not — expose it (`window.fn = fn`) or convert.

Conversion rule: `onclick="f('${id}')"` → `${actAttr('f', id)}`; `onchange="g(this)"` →
`data-on="change" ${actAttr('g', '$this')}`; `href="javascript:void(0)" onclick=…` →
`href="#" ${actAttr(…)}`. Behaviour identical, DOM text identical (attributes differ; the oracle
compares innerText + element counts + ids).

## Ownership (disjoint)

| Slice | Owns | Must not touch |
|---|---|---|
| A — unsubscribe | `unsubscribe.html` (new, root), `edge/unsubscribe-v4.ts`, `edge/process-emails-v22.ts`, `tests/r95_unsub.js`, `robots.txt` (Disallow /unsubscribe), `sitemap.xml` (do NOT add it) | admin/*, vercel.json, other html, enhance.js |
| B — app.js | `admin/core.js` (kit + `actAttr`), `admin/app.js`, `admin/admin.css` (ONLY the dead `.chip-at-end`/`.is-scrollable` rules when `wireChipStripOverflow` goes), `tests/r95_kit.js` (new) | index.html, other admin/*.js, vercel.json, build.js |
| C — the rest of the back office | `admin/boot.js` (new: NX_BUILD_TAG, the font media swap, the SW registration), `admin/index.html`, `admin/reports-money.js`, `admin/diary.js`, `admin/import.js`, `admin/vault.js`, `admin/site.js`, `build.js` (MINIFY + hash list gain boot.js), `tests/r81_platform.js` (the tag-file map), `tests/r90_queues.js` / `tests/r87_shell.js` ONLY if they count scripts or inline attributes, `HARNESS.md` (tag-places wording) | core.js, app.js, introducer.html, vercel.json |
| D — site + CSP | every root `*.html` except `unsubscribe.html` and `admin/*`, `guides.template.html`, `enhance.js`, new `site.js` only if enhance.js is the wrong home, `vercel.json` (both CSPs), `tests/r94_csp.js` (strict assertions) | admin/*, edge/*, build.js (ask C via the report if a new file must be minified) |
| E — introducer RPCs | `supabase/migrations/20261022090000_r95_introducer_rpcs.sql` (new), `admin/introducer.html` (inline script → `admin/introducer.js`, views → RPCs), `admin/introducer.js` (new), `admin/mock-supabase.js` (only if a suite needs the RPCs mocked), `db/_live_functions_snapshot.sql` + `db/columns.json` via `node db/check-schema-drift.js`, `db/r95/README.md` (≤ 15 lines: what ships on merge) | everything else |

Cross-slice facts:
- C adds `admin/boot.js` as the FIRST script tag and moves `window.NX_BUILD_TAG = "r94"` into it
  verbatim (same value; the CTO bumps). r81_platform's `"index.html"` regex entry becomes
  `"boot.js"`. build.js MINIFY gains `"admin/boot.js": "js"`; `--hash` prints eleven lines.
- B's kit must be installed before any page module runs: core.js is already second; with boot.js
  first that still holds. B must not rely on boot.js.
- D's strict admin policy is `script-src 'self' https://cdn.jsdelivr.net/npm/@supabase/ https://cdn.sheetjs.com/xlsx-0.20.2/`
  (no `'unsafe-inline'`); the site's is `script-src 'self' 'sha256-<hash of the js-class one-liner>'`
  if D keeps that one-liner inline, else `'self'`. D commits these as the FINAL policies; they will
  only pass once B, C and E have removed every inline handler — that is the merge gate.
- The evidence-pack popup (`app.js` ~23538, `w.document.write(html)`) inherits the opener's CSP:
  no inline script or handler may remain in that HTML (B: attach listeners from the opener on
  `w.document` after writing, or make the controls plain `<a href>`/print via `w.print()` from the
  opener).
- E's migration ships to PRODUCTION on merge via the Supabase integration and is replayed on the
  PR's Preview Branch first (data-less): idempotent, `create or replace function`, grants to
  `authenticated` only, `revoke from anon, public`, both RPCs call `public.session_ok()` then
  `public.my_introducer_id()` and return exactly the columns the views returned (read
  `pg_get_viewdef` for both via the Supabase MCP — read-only), then `drop view if exists` both.
  `introducer.html` switches to `db.rpc(...)`. Confirm `role = 'introducer'` is NOT in
  `settings.mfa_enforced_roles` so `session_ok()` passes without aal2 for introducers.

## Slice A — unsubscribe

1. `unsubscribe.html`: same shell as `feedback.html` (copy its head/CSS; no inline script, no
   inline handlers — D's CSP will be strict). On load, JS (in a `<script src="/unsubscribe.js">`
   or a block inside `enhance.js`?? NO — A owns a NEW file `unsubscribe.js` at root; add it to
   build.js? build.js copies everything not skipped, and only MINIFY-listed files are minified —
   an unminified 2 KB file is fine, so build.js needs no change) reads `?c=&t=`, calls
   `GET {FN}/unsubscribe?c=&t=&format=json` → `{ok:true, valid:true|false}` (side-effect-free),
   renders the confirm button or the "link not recognised" copy (reuse v3's wording verbatim),
   button → `POST {FN}/unsubscribe` JSON `{c,t}` → `{ok:true}` → "Done — you're unsubscribed."
   `<meta name="robots" content="noindex">`; `robots.txt` Disallow `/unsubscribe`.
2. `edge/unsubscribe-v4.ts` (copy v3, minimum change): GET without `format=json` → 302 to
   `${settings.site_url}/unsubscribe?c=&t=` (read `site_url` the way nps-capture does; fallback
   `https://www.nexmoney.co.uk`); GET with `format=json` → validate the pair → JSON (no names,
   no oracle: `{ok:true, valid:false}` for ANY failure incl. bad shape). POST → perform the opt-out
   exactly as v3, respond JSON `{ok:true}` for JSON/fetch callers; the RFC 8058 one-click POST
   (`List-Unsubscribe=One-Click` body, no Origin) must still get a 200. Keep CORS allow-list,
   size cap, uuid check. The HTML page helpers can go.
3. `edge/process-emails-v22.ts` (copy v21, minimum change): the footer link → `${site_url}/unsubscribe?c=&t=`
   (site_url from settings — check how v21 obtains it; FN_BASE stays for List-Unsubscribe if the
   header uses the function URL for one-click POST — keep that). Header line `// R95 · A: …`.
4. `tests/r95_unsub.js`: Playwright, house style: serve the repo root on your port; load
   `/unsubscribe.html?c=<uuid>&t=<uuid>` with `page.route` intercepting the function URL
   (valid → button shows; invalid → not-recognised copy; POST → done copy); assert zero inline
   handlers/scripts in the page; assert the v22 footer regex points at `/unsubscribe?c=` on the
   site host (static read of the ts file).

## Slice B — app.js (137 handlers + javascript:void + evidence pack + chip strip)

`grep -nE 'on(click|change|input|submit|key[a-z]+)="' admin/app.js` is your worklist; also the
four `javascript:void(0)` anchors and the popup at ~23538. Work mechanically: convert, run smoke,
run the suites that touch each area (grep tests/ for the function name). Remove
`wireChipStripOverflow` and the `.chip-at-end` / `.is-scrollable` rules (r87_shell's dead-CSS check
must stay green — run it). `tests/r95_kit.js`: unit-ish Playwright test of the kit on mock.html:
`$event`/`$this` substitution, `data-on`, preventDefault on `href="#"`, unknown name logs once and
does not throw, nested `[data-act]` picks the closest. Report every call site where the converted
handler's signature needed an `$event`/`$this`, and any global you had to expose.

## Slice C — the rest of the back office

`boot.js` (first script): `window.NX_BUILD_TAG = "r94";`, the Google Fonts media swap (find the
`<link … media="print" onload="this.media='all'">` → drop the attribute and do the swap in boot.js
on `DOMContentLoaded`/load with `document.querySelector('link[data-swap]')`), the SW registration
block from the bottom of index.html verbatim. index.html: 7 `onclick=` + the `onload=` → kit
attributes (the kit is in core.js which loads AFTER boot.js but before any click can be handled
— fine). reports-money.js 43, diary.js 3, import.js 2 → kit. build.js: `"admin/boot.js": "js"`
in MINIFY and in the `--hash` list; the deploy copies it anyway. `tests/r81_platform.js`: the
tag-file map `"index.html"` → `"boot.js"`; whatever asserts "seven/eight scripts" in index.html
→ nine. HARNESS: "ALL EIGHT places" → nine (boot.js + seven scripts + … list them). Smoke must
regenerate mock.html cleanly (boot.js is same-origin, no swap needed).

## Slice D — site + CSP

Inventory: `grep -oE ' on[a-z]+="' *.html | sort | uniq -c` (57 across 15 files) and every
`<script>` without `src` that is not `application/ld+json` (`grep -n '<script' *.html | grep -v
'src=\|ld+json'`). Move handlers to a site delegation kit in `enhance.js` (same `data-act`
convention; the handlers' functions live in enhance.js already or get moved there — keep each
page's behaviour identical: calculators, FAQ accordions, contact form, cookie banner, nav). Inline
`<script>` blocks → `enhance.js` guarded by `document.body.dataset.page` (set `data-page` on
`<body>` of each page) or a per-page file; `guides.template.html` the same (build.js renders it —
check it has no inline script after your change; the rendered guide pages must stay CSP-clean).
The `document.documentElement.classList.add('js')` one-liner: keep it inline and allow it by
hash (`'sha256-…'`, computed from the exact bytes between the tags) — document the hash in the
suite so a change to the one-liner fails the test — OR move it to a 1-line `js-class.js` loaded
synchronously in `<head>`. Your call; say why. Then `vercel.json`: remove `'unsafe-inline'` from
BOTH `script-src`s (style-src keeps it — out of scope). `tests/r94_csp.js`: assert no
`'unsafe-inline'` in either script-src; assert `grep` count of ` on[a-z]+="` across `admin/*.js`
(excluding mock-supabase.js), `admin/*.html`, root `*.html` is ZERO; keep the runtime walk (it
now runs under the strict policy and is the gate for B/C/E). Do not touch `unsubscribe.html`.

## Slice E — introducer RPCs

See the cross-slice facts. Migration file is the ONLY SQL; nothing is pasted. `introducer.html`:
move its inline `<script>` to `admin/introducer.js` (CSP), replace the two `db.from("v_introducer_…")`
reads with `db.rpc("get_introducer_cases")` / `db.rpc("get_introducer_clients", { p_ids })` and keep
the page byte-for-byte otherwise. If any suite loads introducer.html, mock the RPCs in
`mock-supabase.js`; otherwise do not touch the mock. Run `node db/check-schema-drift.js` and
commit the refreshed snapshot files it writes (it reads the mock's registry via Chromium — run it
from your worktree with REPO sed'd like the suites). `db/r95/README.md`: three lines — what the
migration does, that the merge applies it, the verify query (`select proname from pg_proc where
proname like 'get_introducer_%'` and `select count(*) from pg_views where viewname like
'v_introducer_%'` = 0).

## Verifier (after merge) — told to refute

smoke 150/150; `node tests/r94_csp.js` under the STRICT policies (the merge gate); grep for any
surviving ` on[a-z]+="`, `javascript:`, `<script>` without src (non-ld+json) across admin/*.js,
admin/*.html, root *.html, the evidence-pack HTML string, `guides.template.html` and a rendered
guide from `NX_CONTENT_FIXTURE`; `tests/r95_kit.js`, `tests/r95_unsub.js`, `tests/r81_platform.js`,
`r87_shell`, `r90_queues`, `r90_carve`, `r89_tabs`, `r88_kit`, `r65_pipeline`, `r82_correct` + 6 more
chosen from the diff; DOM oracle p1–p4 × every page + case + client modal vs base `520c2eb`; eleven
hashes; lint 0; tsc 0; the migration file: idempotent, replayable on an empty DB (statement
order: functions before `drop view`), grants exact, `session_ok()` present in both; unsubscribe
v4 ↔ process-emails v22 link shape agree; `vercel.json` diff is only the two script-src values.
