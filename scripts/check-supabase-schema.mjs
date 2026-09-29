// Quick check that the Supabase project the .env points at serves yumlog's
// schema the way the app expects, using only the public anon key.
//
// Run:  node --env-file=.env scripts/check-supabase-schema.mjs
//
// Yumlog's tables live in the `yumlog` schema of wrapt's Supabase project, and
// anon is deliberately limited (see CLAUDE.md "Database schema"):
// it can read recipes/ingredients/recipe_ingredients, but gets "permission
// denied" on shopping_list and on the RPCs. For those, a permission error is
// the expected, healthy answer — it proves the object exists and is locked down.
import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

// Same value as src/lib/db-schema.ts (Node can't import the .ts file) — keep in step.
const YUMLOG_DB_SCHEMA = 'yumlog';

const supabase = createClient(url, key, { db: { schema: YUMLOG_DB_SCHEMA } });

const PERMISSION_DENIED = /permission denied|42501/i;
const NOT_FOUND = /Could not find|schema cache|does not exist|Invalid schema/i;

// Anon should be able to read this column.
async function checkReadable(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (error) return { ok: false, detail: error.message };
  return { ok: true, detail: 'readable by anon' };
}

// Anon should be refused — and refused for permissions, not because it's missing.
async function checkDeniedToAnon(table, column) {
  const { error } = await supabase.from(table).select(column).limit(1);
  if (!error) return { ok: false, detail: 'anon CAN read it — grants are too open (see 002_yumlog_security.sql)' };
  if (PERMISSION_DENIED.test(error.message)) return { ok: true, detail: 'exists; anon correctly denied' };
  return { ok: false, detail: error.message };
}

async function checkRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (!error) return { ok: false, detail: `anon could execute it (returned ${JSON.stringify(data)}) — EXECUTE grant too open` };
  const msg = error.message || String(error);
  if (NOT_FOUND.test(msg)) return { ok: false, detail: msg };
  if (PERMISSION_DENIED.test(msg)) return { ok: true, detail: 'exists; anon correctly denied (members only)' };
  return { ok: false, detail: msg };
}

const checks = [
  ['recipes.updated_at', () => checkReadable('recipes', 'updated_at')],
  ['ingredients.category', () => checkReadable('ingredients', 'category')],
  ['recipe_ingredients.display_name', () => checkReadable('recipe_ingredients', 'display_name')],
  ['shopping_list.updated_at', () => checkDeniedToAnon('shopping_list', 'updated_at')],
  ['is_member()', () => checkRpc('is_member', {})],
  ['touch_recipes_for_ingredient()', () => checkRpc('touch_recipes_for_ingredient', { p_ingredient: '__schema_check__' })],
  ['merge_ingredients()', () => checkRpc('merge_ingredients', { p_source: '__a__', p_target: '__b__' })],
];

let allOk = true;
for (const [name, fn] of checks) {
  const result = await fn();
  console.log(`${result.ok ? 'OK' : 'PROBLEM'}  ${name}: ${result.detail}`);
  if (!result.ok) allOk = false;
}

process.exit(allOk ? 0 : 1);
