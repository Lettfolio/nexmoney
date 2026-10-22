-- 20260827002300_r65_watchtower_clash_rules — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R65 · M10: two new Watchtower rules (offer expiry vs expected completion; completing inside the
-- old rate's ERC on a retention successor) and rule 5 (client email unanswered) aggregated per
-- client. Edited in place on the live definition so nothing else in the body moves; the mock's
-- watchtowerRules() mirrors these predicates and text formats exactly (tests/r65_watchtower.js).
do $$
declare d text; rule5_old text; rule5_new text; tail_marker text; new_rules text;
begin
  d := pg_get_functiondef('public.run_watchtower'::regproc);

  rule5_old := $x$  -- Rule 5: client email unanswered 24h+
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(e.from_name,''), e.from_email),
    coalesce(e.subject,'(no subject)') || ' · received ' || to_char(e.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    e.case_id, e.client_id, 'email_unanswered:'||e.id, clock_timestamp()
  from case_emails e
  where e.triage_status = 'new' and e.received_at < now() - interval '24 hours'
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;
$x$;
  if position(rule5_old in d) = 0 then
    raise exception 'run_watchtower: rule 5 block not found verbatim — body has changed, re-read before migrating';
  end if;

  rule5_new := $x$  -- Rule 5 (R65): client email unanswered 24h+ — ONE alert per CLIENT, not per message.
  -- Three emails from one client used to be three rows; now one row counts them and names the
  -- latest. Emails with no client_id keep the old per-email key so they still surface.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(l.from_name,''), l.from_email, '(unknown sender)'),
    g.n || case when g.n = 1 then ' message' else ' messages' end || ' waiting · latest "'
      || coalesce(l.subject,'(no subject)') || '" received '
      || to_char(l.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    l.case_id, g.client_id, 'email_unanswered:c:'||g.client_id, clock_timestamp()
  from (select client_id, count(*) n, max(received_at) latest
        from case_emails
        where triage_status = 'new' and received_at < now() - interval '24 hours' and client_id is not null
        group by client_id) g
  join lateral (select * from case_emails e
                where e.client_id = g.client_id and e.triage_status = 'new'
                  and e.received_at < now() - interval '24 hours'
                order by e.received_at desc limit 1) l on true
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'email_unanswered','warn',
    'Client email unanswered: ' || coalesce(nullif(e.from_name,''), e.from_email, '(unknown sender)'),
    '1 message waiting · latest "' || coalesce(e.subject,'(no subject)') || '" received '
      || to_char(e.received_at at time zone 'Europe/London','DD Mon HH24:MI'),
    e.case_id, null, 'email_unanswered:'||e.id, clock_timestamp()
  from case_emails e
  where e.triage_status = 'new' and e.received_at < now() - interval '24 hours' and e.client_id is null
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;
$x$;
  d := replace(d, rule5_old, rule5_new);

  tail_marker := $x$  -- Auto-resolve anything no longer flagged this run$x$;
  if position(tail_marker in d) = 0 then
    raise exception 'run_watchtower: auto-resolve marker not found';
  end if;

  new_rules := $x$  -- Rule 11 (R65): the offer runs out before the date the client was told they would complete.
  -- The single most avoidable re-application in the business; both dates are already on the case.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'offer_before_completion',
    case when (c.offer_expiry_date - current_date) <= 30 then 'crit' else 'warn' end,
    'Offer expires before completion: ' || btrim(cl.first_name||' '||cl.last_name),
    'Offer expires ' || to_char(c.offer_expiry_date,'DD Mon YYYY')
      || ' · completion expected ' || to_char(c.expected_completion_date,'DD Mon YYYY')
      || ' — ' || (c.expected_completion_date - c.offer_expiry_date)
      || case when (c.expected_completion_date - c.offer_expiry_date) = 1 then ' day' else ' days' end || ' short',
    c.id, c.client_id, 'offer_before_completion:'||c.id, clock_timestamp()
  from cases c join clients cl on cl.id = c.client_id
  where c.stage in ('offer','exchange')
    and c.offer_expiry_date is not null and c.expected_completion_date is not null
    and c.offer_expiry_date < c.expected_completion_date
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

  -- Rule 12 (R65): a retention successor completing while the OLD rate's ERC still runs — the
  -- client pays the charge nobody budgeted for. The source case carries the ERC date.
  insert into watch_alerts (rule, severity, title, detail, case_id, client_id, dedupe_key, last_seen_at)
  select 'erc_before_completion','warn',
    'Completing inside the old rate''s ERC: ' || btrim(cl.first_name||' '||cl.last_name),
    'Old rate''s ERC runs until ' || to_char(s.erc_end_date,'DD Mon YYYY')
      || ' · completion expected ' || to_char(c.expected_completion_date,'DD Mon YYYY')
      || ' — ' || (s.erc_end_date - c.expected_completion_date)
      || case when (s.erc_end_date - c.expected_completion_date) = 1 then ' day' else ' days' end || ' early',
    c.id, c.client_id, 'erc_before_completion:'||c.id, clock_timestamp()
  from cases c
  join cases s on s.id = c.retention_source_case_id
  join clients cl on cl.id = c.client_id
  where c.stage not in ('completed','not_proceeding')
    and c.expected_completion_date is not null
    and s.erc_end_date is not null
    and c.expected_completion_date < s.erc_end_date
  on conflict (dedupe_key) do update
    set severity = excluded.severity, title = excluded.title, detail = excluded.detail,
        last_seen_at = excluded.last_seen_at, resolved_at = null;

$x$;
  d := replace(d, tail_marker, new_rules || tail_marker);
  execute d;
end $$;
