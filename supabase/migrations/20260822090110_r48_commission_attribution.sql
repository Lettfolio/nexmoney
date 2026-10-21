-- 20260822090110_r48_commission_attribution — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R48 — commission attribution. Each statement line's income is attributed to a person's figures.
-- Rule (set at import, editable in the review queue): miscellaneous insurance — protection, GI and
-- renewal trail — always attributes to the owner, whoever's name it sits under on the sheet;
-- mortgage commission attributes to the case's adviser once matched, else the person the statement
-- names, else the owner (covers the ex-brokers Hannah/Nathan/Ciaran/Elizabeth, whose trail is the
-- owner's). NULL = not yet attributed → surfaces in the owner's "needs you" queue.
alter table public.commission_lines
  add column attributed_to uuid references public.profiles(id) on delete set null;
create index commission_lines_attributed_idx on public.commission_lines (attributed_to);
