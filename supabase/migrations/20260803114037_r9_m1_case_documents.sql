-- 20260803114037_r9_m1_case_documents — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R9-M1: per-case document checklist, plus the case-level columns that support
-- "who is blocking" reporting and the tokenised client upload link.
create table public.case_documents (
  id           uuid primary key default gen_random_uuid(),
  case_id      uuid not null references public.cases(id) on delete cascade,
  item         text not null,
  status       text not null default 'requested'
                 check (status in ('requested','received','waived')),
  requested_at timestamptz default now(),
  received_at  timestamptz,
  note         text,
  storage_path text,
  created_at   timestamptz default now()
);

create index case_documents_case_id_idx on public.case_documents (case_id);
-- The nightly chase and the upload page both ask "what is still outstanding on
-- this case", so the partial index carries the status too.
create index case_documents_outstanding_idx on public.case_documents (case_id) where status = 'requested';

alter table public.case_documents enable row level security;

-- Operational table: staff read/write, destructive delete reserved for admin/owner,
-- mirroring the split used on public.cases.
create policy "case_documents read staff"   on public.case_documents for select to authenticated using (is_staff());
create policy "case_documents insert staff" on public.case_documents for insert to authenticated with check (is_staff());
create policy "case_documents update staff" on public.case_documents for update to authenticated using (is_staff()) with check (is_staff());
create policy "case_documents delete admin" on public.case_documents for delete to authenticated using (is_admin_or_owner());

create trigger audit_case_documents
  after insert or delete or update on public.case_documents
  for each row execute function audit_row();

-- Case-level additions.
--   waiting_on      — free text: who the case is currently blocked on.
--   solicitor_firm  — enables average-days-by-solicitor reporting.
--   doc_token       — per-case secret for the public upload link. Typed uuid to
--                     match the two token mechanics already in production
--                     (fact_finds.token, cases.nps_token); both public edge
--                     functions validate tokens with a uuid regex.
alter table public.cases
  add column waiting_on     text,
  add column solicitor_firm text,
  add column doc_token      uuid;

-- Token lookup is the authentication step for doc-upload: it must be indexed and
-- must never be ambiguous.
create unique index cases_doc_token_key on public.cases (doc_token) where doc_token is not null;
