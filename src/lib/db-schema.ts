// The Postgres schema yumlog's tables live in. Yumlog shares wrapt's Supabase
// project, and its tables sit in their own `yumlog` schema (not `public`) —
// see CLAUDE.md "Database schema".
//
// Hard-coded rather than an env var on purpose: the schema is part of the data
// model, not deployment config, and another build-vs-runtime variable is
// exactly the mismatch CLAUDE.md warns about. Imported by the browser/build
// client (supabase.ts), the Worker (worker.ts, functions/). The Node scripts in
// scripts/ can't import TypeScript, so they repeat the value — keep them in step.
export const YUMLOG_DB_SCHEMA = 'yumlog';
