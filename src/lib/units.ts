/**
 * Shopping-list unit conversion.
 *
 * Rule: 1 g = 1 mL — all weight/volume becomes grams.
 * Counts become 'each'. Pinch/dash/sprig/handful/to taste pass through unchanged.
 */

export interface CanonicalAmount {
  quantity: number | null;
  unit: string;
}

/** Weight and volume units → grams (multiply quantity by this factor). */
const TO_GRAMS: Record<string, number> = {
  g: 1,
  kg: 1000,
  mg: 0.001,
  ml: 1,
  l: 1000,
  tsp: 5,
  tbsp: 15,
  cup: 240,
  oz: 28,
  lb: 454,
};

/** Count-style units → stored as 'each'. */
const COUNT_UNITS = new Set([
  'each', 'whole', 'clove', 'slice',
  'piece', 'tin', 'can', 'sheet', 'stalk', 'stick', 'head', 'bunch',
]);

/** Pass-through units → stored under their canonical singular name. */
const PASSTHROUGH_CANONICAL: Record<string, string> = {
  pinch: 'pinch', pinches: 'pinch',
  dash: 'dash', dashes: 'dash',
  sprig: 'sprig', sprigs: 'sprig',
  handful: 'handful', handfuls: 'handful',
  part: 'part', parts: 'part',
};

function unitKey(raw: string): string {
  const u = raw.toLowerCase().trim();
  if (TO_GRAMS[u] != null) return u;
  if (u.endsWith('es') && TO_GRAMS[u.slice(0, -2)] != null) return u.slice(0, -2);
  if (u.endsWith('s') && TO_GRAMS[u.slice(0, -1)] != null) return u.slice(0, -1);
  return u;
}

function isCountUnit(raw: string): boolean {
  const u = raw.toLowerCase().trim();
  if (COUNT_UNITS.has(u)) return true;
  // simple plural: cloves → clove
  if (u.endsWith('s') && COUNT_UNITS.has(u.slice(0, -1))) return true;
  if (u.endsWith('es') && COUNT_UNITS.has(u.slice(0, -2))) return true;
  return false;
}

/**
 * Convert a recipe-ingredient amount to its shopping-list canonical form.
 */
export function toShoppingUnit(quantity: number | null, unit: string | null): CanonicalAmount {
  const raw = (unit ?? 'each').toLowerCase().trim();

  if (raw.includes('taste')) {
    return { quantity, unit: 'to taste' };
  }

  const pass = PASSTHROUGH_CANONICAL[raw];
  if (pass) {
    return { quantity, unit: pass };
  }

  if (isCountUnit(raw)) {
    return { quantity, unit: 'each' };
  }

  const key = unitKey(raw);
  const factor = TO_GRAMS[key];
  if (factor != null) {
    if (quantity == null) return { quantity: null, unit: 'g' };
    return { quantity: quantity * factor, unit: 'g' };
  }

  // Unknown unit — pass through unchanged
  return { quantity, unit: raw };
}

/** Add two shopping-list quantities (null-safe). */
export function addQuantities(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** Format quantity + unit for display ('each' is omitted). */
export function formatShoppingAmount(quantity: number | null, unit: string | null): string {
  if (quantity == null && !unit) return '';
  const qty = quantity != null ? String(+quantity) : '';
  const u = unit === 'each' ? '' : (unit ?? '');
  return [qty, u].filter(Boolean).join(' ');
}

/** Composite key for merging rows: same ingredient + canonical unit. */
export function shoppingMergeKey(ingredient: string, unit: string): string {
  return `${ingredient}\0${unit}`;
}
