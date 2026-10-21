-- 20260825151905_r59_property_sold — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R59: visible SOLD marker, written by the rate-end outcome's "property sold / redeemed" path.
alter table cases add column if not exists property_sold_at date;
comment on column cases.property_sold_at is 'R59 - date the property was sold / mortgage redeemed, recorded via the rate-end outcome. Drives the SOLD badge on the client record.';
