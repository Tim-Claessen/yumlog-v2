"""Yumlog migration SQL generator (Stage 3 of migration/stage2/PLAN.md).

Plain Python 3 standard library only — no npm/node needed. Run from the repo root:

  python migration/stage3/loadgen.py static
      Regenerates the committed, data-free SQL files in migration/stage3/ from one
      source of truth: dryrun.sql (supabase/migrations/001-004 wrapped in a single
      self-rolling-back DO block), checksum.sql, export_from_old.sql and
      export_from_wrapt.sql. Re-run after editing any migration.

  python migration/stage3/loadgen.py load <export.csv> --target wrapt|old
      Turns the CSV of export_from_old.sql (target wrapt: the forward copy) or of
      export_from_wrapt.sql (target old: the rollback reverse sync) into
      paste-sized SQL files: load_NN_chunk.sql (staging) + load_99_swap.sql.
      Written to migration/stage3/out/<target>-<run id>/ (gitignored: it holds data).

  python migration/stage3/loadgen.py selftest
      Offline round-trip test using backups/*.json plus synthetic nasty rows.

Design notes
  * The export emits, per table, the JSON array text (jsonb_agg(to_jsonb(row))::text)
    and md5() of exactly that text. md5() in Postgres hashes the UTF-8 bytes, so
    hashlib.md5(json_text.encode('utf-8')) here must match — that is the CSV
    truncation check, done before anything is generated.
  * Chunks carry slices of that same text; the swap reassembles them with
    string_agg(... order by part), re-checks the md5 IN THE DATABASE, and only
    then truncates and reloads via jsonb_populate_recordset.
  * Dollar-quote tags are random and verified not to occur in (or be formed at the
    end of) any chunk, so no data can terminate a literal early.
  * checksum.sql uses a timezone- and collation-independent canonical row text,
    identical on both sides, so old vs wrapt can be compared exactly.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import secrets
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MIGRATIONS = REPO / "supabase" / "migrations"

TABLE_ORDER = ["ingredients", "recipes", "recipe_ingredients", "shopping_list"]  # FK order

# Column lists exactly as in the live schema (migration/stage1 facts) — used to
# sanity-check the export before generating anything.
COLUMNS = {
    "ingredients": ["name", "category"],
    "recipes": ["slug", "title", "category", "protein", "cook_time_min", "method",
                "source_url", "created_at", "tips", "substitutions", "updated_at"],
    "recipe_ingredients": ["id", "recipe_slug", "ingredient", "display_name", "quantity", "unit"],
    "shopping_list": ["id", "ingredient", "quantity", "unit", "checked", "position",
                      "added_at", "updated_at"],
}

# Order used for both the export array and the checksum. `collate "C"` keeps text
# ordering identical whatever each database's default collation is.
ORDER_BY = {
    "ingredients": 't.name collate "C"',
    "recipes": 't.slug collate "C"',
    "recipe_ingredients": "t.id",
    "shopping_list": "t.id",
}

# Canonical row text for checksum.sql: every column, timestamps rendered in UTC so
# the session TimeZone can't change the hash.
CANONICAL_ROW = {
    "ingredients": "jsonb_build_array(t.name, t.category)",
    "recipes": ("jsonb_build_array(t.slug, t.title, t.category, t.protein, t.cook_time_min, t.method, "
                "t.source_url, t.created_at at time zone 'UTC', t.tips, t.substitutions, "
                "t.updated_at at time zone 'UTC')"),
    "recipe_ingredients": ("jsonb_build_array(t.id, t.recipe_slug, t.ingredient, t.display_name, "
                           "t.quantity, t.unit)"),
    "shopping_list": ("jsonb_build_array(t.id, t.ingredient, t.quantity, t.unit, t.checked, t.position, "
                      "t.added_at at time zone 'UTC', t.updated_at at time zone 'UTC')"),
}

SEQUENCES = {"recipe_ingredients": "recipe_ingredients_id_seq", "shopping_list": "shopping_list_id_seq"}

TARGETS = {
    # forward copy: old project public.* -> wrapt yumlog.*
    "wrapt": {
        "project": "WRAPT",
        "schema": "yumlog",
        "staging_schema": "yumlog",          # exists already; table has no grants
        "create_staging_schema": False,
        "rebuild_trigger": "yumlog_rebuild_site",
        "source_schema": "public",
    },
    # rollback reverse sync: wrapt yumlog.* -> old project public.*
    "old": {
        "project": "OLD yumlog (nrmimftrjulvsgonrlzg)",
        "schema": "public",
        # Not `public`: the old project's default ACLs would hand a new public
        # table to anon, and PostgREST would expose it.
        "staging_schema": "yumlog_load",
        "create_staging_schema": True,
        "rebuild_trigger": "Rebuild Cloudflare on recipe change",   # row-level: 1 POST per row
        "source_schema": "yumlog",
    },
}

MAX_CHUNK_BYTES = 45_000   # keeps each paste well under ~50 KB


# ---------------------------------------------------------------------------
# SQL builders shared by `static` and `load`
# ---------------------------------------------------------------------------

def checksum_select(schema_expr: str, comment: str = "") -> str:
    """One SELECT: per-table row count + md5 of the canonical row text, then sequences.
    `schema_expr` is the VALUES entry of the params CTE (e.g. "'yumlog'::text")."""
    rows = []
    for i, tbl in enumerate(TABLE_ORDER, start=1):
        q = (f"select count(*) as n, md5(coalesce(string_agg({CANONICAL_ROW[tbl]}::text, chr(10) "
             f"order by {ORDER_BY[tbl]}), '')) as h from %I.{tbl} t")
        rows.append(f"    ({i}, '{tbl}', $q${q}$q$)")
    tables_values = ",\n".join(rows)
    return f"""with
params(s) as (values ({schema_expr})),{comment}
tables(ord, tbl, q) as (
  values
{tables_values}
),
counted as (
  select t.ord, t.tbl, query_to_xml(format(t.q, p.s), false, true, '') as x
  from tables t cross join params p
)
select c.ord, c.tbl as item,
       (xpath('/row/n/text()', c.x))[1]::text as row_count,
       (xpath('/row/h/text()', c.x))[1]::text as md5
from counted c
union all
select 10 + row_number() over (order by s.sequencename), 'sequence ' || s.sequencename,
       coalesce(s.last_value::text, '<never used>'), null
from pg_sequences s cross join params p
where s.schemaname = p.s
  and s.sequencename in ('recipe_ingredients_id_seq', 'shopping_list_id_seq')
union all
select 20, 'schema / database / TimeZone (info)',
       p.s || ' / ' || current_database() || ' / ' || current_setting('TimeZone'), null
from params p
order by 1;
"""


def export_select(schema: str) -> str:
    ctes = []
    for tbl in TABLE_ORDER:
        ctes.append(
            f"{tbl} as (\n  select coalesce(jsonb_agg(to_jsonb(t) order by {ORDER_BY[tbl]}), '[]'::jsonb)::text as j\n"
            f"  from {schema}.{tbl} t\n)")
    seq_parts = []
    for tbl, seq in SEQUENCES.items():
        seq_parts.append(
            f"    '{seq}', (select jsonb_build_object('last_value', s.last_value, 'is_called', s.is_called)\n"
            f"               from {schema}.{seq} s)")
    ctes.append(
        "meta as (\n  select jsonb_build_object(\n"
        f"    'source_schema', '{schema}',\n"
        "    'database', current_database(),\n"
        "    'exported_at', now(),\n"
        "    'timezone', current_setting('TimeZone'),\n"
        + ",\n".join(seq_parts) + "\n  )::text as j\n)")
    selects = []
    for i, tbl in enumerate(TABLE_ORDER, start=1):
        selects.append(f"select {i} as ord, '{tbl}' as tbl, jsonb_array_length(j::jsonb) as row_count, "
                       f"md5(j) as md5, j as json from {tbl}")
    selects.append("select 5, '_meta', null, md5(j), j from meta")
    return "with\n" + ",\n".join(ctes) + "\n" + "\nunion all\n".join(selects) + "\norder by ord;\n"


# ---------------------------------------------------------------------------
# static: dryrun.sql, checksum.sql, export_*.sql
# ---------------------------------------------------------------------------

DRYRUN_CHECKS = r"""
  -- ---------------------------------------------------------------------
  -- Catalogue checks on what the four files just built (still inside the
  -- same transaction). Any problem => DRY RUN FAILED; otherwise DRY RUN OK.
  -- Both are exceptions, so either way nothing is kept.
  -- ---------------------------------------------------------------------
  select count(*) into n from pg_class c
   where c.relnamespace = to_regnamespace('yumlog') and c.relkind = 'r';
  summary := summary || format('tables=%s ', n);
  if n <> 5 then problems := problems || format('expected 5 tables, got %s; ', n); end if;

  select count(*) into n from pg_policies where schemaname = 'yumlog';
  summary := summary || format('policies=%s ', n);
  if n <> 13 then problems := problems || format('expected 13 policies, got %s; ', n); end if;

  select count(*) into n from pg_proc where pronamespace = to_regnamespace('yumlog');
  summary := summary || format('functions=%s ', n);
  if n <> 5 then problems := problems || format('expected 5 functions, got %s; ', n); end if;

  select count(*) into n from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
   where c.relnamespace = to_regnamespace('yumlog') and not tg.tgisinternal;
  summary := summary || format('triggers=%s ', n);
  if n <> 2 then problems := problems || format('expected 2 triggers, got %s; ', n); end if;

  select count(*) into n from pg_index i join pg_class c on c.oid = i.indrelid
   where c.relnamespace = to_regnamespace('yumlog');
  summary := summary || format('indexes=%s ', n);
  if n <> 8 then problems := problems || format('expected 8 indexes (5 pkeys + 3 FK), got %s; ', n); end if;

  if not has_schema_privilege('anon', 'yumlog', 'USAGE') then problems := problems || 'anon lacks schema USAGE; '; end if;
  if has_schema_privilege('service_role', 'yumlog', 'USAGE') then problems := problems || 'service_role HAS schema USAGE; '; end if;
  if not has_table_privilege('anon', 'yumlog.recipes', 'SELECT') then problems := problems || 'anon cannot SELECT recipes; '; end if;
  if has_table_privilege('anon', 'yumlog.shopping_list', 'SELECT') then problems := problems || 'anon CAN SELECT shopping_list; '; end if;
  if has_table_privilege('anon', 'yumlog.recipes', 'INSERT') then problems := problems || 'anon CAN INSERT recipes; '; end if;
  if has_table_privilege('authenticated', 'yumlog.members', 'SELECT') then problems := problems || 'authenticated CAN SELECT members; '; end if;
  if not has_table_privilege('authenticated', 'yumlog.shopping_list', 'DELETE') then problems := problems || 'authenticated cannot DELETE shopping_list; '; end if;
  summary := summary || 'grants=checked ';

  select count(*) into n from pg_proc p
   where p.pronamespace = to_regnamespace('yumlog')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE')
          or has_function_privilege('service_role', p.oid, 'EXECUTE'));
  if n <> 0 then problems := problems || format('%s function(s) executable by anon/public/service_role; ', n); end if;
  select count(*) into n from pg_proc p
   where p.pronamespace = to_regnamespace('yumlog') and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  summary := summary || format('authenticated_exec=%s ', n);
  if n <> 3 then problems := problems || format('expected authenticated EXECUTE on 3 functions, got %s; ', n); end if;

  select string_agg(p.proname, ',' order by p.proname) into t from pg_proc p
   where p.pronamespace = to_regnamespace('yumlog') and p.prosecdef;
  summary := summary || format('definer=%s ', coalesce(t, '-'));
  if t is distinct from 'is_member,request_site_rebuild' then
    problems := problems || format('SECURITY DEFINER set should be is_member,request_site_rebuild, got %s; ', coalesce(t, '-'));
  end if;

  select count(*) into n from pg_proc p
   where p.pronamespace = to_regnamespace('yumlog')
     and coalesce(array_to_string(p.proconfig, ','), '') <> 'search_path=""';
  if n <> 0 then problems := problems || format('%s function(s) without search_path=""; ', n); end if;

  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'yumlog' and tablename = 'shopping_list') then
    summary := summary || 'realtime=yes ';
  else
    problems := problems || 'shopping_list not in supabase_realtime; ';
  end if;

  summary := summary || format('pg_net=%s', exists (select 1 from pg_extension where extname = 'pg_net'));

  if problems <> '' then
    raise exception 'DRY RUN FAILED (all rolled back): %', problems;
  end if;
  raise exception 'DRY RUN OK (all rolled back): %', summary;
"""


def build_dryrun() -> str:
    parts = []
    for num, name in [("001", "001_yumlog_schema.sql"), ("002", "002_yumlog_security.sql"),
                      ("003", "003_yumlog_rebuild_webhook.sql"), ("004", "004_yumlog_realtime.sql")]:
        body = (MIGRATIONS / name).read_text(encoding="utf-8")
        tag = f"$m{num}$"
        if tag in body:
            raise SystemExit(f"{name} contains the tag {tag}; pick another")
        parts.append(f"  -- ===== supabase/migrations/{name} (verbatim) =====\n"
                     f"  execute {tag}\n{body}\n{tag};\n")
    header = """-- =============================================================================
-- dryrun.sql  --  PLAN step 4.1: build everything in wrapt, check it, roll back
--
-- GENERATED by `python migration/stage3/loadgen.py static` from
-- supabase/migrations/001-004. Don't edit by hand; edit the migrations and
-- regenerate.
--
-- RUN IN:     wrapt's Supabase project -> SQL Editor -> paste all -> Run.
-- WHAT:       ONE `do` block: a clash check, then 001, 002, 003 and 004 verbatim
--             (each via EXECUTE), then catalogue checks. It always ends by
--             raising an exception, and a single statement is atomic, so
--             NOTHING persists — no schema, no grants, no publication change.
--             Does not need pg_net (003 no-ops without it).
-- EXPECTED:   an ERROR whose text starts
--               DRY RUN OK (all rolled back): tables=5 policies=13 functions=5 ...
--             "DRY RUN ABORTED" = schema yumlog already exists (nothing done).
--             "DRY RUN FAILED"  = a check failed; the text lists which.
--             Any other error   = a real problem in the migration SQL: copy the
--                                 message (and line number) back.
-- THEN:       run  select to_regnamespace('yumlog');   on its own. It must
--             return NULL (proves the rollback; PLAN Q1).
-- =============================================================================
do $dryrun$
declare
  problems text := '';
  summary  text := '';
  n        bigint;
  t        text;
begin
  if to_regnamespace('yumlog') is not null then
    raise exception 'DRY RUN ABORTED: schema yumlog already exists in this project, so a dry run can''t prove anything. Nothing was changed.';
  end if;

"""
    return header + "\n".join(parts) + DRYRUN_CHECKS + "end\n$dryrun$;\n"


def build_checksum_file() -> str:
    header = """-- =============================================================================
-- checksum.sql  --  PLAN steps 4.6 / 5.5: prove the copy is exact
--
-- GENERATED by `python migration/stage3/loadgen.py static`.
-- RUN IN:     BOTH projects, read-only. Edit ONE value first:
--               old yumlog project:  'public'
--               wrapt project:       'yumlog'   (as shipped)
-- OUTPUT:     one grid: per table the row count and an md5 over every column of
--             every row, in primary-key order (collation "C"), timestamps in UTC
--             — so neither database's TimeZone nor collation can cause a false
--             mismatch. Then the identity sequences' last_value.
-- MATCH:      row_count and md5 identical per table on both sides. Wrapt's
--             sequences must be >= the old project's (the load sets them to
--             greatest(max id, old last_value)).
-- =============================================================================
"""
    return header + checksum_select("'yumlog'::text", "   -- <== 'public' in the OLD project, 'yumlog' in wrapt")


def build_export_file(schema: str, which: str) -> str:
    if which == "old":
        header = """-- =============================================================================
-- export_from_old.sql  --  PLAN steps 4.6 / 5.2: copy the data out of the OLD project
--
-- GENERATED by `python migration/stage3/loadgen.py static`.
-- RUN IN:     the OLD yumlog project (ref nrmimftrjulvsgonrlzg). READ-ONLY.
-- OUTPUT:     one grid, 5 rows: ingredients, recipes, recipe_ingredients,
--             shopping_list (row_count, md5, json) and _meta (sequence
--             last_values, TimeZone, export time). The json cell is the whole
--             table as a JSON array; md5 is md5() of exactly that text.
-- SEND BACK:  Export -> CSV (the grid view truncates long cells; the CSV
--             doesn't). Claude runs `loadgen.py load <csv> --target wrapt`,
--             which first re-checks every md5 to catch a truncated CSV.
-- =============================================================================
"""
    else:
        header = """-- =============================================================================
-- export_from_wrapt.sql  --  ROLLBACK ONLY (PLAN R-B step 3): copy yumlog.* back out
--
-- GENERATED by `python migration/stage3/loadgen.py static`.
-- RUN IN:     wrapt's project. READ-ONLY. Same output shape as export_from_old.sql.
-- USE:        only if cutover is rolled back after writes landed in wrapt.
--             Export -> CSV, then `loadgen.py load <csv> --target old` builds
--             the reverse-sync chunks + swap for the OLD project.
-- =============================================================================
"""
    return header + export_select(schema)


def cmd_static(_args) -> None:
    outputs = {
        HERE / "dryrun.sql": build_dryrun(),
        HERE / "checksum.sql": build_checksum_file(),
        HERE / "export_from_old.sql": build_export_file("public", "old"),
        HERE / "export_from_wrapt.sql": build_export_file("yumlog", "wrapt"),
    }
    for path, text in outputs.items():
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {path.relative_to(REPO)} ({len(text.encode('utf-8')):,} bytes)")


# ---------------------------------------------------------------------------
# load: CSV -> chunk files + swap
# ---------------------------------------------------------------------------

class ExportError(Exception):
    pass


def read_export_csv(path: Path) -> dict:
    """Parse and verify an export CSV. Returns {table: {...}, '_meta': {...}}."""
    csv.field_size_limit(sys.maxsize if sys.maxsize < 2**31 else 2**31 - 1)
    with path.open(encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows or not {"tbl", "row_count", "md5", "json"} <= set(rows[0].keys()):
        raise ExportError(f"{path}: expected columns ord,tbl,row_count,md5,json; got {list(rows[0].keys()) if rows else 'no rows'}")

    by_tbl = {r["tbl"]: r for r in rows}
    missing = [t for t in TABLE_ORDER + ["_meta"] if t not in by_tbl]
    if missing:
        raise ExportError(f"export is missing rows for: {', '.join(missing)}")

    out = {}
    for tbl in TABLE_ORDER + ["_meta"]:
        r = by_tbl[tbl]
        text = r["json"]
        digest = hashlib.md5(text.encode("utf-8")).hexdigest()
        if digest != r["md5"].strip():
            raise ExportError(f"{tbl}: md5 of the JSON cell is {digest}, export says {r['md5']} — "
                              "the CSV cell was truncated or altered. Re-export.")
        data = json.loads(text)
        entry = {"json": text, "md5": digest, "data": data}
        if tbl != "_meta":
            expected_n = int(r["row_count"])
            if len(data) != expected_n:
                raise ExportError(f"{tbl}: JSON has {len(data)} rows, export says {expected_n}")
            for row in data:
                if sorted(row.keys()) != sorted(COLUMNS[tbl]):
                    raise ExportError(f"{tbl}: unexpected columns {sorted(row.keys())}")
            entry["row_count"] = expected_n
        out[tbl] = entry
    return out


def split_utf8(text: str, max_bytes: int) -> list[str]:
    """Split text into pieces of at most max_bytes UTF-8 bytes (never mid-character)."""
    pieces, current, size = [], [], 0
    for ch in text:
        b = len(ch.encode("utf-8"))
        if size + b > max_bytes and current:
            pieces.append("".join(current))
            current, size = [], 0
        current.append(ch)
        size += b
    if current or not pieces:
        pieces.append("".join(current))
    return pieces


def tag_is_safe(tag: str, pieces: list[str]) -> bool:
    # The literal ends at the FIRST occurrence of the tag, so the tag must not
    # occur in the data nor be formed by a piece's tail + the closing tag.
    return all((p + tag).find(tag) == len(p) for p in pieces)


def pick_tag(pieces: list[str]) -> str:
    for _ in range(100):
        tag = f"$yl_{secrets.token_hex(6)}$"
        if tag_is_safe(tag, pieces):
            return tag
    raise RuntimeError("could not find a safe dollar-quote tag")


def generate_load(export: dict, target: str, out_dir: Path, max_bytes: int = MAX_CHUNK_BYTES,
                  run_id: str | None = None, tag: str | None = None) -> dict:
    cfg = TARGETS[target]
    schema, stage_schema = cfg["schema"], cfg["staging_schema"]
    stage = f"{stage_schema}._load"
    run_id = run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    meta = export["_meta"]["data"]
    source_schema = meta.get("source_schema")
    if source_schema != cfg["source_schema"]:
        raise ExportError(f"target {target} expects an export of schema {cfg['source_schema']!r}, "
                          f"this CSV is from {source_schema!r}")

    # Slice every table's JSON text into paste-sized parts.
    table_parts = {tbl: split_utf8(export[tbl]["json"], max_bytes) for tbl in TABLE_ORDER}
    all_pieces = [p for parts in table_parts.values() for p in parts]
    tag = tag or pick_tag(all_pieces)
    if not tag_is_safe(tag, all_pieces):
        raise RuntimeError("dollar-quote tag occurs in the data")

    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    staging_ddl = ""
    if cfg["create_staging_schema"]:
        staging_ddl += (f"create schema if not exists {stage_schema};\n"
                        f"revoke all on schema {stage_schema} from public, anon, authenticated, service_role;\n")
    staging_ddl += (f"create table if not exists {stage} (\n"
                    "  run_id text not null,\n  tbl text not null,\n  part integer not null,\n"
                    "  body text not null,\n  primary key (run_id, tbl, part)\n);\n"
                    f"alter table {stage} enable row level security;\n"
                    f"revoke all on {stage} from public, anon, authenticated, service_role;\n"
                    f"-- Leftovers from an earlier run (e.g. the rehearsal) can't mix in.\n"
                    f"delete from {stage} where run_id <> '{run_id}';\n")

    n_chunks = sum(len(p) for p in table_parts.values())
    k = 0
    for tbl in TABLE_ORDER:
        for part_no, piece in enumerate(table_parts[tbl], start=1):
            k += 1
            body = (f"-- yumlog load, run {run_id}: chunk {k} of {n_chunks} — {tbl} part {part_no}/{len(table_parts[tbl])}\n"
                    f"-- RUN IN: {cfg['project']} project -> SQL Editor. Paste the whole file, Run.\n"
                    f"-- Order doesn't matter and re-running a chunk is harmless. Then run load_99_swap.sql.\n"
                    + staging_ddl +
                    f"insert into {stage} (run_id, tbl, part, body)\nvalues ('{run_id}', '{tbl}', {part_no}, {tag}{piece}{tag})\n"
                    "on conflict (run_id, tbl, part) do update set body = excluded.body;\n\n"
                    f"select tbl, count(*) as parts_loaded, sum(length(body)) as chars\n"
                    f"from {stage} where run_id = '{run_id}' group by tbl order by tbl;\n")
            path = out_dir / f"load_{k:02d}_chunk.sql"
            path.write_text(body, encoding="utf-8", newline="\n")
            files.append(path)

    # --- swap -------------------------------------------------------------
    trig = cfg["rebuild_trigger"]
    trig_lit = trig.replace("'", "''")
    verify, loads, seqs, counts = [], [], [], []
    for tbl in TABLE_ORDER:
        e = export[tbl]
        verify.append(
            f"  select count(*), string_agg(body, '' order by part) into n, j from {stage}\n"
            f"   where run_id = '{run_id}' and tbl = '{tbl}';\n"
            f"  if n is distinct from {len(table_parts[tbl])} or md5(coalesce(j, '')) <> '{e['md5']}' then\n"
            f"    raise exception '{tbl}: expected {len(table_parts[tbl])} part(s) with md5 {e['md5']}, found % part(s) with md5 % — paste the missing chunk(s) and re-run', n, md5(coalesce(j, ''));\n"
            f"  end if;\n"
            f"  if jsonb_array_length(j::jsonb) <> {e['row_count']} then\n"
            f"    raise exception '{tbl}: expected {e['row_count']} rows in the JSON, found %', jsonb_array_length(j::jsonb);\n"
            f"  end if;\n"
            f"  j_{tbl} := j::jsonb;\n")
        overriding = " overriding system value" if tbl in SEQUENCES else ""
        loads.append(f"  insert into {schema}.{tbl}{overriding}\n"
                     f"  select * from jsonb_populate_recordset(null::{schema}.{tbl}, j_{tbl});\n"
                     f"  get diagnostics n = row_count;\n"
                     f"  if n <> {e['row_count']} then raise exception '{tbl}: inserted % rows, expected {e['row_count']}', n; end if;\n")
    for tbl, seq in SEQUENCES.items():
        info = meta.get(seq) or {}
        old_last = int(info.get("last_value") or 0)
        seqs.append(f"  perform setval(pg_get_serial_sequence('{schema}.{tbl}', 'id'),\n"
                    f"                 greatest((select coalesce(max(id), 0) from {schema}.{tbl}), {old_last}, 1), true);\n")
    drop_stage = f"  drop schema {stage_schema} cascade;\n" if cfg["create_staging_schema"] else f"  drop table {stage};\n"
    counts_sql = checksum_select(f"'{schema}'::text", "   -- same as checksum.sql")

    decls = "\n".join(f"  j_{tbl} jsonb;" for tbl in TABLE_ORDER)
    swap = f"""-- =============================================================================
-- yumlog load, run {run_id}: SWAP (truncate-and-reload), target {target}
--
-- RUN IN:     {cfg['project']} project -> SQL Editor, AFTER all {n_chunks} chunk files.
-- WHAT:       one `do` block = one transaction: re-checks every table's md5 in the
--             database, disables the rebuild trigger "{trig}", truncates the
--             four {schema}.* tables, reloads them keeping ids (overriding system
--             value), sets the identity sequences to greatest(max id, source
--             last_value), re-enables the trigger, drops the staging data.
--             Any error = nothing changed; fix and re-run. Re-running after success
--             fails harmlessly (staging is gone) — regenerate to load again.
--             The shopping_list BEFORE UPDATE trigger doesn't fire on INSERT, so
--             updated_at values are kept as exported.
-- SOURCE:     {cfg['source_schema']}.* exported {meta.get('exported_at')} (TimeZone {meta.get('timezone')})
-- EXPECTED:   the final grid = the source's checksum.sql grid (counts, md5s).
-- =============================================================================
do $swap$
declare
  n bigint;
  j text;
  trigger_was_enabled boolean;
{decls}
begin
  if to_regclass('{stage}') is null then
    raise exception 'staging table {stage} not found — paste the chunk files first';
  end if;

  -- 1. Every chunk present and intact?
{"".join(verify)}
  -- 2. Rebuild trigger off for the load (row-level in the old project = 1 POST per row).
  select tg.tgenabled <> 'D' into trigger_was_enabled
  from pg_trigger tg
  where tg.tgrelid = '{schema}.recipes'::regclass and tg.tgname = '{trig_lit}';
  if trigger_was_enabled then
    execute format('alter table {schema}.recipes disable trigger %I', '{trig_lit}');
  end if;

  -- 3. Truncate-and-reload in FK order.
  truncate {schema}.recipe_ingredients, {schema}.shopping_list, {schema}.recipes, {schema}.ingredients;
{"".join(loads)}
  -- 4. Identity sequences: never hand out an id the source already used.
{"".join(seqs)}
  -- 5. Trigger back on (only if it was on), staging gone.
  if trigger_was_enabled then
    execute format('alter table {schema}.recipes enable trigger %I', '{trig_lit}');
  end if;
{drop_stage}end
$swap$;

-- Result grid (same query as checksum.sql, schema {schema}):
{counts_sql}"""
    swap_path = out_dir / "load_99_swap.sql"
    swap_path.write_text(swap, encoding="utf-8", newline="\n")
    files.append(swap_path)

    manifest = {
        "run_id": run_id, "target": target, "tag": tag, "chunks": n_chunks,
        "tables": {t: {"rows": export[t]["row_count"], "md5": export[t]["md5"],
                       "parts": len(table_parts[t])} for t in TABLE_ORDER},
        "sequences_from_source": {s: meta.get(s) for s in SEQUENCES.values()},
        "source": {k2: meta.get(k2) for k2 in ("source_schema", "database", "exported_at", "timezone")},
        "files": [f.name for f in files],
        "largest_file_bytes": max(f.stat().st_size for f in files),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def cmd_load(args) -> None:
    export = read_export_csv(Path(args.csv))
    for tbl in TABLE_ORDER:
        print(f"  {tbl:<20} rows={export[tbl]['row_count']:>5}  md5={export[tbl]['md5']}  OK")
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    out_dir = Path(args.out) if args.out else HERE / "out" / f"{args.target}-{run_id}"
    manifest = generate_load(export, args.target, out_dir, run_id=run_id)
    print(f"wrote {len(manifest['files'])} files to {out_dir} "
          f"(largest {manifest['largest_file_bytes']:,} bytes, {manifest['chunks']} chunks + swap)")


# ---------------------------------------------------------------------------
# selftest: no database — proves CSV parsing, md5 check, chunking, quoting
# ---------------------------------------------------------------------------

def jsonb_text(value) -> str:
    """Approximate Postgres jsonb::text layout (', ' and ': ' separators)."""
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def fake_export_csv(path: Path, tables: dict, meta: dict) -> None:
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["ord", "tbl", "row_count", "md5", "json"])
        for i, tbl in enumerate(TABLE_ORDER, start=1):
            text = jsonb_text(tables[tbl])
            w.writerow([i, tbl, len(tables[tbl]), hashlib.md5(text.encode("utf-8")).hexdigest(), text])
        text = jsonb_text(meta)
        w.writerow([5, "_meta", "", hashlib.md5(text.encode("utf-8")).hexdigest(), text])


def parse_chunks(out_dir: Path) -> dict:
    """Re-read generated chunk files the way Postgres would lex them."""
    got: dict[str, dict[int, str]] = {}
    pat = re.compile(r"values \('([^']+)', '([a-z_]+)', (\d+), (\$yl_[0-9a-f]+\$)(.*?)\4\)", re.S)
    for f in sorted(out_dir.glob("load_*_chunk.sql")):
        text = f.read_text(encoding="utf-8")
        m = pat.search(text)
        assert m, f"no insert found in {f.name}"
        got.setdefault(m.group(2), {})[int(m.group(3))] = m.group(5)
    return {t: "".join(parts[i] for i in sorted(parts)) for t, parts in got.items()}


def cmd_selftest(_args) -> None:
    backups = REPO / "backups"
    tables = {t: json.loads((backups / f"{t}.json").read_text(encoding="utf-8"))
              for t in ("ingredients", "recipes", "recipe_ingredients")}
    nasty = "O'Brien's \"quote\" back\\slash $$ $yl_ $yl_deadbeef$ tab\t nl\n emoji 🍞 é ü 中文"
    tables["ingredients"].append({"name": "__selftest__ " + nasty, "category": None})
    tables["shopping_list"] = [
        {"id": 5, "ingredient": "salt", "quantity": 1.5, "unit": "g", "checked": False, "position": 1,
         "added_at": "2026-07-30T07:46:56.037204+00:00", "updated_at": "2026-07-30T07:46:56.037204+00:00"},
        {"id": 97, "ingredient": "__selftest__ " + nasty, "quantity": None, "unit": nasty, "checked": True,
         "position": None, "added_at": None, "updated_at": "2026-07-30T07:46:56+00:00"},
    ]
    meta = {"source_schema": "public", "database": "postgres", "exported_at": "2026-09-28T10:00:00+00:00",
            "timezone": "UTC",
            "recipe_ingredients_id_seq": {"last_value": 1844, "is_called": True},
            "shopping_list_id_seq": {"last_value": 97, "is_called": True}}

    failures = 0

    def check(label, cond):
        nonlocal failures
        print(f"  {'PASS' if cond else 'FAIL'}  {label}")
        failures += 0 if cond else 1

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        csv_path = tmp / "export.csv"
        fake_export_csv(csv_path, tables, meta)
        export = read_export_csv(csv_path)
        check("CSV parses and every md5 verifies", True)

        for max_bytes, label in [(MAX_CHUNK_BYTES, "default chunk size"), (3_000, "tiny chunks (many parts)")]:
            out = tmp / f"out-{max_bytes}"
            manifest = generate_load(export, "wrapt", out, max_bytes=max_bytes, run_id="selftest")
            back = parse_chunks(out)
            for tbl in TABLE_ORDER:
                ok = back.get(tbl) == export[tbl]["json"] and \
                    hashlib.md5(back[tbl].encode("utf-8")).hexdigest() == export[tbl]["md5"]
                check(f"{label}: {tbl} reassembles byte-identical ({manifest['tables'][tbl]['parts']} part(s))", ok)
            sizes = [(out / f).stat().st_size for f in manifest["files"] if f.endswith("_chunk.sql")]
            check(f"{label}: every chunk file <= 50 KB (max {max(sizes):,})", max(sizes) <= 50_000)
            swap = (out / "load_99_swap.sql").read_text(encoding="utf-8")
            check(f"{label}: swap embeds each table's md5",
                  all(export[t]["md5"] in swap for t in TABLE_ORDER))
            check(f"{label}: swap keeps ids (overriding system value x2) and sets sequences from 1844/97",
                  swap.count("overriding system value") == 2 and ", 1844, 1)" in swap and ", 97, 1)" in swap)
            check(f"{label}: dollar tags balanced in swap",
                  swap.count("$swap$") == 2 and swap.count("$q$") % 2 == 0)

        # A tag that appears in the data must be rejected.
        pieces = split_utf8(export["ingredients"]["json"], MAX_CHUNK_BYTES)
        check("tag present in data is rejected", not tag_is_safe("$yl_deadbeef$", pieces))
        check("tag formed at a piece boundary is rejected", not tag_is_safe("$yl_ab$", ["x$yl_ab"]))

        # Truncated CSV cell must be caught.
        bad = tmp / "truncated.csv"
        text = csv_path.read_text(encoding="utf-8")
        rj = jsonb_text(tables["recipes"])
        bad.write_text(text.replace(rj.replace('"', '""'), rj[:-500].replace('"', '""') + "]"), encoding="utf-8")
        try:
            read_export_csv(bad)
            check("truncated CSV is rejected", False)
        except ExportError as err:
            check(f"truncated CSV is rejected ({str(err)[:60]}...)", True)

        # Reverse direction refuses an export from the wrong side.
        try:
            generate_load(export, "old", tmp / "rev", run_id="selftest")
            check("target old refuses a public.* export", False)
        except ExportError:
            check("target old refuses a public.* export", True)
        meta_rev = dict(meta, source_schema="yumlog")
        fake_export_csv(tmp / "rev.csv", tables, meta_rev)
        m = generate_load(read_export_csv(tmp / "rev.csv"), "old", tmp / "rev", run_id="selftest")
        swap = (tmp / "rev" / "load_99_swap.sql").read_text(encoding="utf-8")
        check("reverse sync: stages in yumlog_load, targets public.*, disables the old row trigger",
              "yumlog_load._load" in swap and "truncate public.recipe_ingredients" in swap
              and "Rebuild Cloudflare on recipe change" in swap and "drop schema yumlog_load cascade" in swap)
        check("reverse sync: chunks reassemble", parse_chunks(tmp / "rev") ==
              {t: read_export_csv(tmp / "rev.csv")[t]["json"] for t in TABLE_ORDER})

    # The committed static files must match what `static` would write now.
    for name, text in [("dryrun.sql", build_dryrun()), ("checksum.sql", build_checksum_file()),
                       ("export_from_old.sql", build_export_file("public", "old")),
                       ("export_from_wrapt.sql", build_export_file("yumlog", "wrapt"))]:
        p = HERE / name
        check(f"{name} is up to date", p.exists() and p.read_text(encoding="utf-8") == text)

    print("\nselftest:", "ALL PASS" if failures == 0 else f"{failures} FAILURE(S)")
    sys.exit(1 if failures else 0)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("static", help="regenerate dryrun/checksum/export SQL").set_defaults(fn=cmd_static)
    p = sub.add_parser("load", help="export CSV -> chunk + swap SQL")
    p.add_argument("csv")
    p.add_argument("--target", choices=sorted(TARGETS), required=True)
    p.add_argument("--out", help="output directory (default migration/stage3/out/<target>-<run>)")
    p.set_defaults(fn=cmd_load)
    sub.add_parser("selftest", help="offline round-trip test").set_defaults(fn=cmd_selftest)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
