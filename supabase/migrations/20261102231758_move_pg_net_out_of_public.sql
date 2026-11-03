-- 20261102231758_move_pg_net_out_of_public — recorded after the fact (R97, 3 Nov 2026).
-- This was applied straight to PRODUCTION on 2 Nov 2026 (Supabase advisor fix: pg_net lived in public), so the
-- remote migration history held a version this folder did not. The GitHub integration then refused the R97 push
-- on merge ("Remote migration versions not found in local migrations directory"). This file is the record; the
-- integration skips it on production (version already present) and replays it on Preview Branches.
-- Text as applied, made idempotent for an empty branch. pg_net is not relocatable, so it is dropped and
-- recreated in `extensions`; its objects live in the `net` schema either way, so the cron jobs calling
-- net.http_post are unaffected.
drop extension if exists pg_net;
create extension if not exists pg_net with schema extensions;
