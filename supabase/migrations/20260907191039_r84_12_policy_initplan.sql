-- 20260907191039_r84_12_policy_initplan — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

drop policy if exists "staff all" on public.appointments;
create policy "staff all" on public.appointments for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "assistant_actions_staff" on public.assistant_actions;
create policy "assistant_actions_staff" on public.assistant_actions for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "audit read" on public.audit_log;
create policy "audit read" on public.audit_log for select to public
  using (case when table_name = any (array['settings'::text,'profiles'::text])
              then (select public.is_owner())
              else (select public.is_staff()) end);
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
drop policy if exists "case_emails_staff" on public.case_emails;
create policy "case_emails_staff" on public.case_emails for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "staff read" on public.case_events;
create policy "staff read" on public.case_events for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "staff all case_files" on public.case_files;
create policy "staff all case_files" on public.case_files for all to public
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "staff all" on public.case_notes;
create policy "staff all" on public.case_notes for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "staff all" on public.case_tasks;
create policy "staff all" on public.case_tasks for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "cases delete admin" on public.cases;
create policy "cases delete admin" on public.cases for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "cases insert staff" on public.cases;
create policy "cases insert staff" on public.cases for insert to public
  with check ((select public.is_staff()));
drop policy if exists "cases update staff" on public.cases;
create policy "cases update staff" on public.cases for update to public
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "clients delete admin" on public.clients;
create policy "clients delete admin" on public.clients for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "clients insert staff" on public.clients;
create policy "clients insert staff" on public.clients for insert to public
  with check ((select public.is_staff()));
drop policy if exists "clients update staff" on public.clients;
create policy "clients update staff" on public.clients for update to public
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "commission_lines_owner" on public.commission_lines;
create policy "commission_lines_owner" on public.commission_lines for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists "commission_statements_owner" on public.commission_statements;
create policy "commission_statements_owner" on public.commission_statements for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists "dup dismiss delete admin" on public.duplicate_dismissals;
create policy "dup dismiss delete admin" on public.duplicate_dismissals for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "dup dismiss insert staff" on public.duplicate_dismissals;
create policy "dup dismiss insert staff" on public.duplicate_dismissals for insert to public
  with check ((select public.is_staff()));
drop policy if exists "dup dismiss read staff" on public.duplicate_dismissals;
create policy "dup dismiss read staff" on public.duplicate_dismissals for select to public
  using ((select public.is_staff()));
drop policy if exists "staff all" on public.email_queue;
create policy "staff all" on public.email_queue for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "error events delete admin" on public.error_events;
create policy "error events delete admin" on public.error_events for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "error events insert staff" on public.error_events;
create policy "error events insert staff" on public.error_events for insert to public
  with check ((select public.is_staff()));
drop policy if exists "error events read admin" on public.error_events;
create policy "error events read admin" on public.error_events for select to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "fact_finds_staff" on public.fact_finds;
create policy "fact_finds_staff" on public.fact_finds for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
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
drop policy if exists "staff all" on public.leads;
create policy "staff all" on public.leads for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "proc_rates_owner" on public.proc_rates;
create policy "proc_rates_owner" on public.proc_rates for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
drop policy if exists "profiles del owner" on public.profiles;
create policy "profiles del owner" on public.profiles for delete to public
  using ((select public.is_owner()));
drop policy if exists "profiles write owner" on public.profiles;
create policy "profiles write owner" on public.profiles for insert to public
  with check ((select public.is_owner()));
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
drop policy if exists "sms_queue_staff" on public.sms_queue;
create policy "sms_queue_staff" on public.sms_queue for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "staff read absences" on public.staff_absences;
create policy "staff read absences" on public.staff_absences for select to public
  using ((select public.is_staff()));
drop policy if exists "sync_state_staff_read" on public.sync_state;
create policy "sync_state_staff_read" on public.sync_state for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "admin delete vault" on public.vault_entries;
create policy "admin delete vault" on public.vault_entries for delete to public
  using ((select public.is_admin_or_owner()));
drop policy if exists "staff insert vault" on public.vault_entries;
create policy "staff insert vault" on public.vault_entries for insert to public
  with check ((select public.is_staff()));
drop policy if exists "watch_alerts_staff" on public.watch_alerts;
create policy "watch_alerts_staff" on public.watch_alerts for all to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
