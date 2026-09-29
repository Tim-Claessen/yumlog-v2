-- =============================================================================
-- yumlog load, run 20260928T134240Z-8a7541: SWAP (truncate-and-reload), target wrapt
--
-- RUN IN:     WRAPT project -> SQL Editor, AFTER all 6 chunk files.
-- WHAT:       one `do` block = one transaction: re-checks every table's md5 in the
--             database, disables the rebuild trigger "yumlog_rebuild_site", truncates the
--             four yumlog.* tables, reloads them keeping ids (overriding system
--             value), sets the identity sequences to greatest(max id, source
--             last_value), re-enables the trigger, drops the staging data.
--             Any error = nothing changed; fix and re-run. Re-running after success
--             fails harmlessly (staging is gone) — regenerate to load again.
--             The shopping_list BEFORE UPDATE trigger doesn't fire on INSERT, so
--             updated_at values are kept as exported.
-- SOURCE:     public.* exported 2026-09-28T13:37:38.025483+00:00 (TimeZone UTC)
-- EXPECTED:   the final grid = the source's checksum.sql grid (counts, md5s).
-- =============================================================================
do $swap$
declare
  n bigint;
  j text;
  trigger_was_enabled boolean;
  j_ingredients jsonb;
  j_recipes jsonb;
  j_recipe_ingredients jsonb;
  j_shopping_list jsonb;
begin
  if to_regclass('yumlog._load') is null then
    raise exception 'staging table yumlog._load not found — paste the chunk files first';
  end if;

  -- 1. Every chunk present and intact?
  select count(*), string_agg(body, '' order by part) into n, j from yumlog._load
   where run_id = '20260928T134240Z-8a7541' and tbl = 'ingredients';
  if n is distinct from 1 or md5(coalesce(j, '')) <> '56a31e4a2cdb52d390fdcc2a51b8b5e9' then
    raise exception 'ingredients: expected 1 part(s) with md5 56a31e4a2cdb52d390fdcc2a51b8b5e9, found % part(s) with md5 % — paste the missing chunk(s) and re-run', n, md5(coalesce(j, ''));
  end if;
  if jsonb_array_length(j::jsonb) <> 201 then
    raise exception 'ingredients: expected 201 rows in the JSON, found %', jsonb_array_length(j::jsonb);
  end if;
  j_ingredients := j::jsonb;
  select count(*), string_agg(body, '' order by part) into n, j from yumlog._load
   where run_id = '20260928T134240Z-8a7541' and tbl = 'recipes';
  if n is distinct from 2 or md5(coalesce(j, '')) <> '3b600c1c3397c96159c19f1cbe730735' then
    raise exception 'recipes: expected 2 part(s) with md5 3b600c1c3397c96159c19f1cbe730735, found % part(s) with md5 % — paste the missing chunk(s) and re-run', n, md5(coalesce(j, ''));
  end if;
  if jsonb_array_length(j::jsonb) <> 51 then
    raise exception 'recipes: expected 51 rows in the JSON, found %', jsonb_array_length(j::jsonb);
  end if;
  j_recipes := j::jsonb;
  select count(*), string_agg(body, '' order by part) into n, j from yumlog._load
   where run_id = '20260928T134240Z-8a7541' and tbl = 'recipe_ingredients';
  if n is distinct from 2 or md5(coalesce(j, '')) <> '76736d8d30c048ce93550f347451252b' then
    raise exception 'recipe_ingredients: expected 2 part(s) with md5 76736d8d30c048ce93550f347451252b, found % part(s) with md5 % — paste the missing chunk(s) and re-run', n, md5(coalesce(j, ''));
  end if;
  if jsonb_array_length(j::jsonb) <> 483 then
    raise exception 'recipe_ingredients: expected 483 rows in the JSON, found %', jsonb_array_length(j::jsonb);
  end if;
  j_recipe_ingredients := j::jsonb;
  select count(*), string_agg(body, '' order by part) into n, j from yumlog._load
   where run_id = '20260928T134240Z-8a7541' and tbl = 'shopping_list';
  if n is distinct from 1 or md5(coalesce(j, '')) <> 'b3454228b2b5fa7b038b98ab16943dfb' then
    raise exception 'shopping_list: expected 1 part(s) with md5 b3454228b2b5fa7b038b98ab16943dfb, found % part(s) with md5 % — paste the missing chunk(s) and re-run', n, md5(coalesce(j, ''));
  end if;
  if jsonb_array_length(j::jsonb) <> 10 then
    raise exception 'shopping_list: expected 10 rows in the JSON, found %', jsonb_array_length(j::jsonb);
  end if;
  j_shopping_list := j::jsonb;

  -- 2. Rebuild trigger off for the load (row-level in the old project = 1 POST per row).
  select tg.tgenabled <> 'D' into trigger_was_enabled
  from pg_trigger tg
  where tg.tgrelid = 'yumlog.recipes'::regclass and tg.tgname = 'yumlog_rebuild_site';
  if trigger_was_enabled then
    execute format('alter table yumlog.recipes disable trigger %I', 'yumlog_rebuild_site');
  end if;

  -- 3. Truncate-and-reload in FK order.
  truncate yumlog.recipe_ingredients, yumlog.shopping_list, yumlog.recipes, yumlog.ingredients;
  insert into yumlog.ingredients
  select * from jsonb_populate_recordset(null::yumlog.ingredients, j_ingredients);
  get diagnostics n = row_count;
  if n <> 201 then raise exception 'ingredients: inserted % rows, expected 201', n; end if;
  insert into yumlog.recipes
  select * from jsonb_populate_recordset(null::yumlog.recipes, j_recipes);
  get diagnostics n = row_count;
  if n <> 51 then raise exception 'recipes: inserted % rows, expected 51', n; end if;
  insert into yumlog.recipe_ingredients overriding system value
  select * from jsonb_populate_recordset(null::yumlog.recipe_ingredients, j_recipe_ingredients);
  get diagnostics n = row_count;
  if n <> 483 then raise exception 'recipe_ingredients: inserted % rows, expected 483', n; end if;
  insert into yumlog.shopping_list overriding system value
  select * from jsonb_populate_recordset(null::yumlog.shopping_list, j_shopping_list);
  get diagnostics n = row_count;
  if n <> 10 then raise exception 'shopping_list: inserted % rows, expected 10', n; end if;

  -- 4. Identity sequences: never hand out an id the source already used.
  perform setval(pg_get_serial_sequence('yumlog.recipe_ingredients', 'id'),
                 greatest((select coalesce(max(id), 0) from yumlog.recipe_ingredients), 1844, 1), true);
  perform setval(pg_get_serial_sequence('yumlog.shopping_list', 'id'),
                 greatest((select coalesce(max(id), 0) from yumlog.shopping_list), 97, 1), true);

  -- 5. Trigger back on (only if it was on), staging gone.
  if trigger_was_enabled then
    execute format('alter table yumlog.recipes enable trigger %I', 'yumlog_rebuild_site');
  end if;
  drop table yumlog._load;
end
$swap$;

-- Result grid (same query as checksum.sql, schema yumlog):
with
params(s) as (values ('yumlog'::text)),   -- same as checksum.sql
tables(ord, tbl, q) as (
  values
    (1, 'ingredients', $q$select count(*) as n, md5(coalesce(string_agg(jsonb_build_array(t.name, t.category)::text, chr(10) order by t.name collate "C"), '')) as h from %I.ingredients t$q$),
    (2, 'recipes', $q$select count(*) as n, md5(coalesce(string_agg(jsonb_build_array(t.slug, t.title, t.category, t.protein, t.cook_time_min, t.method, t.source_url, t.created_at at time zone 'UTC', t.tips, t.substitutions, t.updated_at at time zone 'UTC')::text, chr(10) order by t.slug collate "C"), '')) as h from %I.recipes t$q$),
    (3, 'recipe_ingredients', $q$select count(*) as n, md5(coalesce(string_agg(jsonb_build_array(t.id, t.recipe_slug, t.ingredient, t.display_name, t.quantity, t.unit)::text, chr(10) order by t.id), '')) as h from %I.recipe_ingredients t$q$),
    (4, 'shopping_list', $q$select count(*) as n, md5(coalesce(string_agg(jsonb_build_array(t.id, t.ingredient, t.quantity, t.unit, t.checked, t.position, t.added_at at time zone 'UTC', t.updated_at at time zone 'UTC')::text, chr(10) order by t.id), '')) as h from %I.shopping_list t$q$)
),
counted as (
  select t.ord, t.tbl, query_to_xml(format(t.q, p.s), false, true, '') as x
  from tables t cross join params p
)
select c.ord, c.tbl as item,
       (xpath('/row/n/text()', c.x))[1]::text as row_count,
       (xpath('/row/h/text()', c.x))[1]::text as md5
from counted c
union all
select 10 + row_number() over (order by s.sequencename), 'sequence ' || s.sequencename,
       coalesce(s.last_value::text, '<never used>'), null
from pg_sequences s cross join params p
where s.schemaname = p.s
  and s.sequencename in ('recipe_ingredients_id_seq', 'shopping_list_id_seq')
union all
select 20, 'schema / database / TimeZone (info)',
       p.s || ' / ' || current_database() || ' / ' || current_setting('TimeZone'), null
from params p
order by 1;
