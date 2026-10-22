-- 20260825122240_r55_perf_dupfinder_trgm — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R55 F4: the duplicate-client finder was an O(n^2) similarity() cross-join (~1s per call at
-- 1,161 clients, growing quadratically). Give the normalised name a trigram GIN index and add
-- an index-served % prefilter, plus an expression index for the email match. Semantics are
-- IDENTICAL: pg_trgm's default similarity_threshold is 0.3, so `a % b` is implied by
-- similarity(a,b) > 0.6 — the % just lets the planner cut the candidate set with the index
-- before the exact > 0.6 check runs.

create index if not exists idx_clients_name_trgm
  on public.clients using gin (lower(btrim((first_name || ' '::text) || last_name)) extensions.gin_trgm_ops);
create index if not exists idx_clients_email_lower on public.clients (lower(email)) where email is not null;

create or replace function public.find_duplicate_clients()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare uid uuid := auth.uid();
begin
  if not exists (select 1 from profiles where id = uid and role in ('owner','admin','adviser','staff')) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'score')::numeric desc)
    from (
      select jsonb_build_object(
        'a_id', a.id, 'a_name', btrim(a.first_name||' '||a.last_name), 'a_email', a.email,
        'b_id', b.id, 'b_name', btrim(b.first_name||' '||b.last_name), 'b_email', b.email,
        'reason', case when a.email is not null and lower(a.email) = lower(b.email) then 'same email' else 'similar name' end,
        'score', round(greatest(
          case when a.email is not null and lower(a.email) = lower(b.email) then 1 else 0 end,
          similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name)))
        )::numeric, 2)
      ) as x
      from clients a
      join clients b on a.id < b.id
      where (a.email is not null and b.email is not null and lower(a.email) = lower(b.email))
         or (lower(btrim(a.first_name||' '||a.last_name)) % lower(btrim(b.first_name||' '||b.last_name))
             and similarity(lower(btrim(a.first_name||' '||a.last_name)), lower(btrim(b.first_name||' '||b.last_name))) > 0.6)
      limit 100
    ) s), '[]'::jsonb);
end $function$;
