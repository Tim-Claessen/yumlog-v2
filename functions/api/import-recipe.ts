// Cloudflare Pages Function — POST /api/import-recipe
//
// Auth-gated proxy that fetches a recipe URL, pulls out JSON-LD Recipe data
// if present (falling back to readable page text otherwise), then runs the
// result through an LLM to normalise it into the app's recipe shape. See
// CLAUDE.md for the response contract — Phase 2 depends on it, so keep
// shapes stable.

import { fetchExistingCategories } from "../lib/recipe-categories";
import {
  normaliseRecipe,
  RecipeNormalisationError,
  type AiBinding,
  type NormaliseInput,
} from "../lib/recipe-normaliser";

interface Env {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
  AI: AiBinding;
}

interface RequestContext {
  request: Request;
  env: Env;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_TEXT_CHARS = 15_000;
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const onRequest = async (context: RequestContext): Promise<Response> => {
  const { request, env } = context;

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
  }

  if (!env.PUBLIC_SUPABASE_URL || !env.PUBLIC_SUPABASE_ANON_KEY) {
    return jsonResponse({ error: "Server is misconfigured." }, 500);
  }

  const authorized = await isAuthorized(request, env);
  if (!authorized) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }

  const rawUrl = (body as { url?: unknown } | null)?.url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return jsonResponse({ error: 'Request body must include a "url" string.' }, 400);
  }

  const validated = validateTargetUrl(rawUrl.trim());
  if (!validated.ok) {
    return jsonResponse({ error: validated.message }, 400);
  }

  const fetched = await fetchPage(validated.url.toString());
  if (!fetched.ok) {
    return jsonResponse({ error: fetched.message }, 422);
  }

  const jsonLdBlocks = extractJsonLdBlocks(fetched.html);
  const recipeNode = findRecipeNode(jsonLdBlocks);

  const normaliseInput: NormaliseInput = recipeNode
    ? { kind: "structured", data: buildRawRecipe(recipeNode) }
    : { kind: "page_text", text: extractPageText(fetched.html) };

  const existingCategories = await fetchExistingCategories(env);

  try {
    const recipe = await normaliseRecipe(normaliseInput, env, existingCategories);
    return jsonResponse({ source_url: validated.url.toString(), recipe });
  } catch (err) {
    if (err instanceof RecipeNormalisationError) {
      return jsonResponse({ error: err.message }, 502);
    }
    return jsonResponse({ error: "Something went wrong while importing that recipe." }, 502);
  }
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const token = match[1].trim();
  if (!token) return false;

  try {
    const res = await fetch(`${env.PUBLIC_SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: env.PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// URL validation (SSRF guard)
// ---------------------------------------------------------------------------

type UrlValidation = { ok: true; url: URL } | { ok: false; message: string };

function validateTargetUrl(rawUrl: string): UrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: "That doesn't look like a valid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "Only http and https URLs are supported." };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, message: "That URL points to a local address, which isn't allowed." };
  }

  if (isPrivateIp(hostname)) {
    return { ok: false, message: "That URL points to a private network address, which isn't allowed." };
  }

  if (url.port && !isStandardPort(url.protocol, url.port)) {
    return { ok: false, message: "That URL uses a non-standard port, which isn't allowed." };
  }

  return { ok: true, url };
}

function isStandardPort(protocol: string, port: string): boolean {
  if (protocol === "http:") return port === "80";
  if (protocol === "https:") return port === "443";
  return false;
}

function isPrivateIp(hostname: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }

  if (hostname.includes(":")) {
    const h = hostname.replace(/^\[|\]$/g, "");
    if (h === "::1" || h === "::") return true; // loopback / unspecified
    if (/^fe80:/i.test(h)) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // unique local fc00::/7
    if (/^::ffff:/i.test(h)) return isPrivateIp(h.replace(/^::ffff:/i, ""));
    return false;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

type FetchResult = { ok: true; html: string } | { ok: false; message: string };

async function fetchPage(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    return { ok: false, message: "Couldn't fetch that page" };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return { ok: false, message: `Couldn't fetch that page (status ${response.status})` };
  }
  if (!response.body) {
    return { ok: false, message: "Couldn't fetch that page" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (received >= MAX_RESPONSE_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }
  } catch {
    return { ok: false, message: "Couldn't fetch that page" };
  }

  const combined = new Uint8Array(Math.min(received, MAX_RESPONSE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= combined.length) break;
    const slice = chunk.subarray(0, combined.length - offset);
    combined.set(slice, offset);
    offset += slice.length;
  }

  return { ok: true, html: new TextDecoder("utf-8").decode(combined) };
}

// ---------------------------------------------------------------------------
// JSON-LD extraction
// ---------------------------------------------------------------------------

function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {
      // Malformed JSON-LD block — skip it and keep looking.
    }
  }
  return blocks;
}

function findRecipeNode(blocks: unknown[]): Record<string, unknown> | null {
  for (const block of blocks) {
    const found = searchForRecipe(block);
    if (found) return found;
  }
  return null;
}

function searchForRecipe(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchForRecipe(item);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;

  const obj = node as Record<string, unknown>;
  if (isRecipeType(obj["@type"])) return obj;
  if (Array.isArray(obj["@graph"])) return searchForRecipe(obj["@graph"]);
  return null;
}

function isRecipeType(type: unknown): boolean {
  if (typeof type === "string") return type === "Recipe" || type.includes("Recipe");
  if (Array.isArray(type)) {
    return type.some((t) => typeof t === "string" && (t === "Recipe" || t.includes("Recipe")));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Recipe field extraction
// ---------------------------------------------------------------------------

function buildRawRecipe(node: Record<string, unknown>) {
  const cookTimeMin = parseDurationMinutes(node.cookTime) ?? parseDurationMinutes(node.totalTime);

  return {
    title: typeof node.name === "string" ? node.name.trim() : "",
    ingredients: extractIngredients(node.recipeIngredient),
    method_steps: flattenInstructions(node.recipeInstructions),
    cook_time_min: cookTimeMin ?? null,
    category_hint: extractCategoryHint(node.recipeCategory, node.keywords),
    tips: [] as string[],
  };
}

function extractIngredients(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function extractCategoryHint(category: unknown, keywords: unknown): string {
  if (typeof category === "string" && category.trim()) return category.trim();
  if (Array.isArray(category)) {
    const first = category.find((c) => typeof c === "string" && c.trim());
    if (typeof first === "string") return first.trim();
  }

  // Plenty of sites skip recipeCategory but do populate keywords — fall back to it.
  if (typeof keywords === "string" && keywords.trim()) {
    return keywords.split(",")[0].trim();
  }
  if (Array.isArray(keywords)) {
    const first = keywords.find((k) => typeof k === "string" && k.trim());
    if (typeof first === "string") return first.trim();
  }

  return "";
}

function flattenInstructions(instructions: unknown): string[] {
  if (!instructions) return [];
  if (typeof instructions === "string") {
    return instructions
      .split(/\r?\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(instructions)) {
    return instructions.flatMap((item) => flattenInstructionItem(item));
  }
  return flattenInstructionItem(instructions);
}

function flattenInstructionItem(item: unknown, sectionName?: string): string[] {
  if (typeof item === "string") {
    const trimmed = item.trim();
    if (!trimmed) return [];
    return [sectionName ? `${sectionName}: ${trimmed}` : trimmed];
  }
  if (!item || typeof item !== "object") return [];

  const obj = item as Record<string, unknown>;
  const type = obj["@type"];
  const typeStr = Array.isArray(type) ? type.join(",") : String(type ?? "");

  if (typeStr.includes("HowToSection")) {
    const name = typeof obj.name === "string" ? obj.name.trim() : undefined;
    const itemList = obj.itemListElement;
    if (Array.isArray(itemList)) {
      return itemList.flatMap((sub) => flattenInstructionItem(sub, name));
    }
    return [];
  }

  // HowToStep (or an unrecognised object) — use `text`, falling back to `name`.
  const text = typeof obj.text === "string" ? obj.text : typeof obj.name === "string" ? obj.name : "";
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [sectionName ? `${sectionName}: ${trimmed}` : trimmed];
}

function parseDurationMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!match) return null;

  const [, days, hours, minutes, seconds] = match;
  if (!days && !hours && !minutes && !seconds) return null;

  const totalMinutes =
    Number(days ?? 0) * 24 * 60 +
    Number(hours ?? 0) * 60 +
    Number(minutes ?? 0) +
    Math.round(Number(seconds ?? 0) / 60);

  return totalMinutes > 0 ? totalMinutes : null;
}

// ---------------------------------------------------------------------------
// Plain-text fallback (no JSON-LD Recipe found)
// ---------------------------------------------------------------------------

function extractPageText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const stripped = withoutNoise.replace(/<[^>]+>/g, " ");
  const decoded = decodeHtmlEntities(stripped);
  return decoded.replace(/\s+/g, " ").trim().slice(0, MAX_PAGE_TEXT_CHARS);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = isHex ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      if (Number.isNaN(code)) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}
