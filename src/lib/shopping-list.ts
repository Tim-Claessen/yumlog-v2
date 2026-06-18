import { supabase } from './supabase';
import { normalizeIngredient } from './ingredient';
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
}

export interface RecipeIngredientInput {
  ingredient: string;
  quantity: number | null;
  unit: string | null;
}

export async function fetchShoppingList(): Promise<ShoppingItem[]> {
  const { data, error } = await supabase
    .from('shopping_list')
    .select('*')
    .order('position', { ascending: true, nullsFirst: false })
    .order('added_at', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

function nextPosition(items: ShoppingItem[]): number {
  const max = items.reduce((m, row) => Math.max(m, row.position ?? 0), 0);
  return max + 1;
}

async function upsertMerged(
  existing: ShoppingItem[],
  ingredient: string,
  canonical: CanonicalAmount,
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
    .select()
    .single();

  if (error) throw error;
  return [...existing, data];
}

/** Add all recipe ingredients to the shared list, merging by ingredient + unit. */
export async function addRecipeIngredientsToList(
  ingredients: RecipeIngredientInput[],
): Promise<void> {
  let existing = await fetchShoppingList();

  for (const ing of ingredients) {
    const canonical = toShoppingUnit(ing.quantity, ing.unit);
    existing = await upsertMerged(existing, ing.ingredient, canonical);
  }
}

/** Manually add one item (ingredient name is normalised). */
export async function addManualItem(
  name: string,
  quantity: number | null,
  unit: string,
): Promise<void> {
  const ingredient = normalizeIngredient(name);
  if (!ingredient) throw new Error('Enter an ingredient name');

  const canonical = toShoppingUnit(quantity, unit);
  const existing = await fetchShoppingList();
  await upsertMerged(existing, ingredient, canonical);
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
