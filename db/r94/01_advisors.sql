-- =============================================================================
-- R94 · 01 · advisors — what the Supabase advisor flags, closed where it is safe, explained where not
--
-- EVIDENCE (read-only queries against the live project, 2026-10-21):
--   advisors (security): ERROR security_definer_view ×2 (v_introducer_cases/_clients) · WARN
--     extension_in_public (pg_net) · WARN authenticated_security_definer_function_executable ×20 ·
--     INFO rls_enabled_no_policy ×5 (ai_usage + the four backups). (performance): unused_index ×19,
--     no_primary_key ×4 (the backups), unindexed_foreign_keys ×4 (R93 site_* tables).
--   anon can EXECUTE no SECURITY DEFINER function in public (has_function_privilege sweep: none).
--
-- WHAT THIS FILE DOES (sections A–F; only A, B, E change anything):
--   A  introducer views: KEPT owner-rights (security_invoker stays false) + security_barrier on.
--   B  drops Daniel's four backup tables (row counts below).
--   C  pg_net stays in public — finding + Supabase's path, comment only. NO drop/recreate.
--   D  gates: run_watchtower / reassign_holdings / find_duplicate_clients already carry the R86
--      guard — an ASSERTION (read-only) fails the file if that ever regresses. No function rewrite.
--   E  cron_key → Supabase Vault: the four net.http_post cron jobs read the key from Vault at run
--      time; no-op if supabase_vault is missing. settings.cron_key is KEPT (see E).
--   F  the 19 "unused" indexes — commented DROPs only; Daniel's call.
-- IDEMPOTENT: if exists / if not exists / re-asserting alters; E re-writes the jobs to the same text.
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY: queries at the end of the file.
-- =============================================================================
begin;

-- ---------- A · v_introducer_cases / v_introducer_clients ----------------------------------
-- Live: reloptions {security_invoker=false}, owner postgres, SELECT granted to authenticated only
-- (anon none). Bodies filter on introducer_id = (select my_introducer_id()), which is NULL for any
-- profile whose role is not 'introducer' → staff and strangers get 0 rows.
-- WHY NOT security_invoker = true: the base-table SELECT policies are staff-only since R84
--   ("cases read staff" / "clients read staff" = (select is_staff())) and NO policy mentions
--   introducers any more. An invoker view would run those policies as the introducer and return
--   ZERO rows — introducer.html would go blank. Re-adding an introducer branch to the table
--   policies would hand back the whole row (doc_token, DOB, notes) that R84 removed. So the
--   advisor ERROR stays, deliberately: the view IS the column whitelist.
-- NARROWEST HARDENING NOW: security_barrier = true — the scope predicate is evaluated before any
--   caller-supplied predicate, so no leaky function can see rows outside the caller's introducer.
--   Same rows, same columns; no visible change.
-- R95 CANDIDATE (closes the ERROR): replace both views with SECURITY DEFINER RPCs
--   get_introducer_cases() / get_introducer_clients() (same body + `if my_introducer_id() is null
--   then return; end if;`), switch introducer.html to .rpc(), then revoke select on the views
--   from authenticated and drop them. Needs an introducer.html change, so not this round.
alter view public.v_introducer_cases   set (security_invoker = false, security_barrier = true);
alter view public.v_introducer_clients set (security_invoker = false, security_barrier = true);
revoke all on public.v_introducer_cases   from anon, public;
revoke all on public.v_introducer_clients from anon, public;

-- ---------- B · Daniel's housekeeping: the four backup tables --------------------------------
-- Rows on 2026-10-21: backup_case_notes_pre_sb1 302 · backup_cases_pre_sb1 301 ·
-- backup_clients_pre_sb1 326 · backup_r70_retention_link 54. RLS on, no policy, no PK — read by
-- nothing in admin/ or edge/. No CASCADE: if anything depends on one, the drop fails loudly.
drop table if exists public.backup_case_notes_pre_sb1;
drop table if exists public.backup_cases_pre_sb1;
drop table if exists public.backup_clients_pre_sb1;
drop table if exists public.backup_r70_retention_link;

-- ---------- C · pg_net in public (comment only) -----------------------------------------------
-- Live: pg_net 0.20.3, extnamespace = public, extrelocatable = FALSE → `alter extension pg_net
-- set schema extensions` is impossible. Its functions are NOT in public anyway: http_post,
-- http_get, http_delete, http_collect_response, _await_response all live in schema `net`, and
-- every cron job calls net.http_post — the lint is about the extension's registered schema only.
-- Supabase's documented path (troubleshooting "42501 permission denied for table
-- http_request_queue"): with net.http_request_queue empty (it was: 0 rows), DROP the extension
-- and CREATE it again `schema extensions` (two statements, see that page).
-- That removes and recreates the `net` schema — for the minutes between, the four cron jobs fail.
-- NOT DONE HERE. If Daniel wants the WARN gone: run it in a quiet window (not 02:30, 06:15–06:30,
-- 08:00–08:05 UTC), then re-run VERIFY E. Accepting the WARN is also reasonable.

-- ---------- D · gates (assertion only) --------------------------------------------------------
-- Live bodies (pg_proc.prosrc) already guard before any work:
--   find_duplicate_clients — staff role + session_ok() else '[]'
--   run_watchtower         — signed-in caller must be staff + session_ok() else {"error":"forbidden"};
--                            auth.uid() null (cron job 2, `select public.run_watchtower()`) proceeds
--   reassign_holdings      — `if not is_owner() or not session_ok() then raise 42501` — owner-only,
--                            stricter than owner/admin; kept.
-- The 20 "authenticated can execute SECURITY DEFINER" WARNs are by design: each is gated in-body
-- (R86 rule) and none is executable by anon.
do $$
begin
  if (select count(*) from pg_proc
       where pronamespace = 'public'::regnamespace
         and proname in ('run_watchtower','reassign_holdings','find_duplicate_clients')
         and prosrc like '%session_ok()%') <> 3 then
    raise exception 'R94 · D: a gate lost its session_ok() guard — re-apply db/r86/02_rpc_guards.sql first';
  end if;
end
$$;

-- ---------- E · cron_key → Supabase Vault --------------------------------------------------------
-- Live: jobs 1 nexmoney-process-emails, 3 nexmoney-owner-digest, 6 nexmoney-send-sms embed the
-- key as a plaintext literal ('x-cron-key','<cron_key>'); job 7 nexmoney-seo-snapshot reads
-- settings.cron_key at run time (R93); job 2 nexmoney-watchtower is plain SQL (untouched).
-- The literal is also in 285 cron.job_run_details rows and in migration 20260718165010.
-- AFTER THIS: all four http jobs read (select decrypted_secret from vault.decrypted_secrets where
-- name = 'nexmoney_cron_key') at run time. The Bearer (public anon JWT) is copied from each job's
-- own command, so no key literal of any kind is written into the repo.
-- The secret is created FROM settings.cron_key (nothing to paste, no typo can break the 08:00
-- run). The edge functions still compare x-cron-key against settings.cron_key, so that row STAYS
-- and the two must stay equal — the block aborts if they differ. To rotate, see E2 below.
-- (To paste a value instead, replace the select in vault.create_secret with '<PASTE cron_key HERE>'.)
do $$
declare
  j       record;
  bearer  text;
  fn      text;
  tmo     text;
begin
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise notice 'R94 · D: supabase_vault not installed — cron jobs left unchanged';
    return;
  end if;
  if coalesce((select value from public.settings where key = 'cron_key'), '') = '' then
    raise exception 'R94 · D: settings.cron_key is empty — nothing to move';
  end if;

  if not exists (select 1 from vault.secrets where name = 'nexmoney_cron_key') then
    perform vault.create_secret(
      (select value from public.settings where key = 'cron_key'),
      'nexmoney_cron_key',
      'R94: x-cron-key for the nexmoney-* cron jobs. Must equal settings.cron_key while the edge functions read that row.');
  end if;
  if (select decrypted_secret from vault.decrypted_secrets where name = 'nexmoney_cron_key')
     is distinct from (select value from public.settings where key = 'cron_key') then
    raise exception 'R94 · D: vault nexmoney_cron_key differs from settings.cron_key — fix one before rewriting the jobs';
  end if;

  for j in select jobid, jobname, command from cron.job
            where jobname in ('nexmoney-process-emails','nexmoney-owner-digest','nexmoney-send-sms','nexmoney-seo-snapshot')
            order by jobid loop
    bearer := (regexp_match(j.command, 'Bearer ([A-Za-z0-9._-]+)'))[1];
    fn     := (regexp_match(j.command, '/functions/v1/([a-z0-9-]+)'))[1];
    tmo    := (regexp_match(j.command, 'timeout_milliseconds\s*:=\s*([0-9]+)'))[1];
    if bearer is null or fn is null then
      raise exception 'R94 · D: could not parse job % (%) — rewrite it by hand', j.jobid, j.jobname;
    end if;
    perform cron.alter_job(j.jobid, command := format($cmd$
  select net.http_post(
    url := 'https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/%s',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer %s',
      'x-cron-key', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'nexmoney_cron_key'), '')
    ),
    body := '{}'::jsonb%s
  );
$cmd$, fn, bearer, case when tmo is null then '' else format(E',\n    timeout_milliseconds := %s', tmo) end));
  end loop;
end
$$;

-- E1 · AFTER the next 02:30 / 06:30 / 08:00 / 08:05 UTC runs succeed (VERIFY E2), purge the
-- history rows that still carry the old literal (cron's own log, nothing else reads it):
--   delete from cron.job_run_details
--    where command like '%x-cron-key%' and command not like '%vault.decrypted_secrets%'
--      and command not like '%from public.settings where key = ''cron_key''%';
-- E2 · ROTATE (recommended once E1 is done — the old value also sits in schema_migrations):
--   begin;
--   update public.settings set value = encode(extensions.gen_random_bytes(24), 'hex') where key = 'cron_key';
--   select vault.update_secret((select id from vault.secrets where name = 'nexmoney_cron_key'),
--                              (select value from public.settings where key = 'cron_key'));
--   commit;   -- jobs and functions both read at run time: no reschedule, no redeploy.

-- ---------- F · the 19 "unused" indexes — COMMENTED, Daniel's call --------------------------------
-- "Unused" = zero scans since stats reset on a ~300-case book; most exist for scale (R18/R55) or
-- cover a foreign key (dropping those re-raises lint 0001 unindexed_foreign_keys).
-- KEEP: idx_leads_source_ip_created — new-lead's per-IP limiter counts on (source_ip, created_at).
-- drop index if exists public.idx_leads_source_ip_created;        -- KEEP (new-lead rate limiter)
-- drop index if exists public.email_queue_lead_id_idx;            -- FK lead_id
-- drop index if exists public.idx_assistant_actions_staff_id;     -- FK staff_id
-- drop index if exists public.idx_case_tasks_created_by;          -- FK created_by
-- drop index if exists public.idx_cases_protection_quoted_by;     -- FK protection_quoted_by
-- drop index if exists public.idx_duplicate_dismissals_dismissed_by; -- FK dismissed_by
-- drop index if exists public.idx_leads_converted_case_id;        -- FK converted_case_id
-- drop index if exists public.idx_profiles_introducer_id;         -- FK introducer_id (my_introducer_id())
-- drop index if exists public.idx_watch_alerts_case_id;           -- FK case_id
-- drop index if exists public.idx_watch_alerts_lead_id;           -- FK lead_id
-- drop index if exists public.idx_watch_alerts_snoozed_by;        -- FK snoozed_by
-- drop index if exists public.idx_watch_alerts_staff_id;          -- FK staff_id
-- drop index if exists public.vault_entries_category_idx;         -- category filter
-- drop index if exists public.commission_lines_case_idx;          -- commission_lines → cases
-- drop index if exists public.commission_lines_account_idx;       -- commission_lines → account
-- drop index if exists public.commission_lines_attributed_idx;    -- attribution reports (R48)
-- drop index if exists public.idx_referrals_created_by;           -- FK created_by
-- drop index if exists public.idx_referrals_client_id;            -- FK client_id
-- drop index if exists public.idx_staff_absences_profile_id;      -- FK profile_id

commit;

-- =============================================================================
-- VERIFY (after apply)
-- A  select relname, reloptions from pg_class where relname in ('v_introducer_cases','v_introducer_clients');
--      -- both {security_invoker=false,security_barrier=true}
--    select table_name, grantee, privilege_type from information_schema.role_table_grants
--     where table_name like 'v_introducer_%' and grantee in ('anon','authenticated');  -- authenticated SELECT only
-- B  select to_regclass('public.backup_case_notes_pre_sb1'), to_regclass('public.backup_cases_pre_sb1'),
--           to_regclass('public.backup_clients_pre_sb1'), to_regclass('public.backup_r70_retention_link');  -- 4 × null
-- E  select jobid, jobname, command like '%vault.decrypted_secrets%' uses_vault,
--           position((select value from public.settings where key='cron_key') in command) = 0 no_literal
--      from cron.job order by jobid;     -- jobs 1,3,6,7: t,t · job 2: f,t
--    select (select decrypted_secret from vault.decrypted_secrets where name='nexmoney_cron_key')
--         = (select value from public.settings where key='cron_key') as in_sync;   -- t
-- E2 next morning: select j.jobname, d.status, d.start_time from cron.job_run_details d
--      join cron.job j using (jobid) order by d.start_time desc limit 8;          -- succeeded
--    select status_code, count(*) from net._http_response
--     where created > now() - interval '1 day' group by 1;                        -- 200s; no 401
--    and the admin app's stuck-cron banner stays quiet (settings.last_cron_run_at moves).
-- =============================================================================
