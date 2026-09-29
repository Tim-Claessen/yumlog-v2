-- =============================================================================
-- freeze_old.sql  --  PLAN step 5.1 (T0): make the OLD project read-only for the app
--
-- RUN IN:     the OLD yumlog project (ref nrmimftrjulvsgonrlzg) -> SQL Editor.
--             CHECK THE PROJECT NAME IN THE TOP BAR FIRST.
-- WHAT:       revokes INSERT, UPDATE, DELETE, TRUNCATE on the four app tables
--             from anon and authenticated, and EXECUTE on the two RPCs from
--             authenticated (they are SECURITY DEFINER in the old project, so
--             they would otherwise still write past the table revoke).
--             SELECT stays: the public site, logins and the shopping-list read
--             keep working; every write from the app (or a stale browser tab)
--             fails visibly. postgres / the SQL editor is unaffected, so the
--             export still runs. REFERENCES, TRIGGER and MAINTAIN are left as
--             they were (they don't write data).
-- PRE-FREEZE STATE (docs/archive/2026-09-supabase-to-wrapt/stage1 facts + hotfix_revoke_anon_rpc.sql):
--             anon and authenticated had every table privilege; RPC EXECUTE was
--             authenticated only (PUBLIC/anon removed by the hotfix). This file
--             also re-revokes PUBLIC/anon on the RPCs, which is a no-op if the
--             hotfix ran. unfreeze_old.sql restores exactly the pre-freeze state.
-- IDEMPOTENT: yes.
-- ROLLBACK:   unfreeze_old.sql
-- RESULT:     every row status = OK (all write privileges false; SELECT true).
-- =============================================================================

revoke insert, update, delete, truncate
  on public.recipes, public.ingredients, public.recipe_ingredients, public.shopping_list
  from anon, authenticated;

revoke execute on function public.merge_ingredients(text, text) from public, anon, authenticated;
revoke execute on function public.touch_recipes_for_ingredient(text) from public, anon, authenticated;

notify pgrst, 'reload schema';

with
roles(role) as (values ('anon'::name), ('authenticated')),
tables(tbl) as (values ('recipes'), ('ingredients'), ('recipe_ingredients'), ('shopping_list')),
report(ord, item, expected, actual) as (
  select 1, 'public.' || t.tbl || ' -> ' || r.role || ' SELECT/INSERT/UPDATE/DELETE/TRUNCATE',
         'true/false/false/false/false',
         has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'SELECT')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'INSERT')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'UPDATE')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'DELETE')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'TRUNCATE')::text
  from tables t cross join roles r
  union all
  select 2, p.proname || ' EXECUTE public/anon/authenticated', 'false/false/false',
         has_function_privilege('public', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('merge_ingredients', 'touch_recipes_for_ingredient')
  union all
  select 3, 'frozen at (info)', 'INFO', now()::text
)
select ord, item, expected, actual,
       case when expected = 'INFO' then 'INFO' when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
