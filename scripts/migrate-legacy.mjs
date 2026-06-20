#!/usr/bin/env node
/**
 * scripts/migrate-legacy.mjs
 * One-off migration: legacy Jekyll recipes in /legacy/recipes/ → Supabase.
 *
 * Run from the project root:
 *   node scripts/migrate-legacy.mjs
 *
 * ⚠️  PASTE your service-role key below, run once, then DELETE IT.
 *     Never commit this file with a real key in it.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  PASTE YOUR SERVICE ROLE KEY BELOW — REMOVE IT BEFORE COMMITTING  ⚠️
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = "https://nrmimftrjulvsgonrlzg.supabase.co";
const SERVICE_ROLE_KEY = "PASTE_SERVICE_ROLE_KEY_HERE";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RECIPES_DIR = resolve(__dirname, "../legacy/recipes");

// ── Units recognised by the ingredient parser ────────────────────────────────

const SEP_UNITS = [
  "tablespoons?",
  "tbsp",
  "tbs",
  "tb",
  "teaspoons?",
  "tsp",
  "cups?",
  "oz",
  "lbs?",
  "lb",
  // weight/volume with a space (e.g. "1.5 kg", "112.5 g")
  "kg",
  "mg",
  "ml",
  "g",
  "l",
  "cloves?",
  "whole",
  "each",
  "pieces?",
  "tins?",
  "cans?",
  "slices?",
  "sheets?",
  "stalks?",
  "sticks?",
  "heads?",
  "bunches?",
  "bunch",
  "parts?", // cocktail ratios
  "sprigs?",
  "pinch(?:es)?",
  "dash(?:es)?",
  "handful",
];

// Regex alternation of all recognised separated-unit spellings
const SEP_UNIT_RE = new RegExp(
  `^(\\d+(?:\\.\\d+)?)\\s+(${SEP_UNITS.join("|")})\\s+(.+)`,
  "i",
);
const MIXED_FRAC_UNIT_RE = new RegExp(
  `^(\\d+)\\s+(\\d+\\/\\d+)\\s+(${SEP_UNITS.join("|")})\\s+(.+)`,
  "i",
);
const FRAC_UNIT_RE = new RegExp(
  `^(\\d+\\/\\d+)\\s+(${SEP_UNITS.join("|")})\\s+(.+)`,
  "i",
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFraction(s) {
  if (typeof s !== "string") return parseFloat(s);
  if (s.includes("/")) {
    const [n, d] = s.split("/");
    return parseInt(n, 10) / parseInt(d, 10);
  }
  return parseFloat(s);
}

function canonicalUnit(raw) {
  const u = raw.toLowerCase().replace(/s$/, ""); // naive deplural
  const map = {
    g: "g",
    kg: "kg",
    mg: "mg",
    ml: "ml",
    l: "l",
    tsp: "tsp",
    teaspoon: "tsp",
    tbsp: "tbsp",
    tbs: "tbsp",
    tb: "tbsp",
    tablespoon: "tbsp",
    cup: "cup",
    oz: "oz",
    lb: "lb",
    // count-style → 'each'
    clove: "each",
    whole: "each",
    each: "each",
    piece: "each",
    tin: "each",
    can: "each",
    slice: "each",
    sheet: "each",
    stalk: "each",
    stick: "each",
    head: "each",
    bunch: "each",
    // pass-through
    part: "part",
    pinch: "pinch",
    dash: "dash",
    sprig: "sprig",
    handful: "handful",
  };
  return map[u] ?? raw.toLowerCase();
}

/** Strip leading size/freshness adjectives the schema calls for normalisation. */
function normalizeIngredient(displayName) {
  let name = displayName
    .split(",")[0]
    .replace(/\(.*?\)/g, "") // strip parentheticals
    .trim()
    .toLowerCase();

  const STRIP_LEADING = [
    "fresh ",
    "dried ",
    "frozen ",
    "canned ",
    "tinned ",
    "raw ",
    "cooked ",
    "baby ",
    "button ",
    "large ",
    "small ",
    "medium ",
    "big ",
    "finely ",
    "roughly ",
    "thinly ",
  ];
  for (const pfx of STRIP_LEADING) {
    if (name.startsWith(pfx)) {
      name = name.slice(pfx.length).trim();
      break; // one pass is enough
    }
  }

  return name;
}

/**
 * Parse one ingredient bullet line.
 * Returns { quantity, unit, displayName, ingredient, flagged, reason }.
 */
function parseIngredientLine(rawLine) {
  const flag = (reason, displayName = rawLine) => ({
    quantity: null,
    unit: null,
    displayName,
    ingredient: normalizeIngredient(displayName),
    flagged: true,
    reason,
  });

  let text = rawLine.replace(/^-\s*/, "").trim();
  if (!text) return null;

  // Strip optional markers (with or without colon: "_Optional:_" and "_optional_")
  text = text
    .replace(/^[_*]{0,2}\s*[Oo]ptional[:]?\s*[_*]{0,2}\s*/i, "")
    .trim();

  // Unicode fractions → ASCII. Handle "1½" (digit-glued) before standalone "½".
  text = text
    .replace(/(\d)½/g, "$1 1/2")
    .replace(/(\d)¼/g, "$1 1/4")
    .replace(/(\d)¾/g, "$1 3/4")
    .replace(/(\d)⅓/g, "$1 1/3")
    .replace(/(\d)⅔/g, "$1 2/3")
    .replace(/(\d)⅛/g, "$1 1/8")
    .replace(/½/g, "1/2")
    .replace(/¼/g, "1/4")
    .replace(/¾/g, "3/4")
    .replace(/⅓/g, "1/3")
    .replace(/⅔/g, "2/3")
    .replace(/⅛/g, "1/8")
    .replace(/⅜/g, "3/8");

  // Normalise dashes (en-dash, em-dash → hyphen) so range detection works uniformly
  text = text.replace(/[–—]/g, "-");

  // Handle ranges: "3-4 cloves" / "1/2-1 tsp" → take lower bound
  const rangeM = text.match(/^(\d+(?:\/\d+)?)-(\d+(?:\/\d+)?)\s+(.*)/);
  if (rangeM) {
    text = String(parseFraction(rangeM[1])) + " " + rangeM[3];
  }

  // Strip parenthetical annotations that sit BEFORE the ingredient (e.g. "¼ (35g) cup flour")
  // Also strips trailing parentheticals like "(or pork neck)" cleanly.
  text = text
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Strip Hello-Fresh allergen numbers at the tail FIRST — must happen before the
  // multi-ingredient check so "seasoning 1,6,17" doesn't look like two ingredients.
  text = text.replace(/\s+\d+(,\d+)*$/, "").trim();

  // Flag: multiple quantity-bearing ingredients on one line (e.g. "2 bay leaves, 4 sprigs thyme")
  if (/,\s*\d+/.test(text)) {
    return flag(
      "Multiple ingredients on one line — split manually",
      text.split(",")[0].trim(),
    );
  }

  // Special: "Dash/Pinch/Handful of X"
  const dashOf = text.match(/^(dash|pinch|handful|sprig)\s+of\s+(.+)/i);
  if (dashOf) {
    const dn = dashOf[2].split(",")[0].trim();
    return {
      quantity: null,
      unit: canonicalUnit(dashOf[1]),
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Special: "N x Mg [unit-word] ingredient" e.g. "2 x 400g tins chickpeas"
  const mult = text.match(
    /^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)(g|kg|mg|ml|l)\s+(.*)/i,
  );
  if (mult) {
    const qty = parseFloat(mult[1]) * parseFloat(mult[2]);
    const unit = canonicalUnit(mult[3]);
    // strip container noun (tins, cans, etc.) if it leads the remainder
    const rest = mult[4]
      .replace(/^(tins?|cans?|packs?|packets?)\s+/i, "")
      .trim();
    const dn = rest.split(",")[0].trim();
    return {
      quantity: qty,
      unit,
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Attached unit (no space): "200g", "1.5kg", "385g"
  const attached = text.match(/^(\d+(?:\.\d+)?)(g|kg|mg|ml|l)\s+(.*)/i);
  if (attached) {
    const dn = attached[3].split(",")[0].trim();
    return {
      quantity: parseFloat(attached[1]),
      unit: canonicalUnit(attached[2]),
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Mixed fraction + unit: "1 1/2 tbsp"
  const mfrac = text.match(MIXED_FRAC_UNIT_RE);
  if (mfrac) {
    const qty = parseInt(mfrac[1], 10) + parseFraction(mfrac[2]);
    const dn = mfrac[4].split(",")[0].trim();
    return {
      quantity: qty,
      unit: canonicalUnit(mfrac[3]),
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Simple fraction + unit: "1/2 tsp"
  const sfrac = text.match(FRAC_UNIT_RE);
  if (sfrac) {
    const dn = sfrac[3].split(",")[0].trim();
    return {
      quantity: parseFraction(sfrac[1]),
      unit: canonicalUnit(sfrac[2]),
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Integer/decimal + unit: "2 tbsp" / "1.5 cups"
  const sepUnit = text.match(SEP_UNIT_RE);
  if (sepUnit) {
    const dn = sepUnit[3].split(",")[0].trim();
    return {
      quantity: parseFraction(sepUnit[1]),
      unit: canonicalUnit(sepUnit[2]),
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // Integer/fraction + rest (no recognised unit): "2 garlic cloves", "3 ripe avocados"
  const noUnit = text.match(/^(\d+(?:\/\d+)?)\s+(.+)/);
  if (noUnit) {
    const dn = noUnit[2].split(",")[0].trim();
    return {
      quantity: parseFraction(noUnit[1]),
      unit: "each",
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  // No number at all: "Coriander, to finish" / "Ice"
  if (/^[a-zA-Z]/.test(text)) {
    const dn = text.split(",")[0].trim();
    return {
      quantity: null,
      unit: null,
      displayName: dn,
      ingredient: normalizeIngredient(dn),
      flagged: false,
      reason: null,
    };
  }

  return flag("Could not parse", text);
}

/** Very minimal YAML frontmatter parser (handles the subset used in this repo). */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result = {};
  let currentKey = null;

  for (const raw of match[1].split("\n")) {
    const line = raw.replace(/\r$/, "");

    // Array item (indented dash)
    if (/^\s+-\s/.test(line) && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      let val = line.replace(/^\s+-\s+/, "").trim();
      // Strip [[wikilink]] and surrounding quotes
      val = val
        .replace(/^["']?\[\[(.+?)\]\]["']?$/, "$1")
        .replace(/^["']|["']$/g, "");
      result[currentKey].push(val);
      continue;
    }

    // Key: value
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      currentKey = kv[1];
      let val = kv[2].trim();
      val = val
        .replace(/^["']?\[\[(.+?)\]\]["']?$/, "$1")
        .replace(/^["']|["']$/g, "");
      result[currentKey] = val || null;
    }
  }

  return result;
}

function titleToSlug(title) {
  return title
    .toLowerCase()
    .replace(/['']/g, "") // smart apostrophes
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Extract the ingredient bullet lines from between ## Ingredients and the next ## heading. */
function extractIngredients(body) {
  const ingMatch = body.match(
    /##\s+Ingredients\s*\r?\n([\s\S]*?)(?=\n##\s|\s*$)/i,
  );
  if (!ingMatch) return [];
  return ingMatch[1]
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l.startsWith("-"));
}

/**
 * Extract a named markdown section (everything between ## Heading and the next ##).
 * Returns the raw trimmed content, or null if the section is absent or empty.
 */
function extractSection(body, ...headingPatterns) {
  for (const pattern of headingPatterns) {
    const re = new RegExp(
      `##\\s+${pattern}\\s*\\r?\\n([\\s\\S]*?)(?=\\n##\\s|\\s*$)`,
      "i",
    );
    const m = body.match(re);
    if (m) {
      const content = m[1].replace(/\r\n/g, "\n").trim();
      return content || null;
    }
  }
  return null;
}

/**
 * Extract step-by-step instructions, storing one step per line.
 * Strips the leading "N." / "N)" numbering; keeps any bold labels.
 */
function extractInstructions(body) {
  const raw = extractSection(body, "Instructions?", "Method");
  if (!raw) return "";
  const steps = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
  return steps.join("\n");
}

/**
 * Extract a bullet-list section, storing one item per line (bullet stripped).
 */
function extractBullets(body, ...headingPatterns) {
  const raw = extractSection(body, ...headingPatterns);
  if (!raw) return null;
  const items = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  return items.length > 0 ? items.join("\n") : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (SERVICE_ROLE_KEY === "PASTE_SERVICE_ROLE_KEY_HERE") {
    console.error(
      "\n⚠️  No service-role key set. Edit this file and paste your key.\n",
    );
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const files = readdirSync(RECIPES_DIR).filter((f) => f.endsWith(".md"));

  let totalRecipes = 0;
  let totalIngr = 0;
  const flaggedLines = []; // { file, line, reason }
  const errors = []; // { file, message }

  console.log("\n─────────────────────────────────────────────────────────");
  console.log(`  Yumlog legacy migration — ${files.length} files found`);
  console.log("─────────────────────────────────────────────────────────\n");

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const filepath = join(RECIPES_DIR, filename);
    const content = readFileSync(filepath, "utf8");

    const fm = parseFrontmatter(content);
    const body = content.replace(/^---[\s\S]*?---\r?\n/, "");

    const title = fm.title ?? filename.replace(".md", "").replace(/_/g, " ");
    const slug = titleToSlug(title);

    // Derive fields
    const category = Array.isArray(fm.category)
      ? fm.category[0]
      : (fm.category ?? null);

    const proteins = (
      Array.isArray(fm.protein) ? fm.protein : fm.protein ? [fm.protein] : []
    ).filter((p) => p !== "other");
    const protein = proteins.length > 0 ? proteins.join(", ") : null;

    const sourceVal = fm.source ?? null;
    const source_url = sourceVal?.startsWith("http") ? sourceVal : null;

    const cook_time_min = fm.total_time_mins
      ? parseInt(fm.total_time_mins, 10)
      : null;

    // Extract prose sections (one step/item per line, bullets/numbering stripped)
    const method        = extractInstructions(body);
    const tips          = extractBullets(body, "Tips?");
    const substitutions = extractBullets(body, "Substitutions?", "Swaps?");

    // ── Insert recipe row ─────────────────────────────────────────────────
    const { error: recipeErr } = await supabase.from("recipes").upsert(
      {
        slug,
        title,
        category,
        protein,
        cook_time_min,
        method,
        source_url,
        tips,
        substitutions,
      },
      { onConflict: "slug" },
    );

    if (recipeErr) {
      errors.push({ file: filename, message: recipeErr.message });
      console.log(
        `  [${i + 1}/${files.length}] ${filename} … ✗ recipe insert failed: ${recipeErr.message}`,
      );
      continue;
    }

    // ── Parse + insert ingredients ────────────────────────────────────────
    const bulletLines = extractIngredients(body);
    const ingredients = [];

    for (const line of bulletLines) {
      const parsed = parseIngredientLine(line);
      if (!parsed) continue;

      if (parsed.flagged) {
        flaggedLines.push({
          file: filename,
          line: line.replace(/^-\s*/, ""),
          reason: parsed.reason,
        });
      }

      if (parsed.ingredient) {
        ingredients.push({
          recipe_slug: slug,
          ingredient: parsed.ingredient,
          display_name: parsed.displayName || null,
          quantity: parsed.quantity,
          unit: parsed.unit,
        });
      }
    }

    if (ingredients.length > 0) {
      const canonicalNames = [...new Set(ingredients.map((row) => row.ingredient))];

      const { error: canonErr } = await supabase
        .from("ingredients")
        .upsert(
          canonicalNames.map((name) => ({ name })),
          { onConflict: "name" },
        );

      if (canonErr) {
        errors.push({
          file: filename,
          message: `ingredients registry: ${canonErr.message}`,
        });
        console.log(
          `  [${i + 1}/${files.length}] ${slug} … ✗ ingredients registry failed: ${canonErr.message}`,
        );
        continue;
      }

      // Delete existing first (idempotent re-run)
      await supabase
        .from("recipe_ingredients")
        .delete()
        .eq("recipe_slug", slug);

      const { error: ingrErr } = await supabase
        .from("recipe_ingredients")
        .insert(ingredients);

      if (ingrErr) {
        errors.push({
          file: filename,
          message: `ingredients: ${ingrErr.message}`,
        });
        console.log(
          `  [${i + 1}/${files.length}] ${slug} … ✗ ingredients insert failed: ${ingrErr.message}`,
        );
        continue;
      }
    }

    totalRecipes++;
    totalIngr += ingredients.length;
    console.log(
      `  [${i + 1}/${files.length}] ${slug.padEnd(45)} ✓  ${ingredients.length} ingredients`,
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────────────────");
  console.log("  SUMMARY");
  console.log("─────────────────────────────────────────────────────────");
  console.log(`  Recipes inserted:      ${totalRecipes}`);
  console.log(`  Ingredients inserted:  ${totalIngr}`);

  if (errors.length > 0) {
    console.log(`\n  ERRORS (${errors.length}):`);
    for (const e of errors) {
      console.log(`    • ${e.file}: ${e.message}`);
    }
  }

  if (flaggedLines.length > 0) {
    console.log(`\n  Lines needing manual review (${flaggedLines.length}):`);
    for (const f of flaggedLines) {
      console.log(`    • ${f.file.padEnd(48)} "${f.line}"`);
      if (f.reason) console.log(`      reason: ${f.reason}`);
    }
  } else {
    console.log("\n  No lines flagged for review.");
  }

  console.log("\n─────────────────────────────────────────────────────────");
  console.log("  ⚠️  Done. Remove your service-role key from this file!");
  console.log("─────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
