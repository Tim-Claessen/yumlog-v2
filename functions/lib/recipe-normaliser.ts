// Shared recipe-normalisation logic for the recipe importer.
//
// Wraps the LLM call behind a single normaliseRecipe() function so the
// underlying provider (currently Workers AI) can be swapped later without
// touching the calling Function. See CLAUDE.md "Stored text formats" and
// "Ingredient normalisation and display" for the rules encoded in the
// prompt below.

export interface StructuredRecipeInput {
  title: string;
  ingredients: string[];
  method_steps: string[];
  cook_time_min: number | null;
  category_hint: string;
  tips: string[];
}

export type NormaliseInput =
  | { kind: "structured"; data: StructuredRecipeInput }
  | { kind: "page_text"; text: string };

export interface NormalisedIngredient {
  quantity: number | null;
  unit: string;
  text: string;
}

export interface NormalisedRecipe {
  title: string;
  category: string | null;
  protein: string | null;
  cook_time_min: number | null;
  ingredients: NormalisedIngredient[];
  method: string[];
  tips: string[];
  substitutions: string[];
}

// Minimal shape of the Workers AI binding actually used here — avoids
// pulling in @cloudflare/workers-types for one method.
export interface AiBinding {
  run(
    model: string,
    input: {
      messages: { role: "system" | "user"; content: string }[];
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<unknown>;
}

export class RecipeNormalisationError extends Error {}

const FRIENDLY_FAILURE_MESSAGE =
  "We couldn't automatically read that recipe. Try a different link, or enter it manually.";

// A current small instruct model. Swap this (and runModel below) to change
// provider/model without touching the calling Function.
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct";

const ALLOWED_UNITS = [
  "g", "kg", "mg", "ml", "l", "tsp", "tbsp", "cup", "oz", "lb",
  "each", "pinch", "dash", "sprig", "handful", "clove", "slice",
  "piece", "tin", "can", "sheet", "stalk", "stick", "head", "bunch",
  "to taste",
];

export async function normaliseRecipe(
  input: NormaliseInput,
  env: { AI: AiBinding },
  existingCategories: string[]
): Promise<NormalisedRecipe> {
  const messages = buildMessages(input, existingCategories);

  const first = await runModel(env, messages);
  const parsedFirst = tryParse(first);
  if (parsedFirst) return parsedFirst;

  const retryMessages = [
    ...messages,
    {
      role: "user" as const,
      content:
        "Your previous reply was not valid JSON matching the schema. Reply again with ONLY valid JSON — no markdown fences, no commentary, no explanation.",
    },
  ];
  const second = await runModel(env, retryMessages);
  const parsedSecond = tryParse(second);
  if (parsedSecond) return parsedSecond;

  throw new RecipeNormalisationError(FRIENDLY_FAILURE_MESSAGE);
}

async function runModel(
  env: { AI: AiBinding },
  messages: { role: "system" | "user"; content: string }[]
): Promise<string> {
  let result: unknown;
  try {
    result = await env.AI.run(MODEL_ID, {
      messages,
      temperature: 0.2,
      max_tokens: 2048,
    });
  } catch {
    throw new RecipeNormalisationError(FRIENDLY_FAILURE_MESSAGE);
  }

  if (result && typeof result === "object" && "response" in result) {
    const response = (result as { response?: unknown }).response;
    return typeof response === "string" ? response : "";
  }
  return typeof result === "string" ? result : "";
}

function buildMessages(
  input: NormaliseInput,
  existingCategories: string[]
): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: buildSystemPrompt(existingCategories) },
    { role: "user", content: buildUserContent(input) },
  ];
}

function buildSystemPrompt(existingCategories: string[]): string {
  const categoryList =
    existingCategories.length > 0 ? existingCategories.map((c) => `"${c}"`).join(", ") : "(none yet)";

  return `You turn a scraped recipe (structured data or raw page text) into clean, normalised JSON for a recipe app.

Reply with ONLY a single JSON object — no markdown code fences, no commentary before or after. It must match exactly this shape:

{
  "title": "string",
  "category": "string or null",
  "protein": "string or null",
  "cook_time_min": 45,
  "ingredients": [ { "quantity": 2, "unit": "cup", "text": "plain flour, sifted" } ],
  "method": ["Label: step text", "step text"],
  "tips": ["..."],
  "substitutions": ["..."]
}

Rules:
- "title": the recipe's plain title.
- "category": pick the single best match from this list of existing categories if one clearly fits: [${categoryList}]. If none fit well, use null. Never invent a new category. Existing categories are lowercase, underscore-separated slugs (e.g. "sweet_treat").
- "protein": lowercase, underscore-separated slug(s), comma-separated if the recipe has more than one main protein (e.g. "chickpea, lentils"). Use null if the recipe has no clear main protein (e.g. a dessert).
- "cook_time_min": total cook/prep time in whole minutes as a number, or null if not stated.
- "ingredients": one entry per ingredient line.
  - "quantity": a number, or null if no quantity is given.
  - "unit": one of: ${ALLOWED_UNITS.join(", ")}. Use "each" for countable items (e.g. "2 eggs" -> quantity 2, unit "each"). If nothing else fits, pick the closest unit from this list rather than inventing a new one.
  - "text": the ingredient exactly as written by the recipe author (e.g. "plain flour, sifted"), minus the quantity/unit. Do not rename or standardise the ingredient name — the app normalises that separately.
- "method": one array entry per step, in order. No leading numbers. A step may start with a short label followed by a colon (e.g. "Rest: leave the dough for 10 minutes."); only add a label if the source text implies one.
- "tips": one array entry per tip, no leading bullets or dashes. Empty array if there are none.
- "substitutions": one array entry per substitution, no leading bullets or dashes. Empty array if there are none.

If the source doesn't clearly state something, use null (for scalars) or an empty array (for lists) rather than guessing.`;
}

function buildUserContent(input: NormaliseInput): string {
  if (input.kind === "structured") {
    return `Structured recipe data extracted from the page:\n\n${JSON.stringify(input.data, null, 2)}`;
  }
  return `Raw page text (no structured recipe data was found on the page):\n\n${input.text}`;
}

function tryParse(rawResponse: string): NormalisedRecipe | null {
  const candidate = extractJsonCandidate(rawResponse);
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  return validateNormalisedRecipe(parsed);
}

function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  return trimmed.slice(start, end + 1);
}

function validateNormalisedRecipe(value: unknown): NormalisedRecipe | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;

  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  if (!title) return null;

  const ingredients = parseIngredients(obj.ingredients);
  if (!ingredients) return null;

  const method = parseStringArray(obj.method);
  if (!method) return null;

  return {
    title,
    category: parseNullableString(obj.category),
    protein: parseNullableString(obj.protein),
    cook_time_min: parseNullableNumber(obj.cook_time_min),
    ingredients,
    method,
    tips: parseStringArray(obj.tips) ?? [],
    substitutions: parseStringArray(obj.substitutions) ?? [],
  };
}

function parseIngredients(value: unknown): NormalisedIngredient[] | null {
  if (!Array.isArray(value)) return null;

  const parsed: NormalisedIngredient[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : "";
    if (!text) continue;

    parsed.push({
      quantity: parseNullableNumber(obj.quantity),
      unit: typeof obj.unit === "string" && obj.unit.trim() ? obj.unit.trim().toLowerCase() : "each",
      text,
    });
  }
  return parsed;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}
