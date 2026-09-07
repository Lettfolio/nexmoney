-- R84 · S2-5 (P2) — RLS helper calls as initplans
--
-- WHAT: most policies call is_staff() / is_owner() / is_admin_or_owner() / my_introducer_id()
-- bare. Postgres then evaluates the (STABLE, SECURITY DEFINER, profiles-lookup) function once per
-- candidate row. Wrapping as `(select fn())` makes it an InitPlan evaluated once per statement.
-- audit_log (9.3k rows, +~30/day) was the worst case: a CASE over is_owner()/is_staff() per row.
--
-- FIX: every policy below is dropped and re-created with IDENTICAL semantics, roles and command,
-- only the helper calls are wrapped. Policies already in initplan form (cases/clients/profiles
-- SELECT, profiles UPDATE, referrals, staff_absences write policies, saved_views, vault read) are
-- untouched. cases/clients SELECT are rewritten in 10_introducer_views.sql; vault UPDATE in 11_.
--
-- POLICIES REWRITTEN (46):
--   appointments."staff all"                          assistant_actions."assistant_actions_staff"
--   audit_log."audit read"                            case_documents."case_documents delete admin"
--   case_documents."case_documents insert staff"      case_documents."case_documents read staff"
--   case_documents."case_documents update staff"      case_emails."case_emails_staff"
--   case_events."staff read"                          case_files."staff all case_files"
--   case_notes."staff all"                            case_tasks."staff all"
--   cases."cases delete admin"                        cases."cases insert staff"
--   cases."cases update staff"                        clients."clients delete admin"
--   clients."clients insert staff"                    clients."clients update staff"
--   commission_lines."commission_lines_owner"         commission_statements."commission_statements_owner"
--   duplicate_dismissals."dup dismiss delete admin"   duplicate_dismissals."dup dismiss insert staff"
--   duplicate_dismissals."dup dismiss read staff"     email_queue."staff all"
--   error_events."error events delete admin"          error_events."error events insert staff"
--   error_events."error events read admin"            fact_finds."fact_finds_staff"
--   introducers."introducers_delete"                  introducers."introducers_insert"
--   introducers."introducers_select"                  introducers."introducers_update"
--   leads."staff all"                                 proc_rates."proc_rates_owner"
--   profiles."profiles del owner"                     profiles."profiles write owner"
--   settings."settings del owner"                     settings."settings write owner"
--   settings."settings read staff"                    settings."settings edit owner"
--   sms_queue."sms_queue_staff"                       staff_absences."staff read absences"
--   sync_state."sync_state_staff_read"                vault_entries."admin delete vault"
--   vault_entries."staff insert vault"                watch_alerts."watch_alerts_staff"
--
-- EXPECTED EFFECT: no behaviour change; fewer profiles lookups per statement.
--
-- VERIFY (after apply):
--   select tablename, policyname from pg_policies where schemaname='public'
--     and (coalesce(qual,'')||coalesce(with_check,'')) ~ '(^|[^ (])(is_staff|is_owner|is_admin_or_owner|my_introducer_id|my_role)\(\)'
--     and (coalesce(qual,'')||coalesce(with_check,'')) !~ 'SELECT (is_staff|is_owner|is_admin_or_owner|my_introducer_id|my_role)\(\)';
--     -- expect 0 rows (every helper call is inside a SELECT)
--   select count(*) from pg_policies where schemaname='public';   -- 63 (unchanged count; live count verified 2026-09-07)
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

-- ---------- appointments
drop policy if exists "staff all" on public.appointments;
create policy "staff all" on public.appointments for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- assistant_actions
drop policy if exists "assistant_actions_staff" on public.assistant_actions;
create policy "assistant_actions_staff" on public.assistant_actions for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- audit_log
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select to public
  using (case when table_name = any (array['settings'::text,'profiles'::text])
              then (select public.is_owner())
              else (select public.is_staff()) end);

-- ---------- case_documents
drop policy if exists "case_documents delete admin" on public.case_documents;
create policy "case_documents delete admin" on public.case_documents for delete to authenticated
  using ((select public.is_admin_or_owner()));
drop policy if exists "case_documents insert staff" on public.case_documents;
create policy "case_documents insert staff" on public.case_documents for insert to authenticated
  with check ((select public.is_staff()));
drop policy if exists "case_documents read staff" on public.case_documents;
create policy "case_documents read staff" on public.case_documents for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "case_documents update staff" on public.case_documents;
create policy "case_documents update staff" on public.case_documents for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- case_emails
drop policy if exists "case_emails_staff" on public.case_emails;
create policy "case_emails_staff" on public.case_emails for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- case_events
drop policy if exists "staff read" on public.case_events;
create policy "staff read" on public.case_events for select to authenticated
  using ((select public.is_staff()));

-- ---------- case_files
drop policy if exists "staff all case_files" on public.case_files;
create policy "staff all case_files" on public.case_files for all to public
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- case_notes
drop policy if exists "staff all" on public.case_notes;
create policy "staff all" on public.case_notes for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- case_tasks
drop policy if exists "staff all" on public.case_tasks;
create policy "staff all" on public.case_tasks for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- cases (SELECT is in 10_introducer_views.sql)
drop policy if exists "cases delete admin" on public.cases;
create policy "cases delete admin" on public.cases for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "cases insert staff" on public.cases;
create policy "cases insert staff" on public.cases for insert to public
  with check ((select public.is_staff()));
drop policy if exists "cases update staff" on public.cases;
create policy "cases update staff" on public.cases for update to public
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- clients (SELECT is in 10_introducer_views.sql)
drop policy if exists "clients delete admin" on public.clients;
create policy "clients delete admin" on public.clients for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "clients insert staff" on public.clients;
create policy "clients insert staff" on public.clients for insert to public
  with check ((select public.is_staff()));
drop policy if exists "clients update staff" on public.clients;
create policy "clients update staff" on public.clients for update to public
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- commission_lines / commission_statements
drop policy if exists "commission_lines_owner" on public.commission_lines;
create policy "commission_lines_owner" on public.commission_lines for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists "commission_statements_owner" on public.commission_statements;
create policy "commission_statements_owner" on public.commission_statements for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ---------- duplicate_dismissals
drop policy if exists "dup dismiss delete admin" on public.duplicate_dismissals;
create policy "dup dismiss delete admin" on public.duplicate_dismissals for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "dup dismiss insert staff" on public.duplicate_dismissals;
create policy "dup dismiss insert staff" on public.duplicate_dismissals for insert to public
  with check ((select public.is_staff()));
drop policy if exists "dup dismiss read staff" on public.duplicate_dismissals;
create policy "dup dismiss read staff" on public.duplicate_dismissals for select to public
  using ((select public.is_staff()));

-- ---------- email_queue
drop policy if exists "staff all" on public.email_queue;
create policy "staff all" on public.email_queue for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- error_events
drop policy if exists "error events delete admin" on public.error_events;
create policy "error events delete admin" on public.error_events for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "error events insert staff" on public.error_events;
create policy "error events insert staff" on public.error_events for insert to public
  with check ((select public.is_staff()));
drop policy if exists "error events read admin" on public.error_events;
create policy "error events read admin" on public.error_events for select to public
  using ((select public.is_admin_or_owner()));

-- ---------- fact_finds
drop policy if exists "fact_finds_staff" on public.fact_finds;
create policy "fact_finds_staff" on public.fact_finds for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- introducers (introducer may still read its OWN introducer row — portal title)
drop policy if exists "introducers_delete" on public.introducers;
create policy "introducers_delete" on public.introducers for delete to authenticated
  using ((select public.is_staff()));
drop policy if exists "introducers_insert" on public.introducers;
create policy "introducers_insert" on public.introducers for insert to authenticated
  with check ((select public.is_staff()));
drop policy if exists "introducers_select" on public.introducers;
create policy "introducers_select" on public.introducers for select to authenticated
  using ((select public.is_staff()) or (id = (select public.my_introducer_id())));
drop policy if exists "introducers_update" on public.introducers;
create policy "introducers_update" on public.introducers for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- leads
drop policy if exists "staff all" on public.leads;
create policy "staff all" on public.leads for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- proc_rates
drop policy if exists "proc_rates_owner" on public.proc_rates;
create policy "proc_rates_owner" on public.proc_rates for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ---------- profiles (read / update already initplan-form)
drop policy if exists "profiles del owner" on public.profiles;
create policy "profiles del owner" on public.profiles for delete to public
  using ((select public.is_owner()));
drop policy if exists "profiles write owner" on public.profiles;
create policy "profiles write owner" on public.profiles for insert to public
  with check ((select public.is_owner()));

-- ---------- settings
drop policy if exists "settings del owner" on public.settings;
create policy "settings del owner" on public.settings for delete to public
  using ((select public.is_owner()));
drop policy if exists "settings write owner" on public.settings;
create policy "settings write owner" on public.settings for insert to public
  with check ((select public.is_owner()));
drop policy if exists "settings read staff" on public.settings;
create policy "settings read staff" on public.settings for select to public
  using ((select public.is_staff())
         and ((select public.is_owner())
              or key !~* '(bank|account|sort_code|secret|token|api|key|password)'::text));
drop policy if exists "settings edit owner" on public.settings;
create policy "settings edit owner" on public.settings for update to public
  using ((select public.is_owner())) with check ((select public.is_owner()));

-- ---------- sms_queue
drop policy if exists "sms_queue_staff" on public.sms_queue;
create policy "sms_queue_staff" on public.sms_queue for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));

-- ---------- staff_absences (write policies already initplan-form)
drop policy if exists "staff read absences" on public.staff_absences;
create policy "staff read absences" on public.staff_absences for select to public
  using ((select public.is_staff()));

-- ---------- sync_state
drop policy if exists "sync_state_staff_read" on public.sync_state;
create policy "sync_state_staff_read" on public.sync_state for select to authenticated
  using ((select public.is_staff()));

-- ---------- vault_entries (read already initplan-form; update in 11_)
drop policy if exists "admin delete vault" on public.vault_entries;
create policy "admin delete vault" on public.vault_entries for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "staff insert vault" on public.vault_entries;
create policy "staff insert vault" on public.vault_entries for insert to public
  with check ((select public.is_staff()));

-- ---------- watch_alerts
drop policy if exists "watch_alerts_staff" on public.watch_alerts;
create policy "watch_alerts_staff" on public.watch_alerts for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
