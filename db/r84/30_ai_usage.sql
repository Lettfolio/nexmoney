-- =============================================================================
-- R84 · 30 · ai_usage — per-user daily meter for the AI edge functions (S4 finding, P1)
--
-- WHAT: a small ledger the service role writes from parse-offer v5 and ai-import v3:
--       one row per (uid, London calendar day) with a call counter and total input bytes.
--       RLS is ON with NO client policies, and every table privilege is revoked from
--       anon/authenticated, so PostgREST callers can neither read nor forge it — only the
--       edge functions' service-role client touches it.
-- WHY:  both functions relied on verify_jwt alone, which the public anon key satisfies, so
--       anybody holding the key from app.js could spend the Anthropic budget without limit.
--       v5/v3 now require a signed-in owner/admin/adviser AND refuse the 51st call in a day.
-- EFFECT: no change to any existing table, view, policy or function. New table only.
--
-- DRY RUN: wrapped in BEGIN/COMMIT — replace the final COMMIT with ROLLBACK.
-- VERIFY (after apply):
--   select c.relname, c.relrowsecurity,
--          (select count(*) from pg_policies where tablename='ai_usage') n_policies,   -- expect 0
--          has_table_privilege('anon','public.ai_usage','SELECT')          anon_sel,   -- expect f
--          has_table_privilege('authenticated','public.ai_usage','SELECT') auth_sel,   -- expect f
--          has_table_privilege('service_role','public.ai_usage','INSERT')  svc_ins     -- expect t
--     from pg_class c where c.relname='ai_usage' and c.relnamespace='public'::regnamespace;
-- =============================================================================
begin;

create table if not exists public.ai_usage (
  uid        uuid        not null,                                   -- R84: auth.users id of the caller
  day        date        not null,                                   -- R84: Europe/London calendar day
  fn         text        not null,                                   -- R84: 'parse-offer' | 'ai-import'
  calls      integer     not null default 0,
  bytes      bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (uid, day, fn)
);

comment on table public.ai_usage is
  'R84: per-user per-day meter for the AI edge functions (parse-offer, ai-import). Service-role only.';

alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;   -- R84: even the owner role goes through RLS

-- R84: no policies at all → nothing readable/writable through PostgREST for anon/authenticated.
revoke all on table public.ai_usage from anon, authenticated;
grant select, insert, update, delete on table public.ai_usage to service_role;

-- R84: bump-and-return in one statement so the edge function has no read-then-write race.
-- Returns the call count AFTER the bump; the function refuses when it exceeds its cap.
-- Callable by service_role only (RLS is forced, but the function is SECURITY DEFINER, so the
-- EXECUTE grant is the real gate).
create or replace function public.ai_usage_bump(p_uid uuid, p_fn text, p_bytes bigint)
returns integer
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.ai_usage as u (uid, day, fn, calls, bytes)
  values (p_uid, (now() at time zone 'Europe/London')::date, p_fn, 1, greatest(p_bytes, 0))
  on conflict (uid, day, fn) do update
    set calls = u.calls + 1,
        bytes = u.bytes + greatest(excluded.bytes, 0),
        updated_at = now()
  returning calls;
$function$;

revoke execute on function public.ai_usage_bump(uuid, text, bigint) from public, anon, authenticated;
grant  execute on function public.ai_usage_bump(uuid, text, bigint) to service_role;

commit;
