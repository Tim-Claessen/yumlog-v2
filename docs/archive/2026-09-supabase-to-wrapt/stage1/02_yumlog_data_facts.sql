-- =============================================================================
-- 02_yumlog_data_facts.sql  --  Stage 1 recon, data volumes + auth users
--
-- RUN IN:    the YUMLOG Supabase project (ref nrmimftrjulvsgonrlzg)
--            Dashboard -> SQL Editor -> New query -> paste all -> Run
-- READ-ONLY: SELECTs only (row counts run via query_to_xml, which executes a
--            read-only "select count(*)" per table). No DDL, no DML, no SET.
-- OUTPUT:    ONE statement -> ONE result grid (section, name, detail).
-- PRIVACY:   auth.users is read for id/email/timestamps/provider only.
--            NO password hashes, tokens or metadata blobs are output
--            ("has_password" is a true/false flag, not the hash).
-- =============================================================================
with
known(tbl) as (
  values ('recipes'), ('ingredients'), ('recipe_ingredients'), ('shopping_list')
),
pub_tables as (
  select c.oid, c.relname, c.reltuples
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p')
),
report(section, ord, name, detail) as (
  -- 00 meta ------------------------------------------------------------------
  select '00_meta'::text, 1, 'database'::text, current_database()::text
  union all
  select '00_meta', 2, 'db_size',
         pg_size_pretty(pg_database_size(current_database())) || ' ('
         || pg_database_size(current_database())::text || ' bytes)'
  union all
  select '00_meta', 3, 'run_at', now()::text

  -- 01 exact row counts for the four yumlog tables (guarded if absent) --------
  union all
  select '01_exact_count', 0, 'public.' || k.tbl,
         case when to_regclass('public.' || quote_ident(k.tbl)) is null then 'TABLE ABSENT'
              else (xpath('/row/c/text()',
                          query_to_xml(format('select count(*) as c from public.%I', k.tbl),
                                       false, true, '')))[1]::text
         end
  from known k

  -- 02 estimated counts for every OTHER public table -------------------------
  union all
  select '02_estimated_count', 0, 'public.' || p.relname::text,
         'reltuples=' || p.reltuples::bigint::text || ' (-1 = never analysed)'
  from pub_tables p
  where p.relname not in (select k.tbl from known k)

  -- 03 per-table total size (table + indexes + toast), largest first ----------
  union all
  select '03_table_size',
         (row_number() over (order by pg_total_relation_size(p.oid) desc))::int,
         'public.' || p.relname::text,
         pg_size_pretty(pg_total_relation_size(p.oid)) || ' ('
         || pg_total_relation_size(p.oid)::text || ' bytes)'
  from pub_tables p

  -- 04 freshness / id facts (guarded: table or column may be absent) ----------
  union all
  select '04_fact', 1, 'recipes max(updated_at)',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.recipes')
                             and attname = 'updated_at' and not attisdropped)
              then coalesce((xpath('/row/m/text()',
                     query_to_xml('select max(updated_at)::text as m from public.recipes',
                                  false, true, '')))[1]::text, '<null>')
              else 'COLUMN OR TABLE ABSENT' end
  union all
  select '04_fact', 2, 'recipes max(created_at)',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.recipes')
                             and attname = 'created_at' and not attisdropped)
              then coalesce((xpath('/row/m/text()',
                     query_to_xml('select max(created_at)::text as m from public.recipes',
                                  false, true, '')))[1]::text, '<null>')
              else 'COLUMN OR TABLE ABSENT' end
  union all
  select '04_fact', 3, 'shopping_list max(updated_at)',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.shopping_list')
                             and attname = 'updated_at' and not attisdropped)
              then coalesce((xpath('/row/m/text()',
                     query_to_xml('select max(updated_at)::text as m from public.shopping_list',
                                  false, true, '')))[1]::text, '<null / empty list>')
              else 'COLUMN OR TABLE ABSENT' end
  union all
  select '04_fact', 4, 'recipe_ingredients max(id)',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.recipe_ingredients')
                             and attname = 'id' and not attisdropped)
              then coalesce((xpath('/row/m/text()',
                     query_to_xml('select max(id)::text as m from public.recipe_ingredients',
                                  false, true, '')))[1]::text, '<null>')
              else 'COLUMN OR TABLE ABSENT' end
  union all
  select '04_fact', 5, 'shopping_list max(id)',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.shopping_list')
                             and attname = 'id' and not attisdropped)
              then coalesce((xpath('/row/m/text()',
                     query_to_xml('select max(id)::text as m from public.shopping_list',
                                  false, true, '')))[1]::text, '<null / empty list>')
              else 'COLUMN OR TABLE ABSENT' end
  union all
  select '04_fact', 6, 'ingredients with NULL category',
         case when exists (select 1 from pg_attribute
                           where attrelid = to_regclass('public.ingredients')
                             and attname = 'category' and not attisdropped)
              then (xpath('/row/m/text()',
                     query_to_xml('select count(*)::text as m from public.ingredients where category is null',
                                  false, true, '')))[1]::text
              else 'COLUMN OR TABLE ABSENT' end

  -- 05 sequences in public ----------------------------------------------------
  union all
  select '05_sequence', 0, s.schemaname || '.' || s.sequencename::text,
         'last_value=' || coalesce(s.last_value::text, '<never used or no privilege>')
  from pg_sequences s
  where s.schemaname = 'public'

  -- 06 auth users (no secrets) ------------------------------------------------
  union all
  select '06_auth_user', 0, '(total auth.users rows)', count(*)::text
  from auth.users
  union all
  select '06_auth_user',
         (row_number() over (order by u.created_at))::int,
         coalesce(u.email::text, '<no email>'),
         'id=' || u.id::text
         || ' created_at=' || coalesce(u.created_at::text, '<null>')
         || ' last_sign_in_at=' || coalesce(u.last_sign_in_at::text, '<null>')
         || ' email_confirmed_at=' || coalesce(u.email_confirmed_at::text, '<null>')
         || ' provider=' || coalesce(u.raw_app_meta_data ->> 'provider', '<null>')
         || ' providers=' || coalesce((u.raw_app_meta_data -> 'providers')::text, '<null>')
         || ' has_password=' || (coalesce(u.encrypted_password, '') <> '')::text
         || ' role=' || coalesce(u.role::text, '<null>')
         -- optional GoTrue columns read via to_jsonb so older schemas don't error:
         || ' is_anonymous=' || coalesce(to_jsonb(u) ->> 'is_anonymous', '<n/a>')
         || ' banned_until=' || coalesce(to_jsonb(u) ->> 'banned_until', '<null/n/a>')
         || ' deleted_at=' || coalesce(to_jsonb(u) ->> 'deleted_at', '<null/n/a>')
         || ' identities=' || (select count(*) from auth.identities i where i.user_id = u.id)::text
         || ' identity_providers=' || coalesce((select string_agg(i.provider, ',' order by i.provider)
                                                 from auth.identities i where i.user_id = u.id), '<none>')
  from auth.users u
)
select section, name, detail
from report
order by section, ord, name;
