# Yumlog — Project Context

A personal cookbook for two users (Tim + Zoe). Public read-only; only the two of them can log in and edit.

---

## Stack

| Layer     | Technology                                                          |
| --------- | ------------------------------------------------------------------- |
| Frontend  | Astro, deployed to **Cloudflare Pages**                             |
| Styling   | Tailwind CSS                                                        |
| Backend   | Supabase (Postgres + Auth)                                          |
| DB client | `@supabase/supabase-js`                                             |

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
  category       text,
  protein        text,
  cook_time_min  integer,
  method         text not null,
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

### Row-level security

- `recipes` and `recipe_ingredients` — public **SELECT**; authenticated-only **INSERT/UPDATE/DELETE**.
- `shopping_list` — authenticated-only for everything (no public access).

### Key design decisions

- Primary keys are **slugs**, not UUIDs. Keep slugs stable even if a recipe title changes — links and shopping-list history depend on them.
- Public sign-ups are **disabled** in Supabase Auth. Only manually-added accounts (Tim + Zoe) can log in.

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

Keep all conversion logic in a single helper file (e.g. `src/lib/units.ts`) so it's easy to audit.

---

## Priorities

1. **Recipe availability first.** The shopping list must never break or block access to recipes.
2. **Simple and human-readable.** Prefer clear, obvious code over clever abstractions.
3. **Mobile-friendly.** Tim and Zoe cook from their phones.

---

## Environment variables

```
PUBLIC_SUPABASE_URL=      # from Supabase → Settings → API
PUBLIC_SUPABASE_ANON_KEY= # public anon key (safe to expose)
```

The service-role key is **never** committed. It is only used in one-off migration scripts, deleted immediately after.

---

## Repo layout

```
/                   ← Astro project root
/legacy/            ← old Jekyll site (kept for recipe migration)
/src/
  /pages/           ← Astro pages
  /lib/             ← shared helpers (units.ts, supabase.ts, …)
  /components/      ← Astro/UI components
```
