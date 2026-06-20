import { supabase } from './supabase';

/** Most recent shopping_list.updated_at, or null when the list is empty. */
export async function fetchShoppingListLastChanged(): Promise<string | null> {
  const { data, error } = await supabase
    .from('shopping_list')
    .select('updated_at')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.updated_at ?? null;
}

const SETTINGS_DATETIME_LOCALE = 'en-AU';

export function formatSettingsTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(SETTINGS_DATETIME_LOCALE, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
