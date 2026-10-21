-- 20260718211953_data_quality_rpcs — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA extensions;

-- Fuzzy duplicate-client detection (name similarity or shared email). Staff only.
CREATE OR REPLACE FUNCTION public.find_duplicate_clients()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role = 'staff') then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'score')::numeric desc)
    from (
      select jsonb_build_object(
        'a_id', a.id, 'a_name', btrim(a.first_name||' '||a.last_name), 'a_email', a.email,
        'b_id', b.id, 'b_name', btrim(b.first_name||' '||b.last_name), 'b_email', b.email,
        'reason', case when a.email is not null and lower(a.email) = lower(b.email) then 'same email' else 'similar name' end,
        'score', round(greatest(
          case when a.email is not null and lower(a.email) = lower(b.email) then 1 else 0 end,
          similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name)))
        )::numeric, 2)
      ) as x
      from clients a
      join clients b on a.id < b.id
      where (a.email is not null and b.email is not null and lower(a.email) = lower(b.email))
         or similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name))) > 0.6
      limit 100
    ) s), '[]'::jsonb);
end $function$;

-- Data-health snapshot: what is missing / broken across the book. Staff only.
CREATE OR REPLACE FUNCTION public.get_data_quality()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  sent_ever boolean;
begin
  if not exists (select 1 from profiles where id = uid and role = 'staff') then
    return '{}'::jsonb;
  end if;
  select exists(select 1 from email_queue where status = 'sent') into sent_ever;

  return jsonb_build_object(
    'clients_total', (select count(*) from clients),
    'missing_email', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', btrim(first_name||' '||last_name)) order by last_name), '[]'::jsonb)
                      from (select id, first_name, last_name from clients where (email is null or email = '')
                            and exists (select 1 from cases c where c.client_id = clients.id and c.stage <> 'not_proceeding')
                            limit 300) q),
    'missing_email_count', (select count(*) from clients where (email is null or email = '')),
    'missing_phone_count', (select count(*) from clients where (phone is null or phone = '')),
    'missing_both_count', (select count(*) from clients where (email is null or email = '') and (phone is null or phone = '')),
    'live_unassigned', (select coalesce(jsonb_agg(jsonb_build_object('case_id', c.id, 'name', btrim(cl.first_name||' '||cl.last_name), 'stage', c.stage) order by c.updated_at desc), '[]'::jsonb)
                        from cases c join clients cl on cl.id = c.client_id
                        where c.assigned_to is null and c.stage not in ('completed','not_proceeding')),
    'completed_missing_fee', (select coalesce(jsonb_agg(jsonb_build_object('case_id', c.id, 'name', btrim(cl.first_name||' '||cl.last_name)) order by c.completed_at desc), '[]'::jsonb)
                        from cases c join clients cl on cl.id = c.client_id
                        where c.stage = 'completed' and coalesce(c.broker_fee,0) = 0 and coalesce(c.proc_fee,0) = 0 and c.fee_status <> 'waived'
                        limit 200),
    'completed_missing_rate_end', (select count(*) from cases c
                        where c.stage = 'completed' and c.rate_end_date is null
                          and coalesce(c.rate_type,'') not in ('tracker','variable')
                          and c.retention_source_case_id is null),
    'emails_stuck', (select count(*) from email_queue where status = 'queued' and scheduled_for < now() - interval '2 hours'),
    'emails_sending_live', sent_ever,
    'emails_failed', (select count(*) from email_queue where status = 'failed')
  );
end $function$;
