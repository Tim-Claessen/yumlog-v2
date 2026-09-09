# Tim & Zoe's Yumlog

**Zoe & Tim's favourite recipes**

A personal cookbook: search and browse recipes publicly, with a shared shopping list and recipe editor for the two of us. Built with [Astro](https://astro.build/) 6, [Tailwind CSS](https://tailwindcss.com/) 4, and [Supabase](https://supabase.com/), deployed to **Cloudflare Workers** (Workers-Builds Git integration — see the callout below, this is *not* Cloudflare Pages).

The UI uses the **Hearth** design direction — editorial Newsreader serif, Hanken Grotesk UI type, and a clay / sage / paper palette. See [`docs/brand-hearth.md`](docs/brand-hearth.md) for the full brand guide.

## Live site

Hosted on **Cloudflare Workers**, connected to GitHub repo [`Tim-Claessen/yumlog-v2`](https://github.com/Tim-Claessen/yumlog-v2) via Workers-Builds (auto-deploys on push to `main`).

> **This is not Cloudflare Pages**, despite living in the same "Workers & Pages" dashboard section. That distinction matters as soon as you touch anything server-side (the recipe importer) — see [`worker.ts`](worker.ts) and the big callout in [CLAUDE.md → Deployment](CLAUDE.md#deployment-cloudflare-workers--not-classic-pages) before troubleshooting Cloudflare issues. Short version: `functions/api/import-recipe.ts` does **not** auto-route the way it would on Pages — `worker.ts` is what actually wires `/api/import-recipe` up, and there's no "Functions"/"Bindings" dashboard tab to go looking for on this project type.

## Features

- **Public recipes** — pre-rendered static pages; no login required to browse or search.
- **Auth-gated editing** — create and edit recipes, manage a shared shopping list, and maintain the ingredient registry (Tim + Zoe only; sign-ups disabled).
- **Shopping list** — aisle grouping, drag reorder, unit conversion, realtime sync between devices.
- **Ingredient registry** — canonical names, shopping sections, rename/merge/delete admin at `/settings/ingredients`.
- **Recipe import** — paste a URL on the create page to pre-fill the form from JSON-LD (or page text), via a server-side route (`functions/api/import-recipe.ts`, routed through `worker.ts`) backed by Workers AI.

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

**Cloudflare Workers (Workers-Builds Git integration) — not Cloudflare Pages.** Static output (`dist/`) is served via the `assets` binding in `wrangler.jsonc`; `worker.ts` is the `main` entrypoint and the *only* place that routes anything to server-side code. There's no Astro adapter and no SSR — see [CLAUDE.md](CLAUDE.md#deployment-cloudflare-workers--not-classic-pages) for the full explanation, common pitfalls, and how to verify bindings/routing with `wrangler` yourself instead of hunting through the dashboard.

| Setting | Value |
| -------- | ----- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Node version | `22` |
| Worker entrypoint | `worker.ts` (`main` in `wrangler.jsonc`) |

Set `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_ANON_KEY` as Cloudflare **Variables and Secrets** on the project (not "Pages environment variables" — this project has no Pages settings pages).

> **Build variables and runtime variables are separate in Workers Builds.** Both Supabase vars are needed in *both* places: `astro build` reads them at build time, and `worker.ts` / `functions/api/*` read them at runtime. Set only on the build side, the site builds perfectly while the server-side code fails at runtime — `/api/import-recipe` returns 500 and the keep-alive cron dies silently. `GET /api/keepalive` tells you which state you're in.

Recipe create/edit/delete triggers a Supabase webhook on the `recipes` table, which POSTs to a Cloudflare deploy hook so static pages rebuild automatically (~2–3 min). See [CLAUDE.md](CLAUDE.md) for webhook and ingredient-registry rebuild details.

### Keeping Supabase awake

Supabase pauses Free-plan projects that go ~7 days without regular database activity. That wouldn't take the public site down — recipe pages are pre-rendered static HTML with no request-time DB access — but login, shopping list, create and settings would all break.

`worker.ts` runs a `scheduled()` keep-alive every 6 hours (`triggers.crons` in `wrangler.jsonc`) that reads a row from `recipes` and `ingredients`. It **throws** on failure so a bad run shows up as a failed invocation in Workers Observability rather than scrolling past in the logs.

`GET /api/keepalive` runs the same code path on demand — `200` when everything works, `503` naming the failed check. Point an external monitor (cron-job.org, UptimeRobot) at it so a breakage emails you instead of going unnoticed. It exposes no keys.

**Adding a new server-side route?** Write the handler under `functions/`, then add a matching branch in `worker.ts` — it will not work otherwise. Test locally with `npx wrangler dev` (not `npm run dev`, which doesn't run the Worker at all) or verify bindings with `npx wrangler deploy --dry-run`.

## Repo layout

```
worker.ts           Worker entrypoint — routes /api/*, serves the static build, runs the keep-alive cron
wrangler.jsonc      Worker config: main, assets binding, AI binding, cron triggers
functions/          Server-side route handlers (Pages-Function style, dispatched manually by worker.ts)
src/pages/          Routes (homepage, recipes, shopping, create, settings)
src/lib/            Supabase client, auth, shopping list, ingredient logic
src/layouts/        Shared shell, fonts, wordmark, navigation
src/styles/         Tailwind + Hearth colour tokens (global.css @theme)
docs/               Brand and design reference (brand-hearth.md)
scripts/            One-off SQL, schema checks, data export
backups/            Committed JSON export of the recipe data (see backups/README.md)
public/             Static assets (favicon, etc.)
```

Detailed architecture, schema, UI patterns, and conventions live in [CLAUDE.md](CLAUDE.md) — the primary reference for development on this project. Visual design details are in [docs/brand-hearth.md](docs/brand-hearth.md).

## Database scripts

Run once in the Supabase SQL editor when setting up or upgrading:

- **`scripts/ingredient-registry-rpc.sql`** — `touch_recipes_for_ingredient()` and `merge_ingredients()` RPCs for ingredient rename/merge and rebuild triggers.

Both Node scripts read the Supabase vars from `.env`, so they need Node's `--env-file` flag:

```bash
node --env-file=.env scripts/check-supabase-schema.mjs   # verify columns + RPCs exist
node --env-file=.env scripts/export-data.mjs             # refresh backups/*.json
```

## Backups

`scripts/export-data.mjs` dumps `recipes`, `ingredients` and `recipe_ingredients` to JSON in [`backups/`](backups/), committed to the repo so the content survives independently of the Supabase project. Filenames are stable and rows are deterministically sorted, so a re-run produces a clean diff — **git history is the backup history**.

Re-run and commit after any batch of recipe work. Restore procedure in [`backups/README.md`](backups/README.md).

## Line endings

The repo uses `.gitattributes` with `* text=auto eol=lf`. After cloning on Windows, run `git add --renormalize .` if you see whole-file CRLF diffs.

## Credits

Thanks to everyone whose cooking and writing inspired these recipes. See [Credits.md](Credits.md).

## License

[MIT License](LICENSE).
