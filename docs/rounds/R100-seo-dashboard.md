# R100 · SEO dashboard — history, queries, keyword recommendations

Website › SEO gains three things, all inside the existing tab:

- **Search history** — clicks, impressions and average position over time for the whole site, one page or one
  query (28 days / 90 days / 16 months; weekly totals past 120 days). Three single-series charts on one date
  axis, a shared crosshair and read-out. A page row's **History** button, a query row or a recommendation
  switches the chart.
- **Search queries** — the top-20 list becomes a table of every stored query (up to 250): sortable columns,
  a filter box, the page that ranks, and **Change** in position against the snapshot a week older. The pages
  table gains the same Change column.
- **Keyword recommendations** — rules over the 28-day queries and the audited titles/H1s: nearly page one
  (11–20), page one with few clicks, two pages competing, seen but buried (20+, 50+ impressions), and old
  addresses Google still lists. Brand searches are left out. At most ten, most actionable first.

## Data
- `edge/seo-snapshot-v3.ts` (was v2): 250 queries; `gsc_query.data.pages` (query × page, top 3); daily series
  `gsc_day` / `gsc_page_day` / `gsc_query_day` whose `day` is the date itself. First run (or
  `{ backfill: true }`) reads 480 days of site data and 90 of page/query data; later runs re-read 10 days.
  History is upserted after the audit rows and never decides `ok`.
- `supabase/migrations/20261113120000_r100_seo_history_kinds.sql`: widens the `kind` check, adds
  `(kind, page, day)` index. Applied by the Supabase integration on merge.

## Order after merge
1. Merge → migration applies → Vercel deploys (eight tags `r100`).
2. Deploy `seo-snapshot` v3, then run it once (the stored cron command): it backfills.
3. Live-verify eleven hashes, `__errorLog` 0, the chart draws.
Until step 2 the tab works on v2 data: the chart says "No daily figures for this yet".

## Tests
`r93_seo` 65 (new §F, 22 checks), `r93_data` 96, `r93_content`, `r81_platform`, `r90_carve`, `r90_queues`,
`r94_csp`, `r95_kit`, `r82_correct`, smoke 150, lint 0, tsc 0.
