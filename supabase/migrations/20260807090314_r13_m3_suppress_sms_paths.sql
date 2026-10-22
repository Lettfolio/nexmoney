-- 20260807090314_r13_m3_suppress_sms_paths — exported from the live Supabase project sclghkmvzpwtmnzbkaoe on 2026-10-21 (R94 · D).
-- Source: supabase_migrations.schema_migrations.statements, verbatim, joined with ";\n\n".
-- This is the rebuild record of what was applied; do not edit — new DDL gets a new file.

-- R13 (M-30 continued): SMS queueing paths must honour suppress_automation too.
-- Two functions insert into sms_queue. Their guard is phone-based, and both
-- carry "not coalesce(cl.sms_opt_out,false)" — extend that guard mechanically,
-- counted, aborting on drift, exactly as r13_m2 did for the email guards.
do $$
declare
  fn record;
  def text;
  newdef text;
  hits int;
begin
  for fn in
    select p.oid, p.proname from pg_proc p
    where p.proname in ('queue_appointment_sms','queue_automated_emails')
  loop
    def := pg_get_functiondef(fn.oid);
    hits := (select count(*) from regexp_matches(def, 'not coalesce\(cl\.sms_opt_out,false\)', 'g'));
    if def like '%sms_opt_out,false) and not coalesce(cl.suppress_automation%' then
      raise notice 'R13 m3: % already patched, skipping', fn.proname;
      continue;
    end if;
    if hits = 0 then
      raise notice 'R13 m3: % has no sms_opt_out guard (no client SMS path) — skipping', fn.proname;
      continue;
    end if;
    newdef := replace(def,
      'not coalesce(cl.sms_opt_out,false)',
      'not coalesce(cl.sms_opt_out,false) and not coalesce(cl.suppress_automation,false)');
    execute newdef;
    raise notice 'R13 m3: % patched (% sms guards)', fn.proname, hits;
  end loop;
end $$;
