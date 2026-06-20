# Tim & Zoe's Yumlog

**Zoe & Tim's favourite recipes**

A personal cookbook: search and browse recipes publicly, with a shared shopping list and recipe editor for the two of us. Built with [Astro](https://astro.build/) 6, [Tailwind CSS](https://tailwindcss.com/) 4, and [Supabase](https://supabase.com/), deployed to [Cloudflare Pages](https://pages.cloudflare.com/).

## Live site

Hosted on Cloudflare Pages (GitHub repo [`Tim-Claessen/yumlog-v2`](https://github.com/Tim-Claessen/yumlog-v2)).

## Features

- **Public recipes** — pre-rendered static pages; no login required to browse or search.
- **Auth-gated editing** — create and edit recipes, manage a shared shopping list, and maintain the ingredient registry (Tim + Zoe only; sign-ups disabled).
- **Shopping list** — aisle grouping, drag reorder, unit conversion, realtime sync between devices.
- **Ingredient registry** — canonical names, shopping sections, rename/merge/delete admin at `/settings/ingredients`.

## Local development

**Requirements:** Node.js 22.12+ (see `package.json` engines).

```bash
npm install
```

Create a `.env` file in the repo root:

```
PUBLIC_SUPABASE_URL=https://nrmimftrjulvsgonrlzg.supabase.co
PUBLIC_SUPABASE_ANON_KEY=<your anon key>
```

Then:

```bash
npm run dev      # http://localhost:4321
npm run build    # static output → dist/
npm run preview  # serve the production build locally
```

Recipe pages are generated at build time from Supabase. After adding a recipe in the app, run a build (or wait for the Cloudflare deploy triggered by the Supabase webhook) before the new static page appears.

## Deployment

| Setting | Value |
| -------- | ----- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | `22` |

Set `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` in Cloudflare Pages environment variables.

Recipe create/edit/delete triggers a Supabase webhook on the `recipes` table, which POSTs to a Cloudflare deploy hook so static pages rebuild automatically (~2–3 min). See [CLAUDE.md](CLAUDE.md) for webhook and ingredient-registry rebuild details.

## Repo layout

```
src/pages/          Routes (homepage, recipes, shopping, create, settings)
src/lib/            Supabase client, auth, shopping list, ingredient logic
src/layouts/        Shared shell and navigation
src/styles/         Tailwind + Material Design 3 colour tokens
scripts/            One-off SQL and schema checks
public/             Static assets (favicon, etc.)
```

Detailed architecture, schema, UI patterns, and conventions live in [CLAUDE.md](CLAUDE.md) — the primary reference for development on this project.

## Database scripts

Run once in the Supabase SQL editor when setting up or upgrading:

- **`scripts/ingredient-registry-rpc.sql`** — `touch_recipes_for_ingredient()` and `merge_ingredients()` RPCs for ingredient rename/merge and rebuild triggers.

Check schema expectations locally with:

```bash
node scripts/check-supabase-schema.mjs
```

## Line endings

The repo uses `.gitattributes` with `* text=auto eol=lf`. After cloning on Windows, run `git add --renormalize .` if you see whole-file CRLF diffs.

## Credits

Thanks to everyone whose cooking and writing inspired these recipes. See [Credits.md](Credits.md).

## License

[MIT License](LICENSE).
