-- R82 — the query that produces db/columns.json.
-- Run against production, convert to JSON (table -> sorted column array), commit the result.
-- Deliberately EXCLUDES backup_* tables: they are the SB-IMPORT-1 safety net, due to be
-- dropped, and are not part of the app's schema contract.
select c.table_name, string_agg(c.column_name, ',' order by c.column_name) as cols
from information_schema.columns c
join information_schema.tables tb
  on tb.table_name = c.table_name and tb.table_schema = c.table_schema
where c.table_schema = 'public'
  and tb.table_type in ('BASE TABLE', 'VIEW')
  and c.table_name not like 'backup\_%'
group by c.table_name
order by c.table_name;
