# R93 "Website" — verification (refutation pass)

Verified on branch `r93` at **e18cc2d** (the gate commit on top of 4334783 — HEAD moved while this ran; the
only difference is the eight-tag bump to `r93`). Read-only: no repo file was changed (a suite overwrote
`shots/p1-settings.png` during its run; restored with `git checkout`). `dist/` was written by `node build.js`
runs (mine and `tests/r93_data.js`'s own) — it is a build artefact, not tracked.

Harness runs (all on 8099, each suite spawning its own server; smoke first):

| suite | result |
|---|---|
| `smoke.js` | **150 / 0** |
| `tests/r93_data.js` | 85 / 0 |
| `tests/r93_content.js` | 52 / 0 |
| `tests/r93_seo.js` | 40 / 0 |
| `tests/r90_carve.js` | 70 / 0 |
| `tests/r90_queues.js` | 40 / 0 |
| `tests/r87_shell.js` | 56 / 0 |
| `tests/r89_tabs.js` | 63 / 0 |
| `tests/r81_platform.js` | 62 / 0 |
| `node db/check-schema-drift.js` | Schema OK |

Plus my own probe (`scratchpad/v/probe.js`, Playwright on 8140: owner / admin / adviser at 1440 px, owner at
390 px) and offline fuzzing of both Markdown sanitisers and of `build.js` with a hostile fixture.

---

## 1 · SECURITY

| # | check | verdict | evidence |
|---|---|---|---|
| 1 | RLS enabled on all four tables | PASS | `db/r93/01_site_tables.sql:127-130` |
| 2 | `site_pages` / `site_posts`: owner/admin ALL (select+insert+update+delete) via `is_admin_or_owner()`, which carries `session_ok()` | PASS | `01:133-141`; `db/_live_functions_snapshot.sql:909-916` (`and public.session_ok()`) |
| 3 | `site_publishes` / `seo_snapshots`: select+insert+update only, **no DELETE policy and no DELETE grant** | PASS | `01:146-171`; probe `admin.deleteSnapshot => permission denied for table seo_snapshots` |
| 4 | anon read limited exactly as contracted: `site_pages` all rows but **column-scoped** (no `notes`, no `updated_by`); `site_posts` only `status='published'` and no `author_id/approved_by/approved_at` | PASS | `01:136-144` (policies) + `01:175-178` (column grants); `revoke all … from anon, authenticated` first at `01:167` |
| 5 | Can anon read drafts? | PASS (no) | policy `using (status = 'published')` `01:144`; `build.js:173` also filters `status=eq.published` |
| 6 | Can an authenticated `none` / `introducer` / `adviser` read or write anything? | PASS (no) | every policy is `to authenticated using ((select is_admin_or_owner()))`; `anon` policies are `to anon` only (not inherited). Probe p2: `adviser.readPages => 0 rows`, nav hidden, `nav("site")` refused (`shown:false`) |
| 7 | Status guard — admin UPDATE with `status='published'` in any column order | PASS | trigger reads `new.status` (`01:104-109`), column order is irrelevant; mock mirror refuses: `admin.upsertPublished => Only the owner can approve` |
| 8 | Status guard — admin **upsert** / **insert with status preset** | PASS | `before insert or update` (`01:123`); `tg_op = 'INSERT'` branch `01:105`; probe `admin.insertPublished => Only the owner can approve` |
| 9 | Status guard — admin edits `body_md` / `title` of an **already published or approved** post | **FAIL** | guard only fires when `new.status is distinct from old.status` (`01:105`). Probe: `admin.editPublishedBody => ALLOWED (status stays published)`. The owner's approval (`approved_by/approved_at`) then vouches for content the owner never saw; the next Publish ships it. For a regulated firm's public copy this is an approval bypass (cf. R82's financial-promotions gate). Same for `site_pages` (titles/H1/FAQ go live with no approval at all — contract-accepted, but note it). |
| 10 | Status guard is enforced only for `current_user in ('authenticated','anon')` | PASS/RISK | `01:107`. PostgREST `SET ROLE authenticated` makes `current_user` = `authenticated`, so the API path is covered; service_role/SQL editor bypass by design (documented at `01:17`). Guard function is SECURITY INVOKER so `current_user` is the API role, not `postgres`. |
| 11 | `session_ok()` gate on the JWT path of **both** edge functions | PASS | `edge/site-publish-v1.ts:34-35`; `edge/seo-snapshot-v1.ts:65-66` (`uc.rpc("session_ok")` on the caller's own client, `okErr || ok !== true` → 403) |
| 12 | Cron path accepts only the correct key | PASS | `seo-snapshot-v1.ts:54-58`: header must equal `settings.cron_key` and the row must be non-empty; a wrong/missing key falls through to the JWT path, where the pg_cron Bearer (anon or service key) yields no `auth.getUser()` user → 401. `site-publish` has no cron path at all (correct). |
| 13 | **Deploy-hook URL is readable by every staff role** | **FAIL (P1)** | `settings read staff` policy (`db/r84/12_policy_initplan.sql:206-210`) hides only keys matching `(bank\|account\|sort_code\|secret\|token\|api\|key\|password)`; `vercel_deploy_hook` matches none. Probe as adviser p2: `adviser.readSettingsHook => [{"key":"vercel_deploy_hook","value":""}]` (the mock's `SENSITIVE_SETTING_KEYS` mirrors the live regex, `mock-supabase.js:494`). A Vercel deploy hook is a bearer capability: anyone holding the URL can redeploy nexmoney.co.uk at will. It also lands in every adviser's `window.settings` at init. |
| 14 | Deploy-hook validation / SSRF | RISK | `site-publish-v1.ts:78-83` accepts **any** https URL and stores the first 200 chars of the response in `site_publishes.detail` (`:91-93`) — an owner-set, admin-readable blind-ish SSRF read primitive. Only the owner can write `settings` (RLS), so exposure is low; restrict host to `api.vercel.com`. |
| 15 | No secrets printed/logged — **PSI key can leak into the function's `errors[]`** | **FAIL (P2)** | `seo-snapshot-v1.ts:274` builds the PSI URL with `&key=<PSI_API_KEY>`; a transport error at `:293-294` pushes `msg(e)`, and Deno's fetch error text embeds the full URL (`error sending request for url (…&key=…)`). `msg()` slices at 200 chars, which still exposes the first ~25-30 chars of the key for short page paths. Returned to the owner/admin caller (not stored). |
| 16 | No secrets in code / repo | PASS | `02_cron.sql:27-29` copies the Bearer from the live `cron.job` row at apply time; `build.js:151-157` reads the anon key from `admin/app.js` line 3 (public key anyway); nothing else |
| 17 | XSS — every `innerHTML` in `site.js` escapes user data | PASS | 7 `innerHTML` sites (`site.js:105,168,196,405,596,603,630`). Row names/chips/titles go through `rowItemHtml`/`kitAttr` (`app.js:590,698-710`, all `esc`); facts are pre-escaped (`site.js:147,158,588`); editor values `esc()`'d into `value=""`/`<textarea>` (`:261-272,375-382`); verbs' `onclick` escaped by `kitVerbHtml` (`app.js:610`); SEO cells `esc()` (`:458,482,543-558`); GSC query text (untrusted external input) is escaped by `rowItemHtml` (`:587`) |
| 18 | `siteMdToHtml` rejects raw HTML and `javascript:` / `data:` / `vbscript:` / protocol-relative URLs | PASS | fuzzed 18 vectors: `<img onerror>` → escaped text; `javascript:`, `JaVaScRiPt:`, `data:`, `vbscript:`, `//evil`, `http:` → link dropped; `&#106;avascript:` survives only as a relative href (`&amp;#106;…`, never decoded to a scheme); quotes in URL re-escaped (`:56-71`) |
| 19 | `build.js` Markdown: `marked` configured to escape raw HTML, strict allow-list afterwards | PASS | `build.js:243` (`html({text}) → esc(text)`), `:219-237` allow-list (unknown tags dropped, only listed attrs kept, href/src re-checked by `safeHref`). Fuzzed: `<script>`, `<iframe>`, `<svg onload>`, `<a onmouseover>`, `[x](javascript:)`, `[x](<javascript:…>)`, `![](javascript:)` all neutralised; `{{title}}` and `<!--NX:JSONLD-->` inside a body are not re-substituted (`:139` of the rendered guide shows them escaped) |
| 20 | `build.js` escapes title/meta/H1/FAQ into attributes and JSON-LD; `</script>` inside a FAQ answer | PASS | `esc()` covers `& < > " '` (`:141-143`); `jsonForScript` rewrites `< > & U+2028/9` (`:145-147`) → fixture `Q </script><img …>` became `</script>…` in `dist/index.html:127`; `<title>`, `description`, `og:title`, `<h1>` all entity-escaped (`dist/index.html:8-29,207`) |
| 21 | `guides.template.html` placeholders all in escaped context | PASS | `{{title}}/{{excerpt}}/{{slug}}/{{path}}/{{ogimage}}` are `esc()`'d before substitution (`build.js:277-282,297-300`); `{{body}}/{{cover}}/{{crumbs}}/{{published}}` are builder-generated HTML; JSON-LD via `ldScript` |
| 22 | `og_image` / cover URL: only https reaches the page | PASS | `build.js:193,275` (`/^https:\/\//`); fixture `javascript:alert(1)` left the repo's own og:image in place |
| 23 | Slug traversal (`../etc`, `Bad Slug`) through `site_pages`/`site_posts` into `dist/` | PASS | `build.js:323,331` `SLUG_RE`; fixture rows skipped (no `dist/etc.html`). Note `site_pages.slug` has **no CHECK** in SQL (`01:36`) — the build filter is the only guard (P3) |
| 24 | `updated_by` / `author_id` are client-supplied | RISK | `site.js:301,350` write `ME.id`; any admin can write any uuid. Harmless today; a `default auth.uid()` or trigger stamp would make it evidence-grade (P3) |

## 2 · CONTRACT

| # | check | verdict | evidence |
|---|---|---|---|
| 25 | Table shapes exactly as frozen | PASS | `01:35-77` column-for-column vs `R93-CONTRACT.md` "Data model" (plus two indexes `01:80-81`, allowed) |
| 26 | Edge `data` shapes == what the SEO tab reads (field names/types) | PASS | audit `seo-snapshot-v1.ts:180-185` ↔ `site.js:537-558`; psi `:284-292` ↔ `:556`; gsc `:326-328` ↔ `:557-558`; summary `:394-399` ↔ `:513-520,601-602` |
| 27 | Page-key normalisation (edge writes `pathOf` = `/`, `/mortgages`; GSC may send trailing slash / full URL) | PASS | `seoPath()` `site.js:449-454` strips host and trailing slash on both sides of the join; summary page `""` handled by `kind === "summary"` first |
| 28 | 14-page constant == `sitemap.xml` | PASS | `sitePagesConst` (`site.js:15-30`) is the 14 `<loc>` paths in sitemap order |
| 29 | `vercel.json`: only the `/guides → /faq` redirect removed | PASS | `git diff 9797934 -- vercel.json` = one 5-line deletion |
| 30 | `node build.js --hash` lists the eight admin files, no network | PASS | run under `unshare -n`: 10 lines (7 admin JS + admin.css + style.css + enhance.js), exit 0; `process.exit(0)` at `build.js:112` precedes any content code |
| 31 | Fail-open content fetch (401 / outage) | PASS (build) / **RISK (content)** | `unshare -n node build.js` → `content: fetch failed (fetch failed) — repo HTML shipped unchanged`, exit 0, 0.6 s. **But** `renderContent({pages:[],posts:[]})` still runs (`build.js:353`): `dist/guides.html` says "No guides yet", `dist/sitemap.xml` lists `/guides`, and every previously published `/guides/<slug>` is absent → a transient Supabase outage (or the 401 before `01` is applied) silently **un-publishes every guide** on that deploy and 404s indexed URLs. The log line "repo HTML shipped unchanged" is also not quite true. |
| 32 | `NX_CONTENT_FIXTURE` hook | PASS | hostile fixture built: `content (fixture): 3 page override(s), 1 guide(s)`; `dist/guides/evil-guide.html`, `dist/guides.html`, sitemap gained `/guides` + the post with `lastmod` |
| 33 | FAQ on a page that already carries FAQPage (faq.html) | PASS | one `"FAQPage"` in `dist/faq.html` after an override row with FAQ items (`build.js:202`) |
| 34 | FAQ markup is **JSON-LD only** on every page today | RISK | no root page contains `<!-- nx:faq -->` (grep = 0 on all 14), so FAQ q/a written in the editor are never visible to a visitor — only in structured data. Google treats FAQ structured data for content not visible on the page as spammy markup, and FAQ rich results are restricted (Aug 2023) anyway. The editor invites effort that renders nowhere. |
| 35 | `marked` as pinned devDependency, CJS-capable | PASS | `package.json` `"marked": "15.0.12"`; Vercel's `npm install` installs devDependencies (esbuild already relies on it) |
| 36 | `llms.txt` + template footer only carry `/guides`; site nav untouched | PASS | `git diff` on llms.txt (1 line); `guides.template.html:198`; no other page diff |

## 3 · HARNESS RULES

| # | check | verdict | evidence |
|---|---|---|---|
| 37 | Definition-time rule: no top-level reference to app.js names | PASS | `site.js` evaluated in a bare `vm` context (only `window`): no throw, `__nxTag_site = "r93"` |
| 38 | Every top-level name prefixed `site`/`seo` | PASS | 59 top-level declarations; the only exceptions are the contract-named loaders `loadSiteContent` / `loadSiteSeo` (`:101,626`). `SEO_ISSUE_LABEL` is upper-case `seo` |
| 39 | No duplicate top-level declarations across the eight scripts | PASS | cross-file scan of `const/let/var/function/class` at column 0: 0 duplicates; `r90_carve` 70/0 |
| 40 | Zero inline `style=` in `site.js` and in the rendered DOM | PASS | grep 0; probe `content.inlineStyles 0`, `editor.inlineStyles 0`, `seo.inlineStyles 0`; `r90_queues` 40/0 |
| 41 | Eight tag literals equal | PASS | all eight read `"r93"` (`index.html:1502`, core 306, reports-money 5113, diary 1377, import 2333, vault 395, site 656, app 26447) |
| 42 | `.vercelignore` / build skip for new harness files | PASS | `tests/`, `shots/`, `*.md`, `edge/` already ignored; `db/` and `guides.template.html` skipped by `build.js:58-59` |
| 43 | `admin.css` line budget | RISK | B's fence is **two 1,2xx-char lines** (`admin.css:3859-3860`) written to dodge r87_shell D1 — the CTO then raised D1 to 3,950 anyway. Reflow the fence; a 1,300-char line is unreviewable |
| 44 | `mock.html` churn | PASS | the 1,099-line diff is the foundation re-syncing a stale copy to `index.html` (byte-identical except the supabase `<script src>`), per HARNESS.md §mock.html |

## 4 · UX vs "say less"

| # | check | verdict | evidence |
|---|---|---|---|
| 45 | Prose sentences on the Content tab | PASS | probe `content.proseLines => []`; strip is "Last publish 2d ago · Kim Martin · failed", labels/chips only |
| 46 | Prose on the SEO tab (beyond the permitted three-line Connect panel) | PASS | `seo.proseLines => []`; Connect panel = `<h3>` + the three contracted lines (`site.js:576-580`) |
| 47 | Publish button disabled state + title | PASS | `{"disabled":true,"title":"Set the Vercel deploy hook in Settings › Integrations"}` for owner and admin; enabled once a hook is set (r93_content D3) |
| 48 | Owner vs admin visible differences | PASS | owner guide editor buttons `Preview, Approve, Publish, Cancel, Save`; admin `Preview, Archive, Cancel, Submit for approval` |
| 49 | One behaviour per control | RISK | Approve/Publish/Archive **also save** the open edits (`site.js:335-336,420`) — a status verb is two behaviours. "Submit for approval" is a plain Save with no state change and no signal to the owner (`:372`) — the label promises something that does not happen (contract-accepted; honesty smell) |
| 50 | 390 px: no horizontal overflow on list, both editors, SEO table | PASS | `phone.content.scroll [390,390,366]`, `phone.editor.scroll {right:360, overflowInputs:0}`, `phone.guideEditor {btnRow max 360}`, `phone.seo.scroll [390,390,366,366]` (table renders as `mob-cards`; screenshot `scratchpad/v/phone-seo.png`) |
| 51 | Empty states: `site_pages` empty → 14 rows "— from HTML"; no guides → "No guides yet"; `seo_snapshots` empty → "No audit yet." + button | PASS | probe (11 pages show "— from HTML"); r93_seo empty-state check (`tests/r93_seo.js:249`) |
| 52 | `functions.invoke` rejects (throws) | PASS | `seo.invokeReject => ["Audit failed: boom network"]`; button restored |
| 53 | `functions.invoke` returns 403 "second factor required" | RISK | `seo.invokeMfa => ["Audit failed: Edge Function returned a non-2xx status code"]` — `seoRunAudit` (`site.js:644`) does not read `error.context.json()` the way `sitePublish` does (`:206-208`), so the MFA refusal is opaque |
| 54 | Publish strip "failed" badge: detail only on hover `title` | RISK | `site.js:128` — no hover on a phone; the reason for a failed publish is invisible there |
| 55 | Description chip with no override reads "Desc —" red for 11 of 14 pages | RISK | `site.js:139` — the HTML's own description is unknown client-side, so the list opens with 11 red chips that are not findings (the SEO tab knows the real lengths; B guess 3) |
| 56 | `:has()` selector for the editor width | RISK | `admin.css:3859` `.overlay-modal:has(> .site-editor)` — Firefox < 121 ignores it (default overlay width); no functional loss |

## 5 · OPERATIONAL

| # | check | verdict | evidence |
|---|---|---|---|
| 57 | `02_cron.sql` assumptions — **check against live `cron.job` before applying** | RISK | must hold: (a) a job named exactly `nexmoney-process-emails` exists; (b) its `command` contains `Bearer <token>` matching `[A-Za-z0-9._-]+` (`:27`); (c) `net.http_post(url, headers jsonb, body jsonb, timeout_milliseconds)` is the signature of the installed pg_net (≥ 0.7 for `timeout_milliseconds`); (d) a `settings.cron_key` row exists (process-emails v21 reads it, so yes); (e) the job runs as a role that can read `public.settings` under RLS (`postgres` has BYPASSRLS on Supabase); (f) the function is deployed with the name `seo-snapshot` and with JWT verification accepting that Bearer. `format()` is safe: the `$cmd$` body contains no other `%` |
| 58 | seo-snapshot time budget | RISK | one shared 48 s deadline (`:35`) and phases run audit → links → PSI (`:381-382`). Worst case the link check alone is 150 × 6 s ÷ 8 ≈ 112 s, so it exhausts the budget and **PSI runs 0 pages** (`psi: budget reached after 0`). Even on a good night PSI (≈5-10 s/page) covers only the first 4-6 sitemap pages — always the same ones; pages 7-14 never get a score. Final upserts happen after the 48 s mark (→ ~50-52 s wall) |
| 59 | seo-snapshot never throws; degrades | PASS | outer try/catch `:410-413`; `fetchT` throws "budget exhausted" at < 800 ms left (`:92`); `linkStatus` maps failures to 0 (not broken) |
| 60 | While the live site is gated / before DNS cutover | RISK | `SITE = https://www.nexmoney.co.uk` (`:32`); every page audits as `http_error` until the site answers 200 (A guess 10); `errors[]` are not persisted, so tomorrow's tab cannot say *why* (no `errors` in `summary`) |
| 61 | build.js now depends on Supabase at deploy time | **RISK (P2)** | 8 s timeout (`:165`) is fine; the failure mode is check 31 (guides vanish). Also the 401 that *will* happen on the first deploy after this merges but before `01_site_tables.sql` is applied: build passes, guides index published as "No guides yet" with `/guides` in the sitemap and `llms.txt` → a thin indexed page |
| 62 | `seo_snapshots` growth | RISK | ~600 rows/night (audit ≤ 40 + psi ≤ 15 + gsc pages ≤ 500 + 50 queries + 1), no retention; `seoLoadLatest` `.limit(1000)` is safe (< PostgREST 1,000 cap) but only just if GSC ever returns 500 pages |
| 63 | `seo-snapshot` row writes for a `force` run during the day overwrite the nightly row for the same `day` | PASS | by design (`unique (day,kind,page)`) |
| 64 | `decode()` on own-site HTML | RISK | `String.fromCodePoint(Number(n) \|\| 32)` (`:115`) throws RangeError for `&#1114112;`+ → that page's audit is lost (caught per page). Own HTML only |
| 65 | `site-publish` spam | RISK | every click = a Vercel build; the button only disables during one call. Vercel dedupes hook bursts; acceptable |
| 66 | `db/columns.json` lists the four tables before production has them | RISK | A guess 12 — a snapshot refreshed from prod before `01` is applied would drop them and `check-schema-drift` would flip red |

---

## Ranked defects

### P1 — must fix before ship
1. **Deploy hook readable by advisers** — `db/r84/12_policy_initplan.sql:206-210` regex vs key name `vercel_deploy_hook` (`db/r93/01_site_tables.sql:189`, `admin/app.js:5336`, `admin/site.js:124`). Fix: rename the setting to something the sensitive regex already hides (e.g. `vercel_deploy_hook_secret`, matches `secret`) in `01`, `app.js` Settings field, `SETTING_URL_FIELDS`, `site-publish-v1.ts:58`, the mock's `SENSITIVE_SETTING_KEYS` and fixtures — then, because admins will no longer see it either, make `siteHookSet()` ask the server instead of `settings`: a `site_hook_set()` SECURITY DEFINER boolean RPC guarded by `is_admin_or_owner()` (carries `session_ok`), or simply enable the button for admins and let the edge's 400 `no deploy hook set` toast speak. Add a `tests/r93_data.js` check that an adviser's `settings` read never returns the key.

### P2 — fix this round
2. **Edits to approved/published guides bypass owner approval** — `db/r93/01_site_tables.sql:104-105`. Fix: in `site_posts_status_guard`, when `tg_op='UPDATE'` and `old.status in ('approved','published')` and any of `title/excerpt/body_md/cover_image/slug` changed and `not is_owner()`, set `new.status := 'draft'` and null `approved_by/approved_at` (or raise `42501`). Mirror in `mock-supabase.js` writePolicy (~`:678`) and pin with a `r93_data` check; the guide editor already re-reads status after save.
3. **Fail-open build un-publishes every guide on a content-fetch failure** — `build.js:348-356`. Fix: on `loadContent()` failure do NOT regenerate `guides.html`/`guides/*`/sitemap from an empty set — either (a) skip the guides+sitemap step entirely and leave the repo's `sitemap.xml` (and no `/guides` page) in place, or (b) keep a committed last-known-good `content.snapshot.json` that the build falls back to (and that the Publish click refreshes). Make the log line say what was skipped.
4. **PSI key fragment in `errors[]`** — `edge/seo-snapshot-v1.ts:274,293-294`. Fix: catch around the PSI fetch and push a fixed `psi <path>: <e.name>` (or run `msg(e).replace(/key=[^&\s)]+/g, "key=…")` inside `msg()`); same hygiene for the GSC token call (`:317`) although that body carries no secret in the URL.
5. **FAQ editor output is invisible markup** — `build.js:196-205` + no `<!-- nx:faq -->` on any page. Fix: either add the marker to the pages that should show an FAQ (Daniel's call: the four service pages) or emit the FAQPage JSON-LD only when the page actually rendered the visible block, and say so in the editor ("FAQ shows on pages with an FAQ section" is one chip, not prose). Otherwise drop the FAQ fields from the page editor.
6. **PSI starvation by the link check** — `edge/seo-snapshot-v1.ts:35-40,381-382`. Fix: give phases their own budgets (audit+links ≤ 20 s, PSI the rest) and rotate the PSI start index by `dayOfYear % pages` so every page gets a score within a fortnight; persist `errors` in the summary row so the tab can show why PSI/GSC are missing.

### P3 — note
7. `seoRunAudit` toast on 403/401: read `error.context.json()` like `sitePublish` does — `admin/site.js:641-645`.
8. `site-publish` hook host allow-list (`api.vercel.com`) — `edge/site-publish-v1.ts:80`.
9. `site_pages.slug` CHECK (`'' or ^[a-z0-9]+(-[a-z0-9]+)*$'`) and server-side `updated_by/author_id` stamps — `db/r93/01_site_tables.sql:36,44,57`.
10. Drop the unused `insert`/`update` policies+grants on `seo_snapshots`/`site_publishes` for `authenticated` (only service_role writes them) — `01:149-164,171`.
11. Reflow the two 1,2xx-char CSS lines — `admin/admin.css:3859-3860` (D1 is 3,950 now).
12. Publish-strip failure detail visible, not hover-only — `admin/site.js:128`; "Desc —" red for un-overridden pages reads as 11 findings — `admin/site.js:139,45` (show grey "HTML" until the SEO audit supplies `meta_len`).
13. "Submit for approval" without a submitted state / owner signal — `admin/site.js:372` (contract-accepted; at least a Today-list item or badge for the owner later).
14. `02_cron.sql` — run the §5 #57 checklist against `select jobname, command from cron.job` before applying; `db/columns.json` must not be refreshed from prod until `01` is applied.
15. `decode()` RangeError guard (`n <= 0x10FFFF`) — `edge/seo-snapshot-v1.ts:115`.
16. `seo_snapshots` retention (e.g. keep 90 days of `audit/psi/gsc_query`, all `summary`) — none exists.

---

## Fixer (R93 · fixer, on top of e18cc2d)

| defect | change |
|---|---|
| P1-1 deploy hook readable by staff | Key renamed `vercel_deploy_hook` → `vercel_deploy_hook_secret` (matches the R84 "settings read staff" regex's `secret`) in `db/r93/01` seed, `edge/site-publish-v1.ts`, `app.js` Settings field + `SETTING_URL_FIELDS`, mock seed + `SENSITIVE_SETTING_KEYS`, tests. New `public.site_hook_is_set()` (SECURITY DEFINER, `set search_path = public`, `session_ok() and is_admin_or_owner()` and the row non-empty; execute to `authenticated` only, revoked from public/anon). `site.js` reads it via `db.rpc("site_hook_is_set")` into `siteCtState.hook` (a missing function reads as "not set"). Mock RPC mirrors it through `isAdminOrOwner()`. |
| P2-2 approval bypass by editing | `site_posts_status_guard`: API-role non-owner UPDATE of an approved/published post that changes title/slug/excerpt/body_md/cover_image → `status := 'draft'`, approved_by/approved_at/published_at nulled (no exception). Mirrored in the mock's `siteRowTrigger`. Tests: r93_content B18 (owner edit keeps published), C6 (admin edit demotes); r93_data A13 (SQL text). |
| P2-3 fail-open un-publishes | `build.js`: content read retried 3× (1 s, 2 s); on failure (or render failure) ONE line on stderr `build: content fetch failed after 3 tries — <reason>; failing the build so the previous deploy stays live (set NX_CONTENT_OPTIONAL=1 to build without content)` and exit 1. `NX_CONTENT_OPTIONAL=1`: repo HTML + repo sitemap verbatim, no guides pages, exit 0. `--hash` untouched. r93_data C17 (fail-closed) / C18–C19 (optional). |
| P2-4 PSI key leak | `redact()` (`([?&]key=)[^&\s"']+` → `$1<redacted>`) inside `msg()`, on both returned `errors` arrays and on the persisted list. r93_data B8. |
| P2-5 FAQ editor renders nowhere | FAQ rows UI removed from the page editor; Save no longer sends `faq` (existing entries untouched); a page with entries shows one read-only chip `FAQ ×n` (`#sp-faq-chip`). Column and build.js marker logic unchanged. `.site-faq-row` CSS removed (dead). r93_content A9 / A11 / A15b. |
| P2-6 PSI starvation + errors not persisted | seo-snapshot phases: audit fetch → PSI (≤ 8 pages, 12 s per call, stop when < 10 s left) → link check with what remains (cap 150, skipped count noted) — GSC alongside. **Deviation:** the summary's `errors` key is already the issue COUNT the tiles read (contract + r93_data D8 + r93_seo A3), so the step failures persist as `run_errors: string[]` (≤ 20, ≤ 200 chars, redacted). The SEO header shows one amber chip "n notes" (`.seo-notes`) with the messages in `title`. r93_data B9 / D7, r93_seo B4. |
| P3 | `seoRunAudit` reads `error.context.json()` → "Audit failed: second factor required" (r93_seo A23b). `site_publishes` / `seo_snapshots`: authenticated INSERT/UPDATE policies dropped and grants cut to SELECT (sequence grant to authenticated removed); mock refuses every client write there. Triggers `site_pages_stamp_author` (`updated_by := auth.uid()`) and `site_posts_stamp_author` (INSERT, `author_id := coalesce(author_id, auth.uid())`); site.js stops sending them; mock mirrors. `site_pages.slug` CHECK `^[a-z0-9-]*$` (+ mock). B CSS fence reflowed to one rule per line (admin.css 3,944 ≤ 3,950). |

Final runs (8099): smoke **150/0** · r93_data **92/0** · r93_content **56/0** · r93_seo **42/0** · r90_carve 70/0 · r90_queues 40/0 · r87_shell 56/0 · r89_tabs 63/0 · r81_platform 62/0 · check-schema-drift OK.

Not done (not in the fixer brief): hook host allow-list (#8), `decode()` RangeError guard (#15), snapshot retention (#16), Publish-strip hover-only detail / grey "Desc" chip (#12). Before applying `01` in production note the build now FAILS on a 401 from the not-yet-created tables — apply `01` first or set `NX_CONTENT_OPTIONAL=1` in Vercel for that deploy.
