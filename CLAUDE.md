# Yumlog — Project Context

A personal cookbook for two users (Tim + Zoe). Public read-only; only the two of them can log in and edit.

---

## Stack

| Layer     | Technology                                                          |
| --------- | ------------------------------------------------------------------- |
| Frontend  | Astro 6, deployed to **Cloudflare Workers** (static assets + a thin routing worker — see **Deployment**) |
| Styling   | Tailwind CSS 4 (via `@tailwindcss/vite`, not `@astrojs/tailwind`)   |
| Backend   | Supabase (Postgres + Auth)                                          |
| DB client | `@supabase/supabase-js` 2                                           |
| Fonts     | `@fontsource-variable/newsreader`, `@fontsource-variable/hanken-grotesk` |
| Other     | `pluralize` — ingredient normalisation and display pluralisation    |

---

## Critical rendering rule

**Recipes are PRE-RENDERED at build time (static pages).** They must never call the database at read time. The Supabase client is only used:

1. **At build time** — to fetch recipe data for static generation.
2. **Client-side for auth** — login session check and nav gating (authenticated only).
3. **Client-side for writes** — adding/editing recipes (authenticated only).
4. **Client-side for the shopping list** — read and write (authenticated only).
5. **Client-side for settings** — site status and ingredient registry (authenticated only); no build-time DB reads for user-specific data.

If a feature would make recipe pages depend on Supabase at request time, reject that approach.

**After creating a new recipe**, the row exists in Supabase immediately but the static page won't appear until the next `npm run build` / deploy. Edits to existing recipes update the DB immediately; the static HTML updates on the next build too.

---

## Authentication

- **Login:** `/login` — email + password via `signInWithPassword`. Redirects to `?redirect=` on success (defaults to `/`).
- **Session:** client-side only — Supabase persisted session in the browser. No SSR.
- **Guests see:** Recipes nav + Log in. Recipe pages are fully public.
- **Logged-in users see:** Recipes, Shopping, Create, Settings, Sign out; edit controls on recipe pages.
- **Protected pages:** `/shopping`, `/create`, `/settings`, `/settings/ingredients` — client-side `requireAuth()` redirects to login if no session.
- Public sign-ups are **disabled** in Supabase Auth. Only manually-added accounts (Tim + Zoe) can log in.

### Astro client-script gotcha

**Never combine `define:vars` with `import` statements** in `<script>` tags — Astro inlines those as classic scripts and imports fail silently (`Cannot use import statement outside a module`). Pass data via URL params, `data-*` attributes, or a `<script type="application/json">` block instead.

---

## Database schema

```sql
-- Recipes — keyed by a readable slug (e.g. 'garlic-butter-mushrooms')
create table recipes (
  slug           text primary key,
  title          text not null,
  category       text,            -- slug-style, e.g. 'sweet_treat'; single value
  protein        text,            -- slug-style; may be comma-separated for multiple, e.g. 'chickpea, lentils'
  cook_time_min  integer,
  method         text not null,   -- step-by-step instructions, one step per line (see Stored text formats)
  tips           text,            -- one tip per line; null when absent
  substitutions  text,            -- one substitution per line; null when absent
  source_url     text,
  created_at     timestamptz default now(),
  updated_at     timestamptz not null default now()  -- bumped to trigger rebuilds (see Deployment)
);

-- Canonical ingredient registry (one row per normalised name)
create table ingredients (
  name      text primary key,     -- normalised name, e.g. 'brown onion'
  category  text                  -- shopping-list aisle; null = valid in recipes but not shopped
);

-- Per-recipe ingredient lines (FK → ingredients.name)
create table recipe_ingredients (
  id            bigint generated always as identity primary key,
  recipe_slug   text not null references recipes(slug) on delete cascade,
  ingredient    text not null references ingredients(name) on update cascade on delete restrict,
  display_name  text,               -- original wording, e.g. 'button mushrooms'
  quantity      numeric,
  unit          text                -- 'g','kg','ml','cup','each','pinch'...
);

-- The single shared shopping list (both users share one list)
create table shopping_list (
  id          bigint generated always as identity primary key,
  ingredient  text not null references ingredients(name) on update cascade on delete restrict,
  quantity    numeric,
  unit        text,                 -- canonical unit after conversion, e.g. 'g' or 'each'
  checked     boolean not null default false,
  position    integer,              -- global order; grouped display derives from category + position
  added_at    timestamptz default now(),
  updated_at  timestamptz not null default now()
);
```

`ingredients.category` is constrained in Postgres to one of eleven fixed aisle values (see **Ingredient shopping sections** below), or `null`.

> **Pending migrations** — run once in the Supabase SQL editor as needed:
>
> `tips` / `substitutions` on recipes (if missing):
> ```sql
> alter table recipes add column if not exists tips          text;
> alter table recipes add column if not exists substitutions text;
> ```
> `shopping_list.updated_at` + auto-touch on row update:
> ```sql
> alter table shopping_list
>   add column if not exists updated_at timestamptz not null default now();
>
> update shopping_list
> set updated_at = coalesce(added_at, now())
> where updated_at is null or updated_at = now();
>
> create or replace function shopping_list_set_updated_at()
> returns trigger language plpgsql as $$
> begin
>   new.updated_at := now();
>   return new;
> end;
> $$;
>
> drop trigger if exists shopping_list_set_updated_at on shopping_list;
> create trigger shopping_list_set_updated_at
>   before update on shopping_list
>   for each row execute function shopping_list_set_updated_at();
> ```
>
> Ingredient registry admin (merge RPC + rebuild touch) — **`scripts/ingredient-registry-rpc.sql`**:
> adds `recipes.updated_at` (if missing), `touch_recipes_for_ingredient()`, and `merge_ingredients()`. Required for merge and auto-rebuild after canonical renames.

### Row-level security

- `recipes` and `recipe_ingredients` — public **SELECT**; authenticated-only **INSERT/UPDATE/DELETE**.
- `ingredients` — public **SELECT** (needed at build time for joins and client autocomplete); authenticated-only writes.
- `shopping_list` — authenticated-only for everything (no public access).

### Key design decisions

- Primary keys are **slugs**, not UUIDs. Slugs are generated from the title on **create** (`titleToSlug()` in `src/lib/slug.ts` — hyphen-separated, e.g. `mixed-berry-muffins`) and **never change on edit**, even if the title is updated.
- **Canonical ingredients** live in `ingredients` (one row per normalised name). `recipe_ingredients.ingredient` and `shopping_list.ingredient` are FKs to `ingredients.name` (`on update cascade`, `on delete restrict` — cannot delete a canonical name still referenced by a recipe or shopping row).
- **`ingredients` has no unit column** — units live on `recipe_ingredients` and `shopping_list`; conversion happens in app code at shopping-list roll-up time (`src/lib/units.ts`), not on the registry row.
- On recipe save or manual shopping-list add, **upsert** new names into `ingredients` before inserting child rows. Brand-new names require a shopping **category** (modal prompt); existing names keep their stored category silently.
- Public sign-ups are **disabled** in Supabase Auth. Only manually-added accounts (Tim + Zoe) can log in.

---

## Stored text formats

These conventions apply to the `method`, `tips`, and `substitutions` columns, and are enforced by the create/edit form at `/create`.

### `method` — step-by-step instructions

One step per line, no leading number. Steps may begin with a short label followed by a colon for display bolding:

```
Label: rest of the step text here.
Another step with no label.
```

Both `Label: body` and legacy `**Label** body` (markdown bold) are accepted by the renderer.

### `tips` and `substitutions`

One item per line, no leading bullet:

```
Chunky beats smooth. Don't over-mash.
Press cling film directly onto the surface if storing.
```

Substitution items often start with a bold ingredient name: `**Hass avocados:** the dark, bumpy ones.`

---

## Ingredient normalisation and display

### Canonical storage (`ingredients.name`)

Keep all normalisation logic in `src/lib/ingredient.ts` (`normalizeIngredient()`).

On save (create/edit form and manual shopping-list add):

1. **Autocomplete safeguard** — as the user types, suggest existing canonical names from the `ingredients` table (recipe form: all names; shopping manual-add: names with a non-null category only). Shared UI in `src/lib/ingredient-autocomplete.ts`.
2. **Normalise on save** — for genuinely new input: lowercase, trimmed, `pluralize.singular()` on the **last word** (handles potato/potatoes, leaf/leaves, berry/berries). Small exceptions list for words that look plural but aren't (e.g. `bitters`, `lentils`).
3. **New canonical names** — if the normalised name is not yet in `ingredients`, prompt the user to pick a shopping **category** before save (`ingredient-category-prompt.ts`). Upsert into `ingredients` with that category, then write the child row.

Store the normalised value in `ingredients.name` / FK columns. Keep the user's wording in `recipe_ingredients.display_name`.

### Ingredient shopping sections

Fixed aisle categories on `ingredients.category` (lowercase strings, CHECK-constrained in Postgres). Defined in `src/lib/ingredient-sections.ts` as `INGREDIENT_SECTION_ORDER`:

1. `fresh produce` 2. `breakfast` 3. `tinned` 4. `spices` 5. `international food` 6. `other pantry` 7. `baking` 8. `snacks` 9. `drinks` 10. `fridge` 11. `freezer`

**Null category** — ingredient exists for recipes but is excluded from shopping-list roll-up (e.g. `water`, `liquid from chickpea can`). Do not delete these rows; filter at the app layer when adding to the shopping list.

Display labels via `sectionDisplayLabel()` (title-case words). Do not confuse with **recipe** `category` (slug-style `sweet_treat`, etc.) — different concept.

### Ingredient registry admin (`/settings/ingredients`)

Auth-gated dedicated screen (not embedded in `/settings`). Edits **`ingredients` only** — never `recipe_ingredients` lines.

- **List** — fixed-column table: bold canonical name, shopping section (or “Not shopped”), recipe count, **View recipes** link (read-only modal with title links), **Edit** button per row.
- **Edit dialog** — change `name` and/or `category`; explicit confirm flows for rename, merge, and delete.
- **Rename** — single `UPDATE ingredients SET name = …`; FK `on update cascade` repoints `recipe_ingredients` and `shopping_list`. Confirm shows affected recipe count. Calls `touch_recipes_for_ingredient()` RPC so the `recipes` webhook fires a rebuild.
- **Merge** (rename collides with existing name) — `merge_ingredients()` RPC: reassigns all references to survivor, merges shopping rows by unit, deletes duplicate; confirm required.
- **Delete** — only when zero recipe lines **and** zero shopping rows; DB `on delete restrict` as backstop.
- **Category-only edit** — no site rebuild (shopping list reads category client-side; static recipe pages use `display_name`).

Logic: `ingredient-registry.ts` + `ingredient-registry-ui.ts`. SQL: `scripts/ingredient-registry-rpc.sql`.

### Display pluralisation (recipe detail only)

`displayIngredientName()` in `src/lib/ingredient.ts` — when `quantity > 1` and `unit === 'each'`, pluralise the last word of the display name for rendering only (e.g. `3 button mushroom` → `3 button mushrooms`). Stored values stay singular.

---

## Category and protein display rules

- Stored as slug-style strings: `sweet_treat`, `nuts_seeds`, `grains_rice`.
- **Never show the raw slug in the UI.** Always run through `toDisplayLabel()` from `src/lib/format.ts`, which replaces `_` and `-` with spaces and title-cases each word: `"sweet_treat"` → `"Sweet Treat"`.
- `protein` may contain comma-separated values (`"chickpea, lentils"`). Use `splitValues()` from `src/lib/format.ts` to get individual values before rendering filter options or metadata.
- **Category chip** (main recipe list on homepage + recipe header): `bg-primary-container text-on-primary-container text-xs rounded-full px-2 py-0.5 font-medium`.
- **Cook time** (homepage list + recipe header): `text-xs text-on-surface-muted`.
- Unit `"each"` is **never shown** in the ingredient list — display `"3 garlic"` not `"3 each garlic"`.

---

## Shopping-list unit conversion

**Rule:** 1 g = 1 mL. All weight/volume converts to **grams**. Counts stay **each**. Unconvertible units pass through unchanged.

| Input unit                                 | Output         | Factor            |
| ------------------------------------------ | -------------- | ----------------- |
| g                                          | g              | × 1               |
| kg                                         | g              | × 1000            |
| mg                                         | g              | × 0.001           |
| ml                                         | g              | × 1               |
| l                                          | g              | × 1000            |
| tsp                                        | g              | × 5               |
| tbsp                                       | g              | × 15              |
| cup                                        | g              | × 240             |
| oz                                         | g              | × 28              |
| lb                                         | g              | × 454             |
| each / whole / clove / slice               | each           | keep as 'each'    |
| pinch / dash / to taste / sprig / handful  | (pass-through) | own line, no conv |

When adding a recipe's ingredients to the shopping list: if the same `ingredient` in the same canonical `unit` already exists, **add the quantities** rather than creating a duplicate row. **Skip** ingredients whose `ingredients.category` is `null`.

Keep all conversion logic in `src/lib/units.ts` (`toShoppingUnit()`, `addQuantities()`, `shoppingMergeKey()`).

### Shopping list UI (`/shopping`)

Vanilla TypeScript island — `shopping.astro` client script → `shopping-list-ui.ts` (no React/Svelte). DOM built imperatively.

- Auth-gated. Single shared list synced via Supabase (`shopping-list.ts` + realtime `postgres_changes` subscription).
- **Add from recipe** — auth-only button on recipe pages; converts units, merges rows, skips null-category ingredients.
- **Manual add** — ingredient field with autocomplete (shoppable names only); qty uses `type="text"` + `inputmode="decimal"`. New canonical names trigger the category picker modal.
- **By aisle toggle** — M3 switch (`By aisle` on/off). On: group by `ingredients.category` with section headers (walk-the-shop order from `INGREDIENT_SECTION_ORDER`); empty sections hidden. Off: flat list sorted by global `position`. Preference stored in `localStorage` (`yumlog-shopping-grouped`).
- **Row layout** (left → right): delete → qty + unit (padded tap zone) → name → checkbox → drag grip.
- **Reorder** — pointer-based drag on grip only (`shopping-list-drag.ts`): fixed-position lift + shadow, dashed placeholder, FLIP animation on siblings, gentle settle on drop. **Grouped mode:** drag within one section only. **Flat mode:** drag across the single list. Persists global `position` via `setItemOrder()`.
- **Other actions** — tick off (`checked`), edit qty/unit inline, delete, clear done, clear all (with confirmation dialog).

> Enable **Realtime** for `shopping_list` in Supabase → Database → Replication if cross-device live sync is needed.

---

## Design system

The UI follows **Material Design 3** patterns with the **"Hearth"** editorial cookbook palette — clay terracotta, sage olive, ochre accent, and warm paper surfaces. No photography; type, colour, and whitespace carry the personality. Full brand reference: [`docs/brand-hearth.md`](docs/brand-hearth.md).

### Colour tokens — defined in `src/styles/global.css` via `@theme`

| Token | Value | Used for |
|---|---|---|
| `primary` | `#A8472B` | Clay — buttons, links, ingredient amounts, active nav |
| `primary-container` | `#F4DAC8` | Featured cards (1 & 3), category chips, step badges |
| `on-primary` | `#FFF1E6` | Warm cream text on terracotta (never pure white) |
| `on-primary-container` | `#4A1606` | Text on primary-container |
| `secondary` | `#566B4E` | Sage — add-to-shopping, checked shopping items |
| `secondary-container` | `#DCE5CF` | Featured card 2, tip/substitution callouts |
| `on-secondary-container` | `#27341F` | Text on secondary-container, tip labels |
| `accent` | `#C58A2E` | Ochre — wordmark dot only; use sparingly |
| `surface` | `#FBF4EA` | Page background and card fills (warm paper) |
| `surface-low` | `#F6ECE0` | App bar, bottom nav, manual-add panel |
| `surface-container` | `#F0E4D5` | Subtle input fills, hover states |
| `on-surface-muted` | `#6E5C4F` | Secondary text, metadata, cook time |
| `outline-soft` | `#EBDDCC` | Dividers, borders |

Shadow tokens: `shadow-card` (hero, login card), `shadow-soft` (nested elements).

### Card recipe

Paper cards: `bg-surface border border-outline-soft rounded-2xl shadow-card`. Nested list cards use `bg-surface` + border, no shadow. Never use `bg-white` — use `bg-surface`.

### Subtle input pattern

Used for filter-panel selects, shopping-list inline fields, and forms that sit on tinted panels:

```
bg-surface-container/50 border border-transparent rounded-xl
text-sm text-on-surface-muted
focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60
```

Hero search and login/create fields use inset `bg-surface border border-outline-soft` instead.

### Shape scale

- Cards and hero: `rounded-2xl` (16 px), `shadow-card` where lifted
- Hero search / filter: `rounded-[13px]`; filter button 44×44 px
- Inputs: `rounded-xl`
- Category chips: `rounded-full`
- Recipe detail body: two-column grid on desktop; tips/subs in sage callouts below

### Typography

- **Display / headings:** Newsreader (`font-serif`), weight 600, tight tracking on large titles
- **Body / UI:** Hanken Grotesk (`font-sans`), self-hosted via Fontsource in `Layout.astro`
- **Italic accents:** Newsreader italic on hero second line, tip labels, login subtitle — sparingly
- **Eyebrows:** 11 px, bold, uppercase, wide tracking, `text-primary` or `text-secondary`
- **Numbers:** `tabular-nums` on amounts, quantities, cook times, recipe counts

### UI patterns

Keep styling **minimal and text-forward** — no food photography or illustrated imagery.

#### Homepage (`index.astro`)

All homepage interactivity lives in a single inline `<script>` at the bottom of `index.astro` (search, filters, hero scroll, featured visibility). No separate lib file.

- **Sticky hero** (`#hero`) — paper card (`bg-surface border border-outline-soft shadow-card`), `sticky top-16 z-10`. Contains:
  - **Welcome intro** (`#hero-intro`) — eyebrow "Tim & Zoe's kitchen", 34 px serif headline with italic accent line in `text-primary`, recipe count (italic serif, top-right). On **mobile only**, scroll-dismisses quickly over ~40px (`scrollY / 40` then `t³`). Search row stays pinned; hero padding compacts and gains `shadow-sm` once collapsed (~28px scroll).
  - **Search row** — inset `bg-surface` search (`rounded-[13px]`, magnifier in `text-outline`) + **filter button** (`#filter-toggle`, 44×44, matching border). Filter badge shows active filter **count** — toggle `hidden`/`flex` in JS.
  - **Active filter chips** — removable peach pills below the search row when filters are active.
- **Featured** (`#featured-section`) — slugs in `FEATURED_SLUGS` at the top of `index.astro`. `grid grid-cols-3`; cards alternate `bg-primary-container` / `bg-secondary-container` with uppercase category eyebrow + serif title, `min-height` for alignment. Hidden while searching, filtering, or (mobile) hero-collapsed.
- **Filters** — bottom sheet (mobile) / centred dialog (desktop). Three `<select>`s with subtle input pattern.
- **All recipes list** — bordered paper card; rows with title, 11 px category chip, `tabular-nums` cook time.

#### Recipe detail (`recipes/[slug].astro`)

- **Header** — 40 px serif title; metadata row with category chip, protein, `tabular-nums` cook time.
- **Auth-only toolbar** — outline pills: Edit (`border-primary-container`), Add to shopping (`border-secondary-container`); hidden for guests via `data-auth-only`.
- **Body** — desktop `grid grid-cols-[300px_1fr] gap-10`: ingredients left (amounts `text-primary font-semibold tabular-nums`, 58 px width), method right (circular step badges in `bg-primary-container`).
- **Tips / substitutions** — sage `bg-secondary-container` callouts with italic serif labels.

#### Create / edit (`create.astro`)

- Single form for both modes. **Create:** `/create`. **Edit:** `/create?edit={slug}` — prepopulates fields; slug stays fixed on save.
- Auth-gated. Dynamic ingredient rows, method steps, tips, substitutions. Ingredient autocomplete on each row (all canonical names).
- **New ingredient prompt** — on save, any canonical name not yet in `ingredients` opens the category picker before write.

#### Shopping list (`shopping.astro`)

- Auth-gated. 32 px serif page title; "Clear done" in `text-primary`. Manual-add panel (`bg-surface-low/80`). Aisle eyebrows (`text-secondary`, uppercase tracked); paper list cards per aisle. Custom checkboxes: unchecked `border-outline-soft`; checked `bg-secondary` with cream checkmark; sage = done. Grouped or flat list (see **Shopping list UI** above). Terracotta on aisle toggle and primary actions only.

#### Sourdough loaf calculator (`sourdough.astro`)

**Public** (no auth) static page at `/sourdough`. Scales the `sourdough-bread` recipe by batch size and lets you shift the wholemeal/white flour balance.

- **Ratios come from the DB at build time**, not read time — the frontmatter reads `recipe_ingredients` for `sourdough-bread`, derives baker's percentages against total flour, and bakes them into a `<script type="application/json">` block. Edit the recipe → webhook → rebuild → calculator follows. No request-time Supabase (see **Critical rendering rule**).
- Ingredient lines are matched by **canonical name**: `flour` (white), `whole wheat flour`, `water`, `salt`, `sourdough starter`. If any is missing or renamed, the page silently falls back to `FALLBACK_RATIOS` in `sourdough.ts` so it can never break the build (Priority 1).
- **Controls:** a ½-step loaf stepper (0.5–6, disabled at the bounds) and a 0–50% wholemeal slider. The wholemeal slider only re-splits total flour — hydration, salt and starter are untouched by it.
- Maths lives in `src/lib/sourdough.ts` (`scaleLoaf`, `formatGrams`, `formatLoaves`), kept DOM-free. Grams round to 1 g; salt to 0.5 g.
- **True hydration** counts the water inside a 1:1:1 starter (half flour, half water by weight), so it reads ~72.7% against the recipe's stated 70%.
- Range inputs have no global styling — the `.hearth-range` thumb/track CSS is a scoped `<style>` block on the page.
- Entry points: public nav item + a "Loaf calculator" pill on the `sourdough-bread` recipe page only (guarded by `slug === 'sourdough-bread'` in `[slug].astro`).

> **Timers — investigated and ruled out (2026-07-29).** A "set 4 phone timers at 30/60/90/120 min" button is **not possible** from a website; don't re-investigate. The Notification Triggers API (`TimestampTrigger`) was [abandoned by Chrome](https://developer.chrome.com/docs/web-platform/notification-triggers) and never shipped. The `intent://…action=android.intent.action.SET_TIMER` route fails silently because Chrome only launches intents whose target activity declares `android.intent.category.BROWSABLE`, and the Clock app's `HandleApiCalls` activity declares only `DEFAULT`/`VOICE` — deliberately, so websites can't set system alarms. The only working alternatives are an in-page countdown (needs a service worker, since `new Notification()` throws on Android Chrome) or full Web Push with a server-side scheduler. Both were declined as not worth the complexity.

#### Login (`login.astro`)

- Centred `shadow-card` (max ~400 px): 48 px clay medallion, "Welcome back", italic subtitle, inset `bg-surface` fields, inset-shadow primary button, muted footnote about disabled sign-ups.

#### Settings (`settings.astro`, `settings/ingredients.astro`)

Auth-gated static shells; all Supabase reads/writes client-side after `requireAuth()`.

- **`/settings`** — site status panel: **Website last published** (build timestamp baked into HTML at deploy, formatted client-side via `formatSettingsTimestamp()` in `settings.ts`, locale `en-AU`); **Shopping list last changed** (`max(shopping_list.updated_at)` after migration); link row to ingredient registry.
- **`/settings/ingredients`** — canonical ingredient registry admin (see **Ingredient registry admin** above).

### Navigation

- **Wordmark** — clay medallion + serif "Yumlog." with ochre full stop (`Layout.astro`).
- **Guests (desktop + mobile):** Recipes, Sourdough + Log in.
- **Logged in:** Recipes, Sourdough, Shopping, Create, **Settings** (last auth item, before Sign out on desktop) + Sign out.
- **Desktop nav pills:** `text-[13px] font-semibold`; active `bg-primary-container text-on-primary-container`.
- **Mobile:** fixed bottom nav — same items; Settings uses gear icon.
- Pass `activeNav` prop to `Layout.astro` to highlight the current tab (`recipes` | `sourdough` | `shopping` | `create` | `settings`).
- The mobile bottom nav branches on `item.id` for its icon — **add an icon case when adding a public nav item**, or it renders label-only.

---

## Priorities

1. **Recipe availability first.** The shopping list must never break or block access to recipes.
2. **Simple and human-readable.** Prefer clear, obvious code over clever abstractions.
3. **Mobile-friendly.** Tim and Zoe cook from their phones.

---

## Supabase project

- **URL:** `https://nrmimftrjulvsgonrlzg.supabase.co`
- **Anon key format:** JWT (the long `eyJ…` key), not the newer `sb_publishable_` format — both work but JWT is used here for compatibility.
- The anon key is safe to expose publicly and is stored in `.env` as `PUBLIC_SUPABASE_ANON_KEY`.
- The **service-role key** is never committed.

## Environment variables

```
PUBLIC_SUPABASE_URL=https://nrmimftrjulvsgonrlzg.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<JWT anon key — see .env, never commit>
```

Set the same variables in the Cloudflare project → **Settings** → **Variables and Secrets** (Production, and Preview if needed). Also set `NODE_VERSION=22` (required by `package.json` engines).

> **Build variables ≠ runtime variables.** Workers Builds keeps these separate. `NODE_VERSION` and the Supabase vars used by `astro build` are **build** variables; but `worker.ts` and `functions/api/*` read `env.PUBLIC_SUPABASE_URL` / `env.PUBLIC_SUPABASE_ANON_KEY` at **runtime**, so both Supabase vars must also exist as runtime **Variables and Secrets**. Set only on the build side, the static site builds perfectly and the Worker's server-side code fails at runtime — `/api/import-recipe` returns 500 and the keep-alive cron dies silently. Verify with `GET /api/keepalive` (see **Supabase keep-alive** below).

---

## Deployment (Cloudflare Workers — NOT classic Pages)

> **Read this section before touching anything Cloudflare-related.** This project has been misdiagnosed as "Cloudflare Pages" more than once, which sent troubleshooting in the wrong direction. Get this wrong and you'll go looking for dashboard tabs ("Functions", "Bindings") that don't exist for this project type, and waste time on Pages-specific docs/behavior that don't apply here.

**The facts, stated plainly:**

1. This is hosted as a **Cloudflare Worker**, deployed via Cloudflare's **Workers-Builds Git integration** (connect-a-repo, auto-build-on-push) — a different product from **Cloudflare Pages**, even though both live under the same "Workers & Pages" dashboard section and both can be Git-connected. Do not assume Pages behavior or Pages dashboard layout.
2. Static output (`dist/`, from `astro build`) is served via the `assets` binding declared in `wrangler.jsonc` — there is no Astro Cloudflare adapter and no SSR.
3. **`functions/api/import-recipe.ts` does NOT auto-route.** File-based auto-routing of a `functions/` directory into `/api/*` paths is a **Pages-only** convention. On this project, it does nothing by itself.
4. The **only** thing that makes `/api/import-recipe` reachable is `worker.ts` (repo root) — the `main` entrypoint declared in `wrangler.jsonc`. It's a plain `fetch(request, env)` handler that checks the URL path, calls the matching function's exported `onRequest({ request, env })` for known API paths, and falls back to `env.ASSETS.fetch(request)` (serving the static build) for everything else.
5. **Adding a new server-side route?** Write the handler under `functions/` in Pages-Function style (`export const onRequest = async ({ request, env }) => ...`) for consistency, but you **must** also add a branch for its path in `worker.ts`, or it will 404 in production forever, silently, with no error anywhere.

**How to verify any of this yourself** (works whether or not you can find the right dashboard page):

```bash
npm run build
npx wrangler deploy --dry-run   # prints the exact bindings (AI, ASSETS, etc.) Cloudflare will see — no deploy happens
npx wrangler dev                # runs worker.ts + the static build locally at http://127.0.0.1:8787
```
`wrangler dev` is the fastest way to catch a routing mistake before it ever reaches production — hit the route with `curl` and check the status code (404 = not wired in `worker.ts`; 401/405/etc. = it's reaching the handler).

**If the Cloudflare dashboard doesn't show a "Functions" or "Bindings" tab** for this project — that's expected for a Workers-Builds project, not a sign something is broken. Bindings (`AI`, `ASSETS`) come from `wrangler.jsonc` directly; there's no dashboard step required to "turn them on" for this project type. Use `wrangler deploy --dry-run` above instead of hunting for a dashboard page.

### Build settings

| Setting | Value |
| ------- | ----- |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` (repo root) |

### Automatic rebuilds on recipe changes

Recipes are pre-rendered at build time (see **Critical rendering rule**). After create/edit in the app, the DB updates immediately; static HTML updates when Cloudflare finishes the next deploy (~2–3 min).

**Cloudflare deploy hook** — project → **Settings** → **Builds** → **Deploy hooks** (or equivalent — Cloudflare has moved this around; look under Build/Deployments settings). Create a hook on the production branch (`main`). Copy the secret POST URL.

**Supabase database webhook** — **Database** → **Webhooks** → create webhook:

| Field | Value |
| ----- | ----- |
| Table | `recipes` |
| Events | INSERT, UPDATE, DELETE |
| Method | POST |
| URL | Cloudflare deploy hook URL |

Hook `recipes` only — not `recipe_ingredients`, `ingredients`, or `shopping_list`. Every recipe save touches `recipes` first; ingredients are written milliseconds later, well before the queued build fetches data. Shopping list is client-side only and does not need rebuilds.

**Ingredient registry rebuilds** — category-only edits do **not** trigger a rebuild. **Rename** and **merge** call `touch_recipes_for_ingredient()` (in `scripts/ingredient-registry-rpc.sql`) to bump `recipes.updated_at` on affected slugs, firing the same webhook. Without that RPC, renames still cascade in the DB but static pages won't redeploy until the next git push.

Treat the deploy hook URL like a password. Test with `curl -X POST "<hook-url>"` or by saving a recipe and checking webhook logs (Supabase) and **Deployments** (Cloudflare).

Git pushes to `main` also trigger builds; the webhook covers DB-only changes from the create/edit form.

### Supabase keep-alive (free-tier auto-pause)

Supabase pauses Free-plan projects that don't get **"a few user requests to the database each day over the previous week."** A paused project would **not** take the public site down — recipe pages are pre-rendered static HTML with no request-time DB access — but login, `/shopping`, `/create` and `/settings` would all break.

- **Cron:** `wrangler.jsonc` → `triggers.crons` = `0 */6 * * *` (four times a day). The handler is `scheduled()` in `worker.ts`, which reads one row from `recipes` and one from `ingredients` via the REST API.
- **Failures throw, they don't log.** A thrown error marks the invocation failed in Workers **Observability**; a `console.error` just scrolls past. The original daily ping (added 2026-07-12) failed unnoticed until a pause warning arrived **2026-09-09**.
- **`GET /api/keepalive`** — public, uncached, runs the identical code path. `200 {"ok":true,…}` means the keep-alive works end to end; `503` reports which check failed. Use it instead of hunting through Cloudflare logs.
- **External monitor.** Point a free scheduler (cron-job.org, UptimeRobot) at `https://<site>/api/keepalive` every 15 min. This is the important half: it's independent of whether the Worker's cron fires, and it **emails on failure** — the gap that let the July breakage run for eight weeks. Nothing secret is exposed; the endpoint returns no keys.
- **If a pause warning arrives anyway:** activity generated during the warning window prevents the pause. Hitting `/api/keepalive` a few times is enough.
- **Not recommended:** Supabase Pro ($25/mo) removes pausing and adds daily backups, but that's a lot for a two-person cookbook when the cron covers it. Do note there is **no backup of recipe data outside Supabase** — worth a periodic manual export from the dashboard.

---

## Recipe import (server-side)

**`functions/api/import-recipe.ts`** is the **only server-side code in the project.** Everything else in this app is either static (recipe pages, built at deploy time) or client-side (auth, writes, shopping list — see **Critical rendering rule** above). This endpoint does not change that: it's called on demand from the create form to pre-fill fields from a pasted URL, never from a recipe read path. Recipe pages remain pre-rendered static HTML with no DB access at request time.

It's a handler (`POST /api/import-recipe`) written in Pages-Function style (`onRequest({ request, env })`) but manually dispatched from `worker.ts` — see **Deployment (Cloudflare Workers, Git-connected)** above for why that dispatch step exists.

### Auth

Reuses the existing Supabase session — the client (`initImportPanel` in `src/lib/recipe-form-ui.ts`) sends `Authorization: Bearer <access_token>` from the current session. The Function validates that token by calling `${PUBLIC_SUPABASE_URL}/auth/v1/user` with the anon key; a non-200 response is treated as unauthorized. Since public sign-ups are disabled, this is effectively Tim/Zoe-only, same as the rest of the write paths.

### Request / response contract

```
POST /api/import-recipe
Authorization: Bearer <supabase access token>
Content-Type: application/json

{
  "url": "https://example.com/some-recipe",
  "known_ingredients": ["brown onion", "plain flour", "..."]  // optional
}
```

`known_ingredients` is the client's already-fetched list of canonical `ingredients.name` values (`fetchKnownIngredients()`), sent so the normalisation prompt can bias ingredient text toward names already in the registry instead of the source site's own wording — reducing near-duplicate canonical entries. Untrusted client input: the Function validates it's a string array and caps it at 500 entries before it reaches the prompt. Optional — omitting it (or sending `[]`) just means the model has no existing names to prefer.

Success (`200`):

```jsonc
{
  "source_url": "https://example.com/some-recipe",
  "recipe": {
    "title": "string",
    "category": "string | null",        // existing slug or null — never invented
    "protein": "string | null",         // slug(s), comma-separated
    "cook_time_min": 45,
    "ingredients": [ { "quantity": 2, "unit": "cup", "text": "plain flour, sifted" } ],
    "method": ["Label: step text", "step text"],
    "tips": ["..."],
    "substitutions": ["..."]
  }
}
```

Errors are `{ "error": "message" }` with status `400` (bad body / invalid or disallowed URL), `401` (unauthorized), `405` (non-POST), `422` (couldn't fetch the page), `500` (server misconfigured — missing Supabase env), or `502` (LLM couldn't produce valid JSON after retry). Keep this shape stable — `recipe-form-ui.ts` depends on it directly.

### SSRF guard

`validateTargetUrl()` only allows `http`/`https`, rejects `localhost`/`.local` hostnames, rejects private/loopback/link-local/CGNAT IPv4 (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `0.0.0.0/8`) and loopback/link-local/unique-local IPv6, and rejects non-standard ports (only `80`/`443`). The fetch itself is capped at a 10s timeout and 2 MB of response body.

### Pipeline: JSON-LD first, LLM to normalise

1. Fetch the target page HTML (`fetchPage`).
2. Extract `<script type="application/ld+json">` blocks and search them (including `@graph`) for a node whose `@type` includes `Recipe`.
3. If found, build a raw recipe straight from schema.org fields — `recipeIngredient`, `recipeInstructions` (including `HowToSection`/`HowToStep`, flattened with section labels), ISO 8601 `cookTime`/`totalTime` parsed to minutes, `recipeCategory`/`keywords` as a category hint.
4. If no JSON-LD `Recipe` node exists, fall back to stripped/decoded plain page text (capped at 15k chars) as the input instead.
5. Either shape is passed to `normaliseRecipe()` (`functions/lib/recipe-normaliser.ts`), which prompts a Workers AI model (`@cf/meta/llama-3.1-8b-instruct`) to emit JSON matching the app's recipe shape — one retry if the first reply isn't valid JSON.
6. `functions/lib/recipe-categories.ts` fetches the distinct existing `recipes.category` values (public anon key, best-effort) beforehand so the model reuses an existing slug instead of inventing one.

The imported recipe only pre-fills the create form — it is not saved until Tim/Zoe review and submit normally, going through the usual client-side save path (ingredient upsert, category prompts, etc.).

### Workers AI binding

`wrangler.jsonc` declares `"ai": { "binding": "AI" }` — required for `env.AI.run(...)` to work. This is Cloudflare-specific config with no Astro equivalent; it has no effect on the static build.

### Local dev requires `wrangler dev`

The import endpoint does **not** run under Astro's dev server — `npm run dev` will not serve `/api/import-recipe` (404). To test it locally: `npm run build` then `npx wrangler dev`, which runs `worker.ts` (routing `/api/import-recipe` to the handler, everything else to the static `dist` build) through Cloudflare's local runtime, with the `AI` and `ASSETS` bindings available. Local env vars go in `.dev.vars` (gitignored), not `.env` (that one is Astro/Vite-only).

---

## Repo layout

```
/                        ← Astro project root
  astro.config.mjs       ← Tailwind wired via vite.plugins: [tailwindcss()]
  package.json
  tsconfig.json
  wrangler.jsonc         ← Worker config: main (worker.ts), assets binding, AI binding
  worker.ts               ← Worker entrypoint — dispatches /api/* routes (import-recipe, keepalive), falls back to ASSETS; also holds the scheduled() Supabase keep-alive (see Deployment)
  .env                   ← Supabase URL + anon key (gitignored)
  .dev.vars               ← local-only env vars for `wrangler dev` (gitignored)
/docs/
  brand-hearth.md        ← Hearth brand guide (colours, type, component patterns)
/functions/              ← Server-side route handlers, written Pages-Function style but dispatched manually from worker.ts (see Deployment)
  /api/
    import-recipe.ts     ← POST /api/import-recipe: auth check, fetch + SSRF guard, JSON-LD/LLM pipeline
  /lib/
    recipe-normaliser.ts ← Workers AI prompt + response validation (normaliseRecipe)
    recipe-categories.ts ← fetch existing recipes.category values for the LLM prompt
/scripts/
  ingredient-registry-rpc.sql  ← merge + touch_recipes RPCs; run once in Supabase SQL editor
  check-supabase-schema.mjs    ← verify expected columns and RPCs against live Supabase
/public/                 ← static assets (favicon, etc.)
/src/
  /pages/
    index.astro          ← homepage: sticky hero, featured, filter panel, recipe list (inline client script)
    login.astro          ← email + password login
    create.astro         ← create/edit recipe form (auth-gated)
    shopping.astro       ← shared shopping list (auth-gated)
    sourdough.astro      ← public loaf calculator; ratios read at build time
    settings.astro       ← site status (auth-gated)
    /settings/
      ingredients.astro  ← canonical ingredient registry admin (auth-gated)
    /recipes/
      [slug].astro       ← static recipe detail (getStaticPaths at build time)
  /layouts/
    Layout.astro         ← shared HTML shell; fonts, wordmark, auth-aware nav; bottom nav on mobile
  /lib/
    supabase.ts          ← Supabase client singleton (always import from here)
    auth.ts              ← signIn, signOut, getSession, requireAuth, initAuthUI
    format.ts            ← toDisplayLabel, splitValues, parseStepLabel, stripBullet
    slug.ts              ← titleToSlug (hyphen-separated slugs)
    ingredient.ts              ← normalizeIngredient, displayIngredientName
    ingredient-sections.ts     ← INGREDIENT_SECTION_ORDER, sectionDisplayLabel, sectionSortIndex
    ingredient-category-prompt.ts ← M3 modal: pick aisle for new canonical ingredients
    ingredient-autocomplete.ts ← shared autocomplete wiring for ingredient inputs
    ingredient-registry.ts     ← fetch/edit canonical ingredients, reference counts, rename/merge/delete
    ingredient-registry-ui.ts  ← registry table UI, edit/confirm dialogs, “used in” modal
    settings.ts                ← shopping list last-changed fetch; shared timestamp formatting
    sourdough.ts               ← loaf scaling maths (baker's percentages); DOM-free
    units.ts                   ← shopping-list unit conversion
    recipe-editor.ts           ← load/save recipe, ingredients registry, category upsert, autocomplete
    recipe-form-ui.ts          ← create/edit form DOM wiring, new-ingredient prompt on submit
    shopping-list.ts           ← shopping list CRUD, merge on add, category join, realtime subscription
    shopping-list-ui.ts        ← shopping list DOM, grouping toggle, row layout
    shopping-list-drag.ts      ← section-scoped drag reorder (FLIP + lift/settle)
  /styles/
    global.css           ← Tailwind entry point + Hearth colour tokens (@theme block)
```

### Key wiring notes

- **Tailwind:** imported via `src/styles/global.css`. `Layout.astro` imports it — all pages that use the layout get Tailwind automatically.
- **Fonts:** Newsreader + Hanken Grotesk loaded in `Layout.astro` via Fontsource; stacks wired in `@theme`.
- **Brand guide:** visual design reference at `docs/brand-hearth.md`.
- **Supabase client:** always import from `src/lib/supabase.ts`; never instantiate `createClient` elsewhere.
- **Format helpers:** always import `toDisplayLabel` and `splitValues` from `src/lib/format.ts` before rendering any category or protein value.
- **Featured recipes:** edit `FEATURED_SLUGS` in `index.astro`. Use **hyphen slugs** as stored in the DB (e.g. `sourdough-bread`, not `sourdough_bread`). Order in the array controls display order.
- **Auth UI toggling:** elements with `data-auth-only` / `data-nav-guest` are shown/hidden by `initAuthUI()` in `Layout.astro`.
- **Dev server:** `npm run dev` → [http://localhost:4321](http://localhost:4321)
- **Production preview:** `npm run build` then `npm run preview` (requires `.env` with Supabase keys at build time).
