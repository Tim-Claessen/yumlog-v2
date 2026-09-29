# Archive — yumlog → wrapt Supabase migration (2026-09-28 → 2026-09-29)

**Finished.** Yumlog moved out of its own Supabase project into a `yumlog` schema in wrapt's project
(to free a free-plan slot). Cutover 2026-09-29 (PR #2); the old project was paused the same day.
This folder is the historical record — nothing here is needed to run the app. The live schema SQL
is [`supabase/migrations/`](../../../supabase/migrations/).

| Folder | What |
|---|---|
| `stage1/` | Recon SQL run against both projects before planning, plus the old-project RPC hotfix |
| `stage2/PLAN.md` | The approved plan and risk register (step numbers below are its numbers) |
| `stage3/` | Working kit: dry run, RLS tests, export/load generator (`loadgen.py`), freeze/unfreeze, rollback. Its README gives the run order. `stage3/out/` is gitignored (it holds data). |

The rest of this file is the step-by-step log kept while the migration ran.

## Projects
- **Old yumlog**: ref `nrmimftrjulvsgonrlzg`, tables in `public`. Hotfix applied (anon EXECUTE
  revoked on the two definer RPCs). Frozen then **paused 2026-09-29** — restorable until ~2026-12-28.
- **Wrapt** (new home): `https://wncacqqtrixnqlykchyy.supabase.co`. Sign-ups ON. Tim's wrapt
  user id `2a368d57-490e-4d71-919f-0693a639f323`. Zoe gets no account for now.

## Decisions (all approved)
Own `yumlog` schema; `yumlog.members` allowlist + `is_member()`; RPCs SECURITY INVOKER with
member guard; no grants to service_role (wrapt `/ask` can't read yumlog); rebuild webhook via
pg_net + Vault secret `yumlog_deploy_hook` + statement-level trigger (no-op for non-members);
realtime on shopping_list; FK indexes; hard freeze of old project at cutover; build guard;
import-recipe member check; separate `yumlog-preview` Worker (`wrangler deploy --env preview`);
revoke pg_net EXECUTE from API roles (005 — turned out impossible, see Done); 2-day soak before pausing old project.

## Done
- Stage 1 recon, Stage 2 plan, Stage 3 build (branch commits incl. `6682e8a`).
- 4.1 dry run: `DRY RUN OK`; `to_regnamespace('yumlog')` = NULL afterwards.
- 4.2 pg_net enabled in wrapt (0.20.3, schema extensions).
- 4.3 migrations 001–004 run in wrapt: **every row OK**. 003 INFO: Vault secret absent (expected),
  postgres can read vault, and `net.http_*` EXECUTE = true for anon/authenticated/**public**/postgres.
- 005: **aborted, nothing changed, not applied.** EXECUTE on `net.http_*` is granted to PUBLIC by
  supabase_admin (owner; functions SECURITY INVOKER) — postgres can't revoke another role's grant.
  Risk accepted (PLAN R19); step 6.6 dropped.
- 4.4 `yumlog` added to Exposed schemas; wrapt still works.
- 4.5 members: one row, Tim `2a368d57-…`.
- 4.6 rehearsal load (run `20260928T134240Z-8a7541`, export 13:37 UTC): checksum grids identical
  both sides — 201/51/483/10, md5s equal, sequences 1844/97, TimeZone UTC. (A hand-edited chunk
  was caught by the swap's md5 check; paste generated files unchanged — dollar-quoted, apostrophes
  are fine.) Files in gitignored `docs/archive/2026-09-supabase-to-wrapt/stage3/out/`.
- 4.7 `rls_tests.sql`: **40 PASS, 0 FAIL, 2 SKIP** (W1/W2 — webhook off until the Vault secret exists).
- Branch pushed to origin (approved 2026-09-28).
- 4.8 `yumlog-preview` Worker live (https://yumlog-preview.timclaessen96.workers.dev): 51 recipes,
  `/api/keepalive` 200, no cron, runtime vars as Secrets, preview deploy hook in Vault. Q2 answered:
  a dashboard-created `yumlog-preview` + `--env preview` works (no fallback needed). rls_tests re-run:
  **42 PASS, 0 FAIL, 0 SKIP (webhook on)**.
- **4.9–4.11 skipped by Tim's decision (2026-09-28)** — browser acceptance, build-guard test and wrapt
  checks not run. Claude smoke-checked the preview's public pages only (home 51 links, recipe pages,
  /sourdough, /login, /shopping, /api/keepalive). Logged-in flows (shopping, save → webhook rebuild,
  realtime, registry, import) are untested before cutover; the 5.10 smoke test is the first check.

## Stage 5 progress (2026-09-29)
- 5.0 prod deploy hook created. Pre-T0 copy of prod vars skipped (old anon key stays visible in the
  old dashboard until Stage 6; old URL is in the repo). Prod runtime vars are type **Secret**.
- 5.1 freeze: every row OK, frozen at 2026-09-29 13:47:21 UTC. 5.2 export 13:47:46; md5s OK, data
  identical to the rehearsal export. 5.3 load generated (run `20260929T134920Z-c34ab1`), **not used**.
- 5.4/5.5 **skipped by Tim's decision**: wrapt kept the rehearsal load plus Tim's own preview test edits
  (wrapt checksum: shopping_list 8 rows vs 10 old; seqs 1846/103). Frozen export kept in
  `docs/archive/2026-09-supabase-to-wrapt/stage3/out/export_final.csv` if the pre-test state is ever wanted.
- 5.6 Vault -> prod hook; 5.7/5.8 CF build + runtime vars -> wrapt; 5.9 PR #2 merged, deploy green.
- 5.10 Claude's public checks on yumlog.timclaessen.com: home 51 recipes, recipe pages, /sourdough,
  /login, /shopping 200; /api/keepalive 200; import-recipe unauthenticated 401; client bundle targets
  wrapt (`wncacqqtrixnqlykchyy`) + schema `yumlog`, no old ref. Tim's logged-in checks all passed: login, /shopping (8 items),
  recipe edit → prod rebuild via webhook, import, wrapt dashboard + /ask. **Cutover complete.**
- Deploy log warned wrangler overrides the dashboard custom-domain route (`yumlog.timclaessen.com`,
  not in wrangler.jsonc); the domain still served after deploy. Fixed: now declared in
  `wrangler.jsonc` `routes` (`custom_domain: true`).

## Stage 6 — brought forward to 2026-09-29 (Tim's decision; 2-day soak skipped)
- 6.2 `backups/` re-exported from **wrapt** (not the final CSV, since prod now includes the preview
  test edits): 51 / 201 / 483. Local `.env` now points at wrapt (old values kept as comments).
- 6.3 `env.preview` removed from `wrangler.jsonc`; Worker `yumlog-preview` + its hook deleted; the
  **old** prod deploy hook deleted (only `supabase-wrapt` remains).
- 6.4 old project paused. 6.5: decide delete vs let it lapse before ~2026-12-28.
- Repo tidy: `migration/` moved here; `.claude/settings.local.json` untracked.

## Known small issues (accepted, not fixed)
UI shows edit controls to any signed-in wrapt user (DB refuses writes); login page copy says
sign-ups disabled (true for yumlog); wrapt's `public.run_ask_sql` executable by anon (wrapt
issue — flag only); login `?redirect=` open redirect.
