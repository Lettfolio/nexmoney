-- =============================================================================
-- R93 · 02 · pg_cron: seo-snapshot nightly at 02:30 UTC
--
-- TODO (CTO, before applying): the repo holds NO copy of a live cron.job command — the
-- functions snapshot and r84–r86 never captured one. What is known (memory of the R5-era
-- setup): every job is `select net.http_post(…)` to /functions/v1/<fn> with the anon key as
-- `Authorization: Bearer …`, and the functions themselves admit a cron call by the
-- `x-cron-key` header matched against settings.cron_key (process-emails v21, owner-digest v7).
-- Diff this file against the real pattern first:
--     select jobname, schedule, command from cron.job order by jobname;
-- and adjust the http_post call if process-emails' differs.
--
-- HOW THIS FILE AVOIDS INVENTING A KEY: it copies the Bearer token straight out of the existing
-- `nexmoney-process-emails` job's command (aborts if that job or token is missing), and reads
-- the x-cron-key from settings.cron_key AT RUN TIME (rotating the key needs no reschedule).
-- No key literal is written into the repo.
--
-- IDEMPOTENT: unschedules a previous 'nexmoney-seo-snapshot' first.
-- VERIFY:  select jobname, schedule, active from cron.job where jobname = 'nexmoney-seo-snapshot';
--          -- '30 2 * * *', t. After 02:30 UTC: select * from seo_snapshots where kind='summary' order by day desc limit 1;
-- =============================================================================
do $$
declare
  bearer text;
begin
  select (regexp_match(command, 'Bearer ([A-Za-z0-9._-]+)'))[1] into bearer
    from cron.job where jobname = 'nexmoney-process-emails';
  if bearer is null then
    raise exception 'R93: could not read the Bearer token from cron job nexmoney-process-emails — schedule seo-snapshot by hand';
  end if;

  if exists (select 1 from cron.job where jobname = 'nexmoney-seo-snapshot') then
    perform cron.unschedule('nexmoney-seo-snapshot');
  end if;

  perform cron.schedule('nexmoney-seo-snapshot', '30 2 * * *', format($cmd$
    select net.http_post(
      url := 'https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/seo-snapshot',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s',
        'x-cron-key', coalesce((select value from public.settings where key = 'cron_key'), '')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$, bearer));
end
$$;
