# R93 · Website — Content + SEO in the back office (21 Oct 2026)

A new **Website** page (owner/admin only; sidebar, Firm group) with two tabs:

- **Content** — the 14 public pages with their title / meta description / H1 / Open Graph fields, editable; **Guides**
  (draft → approved → published, owner approves; a non-owner edit of approved text demotes it to draft); a
  **Publish site** button that fires the Vercel deploy hook and records each click (`site_publishes`).
- **SEO** — the nightly audit (titles, descriptions, H1s, canonicals, broken internal links, thin pages), PageSpeed
  mobile scores, and Search Console clicks/position/top queries once a service account is connected; **Run audit now**.

Content is applied at **build time**: `build.js` reads `site_pages` + published `site_posts` with the anon key, rewrites
the pages' head/H1, renders `/guides/<slug>` + `/guides` from `guides.template.html` (marked 15, HTML escaped) and
extends `sitemap.xml`. A content fetch failure fails the build (the previous deploy stays live); `NX_CONTENT_OPTIONAL=1`
builds without content. `/guides → /faq` redirect removed from `vercel.json`.

## Shape
Foundation (Fable) → A data/edge/build · B Content · C SEO (Opus, worktrees) → merge → verifier (Fable, 66 checks:
1 P1, 5 P2, 12 P3) → fixer (Opus: P1 + all P2 + 5 P3) → tags r93. Eighth classic script `admin/site.js`
(core → reports-money → diary → import → vault → **site** → app); eight build tags; what's-new 93.

## Harness (all green at 7851431)
smoke 150/0 · r93_data 92 · r93_content 56 · r93_seo 42 · r90_carve 70 · r90_queues 40 · r87_shell 56 · r89_tabs 63 ·
r81_platform 62 · schema-drift OK. Re-based fixtures: 8 tags, 11 sidebar entries, admin.css cap 3,950, D12 scans site.js.
Build hashes (first 6): core 1c85b1 · rm f0bc03 · diary 6f5547 · import a12960 · vault 922c81 · site a956aa · app 8acec4 · css 4b40f7.

## Server side (apply IN THIS ORDER, before the push)
1. `db/r93/01_site_tables.sql` — Supabase SQL editor (file is wrapped in begin/commit). Four tables + RLS, column-scoped
   anon read, status guard, `site_hook_is_set()`, three settings rows.
2. Edge functions: deploy `edge/site-publish-v1.ts` as **site-publish** and `edge/seo-snapshot-v1.ts` as **seo-snapshot**
   (verify_jwt true, like the others).
3. `db/r93/02_cron.sql` — nightly 02:30 UTC audit (copies the Bearer from the process-emails job; reads `settings.cron_key`).
4. Push. The Vercel build now needs step 1 (anon read) or it fails on purpose.
5. Settings › Integrations → paste the Vercel **Deploy Hook** URL (Vercel → project → Settings → Git → Deploy Hooks, branch
   main). Optional secrets: `PSI_API_KEY` (more PageSpeed quota), `GSC_SERVICE_ACCOUNT` (Search Console JSON).

## Parked (verifier P3 / product)
FAQ editor (no page renders FAQ blocks yet — decide placement); deploy-hook host allow-list; `seo_snapshots` retention;
"Desc —" chips on un-overridden pages read as findings; "Submit for approval" has no submitted state; Guides not in the
site nav (decide); snapshot/Vercel 404 feed.
