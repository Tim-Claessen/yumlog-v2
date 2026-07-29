// Sourdough loaf scaling — pure baker's-percentage maths, no DOM and no Supabase.
// Ratios are read from the `sourdough-bread` recipe at build time and passed in.

export interface LoafRatios {
  /** Total flour in the recipe as stored, e.g. 550 g — one "standard loaf". */
  standardFlourG: number;
  /** Wholemeal as a share of total flour in the stored recipe, e.g. 0.0909. */
  standardWholemealShare: number;
  /** Water as a share of total flour, e.g. 0.70. */
  hydration: number;
  /** Salt as a share of total flour, e.g. 0.02. */
  saltPct: number;
  /** Starter as a share of total flour, e.g. 0.20. */
  starterPct: number;
}

/**
 * The recipe as stored on 2026-07-29. Used only if the recipe row or one of its
 * ingredient lines goes missing, so the calculator can never break the build.
 */
export const FALLBACK_RATIOS: LoafRatios = {
  standardFlourG: 550,
  standardWholemealShare: 50 / 550,
  hydration: 385 / 550,
  saltPct: 11 / 550,
  starterPct: 110 / 550,
};

export interface LoafQuantities {
  totalFlourG: number;
  whiteFlourG: number;
  wholemealFlourG: number;
  waterG: number;
  saltG: number;
  starterG: number;
  doughWeightG: number;
  /** Hydration once the water already in the starter is counted. */
  trueHydration: number;
}

function roundTo(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Scale the loaf. `loaves` multiplies total flour; `wholemealShare` splits that
 * flour between wholemeal and white without changing total flour, so hydration,
 * salt and starter are unaffected by the wholemeal tweak.
 */
export function scaleLoaf(
  ratios: LoafRatios,
  loaves: number,
  wholemealShare: number,
): LoafQuantities {
  const totalFlourG = roundTo(ratios.standardFlourG * loaves, 1);
  const wholemealFlourG = roundTo(totalFlourG * wholemealShare, 1);
  const whiteFlourG = totalFlourG - wholemealFlourG;
  const waterG = roundTo(totalFlourG * ratios.hydration, 1);
  const saltG = roundTo(totalFlourG * ratios.saltPct, 0.5);
  const starterG = roundTo(totalFlourG * ratios.starterPct, 1);

  // A 1:1:1 starter sits at roughly half flour, half water by weight, so it
  // carries hidden water the stated 70% doesn't account for.
  const starterFlourG = starterG / 2;
  const trueHydration = (waterG + starterFlourG) / (totalFlourG + starterFlourG);

  return {
    totalFlourG,
    whiteFlourG,
    wholemealFlourG,
    waterG,
    saltG,
    starterG,
    doughWeightG: Math.round(totalFlourG + waterG + saltG + starterG),
    trueHydration,
  };
}

/** Trim trailing zeroes: 49.5 → "49.5", 50.0 → "50". */
export function formatGrams(value: number): string {
  return String(+value.toFixed(1));
}

/** 0.5 → "½ loaf", 1 → "1 loaf", 1.5 → "1½ loaves", 3 → "3 loaves". */
export function formatLoaves(loaves: number): string {
  const whole = Math.floor(loaves);
  const half = loaves - whole >= 0.5;
  const count = whole === 0 ? '½' : `${whole}${half ? '½' : ''}`;
  return `${count} ${loaves <= 1 ? 'loaf' : 'loaves'}`;
}
