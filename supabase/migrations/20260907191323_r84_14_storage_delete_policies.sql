-- 20260907191323_r84_14_storage_delete_policies — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

drop policy if exists "staff client-docs delete" on storage.objects;
create policy "staff client-docs delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'client-docs'::text and (select public.is_staff()));
drop policy if exists "staff offers delete" on storage.objects;
create policy "staff offers delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'offers'::text and (select public.is_staff()));
