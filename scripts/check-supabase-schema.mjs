import { createClient } from '@supabase/supabase-js';

const url = process.env.PUBLIC_SUPABASE_URL;
const key = process.env.PUBLIC_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(url, key);

async function checkColumn(table, column) {
  const { data, error } = await supabase.from(table).select(column).limit(1);
  if (error) return { ok: false, detail: error.message };
  return { ok: true, detail: 'present' };
}

async function checkRpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (!error) return { ok: true, detail: `present (returned ${JSON.stringify(data)})` };
  const msg = error.message || String(error);
  if (/Could not find the function|schema cache/i.test(msg)) return { ok: false, detail: msg };
  if (/permission denied|JWT|not authorized|42501|Source ingredient not found/i.test(msg)) {
    return { ok: true, detail: 'present (execution blocked as expected without auth/bad args)' };
  }
  return { ok: false, detail: msg };
}

const checks = [
  ['shopping_list.updated_at', () => checkColumn('shopping_list', 'updated_at')],
  ['recipes.updated_at', () => checkColumn('recipes', 'updated_at')],
  ['touch_recipes_for_ingredient()', () => checkRpc('touch_recipes_for_ingredient', { p_ingredient: '__schema_check__' })],
  ['merge_ingredients()', () => checkRpc('merge_ingredients', { p_source: '__a__', p_target: '__b__' })],
];

let allOk = true;
for (const [name, fn] of checks) {
  const result = await fn();
  console.log(`${result.ok ? 'OK' : 'MISSING'}  ${name}: ${result.detail}`);
  if (!result.ok) allOk = false;
}

process.exit(allOk ? 0 : 1);
