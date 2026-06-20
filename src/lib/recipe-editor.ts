import { supabase } from './supabase';
import { titleToSlug } from './slug';
import { normalizeIngredient } from './ingredient';
import type { IngredientSection } from './ingredient-sections';

export const UNIT_OPTIONS = [
  'g', 'kg', 'mg', 'ml', 'l', 'cup', 'tsp', 'tbsp', 'oz', 'lb',
  'each', 'pinch', 'dash', 'handful', 'sprig', 'part',
] as const;

export type Unit = (typeof UNIT_OPTIONS)[number];

export interface IngredientRow {
  quantity: string;
  unit: string;
  name: string;
  /** Set when user picks an autocomplete suggestion (canonical DB value). */
  pickedCanonical: string | null;
}

export interface RecipeFormData {
  title: string;
  category: string;
  protein: string;
  cookTimeMin: string;
  sourceUrl: string;
  methodSteps: string[];
  tips: string[];
  substitutions: string[];
  ingredients: IngredientRow[];
}

interface RecipeRecord {
  slug: string;
  title: string;
  category: string | null;
  protein: string | null;
  cook_time_min: number | null;
  method: string;
  tips: string | null;
  substitutions: string | null;
  source_url: string | null;
}

interface IngredientRecord {
  quantity: number | null;
  unit: string | null;
  display_name: string | null;
  ingredient: string;
}

export async function fetchKnownIngredients(): Promise<string[]> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('name')
    .order('name');

  if (error) throw error;
  return (data ?? []).map(r => r.name);
}

/** Canonical names with a shopping section (excludes water, aquafaba, etc.). */
export async function fetchShoppableIngredients(): Promise<string[]> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('name')
    .not('category', 'is', null)
    .order('name');

  if (error) throw error;
  return (data ?? []).map(r => r.name);
}

export async function fetchIngredientNames(): Promise<Set<string>> {
  const { data, error } = await supabase.from('ingredients').select('name');
  if (error) throw error;
  return new Set((data ?? []).map(r => r.name));
}

export function resolveCanonicalIngredient(row: IngredientRow): string | null {
  const name = row.name.trim();
  if (!name) return null;
  const canonical = row.pickedCanonical ?? normalizeIngredient(name);
  return canonical || null;
}

/** Distinct canonical names from ingredient rows (form order preserved). */
export function collectCanonicalNames(rows: IngredientRow[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const row of rows) {
    const canonical = resolveCanonicalIngredient(row);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    names.push(canonical);
  }

  return names;
}

export function findUnknownIngredients(
  canonicalNames: string[],
  existing: Set<string>,
): string[] {
  return canonicalNames.filter(name => !existing.has(name));
}

export async function upsertIngredientCategories(
  categories: Record<string, IngredientSection>,
): Promise<void> {
  const rows = Object.entries(categories).map(([name, category]) => ({
    name,
    category,
  }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('ingredients')
    .upsert(rows, { onConflict: 'name' });

  if (error) throw error;
}

export async function fetchFilterOptions(): Promise<{ categories: string[]; proteins: string[] }> {
  const { data, error } = await supabase
    .from('recipes')
    .select('category, protein');

  if (error) throw error;

  const categories = new Set<string>();
  const proteins = new Set<string>();

  for (const row of data ?? []) {
    if (row.category) categories.add(row.category.trim());
    if (row.protein) {
      for (const p of row.protein.split(',')) {
        const v = p.trim();
        if (v) proteins.add(v);
      }
    }
  }

  return {
    categories: [...categories].sort(),
    proteins: [...proteins].sort(),
  };
}

export async function loadRecipe(slug: string): Promise<{ recipe: RecipeRecord; ingredients: IngredientRecord[] }> {
  const [{ data: recipe, error: recipeErr }, { data: ingredients, error: ingrErr }] = await Promise.all([
    supabase.from('recipes').select('*').eq('slug', slug).single(),
    supabase.from('recipe_ingredients').select('quantity, unit, display_name, ingredient').eq('recipe_slug', slug).order('id'),
  ]);

  if (recipeErr) throw recipeErr;
  if (ingrErr) throw ingrErr;
  if (!recipe) throw new Error('Recipe not found');

  return { recipe, ingredients: ingredients ?? [] };
}

export function recipeToFormData(recipe: RecipeRecord, ingredients: IngredientRecord[]): RecipeFormData {
  return {
    title: recipe.title,
    category: recipe.category ?? '',
    protein: recipe.protein ?? '',
    cookTimeMin: recipe.cook_time_min != null ? String(recipe.cook_time_min) : '',
    sourceUrl: recipe.source_url ?? '',
    methodSteps: (recipe.method ?? '').split('\n').map(l => l.trim()).filter(Boolean),
    tips: (recipe.tips ?? '').split('\n').map(l => l.trim()).filter(Boolean),
    substitutions: (recipe.substitutions ?? '').split('\n').map(l => l.trim()).filter(Boolean),
    ingredients: ingredients.map(ing => ({
      quantity: ing.quantity != null ? String(ing.quantity) : '',
      unit: ing.unit ?? 'each',
      name: ing.display_name ?? ing.ingredient,
      pickedCanonical: ing.ingredient,
    })),
  };
}

export function emptyIngredientRow(): IngredientRow {
  return { quantity: '', unit: 'each', name: '', pickedCanonical: null };
}

export function emptyFormData(): RecipeFormData {
  return {
    title: '',
    category: '',
    protein: '',
    cookTimeMin: '',
    sourceUrl: '',
    methodSteps: [''],
    tips: [],
    substitutions: [],
    ingredients: [emptyIngredientRow()],
  };
}

async function uniqueSlug(base: string, excludeSlug?: string): Promise<string> {
  let candidate = base;
  let n = 2;

  while (true) {
    if (candidate === excludeSlug) return candidate;

    const { data } = await supabase
      .from('recipes')
      .select('slug')
      .eq('slug', candidate)
      .maybeSingle();

    if (!data) return candidate;
    candidate = `${base}-${n++}`;
  }
}

function linesFromList(items: string[]): string | null {
  const lines = items.map(s => s.trim()).filter(Boolean);
  return lines.length > 0 ? lines.join('\n') : null;
}

export async function saveRecipe(
  form: RecipeFormData,
  editSlug: string | null,
  newIngredientCategories: Record<string, IngredientSection> = {},
): Promise<{ slug: string; isNew: boolean }> {
  const title = form.title.trim();
  if (!title) throw new Error('Title is required');

  const methodSteps = form.methodSteps.map(s => s.trim()).filter(Boolean);
  if (methodSteps.length === 0) throw new Error('Add at least one method step');

  const ingredientRows = form.ingredients
    .map(row => {
      const name = row.name.trim();
      if (!name) return null;
      const canonical = resolveCanonicalIngredient(row);
      if (!canonical) return null;
      return {
        quantity: row.quantity.trim() ? Number(row.quantity) : null,
        unit: row.unit || null,
        display_name: name,
        ingredient: canonical,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r != null);

  const canonicalNames = ingredientRows.map(r => r.ingredient);
  const existing = await fetchIngredientNames();
  const unknown = findUnknownIngredients(canonicalNames, existing);

  for (const name of unknown) {
    if (!newIngredientCategories[name]) {
      throw new Error(`Pick a shopping section for “${name}”.`);
    }
  }

  if (unknown.length > 0) {
    await upsertIngredientCategories(
      Object.fromEntries(
        unknown.map(name => [name, newIngredientCategories[name]]),
      ) as Record<string, IngredientSection>,
    );
  }

  const slug = editSlug ?? await uniqueSlug(titleToSlug(title));

  const recipePayload = {
    slug,
    title,
    category: form.category.trim() || null,
    protein: form.protein.trim() || null,
    cook_time_min: form.cookTimeMin.trim() ? Number(form.cookTimeMin) : null,
    method: methodSteps.join('\n'),
    tips: linesFromList(form.tips),
    substitutions: linesFromList(form.substitutions),
    source_url: form.sourceUrl.trim() || null,
  };

  if (editSlug) {
    const { error } = await supabase
      .from('recipes')
      .update({
        title: recipePayload.title,
        category: recipePayload.category,
        protein: recipePayload.protein,
        cook_time_min: recipePayload.cook_time_min,
        method: recipePayload.method,
        tips: recipePayload.tips,
        substitutions: recipePayload.substitutions,
        source_url: recipePayload.source_url,
      })
      .eq('slug', editSlug);

    if (error) throw error;

    const { error: delErr } = await supabase
      .from('recipe_ingredients')
      .delete()
      .eq('recipe_slug', editSlug);

    if (delErr) throw delErr;
  } else {
    const { error } = await supabase.from('recipes').insert(recipePayload);
    if (error) throw error;
  }

  if (ingredientRows.length > 0) {
    const { error } = await supabase.from('recipe_ingredients').insert(
      ingredientRows.map(row => ({
        recipe_slug: slug,
        ...row,
      })),
    );
    if (error) throw error;
  }

  return { slug, isNew: !editSlug };
}

/** Filter known ingredients for autocomplete (case-insensitive substring match). */
export function matchIngredients(query: string, known: string[], limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  return known
    .filter(ing => ing.includes(q))
    .slice(0, limit);
}
