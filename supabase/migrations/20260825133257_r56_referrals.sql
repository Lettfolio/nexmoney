-- 20260825133257_r56_referrals — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R56: outbound referrals (survey / conveyancing) recorded per case — the Revolution-style
-- revenue-referral actions. Append-oriented: staff create and update status, only admin/owner
-- can delete. Helper calls wrapped as init-plans per the R55 convention.
create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cases(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  kind text not null check (kind in ('survey','conveyancing','other')),
  referred_to text,
  status text not null default 'made' check (status in ('made','completed','declined')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_referrals_case_id on public.referrals (case_id);
create index if not exists idx_referrals_client_id on public.referrals (client_id);
create index if not exists idx_referrals_created_by on public.referrals (created_by);
alter table public.referrals enable row level security;
create policy "referrals read staff" on public.referrals for select using ((select is_staff()));
create policy "referrals insert staff" on public.referrals for insert with check ((select is_staff()));
create policy "referrals update staff" on public.referrals for update using ((select is_staff())) with check ((select is_staff()));
create policy "referrals delete admin" on public.referrals for delete using ((select is_admin_or_owner()));
