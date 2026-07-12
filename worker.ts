// Worker entrypoint (wrangler.jsonc "main").
//
// This project is deployed via Cloudflare's Workers-Builds Git integration,
// not the classic Pages product — so the functions/ directory does NOT
// auto-route on its own (that's a Pages-only convention). This entrypoint
// manually dispatches known API routes to their handlers and falls back to
// serving the static build (env.ASSETS) for everything else, which keeps
// recipe pages exactly as static/pre-rendered as before (see CLAUDE.md
// "Critical rendering rule").
import { onRequest as handleImportRecipe } from "./functions/api/import-recipe";
import type { AiBinding } from "./functions/lib/recipe-normaliser";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  PUBLIC_SUPABASE_URL: string;
  PUBLIC_SUPABASE_ANON_KEY: string;
  AI: AiBinding;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/import-recipe") {
      return handleImportRecipe({ request, env });
    }

    return env.ASSETS.fetch(request);
  },

  // Keep-alive: a lightweight REST read counts as Supabase API activity,
  // preventing the free-tier project from being auto-paused for inactivity.
  // Schedule lives in wrangler.jsonc ("triggers").
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const res = await fetch(
      `${env.PUBLIC_SUPABASE_URL}/rest/v1/recipes?select=slug&limit=1`,
      {
        headers: {
          apikey: env.PUBLIC_SUPABASE_ANON_KEY,
          Authorization: `Bearer ${env.PUBLIC_SUPABASE_ANON_KEY}`,
        },
      },
    );
    if (!res.ok) {
      console.error(`Supabase keep-alive ping failed: ${res.status}`);
    }
  },
};
