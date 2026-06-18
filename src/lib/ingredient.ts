import pluralize from 'pluralize';

/**
 * Words that look plural but should not be singularised.
 * e.g. "angostura bitters" must stay "bitters", not "bitter".
 */
const PLURAL_EXCEPTIONS = new Set([
  'bitters',
  'scissors',
  'shears',
  'tongs',
  'pliers',
  'greens',
  'chips',
  'crisps',
  'grits',
  'oats',
  'lentils',
  'noodles',
  'sprouts',
]);

/**
 * Normalise free-text ingredient input to a canonical `ingredient` column value:
 * lowercase, trimmed, last word singularised via pluralize (handles potato/potatoes,
 * leaf/leaves, berry/berries, etc.).
 */
export function normalizeIngredient(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return '';

  const words = trimmed.split(/\s+/);
  const last = words[words.length - 1];

  if (!PLURAL_EXCEPTIONS.has(last)) {
    words[words.length - 1] = pluralize.singular(last);
  }

  return words.join(' ');
}

/**
 * Display-only: pluralise the last word when qty > 1 and unit is 'each'.
 * Stored canonical values stay singular.
 */
export function displayIngredientName(
  name: string,
  quantity: number | string | null,
  unit: string | null,
): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;

  const qty = quantity != null ? Number(quantity) : null;
  if (qty == null || qty <= 1 || unit !== 'each') return trimmed;

  const words = trimmed.split(/\s+/);
  const last = words[words.length - 1];
  const lastLower = last.toLowerCase();

  if (PLURAL_EXCEPTIONS.has(lastLower)) return trimmed;

  words[words.length - 1] = pluralize.plural(last);
  return words.join(' ');
}
