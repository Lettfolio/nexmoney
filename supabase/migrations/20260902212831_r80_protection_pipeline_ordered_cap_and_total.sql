-- 20260902212831_r80_protection_pipeline_ordered_cap_and_total — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R80: get_protection_pipeline's limit 250 had NO ORDER BY — an arbitrary 250 of 1,531
-- candidates, ranked only among themselves. The cap is now the BEST 250 (score computed
-- as scalar columns, ordered before the limit; same array return shape so older clients
-- keep working), and get_protection_pipeline_total() reports the uncapped candidate count.
CREATE OR REPLACE FUNCTION public.get_protection_pipeline(p_scope text DEFAULT 'all'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  avg_comm numeric := coalesce(nullif(get_setting('protection_avg_commission'),'')::numeric, 850);
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return '[]'::jsonb;
  end if;
  if not is_admin_or_owner() then
    p_scope := 'mine';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'case_id', s.id, 'client_id', s.client_id, 'client_name', s.client_name,
      'has_email', s.has_email, 'stage', s.stage, 'case_kind', s.case_kind,
      'lender', s.lender, 'loan_amount', s.loan_amount,
      'protection_status', s.protection_status, 'gi_status', s.gi_status,
      'live', s.live, 'owner', s.owner, 'est_commission', s.est_commission, 'score', s.score
    ) order by s.score desc) from (
    select c.id, c.client_id,
      btrim(cl.first_name || ' ' || cl.last_name) as client_name,
      (cl.email is not null and cl.email <> '') as has_email,
      c.stage, c.case_kind, c.lender, c.loan_amount, c.protection_status, c.gi_status,
      (c.stage not in ('completed','not_proceeding')) as live,
      c.assigned_to as owner,
      round(avg_comm * case
          when coalesce(c.loan_amount,0) < 100000 then 0.7
          when c.loan_amount < 250000 then 1.0
          when c.loan_amount < 500000 then 1.3
          else 1.6 end) as est_commission,
      (case c.stage
          when 'offer' then 100 when 'exchange' then 95 when 'application' then 90
          when 'decision_in_principle' then 80 when 'fact_find' then 70
          when 'enquiry' then 50 when 'completed' then 30 else 0 end
        + case when c.protection_status = 'quoted' then 15
               when c.protection_status = 'discussed' then 5 when c.protection_status = 'referred' then 10 else 0 end
        + least(coalesce(c.loan_amount,0) / 50000, 20)
        + case when cl.email is not null and cl.email <> '' then 3 else 0 end) as score
    from cases c
    join clients cl on cl.id = c.client_id
    where c.protection_status in ('not_discussed','discussed','quoted','referred')
      and c.stage <> 'not_proceeding'
      and c.retention_source_case_id is null
      and (p_scope <> 'mine' or c.assigned_to = uid or c.assigned_to is null)
    order by (case c.stage
          when 'offer' then 100 when 'exchange' then 95 when 'application' then 90
          when 'decision_in_principle' then 80 when 'fact_find' then 70
          when 'enquiry' then 50 when 'completed' then 30 else 0 end
        + case when c.protection_status = 'quoted' then 15
               when c.protection_status = 'discussed' then 5 when c.protection_status = 'referred' then 10 else 0 end
        + least(coalesce(c.loan_amount,0) / 50000, 20)
        + case when cl.email is not null and cl.email <> '' then 3 else 0 end) desc
    limit 250) s), '[]'::jsonb);
end $function$;

CREATE OR REPLACE FUNCTION public.get_protection_pipeline_total(p_scope text DEFAULT 'all'::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  n bigint;
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return jsonb_build_object('total', 0);
  end if;
  if not is_admin_or_owner() then
    p_scope := 'mine';
  end if;
  select count(*) into n
  from cases c join clients cl on cl.id = c.client_id
  where c.protection_status in ('not_discussed','discussed','quoted','referred')
    and c.stage <> 'not_proceeding'
    and c.retention_source_case_id is null
    and (p_scope <> 'mine' or c.assigned_to = uid or c.assigned_to is null);
  return jsonb_build_object('total', n);
end $function$;
