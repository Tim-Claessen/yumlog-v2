# Yumlog — Project Context

A personal cookbook for two users (Tim + Zoe). Public read-only; only members of the allowlist (`yumlog.members`) can edit. Today that's Tim only — Zoe has no account yet (see **Adding Zoe**).

---

## Stack

| Layer     | Technology                                                          |
| --------- | ------------------------------------------------------------------- |
| Frontend  | Astro 6, deployed to **Cloudflare Workers** (static assets + a thin routing worker — see **Deployment**) |
| Styling   | Tailwind CSS 4 (via `@tailwindcss/vite`, not `@astrojs/tailwind`)   |
| Backend   | Supabase (Postgres + Auth) — the **`yumlog` schema inside wrapt's Supabase project** (see **Supabase project**) |
| DB client | `@supabase/supabase-js` 2, created with `db: { schema: 'yumlog' }`  |
| Fonts     | `@fontsource-variable/newsreader`, `@fontsource-variable/hanken-grotesk` |
| Other     | `pluralize` — ingredient normalisation and display pluralisation    |

---

## Critical rendering rule

**Recipes are PRE-RENDERED at build time (static pages).** They must never call the database at read time. The Supabase client is only used:

1. **At build time** — to fetch recipe data for static generation.
2. **Client-side for auth** — login session check and nav gating (authenticated only).
3. **Client-side for writes** — adding/editing recipes (members only).
4. **Client-side for the shopping list** — read and write (members only).
5. **Client-side for settings** — site status and ingredient registry (members only); no build-time DB reads for user-specific data.

If a feature would make recipe pages depend on Supabase at request time, reject that approach.

**After creating a new recipe**, the row exists in Supabase immediately but the static page won't appear until the next `npm run build` / deploy. Edits to existing recipes update the DB immediately; the static HTML updates on the next build too.

**Build guard.** `index.astro` and `recipes/[slug].astro` call `failBuild()` (`src/lib/build-guard.ts`) if a build-time recipe query errors or the recipe list comes back empty. The build fails, Workers Builds skips the deploy, and the last good site stays live — instead of an empty site deploying "successfully" because a variable, the exposed-schema list or a grant was wrong. `/sourdough` keeps its own `FALLBACK_RATIOS` instead.

---

## Authentication

- **Login:** `/login` — email + password via `signInWithPassword`. Redirects to `?redirect=` on success (defaults to `/`).
- **Accounts are wrapt's.** Yumlog shares wrapt's Supabase project, so a yumlog login *is* a wrapt Auth user (Tim's is his wrapt login). Wrapt has **public sign-ups on**: anyone can create an account, so **"authenticated" does not mean Tim or Zoe**. What makes someone an editor is a row in `yumlog.members` (see **Row-level security**).
- **Session:** client-side only — Supabase persisted session in the browser. No SSR.
- **Guests see:** Recipes nav + Log in. Recipe pages are fully public.
- **Logged-in users see:** Recipes, Shopping, Create, Settings, Sign out; edit controls on recipe pages. The UI gates on "has a session", not membership — a signed-in non-member sees the controls, but the database refuses every write and returns an empty shopping list. The database is the security boundary; the UI isn't.
- **Protected pages:** `/shopping`, `/create`, `/settings`, `/settings/ingredients` — client-side `requireAuth()` redirects to login if no session.

### Adding Zoe

Zoe has no account in wrapt's project yet. To add her:

1. Supabase (wrapt) → **Authentication → Users → Add user → Create new user**: her email and a password, *Auto Confirm User* ticked.
2. SQL editor (wrapt):
   ```sql
   insert into yumlog.members (user_id, note)
   select id, 'Zoe' from auth.users where email = 'fisherzoe98@gmail.com'
   on conflict do nothing;
   ```
   It should report 1 row inserted.
3. She logs in at yumlog `/login`. To remove her: `delete from yumlog.members where note = 'Zoe';` (her auth user can stay).

Side effect to tell her: she'd also be able to sign in on wrapt's login page, but gets nowhere there without a Spotify-allowlisted connection.

### Astro client-script gotcha

**Never combine `define:vars` with `import` statements** in `<script>` tags — Astro inlines those as classic scripts and imports fail silently (`Cannot use import statement outside a module`). Pass data via URL params, `data-*` attributes, or a `<script type="application/json">` block instead.

---

## Database schema

All of yumlog's tables live in the **`yumlog` schema** of wrapt's Supabase project — never in `public`, which is wrapt's. The client reaches them because `src/lib/supabase.ts` is created with `db: { schema: YUMLOG_DB_SCHEMA }` (hard-coded `'yumlog'` in `src/lib/db-schema.ts`), and because `yumlog` is listed in Supabase → **Data API → Exposed schemas** (with `public` kept first, so wrapt's default is unchanged). Raw REST calls (`worker.ts`, `functions/`) send `Accept-Profile: yumlog` / `Content-Profile: yumlog` themselves.

The SQL that builds it is **`supabase/migrations/`** — numbered, idempotent, each ending in a verification query:

| File | What |
|---|---|
| `001_yumlog_schema.sql` | schema, the four tables, FK indexes, `members`, the `shopping_list.updated_at` trigger |
| `002_yumlog_security.sql` | grants, `is_member()`, RLS policies, the two RPCs |
| `003_yumlog_rebuild_webhook.sql` | the recipes → Cloudflare rebuild trigger (Vault + pg_net) |
| `004_yumlog_realtime.sql` | adds `shopping_list` to the `supabase_realtime` publication |
| `005_optional_revoke_net_http.sql` | pg_net hardening — **doesn't work on Supabase, not applied** (supabase_admin's PUBLIC grant can't be revoked by postgres; risk accepted, PLAN R19) |

Run them in order in wrapt's SQL editor. Column order and definitions match the original project exactly.

```sql
-- Canonical ingredient registry (one row per normalised name)
create table yumlog.ingredients (
  name      text primary key,     -- normalised name, e.g. 'brown onion'
  category  text                  -- shopping-list aisle; null = valid in recipes but not shopped
);

-- Recipes — keyed by a readable slug (e.g. 'garlic-butter-mushrooms')
create table yumlog.recipes (
  slug           text primary key,
  title          text not null,
  category       text,            -- slug-style, e.g. 'sweet_treat'; single value
  protein        text,            -- slug-style; may be comma-separated for multiple, e.g. 'chickpea, lentils'
  cook_time_min  integer,
  method         text not null,   -- step-by-step instructions, one step per line (see Stored text formats)
  source_url     text,
  created_at     timestamptz default now(),
  tips           text,            -- one tip per line; null when absent
  substitutions  text,            -- one substitution per line; null when absent
  updated_at     timestamptz not null default now()  -- bumped to trigger rebuilds (see Deployment)
);

-- Per-recipe ingredient lines (FK → ingredients.name)
create table yumlog.recipe_ingredients (
  id            bigint generated always as identity primary key,
  recipe_slug   text not null references yumlog.recipes(slug) on delete cascade,
  ingredient    text not null references yumlog.ingredients(name) on update cascade on delete restrict,
  display_name  text,               -- original wording, e.g. 'button mushrooms'
  quantity      numeric,
  unit          text                -- 'g','kg','ml','cup','each','pinch'...
);

-- The single shared shopping list (all members share one list)
create table yumlog.shopping_list (
  id          bigint generated always as identity primary key,
  ingredient  text not null references yumlog.ingredients(name) on update cascade on delete restrict,
  quantity    numeric,
  unit        text,                 -- canonical unit after conversion, e.g. 'g' or 'each'
  checked     boolean not null default false,
  position    integer,              -- global order; grouped display derives from category + position
  added_at    timestamptz default now(),
  updated_at  timestamptz not null default now()   -- set by a BEFORE UPDATE trigger
);

-- Who may edit: the allowlist. RLS on, no policies, no grants — only postgres
-- (the SQL editor) can read or change it.
create table yumlog.members (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  note      text,                   -- e.g. 'Tim'
  added_at  timestamptz not null default now()
);
```

`ingredients.category` is constrained in Postgres to one of eleven fixed aisle values (see **Ingredient shopping sections** below), or `null`.

Indexes on the three FK columns (`recipe_ingredients.recipe_slug`, `recipe_ingredients.ingredient`, `shopping_list.ingredient`) back the cascades and per-recipe reads.

**Functions** (all `set search_path = ''`, every name schema-qualified):

- `yumlog.is_member()` — `true` if `auth.uid()` is in `members`. SECURITY DEFINER (so it can read `members`), read-only, about the caller only.
- `yumlog.touch_recipes_for_ingredient(text)` and `yumlog.merge_ingredients(text, text)` — the registry RPCs (called by name from `src/lib/ingredient-registry.ts`; `db.schema` routes them). **SECURITY INVOKER** with a member guard (`not a yumlog member`, SQLSTATE 42501). They were DEFINER in the old project; members already pass RLS on everything they touch, so definer rights bought nothing but risk.
- `yumlog.shopping_list_set_updated_at()` and `yumlog.request_site_rebuild()` — trigger-only; nobody has EXECUTE.

### Row-level security

The model: **anon reads public data; members do everything; nobody else gets anything.** Grants are explicit (the `yumlog` schema has no default ACLs, so nothing is granted by accident) and RLS decides rows.

| Object | anon | authenticated | service_role |
|---|---|---|---|
| schema `yumlog` | USAGE | USAGE | **none** |
| `recipes`, `ingredients`, `recipe_ingredients` | SELECT | SELECT, INSERT, UPDATE, DELETE | none |
| `shopping_list` | none | SELECT, INSERT, UPDATE, DELETE | none |
| `members` | none | none | none |
| `is_member()`, the two RPCs | none | EXECUTE | none |

- **Policies** — `recipes`, `ingredients`, `recipe_ingredients`: one public SELECT policy (`anon, authenticated`, `using (true)`) plus per-command INSERT/UPDATE/DELETE policies for `authenticated` gated on `(select yumlog.is_member())`. `shopping_list`: one `FOR ALL` policy, members only. `members`: RLS on, no policies.
- **Authenticated ≠ Tim/Zoe.** Wrapt has public sign-ups, so every write policy and both RPCs check the allowlist. A signed-up stranger can read the public tables, sees **0** shopping-list rows, and gets RLS errors on writes and "not a yumlog member" from the RPCs.
- **service_role has no grants — not even schema USAGE.** Wrapt's `/ask` feature runs model-generated SQL as service_role; BYPASSRLS skips policies, not privileges, so it gets *permission denied for schema yumlog*. Don't "fix" that by following Supabase's docs recipe of granting service_role — it's deliberate.
- **Anon can run SQL through wrapt's `public.run_ask_sql`** (EXECUTE is granted to PUBLIC on the wrapt side — a pre-existing wrapt issue). It's read-only, but it can read anything anon can, including the catalogues: `pg_get_functiondef`, `pg_get_triggerdef`. So **no secrets in any function or trigger source** — hence the Vault-based webhook (see **Deployment**).
- Proven by `migration/stage3/rls_tests.sql` (anon, a fabricated stranger, service_role, Tim), which rolls itself back.

### Key design decisions

- Primary keys are **slugs**, not UUIDs. Slugs are generated from the title on **create** (`titleToSlug()` in `src/lib/slug.ts` — hyphen-separated, e.g. `mixed-berry-muffins`) and **never change on edit**, even if the title is updated.
- **Canonical ingredients** live in `ingredients` (one row per normalised name). `recipe_ingredients.ingredient` and `shopping_list.ingredient` are FKs to `ingredients.name` (`on update cascade`, `on delete restrict` — cannot delete a canonical name still referenced by a recipe or shopping row).
- **`ingredients` has no unit column** — units live on `recipe_ingredients` and `shopping_list`; conversion happens in app code at shopping-list roll-up time (`src/lib/units.ts`), not on the registry row.
- On recipe save or manual shopping-list add, **upsert** new names into `ingredients` before inserting child rows. Brand-new names require a shopping **category** (modal prompt); existing names keep their stored category silently.
- **Editing rights come from `yumlog.members`**, not from Supabase Auth settings — wrapt's project has public sign-ups on (see **Authentication**).
- **The schema name is hard-coded** (`src/lib/db-schema.ts`), not an env var: it's part of the data model, and another build-vs-runtime variable is exactly the mismatch **Environment variables** warns about. `scripts/*.mjs` repeat the value (Node can't import the `.ts` file).

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
- **Rename** — single `UPDATE ingredients SET name = …`; FK `on update cascade` repoints `recipe_ingredients` and `shopping_list`. Confirm shows affected recipe count. Calls `touch_recipes_for_ingredient()` RPC so the `recipes` rebuild trigger fires.
- **Merge** (rename collides with existing name) — `merge_ingredients()` RPC: reassigns all references to survivor, merges shopping rows by unit, deletes duplicate; confirm required.
- **Delete** — only when zero recipe lines **and** zero shopping rows; DB `on delete restrict` as backstop.
- **Category-only edit** — no site rebuild (shopping list reads category client-side; static recipe pages use `display_name`).

Logic: `ingredient-registry.ts` + `ingredient-registry-ui.ts`. SQL: the RPCs in `supabase/migrations/002_yumlog_security.sql` (members only).

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

> **Realtime is on** for `yumlog.shopping_list` (`supabase/migrations/004_yumlog_realtime.sql` adds it to the `supabase_realtime` publication; it was never enabled in the old project, so live sync is new). Realtime checks RLS per subscriber, so only members receive row events.

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

- Centred `shadow-card` (max ~400 px): 48 px clay medallion, "Welcome back", italic subtitle, inset `bg-surface` fields, inset-shadow primary button, muted footnote saying sign-ups are disabled (true of yumlog — it has no sign-up page — though wrapt's Auth itself allows them; see **Authentication**).

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

Yumlog has **no Supabase project of its own**. It lives in **wrapt's** project (Tim's Spotify-stats app), in the `yumlog` schema — see **Database schema**.

- **URL:** `https://wncacqqtrixnqlykchyy.supabase.co` — wrapt's project (ref `wncacqqtrixnqlykchyy`).
- **Anon key format:** wrapt's legacy JWT anon key (the long `eyJ…` key), not the newer `sb_publishable_` format — both work but JWT is used here for compatibility.
- The anon key is safe to expose publicly and is stored in `.env` as `PUBLIC_SUPABASE_ANON_KEY`.
- The **service-role key** is never committed, and yumlog never uses it.
- **Wrapt-side settings yumlog depends on:** `yumlog` in **Data API → Exposed schemas** (after `public`); the **pg_net** extension (rebuild webhook); the Vault secret `yumlog_deploy_hook`; `yumlog.shopping_list` in the `supabase_realtime` publication (004).
- **Shared fate.** Wrapt's database is on the Free plan's 500 MB cap and wrapt's `plays` table grows every sync. If the cap is hit the whole database goes read-only — yumlog edits and the shopping list break too (recipe pages don't: they're static). Yumlog itself adds well under 2 MB. Check **Usage** now and then.
- **Don't** point anything in wrapt (e.g. its `/ask` SQL) at the `yumlog` schema, and don't grant `service_role` on it.

### Migration history

Until the 2026-09/10 migration, yumlog had its own Supabase project (ref `nrmimftrjulvsgonrlzg`, tables in `public`, a Database Webhook with the deploy-hook URL in the trigger). The move is planned in `migration/stage2/PLAN.md`; the working SQL is in `migration/stage3/` (its README gives the run order). After cutover the old project stays **frozen** (read-only, `migration/stage3/freeze_old.sql`) for a 2-day soak, then is **paused** — restorable for 90 days, then gone. *Update this note with the actual cutover and pause dates.*

## Environment variables

```
PUBLIC_SUPABASE_URL=https://wncacqqtrixnqlykchyy.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<wrapt's JWT anon key — see .env, never commit>
```

Set the same variables in the Cloudflare project → **Settings** → **Variables and Secrets** (Production, and Preview if needed). Also set `NODE_VERSION=22` (required by `package.json` engines).

> **Build variables ≠ runtime variables.** Workers Builds keeps these separate. `NODE_VERSION` and the Supabase vars used by `astro build` are **build** variables; but `worker.ts` and `functions/api/*` read `env.PUBLIC_SUPABASE_URL` / `env.PUBLIC_SUPABASE_ANON_KEY` at **runtime**, so both Supabase vars must also exist as runtime **Variables and Secrets**. Set only on the build side, the static site builds perfectly and the Worker's server-side code fails at runtime — `/api/import-recipe` returns 500 and the keep-alive cron dies silently. Verify with `GET /api/keepalive` (see **Supabase keep-alive** below).

> **Keep the runtime vars' type as it is.** `wrangler.jsonc` declares no `vars` and no `keep_vars` at the top level. `wrangler deploy` replaces dashboard **Text** variables with the config's `vars` unless `keep_vars` is set, but never touches **Secrets** — so if the vars ever vanish after a deploy (`/api/keepalive` → 503 "Missing Supabase runtime env vars"), re-add them as type **Secret**.

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

How it works (`supabase/migrations/003_yumlog_rebuild_webhook.sql`):

- A **statement-level** trigger `yumlog_rebuild_site` (AFTER INSERT/UPDATE/DELETE on `yumlog.recipes`) calls `yumlog.request_site_rebuild()`, which POSTs to the Cloudflare deploy hook with **pg_net**. Statement-level: a merge that touches 10 recipes sends one POST, not 10.
- The hook URL is a **Vault secret** named `yumlog_deploy_hook` (wrapt dashboard → **Integrations → Vault**). It never appears in SQL — function and trigger source is readable through wrapt's `run_ask_sql` (see **Row-level security**), and the SQL editor keeps history. Create and edit it in the Vault UI only.
- **A rebuild problem never breaks a save.** No pg_net, no Vault secret, or a non-member API caller → the function does nothing; any other failure is a `WARNING` and the recipe write still commits. So "webhook off" (data loads, preview set-up, rollback) is simply "no secret".
- **Only members trigger rebuilds.** A statement trigger fires even when RLS filters an UPDATE down to 0 rows, so the function checks `is_member()` for API callers. SQL-editor / dashboard edits (no JWT claims) always rebuild.
- pg_net sends **after commit**: a rolled-back transaction (dry run, RLS tests) sends nothing. Responses sit in `net._http_response` for ~6 h if you need to debug one.

**Cloudflare deploy hook** — Worker → **Settings** → **Build** → **Deploy hooks** (Cloudflare moves this around; look under Build/Deployments settings). Create a hook on the production branch (`main`), copy the URL into the Vault secret. Treat it like a password. To rotate: create a new hook, edit the Vault secret, delete the old hook.

Hook `recipes` only — not `recipe_ingredients`, `ingredients`, or `shopping_list`. Every recipe save touches `recipes` first; ingredients are written milliseconds later, well before the queued build fetches data. Shopping list is client-side only and does not need rebuilds.

**Ingredient registry rebuilds** — category-only edits do **not** trigger a rebuild. **Rename** and **merge** call `yumlog.touch_recipes_for_ingredient()` to bump `recipes.updated_at` on affected slugs, firing the same trigger (once per call).

Test by saving a recipe and watching **Deployments** (Cloudflare); `select * from net._http_response order by created desc limit 5;` in wrapt's SQL editor shows what Cloudflare answered.

Git pushes to `main` also trigger builds; the trigger covers DB-only changes from the create/edit form.

### Preview Worker (migration only)

While migrating, a second Worker **`yumlog-preview`** builds the `migrate/supabase-to-wrapt` branch with `npx wrangler deploy --env preview` (the `env.preview` block in `wrangler.jsonc`: re-declared `ai` + `assets`, no cron). It has its own build variables and its own deploy hook; during testing the Vault secret points at **that** hook, so preview edits rebuild the preview, never production. Its runtime `PUBLIC_SUPABASE_*` vars are set in its dashboard as **Secrets** (not in `wrangler.jsonc`). Delete the Worker, its hook and the `env.preview` block after cutover (PLAN step 6.3).

### Supabase keep-alive (free-tier auto-pause)

Supabase pauses Free-plan projects that don't get **"a few user requests to the database each day over the previous week."** Wrapt's project is kept busy by wrapt's own 2-hourly sync, so pausing is now unlikely — but a paused project would still **not** take the public site down (recipe pages are static), while login, `/shopping`, `/create` and `/settings` would all break. The keep-alive stays as belt-and-braces and, more usefully, as the **health check for yumlog's grants and Data API exposure**.

- **Cron:** `wrangler.jsonc` → `triggers.crons` = `0 */6 * * *` (four times a day). The handler is `scheduled()` in `worker.ts`, which reads one row from `yumlog.recipes` and one from `yumlog.ingredients` via the REST API (`Accept-Profile: yumlog`).
- **Failures throw, they don't log.** A thrown error marks the invocation failed in Workers **Observability**; a `console.error` just scrolls past. The original daily ping (added 2026-07-12) failed unnoticed until a pause warning arrived **2026-09-09**.
- **`GET /api/keepalive`** — public, uncached, runs the identical code path. `200 {"ok":true,…}` means the keep-alive works end to end; `503` reports which check failed (a 404/406 there usually means `yumlog` isn't in the exposed schemas). Use it instead of hunting through Cloudflare logs.
- **External monitor.** Point a free scheduler (cron-job.org, UptimeRobot) at `https://<site>/api/keepalive` every 15 min. This is the important half: it's independent of whether the Worker's cron fires, and it **emails on failure** — the gap that let the July breakage run for eight weeks. Nothing secret is exposed; the endpoint returns no keys.
- **If a pause warning arrives anyway:** activity generated during the warning window prevents the pause. Hitting `/api/keepalive` a few times is enough.

### Data backups

The keep-alive lowers the odds of a pause; it doesn't insure against one, and per the pause email a project left paused for 90 days can no longer be unpaused.

```bash
node --env-file=.env scripts/export-data.mjs
```

Dumps `yumlog.recipes`, `yumlog.ingredients` and `yumlog.recipe_ingredients` to JSON in [`backups/`](backups/), committed to the repo. Stable filenames and deterministic row order mean a re-run produces a clean diff — **git history is the backup history**. Re-run and commit after any batch of recipe work.

- `shopping_list` is **excluded** — anon has no grant on it (members only), the script deliberately uses only the anon key, and the list is transient enough that nothing is lost.
- `members` is **excluded** — it holds auth user ids, which only mean something in wrapt's project. Re-add members by email after a restore (see **Adding Zoe**).
- Nothing secret is committed; all three exported tables are public-SELECT.
- Restore order matters (`ingredients` → `recipes` → `recipe_ingredients`) — procedure in [`backups/README.md`](backups/README.md).

---

## Recipe import (server-side)

**`functions/api/import-recipe.ts`** is the only server-side code in the project that does real work. (The other two server-side paths both live in `worker.ts` and exist to keep Supabase awake and to health-check it: the `scheduled()` cron and `GET /api/keepalive` — see **Supabase keep-alive** above.) Everything else in this app is either static (recipe pages, built at deploy time) or client-side (auth, writes, shopping list — see **Critical rendering rule** above). This endpoint does not change that: it's called on demand from the create form to pre-fill fields from a pasted URL, never from a recipe read path. Recipe pages remain pre-rendered static HTML with no DB access at request time.

It's a handler (`POST /api/import-recipe`) written in Pages-Function style (`onRequest({ request, env })`) but manually dispatched from `worker.ts` — see **Deployment (Cloudflare Workers, Git-connected)** above for why that dispatch step exists.

### Auth

Reuses the existing Supabase session — the client (`initImportPanel` in `src/lib/recipe-form-ui.ts`) sends `Authorization: Bearer <access_token>` from the current session. The Function checks two things:

1. The token is a valid session — `${PUBLIC_SUPABASE_URL}/auth/v1/user` with the anon key; non-200 → **401**.
2. The user is a **yumlog member** — `POST ${PUBLIC_SUPABASE_URL}/rest/v1/rpc/is_member` with the user's token, `Content-Profile: yumlog` and body `{}`; anything but `true` (including an error) → **403**. Fails closed.

The second check is new with the move to wrapt's project: wrapt has public sign-ups, so a valid session alone would let any stranger spend Workers AI (and outbound fetches) through this endpoint. Same allowlist as every write path.

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

Errors are `{ "error": "message" }` with status `400` (bad body / invalid or disallowed URL), `401` (unauthorized), `403` (signed in but not a yumlog member), `405` (non-POST), `422` (couldn't fetch the page), `500` (server misconfigured — missing Supabase env), or `502` (LLM couldn't produce valid JSON after retry). Keep this shape stable — `recipe-form-ui.ts` depends on it directly.

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
  wrangler.jsonc         ← Worker config: main (worker.ts), assets binding, AI binding, cron; env.preview (migration-only yumlog-preview Worker)
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
/backups/                ← committed JSON export of recipe data (see backups/README.md)
/supabase/
  /migrations/           ← 001–005: the yumlog schema, security, rebuild webhook, realtime (see Database schema)
/migration/              ← the 2026 move into wrapt's project: stage1 recon, stage2 PLAN.md, stage3 working SQL + loadgen.py
/scripts/
  check-supabase-schema.mjs    ← anon-key health check: public tables readable, shopping_list + RPCs locked down
  export-data.mjs              ← dump recipes/ingredients/recipe_ingredients to backups/
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
    supabase.ts          ← Supabase client singleton, db.schema = yumlog (always import from here)
    db-schema.ts         ← YUMLOG_DB_SCHEMA = 'yumlog' (also used by worker.ts / functions/)
    build-guard.ts       ← failBuild(): stop the build on an errored/empty recipe query
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
- **Supabase client:** always import from `src/lib/supabase.ts`; never instantiate `createClient` elsewhere (the scripts in `scripts/` are the exception — they run under Node). It targets the `yumlog` schema; raw REST calls must send `Accept-Profile: yumlog` (reads) or `Content-Profile: yumlog` (writes/RPC) themselves.
- **Format helpers:** always import `toDisplayLabel` and `splitValues` from `src/lib/format.ts` before rendering any category or protein value.
- **Featured recipes:** edit `FEATURED_SLUGS` in `index.astro`. Use **hyphen slugs** as stored in the DB (e.g. `sourdough-bread`, not `sourdough_bread`). Order in the array controls display order.
- **Auth UI toggling:** elements with `data-auth-only` / `data-nav-guest` are shown/hidden by `initAuthUI()` in `Layout.astro`.
- **Dev server:** `npm run dev` → [http://localhost:4321](http://localhost:4321)
- **Production preview:** `npm run build` then `npm run preview` (requires `.env` with Supabase keys at build time — and the build guard fails the build if they can't read recipes).
