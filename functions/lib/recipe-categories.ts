// Fetches the distinct set of category slugs already in use on `recipes`,
// so the importer's LLM normalisation step can reuse an existing value
// instead of inventing a new one. Best-effort — on any failure, callers get
// an empty list and the model falls back to null for category.

export interface SupabaseEnv {
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
}

export async function fetchExistingCategories(env: SupabaseEnv): Promise<string[]> {
  try {
    const res = await fetch(`${env.PUBLIC_SUPABASE_URL}/rest/v1/recipes?select=category&category=not.is.null`, {
      headers: {
        apikey: env.PUBLIC_SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.PUBLIC_SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) return [];

    const rows = (await res.json()) as { category: string | null }[];
    const categories = new Set<string>();
    for (const row of rows) {
      if (row.category && row.category.trim()) categories.add(row.category.trim());
    }
    return [...categories].sort();
  } catch {
    return [];
  }
}
