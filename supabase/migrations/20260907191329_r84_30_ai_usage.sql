-- 20260907191329_r84_30_ai_usage — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

create table if not exists public.ai_usage (
  uid        uuid        not null,
  day        date        not null,
  fn         text        not null,
  calls      integer     not null default 0,
  bytes      bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (uid, day, fn)
);
comment on table public.ai_usage is
  'R84: per-user per-day meter for the AI edge functions (parse-offer, ai-import). Service-role only.';
alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;
revoke all on table public.ai_usage from anon, authenticated;
grant select, insert, update, delete on table public.ai_usage to service_role;
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
