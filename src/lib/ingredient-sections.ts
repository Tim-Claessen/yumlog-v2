/** Fixed shopping-list sections — must match ingredients_category_check in Postgres. */
export const INGREDIENT_SECTION_ORDER = [
  'fresh produce',
  'breakfast',
  'tinned',
  'spices',
  'international food',
  'other pantry',
  'baking',
  'snacks',
  'drinks',
  'fridge',
  'freezer',
] as const;

export type IngredientSection = (typeof INGREDIENT_SECTION_ORDER)[number];

/** All valid sections (same set as order — walk-the-shop sequence). */
export const INGREDIENT_SECTIONS: readonly IngredientSection[] = INGREDIENT_SECTION_ORDER;

export function isIngredientSection(value: string): value is IngredientSection {
  return (INGREDIENT_SECTIONS as readonly string[]).includes(value);
}

export function sectionDisplayLabel(section: IngredientSection): string {
  return section.replace(/\b\w/g, c => c.toUpperCase());
}

export function sectionSortIndex(category: string | null | undefined): number {
  if (!category) return INGREDIENT_SECTION_ORDER.length;
  const idx = INGREDIENT_SECTION_ORDER.indexOf(category as IngredientSection);
  return idx >= 0 ? idx : INGREDIENT_SECTION_ORDER.length;
}
