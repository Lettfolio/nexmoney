-- 20260807090122_r13_m1_prelaunch_columns_tables — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R13 (pre-launch operations round, from the broker-panel consultant audit)

-- 1. Consumer Duty: vulnerability + automation suppression (M-4, M-30).
--    is_vulnerable marks the client; vulnerability_note holds the why (free text,
--    staff-authored); suppress_automation stops EVERY automated client email —
--    a vulnerable client can still be automated if appropriate, and a
--    non-vulnerable one can be suppressed (deceased, complaint, do-not-contact),
--    so they are deliberately two independent flags.
alter table clients
  add column if not exists is_vulnerable boolean not null default false,
  add column if not exists vulnerability_note text,
  add column if not exists suppress_automation boolean not null default false;

-- 2. Clawback minimal (M-23) + forward-planning dates (M-11, M-13, M-10).
alter table cases
  add column if not exists policy_start_date date,
  add column if not exists exchange_date date,
  add column if not exists offer_issued_date date,
  add column if not exists repayment_method text;

-- 3. Holidays / out-of-office (M-31). Advisers manage their own; admin/owner
--    manage anyone's. Read by lead routing and the diary.
create table if not exists staff_absences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint absence_dates_sane check (ends_on >= starts_on)
);
alter table staff_absences enable row level security;
create policy "staff read absences" on staff_absences for select using (is_staff());
create policy "own or admin insert absences" on staff_absences for insert
  with check (is_staff() and (profile_id = auth.uid() or is_admin_or_owner()));
create policy "own or admin update absences" on staff_absences for update
  using (is_staff() and (profile_id = auth.uid() or is_admin_or_owner()))
  with check (is_staff() and (profile_id = auth.uid() or is_admin_or_owner()));
create policy "own or admin delete absences" on staff_absences for delete
  using (is_staff() and (profile_id = auth.uid() or is_admin_or_owner()));
create trigger staff_absences_audit
  after insert or update or delete on staff_absences
  for each row execute function audit_row();

-- 4. Generic case file slot (M-2): outbound/advice documents — ESIS, research
--    evidence, signed client agreement, suitability letters — one attachment
--    surface instead of four missing ones. Files live in the existing private
--    client-docs bucket under files/<case_id>/; storage_path carries the
--    bucket prefix, matching what doc-upload writes for checklist uploads.
create table if not exists case_files (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  client_id uuid,
  name text not null,
  kind text,
  storage_path text not null,
  uploaded_by uuid,
  created_at timestamptz not null default now()
);
alter table case_files enable row level security;
create policy "staff all case_files" on case_files for all
  using (is_staff()) with check (is_staff());
create trigger case_files_audit
  after insert or update or delete on case_files
  for each row execute function audit_row();

-- 5. Firm export bookkeeping (M-42): the Owner's full-export button stamps this
--    so the app can nag when the last firm-controlled backup is stale.
insert into settings (key, value) values ('last_full_export_at', '')
  on conflict (key) do nothing;
