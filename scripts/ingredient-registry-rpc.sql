-- Ingredient registry admin — run once in Supabase SQL editor.
-- Required for merge + rebuild touch. Rename/delete work without this but merge needs the RPC.

-- Bump column so touch_recipes_for_ingredient can fire the recipes UPDATE webhook.
alter table recipes
  add column if not exists updated_at timestamptz not null default now();

create or replace function touch_recipes_for_ingredient(p_ingredient text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  touched integer;
begin
  update recipes r
  set updated_at = now()
  from recipe_ingredients ri
  where ri.recipe_slug = r.slug
    and ri.ingredient = p_ingredient;

  get diagnostics touched = row_count;
  return touched;
end;
$$;

create or replace function merge_ingredients(p_source text, p_target text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  match_id bigint;
  match_qty numeric;
  merged_recipe_lines integer;
  merged_list_rows integer;
begin
  if p_source = p_target then
    raise exception 'Cannot merge an ingredient into itself';
  end if;

  if not exists (select 1 from ingredients where name = p_source) then
    raise exception 'Source ingredient not found';
  end if;

  if not exists (select 1 from ingredients where name = p_target) then
    raise exception 'Target ingredient not found';
  end if;

  select count(*)::int into merged_recipe_lines
  from recipe_ingredients where ingredient = p_source;

  select count(*)::int into merged_list_rows
  from shopping_list where ingredient = p_source;

  update recipe_ingredients
  set ingredient = p_target
  where ingredient = p_source;

  for r in
    select id, unit, quantity from shopping_list where ingredient = p_source
  loop
    select sl.id, sl.quantity
    into match_id, match_qty
    from shopping_list sl
    where sl.ingredient = p_target
      and sl.unit is not distinct from r.unit
    limit 1;

    if match_id is not null then
      update shopping_list
      set quantity = coalesce(match_qty, 0) + coalesce(r.quantity, 0)
      where id = match_id;
      delete from shopping_list where id = r.id;
    else
      update shopping_list set ingredient = p_target where id = r.id;
    end if;
  end loop;

  delete from ingredients where name = p_source;

  perform touch_recipes_for_ingredient(p_target);

  return jsonb_build_object(
    'recipe_lines', merged_recipe_lines,
    'shopping_list_rows', merged_list_rows
  );
end;
$$;

grant execute on function touch_recipes_for_ingredient(text) to authenticated;
grant execute on function merge_ingredients(text, text) to authenticated;
