# Stage 2 — Plan and risk register: yumlog → wrapt's Supabase project

Written 2026-09-28. Inputs: yumlog `CLAUDE.md`, `README.md`, `docs/archive/2026-09-supabase-to-wrapt/stage1/*`, wrapt `CLAUDE.md` +
`supabase/migrations/*` (read-only), the Stage 1 live SQL facts, and vendor docs (cited inline).

Markers: **[V]** verified (live SQL output, repo file, or vendor doc quoted). **[A]** assumption — the
step that proves or disproves it is named. **[T]** needs Tim's explicit choice.

---

## 1. Summary

- Move yumlog's four tables into a **new `yumlog` schema** in wrapt's project, exposed through the Data
  API, with **explicit grants only** (no `service_role`, no anon DML). Wrapt's `public` schema and code
  are untouched.
- Wrapt has public sign-ups **on**, so "authenticated" no longer means "Tim or Zoe". Every write and
  every shopping-list read is gated by a **`yumlog.members` allowlist** via `yumlog.is_member()`.
- Merge/touch RPCs become **SECURITY INVOKER** + a member guard (pushback on D3: they no longer need
  definer rights once members pass RLS).
- Rebuild webhook = **pg_net + Vault + a statement-level trigger**; the hook URL never appears in
  trigger or function source. During preview testing the Vault secret points at the **preview Worker's**
  own deploy hook, so preview edits rebuild preview, never prod.
- Preview = a **separate Worker `yumlog-preview`** (a Wrangler `env.preview`) tracking the migration
  branch with its own build variables. Worker Previews on the existing Worker can't give preview-only
  *build* variables from the dashboard.
- Data copy: a read-only export SQL → CSV → Claude generates an idempotent **truncate-and-reload** SQL,
  verified by counts + md5 checksums. Rehearse on real data, then repeat at cutover. **Hard freeze** on
  the old project during cutover (reversible revoke). Estimated freeze: **45–75 min**. Recipe pages stay
  readable throughout.
- A **build guard** fails the Cloudflare build on an empty or errored recipe query. A failed build
  never runs the deploy step, so the last good site stays live.
- `/api/import-recipe` gains a **member check**. Without it, any wrapt sign-up could spend Workers AI
  through it. This is a new exposure the migration creates.

---

## 2. Decisions

| # | Decision | Recommendation | Why | Rejected alternatives |
|---|---|---|---|---|
| 1 | Where the tables live | `yumlog` schema, added to *Exposed schemas* | Clean separation from wrapt's `public`. A new schema gets **no default ACL** in wrapt [V Stage 1], so nothing is granted by accident. Easy to drop or rename as a unit. | `public` with a `yumlog_` prefix: inherits wrapt's default ACLs, which grant anon/authenticated/service_role everything on new tables [V], and so opens `/ask`. |
| 2 | Who may write | `yumlog.members` allowlist + `yumlog.is_member()` (SECURITY DEFINER, `search_path=''`) | Sign-ups are on in wrapt [V] and stay on (Tim's decision). `auth.role()='authenticated'` would let any stranger write. | Turning sign-ups off: Tim ruled that out. An email check in policies: brittle, and emails can change. A custom JWT claim: needs an auth hook, which is too heavy. |
| 3 | Policy shape | **Per-command** policies on the three public tables (SELECT to anon+authenticated `using(true)`; INSERT/UPDATE/DELETE to authenticated with `(select yumlog.is_member())`). **One `FOR ALL`** policy on `shopping_list`. | A `FOR ALL` write policy overlaps the public SELECT policy. That gives two permissive SELECT policies, flagged by Supabase's *multiple_permissive_policies* advisor, and makes the intent harder to read. `shopping_list` has one audience, so one policy is clearest. | `FOR ALL` everywhere: overlapping SELECT. Restrictive policies: harder to reason about. |
| 4 | RPC security (`merge_ingredients`, `touch_recipes_for_ingredient`) | **SECURITY INVOKER**, `search_path=''`, fully qualified, `if not yumlog.is_member() then raise`. EXECUTE revoked from `public, anon`, granted to `authenticated`. **Disagrees with master's D3 (definer).** | A member already passes RLS for every table these touch. FK cascades bypass RLS regardless [A: standard PG; proven by the rename test in 4.7]. Invoker removes the whole "definer abuse" class. The guard gives a clear error instead of silent 0-row updates. | Keep definer + guard: works, but leaves privilege escalation one bug away. |
| 5 | Rebuild webhook | **(a) pg_net + Vault + statement-level trigger**, SECURITY DEFINER trigger fn reading `vault.decrypted_secrets`. **No-op if the secret is missing.** | Keeps "DB change ⇒ rebuild" for every path (form, RPC, dashboard edits). URL isn't in `pg_get_triggerdef`/`pg_get_functiondef` (both anon-readable via `run_ask_sql` [V Stage 1]). Statement-level: a merge touching 10 recipes = 1 POST, not 10. | (b) `/api/rebuild` Worker endpoint: rebuild depends on the browser finishing a second call, misses dashboard edits, and touches 3 save flows. (c) Dashboard Database Webhooks: URL is a literal trigger argument, anon-readable, so it leaks. Reject. |
| 6 | Realtime for `shopping_list` | **Add** `yumlog.shopping_list` to `supabase_realtime` (optional, recommended) **[T]** | Live sync has never worked (not in the publication [V]). Custom schemas work if the role has SELECT; RLS is checked per subscriber [V docs]. Behaviour change, not parity. | Leave out: keeps a dead code path. |
| 7 | `/ask` (service_role) exposure | **No grants to service_role** on anything in `yumlog` | BYPASSRLS skips policies, not privileges. Without `USAGE` on the schema, service_role gets *permission denied for schema yumlog*. Test 4.7 proves it. | Supabase's documented recipe grants service_role [V docs]. Deliberately not followed. |
| 8 | Zoe | No account (Tim's decision). Procedure to add her later is in §3.6. | — | — |
| 9 | Preview approach | **Separate Worker `yumlog-preview`**, created in the dashboard from the same repo; production branch = `migrate/supabase-to-wrapt`; deploy command `npx wrangler deploy --env preview`; own build vars; runtime vars in `env.preview.vars` (both values are public) **[T]** | Worker Previews: runtime vars come from a `previews` block [V docs], but **build** vars per trigger are documented only via the Builds API [V docs], which needs curl + an API token. `astro build` inlines `PUBLIC_SUPABASE_*` at build time, so preview-only build vars are essential. Also: an existing Worker's non-prod builds may be `versions upload`, which shares prod runtime vars [V docs]. | Worker Previews + Builds API: CLI steps Tim wants to avoid. `--name yumlog-preview` override: the Builds name check may reject it (open question Q2). |
| 10 | Freeze strength | **Hard freeze** on the old project: revoke INSERT/UPDATE/DELETE on all four tables from anon + authenticated, **and** EXECUTE on both RPCs from authenticated (they are definer there, so they would bypass the table revoke) **[T]** | One paste, fully reversible. Turns "no lost writes" into a guarantee. Also protects against a stale open tab writing to the old DB after cutover. | Soft freeze (tell Zoe): cheap but unverifiable. |
| 11 | Build guard | Throw in frontmatter if the recipes query errors or returns 0 rows (index + `getStaticPaths`), and if any per-recipe query errors. Sourdough keeps its fallback. | Today every build-time read swallows errors (`index.astro:8-19`, `[slug].astro:7-9,13-20`). A wrong env var deploys an empty site silently. Workers Builds runs the deploy command only after the build command succeeds [V docs: "runs the build command, followed by the deploy command"], so a throw leaves the last good version live. Proven on the preview in 4.10. | Min-count threshold (e.g. ≥40): too clever. Zero or error is the real failure mode. |
| 12 | Data-copy method | Export SQL in the old project → CSV (one row per table: count, md5, JSON) → Claude generates a **staging + swap** load SQL → Tim pastes into wrapt → checksum SQL in wrapt | No npm. JSON round-trips exactly via `jsonb_populate_recordset`. The md5 in the export lets Claude detect a truncated CSV before anything is loaded. | Per-row INSERT text generated in SQL: larger, harder to escape. `pg_dump`: CLI. The `backups/*.json` files: stale and exclude `shopping_list` (fine as a fallback only). |
| 13 | Schema name in code | **Hard-code** `'yumlog'` in one module (`src/lib/db-schema.ts`), imported by `supabase.ts`, `worker.ts`, `functions/lib/*`, scripts | The schema is part of the data model, not deployment config. An env var would add another build-vs-runtime mismatch surface, the exact failure CLAUDE.md warns about. Env var **names** stay the same; only values change. | `PUBLIC_SUPABASE_SCHEMA` env var. |
| 14 | `.dev.vars` tracked despite `.gitignore` | `git rm --cached .dev.vars` on the branch. It stays in history, but it only holds the URL + anon key (public) [V: names only inspected]. | — | Rewriting history: not worth it for public values. |
| 15 | Where migration SQL lives | yumlog repo `supabase/migrations/001_…sql` onward (numbered, idempotent, wrapt-style header). Working copies in `docs/archive/2026-09-supabase-to-wrapt/stage3/`. | Yumlog owns the schema. Wrapt's repo stays untouched. | Put it in wrapt's repo: off-limits. |
| 16 | FK indexes | Add indexes on `recipe_ingredients(recipe_slug)`, `recipe_ingredients(ingredient)`, `shopping_list(ingredient)` **[T]** | None exist today [V]. Cascades and per-recipe reads benefit. Harmless at this size. | Strict parity. |
| 17 | Keep-alive cron | Keep it, now pointed at `yumlog.*` via `Accept-Profile`. | Wrapt is already kept awake by its 2-hourly sync, so the cron is now belt-and-braces. `/api/keepalive` stays useful as the health check for grants and exposure. | Remove it: loses the external-monitor health check. |

---

## 3. Target design (wrapt project, schema `yumlog`)

### 3.1 Objects

| Object | Notes |
|---|---|
| schema `yumlog` | owner `postgres` |
| `yumlog.ingredients`, `yumlog.recipes`, `yumlog.recipe_ingredients`, `yumlog.shopping_list` | Columns, defaults, identity (`GENERATED ALWAYS`), `ingredients_category_check`, PKs and FKs exactly as the Stage 1 facts. FKs repointed to `yumlog.*`. RLS enabled. |
| FK indexes (decision 16) | `recipe_ingredients(recipe_slug)`, `recipe_ingredients(ingredient)`, `shopping_list(ingredient)` |
| `yumlog.members` | `user_id uuid primary key references auth.users(id) on delete cascade, note text, added_at timestamptz not null default now()`. RLS on, **no policies, no grants**. |
| `yumlog.is_member()` | `returns boolean language sql stable security definer set search_path = ''` |
| `yumlog.shopping_list_set_updated_at()` + BEFORE UPDATE trigger | invoker, `search_path=''` |
| `yumlog.touch_recipes_for_ingredient(text)`, `yumlog.merge_ingredients(text,text)` | INVOKER, member guard, `search_path=''` (decision 4) |
| `yumlog.request_site_rebuild()` + trigger `yumlog_rebuild_site` | AFTER INSERT OR UPDATE OR DELETE **FOR EACH STATEMENT** on `yumlog.recipes`. DEFINER, `search_path=''`. |
| extension `pg_net` | enabled in wrapt (new; dashboard) |
| Vault secret `yumlog_deploy_hook` | created in the dashboard Vault UI, **never in SQL** (the editor keeps query history) |
| `supabase_realtime` membership | `yumlog.shopping_list` (decision 6) |
| Exposed schemas | `public, graphql_public, yumlog` — keep `public` the default (see R12) |
| default privileges | `alter default privileges for role postgres in schema yumlog revoke execute on functions from public;` Stops future functions defaulting to PUBLIC. |

### 3.2 Grants matrix

`–` = none. Postgres grants EXECUTE on new functions to PUBLIC automatically; that's revoked explicitly.

| Object | anon | authenticated | service_role | PUBLIC |
|---|---|---|---|---|
| schema `yumlog` | USAGE | USAGE | **–** | – |
| `recipes`, `ingredients`, `recipe_ingredients` | SELECT | SELECT, INSERT, UPDATE, DELETE | – | – |
| `shopping_list` | **–** | SELECT, INSERT, UPDATE, DELETE | – | – |
| `members` | – | – | – | – |
| identity sequences (`recipe_ingredients_id_seq`, `shopping_list_id_seq`) | – | USAGE, SELECT (belt-and-braces; identity inserts shouldn't need it [A], proven by the insert test) | – | – |
| `is_member()` | – | EXECUTE (policies evaluate as the caller) | – | revoked |
| `merge_ingredients`, `touch_recipes_for_ingredient` | – | EXECUTE | – | revoked |
| `request_site_rebuild()`, `shopping_list_set_updated_at()` | – | – | – | revoked (trigger-only) |

Consequences, all tested in 4.7:
- anon via PostgREST **or** via `public.run_ask_sql` can read the three public tables, which are already public on the static site. `shopping_list` and `members` return *permission denied*.
- service_role via `/ask` gets *permission denied for schema yumlog*.
- A signed-up stranger (authenticated, not a member) can read public tables, sees **0 rows** of `shopping_list` (RLS), and gets RLS errors on writes and "not a member" on RPCs.

```sql
-- sketch, not the Stage 3 file
grant usage on schema yumlog to anon, authenticated;
grant select on yumlog.recipes, yumlog.ingredients, yumlog.recipe_ingredients to anon;
grant select, insert, update, delete
  on yumlog.recipes, yumlog.ingredients, yumlog.recipe_ingredients, yumlog.shopping_list
  to authenticated;
revoke all on yumlog.members from anon, authenticated, service_role;
revoke execute on all functions in schema yumlog from public, anon;
grant execute on function yumlog.is_member(), yumlog.merge_ingredients(text,text),
  yumlog.touch_recipes_for_ingredient(text) to authenticated;
notify pgrst, 'reload schema';   -- harmless; Supabase's pgrst_ddl_watch usually does it anyway [A]
```

### 3.3 Policies

| Table | Policy | Command | To | USING / WITH CHECK |
|---|---|---|---|---|
| recipes, ingredients, recipe_ingredients | `<t> public read` | SELECT | anon, authenticated | `true` |
| same | `<t> member insert` | INSERT | authenticated | check `(select yumlog.is_member())` |
| same | `<t> member update` | UPDATE | authenticated | using + check `(select yumlog.is_member())` |
| same | `<t> member delete` | DELETE | authenticated | using `(select yumlog.is_member())` |
| shopping_list | `shopping_list members only` | ALL | authenticated | using + check `(select yumlog.is_member())` |
| members | — (none) | | | |

```sql
create or replace function yumlog.is_member()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from yumlog.members m where m.user_id = (select auth.uid()));
$$;

create policy "recipes member update" on yumlog.recipes
  for update to authenticated
  using ((select yumlog.is_member())) with check ((select yumlog.is_member()));
```

Idempotency: `drop policy if exists …; create policy …` for each policy.

### 3.4 RPCs (decision 4)

```sql
create or replace function yumlog.touch_recipes_for_ingredient(p_ingredient text)
returns integer language plpgsql security invoker set search_path = '' as $$
declare touched integer;
begin
  if not yumlog.is_member() then raise exception 'not a yumlog member' using errcode = '42501'; end if;
  update yumlog.recipes r set updated_at = now()
  from yumlog.recipe_ingredients ri
  where ri.recipe_slug = r.slug and ri.ingredient = p_ingredient;
  get diagnostics touched = row_count;
  return touched;
end $$;
-- merge_ingredients: body of scripts/ingredient-registry-rpc.sql:31-94, every name qualified
-- with yumlog., same guard at the top. It calls yumlog.touch_recipes_for_ingredient → 1 UPDATE
-- statement → 1 rebuild POST.
```

The client contract is unchanged: `src/lib/ingredient-registry.ts:157,174` call the RPCs by name, and `db.schema` routes them.

### 3.5 Rebuild webhook (decision 5)

```sql
create or replace function yumlog.request_site_rebuild()
returns trigger language plpgsql security definer set search_path = '' as $$
declare hook text;
begin
  select decrypted_secret into hook from vault.decrypted_secrets where name = 'yumlog_deploy_hook';
  if hook is null or hook = '' then
    return null;                                   -- no secret = webhook off (preview/load/rollback)
  end if;
  perform net.http_post(url := hook, body := '{}'::jsonb,
                        headers := '{"Content-Type":"application/json"}'::jsonb,
                        timeout_milliseconds := 5000);
  return null;
end $$;

drop trigger if exists yumlog_rebuild_site on yumlog.recipes;
create trigger yumlog_rebuild_site
  after insert or update or delete on yumlog.recipes
  for each statement execute function yumlog.request_site_rebuild();
```

- pg_net sends **after commit** [V docs]. A rolled-back transaction sends nothing, so dry runs and tests are safe.
- Statement-level fires even when 0 rows changed (e.g. a touch that matched nothing). Worst case is one extra rebuild. Acceptable, and simpler than three transition-table triggers.
- Failure mode: if Cloudflare is down, the POST is lost. The result is in `net._http_response` for 6 h [V docs]. Recovery: re-save any recipe or push to main. Same as today.
- Who can fire it: only members, because only they can write `recipes`.
- Secret exposure: only `postgres` (owner) and **service_role** can read `vault.decrypted_secrets` [V Stage 1]. `/ask` runs model SQL as service_role, so a Tim-typed question could print the URL, to Tim. `/ask` requires a connected, Spotify-allowlisted profile (wrapt `requireProfile`), so strangers can't reach it. Severity: low. The leak's impact is "someone can trigger yumlog rebuilds". See R5.

### 3.6 Adding Zoe later (document in CLAUDE.md)

1. Supabase (wrapt) → **Authentication → Users → Add user → Create new user**: her email plus a password,
   *Auto Confirm User* ticked.
2. SQL editor (wrapt):
   `insert into yumlog.members (user_id, note) select id, 'Zoe' from auth.users where email = 'fisherzoe98@gmail.com' on conflict do nothing;`
3. She logs in at yumlog `/login`. Removing her: `delete from yumlog.members where note = 'Zoe';`
   Her auth user can stay.

Side effect to tell her: she'd also be able to sign in to wrapt's login page, but gets nowhere there
without a Spotify-allowlisted connection.

---

## 4. Step-by-step plan

Gate key: **SQL-RO** = read-only SQL on a live DB. **SQL-W** = writing SQL on a live DB. **SB-DASH** =
Supabase dashboard setting. **CF-ENV** = Cloudflare env vars or settings. **MERGE** = merge to main.
**PAUSE** = pause or delete a project. **GIT** = branch/commit (low risk, still ask). **—** = no gate.

### Stage 3 — build (no live changes)

| # | What | Who | Gate | Verification | Rollback |
|---|---|---|---|---|---|
| 3.1 | Create branch `migrate/supabase-to-wrapt` | Claude | GIT | `git status` | delete branch |
| 3.2 | `supabase/migrations/001_yumlog_schema.sql`: schema, 4 tables, constraints, FK indexes, members, updated_at trigger. Idempotent (`if not exists`, `create or replace`). | Claude | — | self-review; dry run 4.1 | n/a |
| 3.3 | `002_yumlog_security.sql`: grants, default privileges, `is_member`, policies, RPCs (§3.2–3.4) | Claude | — | 4.1, 4.7 | n/a |
| 3.4 | `003_yumlog_rebuild_webhook.sql` (§3.5) | Claude | — | 4.1, 4.9 | n/a |
| 3.5 | `004_yumlog_realtime.sql`: idempotent `alter publication supabase_realtime add table yumlog.shopping_list` inside a `do` block that checks `pg_publication_tables` first | Claude | — | 4.9 | `alter publication … drop table …` |
| 3.6 | `docs/archive/2026-09-supabase-to-wrapt/stage3/dryrun.sql`: 001–004 + catalogue checks, ending in `do $$ begin raise exception 'DRY RUN OK: %', <summary>; end $$;`. The editor sends the paste as one request, which Postgres runs as one implicit transaction, so the exception rolls back everything and the message shows the result [A; proven by a follow-up `select to_regnamespace('yumlog')` returning null]. | Claude | — | 4.1 | n/a |
| 3.7 | `docs/archive/2026-09-supabase-to-wrapt/stage3/rls_tests.sql`: `begin; … set local role …; set local request.jwt.claims …; …; raise exception 'RESULTS: …'` so it is rollback-only. Cases in 4.7. | Claude | — | 4.7 | n/a |
| 3.8 | `export_from_old.sql` (read-only; one row per table plus a `meta` row: count, md5, JSON, sequence `last_value`s, `current_setting('TimeZone')`). `checksum.sql` (same md5 expression, run on both sides). Load template (staging table `yumlog_load.chunk(tbl, part, body)`, then one **swap** transaction). | Claude | — | 4.6 rehearsal | n/a |
| 3.9 | `freeze_old.sql` / `unfreeze_old.sql` (decision 10). `reverse_sync_to_old.sql` template (rollback path; disables the old **row-level** webhook trigger during the load, or it fires 51 POSTs). | Claude | — | read-through + Claude cross-checks object names against Stage 1 facts | n/a |
| 3.10 | Code: `src/lib/db-schema.ts`; `supabase.ts` `createClient(url, key, { db: { schema: YUMLOG_DB_SCHEMA } })`; `shopping-list.ts:243` `schema: 'yumlog'`; `Accept-Profile: yumlog` in `worker.ts:57-60` and `functions/lib/recipe-categories.ts:14-17`; `import-recipe.ts` `isAuthorized` (line 123) also calls `POST /rest/v1/rpc/is_member` with the user's token + `Content-Profile: yumlog` → 403 if false; build guard (decision 11); `scripts/check-supabase-schema.mjs` + `export-data.mjs` schema option (the anon check of `shopping_list.updated_at` will now correctly be *permission denied*; change that check); `git rm --cached .dev.vars` | Claude | GIT | `astro check` / build **can't run here (no npm)**. Rely on the preview build (4.8) plus code review. | revert commits |
| 3.11 | `wrangler.jsonc` `env.preview`: `name` becomes `yumlog-preview` automatically; redeclare `ai` (bindings aren't inherited [V docs]); `vars` = wrapt URL + anon key; `triggers: { crons: [] }`. Whether `assets` is inherited: [A], proven by the preview build serving pages. | Claude | GIT | preview build log lists bindings | remove block |
| 3.12 | Docs: CLAUDE.md (schema section → `yumlog.` + members; RLS; security; deployment/webhook; Zoe procedure; preview Worker); README; `backups/README.md` restore (schema-qualified, `overriding system value`, keep ids, members not in backups) | Claude | GIT | review | revert |

### Stage 4 — build it in wrapt and test (old project stays live; prod untouched)

| # | What | Who | Gate | Verification | Rollback |
|---|---|---|---|---|---|
| 4.1 | Paste `dryrun.sql` into **wrapt** SQL editor. Clash check: the script `raise`s if `to_regnamespace('yumlog')` already exists or any object name clashes. | Tim (SQL editor) | SQL-W (self-rolling-back) | Error text starts `DRY RUN OK`. Then run `select to_regnamespace('yumlog');` → `NULL`. | nothing persisted |
| 4.2 | Enable **pg_net** in wrapt | Tim (dashboard) | SB-DASH | `select extname from pg_extension where extname='pg_net'` | disable extension (nothing else in wrapt uses it [V]) |
| 4.3 | Run 001 → 002 → 003 → (004 if decision 6) in wrapt, one paste each. Each ends with a verification SELECT (object and grant report). | Tim (SQL editor) | SQL-W | report matches §3.2 matrix, including `has_schema_privilege('service_role','yumlog','USAGE') = false` and the pg_net `anon` EXECUTE status (R19) | `drop schema yumlog cascade;` + `alter publication supabase_realtime drop table yumlog.shopping_list` |
| 4.4 | Add `yumlog` to **Exposed schemas**, keeping `public` first/default | Tim (dashboard) | SB-DASH | wrapt still works (4.11 quick check straight after); preview (4.8) reads data | remove `yumlog` from the list |
| 4.5 | `insert into yumlog.members (user_id, note) values ('2a368d57-490e-4d71-919f-0693a639f323','Tim') on conflict do nothing;` | Tim (SQL editor) | SQL-W | `select count(*) from yumlog.members` = 1 | delete row |
| 4.6 | **Rehearsal load.** Run `export_from_old.sql` in the **old** project → Export CSV → give to Claude. Claude checks each JSON's md5 against the exported md5 (catches CSV truncation), then generates chunked staging SQL + swap SQL. Tim pastes each chunk, then the swap, into wrapt. Run `checksum.sql` in both. | Tim + Claude | SQL-RO (old), SQL-W (wrapt) | counts 51/201/483/10 (or current); md5 identical per table; sequences ≥ old `last_value` (1844 / 97); TimeZone equal on both sides | re-run the swap (it's truncate-and-reload), or `truncate` the 4 tables |
| 4.7 | Run `rls_tests.sql` in wrapt (rollback-only). Cases below. | Tim (SQL editor) | SQL-W (self-rolling-back) | every case `PASS` in the raised message | nothing persisted |
| 4.8 | Create Worker **yumlog-preview** (import repo, branch `migrate/supabase-to-wrapt`, deploy command `npx wrangler deploy --env preview`, build vars = wrapt URL + anon key + `NODE_VERSION=22`). Create a deploy hook on it. Put **that** hook URL in wrapt Vault as `yumlog_deploy_hook`. | Tim (CF + SB dashboard) | CF-ENV, SB-DASH | build log succeeds, lists `AI` + `ASSETS`, no cron; `https://yumlog-preview.<sub>.workers.dev` shows 51 recipes; `/api/keepalive` → 200 | delete Worker; delete Vault secret |
| 4.9 | **Preview acceptance test** (list below) | Tim (browser, 2 devices) | — (writes to wrapt `yumlog`, which the cutover reloads anyway) | each item ticked | final sync overwrites all preview edits |
| 4.10 | **Build-guard test:** set the preview build var `PUBLIC_SUPABASE_URL` to a wrong value → Retry build → the build **fails**, and the preview URL still serves the previous version. Restore the var and rebuild. | Tim (CF) | CF-ENV | as described | restore var |
| 4.11 | **Wrapt still works** (list below) | Tim | — | all green | 4.4/4.3 rollbacks |
| 4.12 | Claude: review the full branch diff; open the PR (not merged) | Claude | GIT | diff review | — |

**4.7 RLS cases** (each via `set local role …` + `set local request.jwt.claims = '{"sub":"…","role":"authenticated"}'`, results collected into a temp table granted to PUBLIC, then raised):
- anon: SELECT count on recipes/ingredients/recipe_ingredients = expected; SELECT shopping_list → 42501; INSERT recipes → 42501; `select public.run_ask_sql('select count(*) from yumlog.shopping_list')` → 42501; `… from yumlog.members` → 42501; `select yumlog.is_member()` → 42501; call merge → 42501.
- stranger (authenticated, fabricated uuid `00000000-0000-4000-8000-000000000001`): public reads OK; shopping_list = 0 rows; INSERT/UPDATE/DELETE recipes → RLS error or 0 rows; `yumlog.merge_ingredients('x','y')` → "not a yumlog member".
- service_role: `select count(*) from yumlog.recipes` → *permission denied for schema yumlog*; `select * from vault.decrypted_secrets where name='yumlog_deploy_hook'` → **readable** (documents R5, expected).
- Tim (`2a368d57-…`): full CRUD on all four; rename an ingredient with references (cascade works under RLS); merge two test ingredients; touch returns the row count.
- No real stranger sign-up. It would create a real wrapt account, and the fabricated-claims test exercises the same code path.

**4.9 Preview acceptance (Tim):** guest browse (home count, search, filters, featured, a recipe page, `/sourdough` ratios not the fallback) · log in with the **wrapt** password · edit a recipe → preview rebuild appears in yumlog-preview → Deployments within ~3 min (proves the webhook) · create a throwaway recipe then delete it in the dashboard · shopping list: add from recipe, manual add with a new ingredient (category prompt), tick, reorder, clear done · realtime: phone and laptop both on `/shopping`, tick on one, the other updates · `/settings` timestamps · `/settings/ingredients` rename + merge (throwaway names) · `/create` URL import · `/api/keepalive` 200.

**4.11 Wrapt checks (Tim):** wrapt.timclaessen.com dashboard loads with the leaderboard · `/ask` "how many plays last week?" answers · Cloudflare → Workers & Pages → wrapt sync Worker → Observability: next cron run (≤2 h) succeeded · `/history` and `/artist` load. Run after 4.3, after 4.4 and after 5.9.

### Stage 5 — cutover (the freeze window)

Precondition: Stage 4 all green; PR approved; Tim has ~1.5 h; Zoe told the day before.

| # | What | Who | Gate | Verification | Rollback |
|---|---|---|---|---|---|
| 5.0 | Create a **new prod deploy hook** on Worker `yumlog` (name `supabase-wrapt`). Keep it handy; don't paste it anywhere else. | Tim (CF) | CF-ENV | listed | delete hook |
| 5.1 | **T0 — Freeze** old: `freeze_old.sql` | Tim (SQL, old) | SQL-W | its verification SELECT shows no INSERT/UPDATE/DELETE for anon/authenticated and no RPC EXECUTE for authenticated | `unfreeze_old.sql` |
| 5.2 | Final export: `export_from_old.sql` → CSV → Claude | Tim | SQL-RO | Claude's md5 check passes | re-export |
| 5.3 | Claude generates the final staging + swap SQL (the same generator as the 4.6 rehearsal) | Claude | — | diff against the rehearsal output: only data changes | — |
| 5.4 | Load into wrapt: chunks, then swap. The swap: `begin; alter table yumlog.recipes disable trigger yumlog_rebuild_site; truncate yumlog.recipe_ingredients, yumlog.shopping_list, yumlog.recipes, yumlog.ingredients; insert … overriding system value …; setval(…); enable trigger; drop staging; commit;` | Tim (SQL, wrapt) | SQL-W | the swap's final SELECT prints counts | re-run the swap |
| 5.5 | `checksum.sql` on both projects | Tim | SQL-RO | **exact** match: counts, md5 × 4, sequences | fix, then re-run 5.4 |
| 5.6 | Vault: edit `yumlog_deploy_hook` → the **prod** hook from 5.0 | Tim (SB dashboard) | SB-DASH | name unchanged | set back to the preview hook, or delete |
| 5.7 | Cloudflare `yumlog`: **build** vars `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` → wrapt values | Tim (CF) | CF-ENV | values saved | restore old values (keep them in a password manager beforehand) |
| 5.8 | Cloudflare `yumlog`: **runtime** Variables and Secrets → the same two, wrapt values. Saving deploys immediately with the *old* code (schema `public`), so `/api/keepalive` returns 503 for a few minutes. Static recipe pages are unaffected. | Tim (CF) | CF-ENV | noted | restore old values |
| 5.9 | **Merge PR** → Workers Build on `yumlog` → deploy | Tim (GitHub) | MERGE | Deployments shows success. If the guard fails the build, the old site stays live: fix the vars, retry. | `git revert` merge commit (MERGE gate) + 5.7/5.8 rollback |
| 5.10 | **Prod smoke test**: `/api/keepalive` 200 · home 51 recipes · 3 recipe pages · `/sourdough` · log in (wrapt password) · edit one recipe trivially → a new deploy appears (webhook to prod works) · shopping list loads the 10 migrated items · import one URL · 4.11 wrapt checks | Tim | — | all green | Rollback R-B below |
| 5.11 | Leave the old project **frozen** (read-only) until Stage 6. Tell Zoe she's read-only for now. | Tim | — | — | — |

**Freeze duration estimate:** 5.1–5.5 ≈ 25–40 min (the export → Claude → paste loop is the slow part;
rehearsal 4.6 de-risks it); 5.6–5.10 ≈ 20–35 min, including one ~3 min build. **Total 45–75 min.**
Recipe reading is unaffected the whole time. Only editing and the shopping list are unavailable.

**Rollback R-B (after cutover, before Stage 6):** (1) Cloudflare `yumlog` build + runtime vars → old
values. (2) `git revert` the merge on main → build → deploy (schema `public` code against the old
project). (3) If anything was written in wrapt since cutover: run `export` against wrapt's `yumlog`
schema, load into the old `public` with `loadgen.py load <csv> --target old` (stage3 README, "Rollback after cutover"; old row-level webhook trigger
disabled during the load). (4) `unfreeze_old.sql`. (5) Delete the Vault secret so wrapt edits can't
rebuild prod.

### Stage 6 — decommission

| # | What | Who | Gate | Verification | Rollback |
|---|---|---|---|---|---|
| 6.1 | Soak 2 days of normal use (Tim's call; the pause is reversible for 90 days anyway): external monitor on `/api/keepalive` green; one real edit rebuilt; wrapt sync green | Tim | — | — | R-B |
| 6.2 | Claude writes `backups/*.json` + manifest from the **final export CSV** (no node needed), plus a `shopping_list.json` snapshot if Tim wants it. Commit. | Claude | GIT | row counts = 5.5 | — |
| 6.3 | Delete Worker `yumlog-preview` and its deploy hook. Remove `env.preview` from `wrangler.jsonc`. Delete the **old** prod deploy hook (the one embedded in the old project's trigger; this rotates that secret). | Tim (CF) + Claude | CF-ENV, GIT | only the `supabase-wrapt` hook remains | recreate |
| 6.4 | **Pause** the old yumlog project | Tim (SB dashboard) | PAUSE | project shows Paused | Restore (possible for 90 days) |
| 6.5 | Calendar reminder at +75 days: confirm backups, then decide delete vs let it lapse | Tim | PAUSE (for the delete) | — | — |
| 6.6 | ~~Optional hardening: revoke EXECUTE on `net.http_*`~~ — **dropped**: not possible from the SQL editor (see R19). | — | — | — | — |

---

## 5. Risk register

L/M/H = likelihood / impact.

| ID | Risk | L | I | Mitigation | Owner / stage |
|---|---|---|---|---|---|
| R1 | **Silent empty build**: a wrong URL, key or schema → queries return `[]` → an empty site deploys | M | H | Build guard (decision 11). Proven failing safely on preview (4.10). | Claude 3.10 / Tim 4.10 |
| R2 | **Stranger writes** via wrapt's open sign-ups | H (without mitigation) | H | Members allowlist in every write policy and RPC; stranger tests in 4.7 | Claude 3.3 / 4.7 |
| R3 | **Definer RPC abuse** | L | H | RPCs become INVOKER + guard + EXECUTE revoked from anon/PUBLIC. The only definer functions left are `is_member` (read-only boolean) and the trigger fn (not callable directly). | 3.3 |
| R4 | **`/ask` (service_role) reads yumlog** | L | L (data mostly public) | No service_role grants; 4.7 proves *permission denied for schema* | 3.3 / 4.7 |
| R5 | **Deploy-hook secret leak** | L | L (rebuild spam only) | Vault + no URL in trigger or function source. Residual: service_role / `/ask` can read Vault (Tim-only surface). Rotate by creating a new hook + Vault edit. The old hook is deleted in 6.3. | 3.4 / 6.3 |
| R6 | **Realtime/publication**: events leak, or don't arrive | L | L | SELECT grant + RLS per subscriber [V docs]. **DELETE events aren't RLS-filtered** [V docs] but carry only the PK (default replica identity) and anon has no grant. The client just refetches under RLS. Two-device test in 4.9. | 3.5 / 4.9 |
| R7 | **Identity/sequence drift**: new rows collide with loaded ids | M (without mitigation) | M | `overriding system value` + `setval(greatest(max(id), old last_value))`; verified in 5.5; the preview insert test in 4.9 exercises it | 3.8 / 5.5 |
| R8 | **Data loss in the freeze window** (Zoe or a stale tab writes to old after export) | L | M | Hard freeze incl. RPC EXECUTE revoke (decision 10); checksums on both sides after the load | 5.1 / 5.5 |
| R9 | **Build vs runtime env mismatch** (CLAUDE.md: keep-alive dies silently) | M | M | 5.7 **and** 5.8 as separate checklist lines; `/api/keepalive` 200 in the 5.10 smoke test; external monitor | Tim 5.7–5.10 |
| R10 | **Preview edits rebuild prod** | M (without mitigation) | L (prod still points at old DB, so it's only a wasted build) | Vault holds the **preview** hook during Stage 4, swapped in 5.6. Missing secret = no-op. | 4.8 / 5.6 |
| R11 | **Exposed-schema misconfig** → 404 "relation not found in schema cache" / empty site | M | H (masked by R1 guard → build fails, not empty) | 4.4 before 4.8; preview proves it; R1 guard | 4.4 |
| R12 | **Default schema flips**: if `yumlog` became PostgREST's *first* exposed schema, any client not sending a profile header would hit `yumlog` | L | H (wrapt) | Keep `public` first. supabase-js sends `Accept-Profile` from its default `schema:'public'` [A]. Wrapt has **no raw `/rest/v1` calls** [V grep]. 4.11 straight after 4.4. | 4.4 / 4.11 |
| R13 | **PostgREST schema cache stale** after DDL/grants | L | M | `notify pgrst, 'reload schema'` at the end of each migration file | 3.2–3.5 |
| R14 | **Wrapt regression** (new extension, exposed schema, publication, grants) | L | M | Additive only; no wrapt objects touched; 4.11 after each change | 4.3 / 4.4 / 5.9 |
| R15 | **Tim's shared password**: the yumlog login is now his wrapt login; one compromise covers both apps; the old yumlog password is gone | M | M | Tim confirms the wrapt password is strong/unique; optional leaked-password protection is a wrapt dashboard setting (out of scope, flag). Zoe unaffected (no account). | Tim |
| R16 | **Wrapt anon can call `run_ask_sql`** (wrapt-side, pre-existing) → arbitrary read-only SQL as anon, incl. reading catalogues | H (it exists) | M (wrapt) | **Flag only.** Yumlog's design assumes it: no secrets in function or trigger source; nothing sensitive grantable to anon. Recommend a separate wrapt fix: `revoke execute on function public.run_ask_sql from public, anon, authenticated`. | wrapt, later |
| R17 | **500 MB cap** (`plays` 137 MB and growing) → the DB goes read-only and yumlog writes break too | L (months away) | M | Yumlog adds <2 MB. Tim watches Usage monthly; shared fate noted in CLAUDE.md. | Tim |
| R18 | **Old project paused before verified** | L | H | 2-day soak (6.1) + backups (6.2) before pause (6.4); PAUSE is a separate gate | 6.x |
| R19 | **pg_net grants**: `net` schema USAGE is PUBLIC [V docs]; EXECUTE on `net.http_*` is granted to **PUBLIC by supabase_admin** (the owner), functions SECURITY INVOKER [V 2026-09-28, ACL query]. The only anon SQL path (`run_ask_sql`) is read-only, so a queued request would fail [A]. | L | M | **Accepted.** The revoke (005) can't work: postgres can only revoke grants it made, and isn't superuser — 005 aborted, nothing changed. | 4.3 / 6.6 |
| R20 | **90-day deletion window** on the paused old project | M | L (after 6.2) | Backups committed first; calendar reminder (6.5) | Tim 6.5 |
| R21 | **`.dev.vars` tracked** | H (it is) | L (public values) | `git rm --cached` (decision 14) | 3.10 |
| R22 | **`/api/import-recipe` open to any wrapt user** → Workers AI spend + outbound fetches | M | M | Member check via `rpc/is_member` (3.10); test with a non-member token is not possible without a real account, so unit-read the code + Tim's positive test | 3.10 |
| R23 | **Paste size / CSV truncation** in the SQL editor | M | M | Chunked staging load (each paste ≲ 60 KB; today's data ≈ 150 KB in total [V `backups/` sizes]); md5 of each exported JSON checked before load | 3.8 / 4.6 |
| R24 | **Preview Worker name check** refuses the dashboard setup | M | M | See Q2 fallback | 4.8 |
| R25 | **TimeZone differs** between sessions → timestamptz text differs → false checksum mismatch | L | L | The export and checksum both print `current_setting('TimeZone')`; compare before trusting md5 | 3.8 |
| R26 | **Stale sessions**: the old site's JS in an open tab still points at the old project | M | L | Hard freeze makes those writes fail visibly. Supabase's storage key differs per project ref, so Tim simply logs in again. | 5.1 |

---

## 6. Tim's dashboard checklist

Menu paths as of 2026-09. Supabase moves things, so the older path is given in brackets.

### Stage 4
**Supabase — wrapt project**
- [ ] SQL Editor → New query → paste `dryrun.sql` → Run → expect an error starting `DRY RUN OK`. Then run `select to_regnamespace('yumlog');` → NULL.
- [ ] **Database → Extensions** → search `pg_net` → Enable.
- [ ] SQL Editor: run `001`, `002`, `003`, `004` in order; screenshot or copy each result grid.
- [ ] **Project Settings → Data API** (or **Integrations → Data API → Settings**) → *Exposed schemas* → add `yumlog` → Save. Leave `public` in place.
- [ ] SQL Editor: members insert (4.5).
- [ ] SQL Editor: rehearsal chunks + swap (4.6), then `checksum.sql`.
- [ ] SQL Editor: `rls_tests.sql` → expect an error starting `RESULTS:` with every line PASS.
- [ ] **Integrations → Vault** (or **Project Settings → Vault**) → *Add new secret* → name `yumlog_deploy_hook`, value = **yumlog-preview** deploy-hook URL.

**Supabase — old yumlog project**
- [ ] SQL Editor: `export_from_old.sql` → Run → **Export → CSV** → send to Claude.

**Cloudflare**
- [ ] **Workers & Pages → Create → Import a repository** → `Tim-Claessen/yumlog-v2` → Worker name `yumlog-preview` → production branch `migrate/supabase-to-wrapt` → build command `npm run build` → deploy command `npx wrangler deploy --env preview`.
- [ ] yumlog-preview → **Settings → Build → Variables and secrets**: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY` (wrapt values, legacy JWT anon key), `NODE_VERSION=22`.
- [ ] yumlog-preview → **Settings → Build → Deploy hooks** → create `supabase-wrapt-preview` (branch `migrate/supabase-to-wrapt`) → copy into Vault (above).
- [ ] Build-guard test (4.10), then restore the var.
- [ ] Leave `yumlog` → *Builds for non-production branches* **OFF**.

### Stage 5
- [ ] Before T0: copy the current `yumlog` build + runtime var values into a password manager (rollback).
- [ ] CF `yumlog` → **Settings → Build → Deploy hooks** → create `supabase-wrapt` (branch `main`).
- [ ] SB old → SQL Editor `freeze_old.sql` (T0).
- [ ] SB old → `export_from_old.sql` → CSV → Claude.
- [ ] SB wrapt → paste chunks + swap; `checksum.sql` on **both** projects → send both grids to Claude.
- [ ] SB wrapt → **Integrations → Vault** → edit `yumlog_deploy_hook` → prod hook URL.
- [ ] CF `yumlog` → **Settings → Build → Variables and secrets** → edit both Supabase vars.
- [ ] CF `yumlog` → **Settings → Variables and Secrets** (runtime) → edit both Supabase vars (keep the same type, Text or Secret, as today).
- [ ] GitHub → PR → Merge.
- [ ] CF `yumlog` → **Deployments** → wait for success → smoke test 5.10.

### Stage 6
- [ ] CF → delete Worker `yumlog-preview`; `yumlog` → Deploy hooks → delete the **old** hook (keep `supabase-wrapt`).
- [ ] SB old → **Project Settings → General → Pause project**.
- [ ] Calendar reminder at +75 days.

---

## 7. Open questions / unverified

| # | Question | Why it matters | What resolves it |
|---|---|---|---|
| Q1 | Does the SQL editor run a multi-statement paste as one implicit transaction, so a final `raise exception` rolls back everything? [A] | Dry run and RLS tests depend on it | The first line of 4.1: a follow-up `select to_regnamespace('yumlog')` returns NULL. If it doesn't, drop the schema and switch to explicit `begin; … rollback;` with results raised before the rollback. |
| Q2 | Will Workers Builds accept a dashboard-created Worker `yumlog-preview` whose `wrangler.jsonc` top-level name is `yumlog`, deploying with `--env preview`? Docs: the name "must match" [V troubleshoot page], and environments deploy as `<name>-<env>` connected with `--env` commands [V advanced-setups page], but the docs create those Workers via `wrangler deploy` first. | Preview approach | Try 4.8. **Fallback A:** a branch-only commit setting the top-level `name` to `yumlog-preview`, reverted before merge. **Fallback B:** Worker Previews on `yumlog` with preview build vars set via the Builds API (needs a curl + API token; Tim's call). |
| Q3 | Are `yumlog`'s current runtime vars *Text* or *Secret*? `wrangler deploy` replaces dashboard *Text* vars unless `keep_vars` is set. | If Text vars survive today's deploys there's a reason; if a deploy ever wipes them, `/api/keepalive` breaks (R9) | Tim looks at the type column; `/api/keepalive` after 5.9 is the proof |
| Q4 | Is `assets` inherited into `env.preview`? Is `triggers: {crons: []}` honoured as "no cron"? [A] | Preview correctness and cost | Preview build log + Worker → Settings → Triggers shows no cron |
| Q5 | Does supabase-js always send `Accept-Profile: public` for wrapt's default client? [A] | R12 | 4.11 after 4.4 (wrapt works) settles it in practice |
| Q6 | SQL editor paste/request size limit and CSV-export cell limit: not documented anywhere I found | R23 | Chunking + md5 check make it moot; the rehearsal proves it |
| Q7 | **Answered 2026-09-28:** EXECUTE on `net.http_*` is granted to PUBLIC by supabase_admin (so anon/authenticated inherit it); not revocable by postgres. Was: do Supabase's pg_net install hooks grant EXECUTE on `net.http_*` to anon/authenticated? | R19 | The 4.3 report prints `has_function_privilege('anon','net.http_post(...)','EXECUTE')` |
| Q8 | Do identity inserts need sequence USAGE? [A: no] | Grants | Granted anyway; the 4.7 Tim insert proves inserts work |
| Q9 | Does Realtime deliver DELETE events to a role with no SELECT grant (anon)? | R6 (ids only) | Low value; accept. Could test with an anon subscriber on preview if Tim cares. |
| Q10 | Wrapt Auth *Confirm email* setting (not in the Stage 1 facts) | Affects how easily a stranger reaches `authenticated`; the design is safe either way | Tim glances at **Authentication → Sign In / Providers** |
| Q11 | Should wrapt's `CLAUDE.md` get a one-line note that schema `yumlog` belongs to another app (so a future wrapt session doesn't drop it or point `/ask` at it)? **[T]** | Long-term safety | Tim's call; it's a wrapt-repo change |

### Sources
- Supabase custom schemas: https://supabase.com/docs/guides/api/using-custom-schemas
- Supabase Realtime postgres_changes (custom schemas, RLS per subscriber, DELETE caveat): https://supabase.com/docs/guides/realtime/postgres-changes
- pg_net (after-commit, `_http_response` 6 h, `net` USAGE to PUBLIC): https://supabase.com/docs/guides/database/extensions/pg_net
- Vault: https://supabase.com/docs/guides/database/vault
- Workers Builds configuration (build vars not at runtime; preview command): https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Build branches / preview builds: https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/
- Builds API (env vars per trigger): https://developers.cloudflare.com/workers/ci-cd/builds/api-reference/
- Worker Previews (previews block; no crons; wrangler ≥ 4.135): https://developers.cloudflare.com/workers/previews/ , https://developers.cloudflare.com/workers/previews/get-started/
- Name must match: https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/
- Environments with Workers Builds: https://developers.cloudflare.com/workers/ci-cd/builds/advanced-setups/ , https://developers.cloudflare.com/workers/wrangler/environments/
