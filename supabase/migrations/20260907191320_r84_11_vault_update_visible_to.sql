-- 20260907191320_r84_11_vault_update_visible_to — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

drop policy if exists "staff update vault" on public.vault_entries;
create policy "staff update vault" on public.vault_entries
  for update to public
  using (
    (select public.is_staff())
    and (visible_to is null or cardinality(visible_to) = 0
         or (select public.my_role()) = any (visible_to))
  )
  with check (
    (select public.is_staff())
    and (visible_to is null or cardinality(visible_to) = 0
         or (select public.my_role()) = any (visible_to))
  );
