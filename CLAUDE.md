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

-- Ingredients for each recipe
create table recipe_ingredients (
  id            bigint generated always as identity primary key,
  recipe_slug   text not null references recipes(slug) on delete cascade,
  ingredient    text not null,       -- normalised name, e.g. 'mushroom'
  display_name  text,               -- original wording, e.g. 'button mushrooms'
  quantity      numeric,
  unit          text                -- 'g','kg','ml','cup','each','pinch'...
);

-- The single shared shopping list (both users share one list)
create table shopping_list (
  id          bigint generated always as identity primary key,
  ingredient  text not null,        -- e.g. 'mushroom'
  quantity    numeric,
  unit        text,                 -- canonical unit after conversion, e.g. 'g' or 'each'
  checked     boolean not null default false,
  position    integer,              -- for drag reorder
  added_at    timestamptz default now()
);
```

> **Pending migration** — run this once in the Supabase SQL editor if `tips`/`substitutions` columns don't yet exist:
> ```sql
> alter table recipes add column if not exists tips          text;
> alter table recipes add column if not exists substitutions text;
> ```
> Then re-run `scripts/migrate-legacy.mjs` (with service-role key) to populate all three text fields.

### Row-level security

- `recipes` and `recipe_ingredients` — public **SELECT**; authenticated-only **INSERT/UPDATE/DELETE**.
- `shopping_list` — authenticated-only for everything (no public access).

### Key design decisions

- Primary keys are **slugs**, not UUIDs. Slugs are generated from the title on **create** (`titleToSlug()` in `src/lib/slug.ts` — hyphen-separated, e.g. `mixed-berry-muffins`) and **never change on edit**, even if the title is updated.
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

### Canonical storage (`ingredient` column)

Keep all normalisation logic in `src/lib/ingredient.ts` (`normalizeIngredient()`).

On save (create/edit form and manual shopping-list add):

1. **Autocomplete safeguard** — as the user types, suggest existing `ingredient` values from `recipe_ingredients` so they reuse a canonical entry (e.g. pick `onion` instead of creating a variant). Shared UI in `src/lib/ingredient-autocomplete.ts`.
2. **Normalise on save** — for genuinely new input: lowercase, trimmed, `pluralize.singular()` on the **last word** (handles potato/potatoes, leaf/leaves, berry/berries). Small exceptions list for words that look plural but aren't (e.g. `bitters`, `lentils`).

Store the result in `ingredient`. Keep the user's wording in `display_name`.

### Display pluralisation (recipe detail only)

`displayIngredientName()` in `src/lib/ingredient.ts` — when `quantity > 1` and `unit === 'each'`, pluralise the last word of the display name for rendering only (e.g. `3 button mushroom` → `3 button mushrooms`). Stored values stay singular.

---

## Category and protein display rules

- Stored as slug-style strings: `sweet_treat`, `nuts_seeds`, `grains_rice`.
- **Never show the raw slug in the UI.** Always run through `toDisplayLabel()` from `src/lib/format.ts`, which replaces `_` and `-` with spaces and title-cases each word: `"sweet_treat"` → `"Sweet Treat"`.
- `protein` may contain comma-separated values (`"chickpea, lentils"`). Use `splitValues()` from `src/lib/format.ts` to get individual values before rendering filter options or metadata.
- **Category chip** (homepage list + recipe header): `bg-primary-container text-on-primary-container text-xs rounded-full px-2 py-0.5 font-medium`.
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

When adding a recipe's ingredients to the shopping list: if the same `ingredient` in the same canonical `unit` already exists, **add the quantities** rather than creating a duplicate row.

Keep all conversion logic in `src/lib/units.ts` (`toShoppingUnit()`, `addQuantities()`, `shoppingMergeKey()`).

### Shopping list UI (`/shopping`)

- Auth-gated. Single shared list synced via Supabase (`shopping-list.ts` + realtime `postgres_changes` subscription).
- **Add from recipe** — "Add to shopping list" button on recipe pages (auth-only); converts units then merges rows.
- **Manual add** — ingredient field with autocomplete; qty uses `type="text"` + `inputmode="decimal"` (no native number spinners on mobile).
- **Reorder** — pointer-based drag on the grip handle (touch + mouse); persists `position` column.
- **Other actions** — tick off (`checked`), edit qty/unit inline, delete, clear checked.

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

Used for filters, search, shopping-list inline fields, and the manual-add form:

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

- **Hero** — `bg-surface-low/80` block with tagline + search; search uses the subtle input pattern above.
- **Featured** — hand-picked recipes above the filters. Slugs in `FEATURED_SLUGS` at the top of `index.astro` (currently `sourdough-bread`, `mixed-berry-muffins`, `mexican-rice-arroz-rojo`). Peach cards (`bg-primary-container rounded-2xl`) in a 3-column grid with title + muted category/cook time.
- **Filters** — three `<select>` dropdowns (category, protein, cook time) using the subtle input pattern. Client-side filter script reads dropdown values.
- **All recipes list** — title left; category chip + cook time right.

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
- Auth-gated. Dynamic ingredient rows, method steps, tips, substitutions. Ingredient autocomplete on each row.

#### Shopping list (`shopping.astro`)

- Auth-gated. Manual-add panel (`bg-surface-low/80`). Single-row list items with drag grip, checkbox, name, qty, unit, delete.

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
  migrate-legacy.mjs     ← one-off migration: Jekyll → Supabase (service-role key only)
/public/                 ← static assets (favicon, etc.)
/src/
  /pages/
    index.astro          ← homepage: hero, featured cards, filters, full list
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
    ingredient.ts        ← normalizeIngredient, displayIngredientName
    ingredient-autocomplete.ts ← shared autocomplete wiring for ingredient inputs
    units.ts             ← shopping-list unit conversion
    recipe-editor.ts     ← load/save recipe, fetchKnownIngredients, matchIngredients
    recipe-form-ui.ts    ← create/edit form DOM wiring
    shopping-list.ts     ← shopping list CRUD, merge on add, realtime subscription
    shopping-list-ui.ts  ← shopping list DOM wiring, drag reorder
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
