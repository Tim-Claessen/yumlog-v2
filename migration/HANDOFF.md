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
revoke pg_net EXECUTE from API roles (005); 2-day soak before pausing old project.

## Done
- Stage 1 recon, Stage 2 plan, Stage 3 build (branch commits incl. `6682e8a`).
- 4.1 dry run: `DRY RUN OK`; `to_regnamespace('yumlog')` = NULL afterwards.
- 4.2 pg_net enabled in wrapt (0.20.3, schema extensions).
- 4.3 migrations 001–004 run in wrapt: **every row OK**. 003 INFO: Vault secret absent (expected),
  postgres can read vault, and `net.http_*` EXECUTE = true for anon/authenticated/**public**/postgres.
- 005 was rewritten (commit `6682e8a`) because access is via PUBLIC: it now grants postgres
  explicitly, revokes PUBLIC/anon/authenticated, and aborts with "005 ABORTED (nothing changed)"
  if postgres would lose EXECUTE or anon/authenticated keep it.

## Waiting on Tim (asked for approval, not yet given/returned)
1. Run revised `supabase/migrations/005_optional_revoke_net_http.sql` in wrapt → grid
   (expect `false/false/false/true`, all OK) or the ABORTED message.
2. 4.4 Data API → Exposed schemas: add `yumlog` after `public`; then confirm
   wrapt.timclaessen.com still works.
3. 4.5 members insert (by email) → expect one row, id `2a368d57-…`.
4. 4.6a `migration/stage3/export_from_old.sql` in the OLD project → Export CSV.

## Next after that
- 4.6b: `python migration/stage3/loadgen.py load <csv> --target wrapt` → give Tim chunk files +
  swap (output in gitignored `migration/stage3/out/`); 4.6c/d swap + `checksum.sql` both sides,
  must match exactly.
- 4.7 `rls_tests.sql` → expect `RESULTS: n PASS, 0 FAIL`.
- Push branch (needs approval) → 4.8 create `yumlog-preview` Worker (build vars = wrapt URL +
  legacy anon JWT + NODE_VERSION=22; runtime vars as **Secrets**), its deploy hook into Vault.
  Open question Q2: whether Workers Builds accepts `--env preview` naming; fallbacks in PLAN.
- 4.9–4.11 preview acceptance, build-guard test, wrapt regression checks → Stage 4 gate.
- Stage 5 cutover and Stage 6 decommission per PLAN §4.

## Known small issues (accepted, not fixed)
UI shows edit controls to any signed-in wrapt user (DB refuses writes); login page copy says
sign-ups disabled (true for yumlog); wrapt's `public.run_ask_sql` executable by anon (wrapt
issue — flag only); `.claude/settings.local.json` tracked in git; login `?redirect=` open redirect.
