# Data backups

A plain-JSON export of the recipe data in Supabase, committed to the repo so the
content survives independently of the Supabase project.

**Why:** the Supabase project is on the Free plan, which auto-pauses after ~7 days
of low activity. The keep-alive in [`worker.ts`](../worker.ts) reduces the odds of
that (see CLAUDE.md → *Supabase keep-alive*) but doesn't insure against it — per
the pause email, a project left paused for 90 days can no longer be unpaused.
These files are the insurance.

## Refreshing

```bash
node --env-file=.env scripts/export-data.mjs
```

Filenames are stable and rows are sorted deterministically, so a re-run produces a
clean `git diff` — **git history is the backup history**. Commit the result.

Worth doing after any batch of recipe work, and otherwise every month or two.

## What's here

| File | Rows at last export | Sorted by |
|---|---|---|
| `recipes.json` | 51 | `slug` |
| `ingredients.json` | 201 | `name` |
| `recipe_ingredients.json` | 483 | `recipe_slug`, `id` |
| `manifest.json` | — | export timestamp, source project, row counts |

Every column of each table is exported verbatim, including `created_at` /
`updated_at`.

**`shopping_list` is deliberately excluded.** It's authenticated-only, so the anon
key used by the export script cannot read it, and it's transient by nature — a
week-old shopping list has no value. Nothing is lost by omitting it.

Nothing here is secret; `recipes`, `ingredients` and `recipe_ingredients` are all
public-SELECT, so this is the same data any visitor can already read.

## Restoring

Restore order matters — the foreign keys require it:

1. **`ingredients`** first (`recipe_ingredients.ingredient` → `ingredients.name`)
2. **`recipes`** next (`recipe_ingredients.recipe_slug` → `recipes.slug`)
3. **`recipe_ingredients`** last

Per table, in the Supabase SQL editor — paste the file's contents in place of
`<paste JSON array here>`:

```sql
insert into ingredients
select * from json_populate_recordset(null::ingredients, '<paste JSON array here>');
```

For `recipe_ingredients`, **drop the `id` column** and let the identity sequence
regenerate it. The ids carry no meaning and nothing references them:

```sql
insert into recipe_ingredients (recipe_slug, ingredient, display_name, quantity, unit)
select recipe_slug, ingredient, display_name, quantity, unit
from json_populate_recordset(null::recipe_ingredients, '<paste JSON array here>');
```

After restoring, run `scripts/ingredient-registry-rpc.sql` to recreate the RPCs,
re-check RLS policies (CLAUDE.md → *Row-level security*), and redeploy so the
static recipe pages rebuild.

> **Honest caveat:** this restore procedure is written from the schema, not
> rehearsed against a real empty project. The *data* is verified complete
> (referential integrity checked at export: no orphan ingredient lines, no unknown
> ingredient references); the exact SQL may need adjusting on the day.
