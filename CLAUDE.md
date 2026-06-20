# Yumlog — Project Context

A personal cookbook for two users (Tim + Zoe). Public read-only; only the two of them can log in and edit.

---

## Stack

| Layer     | Technology                                                          |
| --------- | ------------------------------------------------------------------- |
| Frontend  | Astro 6, deployed to **Cloudflare Pages**                           |
| Styling   | Tailwind CSS 4 (via `@tailwindcss/vite`, not `@astrojs/tailwind`)   |
| Backend   | Supabase (Postgres + Auth)                                          |
| DB client | `@supabase/supabase-js` 2                                           |
| Other     | `pluralize` — ingredient normalisation and display pluralisation    |

---

## Critical rendering rule

**Recipes are PRE-RENDERED at build time (static pages).** They must never call the database at read time. The Supabase client is only used:

1. **At build time** — to fetch recipe data for static generation.
2. **Client-side for auth** — login session check and nav gating (authenticated only).
3. **Client-side for writes** — adding/editing recipes (authenticated only).
4. **Client-side for the shopping list** — read and write (authenticated only).

If a feature would make recipe pages depend on Supabase at request time, reject that approach.

**After creating a new recipe**, the row exists in Supabase immediately but the static page won't appear until the next `npm run build` / deploy. Edits to existing recipes update the DB immediately; the static HTML updates on the next build too.

---

## Authentication

- **Login:** `/login` — email + password via `signInWithPassword`. Redirects to `?redirect=` on success (defaults to `/`).
- **Session:** client-side only — Supabase persisted session in the browser. No SSR.
- **Guests see:** Recipes nav + Log in. Recipe pages are fully public.
- **Logged-in users see:** Recipes, Shopping, Create, Sign out; edit controls on recipe pages.
- **Protected pages:** `/shopping`, `/create` — client-side `requireAuth()` redirects to login if no session.
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
  created_at     timestamptz default now()
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
  added_at    timestamptz default now()
);
```

`ingredients.category` is constrained in Postgres to one of eleven fixed aisle values (see **Ingredient shopping sections** below), or `null`.

> **Pending migration** — run this once in the Supabase SQL editor if `tips`/`substitutions` columns don't yet exist:
> ```sql
> alter table recipes add column if not exists tips          text;
> alter table recipes add column if not exists substitutions text;
> ```
> Then re-run `scripts/migrate-legacy.mjs` (with service-role key) to populate all three text fields.

### Row-level security

- `recipes` and `recipe_ingredients` — public **SELECT**; authenticated-only **INSERT/UPDATE/DELETE**.
- `ingredients` — public **SELECT** (needed at build time for joins and client autocomplete); authenticated-only writes.
- `shopping_list` — authenticated-only for everything (no public access).

### Key design decisions

- Primary keys are **slugs**, not UUIDs. Slugs are generated from the title on **create** (`titleToSlug()` in `src/lib/slug.ts` — hyphen-separated, e.g. `mixed-berry-muffins`) and **never change on edit**, even if the title is updated.
- **Canonical ingredients** live in `ingredients` (one row per normalised name). `recipe_ingredients.ingredient` and `shopping_list.ingredient` are FKs to `ingredients.name` (`on update cascade`, `on delete restrict` — cannot delete a canonical name still referenced by a recipe).
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
- **Other actions** — tick off (`checked`), edit qty/unit inline, delete, clear checked, clear all (with confirmation dialog).

> Enable **Realtime** for `shopping_list` in Supabase → Database → Replication if cross-device live sync is needed.

---

## Design system

The UI follows **Material Design 3** with a warm cookbook palette.

### Colour tokens — defined in `src/styles/global.css` via `@theme`

| Token | Value | Used for |
|---|---|---|
| `primary` | `#B85C38` | Terracotta — buttons, links, ingredient quantities |
| `primary-container` | `#FFDBCB` | Featured cards, category chips |
| `on-primary-container` | `#3E0D00` | Text on primary-container |
| `secondary` | `#5C7A62` | Sage — secondary actions (e.g. add to shopping list) |
| `secondary-container` | `#CCE8D2` | (reserved) |
| `surface` | `#FFF8F5` | Page background (warm off-white) |
| `surface-low` | `#F5EDE8` | Hero / panel backgrounds (`bg-surface-low/80`) |
| `surface-container` | `#EFE5E0` | Subtle input fills, hover states |
| `on-surface-muted` | `#53403B` | Secondary text, metadata, cook time |
| `outline-soft` | `#D8C2BC` | Dividers, borders |

### Subtle input pattern

Used for search, filter-panel selects, shopping-list inline fields, and the manual-add form:

```
bg-surface-container/50 border border-transparent rounded-xl
text-sm text-on-surface-muted
focus:text-on-surface focus:bg-surface-container focus:border-outline-soft/60
```

Avoid stark `bg-white` boxes for inline editable fields.

### Shape scale

- Panels and hero: `rounded-2xl` (16 px)
- Inputs and filters: `rounded-xl`
- Category chips: `rounded-full`
- No boxed cards on recipe detail — content sits directly on the page surface

### Typography

- Headings / wordmark: `font-serif` (system serif stack)
- Body / UI: `font-sans` (system sans-serif stack)
- No external font CDN.

### UI patterns

Keep styling **minimal and text-forward** — no coloured section cards on recipe pages, no gradient portrait cards on the homepage.

#### Homepage (`index.astro`)

All homepage interactivity lives in a single inline `<script>` at the bottom of `index.astro` (search, filters, hero scroll, featured visibility). No separate lib file.

- **Sticky hero** (`#hero`) — `bg-surface-low/80 rounded-2xl`, `sticky top-16 z-10` (sits below the `h-16` app bar in `Layout.astro`). Contains:
  - **Welcome intro** (`#hero-intro`) — tagline + serif headline + decorative icon. On **mobile only**, scroll-dismisses quickly: opacity/height/transform interpolate over ~40px with a steep cubic curve (`scrollY / 40` then `t³`). The search row stays pinned; hero padding compacts and gains `shadow-sm` once collapsed (~28px scroll).
  - **Search row** — flex row: search input (`#search`, subtle input pattern) + **filter icon button** (`#filter-toggle`, 42×42, same subtle fill). Filter badge (`#filter-badge`) shows active filter **count** only when category/protein/cook-time filters are set — toggle `hidden`/`flex` in JS (never combine `hidden` + `inline-flex` on the same element).
  - **Active filter chips** (`#active-filter-chips`) — removable peach pills rendered below the search row when filters are active (all breakpoints).
- **Featured** (`#featured-section`) — hand-picked recipes above the full list. Slugs in `FEATURED_SLUGS` at the top of `index.astro` (currently `sourdough-bread`, `mixed-berry-muffins`, `mexican-rice-arroz-rojo`). Order in the array controls display order.
  - **Layout** — full-width `grid grid-cols-3` (equal thirds on mobile and desktop). Title only on featured cards — **no** category chip or cook time (those stay on the main recipe list).
  - **Cards** — `bg-primary-container`, `rounded-xl` (mobile) / `rounded-2xl` (sm+), compact `text-[11px]` / `text-sm` serif titles with `line-clamp-3`.
  - **Visibility** — hidden while the user is searching, has active filters, or (mobile only) has scrolled past the welcome collapse.
- **Filters** — unified panel for all breakpoints (no inline desktop dropdowns). Filter icon opens `#filter-panel`:
  - **Mobile** — bottom sheet over a dimmed backdrop.
  - **Desktop (`sm+`)** — centred dialog (`sm:max-w-md`, `rounded-2xl`).
  - Three `<select>`s (category, protein, cook time) using the subtle input pattern. Header has **Clear filters** (visible only when filters active) and **Done**. Client-side script syncs selects → `activeFilters` → recipe list visibility.
  - **All recipes header** — separate **Clear filters** link clears search + filter selects when anything is active.
- **All recipes list** — title left; category chip + cook time right (unchanged from recipe list pattern).

#### Recipe detail (`recipes/[slug].astro`)

- **Header** — plain title on page surface (no coloured header card). Metadata row below title:
  - **Category** — peach pill chip (same as homepage list).
  - **Protein** — plain `text-xs text-on-surface-muted` (no chip).
  - **Cook time** — `text-xs text-on-surface-muted`.
- **Auth-only toolbar** — "Edit recipe" (`/create?edit={slug}`) and "Add to shopping list" buttons; hidden for guests via `data-auth-only` + `initAuthUI()`.
- **Ingredients** — flat list on page background. Quantities right-aligned in `text-primary/70`; names pluralised on display when qty > 1 and unit is `each`.
- **Method** — plain numbered list (`1.` in muted text). Step labels via `parseStepLabel()`.
- **Tips / substitutions** — simple `list-disc` bullet lists under section headings.

#### Create / edit (`create.astro`)

- Single form for both modes. **Create:** `/create`. **Edit:** `/create?edit={slug}` — prepopulates fields; slug stays fixed on save.
- Auth-gated. Dynamic ingredient rows, method steps, tips, substitutions. Ingredient autocomplete on each row (all canonical names).
- **New ingredient prompt** — on save, any canonical name not yet in `ingredients` opens the category picker before write.

#### Shopping list (`shopping.astro`)

- Auth-gated. Manual-add panel (`bg-surface-low/80`). Grouped or flat list (see **Shopping list UI** above). M3 section headers when grouped; terracotta accent on checkbox switch and primary actions.

### Navigation

- **Guests (desktop + mobile):** Recipes + Log in.
- **Logged in:** Recipes, Shopping, Create + Sign out (desktop header).
- **Mobile:** fixed bottom nav — same items as above.
- Pass `activeNav` prop to `Layout.astro` to highlight the current tab.

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
- The **service-role key** is never committed. It is only used in one-off migration scripts, deleted immediately after.

## Environment variables

```
PUBLIC_SUPABASE_URL=https://nrmimftrjulvsgonrlzg.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<JWT anon key — see .env, never commit>
```

Set the same variables in **Cloudflare Pages** → project → **Settings** → **Environment variables** (Production, and Preview if needed). Also set `NODE_VERSION=22` (required by `package.json` engines).

---

## Deployment (Cloudflare Pages)

Hosted at **Cloudflare Pages**, connected to GitHub repo `Tim-Claessen/yumlog-v2`.

### Build settings

| Setting | Value |
| ------- | ----- |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Root directory | `/` (repo root) |

No Cloudflare adapter — plain static output from `astro build`.

### Automatic rebuilds on recipe changes

Recipes are pre-rendered at build time (see **Critical rendering rule**). After create/edit in the app, the DB updates immediately; static HTML updates when Cloudflare finishes the next deploy (~2–3 min).

**Cloudflare deploy hook** — Pages project → **Settings** → **Builds & deployments** → **Deploy hooks**. Create a hook on the production branch (`main`). Copy the secret POST URL.

**Supabase database webhook** — **Database** → **Webhooks** → create webhook:

| Field | Value |
| ----- | ----- |
| Table | `recipes` |
| Events | INSERT, UPDATE, DELETE |
| Method | POST |
| URL | Cloudflare deploy hook URL |

Hook `recipes` only — not `recipe_ingredients` or `shopping_list`. Every save touches `recipes` first; ingredients are written milliseconds later, well before the queued build fetches data. Shopping list is client-side only and does not need rebuilds.

Treat the deploy hook URL like a password. Test with `curl -X POST "<hook-url>"` or by saving a recipe and checking webhook logs (Supabase) and **Deployments** (Cloudflare).

Git pushes to `main` also trigger builds; the webhook covers DB-only changes from the create/edit form.

---

## Repo layout

```
/                        ← Astro project root
  astro.config.mjs       ← Tailwind wired via vite.plugins: [tailwindcss()]
  package.json
  tsconfig.json
  .env                   ← Supabase URL + anon key (gitignored)
/legacy/                 ← old Jekyll site — source of truth for recipe migration
/scripts/
  migrate-legacy.mjs     ← one-off migration: Jekyll → Supabase (upserts ingredients, then recipe_ingredients)
/public/                 ← static assets (favicon, etc.)
/src/
  /pages/
    index.astro          ← homepage: sticky hero, featured, filter panel, recipe list (inline client script)
    login.astro          ← email + password login
    create.astro         ← create/edit recipe form (auth-gated)
    shopping.astro       ← shared shopping list (auth-gated)
    /recipes/
      [slug].astro       ← static recipe detail (getStaticPaths at build time)
  /layouts/
    Layout.astro         ← shared HTML shell; auth-aware nav; bottom nav on mobile
  /lib/
    supabase.ts          ← Supabase client singleton (always import from here)
    auth.ts              ← signIn, signOut, getSession, requireAuth, initAuthUI
    format.ts            ← toDisplayLabel, splitValues, parseStepLabel, stripBullet
    slug.ts              ← titleToSlug (hyphen-separated slugs)
    ingredient.ts              ← normalizeIngredient, displayIngredientName
    ingredient-sections.ts     ← INGREDIENT_SECTION_ORDER, sectionDisplayLabel, sectionSortIndex
    ingredient-category-prompt.ts ← M3 modal: pick aisle for new canonical ingredients
    ingredient-autocomplete.ts ← shared autocomplete wiring for ingredient inputs
    units.ts                   ← shopping-list unit conversion
    recipe-editor.ts           ← load/save recipe, ingredients registry, category upsert, autocomplete
    recipe-form-ui.ts          ← create/edit form DOM wiring, new-ingredient prompt on submit
    shopping-list.ts           ← shopping list CRUD, merge on add, category join, realtime subscription
    shopping-list-ui.ts        ← shopping list DOM, grouping toggle, row layout
    shopping-list-drag.ts      ← section-scoped drag reorder (FLIP + lift/settle)
  /styles/
    global.css           ← Tailwind entry point + M3 colour tokens (@theme block)
```

### Key wiring notes

- **Tailwind:** imported via `src/styles/global.css`. `Layout.astro` imports it — all pages that use the layout get Tailwind automatically.
- **Supabase client:** always import from `src/lib/supabase.ts`; never instantiate `createClient` elsewhere.
- **Format helpers:** always import `toDisplayLabel` and `splitValues` from `src/lib/format.ts` before rendering any category or protein value.
- **Featured recipes:** edit `FEATURED_SLUGS` in `index.astro`. Use **hyphen slugs** as stored in the DB (e.g. `sourdough-bread`, not `sourdough_bread`). Order in the array controls display order.
- **Auth UI toggling:** elements with `data-auth-only` / `data-nav-guest` are shown/hidden by `initAuthUI()` in `Layout.astro`.
- **Dev server:** `npm run dev` → [http://localhost:4321](http://localhost:4321)
- **Production preview:** `npm run build` then `npm run preview` (requires `.env` with Supabase keys at build time).
