import { supabase } from './supabase';
import { normalizeIngredient } from './ingredient';
import { isIngredientSection, type IngredientSection } from './ingredient-sections';

export interface CanonicalIngredient {
  name: string;
  category: IngredientSection | null;
}

export interface ReferenceCounts {
  recipeLines: number;
  distinctRecipes: number;
  shoppingListRows: number;
}

export interface RecipeUsage {
  slug: string;
  title: string;
}

export type NameValidation =
  | { ok: true; normalized: string }
  | { ok: false; error: string };

const NOT_SHOPPED = '';

export function categoryToSelectValue(category: IngredientSection | null): string {
  return category ?? NOT_SHOPPED;
}

export function selectValueToCategory(value: string): IngredientSection | null {
  if (value === NOT_SHOPPED || value === '') return null;
  if (!isIngredientSection(value)) {
    throw new Error('Pick a valid shopping section.');
  }
  return value;
}

export function validateCanonicalName(input: string, currentName?: string): NameValidation {
  const normalized = normalizeIngredient(input);
  if (!normalized) {
    return { ok: false, error: 'Name cannot be empty.' };
  }
  if (currentName && normalized === currentName) {
    return { ok: true, normalized };
  }
  return { ok: true, normalized };
}

export async function fetchAllCanonicalIngredients(): Promise<CanonicalIngredient[]> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('name, category')
    .order('name');

  if (error) throw error;

  return (data ?? []).map(row => ({
    name: row.name,
    category: row.category && isIngredientSection(row.category) ? row.category : null,
  }));
}

export async function ingredientExists(name: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('name')
    .eq('name', name)
    .maybeSingle();

  if (error) throw error;
  return data != null;
}

export async function getReferenceCounts(name: string): Promise<ReferenceCounts> {
  const [{ count: recipeLines, error: lineErr }, { data: slugRows, error: slugErr }, { count: shoppingListRows, error: listErr }] =
    await Promise.all([
      supabase
        .from('recipe_ingredients')
        .select('*', { count: 'exact', head: true })
        .eq('ingredient', name),
      supabase
        .from('recipe_ingredients')
        .select('recipe_slug')
        .eq('ingredient', name),
      supabase
        .from('shopping_list')
        .select('*', { count: 'exact', head: true })
        .eq('ingredient', name),
    ]);

  if (lineErr) throw lineErr;
  if (slugErr) throw slugErr;
  if (listErr) throw listErr;

  const distinctRecipes = new Set((slugRows ?? []).map(r => r.recipe_slug)).size;

  return {
    recipeLines: recipeLines ?? 0,
    distinctRecipes,
    shoppingListRows: shoppingListRows ?? 0,
  };
}

export async function getRecipesUsing(name: string): Promise<RecipeUsage[]> {
  const { data, error } = await supabase
    .from('recipe_ingredients')
    .select('recipe_slug, recipes!inner(title)')
    .eq('ingredient', name);

  if (error) throw error;

  const bySlug = new Map<string, string>();
  for (const row of data ?? []) {
    const slug = row.recipe_slug as string;
    const title = (row.recipes as { title: string }).title;
    if (!bySlug.has(slug)) bySlug.set(slug, title);
  }

  return [...bySlug.entries()]
    .map(([slug, title]) => ({ slug, title }))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function updateIngredientCategory(
  name: string,
  category: IngredientSection | null,
): Promise<void> {
  const { error } = await supabase
    .from('ingredients')
    .update({ category })
    .eq('name', name);

  if (error) throw error;
}

/** Rename canonical row; FK on update cascade repoints child rows. Triggers rebuild via RPC when available. */
export async function renameCanonicalIngredient(
  oldName: string,
  newName: string,
): Promise<{ distinctRecipes: number; rebuildTriggered: boolean }> {
  if (oldName === newName) {
    return { distinctRecipes: 0, rebuildTriggered: false };
  }

  const counts = await getReferenceCounts(oldName);

  const { error: renameErr } = await supabase
    .from('ingredients')
    .update({ name: newName })
    .eq('name', oldName);

  if (renameErr) throw renameErr;

  let rebuildTriggered = false;
  if (counts.distinctRecipes > 0) {
    const { error: touchErr } = await supabase.rpc('touch_recipes_for_ingredient', {
      p_ingredient: newName,
    });
    if (touchErr) {
      console.warn('touch_recipes_for_ingredient failed — run scripts/ingredient-registry-rpc.sql', touchErr);
    } else {
      rebuildTriggered = true;
    }
  }

  return { distinctRecipes: counts.distinctRecipes, rebuildTriggered };
}

export async function mergeCanonicalIngredients(
  sourceName: string,
  targetName: string,
): Promise<{ recipeLines: number; shoppingListRows: number }> {
  const { data, error } = await supabase.rpc('merge_ingredients', {
    p_source: sourceName,
    p_target: targetName,
  });

  if (error) throw error;

  return {
    recipeLines: data?.recipe_lines ?? 0,
    shoppingListRows: data?.shopping_list_rows ?? 0,
  };
}

export async function deleteCanonicalIngredient(name: string): Promise<void> {
  const counts = await getReferenceCounts(name);
  if (counts.recipeLines > 0 || counts.shoppingListRows > 0) {
    throw new Error('Cannot delete an ingredient that is still in use.');
  }

  const { error } = await supabase.from('ingredients').delete().eq('name', name);
  if (error) throw error;
}
