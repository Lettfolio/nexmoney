-- =============================================================================
-- R97 · S · 01 · stale email queue — ONE-OFF, Daniel pastes it in the SQL editor. NOT a migration.
--
-- WHY: email_hold has been on since August, so 108 queued rows (3 Nov) are more than 7 days past their
--   scheduled_for (oldest 23 Aug). process-emails sends the oldest-due rows first, so releasing the hold
--   as-is would send ~2 months of stale automation (anniversaries, review asks) in one run.
--   N = 7 days (Daniel, 3 Nov 2026) — the same cut-off process-emails v23 applies at send time (R97 · E-3).
-- HOW: run §A and read it. Then run §B (one statement, prints the count). §C is for the release day:
--   run it just before switching email_hold off (today it matches 0 rows).
-- SAFE: touches only status='queued' rows; status → 'cancelled' with a reason in `error`. Nothing is
--   deleted; a cancelled row can be re-queued from Operations › Emails. The R97 email_queue guard
--   allows cancel for any signed-in Owner session, and the SQL editor runs without a JWT anyway.
-- =============================================================================

-- ---------- §A · PREVIEW (read-only) -------------------------------------------------------------
select email_type, count(*) as rows, min(scheduled_for) as oldest
  from public.email_queue
 where status = 'queued' and scheduled_for < now() - interval '7 days'
 group by 1 order by 2 desc;

select count(*) as total_stale
  from public.email_queue
 where status = 'queued' and scheduled_for < now() - interval '7 days';

-- ---------- §B · CANCEL rows more than 7 days late (run after reading §A) -----------------------
with c as (
  update public.email_queue
     set status = 'cancelled',
         error  = 'R97 stale: scheduled_for older than 7 days while email_hold was on'
   where status = 'queued' and scheduled_for < now() - interval '7 days'
  returning 1
)
select count(*) as cancelled_stale from c;

-- ---------- §C · CARE-FLAG SWEEP (release day; mirrors process-emails v23 · E-2) ----------------
-- suppress_automation or comms_optout → every type except a hand-written 'custom' email;
-- marketing_opt_out → the four marketing types (the list in process-emails MARKETING_TYPES).
-- Preview first:
select q.email_type, count(*) as rows
  from public.email_queue q
  join public.clients cl on cl.id = q.client_id
 where q.status = 'queued'
   and ( ((cl.suppress_automation or cl.comms_optout) and q.email_type <> 'custom')
      or (cl.marketing_opt_out and q.email_type in ('birthday_greeting','completion_anniversary','referral_request','review_request')) )
 group by 1 order by 2 desc;
-- Then cancel:
with c as (
  update public.email_queue q
     set status = 'cancelled',
         error  = 'R97 sweep: client suppressed / opted out before release'
    from public.clients cl
   where cl.id = q.client_id
     and q.status = 'queued'
     and ( ((cl.suppress_automation or cl.comms_optout) and q.email_type <> 'custom')
        or (cl.marketing_opt_out and q.email_type in ('birthday_greeting','completion_anniversary','referral_request','review_request')) )
  returning 1
)
select count(*) as cancelled_care from c;

-- VERIFY
--   select count(*) from public.email_queue where status = 'queued' and scheduled_for < now() - interval '7 days';  -- 0
--   select status, count(*) from public.email_queue group by 1;   -- queued drops by §B's count; cancelled rises by it
