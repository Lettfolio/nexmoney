-- 20260806003312_r11_watchtower_text — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R11 quality fixes.
--
-- (a) Noun agreement in run_watchtower.
--     The brief cited "1 completed cases" (Rule 9, fee_aging_60) but that text
--     already agrees in production:
--       s.n || ' completed case' || case when s.n = 1 then '' else 's' end
--     as does Rule 8 (retention_gap, "N client/clients"). The one alert detail
--     that does NOT agree is Rule 7 (workload): "N tasks overdue" is hardcoded
--     plural. It is currently unreachable at n = 1 because the rule only fires
--     at count(*) >= 5, so this is a latent defect, not a live one.
--
--     Patched by rewriting the function from its own pg_get_functiondef with a
--     single targeted replace, so every other byte of the body is preserved
--     verbatim. The guard aborts the migration if the target text is absent.
do $mig$
declare
  src    text;
  newsrc text;
begin
  src := pg_get_functiondef('public.run_watchtower()'::regprocedure);

  newsrc := replace(
    src,
    'n || '' tasks overdue'',',
    'n || '' task'' || case when n = 1 then '''' else ''s'' end || '' overdue'','
  );

  if newsrc = src then
    raise exception
      'r11_watchtower_text: target text for the workload plural fix was not found in run_watchtower(); aborting rather than guessing';
  end if;

  execute newsrc;
end
$mig$;

-- (b) leads.discard_reason — the discard dialog collects a required reason but
--     had nowhere to persist it. Nullable so the 100+ existing rows stay valid;
--     the frontend wiring lands separately.
--
--     No RLS or trigger work needed: leads carries a single ALL policy
--     ("staff all", using/check is_staff()) which is column-agnostic, table-level
--     grants cover new columns automatically, and the R10 BE-8 audit_leads
--     trigger runs audit_row(), which diffs to_jsonb(new) generically and so
--     picks the new column up with no change.
alter table public.leads add column if not exists discard_reason text;

comment on column public.leads.discard_reason is
  'Reason captured when a lead is discarded (R11). Nullable: rows discarded before R11 have none.';
