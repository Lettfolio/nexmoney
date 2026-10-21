-- 20260727073745_r5_m5_get_reports_per_type_cash_date — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- M5 — get_reports: fees_banked_ytd keyed on coalesce(broker_fee_paid_at, fee_paid_at).
-- Re-issued from the live pg_get_functiondef capture; ONLY that subquery changes.
-- Role guard (role in ('owner','admin','adviser','staff')) and every other branch byte-identical.
CREATE OR REPLACE FUNCTION public.get_reports()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  yr int := extract(year from current_date);
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    -- Weighted pipeline: expected fee income from live cases by stage probability.
    'forecast', (
      select jsonb_build_object(
        'weighted_total', coalesce(round(sum((coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)) * p.prob)),0),
        'gross_total', coalesce(round(sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0))),0),
        'by_stage', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'stage', s.stage, 'cases', s.n,
            'gross', round(s.gross), 'weighted', round(s.weighted)) order by s.ord), '[]'::jsonb)
          from (
            select c2.stage,
                   case c2.stage when 'enquiry' then 1 when 'fact_find' then 2 when 'decision_in_principle' then 3
                        when 'application' then 4 when 'offer' then 5 when 'exchange' then 6 end as ord,
                   count(*) n,
                   sum(coalesce(c2.broker_fee,0)+coalesce(c2.proc_fee,0)) gross,
                   sum((coalesce(c2.broker_fee,0)+coalesce(c2.proc_fee,0)) *
                       case c2.stage when 'enquiry' then 0.10 when 'fact_find' then 0.20 when 'decision_in_principle' then 0.35
                            when 'application' then 0.60 when 'offer' then 0.85 when 'exchange' then 0.95 else 0 end) weighted
            from cases c2
            where c2.stage in ('enquiry','fact_find','decision_in_principle','application','offer','exchange')
            group by c2.stage
          ) s
        )
      )
      from cases c
      join (values ('enquiry',0.10),('fact_find',0.20),('decision_in_principle',0.35),
                   ('application',0.60),('offer',0.85),('exchange',0.95)) as p(stage,prob)
        on p.stage = c.stage::text
    ),

    -- Per-adviser scoreboard.
    'advisers', (
      select coalesce(jsonb_agg(x order by (x->>'fees_banked_ytd')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'staff_id', pr.id,
          'name', coalesce(nullif(pr.full_name,''), pr.email),
          'open_cases', (select count(*) from cases c where c.assigned_to = pr.id and c.stage not in ('completed','not_proceeding')),
          'completions_ytd', (select count(*) from cases c where c.assigned_to = pr.id and c.stage='completed' and extract(year from c.completed_at)=yr),
          'fees_banked_ytd', (select coalesce(round(sum(coalesce(c.broker_fee,0))),0) from cases c where c.assigned_to = pr.id and extract(year from coalesce(c.broker_fee_paid_at, c.fee_paid_at))=yr),
          'proc_ytd', (select coalesce(round(sum(coalesce(c.proc_fee,0))),0) from cases c where c.assigned_to = pr.id and c.stage='completed' and extract(year from c.completed_at)=yr),
          'overdue_tasks', (select count(*) from case_tasks t where t.assigned_to = pr.id and t.done_at is null and t.due_date < current_date),
          'avg_days_to_complete', (select round(avg(extract(epoch from (c.completed_at - c.created_at))/86400)) from cases c where c.assigned_to = pr.id and c.stage='completed' and c.completed_at is not null)
        ) as x
        from profiles pr where pr.role in ('owner','admin','adviser','staff')
      ) q
    ),

    -- Lead-source ROI: which sources actually produce completed revenue.
    'lead_sources', (
      select coalesce(jsonb_agg(x order by (x->>'revenue')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'source', src,
          'cases', count(*),
          'completed', count(*) filter (where stage='completed'),
          'conversion', case when count(*)>0 then round(100.0*count(*) filter (where stage='completed')/count(*)) else 0 end,
          'revenue', coalesce(round(sum((coalesce(broker_fee,0)+coalesce(proc_fee,0)) ) filter (where stage='completed')),0)
        ) as x
        from (select coalesce(nullif(btrim(lead_source),''),'(not set)') src, stage, broker_fee, proc_fee from cases) c
        group by src
      ) q
    ),

    -- Client lifetime value: total fees + commission across all a client's cases.
    'client_ltv', (
      select coalesce(jsonb_agg(x order by (x->>'ltv')::numeric desc), '[]'::jsonb) from (
        select jsonb_build_object(
          'client_id', cl.id,
          'name', btrim(cl.first_name||' '||cl.last_name),
          'cases', count(c.id),
          'ltv', coalesce(round(sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)+coalesce(c.protection_commission,0))),0)
        ) as x
        from clients cl join cases c on c.client_id = cl.id
        where c.stage = 'completed'
        group by cl.id, cl.first_name, cl.last_name
        having sum(coalesce(c.broker_fee,0)+coalesce(c.proc_fee,0)+coalesce(c.protection_commission,0)) > 0
        order by 1 desc
        limit 20
      ) q
    )
  );
end $function$;
