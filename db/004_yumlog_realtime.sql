-- =============================================================================
-- 004_yumlog_realtime.sql  --  live shopping-list sync between devices
--
-- PURPOSE:    Add yumlog.shopping_list to the supabase_realtime publication so
--             subscribeShoppingList() (src/lib/shopping-list.ts) receives
--             postgres_changes events. It never worked in the old project (the
--             table was never in the publication). Realtime checks RLS per
--             subscriber, so only members get row events; anon has no SELECT
--             grant. DELETE events are not RLS-filtered but carry only the
--             primary key (default replica identity), and the client just
--             refetches under RLS.
-- RUN IN:     wrapt's Supabase project, after 002.
-- IDEMPOTENT: yes — the table is only added if it isn't already a member.
-- RESULT:     verification SELECT; every row status = OK.
-- ROLLBACK:   alter publication supabase_realtime drop table yumlog.shopping_list;
-- =============================================================================

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'publication supabase_realtime not found — is Realtime enabled on this project?';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'yumlog' and tablename = 'shopping_list'
  ) then
    alter publication supabase_realtime add table yumlog.shopping_list;
  end if;
end
$$;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification (the grid the editor shows). Every row: status = OK.
-- ---------------------------------------------------------------------------
with report(ord, item, expected, actual) as (
  select 1, 'yumlog.shopping_list in supabase_realtime', 'true',
         exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'yumlog'
                   and tablename = 'shopping_list')::text
  union all
  select 2, 'other yumlog tables in supabase_realtime', '0',
         (select count(*) from pg_publication_tables
          where pubname = 'supabase_realtime' and schemaname = 'yumlog'
            and tablename <> 'shopping_list')::text
  union all
  select 3, 'authenticated SELECT on yumlog.shopping_list (Realtime needs it)', 'true',
         has_table_privilege('authenticated', 'yumlog.shopping_list', 'SELECT')::text
  union all
  select 4, 'anon SELECT on yumlog.shopping_list', 'false',
         has_table_privilege('anon', 'yumlog.shopping_list', 'SELECT')::text
  union all
  select 5, 'RLS enabled on yumlog.shopping_list', 'true',
         (select c.relrowsecurity from pg_class c where c.oid = 'yumlog.shopping_list'::regclass)::text
)
select ord, item, expected, actual,
       case when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord;
