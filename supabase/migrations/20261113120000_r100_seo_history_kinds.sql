-- R100 · SEO history: seo-snapshot v3 stores Search Console's DAILY series next to the nightly
-- audit rows. The row's `day` is the date the figures belong to (not the day the audit ran):
--   gsc_day        page = ''      site totals for that date
--   gsc_page_day   page = path    one page on that date
--   gsc_query_day  page = query   one search query on that date
-- Only the kind check widens; RLS, grants and the (day, kind, page) key are unchanged.
-- The table itself came from db/r93/01_site_tables.sql, pasted into production (it is not in this
-- folder), so a data-less Preview Branch has no such table: there this migration does nothing.
do $$
begin
  if to_regclass('public.seo_snapshots') is null then
    raise notice 'R100: public.seo_snapshots absent (preview branch) - nothing to do';
    return;
  end if;
  alter table public.seo_snapshots drop constraint if exists seo_snapshots_kind_check;
  alter table public.seo_snapshots add constraint seo_snapshots_kind_check
    check (kind in ('audit','psi','gsc','gsc_query','summary','gsc_day','gsc_page_day','gsc_query_day'));
  -- The SEO tab reads one series at a time: (kind, page) ordered by day.
  create index if not exists seo_snapshots_kind_page_day_idx on public.seo_snapshots (kind, page, day);
end $$;
