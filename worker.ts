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

// Supabase pauses Free-plan projects that don't see "a few user requests to
// the database each day over the previous week". These are the tables the
// keep-alive reads — cheap, public-SELECT, and enough to register as real
// user database activity.
const KEEP_ALIVE_PATHS = [
  "recipes?select=slug&limit=1",
  "ingredients?select=name&limit=1",
];

interface KeepAliveResult {
  ok: boolean;
  checks: Array<{ path: string; status: number | null; error?: string }>;
}

// Reads a row or two over the Supabase REST API. Deliberately returns a
// result rather than throwing, so both callers below can decide what to do
// with a failure (the cron throws to surface it; the HTTP route reports it).
async function pingSupabase(env: Env): Promise<KeepAliveResult> {
  if (!env.PUBLIC_SUPABASE_URL || !env.PUBLIC_SUPABASE_ANON_KEY) {
    // Almost always means the vars were set as Workers *build* variables but
    // not as runtime Variables and Secrets — see CLAUDE.md "Environment
    // variables". Previously this failed silently every night.
    return {
      ok: false,
      checks: [{ path: "-", status: null, error: "Missing Supabase runtime env vars" }],
    };
  }

  const headers = {
    apikey: env.PUBLIC_SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.PUBLIC_SUPABASE_ANON_KEY}`,
  };

  const checks = await Promise.all(
    KEEP_ALIVE_PATHS.map(async (path) => {
      try {
        const res = await fetch(`${env.PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers });
        return { path, status: res.status };
      } catch (err) {
        return { path, status: null, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  return { ok: checks.every((c) => c.status !== null && c.status < 400), checks };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/import-recipe") {
      return handleImportRecipe({ request, env });
    }

    // Public health check. Runs the exact same code path as the nightly cron,
    // so it doubles as (a) a way to verify the keep-alive without digging
    // through Cloudflare logs and (b) a URL an external uptime monitor can
    // hit on a schedule, independent of whether the Worker's cron fires.
    if (url.pathname === "/api/keepalive") {
      const result = await pingSupabase(env);
      return new Response(
        JSON.stringify({ ok: result.ok, checks: result.checks, at: new Date().toISOString() }, null, 2),
        {
          status: result.ok ? 200 : 503,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        },
      );
    }

    return env.ASSETS.fetch(request);
  },

  // Keep-alive: lightweight REST reads count as Supabase API activity,
  // preventing the free-tier project from being auto-paused for inactivity.
  // Schedule lives in wrangler.jsonc ("triggers").
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const result = await pingSupabase(env);
    if (!result.ok) {
      // Throw, don't console.error. A thrown error marks the cron invocation
      // as failed in Workers Observability and can raise an alert; a logged
      // one just scrolls past unnoticed, which is how this went unnoticed
      // from July to September 2026.
      throw new Error(`Supabase keep-alive ping failed: ${JSON.stringify(result.checks)}`);
    }
  },
};
