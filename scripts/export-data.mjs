// Export the recipe data from Supabase into backups/ as JSON.
//
// Why this exists: the Supabase project is on the Free plan, which auto-pauses
// after ~7 days of low activity and, per the pause email, becomes unrecoverable
// after 90 days paused. worker.ts keeps the project awake, but that reduces the
// odds of a pause rather than insuring against one. This is the insurance.
//
// Run:  node --env-file=.env scripts/export-data.mjs
//
// Filenames are stable and rows are sorted deterministically, so re-running it
// produces a clean git diff — git history *is* the backup history. Commit the
// result; recipe data is public-SELECT anyway, so nothing secret lands in it.
//
// shopping_list is deliberately NOT exported: it's authenticated-only (the anon
// key can't read it) and it's transient by nature. Nothing is lost.

import { createClient } from '@supabase/supabase-js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY.');
  console.error('Run with: node --env-file=.env scripts/export-data.mjs');
  process.exit(1);
}

const supabase = createClient(url, key);
const OUT_DIR = join(process.cwd(), 'backups');
const PAGE_SIZE = 1000;

// [table, ...columns to sort by] — sort keys keep diffs meaningful between runs.
const TABLES = [
  { name: 'recipes', order: ['slug'] },
  { name: 'ingredients', order: ['name'] },
  { name: 'recipe_ingredients', order: ['recipe_slug', 'id'] },
];

async function fetchAll({ name, order }) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase.from(name).select('*').range(from, from + PAGE_SIZE - 1);
    for (const column of order) query = query.order(column, { ascending: true });

    const { data, error } = await query;
    if (error) throw new Error(`${name}: ${error.message}`);

    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

await mkdir(OUT_DIR, { recursive: true });

const counts = {};
for (const table of TABLES) {
  const rows = await fetchAll(table);
  counts[table.name] = rows.length;
  await writeFile(join(OUT_DIR, `${table.name}.json`), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  console.log(`${String(rows.length).padStart(5)}  ${table.name}.json`);
}

await writeFile(
  join(OUT_DIR, 'manifest.json'),
  `${JSON.stringify({ exported_at: new Date().toISOString(), source: url, row_counts: counts }, null, 2)}\n`,
  'utf8',
);
console.log(`\nWrote ${TABLES.length + 1} files to backups/`);
