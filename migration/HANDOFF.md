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

## Next (paused 2026-09-28 — resume here)
Live state right now: old project still live and **not** frozen (prod site uses it); wrapt `yumlog`
holds the rehearsal data (preview edits there are throwaway); Vault `yumlog_deploy_hook` = the
**preview** hook; yumlog-preview Worker up. Nothing in production has changed.
1. 4.12 **done 2026-09-29**: PR #2 opened (https://github.com/Tim-Claessen/yumlog-v2/pull/2) — do not merge until 5.9.
2. Stage 5 cutover per PLAN §4 / stage3 README (Tim needs ~45–75 min; tell Zoe). Before T0: Tim copies
   the current prod `yumlog` build + runtime Supabase values to a password manager. Then 5.0 prod
   deploy hook → 5.1 freeze → 5.2 export → Claude runs `loadgen.py load <csv> --target wrapt` (new
   run id) → 5.4 chunks + swap (paste unchanged) → 5.5 checksums both sides → 5.6 Vault → prod hook →
   5.7/5.8 CF vars → 5.9 merge → 5.10 smoke test (the first logged-in test — 4.9 was skipped).
3. Stage 6 decommission after the 2-day soak.

## Known small issues (accepted, not fixed)
UI shows edit controls to any signed-in wrapt user (DB refuses writes); login page copy says
sign-ups disabled (true for yumlog); wrapt's `public.run_ask_sql` executable by anon (wrapt
issue — flag only); `.claude/settings.local.json` tracked in git; login `?redirect=` open redirect.
