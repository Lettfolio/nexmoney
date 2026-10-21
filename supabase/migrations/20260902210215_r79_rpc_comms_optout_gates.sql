-- 20260902210215_r79_rpc_comms_optout_gates — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R79: the four marketing-adjacent email queues honour clients.comms_optout
-- (review_request + referral_request in queue_automated_emails; birthday + anniversary
--  + review-reminder in queue_comms_extras). Anchored string surgery on the live
-- definitions; counts asserted so a drifted body fails loudly instead of silently.
DO $do$
declare def text;
begin
  select pg_get_functiondef(oid) into def from pg_proc where proname='queue_automated_emails' and pronamespace='public'::regnamespace;
  if (length(def) - length(replace(def,'and c.review_requested_at is null','')))/length('and c.review_requested_at is null') <> 1 then raise exception 'anchor1 count wrong'; end if;
  def := replace(def, 'and c.review_requested_at is null', 'and c.review_requested_at is null and not coalesce(cl.comms_optout,false)');
  if (length(def) - length(replace(def,'and not coalesce(cl.marketing_opt_out,false)','')))/length('and not coalesce(cl.marketing_opt_out,false)') <> 1 then raise exception 'anchor2 count wrong'; end if;
  def := replace(def, 'and not coalesce(cl.marketing_opt_out,false)', 'and not coalesce(cl.marketing_opt_out,false) and not coalesce(cl.comms_optout,false)');
  execute def;

  select pg_get_functiondef(oid) into def from pg_proc where proname='queue_comms_extras' and pronamespace='public'::regnamespace;
  if (length(def) - length(replace(def,'and not coalesce(cl.marketing_opt_out,false)','')))/length('and not coalesce(cl.marketing_opt_out,false)') <> 2 then raise exception 'anchor3 count wrong'; end if;
  def := replace(def, 'and not coalesce(cl.marketing_opt_out,false)', 'and not coalesce(cl.marketing_opt_out,false) and not coalesce(cl.comms_optout,false)');
  if (length(def) - length(replace(def,'and c.nps_score is null','')))/length('and c.nps_score is null') <> 1 then raise exception 'anchor4 count wrong'; end if;
  def := replace(def, 'and c.nps_score is null', 'and c.nps_score is null and not coalesce(cl.comms_optout,false)');
  execute def;
end $do$;
