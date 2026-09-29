# Stage 3 — the migration kit (what to run, where, in what order)

Everything here was written without touching any database. The plan and the reasons
are in [`../stage2/PLAN.md`](../stage2/PLAN.md); step numbers below (4.1, 5.4 …) are
its step numbers. The permanent schema SQL lives in
[`../../supabase/migrations/`](../../supabase/migrations/); this folder holds the
one-off working files.

**Where to paste:** Supabase dashboard → pick the project → **SQL Editor** → **New
query** → paste the *whole* file → **Run**. Check the project name in the top bar
first — two projects are involved:

- **WRAPT** — wrapt's project, the new home.
- **OLD** — yumlog's own project, ref `nrmimftrjulvsgonrlzg`.

**What to send back:** for a grid, **Export → CSV** (or select all + copy). For an
error (the dry run and the RLS tests *end* in one on purpose), copy the whole error
text. Every grid has a `status` column: `OK`, `MISMATCH` or `INFO`.

## Files

| File | Project | Writes? | Purpose |
|---|---|---|---|
| `dryrun.sql` | WRAPT | no (rolls itself back) | 001–004 in one `do` block + checks; always ends in an error |
| `../../supabase/migrations/001…004` | WRAPT | yes | the real schema build |
| `../../supabase/migrations/005_optional_revoke_net_http.sql` | WRAPT | yes | **Don't run** — tried 2026-09-28, can't work on Supabase (grants are supabase_admin's; see PLAN R19). Aborts harmlessly. |
| `rls_tests.sql` | WRAPT | no (rolls itself back) | grants/RLS/RPC/webhook cases; always ends in an error |
| `export_from_old.sql` | OLD | no | the data out, as one CSV |
| `checksum.sql` | both | no | counts + md5 per table + sequences; edit one value per project |
| `freeze_old.sql` / `unfreeze_old.sql` | OLD | yes | cutover freeze / rollback |
| `export_from_wrapt.sql` | WRAPT | no | rollback only: the data back out of wrapt |
| `loadgen.py` | Claude, locally | — | CSV → chunk + swap SQL; regenerates the static files |
| `out/` | — | — | generated load SQL (gitignored; contains data) |

`dryrun.sql`, `checksum.sql` and the two `export_*.sql` files are **generated** —
edit `loadgen.py` or the migrations, then run `python migration/stage3/loadgen.py
static`. `python migration/stage3/loadgen.py selftest` checks the generator offline
(CSV parsing, md5, chunking, quoting) and that the generated files are current.

## Stage 4 — build it in wrapt (old project stays live)

| Step | Run | Project | Expect / send back |
|---|---|---|---|
| 4.1 | `dryrun.sql` | WRAPT | An **error** starting `DRY RUN OK (all rolled back): tables=5 policies=13 functions=5 …`. Then run `select to_regnamespace('yumlog');` on its own → must be **NULL**. Send both. `DRY RUN FAILED`/any other error → send it, stop. |
| 4.2 | Dashboard: **Database → Extensions → pg_net → Enable** | WRAPT | — |
| 4.3 | `001_yumlog_schema.sql`, then `002_…`, `003_…`, `004_…` — one paste each | WRAPT | Each ends in a grid; all rows `OK` (003 also has `INFO` rows: pg_net version, Vault secret count, `net.http_*` EXECUTE for anon/authenticated). Send all four grids. (003 will show `true` for anon/authenticated on `net.http_*` — accepted, PLAN R19; 005 can't fix it.) |
| 4.4 | Dashboard: **Data API → Exposed schemas** → add `yumlog` after `public` | WRAPT | Then check wrapt still works (PLAN 4.11). |
| 4.5 | `insert into yumlog.members (user_id, note) select id, 'Tim' from auth.users where email = 'timclaessen96@gmail.com' on conflict do nothing;` then `select m.user_id, u.email from yumlog.members m join auth.users u on u.id = m.user_id;` | WRAPT | Exactly one row: Tim, id `2a368d57-490e-4d71-919f-0693a639f323`. |
| 4.6a | `export_from_old.sql` | OLD | **Export → CSV** → send the file. |
| 4.6b | Claude runs `loadgen.py load <csv> --target wrapt` → sends `load_01_chunk.sql` … and `load_99_swap.sql` | — | Claude has already checked every md5 in the CSV. |
| 4.6c | each `load_NN_chunk.sql` (any order), then `load_99_swap.sql` | WRAPT | Each chunk shows parts loaded so far. The swap ends in the checksum grid → send it. |
| 4.6d | `checksum.sql` with `'public'` | OLD | Send the grid: counts and md5s must equal the swap's grid; wrapt sequences ≥ old. |
| 4.7 | `rls_tests.sql` | WRAPT | An **error** starting `RESULTS: <n> PASS, 0 FAIL, <n> SKIP (webhook on/off)` then one line per case. Send the whole text. (W-cases SKIP until the Vault secret exists — re-run after 4.8 to see them PASS.) |
| 4.8 | Cloudflare: create Worker `yumlog-preview` (PLAN §6 checklist); **Integrations → Vault** → secret `yumlog_deploy_hook` = the **preview** deploy-hook URL | WRAPT | Runtime vars on yumlog-preview as type **Secret** (see `wrangler.jsonc` comment). |
| 4.9–4.11 | Browser tests per PLAN | — | — |

## Stage 5 — cutover (freeze window)

| Step | Run | Project | Expect / send back |
|---|---|---|---|
| 5.1 | `freeze_old.sql` | OLD | All rows `OK` (writes false, SELECT true). Note the time. |
| 5.2 | `export_from_old.sql` | OLD | **Export → CSV** → send. |
| 5.3 | Claude generates a fresh load (new run id) | — | — |
| 5.4 | new chunks, then the new swap | WRAPT | The swap's grid → send. |
| 5.5 | `checksum.sql` with `'public'` | OLD | Send; must match 5.4's grid exactly. |
| 5.6 | Vault: edit `yumlog_deploy_hook` → the **production** hook | WRAPT | — |
| 5.7–5.10 | Cloudflare vars, merge, smoke test (PLAN) | — | — |

## Rollback after cutover (PLAN R-B)

1. Cloudflare `yumlog` build + runtime vars back to the old values; revert the merge.
2. If wrapt took writes since cutover: `export_from_wrapt.sql` (WRAPT) → CSV → Claude
   runs `loadgen.py load <csv> --target old` → paste its chunks and swap into **OLD**
   (staging goes in a throwaway `yumlog_load` schema; the old row-level
   "Rebuild Cloudflare on recipe change" trigger is disabled during the load). Then
   `checksum.sql` in both (`'yumlog'` in wrapt, `'public'` in old).
3. `unfreeze_old.sql` (OLD).
4. Delete the Vault secret in wrapt so wrapt edits can't rebuild production.

## Things these files assume (checked by their own reports)

- The SQL editor runs as `postgres`.
- A single `do` block is atomic, so the dry run and RLS tests roll back whatever the
  editor's transaction handling is (PLAN Q1 — the `to_regnamespace` check confirms).
- `wrangler deploy` never touches Secret-type variables.
