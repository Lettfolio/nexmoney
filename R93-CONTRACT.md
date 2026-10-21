# R93 "Website" — shared contract (read fully before writing a line)

Repo: /root/nx, branch `r93` (foundation commit a819ce0 on top of origin/main 9797934). Each slice works in its
own git worktree off `r93` and commits there; the CTO merges. Owner/Administrator-only feature. Daniel's rules:
**say less** — no explanatory paragraphs, one behaviour per control, no new pages beyond the two tabs here.
Read `HARNESS.md` §"Standing rules" and the head banners of `admin/site.js`, `admin/vault.js` first.

## What exists (foundation, do not re-do)
- `admin/site.js` — EIGHTH classic script, loads between vault.js and app.js. Two fenced regions:
  `/* ===== R93 · B CONTENT ===== */ … /* ===== END R93 · B CONTENT ===== */` (slice B only) and
  `/* ===== R93 · C SEO ===== */ … /* ===== END R93 · C SEO ===== */` (slice C only). Keep the header and the
  tag line at the foot untouched. Definition-time rule: top-level statements in site.js may NOT reference anything
  from app.js (`db`, `settings`, `isOwner`, `toast`, `esc`, `openOverlay`, `lsGet`, `userKey`, `fmt*`…) — use them
  only INSIDE functions. `esc` and `toast` live in core.js (earlier) and are safe anywhere.
- `admin/index.html` — `#page-site` with `.page-tabs-slot` and two empty panels:
  `<section id="page-site-content" class="page hidden" data-tabpanel="content">` (B) and
  `<section id="page-site-seo" class="page hidden" data-tabpanel="seo">` (C), each inside its own HTML fence
  comment. Paint them from JS (innerHTML) — do not add markup to index.html outside your fence.
- `admin/app.js` — `PAGE_HASH.site = "website"`, `PAGE_TABS.site = [content, seo]`,
  `PAGE_TAB_LOADERS.site = { content: (o) => loadSiteContent(o), seo: (o) => loadSiteSeo(o) }`,
  `PAGE_ROLE_GATE.site = isAdminOrOwner`, palette "Go to Website". `nav("site")`, `nav("site/seo")`, `#website/seo`.
  Loaders get `{ refresh }` (true on arrival/refresh; first open may paint from a read you hold).
- `build.js` MINIFY lists `admin/site.js`. Tests r81_platform / r90_carve / r89_tabs / r33 / r38 / r87_pipeline_case
  already re-based for eight tags / 11 sidebar entries. **Do not bump tags** — the CTO bumps all eight at the gate.

## Data model (slice A owns the SQL; B and C code against this shape — it is frozen)
```sql
-- db/r93/01_site_tables.sql
create table public.site_pages (
  slug          text primary key,            -- "" for home, "services", "buy-to-let-mortgages-dorset" … (no leading slash)
  title         text,                        -- <title>; null = keep the HTML's own
  meta_description text,                     -- <meta name=description>; null = keep
  og_title      text, og_description text, og_image text,
  h1            text,                        -- null = keep
  faq           jsonb not null default '[]', -- [{q,a}] → FAQPage JSON-LD + the page's FAQ block when the page has <!-- nx:faq -->
  notes         text,                        -- internal, never published
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);
create table public.site_posts (             -- guides at /guides/<slug>
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text not null,
  excerpt       text,                        -- ≤ 200 chars, meta description + card text
  body_md       text not null default '',    -- Markdown (headings, paragraphs, **bold**, *italic*, links, lists, > quotes)
  cover_image   text,
  status        text not null default 'draft' check (status in ('draft','approved','published','archived')),
  approved_by   uuid references auth.users(id), approved_at timestamptz,
  published_at  timestamptz,
  author_id     uuid references auth.users(id),
  created_at    timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.site_publishes (         -- one row per Publish click
  id            uuid primary key default gen_random_uuid(),
  requested_by  uuid references auth.users(id), requested_at timestamptz not null default now(),
  status        text not null default 'requested' check (status in ('requested','sent','failed')),
  detail        text,                        -- hook response / error, short
  pages         int, posts int               -- counts at request time
);
create table public.seo_snapshots (          -- one row per (day, kind, page)
  id            bigserial primary key,
  day           date not null default (now() at time zone 'utc')::date,
  kind          text not null check (kind in ('audit','psi','gsc','gsc_query','summary')),
  page          text not null default '',    -- URL path ("" = site-wide / summary); for gsc_query = the query text
  data          jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (day, kind, page)
);
```
RLS: enable on all four. Policies: `is_admin_or_owner()` for ALL on site_pages / site_posts / site_publishes /
seo_snapshots (select+insert+update+delete; **no delete on site_publishes or seo_snapshots**). PUBLIC READ for the
build: `anon` may `select` `site_pages` and `site_posts where status = 'published'` (build.js fetches with the anon key).
Grants to `authenticated`, `anon`, `service_role` as the r86 files do. `updated_at` trigger on site_pages/site_posts
(reuse an existing `set_updated_at()` if one exists in `db/_live_functions_snapshot.sql`, else create
`public.site_touch_updated_at()`). Status rules enforced in SQL (trigger `site_posts_status_guard`):
`approved`/`published` may be set only by `is_owner()`; setting approved stamps `approved_by/approved_at`;
published stamps `published_at` if null. Also `settings` rows (insert if absent): `vercel_deploy_hook` (''),
`gsc_property` ('sc-domain:nexmoney.co.uk'), `seo_audit_enabled` ('on').

`data` shapes (C renders these; A's edge function writes them):
- `audit` per page: `{ status, title, title_len, meta, meta_len, h1, h1_count, canonical, canonical_ok, words,
  internal_links, broken_links:[{href,status}], images_no_alt, has_jsonld, issues:[{code,level:'error'|'warn',msg}] }`
  issue codes: `missing_title`, `title_long`(>60), `title_short`(<30), `missing_meta`, `meta_long`(>160), `meta_short`(<70),
  `no_h1`, `multi_h1`, `canonical_mismatch`, `broken_link`, `img_no_alt`, `thin_content`(<250 words), `dup_title`, `dup_meta`, `http_error`.
- `psi` per page: `{ strategy:'mobile', performance, lcp_ms, cls, inp_ms, fcp_ms, fetched_at }` (scores 0–100).
- `gsc` per page (28-day window ending day-2): `{ clicks, impressions, ctr, position }`; `gsc_query` rows: page = query text,
  data `{ clicks, impressions, ctr, position }` (top 50).
- `summary` (page ''): `{ pages, errors, warnings, psi_avg, gsc:{clicks,impressions,ctr,position}|null, gsc_connected:bool,
  psi_connected:bool, duration_ms, ran_at }`.

## Edge functions (slice A; files only — the CTO deploys)
- `edge/site-publish-v1.ts` — POST, caller JWT required, `uc.rpc("session_ok")` gate (copy the r86 pattern from
  `edge/owner-digest-v7.ts`), role owner/admin via `profiles.role`; reads `settings.vercel_deploy_hook`; inserts a
  `site_publishes` row `requested`; POSTs the hook (no body); updates the row `sent`/`failed` with a ≤200-char detail;
  returns `{ ok, id, status, detail }`. Missing hook → 400 `{ error: "no deploy hook set" }` and a `failed` row.
- `edge/seo-snapshot-v1.ts` — runs by pg_cron (`x-cron-key`, same pattern as process-emails) nightly 02:30 UTC, or by
  owner/admin JWT (`session_ok` gate) with `{ force: true }`. Steps: (1) fetch `https://www.nexmoney.co.uk/sitemap.xml`,
  each `<loc>` → audit (fetch HTML, parse with regex/DOMParser-free string parsing, follow internal links with HEAD/GET,
  cap 150 links, 8 concurrent); (2) PSI: `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=mobile`
  (+`&key=` when `PSI_API_KEY` secret exists), ≤ 15 pages, sequential with 1 s gap, skip on 429; (3) GSC when
  `GSC_SERVICE_ACCOUNT` secret (JSON) exists: sign a JWT with WebCrypto RS256 → token → Search Analytics `query` for
  `settings.gsc_property`, dimensions page / query, 28 days ending today-2; (4) upsert rows on `(day,kind,page)`;
  (5) write `summary`. Never throw out of the handler — return `{ ok, summary, errors:[…] }`. Total budget < 50 s;
  degrade (fewer PSI pages) rather than time out. Also `db/r93/02_cron.sql` scheduling it the way existing cron rows do
  (read `cron.job` pattern in `db/_live_functions_snapshot.sql` or the r84/r85 files; cron key comes from the existing
  settings/secret the others use — do not invent a new one).

## Build-time content (slice A, `build.js` + new `guides.template.html`)
- `build.js`: after `walk`, fetch `site_pages` and published `site_posts` from
  `https://sclghkmvzpwtmnzbkaoe.supabase.co/rest/v1/...` with the anon key (read `SUPABASE_KEY` from `admin/app.js`
  line 3 at build time, don't duplicate the literal). 8 s timeout; on ANY failure log one line and build the repo HTML
  unchanged — the build must never fail because of content. `--hash` mode is unaffected (no network).
- Page override: for each `site_pages` row whose `slug + ".html"` exists at root: replace `<title>…</title>`,
  `<meta name="description" content="…">`, `og:title`, `og:description`, `og:image`, `twitter:title/description`, and the
  FIRST `<h1>…</h1>` text when the field is non-null. FAQ: if the page contains `<!-- nx:faq -->` replace that comment with
  a `<section class="faq">` of `<details><summary>q</summary><p>a</p></details>` + a `FAQPage` JSON-LD script; otherwise
  only the JSON-LD (before `</head>`). Escape everything.
- Guides: `guides.template.html` (root; copy the head/nav/footer of `faq.html`, same CSS, placeholders `{{title}}`,
  `{{excerpt}}`, `{{body}}`, `{{slug}}`, `{{published}}`, `{{cover}}`), rendered with `marked` (add as devDependency,
  pinned) + a strict allow-list sanitiser (no raw HTML from Markdown: `marked` option to escape HTML). Output
  `dist/guides/<slug>.html` and `dist/guides.html` (index: cards). Article JSON-LD + canonical `https://www.nexmoney.co.uk/guides/<slug>`.
- Sitemap: `dist/sitemap.xml` = repo sitemap + `/guides` + one `<url>` per published post (`lastmod` = updated_at date).
- `vercel.json`: REMOVE the `/guides → /faq` redirect (guides is a real page now); keep every other redirect.
- Add `/guides` to `llms.txt` and the footer nav of `guides.template.html` only — do not touch the other 14 pages' nav
  (Daniel decides whether Guides joins the site nav).

## Admin UI — slice B (Content tab, `site.js` B fence + CSS fence + `tests/r93_content.js`)
Paint `#page-site-content` with ONE list of the 14 public pages (from a constant `SITE_PAGES` = the sitemap paths with
labels) merged with `site_pages` rows: row = path, title (or "— from HTML"), description length chip (green 70–160 /
amber / red), "Edited" dot when a row exists, click → editor overlay (`openOverlay`) with fields title / meta
description / H1 / OG title / OG description / OG image URL / FAQ (q+a rows, add/remove) / internal notes, live
character counts, Save (upsert by slug) / Cancel. Below it "Guides": list (title, status badge, updated), "+ New guide",
editor overlay: title, slug (auto from title, editable, validated), excerpt (≤200 counter), cover URL, body Markdown
textarea with a Preview toggle (write a small `siteMdToHtml(md)` in site.js — headings `#`–`###`, paragraphs, `**`/`*`,
`[text](url)` with https/mailto/relative only, `-`/`1.` lists, `>` quotes; escape everything else — no raw HTML),
status control: draft → "Submit for approval" is a no-op label; owner sees "Approve" (→approved) and "Publish"
(→published); anyone sees "Archive". Non-owner clicking approve/publish gets the SQL error toast "Only the owner can
approve". Header strip of the tab: last publish (`site_publishes` latest: when, by whom, status) + **Publish site**
button (owner/admin) → calls edge `site-publish` via `db.functions.invoke("site-publish")`, toasts the result, re-reads
the strip; disabled with title "Set the Vercel deploy hook in Settings › Integrations" when `settings.vercel_deploy_hook`
is empty. Add the `vercel_deploy_hook` input to Settings › Integrations (app.js — ONE field, follow how other
integration URLs are rendered/saved there; this is B's only app.js touch). Everything uses existing kit classes
(`.list-row`, `.badge`, `.seg-strip`, `.btn`, `.panel-sub`, `u-*`); new CSS only in a fenced block
`/* ===== R93 · B CSS ===== */ … /* ===== END R93 · B CSS ===== */` appended to admin.css ABOVE the R90 utilities block.
Inline styles: zero (r90_queues asserts ceilings). Mock: extend `admin/mock-supabase.js` ONLY via the fixture hook
described below. Suite `tests/r93_content.js` (copy the shape of `tests/r89_tabs.js`): p4 opens `#website`, list has
14 rows, editor opens/saves (mock), guide create/approve/publish as owner, p1 (admin) cannot approve, Publish button
state, no console errors, inline-style count unchanged.

## Admin UI — slice C (SEO tab, `site.js` C fence + CSS fence + `tests/r93_seo.js`)
Paint `#page-site-seo` from the latest `seo_snapshots` day (one read: `select * from seo_snapshots where day =
(select max(day) …)` via two queries if needed). Top: four tiles (kit `data-band` tiles as Data health uses):
Pages audited / Issues (errors·warnings) / Performance (PSI avg, "—" until connected) / Search clicks 28d ("Connect"
until gsc_connected). Then ONE table: page · title length · description length · H1 · words · PSI · clicks · position ·
issues (chips with level colour; hover = msg). Row click → expands (`<details>`) the issue list and broken links.
Below: "Top queries" (gsc_query rows, 20) when connected, else a three-line Connect panel: "1. Create a Google Cloud
service account, 2. add it to Search Console as a user, 3. give Daniel the JSON — he adds it as the GSC_SERVICE_ACCOUNT
secret" (this is the only prose allowed). Header strip: "Last audit <when> · <duration>" + **Run audit now** button →
`db.functions.invoke("seo-snapshot", { body: { force: true } })`, spinner, re-read. Empty state when no snapshot:
one line + the button. CSS in `/* ===== R93 · C CSS ===== */` fence appended BELOW B's fence position (append at the
end of the file but above R90 utilities; if B's fence is absent in your worktree, still place yours above R90 utilities —
the merge keeps both). Suite `tests/r93_seo.js`: tiles render from fixtures, table has one row per audited page, issue
chips, connect panel when gsc missing, Run button calls the function (mock records the invoke), no console errors.

## Mock fixtures (shared hook — A writes it; B and C USE it)
A adds to `admin/mock-supabase.js` four fixture tables (`site_pages` 3 rows, `site_posts` 3 rows one per status,
`site_publishes` 2 rows, `seo_snapshots` ~20 rows for yesterday incl. summary/audit×14/psi×3/gsc×3/gsc_query×5) following
the file's existing table conventions, plus `functions.invoke` recording into `window.__mockInvokes` if the mock does
not already record invokes (check first). B and C: until A's commit lands, develop against the SAME shapes by writing
your fixtures into a LOCAL uncommitted copy; do not commit mock-supabase.js from B or C.

## Rules for all slices
- Fresh worktree: `git -C /root/nx worktree add /root/nx-<slice> -b r93-<slice> r93`. Commit there; never touch
  another slice's files or fences. Do not run the full battery; run smoke (`node smoke.js`) after any index.html change
  and your own suite + `tests/r90_queues.js` (inline-style ceilings) + `tests/r90_carve.js` (no duplicate top-level
  declarations across scripts — prefix every top-level name in site.js with `site`/`seo`).
- No new npm deps except `marked` (A). No CDN scripts. No `innerHTML` of unescaped user text. No secrets in code.
- Comments: WHY only, ≤6 lines, `"R93 · B: <why>"`. No tombstones.
- Finish with a short report at `/root/nx-<slice>/R93-<slice>.md`: what you built, how to verify, what you could not do.
