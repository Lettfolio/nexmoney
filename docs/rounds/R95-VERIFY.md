# R95 "No inline" — adversarial verification (branch r95-no-inline @ 83a1cae vs base 520c2eb)

Everything below was run from /root/nx (HEAD, port 8099) and, where a base comparison is stated, from a
throwaway worktree /tmp/nx-base @ 520c2eb (port 8098, since removed). `git status` is clean at the end;
vercel.json / app.js mutations were restored from `git show HEAD:`.

## Findings

### F1 · P2 — `.doc-act` buttons collide with the kit: 4 console errors + tests/r9_docs.js newly red
- admin/app.js:2726–2729 render the case Documents checklist buttons as `class="doc-act" data-act="received|waive|undo|delete" data-doc="…"`,
  read by `b.dataset.act` at app.js:2750 (`b.onclick = () => docAction(b.dataset.act, …)`). This predates R95 and is a plain data attribute.
- The kit (admin/core.js:152–163) treats ANY `[data-act]` as a handler name: a click on these buttons dispatches `window["received"]` etc.
  → `console.error('data-act: no global function "received"')` (once per name). docAction still runs (the element's `.onclick` fires first), so the
  feature works, but the owner session is no longer console-clean.
- Evidence: `node tests/r9_docs.js` on HEAD: `R9_DOCS: 248 checks, 4 failures` — the 4th is
  `✗ owner session · zero console errors — got ["data-act: no global function \"received\"", "...undo", "...waive", "...delete"]`.
  Same suite on the base worktree: 3 failures (only the three lender-average date-drift checks). r44 fails identically on both (§H1 local-midday).
- B's report claims "Every one of the 80 act names resolves" — the script only looked at `actAttr(...)`/`act:` producers, not literal `data-act="…"`.
- Fix (minimal, no behaviour change): rename the data attribute. app.js:2726–2729 `data-act=` → `data-doc-act=`; app.js:2750 `b.dataset.act` → `b.dataset.docAct`;
  tests/r9_docs.js lines 369, 376, 383, 402, 415, 419, 421, 422: `.doc-act[data-act=` → `.doc-act[data-doc-act=`. Then re-run r9_docs (expect the base's 3 drift failures only).
- Harden r95_kit.js: scan app.js/reports-money.js/diary.js/import.js/index.html for literal `data-act="(\w+)"` and assert each name is a global function on mock.html
  (this would have caught F1).

### F2 · P2 — tests/r93_data.js C20 still expects eight admin hash files (red on HEAD, green on base)
- tests/r93_data.js:173 `eq("C20 · --hash prints the eight admin files", adminFiles, ["admin/core.js", …, "admin/admin.css"])`.
  HEAD: `r93_data: 91 passed, 1 failed` — got `["admin/boot.js","admin/core.js",…]`. Base worktree: `92 passed, 0 failed`.
- D and E each ran r93_data green on their own branch (no boot.js there); nobody re-ran it after the C merge; the fixer missed it.
- Fix: prepend `"admin/boot.js"` to that expected array and reword the label ("nine admin files"). `node build.js --hash` does print 11 lines (verified).

### F3 · P3 — behaviour change on a null client id (B's note 6), one real site
- Base inline markup interpolated ids as `'${x}'`: a null became the string `"null"` → `openClient("null")` → PostgREST uuid error → "Client not found" toast.
  `jsArg(null)` sites already produced `""` → `if (id)` false → NEW client/case form (pre-existing, unchanged).
- HEAD: `actAttr` passes `null` → `openClient(null, …)` opens a NEW client form. `openCase(null)` likewise (caseOpenLoad `if (id)`).
- Every producer was traced (app.js 693, 7292, 7339, 7438, 7575, 8382, 8790, 8896–8932, 9290–9291, 10212–10214, 11271, 14884, 15457–15649, 16727, 17089,
  17468, 19446, 19452, 20870, 21881, 21939, 24067, 24087, 24100–24148, 24286, 24294, 24368; reports-money 1161, 2564, 2736, 2743; diary 187; import 1107, 2281).
  All are primary keys, guarded (`x ? … : ""`), or were `jsArg` sites in base. The one materially changed site: app.js:24087 (Data health "shared property"
  table) `actAttr("openClient", cs.client_id, null, null, cs.id)` — a case with no client (`cases.client_id` is nullable; app.js:3112/11307 guard that case)
  now opens a blank New-client form pre-linked to the case instead of toasting.
- Fix: `${cs.client_id ? `<button class="btn btn-sm" ${actAttr("openClient", cs.client_id, null, null, cs.id)}>Open client</button>` : ""}`.

### F4 · P3 — `"$event"` / `"$this"` sentinels are substituted inside DATA args too
- core.js:135 replaces any arg strictly equal to `"$event"`/`"$this"`. My probe (hostile names rendered through a real row on mock.html) shows the
  escaping is otherwise airtight: `x" data-act="nav" y`, `x'],["evil`, `a&quot;b`, `</div><button data-act=…>`, backslashes, emoji, `<img onerror>` all arrive
  byte-identical, the element count is unchanged, `nav` is never called. Only a value exactly `$event`/`$this` is hijacked (arrives as the Event / Element).
- Free-text args exist at: `dismissDuplicate(a_id, b_id, a_name, b_name)`, `fixContactOpen(…, to_email)`, `reportGotoSearch(disp)`, `openMergeClients(…, reason)`.
  A client literally named `$this` is implausible; noting for completeness. Hardening if wanted: have `actAttr` throw/escape when an arg equals a sentinel,
  or use a non-string sentinel such as `{"$":"event"}`.

### F5 · P3 — the runtime CSP walk cannot see an inline handler that is never fired; the static grep is the gate
- Probe: a route-injected `onclick="…"` on `#nav-firm-toggle` under the strict admin header produced NO `securitypolicyviolation` until the button was clicked;
  then `script-src-attr blocked inline` + the console "Refused to execute inline event handler" appeared. Chrome compiles handlers lazily.
- So the merge gate for B/C/E is A20 (static count), not §B. A20 does catch an injected `onclick="x()"` in app.js (`84 passed, 1 failed — [["admin/app.js",1]]`),
  and A8c/A8d catch `'unsafe-inline'` re-added to vercel.json (`83 passed, 2 failed`). Note §B derives its header from vercel.json, so with `'unsafe-inline'`
  back the walk itself passes — A8c is what fails.
- Fix: say so in the r94_csp.js header; widen A20's regex from ` on[a-z]+="` to `\son[a-z]+\s*=` (single-quoted / unquoted handlers are not counted today;
  I grepped for them — none exist).

### F6 · P3 — kit: any global on `window` is callable by name
- core.js:143 `window[name]` with only a `typeof === "function"` check: a stray `data-act="close"`, `"print"`, `"open"`, `"stop"`, `"alert"` would call the
  native. No current producer uses such a name (full literal list checked: navToggle, hoverStyle, toggleDrawer, calc*, toggle*Scope, toggleNpsList,
  switchCalc, repToggleChips, nav, submitForm, openCase + the four F1 names). Optional hardening: reject functions whose `toString()` contains `[native code]`.

### F7 · P3 — README.md:9 still says "seven classic scripts" / "core.js → …" (boot.js not mentioned). HARNESS.md is consistent (eight tag literals,
nine admin hashes, eleven lines, nine script tags). Trivial wording fix.

### F8 · P3 — db/r94/01_advisors.sql section A will error after the merge (`alter view` on a dropped view). E and db/r95/README.md say "do not re-run".
Suggest a one-line guard comment at the top of that section, or wrap it in `do $$ begin if to_regclass('public.v_introducer_cases') is not null then … end if; end $$`.

## Refuted / confirmed claims (what was actually run)

1. `node smoke.js` → **150 checks, 0 failures**; mock.html regenerated identically (git clean).
2. `node tests/r94_csp.js` → **85 passed, 0 failed** under the STRICT policies. Read: §B injects the policy as a response header on every `document` on the
   origin (popups inherit), p1–p4 × 11/8 nav pages, p4 driver (case, client, SheetJS, evidence pack), control (img + eval seen), introducer.html, all 19 root pages,
   13 site behaviour checks; `securitypolicyviolation` captured via `addInitScript`. Mutations: vercel.json `'unsafe-inline'` → fails A8c+A8d; app.js inline
   `onclick` → fails A20 (see F5 for the walk's limit).
3. Grep sweep: ` on[a-z]+="`, single-quoted/unquoted variants, `javascript:`, `<script>` without src (non-ld+json), `setAttribute("on`, `new Function`, `eval(`
   across admin/*.js (non-mock), admin/*.html, root *.html, js/*.js, enhance.js, guides.template.html → zero, bar the 15 identical js-class one-liners.
   Evidence-pack HTML (app.js 23440–23518): no `<script>`, no handler; Print wired from the opener via `w.document.querySelector("button.noprint").addEventListener`.
   `NX_CONTENT_FIXTURE=<r93 fixture> node build.js` → dist/guides/r93-test-guide.html: `<script>alert(1)</script>` escaped, no handler, no javascript: href;
   every dist/*.html clean. `.onclick =` property assignments (≈45 sites) are CSP-legal.
4. Kit: read in full. Semantics vs base verified: no `onkeydown` existed in base (event-type histogram: onclick 193, onchange 2, onerror 1, onload 1, ontoggle 1).
   `data-stop` sites (24 in app.js) map 1:1 onto base's inline `event.stopPropagation()` sites (+ the openReassign chip which also stops inside the fn).
   Difference analysed: base stopped at the ELEMENT, the kit stops at `document`, so element-level listeners on ancestors now see the click. All such
   ancestors (app.js 4236, 15177, 19613, 19623, 24541, 14995; diary 764/894/975) are selector-gated or carry C's `[data-act]` early-return — probed: diary task
   chip opens the case only, no new appointment. Other `document` click listeners (app.js 647, 808, 4660, 8743, 9780, 25541; reports-money 922, 2412, 2513;
   vault 41, 387) are all registered AFTER core.js and were never reached by a stopped event in base either — equivalent. mock-supabase.js/boot.js add no
   document listeners, so the kit IS the first. Nested `[data-act]` pairs found at runtime across p1/p4 × all pages + modals: 6, every inner one `data-stop`
   (so "closest wins + return" never drops an outer act that base would have run). Unknown name: one `console.error`, no throw (probed twice).
   Escaping: see F4. `ev.currentTarget` shadowing works (toggleDrawer/startRetentionCase parity below).
5. Suites on HEAD (one at a time): r95_kit 32/0 · r95_unsub 32/0 · r81_platform 69/0 · r82_correct 131/0 · r78_hands 53/0 · r87_shell 56/0 · r90_queues 40/0 ·
   r90_carve 70/0 · r89_tabs 63/0 · r88_kit 85/0 · r65_pipeline 127/0 · r20 81/0 · r19 39/0 · r24 89/0 · r38 95/0 · r93_content 56/0 ·
   **r93_data 91/1 (F2)** · r70_calls 94/0 · r64_retention 88/0 · r41 86/0 · r88_today 67/0 · r90_case_split 81/0 · r87_today 82/0 ·
   r44 174/1 (same §H1 on base) · **r9_docs 248/4 (base 249/3 — F1 is the extra one)**.
6. DOM oracle (base 8098 vs HEAD 8099): p1–p4 × every nav page (11 owner/admin, 8 adviser) + p4 case modal + client modal = **40 snapshots, 0 divergences**
   (masked innerText, per-tag element counts inside #app-view, every [id] + visibility, modal text). Interaction parity on p4, 31 controls (nav badge, Today row
   Done, drawer h3 toggle ×2 + rate-erc-sort, Open-Retention button, watchtower severity chip, snooze menu + pick, Reports sources/losses scope, jump-chips toggle,
   NPS hide, MI drill-down → case, board card open, card stage-move `<select>` change, pipeline table row, Clients row, Retention bulk tick + Clear, Start
   retention case, Protection row, Diary task chip, Diary empty cell, Vault clear search, Settings edit + Save, Emails Retry-all, Data health Open A, case
   modal stage select, case modal button, Escape close, client modal mini-row → closeModalOpenCase, close): **30 identical, 1 skipped** (no `.client-dob-add`
   rendered in mock data on either side). The seven that leave masked text unchanged were re-probed for their side effects (class/aria/value/panel state):
   identical on both.
7. Null-id: F3.
8. boot.js: first `<script>` (index.html:1482), `NX_BUILD_TAG = "r94"` verbatim, SW block byte-identical to base's inline block. Font swap probed with the
   Google Fonts URL routed: 0 ms delay → `media=all` by DOMContentLoaded; 2.5 s delay → `print` at DCL, `all` after load; blocked → `all` with an empty sheet
   (harmless, no visible difference). `node build.js --hash` → 11 lines. `NX_CONTENT_OPTIONAL=1 node build.js` → dist has admin/boot.js (minified),
   js/*.js ×6, unsubscribe.html/.js; no .md/docs/supabase/.sql/.ts.
9. vercel.json: diff vs base is exactly the two script-src values (4 changed lines, identical after stripping script-src). sha256 of the bytes between
   `<script>…</script>` on all 15 carrying pages = `Du+OJKJSbdUgz5nrHeWWINvez6XKDDU/tyj/5c2uvwo=` (one hash, 15 pages); docs/factfind/feedback/unsubscribe carry
   no inline script at all. No page has a second inline script.
10. Slice A: unsubscribe.html has no inline script/handler/style; unsubscribe.js fetches only `${__NEX_FN_BASE||supabase}/functions/v1/unsubscribe`.
    v4: non-POST without `format=json` → 302 to `${site_url}/unsubscribe?c=&t=` (site_url from settings, fallback www., trailing slash stripped; nothing read
    but settings); `format=json` GET → lookup only, no write; every failure class (bad shape, unknown id, wrong token, too big) → the same `{ok:true,valid:false}`;
    one-click POST (form body `List-Unsubscribe=One-Click`, no Origin) → readParams falls back to the query → update → 200 `{ok:true}`. v22 footer →
    `${site_url}/unsubscribe?c=&t=`, List-Unsubscribe still `${FN_BASE}/unsubscribe?c=&t=` (same `c`/`t` names). `cleanUrls: true` serves /unsubscribe.
    robots.txt: 4 `Disallow: /unsubscribe`; sitemap.xml unchanged.
11. Migration: `my_introducer_id` (20260704190923), `session_ok` (20260908191050), the views (20260907191414) and the enums (initial_schema) all precede it;
    `create or replace`, grants idempotent, no BEGIN/COMMIT, functions before `drop view if exists`. Grants exactly `revoke … from public, anon` + `grant execute …
    to authenticated`. Both bodies have `(select public.session_ok())`. Live (read-only MCP): `pg_get_viewdef` + information_schema columns of both views
    == the RPCs' return tables column-for-column and type-for-type; `mfa_enforced_roles = owner,admin`; pg_depend dependents = 0; no `get_introducer_%` yet;
    schema_migrations has 122 rows, newest 20260908191604 = the 122 files before this one, so the integration is in step. introducer.js vs the old inline block:
    header comment + the two reads (+ their comment) only; introducer.html diff 1+/124−. `node db/check-schema-drift.js` → Schema OK.
12. `npm run lint` 0 · `npx tsc -p jsconfig.json --noEmit` 0 · HARNESS wording consistent (F7 for README) · `git status` clean; /tmp/nx-base removed.

## Verdict: **fix-then-ship**
F1 and F2 are two small, mechanical edits (attribute rename + one expected-array entry) that restore the base's test picture; neither changes user-visible
behaviour. Nothing found would break production under the strict CSPs. F3–F8 are optional follow-ups.
