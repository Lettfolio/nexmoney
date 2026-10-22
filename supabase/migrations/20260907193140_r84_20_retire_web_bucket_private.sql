-- 20260907193140_r84_20_retire_web_bucket_private — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

update storage.buckets set public = false where id = 'web' and public is distinct from false;
