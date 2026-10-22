-- 20260726160732_restrict_sensitive_settings_reads — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- The Settings screen tells advisers that bank details are "Owner-only".
-- Until now that was true of the SCREEN but not of the DATA: any staff
-- session could read them — and `cron_key`, a live secret — straight out
-- of the settings table. Make the claim true.
--
-- Same key pattern the audit masker uses, so what is hidden and what is
-- masked can never drift apart.

drop policy if exists "settings read staff" on public.settings;
create policy "settings read staff" on public.settings for select using (
  is_staff()
  and (
    is_owner()
    or key !~* '(bank|account|sort_code|secret|token|api|key|password)'
  )
);

-- The app gates the "Email fee request" action on the bank details being
-- filled in. A non-Owner can no longer read them, so expose the single
-- bit they legitimately need — whether they are set — and nothing else.
-- The email body itself is composed server-side by the edge function,
-- which uses the service role, so no client ever needs the values.
create or replace function public.has_bank_details()
returns boolean language sql stable security definer set search_path to 'public' as
$$ select coalesce(
     (select value from settings where key = 'bank_account_name'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_sort_code'), '') <> ''
   and coalesce(
     (select value from settings where key = 'bank_account_number'), '') <> '' $$;

revoke all on function public.has_bank_details() from anon, public;
grant execute on function public.has_bank_details() to authenticated;
