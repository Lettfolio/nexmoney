-- R84 · S3 (P2) — retire the public `web` bucket (legacy back-office copy)
--
-- WHAT: storage bucket `web` is public=true and holds one object, backoffice.html (36,861 B,
-- text/html, written 2026-07-04 by the install-web edge function). It is the full 2026-07 admin
-- SPA — a working sign-in against production on a supabase.co origin, outside every later
-- app-layer control (link expiry, refile-not-delete, R83 opt-out flags) and a ready-made
-- phishing target. Nothing in admin/ or the website references it.
--
-- FIX: delete every object in the bucket and make the bucket private. The bucket row itself is
-- kept (dropping it would need the storage API and is not reversible from SQL); a private,
-- empty bucket serves nothing. Pairs with edge/admin-v4.ts and edge/install-web-v4.ts (410 stubs)
-- — deploy those first so nothing can re-create the object.
--
-- EXPECTED EFFECT: GET /storage/v1/object/public/web/backoffice.html → 400/404 "Object not found".
--
-- VERIFY (after apply):
--   select id, public, (select count(*) from storage.objects o where o.bucket_id = b.id) as objects
--     from storage.buckets b where b.id = 'web';
--     -- 1 row: public = false, objects = 0
--
-- (no BEGIN/COMMIT here — run as `BEGIN; \i this_file; ROLLBACK|COMMIT;`)

-- R84: remove the public copy of the legacy SPA (idempotent: no rows → no-op).
delete from storage.objects where bucket_id = 'web';

-- R84: close the bucket. Idempotent; `if exists` semantics via the WHERE.
update storage.buckets set public = false where id = 'web' and public is distinct from false;
