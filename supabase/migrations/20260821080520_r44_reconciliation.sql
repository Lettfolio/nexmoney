-- 20260821080520_r44_reconciliation — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R44 — Stonebridge payment reconciliation. Three owner-only tables:
-- proc_rates: the lender/product procuration percentages (replaced wholesale each upload, every
--   couple of months). commission_statements/commission_lines: the weekly commission statement
--   (received Wednesdays, paid Thursdays) and its rows, kept line-by-line so matches, takebacks
--   and history survive. All owner-only by Daniel's explicit choice — advisers see only the
--   normal fee statuses that confirming a match writes onto cases.
create table public.proc_rates (
  id bigint generated always as identity primary key,
  lender text not null,
  product text not null default '',
  lg_code text not null default '',
  rate numeric not null check (rate >= 0 and rate <= 1),
  notes text not null default '',
  effective_label text not null default '',
  uploaded_at timestamptz not null default now()
);
create table public.commission_statements (
  id bigint generated always as identity primary key,
  ref text not null default '',
  statement_label text not null default '',
  statement_date date,
  filename text not null default '',
  gross_total numeric,
  net_total numeric,
  line_count integer,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid()
);
-- the same statement re-uploaded twice is a reconciliation error, not a second week of income
create unique index commission_statements_ref_key on public.commission_statements (ref) where ref <> '';
create table public.commission_lines (
  id bigint generated always as identity primary key,
  statement_id bigint not null references public.commission_statements(id) on delete cascade,
  line_date timestamptz,
  tran_type text not null default '',
  addressee text not null default '',
  provider text not null default '',
  account_number text not null default '',
  opp_id text not null default '',
  reason text not null default '',
  policy_type text not null default '',
  policy_group text not null default '',
  adviser_name text not null default '',
  premium numeric,
  banked_gross numeric,
  banked_net numeric,
  matched_case_id uuid references public.cases(id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','suggested','confirmed','dismissed','na')),
  match_note text not null default '',
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index commission_lines_statement_idx on public.commission_lines (statement_id);
create index commission_lines_case_idx on public.commission_lines (matched_case_id);
create index commission_lines_account_idx on public.commission_lines (account_number);

alter table public.proc_rates enable row level security;
alter table public.commission_statements enable row level security;
alter table public.commission_lines enable row level security;
create policy proc_rates_owner on public.proc_rates for all to authenticated
  using (is_owner()) with check (is_owner());
create policy commission_statements_owner on public.commission_statements for all to authenticated
  using (is_owner()) with check (is_owner());
create policy commission_lines_owner on public.commission_lines for all to authenticated
  using (is_owner()) with check (is_owner());
grant select, insert, update, delete on public.proc_rates to authenticated;
grant select, insert, update, delete on public.commission_statements to authenticated;
grant select, insert, update, delete on public.commission_lines to authenticated;
