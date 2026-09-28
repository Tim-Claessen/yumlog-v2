# Data backups

A plain-JSON export of the recipe data in Supabase (the `yumlog` schema in wrapt's
project), committed to the repo so the content survives independently of the
Supabase project.

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

**`shopping_list` is deliberately excluded.** It's members-only (anon has no grant
on `yumlog.shopping_list`), the export script deliberately uses only the anon key,
and it's transient by nature — a week-old shopping list has no value. Nothing is
lost by omitting it.

**`members` is excluded too.** It holds auth user ids, which only mean something
inside the Supabase project they came from. After a restore, re-add members by
email (CLAUDE.md → *Adding Zoe* shows the insert).

Nothing here is secret; `recipes`, `ingredients` and `recipe_ingredients` are all
public-SELECT, so this is the same data any visitor can already read.

> The files up to the 2026 migration were exported from yumlog's old, standalone
> Supabase project (`public` schema). The rows are identical in shape to
> `yumlog.*`, so they restore the same way.

## Restoring

Into wrapt's project (or any Supabase project), in the SQL editor:

1. **Build the schema first:** run `supabase/migrations/001` → `004` in order.
   Leave the Vault secret `yumlog_deploy_hook` unset until the data is back, so
   the restore doesn't trigger a rebuild.
2. **Load in FK order** — `ingredients`, then `recipes`, then `recipe_ingredients`
   (`recipe_ingredients.ingredient` → `ingredients.name`,
   `recipe_ingredients.recipe_slug` → `recipes.slug`). Paste each file's contents in
   place of `<paste JSON array here>`. Keep the ids: `recipe_ingredients.id` is an
   `always` identity column, so its insert needs `overriding system value`.

```sql
insert into yumlog.ingredients
select * from jsonb_populate_recordset(null::yumlog.ingredients, '<paste JSON array here>');

insert into yumlog.recipes
select * from jsonb_populate_recordset(null::yumlog.recipes, '<paste JSON array here>');

insert into yumlog.recipe_ingredients overriding system value
select * from jsonb_populate_recordset(null::yumlog.recipe_ingredients, '<paste JSON array here>');

-- Move the identity sequence past the restored ids, or the next insert collides.
select setval(pg_get_serial_sequence('yumlog.recipe_ingredients', 'id'),
              (select greatest(max(id), 1) from yumlog.recipe_ingredients));
```

A JSON array containing a single quote (`'`) breaks the `'…'` literal; either
double every `'` in the pasted text or use a dollar-quoted literal
(`$json$[ … ]$json$`) instead. A paste over ~50 KB (`recipe_ingredients.json`,
`recipes.json`) may be too big for the SQL editor in one go — for anything large,
`migration/stage3/loadgen.py` shows the chunked approach.

3. **Re-add members** (see above), set the Vault secret, and push a commit (or save
   any recipe) so the static pages rebuild.

> **Honest caveat:** this restore procedure is written from the schema, not
> rehearsed against a real empty project. The *data* is verified complete
> (referential integrity checked at export: no orphan ingredient lines, no unknown
> ingredient references); the exact SQL may need adjusting on the day. The
> migration's own load (`migration/stage3/`) is the rehearsed path.
