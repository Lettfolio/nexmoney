-- 20260803114307_r9_m3_comms — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R9-M3: two new nightly steps bolted onto queue_comms_extras.
-- The three pre-existing blocks (birthday, anniversary, annual review) are
-- copied through byte-for-byte; the DO block at the end aborts the migration if
-- that is not true.
create temp table _r9_old_comms as
  select pg_get_functiondef(p.oid) as d
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'queue_comms_extras';

create or replace function public.queue_comms_extras()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare n_birthday int := 0; n_anniv int := 0; n_annual int := 0;
        n_doc_chase int := 0; n_doc_tasks int := 0;
        n_review_reminders int := 0; n_recent_reviews int := 0;
begin
  if get_setting('birthday_enabled') = 'on' then
    with due as (
      select cl.id, cl.email from clients cl
      where cl.date_of_birth is not null
        and to_char(cl.date_of_birth,'MM-DD') = to_char(current_date,'MM-DD')
        and cl.email is not null and cl.email <> ''
        and not coalesce(cl.marketing_opt_out,false)
        and not exists (select 1 from email_queue e where e.client_id = cl.id
                        and e.email_type = 'birthday_greeting'
                        and e.created_at >= date_trunc('year', now()))
    ), ins as (
      insert into email_queue (client_id, email_type, to_email)
      select id, 'birthday_greeting', email from due
      returning 1
    )
    select count(*) into n_birthday from ins;
  end if;

  if get_setting('anniversary_enabled') = 'on' then
    with due as (
      select c.id, c.client_id, cl.email from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and to_char(c.completed_at at time zone 'Europe/London','MM-DD') = to_char(current_date,'MM-DD')
        and c.completed_at < date_trunc('year', now())
        and (c.anniversary_sent_at is null or c.anniversary_sent_at < date_trunc('year', now()))
        and cl.email is not null and cl.email <> ''
        and not coalesce(cl.marketing_opt_out,false)
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'completion_anniversary', email from due
      returning case_id
    )
    update cases set anniversary_sent_at = now() where id in (select case_id from ins);
    get diagnostics n_anniv = row_count;
  end if;

  -- R8-M1: annual review touch. Twelve months after completion, and every year
  -- after, drop ONE call task on the case adviser's list. Deliberately no email:
  -- an annual-review email would need a new email_type enum value, which was not
  -- approved for this round.
  -- Idempotency without a schema change: the generated title is byte-identical
  -- every year (completion date and property never change), so an exact-title
  -- check would suppress every year after the first. Instead we look for an
  -- annual-review task on the same case created within the last 11 months --
  -- one anniversary is ~12 months apart, so last year's task never blocks this
  -- year's, while any re-run inside the same year is blocked.
  if get_setting('annual_review_enabled') = 'on' then
    with due as (
      select c.id, c.assigned_to,
             btrim(cl.first_name || ' ' || cl.last_name) as client_name,
             to_char(c.completed_at at time zone 'Europe/London','DD/MM/YYYY') as completed_label,
             coalesce(
               nullif(btrim(split_part(replace(coalesce(c.property_address,''), E'\\n', ','), ',', 1)), ''),
               nullif(btrim(coalesce(c.property_address,'')), '')
             ) as prop_label
      from cases c join clients cl on cl.id = c.client_id
      where c.stage = 'completed' and c.completed_at is not null
        and to_char(c.completed_at at time zone 'Europe/London','MM-DD') = to_char(current_date,'MM-DD')
        and (c.completed_at at time zone 'Europe/London')::date <= (current_date - interval '12 months')::date
        and not exists (
          select 1 from case_tasks t
          where t.case_id = c.id
            and t.title like 'Annual review call — %'
            and t.created_at >= now() - interval '11 months')
    ), ins as (
      insert into case_tasks (case_id, title, due_date, assigned_to)
      select id,
             'Annual review call — ' || client_name || ' (completed ' || completed_label ||
             case when prop_label is not null then ', on ' || prop_label else '' end || ')',
             current_date, assigned_to
      from due
      returning 1
    )
    select count(*) into n_annual from ins;
  end if;

  -- R9-M3: document chase. A case parked in fact_find or application with items
  -- still outstanding gets nudged every three days. There is no new email type:
  -- process-emails v11 composes docs_request from the checklist, naming ONLY the
  -- missing items, so the same type carries the first ask and every chase.
  -- Cap: at most four docs_request emails per case in total (the original from
  -- auto_stage_comms plus three chases). After that the client is left alone and
  -- the adviser gets a task to phone instead -- an unanswered email chain is not
  -- fixed by a fifth email.
  -- Gated on auto_docs_request, the switch that already governs whether this
  -- firm sends document requests automatically at all.
  if get_setting('auto_docs_request') = 'on' then
    with base as (
      select c.id, c.client_id, cl.email,
             (select count(*) from email_queue e
               where e.case_id = c.id and e.email_type = 'docs_request'
                 and e.status <> 'cancelled') as sent_count,
             (select max(e.created_at) from email_queue e
               where e.case_id = c.id and e.email_type = 'docs_request'
                 and e.status <> 'cancelled') as last_queued
      from cases c join clients cl on cl.id = c.client_id
      where c.stage in ('fact_find','application')
        and cl.email is not null and cl.email <> ''
        and exists (select 1 from case_documents d
                     where d.case_id = c.id and d.status = 'requested')
        -- Never stack a second request behind one that has not gone out yet
        -- (e.g. RESEND_API_KEY unset): that is how you end up sending four
        -- identical emails the minute sending is restored.
        and not exists (select 1 from email_queue e
                         where e.case_id = c.id and e.email_type = 'docs_request'
                           and e.status in ('queued','sending'))
    ), chase as (
      select id, client_id, email from base
      where sent_count <= 3
        and (last_queued is null or last_queued <= now() - interval '3 days')
    ), ins as (
      insert into email_queue (case_id, client_id, email_type, to_email)
      select id, client_id, 'docs_request', email from chase
      returning 1
    )
    select count(*) into n_doc_chase from ins;

    -- Chase budget spent -> hand it to a human, once, while it stays open.
    with overdue as (
      select c.id, c.assigned_to,
             btrim(cl.first_name || ' ' || cl.last_name) as client_name
      from cases c join clients cl on cl.id = c.client_id
      where c.stage in ('fact_find','application')
        and exists (select 1 from case_documents d
                     where d.case_id = c.id and d.status = 'requested')
        and (select count(*) from email_queue e
              where e.case_id = c.id and e.email_type = 'docs_request'
                and e.status <> 'cancelled') >= 4
        and not exists (select 1 from case_tasks t
                         where t.case_id = c.id
                           and t.title like 'Documents overdue — %'
                           and t.done_at is null)
    ), ins2 as (
      insert into case_tasks (case_id, title, due_date, assigned_to)
      select id, 'Documents overdue — call ' || client_name, current_date, assigned_to
      from overdue
      returning 1
    )
    select count(*) into n_doc_tasks from ins2;
  end if;

  -- R9-M3: one gentle reminder about seven days after a review request that went
  -- unanswered (no score recorded). It reuses the review_request type rather than
  -- adding an enum value: process-emails v11 sees that the case already has an
  -- earlier review_request row and switches to reminder wording. The "exactly one
  -- prior row" test is therefore also the thing that guarantees a single reminder
  -- and never a third email.
  if get_setting('nps_enabled') = 'on' then
    -- Share the 5-per-run drip with the initial review requests that
    -- queue_automated_emails queued moments ago -- process-emails calls it
    -- immediately before this function, so anything created in the last five
    -- minutes belongs to this run. If runs are closer together than that we
    -- over-count, which only slows the drip; it can never exceed five.
    select count(*) into n_recent_reviews from email_queue
     where email_type = 'review_request' and created_at >= now() - interval '5 minutes';

    if n_recent_reviews < 5 then
      with due as (
        select c.id, c.client_id, cl.email
        from cases c join clients cl on cl.id = c.client_id
        where c.stage = 'completed'
          and c.review_requested_at is not null
          and c.review_requested_at <= now() - interval '7 days'
          and c.nps_score is null
          and cl.email is not null and cl.email <> ''
          and (select count(*) from email_queue e
                where e.case_id = c.id and e.email_type = 'review_request'
                  and e.status <> 'cancelled') = 1
          and not exists (select 1 from email_queue e
                           where e.case_id = c.id and e.email_type = 'review_request'
                             and e.status in ('queued','sending'))
        order by c.review_requested_at
        limit (5 - n_recent_reviews)
      ), ins as (
        insert into email_queue (case_id, client_id, email_type, to_email)
        select id, client_id, 'review_request', email from due
        returning 1
      )
      select count(*) into n_review_reminders from ins;
    end if;
  end if;

  return jsonb_build_object('birthday_queued', n_birthday, 'anniversary_queued', n_anniv,
                            'annual_review_tasks', n_annual,
                            'doc_chases_queued', n_doc_chase,
                            'doc_overdue_tasks', n_doc_tasks,
                            'review_reminders_queued', n_review_reminders);
end $fn$;

do $verify$
declare
  old_d text; new_d text; old_seg text; new_seg text;
  s_tag text := 'if get_setting(''birthday_enabled'')';
  e_tag text := 'select count(*) into n_annual from ins;';
begin
  select d into old_d from _r9_old_comms;
  select pg_get_functiondef(p.oid) into new_d
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'queue_comms_extras';

  old_seg := substr(old_d, strpos(old_d, s_tag), strpos(old_d, e_tag) + length(e_tag) - strpos(old_d, s_tag));
  new_seg := substr(new_d, strpos(new_d, s_tag), strpos(new_d, e_tag) + length(e_tag) - strpos(new_d, s_tag));

  if length(old_seg) < 2000 or md5(old_seg) <> md5(new_seg) then
    raise exception 'R9-M3 aborted: pre-existing body drifted (old md5 %, len %; new md5 %, len %)',
      md5(old_seg), length(old_seg), md5(new_seg), length(new_seg);
  end if;
  raise notice 'R9-M3 preserved-segment md5 % (% bytes) verified identical', md5(new_seg), length(new_seg);
end $verify$;

revoke all on function public.queue_comms_extras() from public;
grant execute on function public.queue_comms_extras() to postgres, service_role;
