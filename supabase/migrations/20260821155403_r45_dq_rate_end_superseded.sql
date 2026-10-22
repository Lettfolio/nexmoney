-- 20260821155403_r45_dq_rate_end_superseded — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R45 — post-import data-quality honesty. "Completed, no rate-end" existed to catch mortgages
-- whose deal-end nobody recorded. The back book import deliberately clears dates on deals that
-- were REPLACED by a newer deal on the same property (and protection-only holder records have no
-- mortgage at all), so the tile read 598 — noise burying the ~12 genuine gaps. Two exclusions,
-- both true for future hand-entered data as well: (a) a record with no loan and no mortgage
-- account number is not a mortgage; (b) a completed deal with a NEWER completed deal on the same
-- property for the same client has been superseded — its missing rate-end is a fact, not a fault.
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
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
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
                          and c.retention_source_case_id is null
                          -- R45 (a): not a mortgage record at all
                          and not (c.loan_amount is null and c.mortgage_account_number is null)
                          -- R45 (b): superseded by a newer completed deal on the same property
                          and not exists (select 1 from cases n
                                          where n.client_id = c.client_id and n.stage = 'completed' and n.id <> c.id
                                            and n.property_address is not null and c.property_address is not null
                                            and lower(regexp_replace(n.property_address,'[^a-zA-Z0-9]','','g'))
                                              = lower(regexp_replace(c.property_address,'[^a-zA-Z0-9]','','g'))
                                            and n.completed_at > c.completed_at)),
    'emails_stuck', (select count(*) from email_queue where status = 'queued' and scheduled_for < now() - interval '2 hours'),
    'emails_sending_live', sent_ever,
    'emails_failed', (select count(*) from email_queue where status = 'failed')
  );
end $function$;
