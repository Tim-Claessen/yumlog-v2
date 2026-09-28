-- =============================================================================
-- 002_yumlog_security.sql  --  grants, is_member(), RLS policies, RPCs
--
-- PURPOSE:    Who may read and write yumlog.*. Wrapt has public sign-ups, so
--             "authenticated" is NOT "Tim or Zoe": every write, every
--             shopping-list read and both RPCs are gated on yumlog.members via
--             yumlog.is_member(). Grants are explicit and exact (see the matrix
--             in the verification SELECT):
--               anon           USAGE on schema; SELECT on recipes, ingredients,
--                              recipe_ingredients. Nothing else.
--               authenticated  USAGE; SELECT/INSERT/UPDATE/DELETE on the four
--                              app tables (RLS decides which rows); EXECUTE on
--                              is_member + the two RPCs.
--               service_role   NOTHING — not even schema USAGE. Wrapt's /ask
--                              runs model SQL as service_role; without USAGE it
--                              gets "permission denied for schema yumlog".
--               PUBLIC         nothing.
--             merge_ingredients / touch_recipes_for_ingredient are SECURITY
--             INVOKER now (they were DEFINER in the old project): a member
--             passes RLS on every table they touch, so definer rights bought
--             nothing but risk. The member guard gives a clear error instead of
--             silently updating 0 rows.
-- RUN IN:     wrapt's Supabase project, after 001.
-- IDEMPOTENT: yes. Grants are reset (revoke all, then grant exactly) on every
--             run; policies are drop-if-exists then create; functions are
--             create or replace.
-- RESULT:     verification SELECT; every row status = OK.
-- ROLLBACK:   drop schema yumlog cascade;  (or re-run after editing)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Schema, table and sequence grants (reset, then grant exactly)
-- ---------------------------------------------------------------------------

revoke all on schema yumlog from public, anon, authenticated, service_role;
grant usage on schema yumlog to anon, authenticated;

revoke all on all tables in schema yumlog from public, anon, authenticated, service_role;
grant select on yumlog.recipes, yumlog.ingredients, yumlog.recipe_ingredients to anon;
grant select, insert, update, delete
  on yumlog.recipes, yumlog.ingredients, yumlog.recipe_ingredients, yumlog.shopping_list
  to authenticated;
-- yumlog.members: no grants to anyone (postgres owns it).

-- Identity inserts shouldn't need sequence rights, but it's cheap insurance.
revoke all on all sequences in schema yumlog from public, anon, authenticated, service_role;
grant usage, select on sequence yumlog.recipe_ingredients_id_seq, yumlog.shopping_list_id_seq
  to authenticated;

-- ---------------------------------------------------------------------------
-- is_member(): the allowlist check every write policy and RPC uses
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER so it can read yumlog.members, which nobody else can.
-- Read-only, returns a boolean about the caller only.
create or replace function yumlog.is_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from yumlog.members m where m.user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- RPCs (called by src/lib/ingredient-registry.ts)
-- ---------------------------------------------------------------------------

-- Bump recipes.updated_at on every recipe using an ingredient, so the
-- recipes rebuild trigger (003) redeploys the static pages after a rename.
create or replace function yumlog.touch_recipes_for_ingredient(p_ingredient text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  touched integer;
begin
  if not yumlog.is_member() then
    raise exception 'not a yumlog member' using errcode = '42501';
  end if;

  update yumlog.recipes r
  set updated_at = now()
  from yumlog.recipe_ingredients ri
  where ri.recipe_slug = r.slug
    and ri.ingredient = p_ingredient;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

-- Merge p_source into p_target: repoint recipe lines, merge shopping rows by
-- unit, delete the source name, then touch affected recipes. Body ported
-- unchanged from the old project's public.merge_ingredients (formerly
-- scripts/ingredient-registry-rpc.sql, see git history), apart from the
-- member guard, SECURITY INVOKER and fully qualified names.
create or replace function yumlog.merge_ingredients(p_source text, p_target text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  r record;
  match_id bigint;
  match_qty numeric;
  merged_recipe_lines integer;
  merged_list_rows integer;
begin
  if not yumlog.is_member() then
    raise exception 'not a yumlog member' using errcode = '42501';
  end if;

  if p_source = p_target then
    raise exception 'Cannot merge an ingredient into itself';
  end if;

  if not exists (select 1 from yumlog.ingredients where name = p_source) then
    raise exception 'Source ingredient not found';
  end if;

  if not exists (select 1 from yumlog.ingredients where name = p_target) then
    raise exception 'Target ingredient not found';
  end if;

  select count(*)::int into merged_recipe_lines
  from yumlog.recipe_ingredients where ingredient = p_source;

  select count(*)::int into merged_list_rows
  from yumlog.shopping_list where ingredient = p_source;

  update yumlog.recipe_ingredients
  set ingredient = p_target
  where ingredient = p_source;

  for r in
    select id, unit, quantity from yumlog.shopping_list where ingredient = p_source
  loop
    select sl.id, sl.quantity
    into match_id, match_qty
    from yumlog.shopping_list sl
    where sl.ingredient = p_target
      and sl.unit is not distinct from r.unit
    limit 1;

    if match_id is not null then
      update yumlog.shopping_list
      set quantity = coalesce(match_qty, 0) + coalesce(r.quantity, 0)
      where id = match_id;
      delete from yumlog.shopping_list where id = r.id;
    else
      update yumlog.shopping_list set ingredient = p_target where id = r.id;
    end if;
  end loop;

  delete from yumlog.ingredients where name = p_source;

  perform yumlog.touch_recipes_for_ingredient(p_target);

  return jsonb_build_object(
    'recipe_lines', merged_recipe_lines,
    'shopping_list_rows', merged_list_rows
  );
end;
$$;

-- Postgres gives PUBLIC EXECUTE on every new function; take it away from
-- everyone, then grant back only what the app needs. (003's trigger
-- function repeats this for itself.)
revoke execute on all functions in schema yumlog from public, anon, authenticated, service_role;
grant execute on function
  yumlog.is_member(),
  yumlog.merge_ingredients(text, text),
  yumlog.touch_recipes_for_ingredient(text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RLS policies. Per-command on the three public tables (one public SELECT
-- policy, member-only writes — no overlapping permissive SELECTs); one
-- FOR ALL policy on shopping_list, which has a single audience.
-- `(select yumlog.is_member())` is evaluated once per statement, not per row.
-- ---------------------------------------------------------------------------

-- recipes
drop policy if exists "recipes public read" on yumlog.recipes;
create policy "recipes public read" on yumlog.recipes
  for select to anon, authenticated using (true);
drop policy if exists "recipes member insert" on yumlog.recipes;
create policy "recipes member insert" on yumlog.recipes
  for insert to authenticated with check ((select yumlog.is_member()));
drop policy if exists "recipes member update" on yumlog.recipes;
create policy "recipes member update" on yumlog.recipes
  for update to authenticated
  using ((select yumlog.is_member())) with check ((select yumlog.is_member()));
drop policy if exists "recipes member delete" on yumlog.recipes;
create policy "recipes member delete" on yumlog.recipes
  for delete to authenticated using ((select yumlog.is_member()));

-- ingredients
drop policy if exists "ingredients public read" on yumlog.ingredients;
create policy "ingredients public read" on yumlog.ingredients
  for select to anon, authenticated using (true);
drop policy if exists "ingredients member insert" on yumlog.ingredients;
create policy "ingredients member insert" on yumlog.ingredients
  for insert to authenticated with check ((select yumlog.is_member()));
drop policy if exists "ingredients member update" on yumlog.ingredients;
create policy "ingredients member update" on yumlog.ingredients
  for update to authenticated
  using ((select yumlog.is_member())) with check ((select yumlog.is_member()));
drop policy if exists "ingredients member delete" on yumlog.ingredients;
create policy "ingredients member delete" on yumlog.ingredients
  for delete to authenticated using ((select yumlog.is_member()));

-- recipe_ingredients
drop policy if exists "recipe_ingredients public read" on yumlog.recipe_ingredients;
create policy "recipe_ingredients public read" on yumlog.recipe_ingredients
  for select to anon, authenticated using (true);
drop policy if exists "recipe_ingredients member insert" on yumlog.recipe_ingredients;
create policy "recipe_ingredients member insert" on yumlog.recipe_ingredients
  for insert to authenticated with check ((select yumlog.is_member()));
drop policy if exists "recipe_ingredients member update" on yumlog.recipe_ingredients;
create policy "recipe_ingredients member update" on yumlog.recipe_ingredients
  for update to authenticated
  using ((select yumlog.is_member())) with check ((select yumlog.is_member()));
drop policy if exists "recipe_ingredients member delete" on yumlog.recipe_ingredients;
create policy "recipe_ingredients member delete" on yumlog.recipe_ingredients
  for delete to authenticated using ((select yumlog.is_member()));

-- shopping_list: members only, for everything (anon has no grant at all)
drop policy if exists "shopping_list members only" on yumlog.shopping_list;
create policy "shopping_list members only" on yumlog.shopping_list
  for all to authenticated
  using ((select yumlog.is_member())) with check ((select yumlog.is_member()));

-- members: RLS on (001), deliberately no policies.

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification (the grid the editor shows). Every row: status = OK.
-- Privilege lists use Postgres names in a fixed order:
-- SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ('-' = none).
-- ---------------------------------------------------------------------------
with
roles(role) as (
  values ('anon'::name), ('authenticated'), ('service_role'), ('public')
),
privs(ord, priv) as (
  values (1, 'SELECT'), (2, 'INSERT'), (3, 'UPDATE'), (4, 'DELETE'),
         (5, 'TRUNCATE'), (6, 'REFERENCES'), (7, 'TRIGGER')
),
tables(tbl) as (
  values ('recipes'), ('ingredients'), ('recipe_ingredients'), ('shopping_list'), ('members')
),
table_expected(tbl, role, privs) as (
  select t.tbl, r.role,
         case
           when r.role = 'anon' and t.tbl in ('recipes', 'ingredients', 'recipe_ingredients') then 'SELECT'
           when r.role = 'authenticated' and t.tbl <> 'members' then 'SELECT,INSERT,UPDATE,DELETE'
           else '-'
         end
  from tables t cross join roles r
),
table_actual(tbl, role, privs) as (
  select t.tbl, r.role,
         coalesce((select string_agg(p.priv, ',' order by p.ord)
                   from privs p
                   where to_regclass('yumlog.' || t.tbl) is not null
                     and has_table_privilege(r.role, to_regclass('yumlog.' || t.tbl), p.priv)), '-')
  from tables t cross join roles r
),
fn_expected(fn, definer, auth_exec) as (
  values
    ('is_member()',                                    'true',  'true'),
    ('merge_ingredients(p_source text, p_target text)', 'false', 'true'),
    ('touch_recipes_for_ingredient(p_ingredient text)', 'false', 'true'),
    ('shopping_list_set_updated_at()',                 'false', 'false'),
    ('request_site_rebuild()',                         'true',  'false')   -- from 003
),
fns as (
  select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
         p.prosecdef, p.proconfig
  from pg_proc p
  where p.pronamespace = to_regnamespace('yumlog')
),
policies(tbl, pol, cmd, roles, qual, chk) as (
  select tablename::text, policyname::text, cmd::text, array_to_string(roles, ','),
         coalesce(qual, '-'), coalesce(with_check, '-')
  from pg_policies
  where schemaname = 'yumlog'
),
report(ord, item, expected, actual) as (
  select 10, 'schema USAGE ' || r.role,
         case when r.role in ('anon', 'authenticated') then 'true' else 'false' end,
         has_schema_privilege(r.role, 'yumlog', 'USAGE')::text
  from roles r
  union all
  select 11, 'schema CREATE ' || r.role, 'false',
         has_schema_privilege(r.role, 'yumlog', 'CREATE')::text
  from roles r
  union all
  select 20, 'table ' || e.tbl || ' -> ' || e.role, e.privs, a.privs
  from table_expected e
  join table_actual a on a.tbl = e.tbl and a.role = e.role
  union all
  select 30, 'sequence ' || s.seq || ' -> ' || r.role,
         case when r.role = 'authenticated' then 'USAGE,SELECT' else '-' end,
         coalesce(nullif(concat_ws(',',
           case when has_sequence_privilege(r.role, to_regclass('yumlog.' || s.seq), 'USAGE') then 'USAGE' end,
           case when has_sequence_privilege(r.role, to_regclass('yumlog.' || s.seq), 'SELECT') then 'SELECT' end,
           case when has_sequence_privilege(r.role, to_regclass('yumlog.' || s.seq), 'UPDATE') then 'UPDATE' end
         ), ''), '-')
  from (values ('recipe_ingredients_id_seq'), ('shopping_list_id_seq')) as s(seq)
  cross join roles r
  -- every function in the schema, including any not listed in fn_expected
  union all
  select 40, 'fn ' || f.fn || ': security_definer / config',
         coalesce(e.definer, '<unexpected function>') || ' / search_path=""',
         f.prosecdef::text || ' / ' || coalesce(array_to_string(f.proconfig, ','), '<none>')
  from fns f left join fn_expected e on e.fn = f.fn
  union all
  select 41, 'fn ' || f.fn || ': EXECUTE anon/authenticated/service_role/public',
         'false/' || coalesce(e.auth_exec, '<unexpected function>') || '/false/false',
         has_function_privilege('anon', f.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', f.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('service_role', f.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('public', f.oid, 'EXECUTE')::text
  from fns f left join fn_expected e on e.fn = f.fn
  union all
  select 42, 'fn ' || e.fn || ' exists', 'true',
         exists (select 1 from fns f where f.fn = e.fn)::text
  from fn_expected e
  where e.fn <> 'request_site_rebuild()'
  union all
  select 50, 'policy count', '13', (select count(*) from policies)::text
  union all
  select 51, 'policy ' || p.tbl || '."' || p.pol || '"',
         case
           when p.pol like '% public read' then 'SELECT to anon,authenticated using true check -'
           when p.pol like '% member insert' then 'INSERT to authenticated using - check (SELECT yumlog.is_member())'
           when p.pol like '% member update' then 'UPDATE to authenticated using (SELECT yumlog.is_member()) check (SELECT yumlog.is_member())'
           when p.pol like '% member delete' then 'DELETE to authenticated using (SELECT yumlog.is_member()) check -'
           when p.pol = 'shopping_list members only' then 'ALL to authenticated using (SELECT yumlog.is_member()) check (SELECT yumlog.is_member())'
           else '<unexpected policy>'
         end,
         -- deparse prints "( SELECT yumlog.is_member() AS is_member)"; normalise
         -- the spacing and alias so the comparison is about meaning, not layout
         regexp_replace(regexp_replace(
           p.cmd || ' to ' || p.roles || ' using ' || p.qual || ' check ' || p.chk,
           '\(\s+', '(', 'g'), ' AS is_member', '', 'g')
  from policies p
  union all
  select 52, 'policies on members', '0',
         (select count(*) from policies where tbl = 'members')::text
  union all
  select 60, 'RLS enabled on all 5 tables', '5',
         (select count(*) from pg_class c
          where c.relnamespace = to_regnamespace('yumlog') and c.relkind = 'r'
            and c.relname in (select tbl from tables) and c.relrowsecurity)::text
)
select ord, item, expected, actual,
       case when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
