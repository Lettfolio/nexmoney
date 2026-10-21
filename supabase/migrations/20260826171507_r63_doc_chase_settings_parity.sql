-- 20260826171507_r63_doc_chase_settings_parity — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R63 · C1/C4 parity: (1) the document chaser reads the two settings the admin UI has always shown
-- for it (doc_chase_enabled, doc_chase_days) instead of auto_docs_request + a hard-coded 3 days;
-- (2) every stage-comms / chase gate accepts BOTH spellings the app writes ('on' seeded, '1' from the
-- Settings form's bool10 selects) so saving the Settings page can no longer silently switch the
-- stage emails off. Done by editing the live definitions in place so nothing else in either body moves.
do $$
declare
  d text;
begin
  -- auto_stage_comms: accept '1' as well as 'on' on the four email gates
  d := pg_get_functiondef('public.auto_stage_comms'::regproc);
  d := replace(d, $x$get_setting('auto_docs_request') = 'on'$x$,     $x$get_setting('auto_docs_request') in ('on','1')$x$);
  d := replace(d, $x$get_setting('auto_submitted_update') = 'on'$x$, $x$get_setting('auto_submitted_update') in ('on','1')$x$);
  d := replace(d, $x$get_setting('auto_offer_update') = 'on'$x$,     $x$get_setting('auto_offer_update') in ('on','1')$x$);
  d := replace(d, $x$get_setting('auto_completion_email') = 'on'$x$, $x$get_setting('auto_completion_email') in ('on','1')$x$);
  execute d;

  -- queue_comms_extras: the chase block is gated on doc_chase_enabled and paced by doc_chase_days
  d := pg_get_functiondef('public.queue_comms_extras'::regproc);
  if position($x$if get_setting('auto_docs_request') = 'on' then$x$ in d) = 0 then
    raise exception 'queue_comms_extras: chase gate not found — body has changed, migration needs re-reading';
  end if;
  d := replace(d,
    $x$        n_review_reminders int := 0; n_recent_reviews int := 0;$x$,
    $x$        n_review_reminders int := 0; n_recent_reviews int := 0;
        -- R63: the chase interval is the Settings "Document chase interval" (doc_chase_days), default 3.
        chase_days int := case when coalesce(get_setting('doc_chase_days'),'') ~ '^[0-9]+$'
                               and get_setting('doc_chase_days')::int > 0
                               then get_setting('doc_chase_days')::int else 3 end;$x$);
  d := replace(d,
    $x$if get_setting('auto_docs_request') = 'on' then$x$,
    $x$if get_setting('doc_chase_enabled') in ('on','1') then  -- R63: chasing is its own switch (Settings > Documents), not the first-request switch$x$);
  d := replace(d,
    $x$last_queued <= now() - interval '3 days'$x$,
    $x$last_queued <= now() - (chase_days || ' days')::interval$x$);
  execute d;
end $$;

-- The two Settings rows the UI has always rendered, made explicit (no-op if already present).
insert into settings (key, value) values ('doc_chase_enabled', 'off') on conflict (key) do nothing;
insert into settings (key, value) values ('doc_chase_days', '3') on conflict (key) do nothing;
-- R63 · H1: the stage-playbook auto-task switch (app-side; absent means on). Seeded so it is visible.
insert into settings (key, value) values ('playbook_auto_tasks', 'on') on conflict (key) do nothing;
