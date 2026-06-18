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

---

## Critical rendering rule

**Recipes are PRE-RENDERED at build time (static pages).** They must never call the database at read time. The Supabase client is only used:

1. **At build time** — to fetch recipe data for static generation.
2. **Client-side for writes** — adding/editing recipes (authenticated only).
3. **Client-side for the shopping list** — read and write (authenticated only).

If a feature would make recipe pages depend on Supabase at request time, reject that approach.

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
  unit        text,                 -- 'g' or 'each' (or free text for manual adds)
  checked     boolean not null default false,
  position    integer,              -- for manual reorder
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

- Primary keys are **slugs**, not UUIDs. Keep slugs stable even if a recipe title changes — links and shopping-list history depend on them.
- Public sign-ups are **disabled** in Supabase Auth. Only manually-added accounts (Tim + Zoe) can log in.

---

## Stored text formats

These conventions apply to the `method`, `tips`, and `substitutions` columns, and must be respected by the Create Recipe form when it is built.

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

## Category and protein display rules

- Stored as slug-style strings: `sweet_treat`, `nuts_seeds`, `grains_rice`.
- **Never show the raw slug in the UI.** Always run through `toDisplayLabel()` from `src/lib/format.ts`, which replaces `_` and `-` with spaces and title-cases each word: `"sweet_treat"` → `"Sweet Treat"`.
- `protein` may contain comma-separated values (`"chickpea, lentils"`). Use `splitValues()` from `src/lib/format.ts` to get individual values before rendering chips or filter options.
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

Keep all conversion logic in a single helper file (`src/lib/units.ts`) so it's easy to audit.

---

## Design system

The UI follows **Material Design 3** with a warm cookbook palette.

### Colour tokens — defined in `src/styles/global.css` via `@theme`

| Token | Value | Used for |
|---|---|---|
| `primary` | `#B85C38` | Terracotta — buttons, active chips, step numbers |
| `primary-container` | `#FFDBCB` | Hero card background, header card |
| `on-primary-container` | `#3E0D00` | Text on primary-container |
| `secondary` | `#5C7A62` | Sage — protein chips, secondary actions |
| `secondary-container` | `#CCE8D2` | Tips card background |
| `surface` | `#FFF8F5` | Page background (warm off-white) |
| `surface-container` | `#EFE5E0` | Substitutions card, hover states |
| `on-surface-muted` | `#53403B` | Secondary text, metadata |
| `outline-soft` | `#D8C2BC` | Dividers, card borders |

### Shape scale

- Cards and containers: `rounded-2xl` (16 px)
- Chips and pills: `rounded-full`
- Ingredient rows: no rounding (inside a `rounded-2xl` container)

### Typography

- Headings / wordmark: `font-serif` (system serif stack)
- Body / UI: `font-sans` (system sans-serif stack)
- No external font CDN.

### Navigation

- **Desktop:** horizontal links in the top app bar (Recipes / Shopping List / Create Recipe).
- **Mobile:** fixed bottom nav bar with icon + label for each of the three destinations.
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
    index.astro          ← homepage: hero, search, filter chips, featured, full list
    /recipes/
      [slug].astro       ← static recipe detail (getStaticPaths at build time)
  /layouts/
    Layout.astro         ← shared HTML shell; imports global.css; top bar + bottom nav
  /components/
    RecipeCard.astro     ← M3 portrait card used in the "Recently added" section
  /lib/
    supabase.ts          ← Supabase client singleton (always import from here)
    format.ts            ← display utilities: toDisplayLabel, splitValues, parseStepLabel, stripBullet
    units.ts             ← shopping-list unit conversion (to be created)
  /styles/
    global.css           ← Tailwind entry point + M3 colour tokens (@theme block)
```

### Key wiring notes

- **Tailwind:** imported via `src/styles/global.css`. `Layout.astro` imports it — all pages that use the layout get Tailwind automatically.
- **Supabase client:** always import from `src/lib/supabase.ts`; never instantiate `createClient` elsewhere.
- **Format helpers:** always import `toDisplayLabel` and `splitValues` from `src/lib/format.ts` before rendering any category or protein value.
- **Dev server:** `npm run dev` → [http://localhost:4321](http://localhost:4321)
