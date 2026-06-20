import { supabase } from './supabase';
import { normalizeIngredient } from './ingredient';
import type { IngredientSection } from './ingredient-sections';
import {
  addQuantities,
  shoppingMergeKey,
  toShoppingUnit,
  type CanonicalAmount,
} from './units';

export interface ShoppingItem {
  id: number;
  ingredient: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
  position: number | null;
  added_at: string;
  category: string | null;
}

export interface RecipeIngredientInput {
  ingredient: string;
  quantity: number | null;
  unit: string | null;
}

interface ShoppingListRow {
  id: number;
  ingredient: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
  position: number | null;
  added_at: string;
  ingredients: { category: string | null } | null;
}

function mapShoppingRow(row: ShoppingListRow): ShoppingItem {
  return {
    id: row.id,
    ingredient: row.ingredient,
    quantity: row.quantity,
    unit: row.unit,
    checked: row.checked,
    position: row.position,
    added_at: row.added_at,
    category: row.ingredients?.category ?? null,
  };
}

export async function fetchShoppingList(): Promise<ShoppingItem[]> {
  const { data, error } = await supabase
    .from('shopping_list')
    .select('id, ingredient, quantity, unit, checked, position, added_at, ingredients(category)')
    .order('position', { ascending: true, nullsFirst: false })
    .order('added_at', { ascending: true });

  if (error) throw error;
  return (data as ShoppingListRow[] ?? []).map(mapShoppingRow);
}

async function fetchShoppableNames(names: string[]): Promise<Set<string>> {
  if (names.length === 0) return new Set();

  const unique = [...new Set(names)];
  const { data, error } = await supabase
    .from('ingredients')
    .select('name, category')
    .in('name', unique);

  if (error) throw error;

  return new Set(
    (data ?? [])
      .filter(row => row.category != null)
      .map(row => row.name),
  );
}

function nextPosition(items: ShoppingItem[]): number {
  const max = items.reduce((m, row) => Math.max(m, row.position ?? 0), 0);
  return max + 1;
}

async function upsertMerged(
  existing: ShoppingItem[],
  ingredient: string,
  canonical: CanonicalAmount,
  category: string | null,
): Promise<ShoppingItem[]> {
  const unit = canonical.unit;
  const key = shoppingMergeKey(ingredient, unit);
  const match = existing.find(
    row => shoppingMergeKey(row.ingredient, row.unit ?? '') === key,
  );

  if (match) {
    const quantity = addQuantities(match.quantity, canonical.quantity);
    const { error } = await supabase
      .from('shopping_list')
      .update({ quantity })
      .eq('id', match.id);

    if (error) throw error;

    return existing.map(row =>
      row.id === match.id ? { ...row, quantity } : row,
    );
  }

  const position = nextPosition(existing);
  const { data, error } = await supabase
    .from('shopping_list')
    .insert({
      ingredient,
      quantity: canonical.quantity,
      unit,
      position,
      checked: false,
    })
    .select('id, ingredient, quantity, unit, checked, position, added_at, ingredients(category)')
    .single();

  if (error) throw error;
  const item = mapShoppingRow(data as ShoppingListRow);
  if (category != null) item.category = category;
  return [...existing, item];
}

/** Add recipe ingredients that have a shopping section; skip null-category names. */
export async function addRecipeIngredientsToList(
  ingredients: RecipeIngredientInput[],
): Promise<void> {
  if (ingredients.length === 0) return;

  const shoppable = await fetchShoppableNames(ingredients.map(ing => ing.ingredient));
  let existing = await fetchShoppingList();

  for (const ing of ingredients) {
    if (!shoppable.has(ing.ingredient)) continue;

    const canonical = toShoppingUnit(ing.quantity, ing.unit);
    existing = await upsertMerged(existing, ing.ingredient, canonical, null);
  }
}

/** Manually add one item (ingredient name is normalised). Caller must ensure the canonical row exists. */
export async function addManualItem(
  name: string,
  quantity: number | null,
  unit: string,
  category: string | null = null,
): Promise<void> {
  const ingredient = normalizeIngredient(name);
  if (!ingredient) throw new Error('Enter an ingredient name');

  const canonical = toShoppingUnit(quantity, unit);
  const existing = await fetchShoppingList();
  await upsertMerged(existing, ingredient, canonical, category);
}

export async function ensureIngredientForShopping(
  name: string,
  category: IngredientSection,
): Promise<string> {
  const ingredient = normalizeIngredient(name);
  if (!ingredient) throw new Error('Enter an ingredient name');

  const { error } = await supabase
    .from('ingredients')
    .upsert({ name: ingredient, category }, { onConflict: 'name' });

  if (error) throw error;
  return ingredient;
}

export async function fetchIngredientRegistry(): Promise<Set<string>> {
  const { data, error } = await supabase.from('ingredients').select('name');
  if (error) throw error;
  return new Set((data ?? []).map(r => r.name));
}

export async function lookupIngredientCategory(name: string): Promise<string | null> {
  const ingredient = normalizeIngredient(name);
  if (!ingredient) return null;

  const { data, error } = await supabase
    .from('ingredients')
    .select('category')
    .eq('name', ingredient)
    .maybeSingle();

  if (error) throw error;
  return data?.category ?? null;
}

export async function updateItem(
  id: number,
  fields: Partial<Pick<ShoppingItem, 'quantity' | 'unit' | 'checked' | 'position'>>,
): Promise<void> {
  const { error } = await supabase.from('shopping_list').update(fields).eq('id', id);
  if (error) throw error;
}

export async function deleteItem(id: number): Promise<void> {
  const { error } = await supabase.from('shopping_list').delete().eq('id', id);
  if (error) throw error;
}

export async function setItemOrder(orderedIds: number[]): Promise<void> {
  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from('shopping_list').update({ position: index + 1 }).eq('id', id),
    ),
  );
  const err = results.find(r => r.error)?.error;
  if (err) throw err;
}

export async function clearChecked(): Promise<void> {
  const { error } = await supabase
    .from('shopping_list')
    .delete()
    .eq('checked', true);
  if (error) throw error;
}

/** Remove every item from the shared list. */
export async function clearAllItems(): Promise<void> {
  const { error } = await supabase
    .from('shopping_list')
    .delete()
    .neq('id', 0);
  if (error) throw error;
}

export function subscribeShoppingList(onChange: () => void): () => void {
  const channel = supabase
    .channel('shopping_list_changes')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'shopping_list' },
      () => onChange(),
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
