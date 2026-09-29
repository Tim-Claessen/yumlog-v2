# Stage 1 — read-only recon for moving yumlog's database into the wrapt Supabase project

Nothing in this folder changes anything. Each `.sql` file is one read-only `SELECT`
that returns one result grid with columns `section | name | detail`.

## What to run, where, in order

| # | File | Run in project | Before running |
|---|------|----------------|----------------|
| 1 | `01_yumlog_schema.sql` | **yumlog** (`nrmimftrjulvsgonrlzg`) | nothing |
| 2 | `02_yumlog_data_facts.sql` | **yumlog** | nothing |
| 3 | `03_wrapt_facts.sql` | **wrapt** | edit the `params` CTE at the top: replace `%REPLACE_WITH_ZOE_EMAIL_OR_PATTERN%` with Zoe's email (or an ILIKE pattern). `%claessen%` is already there. |

How: Supabase Dashboard → pick the project → **SQL Editor** → **New query** → paste the
whole file → **Run**. Check the project name in the top bar before you press Run.

## What to copy back

For each file, the whole result grid. Either:

- **Export → CSV** (button above the results grid) and attach the file, or
- click in the grid, select all, copy, and paste as text.

If the grid shows "limited to N rows", use Export — it contains everything.
If a file errors, copy the error message and the line number it reports.

Privacy: no password hashes, tokens or secrets are selected. Trigger and cron text has
URL paths and `Bearer` tokens redacted (the recipes → Cloudflare deploy-hook URL is a
secret — the SQL shows only its host). The output does contain Tim's and Zoe's
email addresses and user ids.

## Dashboard checklist (settings SQL can't see)

Write down what you see; never copy secret values (keys, hook URLs, SMTP passwords).

### Both projects

- [ ] **Authentication → Sign In / Providers**: *Allow new users to sign up* (on/off);
      *Confirm email* (on/off); which providers are enabled (Email, anything else);
      anonymous sign-ins (on/off).
- [ ] **Authentication → URL Configuration**: *Site URL*; the full *Redirect URLs* list.
- [ ] **Authentication → Emails**: custom SMTP on/off (host name only); whether the
      *Confirm signup*, *Reset password*, *Magic link* and *Invite* templates are
      customised (and if they hard-code a domain).
- [ ] **Authentication → Rate limits / Attack protection**: CAPTCHA on/off, leaked-password
      protection on/off.
- [ ] **Project Settings → API** (Data API): *Exposed schemas* list, *Extra search path*,
      *Max rows*.
- [ ] **Project Settings → API Keys**: whether the project uses the legacy JWT `anon` /
      `service_role` keys, the new `sb_publishable_` / `sb_secret_` keys, or both
      (names only — no values).
- [ ] **Database → Publications** (Replication): which tables are in `supabase_realtime`.
- [ ] **Organization / Project → Usage**: database size, egress, MAU, and the plan's
      limits as shown (confirm the Free-plan database size cap).
- [ ] **Project Settings → General**: plan, region, Postgres version.

### yumlog only

- [ ] **Database → Webhooks** (Integrations → Database Webhooks): for each webhook, record
      name, table, events (INSERT/UPDATE/DELETE), type (HTTP request / Edge Function),
      method, **URL host only** (e.g. `api.cloudflare.com`), headers *names*, params,
      timeout. Expected per CLAUDE.md: table `recipes`, all three events, `POST`,
      URL = Cloudflare deploy hook.
- [ ] **Authentication → Users**: confirm only Tim + Zoe exist.

### wrapt only

- [ ] **Database → Webhooks**: list any (expected: none).
- [ ] **Integrations → Cron** (pg_cron): list any jobs (expected: none — wrapt's cron is a
      Cloudflare Worker).

### Cloudflare (yumlog Worker `yumlog`, Workers-Builds)

Names only, never values.

- [ ] **Workers & Pages → yumlog → Settings → Build → Variables and secrets** (build-time):
      list names (expected `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `NODE_VERSION`).
- [ ] **Workers & Pages → yumlog → Settings → Variables and Secrets** (runtime): list names
      (expected `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`).
- [ ] **Settings → Build → Deploy hooks**: hook name and branch (not the URL).
- [ ] Any external uptime monitor pointed at `/api/keepalive` (service + URL).
