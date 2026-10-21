-- 20260729160243_r5_m6_reassign_holdings — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R5-M6 — atomic leaver handover.
--
-- The client-side handover (admin/app.js openDeactivate) moves three scopes with three separate
-- PostgREST updates and, when one fails, tries to PUT BACK whatever already moved. That
-- compensating path is honest but it is not atomic: a failure between the move and the put-back
-- leaves a leaver's book split across two people with no undo. This function does the same three
-- moves in ONE transaction, so the outcome is all or nothing.
--
-- The live-work definitions are copied EXACTLY from the client flow they replace:
--   cases        : assigned_to = leaver AND stage NOT IN ('completed','not_proceeding')
--                  (completed and closed cases keep the adviser who did the work — every report
--                   that reads assigned_to is a historical record, and rewriting it retrospectively
--                   re-attributes months of somebody's completions to a colleague who never
--                   touched them.)
--   case_tasks   : assigned_to = leaver AND done_at IS NULL
--   appointments : staff_id    = leaver AND starts_at >= now()
--
-- Owner-only, via the is_owner() helper every RLS policy in this schema already evaluates — never
-- an inline role string, so a future role rename cannot silently open this up.
--
-- SECURITY DEFINER because the point is the transaction, not extra reach: the Owner can already
-- perform all three updates through RLS. The per-row audit triggers on cases / case_tasks /
-- appointments still fire (they run inside this transaction and read auth.uid(), which is the real
-- caller, not the definer), so the handover is recorded row by row exactly as the client path
-- recorded it. auto_stage_comms / auto_protection_triggers / cancel_retention_touches all return
-- early when the stage is unchanged, so no email or task is queued as a side effect of a handover.

create or replace function public.reassign_holdings(p_from uuid, p_to uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cases int := 0;
  v_tasks int := 0;
  v_appts int := 0;
  v_now   timestamptz := now();
begin
  if not public.is_owner() then
    raise exception 'Only an Owner can hand over a colleague''s work'
      using errcode = '42501';
  end if;

  if p_from is null or p_to is null then
    raise exception 'Both the person leaving and the person receiving the work are required'
      using errcode = '22004';
  end if;

  if p_from = p_to then
    raise exception 'Cannot hand work over to the same person'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'The person receiving the work has no profile'
      using errcode = '23503';
  end if;

  update public.cases
     set assigned_to = p_to
   where assigned_to = p_from
     and stage not in ('completed', 'not_proceeding');
  get diagnostics v_cases = row_count;

  update public.case_tasks
     set assigned_to = p_to
   where assigned_to = p_from
     and done_at is null;
  get diagnostics v_tasks = row_count;

  update public.appointments
     set staff_id = p_to
   where staff_id = p_from
     and starts_at >= v_now;
  get diagnostics v_appts = row_count;

  return jsonb_build_object('cases', v_cases, 'tasks', v_tasks, 'appointments', v_appts);
end;
$$;

comment on function public.reassign_holdings(uuid, uuid) is
  'R5-M6 — atomically move a leaver''s live cases, open tasks and future appointments to another '
  'colleague in one transaction. Owner-only (is_owner()). Returns {cases,tasks,appointments}.';

revoke all on function public.reassign_holdings(uuid, uuid) from public;
revoke all on function public.reassign_holdings(uuid, uuid) from anon;
grant execute on function public.reassign_holdings(uuid, uuid) to authenticated;
