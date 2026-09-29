-- =============================================================================
-- unfreeze_old.sql  --  undo freeze_old.sql (rollback path R-B step 4)
--
-- RUN IN:     the OLD yumlog project (ref nrmimftrjulvsgonrlzg) -> SQL Editor.
-- WHAT:       restores exactly the pre-freeze state (migration/stage1 facts +
--             the anon-RPC hotfix): INSERT, UPDATE, DELETE, TRUNCATE on the four
--             tables back to anon and authenticated (both had them — the old
--             project's RLS policies, not grants, kept anon out), and EXECUTE
--             on the two RPCs back to authenticated only. PUBLIC/anon stay
--             revoked on the RPCs, as after the hotfix.
-- ONLY IF:    rolling back the cutover. If wrapt took writes after cutover, run
--             the reverse sync (loadgen.py load ... --target old) BEFORE this,
--             while the old project is still frozen.
-- IDEMPOTENT: yes.
-- RESULT:     every row status = OK.
-- =============================================================================

grant insert, update, delete, truncate
  on public.recipes, public.ingredients, public.recipe_ingredients, public.shopping_list
  to anon, authenticated;

grant execute on function public.merge_ingredients(text, text) to authenticated;
grant execute on function public.touch_recipes_for_ingredient(text) to authenticated;

notify pgrst, 'reload schema';

with
roles(role) as (values ('anon'::name), ('authenticated')),
tables(tbl) as (values ('recipes'), ('ingredients'), ('recipe_ingredients'), ('shopping_list')),
report(ord, item, expected, actual) as (
  select 1, 'public.' || t.tbl || ' -> ' || r.role || ' SELECT/INSERT/UPDATE/DELETE/TRUNCATE',
         'true/true/true/true/true',
         has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'SELECT')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'INSERT')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'UPDATE')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'DELETE')::text
         || '/' || has_table_privilege(r.role, ('public.' || t.tbl)::regclass, 'TRUNCATE')::text
  from tables t cross join roles r
  union all
  select 2, p.proname || ' EXECUTE public/anon/authenticated', 'false/false/true',
         has_function_privilege('public', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('merge_ingredients', 'touch_recipes_for_ingredient')
)
select ord, item, expected, actual,
       case when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
