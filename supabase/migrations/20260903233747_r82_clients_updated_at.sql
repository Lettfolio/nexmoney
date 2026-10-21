-- 20260903233747_r82_clients_updated_at — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R82: clients.updated_at — the column R18-D1's guard has always assumed and never had.
--
-- Found by db/check-schema-drift.js on its first run. `admin/app.js` has, since R18,
-- read `clients.updated_at` to baseline the client modal's stale-write guard
-- (refreshOpenedClientStamp, app.js:19652) and filtered on it when saving
-- (`.eq("updated_at", openedClientUpdatedAt)`, app.js:25084) — exactly mirroring the
-- case modal's guard. But the column was never created: production returns
-- 42703 for `select updated_at from clients`, verified directly. So the client
-- guard has never worked, and saving an existing client could never behave as designed.
--
-- The mock had the column, so 86 suites and ~7,900 assertions were green over a
-- production 42703 for many rounds. That is precisely the silent failure the drift
-- check was built to make loud, and it found it immediately.
--
-- The app's belief is the correct one — a client record deserves the same protection
-- as a case record — so production is what changes here. `cases` maintains its stamp
-- with a BEFORE UPDATE trigger (touch_case); this mirrors it exactly for clients.
alter table public.clients add column if not exists updated_at timestamptz;

-- Backfill so the guard never baselines on a null.
update public.clients set updated_at = coalesce(updated_at, created_at, now());

alter table public.clients alter column updated_at set default now();

create or replace function public.touch_client()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  return new;
end $function$;

drop trigger if exists clients_touch on public.clients;
create trigger clients_touch before update on public.clients
  for each row execute function public.touch_client();
