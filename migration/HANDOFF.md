# Handoff — yumlog → wrapt Supabase migration (state at 2026-09-28)

Read this, then `migration/stage2/PLAN.md` (the approved plan; step numbers below are its
numbers) and `migration/stage3/README.md` (run order). Branch: `migrate/supabase-to-wrapt`
(not pushed, not merged). Wrapt repo (`../wrapt`) is read-only reference — never change it.

## Working rules Tim set (still in force)
- Claude is the **master**: spawn a subagent per stage/heavy task, review its report
  critically against the repo before passing anything on.
- **Gates — explicit approval per action** for: running SQL on a live DB, Supabase dashboard
  changes, Cloudflare env var changes, pushing/merging, pausing/deleting a project. Tim pastes
  SQL himself and sends back the result grids (CSV).
- Dashboards over CLIs; no npm/npx on his machine. Python 3.14 is available (loadgen.py).
- Commits only to the branch, ending with the Co-Authored-By line.

## Projects
- **Old yumlog**: ref `nrmimftrjulvsgonrlzg`, tables in `public`. Hotfix applied (anon EXECUTE
  revoked on the two definer RPCs). Still live and in use.
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
  are fine.) Files in gitignored `migration/stage3/out/`.
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

## Next
- 4.8 create `yumlog-preview` Worker (build vars = wrapt URL + legacy anon JWT + NODE_VERSION=22;
  runtime vars as **Secrets**), its deploy hook into Vault as `yumlog_deploy_hook`; then re-run
  `rls_tests.sql` to see W1/W2 PASS. Open question Q2: whether Workers Builds accepts
  `--env preview` naming; fallbacks in PLAN.
- Stage 5 cutover (fresh export + load with a new run id) and Stage 6 decommission per PLAN §4.

## Known small issues (accepted, not fixed)
UI shows edit controls to any signed-in wrapt user (DB refuses writes); login page copy says
sign-ups disabled (true for yumlog); wrapt's `public.run_ask_sql` executable by anon (wrapt
issue — flag only); `.claude/settings.local.json` tracked in git; login `?redirect=` open redirect.
