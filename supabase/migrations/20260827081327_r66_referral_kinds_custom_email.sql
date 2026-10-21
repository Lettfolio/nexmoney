-- 20260827081327_r66_referral_kinds_custom_email — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R66 · M6/M8: protection + GI referral kinds, a 'referred' protection outcome kept on the Protection
-- page, and the adviser-written 'custom' email type (subject + body_html carried on the queue row;
-- process-emails v17 wraps them in the house template at send time).
alter table referrals drop constraint if exists referrals_kind_check;
alter table referrals add constraint referrals_kind_check
  check (kind = any (array['survey'::text,'conveyancing'::text,'protection'::text,'gi'::text,'other'::text]));

alter type email_type add value if not exists 'custom';

-- get_protection_pipeline: a case whose protection was REFERRED to the network's protection adviser
-- stays on the Protection page (weight between discussed and quoted) instead of vanishing.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.get_protection_pipeline'::regproc);
  if position($x$protection_status in ('not_discussed','discussed','quoted')$x$ in d) = 0 then
    raise exception 'get_protection_pipeline: status filter not found verbatim';
  end if;
  d := replace(d, $x$protection_status in ('not_discussed','discussed','quoted')$x$,
                  $x$protection_status in ('not_discussed','discussed','quoted','referred')$x$);
  d := replace(d, $x$protection_status = 'discussed' then 5 else 0 end$x$,
                  $x$protection_status = 'discussed' then 5 when c.protection_status = 'referred' then 10 else 0 end$x$);
  execute d;
end $$;
