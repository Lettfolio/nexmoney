-- R84 · S2-4 (P2) — storage DELETE policies for client-docs and offers
--
-- WHAT: storage.objects had SELECT/INSERT/UPDATE policies for both private buckets but no
-- DELETE policy. Supabase Storage answers a denied delete with 200 and an empty array (no error),
-- so admin/app.js deleteCaseFile() removed the case_files row, told the operator the stored copy
-- was gone, and left the client document orphaned in the bucket. The upload-rollback path had the
-- same blind spot. (0 orphans found today — 10 objects, all referenced.)
--
-- FIX: staff may delete objects in client-docs and offers, mirroring the existing insert/update
-- policies. The app-side "treat data.length===0 as not removed" check is a separate app.js edit.
--
-- EXPECTED EFFECT: "Remove the file" actually removes the object; rollback of a failed upload
-- actually cleans up.
--
-- VERIFY (after apply):
--   select policyname, cmd, qual from pg_policies
--    where schemaname='storage' and tablename='objects' and cmd='DELETE';
--     -- 2 rows: "staff client-docs delete", "staff offers delete"
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

drop policy if exists "staff client-docs delete" on storage.objects;
create policy "staff client-docs delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'client-docs'::text and (select public.is_staff()));

drop policy if exists "staff offers delete" on storage.objects;
create policy "staff offers delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'offers'::text and (select public.is_staff()));
