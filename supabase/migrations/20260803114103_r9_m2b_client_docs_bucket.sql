-- 20260803114103_r9_m2b_client_docs_bucket — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R9: private bucket for documents clients send in through the upload link.
-- Policies mirror the 'offers' bucket exactly: authenticated staff may select,
-- insert and update; there is deliberately no delete policy (same as offers),
-- so removals stay a service-role/dashboard action.
-- file_size_limit is a second line of defence behind the 10MB check in the
-- doc-upload function; mime types are left unconstrained at bucket level so a
-- browser sending octet-tinged HEIC cannot fail twice for the same reason.
insert into storage.buckets (id, name, public, file_size_limit)
values ('client-docs', 'client-docs', false, 10485760)
on conflict (id) do nothing;

create policy "staff client-docs select" on storage.objects
  for select to authenticated
  using ((bucket_id = 'client-docs'::text) and is_staff());

create policy "staff client-docs insert" on storage.objects
  for insert to authenticated
  with check ((bucket_id = 'client-docs'::text) and is_staff());

create policy "staff client-docs update" on storage.objects
  for update to authenticated
  using ((bucket_id = 'client-docs'::text) and is_staff())
  with check ((bucket_id = 'client-docs'::text) and is_staff());
