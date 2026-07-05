# Runsheet — URL Recipe Importer for Yumlog

Feature: paste a website URL on `/create`, scrape + convert the recipe into the create form, user reviews/edits, then saves via the existing flow.

**Architecture (agreed defaults — confirm before Phase 1):**

- Cloudflare Pages Function at `functions/api/import-recipe.ts` (repo root `/functions`, auto-detected by Pages; no Astro adapter, static output unchanged)
- Extraction pipeline: JSON-LD (schema.org/Recipe) first → LLM normalisation → LLM full-text fallback only when no JSON-LD
- LLM: Cloudflare Workers AI binding (`env.AI`), free tier; structured so the provider can be swapped for Anthropic later
- Endpoint is auth-gated by validating the caller's Supabase access token; nothing is written to the DB — the endpoint only returns JSON to populate the form. All existing save-time invariants (ingredient normalisation, new-ingredient category prompt, slug generation, rebuild webhook) run unchanged.

**Decision checkpoints (do not proceed past Phase 0 without these):**

1. OK to introduce the first server-side code (Pages Function)? CLAUDE.md currently says "plain static output".
2. Workers AI (free) vs Anthropic Haiku (paid, better quality) vs Gemini Flash free tier?
3. Confirm import should only _populate the form_, never auto-submit.

---

## Phase 0 — Manual prep (Tim, ~10 min)

1. Confirm the three decision checkpoints above.
2. In Cloudflare dashboard → Pages project → Settings → Functions, confirm Functions are available on the project (they are on all Pages projects; nothing to enable for the function itself).
3. If using Workers AI: no API key needed — the binding is added in Phase 4.
4. If using Anthropic instead: create an API key and add it as an **encrypted** env var `ANTHROPIC_API_KEY` in Pages → Settings → Environment variables (Production + Preview).

---

## Phase 1 — Claude Code prompt: endpoint scaffold + JSON-LD extraction (no LLM yet)

> Read CLAUDE.md fully before starting. Create a Cloudflare Pages Function at `functions/api/import-recipe.ts` (TypeScript). Requirements:
>
> 1. **POST only.** Body: `{ "url": string }`. All responses JSON.
> 2. **Auth:** require `Authorization: Bearer <supabase access token>`. Validate it server-side by calling `GET {PUBLIC_SUPABASE_URL}/auth/v1/user` with headers `apikey: <anon key>` and the bearer token. Return 401 on failure. Read the Supabase URL and anon key from env vars (they are already set in Cloudflare Pages as `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY`).
> 3. **URL validation (SSRF guard):** http/https only; reject localhost, `*.local`, raw IPs in private ranges, and non-standard ports. Return 400 with a friendly message.
> 4. **Fetch the page** with a realistic browser User-Agent, a 10s timeout, and a 2 MB response cap. Return 422 with message "Couldn't fetch that page" on failure (include status code in the message where available).
> 5. **JSON-LD extraction:** parse all `<script type="application/ld+json">` blocks (handle arrays and `@graph`). Find the first object whose `@type` is or includes `Recipe`. Extract: `name`, `recipeIngredient[]`, `recipeInstructions` (flatten `HowToStep` text; if `HowToSection`, prefix each step with the section name as a `Label:`), `cookTime`/`totalTime` (parse ISO 8601 duration → integer minutes, prefer cookTime), `recipeCategory`, `keywords`, `description`.
> 6. **Response shape** (this is the contract the frontend and Phase 2 both depend on — do not change it later without updating both):
>    ```json
>    {
>      "found_structured_data": true,
>      "source_url": "...",
>      "raw": {
>        "title": "...",
>        "ingredients": ["2 cups plain flour, sifted", "..."],
>        "method_steps": ["...", "..."],
>        "cook_time_min": 45,
>        "category_hint": "...",
>        "tips": []
>      }
>    }
>    ```
>    When no JSON-LD Recipe is found, return `found_structured_data: false` plus `page_text` — the page's readable text content, stripped of nav/script/style, capped at ~15,000 characters.
> 7. Keep the code simple and human-readable per CLAUDE.md priorities. No new npm dependencies unless genuinely necessary; prefer hand-rolled parsing of JSON-LD and ISO durations.
> 8. Do not touch any existing files in this phase.
>
> When done, tell me how to test it locally (note: `npm run dev` will not serve `/functions`; expect `npx wrangler pages dev dist` after a build, or document whichever approach works with this repo's wrangler.jsonc).

**Manual after Phase 1:** build, run the local functions server, and test with `curl` against 2–3 real recipe URLs (grab your access token from the browser's local storage while logged in). Confirm the JSON-LD path works before spending anything on Phase 2.

---

## Phase 2 — Claude Code prompt: LLM normalisation layer

> Read CLAUDE.md, especially "Stored text formats", "Ingredient normalisation", and the fixed recipe category conventions. Extend `functions/api/import-recipe.ts` (extract shared logic into `functions/lib/` if it gets long):
>
> 1. Add a **Workers AI binding** (`env.AI`). Update `wrangler.jsonc` with `"ai": { "binding": "AI" }`. Use a current small instruct model (check Cloudflare's model catalog; e.g. a Llama 3.x 8B instruct class model). Wrap the LLM call in a single function `normaliseRecipe(raw, env)` so the provider can be swapped later.
> 2. **Normalisation call** (runs whether or not JSON-LD was found — input is either `raw` or `page_text`). The prompt must instruct the model to return ONLY JSON, no markdown fences, matching:
>    ```json
>    {
>      "title": "...",
>      "category": "one of the existing slug-style categories or null",
>      "protein": "slug-style, comma-separated if multiple, or null",
>      "cook_time_min": 45,
>      "ingredients": [
>        { "quantity": 2, "unit": "cup", "text": "plain flour, sifted" }
>      ],
>      "method": ["Label: step text", "step text"],
>      "tips": ["..."],
>      "substitutions": ["..."]
>    }
>    ```
>    Rules to encode in the prompt: method is one step per line, no leading numbers, optional `Label:` prefix; tips/substitutions one per line, no bullets; units limited to the set used by `src/lib/units.ts` (g, kg, mg, ml, l, tsp, tbsp, cup, oz, lb, each, pinch, etc.) — countable items use `each`; quantity null when absent; keep ingredient `text` as the original human wording (the app normalises canonical names at save time — do not attempt canonicalisation here).
> 3. **Robust parsing** of the LLM response: strip accidental code fences, JSON.parse in try/catch, validate the shape, and on failure retry once with a "return only valid JSON" reminder. If it still fails, return 502 with a friendly message.
> 4. Final endpoint response to the frontend: `{ source_url, recipe: <normalised object> }`.
> 5. Log nothing sensitive; keep errors user-friendly.

**Manual after Phase 2:** re-test locally with the same URLs plus one site you suspect has no JSON-LD. Sanity-check the ingredient quantity/unit splits.

---

## Phase 3 — Claude Code prompt: frontend on `/create`

> Read CLAUDE.md ("Create / edit", "Design system", "UI patterns") and `docs/brand-hearth.md`. Add an "Import from URL" capability to `create.astro` / `recipe-form-ui.ts`:
>
> 1. **Placement:** a collapsed/compact panel above the form, create mode only (hide when `?edit=` is present). Styling must follow Hearth: paper card (`bg-surface border border-outline-soft rounded-2xl`), subtle input pattern for the URL field, primary button. No new colours, no `bg-white`. Mobile-friendly — this will mostly be used from a phone.
> 2. **Flow:** paste URL → "Import" button → loading state (disable button, show a quiet inline status like "Fetching recipe…") → POST to `/api/import-recipe` with the current Supabase session access token in the Authorization header (get it from the existing supabase client in `src/lib/supabase.ts`).
> 3. **On success:** populate the form — title, category select (only if the returned slug matches an existing option, otherwise leave unselected), protein, cook time, ingredient rows (quantity, unit, ingredient text into the existing row structure so autocomplete still works), method steps, tips, substitutions — and set `source_url`. Reuse the existing dynamic-row creation functions in `recipe-form-ui.ts` rather than duplicating DOM code. If the form already has content, confirm before overwriting.
> 4. **After populate:** show a dismissible sage callout (`bg-secondary-container`) saying the recipe was imported and should be reviewed before saving. Do NOT auto-submit — the existing save flow (normalisation, new-ingredient category prompts, webhook rebuild) must run exactly as it does for manual entry.
> 5. **Error states:** friendly inline messages for 401 (session expired — log in again), 400/422 (couldn't read that page — enter manually), 502 (import service hiccup — try again).
> 6. Respect the Astro client-script gotcha in CLAUDE.md: never combine `define:vars` with `import` in `<script>` tags.

**Manual after Phase 3:** full local end-to-end — import, tweak, save, confirm the new-ingredient category prompt fires for unknown ingredients, and the Supabase webhook triggers a deploy after save.

---

## Phase 4 — Manual: Cloudflare config + deploy (Tim, ~15 min)

1. Commit and push to `main`.
2. Cloudflare Pages → project → **Settings → Functions → AI binding** (or confirm the `wrangler.jsonc` `ai` binding is picked up by the build — check the deploy log). Variable name must match the code (`AI`).
3. Confirm `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` exist as Pages env vars (they already do per CLAUDE.md).
4. Wait for deploy; smoke test on the live site while logged in:
   - RecipeTin Eats URL (JSON-LD path)
   - BBC Good Food or Taste.com.au URL
   - A blog-style site without structured data (LLM fallback path)
   - A garbage URL and a non-recipe URL (error handling)
5. Check Workers AI usage in the Cloudflare dashboard after a few imports to confirm you're comfortably inside the free tier.

---

## Phase 5 — Claude Code prompt: documentation

> Update CLAUDE.md to document the new import feature: the `functions/api/import-recipe.ts` endpoint (auth model, request/response contract, SSRF guard), the Workers AI binding, the JSON-LD-first + LLM-normalise pipeline, and an explicit note that this is the only server-side code in the project and that the critical rendering rule (static recipe pages, no DB at read time) is unaffected. Also note the local-dev requirement (`wrangler pages dev`) for testing functions. Update README's Features list with one line. Keep the tone and structure consistent with the existing docs.

---

## Phase 6 (optional, later) — Canonical ingredient matching hint

Nice-to-have once the basics work: pass the list of existing canonical ingredient names (fetched client-side, sent in the request body) into the normalisation prompt so the LLM biases toward names already in the registry — fewer "new ingredient" category prompts on save. Defer until you've seen how noisy real imports are.

---

## Cost + risk notes

- **Workers AI free tier:** ~10,000 neurons/day; a couple of imports a week is a rounding error. If quality is poor on the fallback path, swap `normaliseRecipe()` to Claude Haiku (~fractions of a cent per import) — the abstraction in Phase 2 makes this a one-file change.
- **Paywalled sites** (NYT Cooking, some AFR/Delicious content) will fail at the fetch step — expected; enter manually.
- **The endpoint is a fetch proxy** — the auth check and SSRF guard are what stop it being abused. Don't remove them to "simplify".
- **No DB or webhook changes** — the importer never writes; the save button does, exactly as today.
