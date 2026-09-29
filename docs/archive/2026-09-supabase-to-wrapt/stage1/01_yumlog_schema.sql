-- =============================================================================
-- 01_yumlog_schema.sql  --  Stage 1 recon, schema snapshot
--
-- RUN IN:    the YUMLOG Supabase project (ref nrmimftrjulvsgonrlzg)
--            Dashboard -> SQL Editor -> New query -> paste all -> Run
-- READ-ONLY: SELECTs against system catalogs only. No DDL, no DML, no SET.
-- OUTPUT:    ONE statement -> ONE result grid with columns (section, name, detail).
--            Copy the whole grid back (Export -> CSV, or select all + copy).
-- REDACTION: URLs inside trigger definitions (e.g. the recipes -> Cloudflare
--            deploy-hook webhook) are cut to scheme+host; Bearer tokens redacted.
-- =============================================================================
with
managed(nspname) as (
  values ('pg_catalog'), ('information_schema'), ('auth'), ('storage'), ('realtime'),
         ('_realtime'), ('graphql'), ('graphql_public'), ('vault'), ('pgsodium'),
         ('pgsodium_masks'), ('extensions'), ('supabase_functions'), ('supabase_migrations'),
         ('net'), ('cron'), ('pgbouncer'), ('_analytics'), ('pgtle'), ('topology'),
         ('tiger'), ('tiger_data')
),
ns as (   -- user schemas (public + anything custom)
  select n.oid, n.nspname
  from pg_namespace n
  where n.nspname not in (select m.nspname from managed m)
    and n.nspname not like 'pg\_toast%'
    and n.nspname not like 'pg\_temp%'
),
ext_obj as (   -- objects owned by extensions (excluded from listings)
  select d.classid, d.objid from pg_depend d where d.deptype = 'e'
),
tbl as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
         c.reltuples, c.relacl, c.relowner
  from pg_class c
  join ns n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'f')
    and not exists (select 1 from ext_obj e where e.classid = 'pg_class'::regclass and e.objid = c.oid)
),
fn as (
  select p.oid, n.nspname, p.proname, p.prokind, p.prosecdef, p.provolatile, p.proconfig, p.proacl
  from pg_proc p
  join ns n on n.oid = p.pronamespace
  where p.prokind in ('f', 'p', 'w')
    and not exists (select 1 from ext_obj e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
),
report(section, ord, name, detail) as (
  -- 00 meta ------------------------------------------------------------------
  select '00_meta'::text, 1, 'server'::text, version()::text
  union all
  select '00_meta', 2, 'database', current_database()::text
  union all
  select '00_meta', 3, 'db_size',
         pg_size_pretty(pg_database_size(current_database())) || ' (' ||
         pg_database_size(current_database())::text || ' bytes)'
  union all
  select '00_meta', 4, 'run_at', now()::text

  -- 01 schemas (all, incl. Supabase-managed) ---------------------------------
  union all
  select '01_schema', 0, n.nspname::text,
         'owner=' || pg_get_userbyid(n.nspowner)::text
         || ' managed=' || (n.nspname in (select m.nspname from managed m))::text
         || ' relations=' || (select count(*) from pg_class c where c.relnamespace = n.oid)::text
         || ' functions=' || (select count(*) from pg_proc p where p.pronamespace = n.oid)::text
  from pg_namespace n
  where n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'

  -- 02 tables ----------------------------------------------------------------
  union all
  select '02_table', 0, t.nspname || '.' || t.relname,
         'relkind=' || t.relkind::text
         || ' rls_enabled=' || t.relrowsecurity::text
         || ' rls_forced=' || t.relforcerowsecurity::text
         || ' est_rows=' || t.reltuples::bigint::text
         || ' total_size=' || pg_size_pretty(pg_total_relation_size(t.oid))
         || ' owner=' || pg_get_userbyid(t.relowner)::text
  from tbl t

  -- 03 columns ---------------------------------------------------------------
  union all
  select '03_column', 0,
         t.nspname || '.' || t.relname || ' #' || lpad(a.attnum::text, 2, '0') || ' ' || a.attname::text,
         format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' NOT NULL' else ' NULL' end
         || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
         || case a.attidentity when 'a' then ' IDENTITY ALWAYS'
                               when 'd' then ' IDENTITY BY DEFAULT' else '' end
         || case when a.attgenerated = 's' then ' GENERATED STORED' else '' end
         || coalesce(' COLUMN_ACL=' || a.attacl::text, '')
  from tbl t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum

  -- 04 constraints -----------------------------------------------------------
  union all
  select '04_constraint', 0, t.nspname || '.' || t.relname || '.' || co.conname::text,
         'type=' || co.contype::text || ' ' || pg_get_constraintdef(co.oid, true)
  from tbl t
  join pg_constraint co on co.conrelid = t.oid

  -- 05 indexes ---------------------------------------------------------------
  union all
  select '05_index', 0, t.nspname || '.' || t.relname || '.' || ic.relname::text,
         pg_get_indexdef(i.indexrelid)
  from tbl t
  join pg_index i on i.indrelid = t.oid
  join pg_class ic on ic.oid = i.indexrelid

  -- 06 RLS policies ----------------------------------------------------------
  union all
  select '06_policy', 0, pol.schemaname || '.' || pol.tablename || '.' || pol.policyname::text,
         'permissive=' || pol.permissive::text
         || ' roles=' || pol.roles::text
         || ' cmd=' || pol.cmd::text
         || ' using=' || coalesce(pol.qual, '<none>')
         || ' with_check=' || coalesce(pol.with_check, '<none>')
  from pg_policies pol
  where pol.schemaname in (select nspname from ns)

  -- 07 functions (full definition) -------------------------------------------
  union all
  select '07_function', 0,
         f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         'security_definer=' || f.prosecdef::text
         || ' volatility=' || f.provolatile::text
         || ' config=' || coalesce(array_to_string(f.proconfig, ','), '<none>')
         || ' acl=' || coalesce(f.proacl::text, '<NULL = default: PUBLIC has EXECUTE>')
         || E'\n' || pg_get_functiondef(f.oid)
  from fn f

  -- 08 who can EXECUTE each function (L1) ------------------------------------
  union all
  select '08_function_execute', 0,
         f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         'security_definer=' || f.prosecdef::text
         || ' PUBLIC=' || (f.proacl is null
                           or exists (select 1 from aclexplode(f.proacl) x
                                      where x.grantee = 0 and x.privilege_type = 'EXECUTE'))::text
         || ' anon=' || case when to_regrole('anon') is null then 'n/a'
                             else has_function_privilege(to_regrole('anon'), f.oid, 'EXECUTE')::text end
         || ' authenticated=' || case when to_regrole('authenticated') is null then 'n/a'
                             else has_function_privilege(to_regrole('authenticated'), f.oid, 'EXECUTE')::text end
         || ' service_role=' || case when to_regrole('service_role') is null then 'n/a'
                             else has_function_privilege(to_regrole('service_role'), f.oid, 'EXECUTE')::text end
  from fn f

  -- 09 triggers on user-schema tables (webhook URLs truncated) ---------------
  union all
  select '09_trigger', 0, t.nspname || '.' || t.relname || '.' || tg.tgname::text,
         'enabled=' || tg.tgenabled::text
         || ' function=' || tg.tgfoid::regprocedure::text || ' :: '
         || regexp_replace(
              regexp_replace(pg_get_triggerdef(tg.oid, true),
                             '(https?://[^/''" ]+)[^''" ]*', '\1/<path-redacted>', 'g'),
              '(Bearer\s+)[^''" ]+', '\1<redacted>', 'gi')
  from tbl t
  join pg_trigger tg on tg.tgrelid = t.oid and not tg.tgisinternal

  -- 10 triggers on auth.users (anything firing on sign-up) --------------------
  union all
  select '10_auth_users_trigger', 0, tg.tgname::text,
         'enabled=' || tg.tgenabled::text
         || ' function=' || tg.tgfoid::regprocedure::text || ' :: '
         || pg_get_triggerdef(tg.oid, true)
  from pg_trigger tg
  where tg.tgrelid = to_regclass('auth.users') and not tg.tgisinternal

  -- 11 types (enum / domain / standalone composite / range) -------------------
  union all
  select '11_type', 0, n.nspname || '.' || ty.typname::text,
         'typtype=' || ty.typtype::text
         || coalesce(' labels=' || (select string_agg(e.enumlabel::text, ',' order by e.enumsortorder)
                                     from pg_enum e where e.enumtypid = ty.oid), '')
         || case when ty.typtype = 'd' then ' base=' || format_type(ty.typbasetype, ty.typtypmod) else '' end
  from pg_type ty
  join ns n on n.oid = ty.typnamespace
  where (ty.typtype in ('e', 'd', 'r')
         or (ty.typtype = 'c' and exists (select 1 from pg_class c2
                                           where c2.oid = ty.typrelid and c2.relkind = 'c')))
    and not exists (select 1 from ext_obj e where e.classid = 'pg_type'::regclass and e.objid = ty.oid)

  -- 12 views / materialized views --------------------------------------------
  union all
  select '12_view', 0, n.nspname || '.' || c.relname::text,
         'relkind=' || c.relkind::text || ' :: ' || pg_get_viewdef(c.oid, true)
  from pg_class c
  join ns n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm')
    and not exists (select 1 from ext_obj e where e.classid = 'pg_class'::regclass and e.objid = c.oid)

  -- 13 sequences (last_value matters for identity columns on copy) ------------
  union all
  select '13_sequence', 0, s.schemaname || '.' || s.sequencename::text,
         'type=' || s.data_type::text
         || ' last_value=' || coalesce(s.last_value::text, '<never used or no privilege>')
         || ' owned_by=' || coalesce((
              select dc.relname || '.' || da.attname
              from pg_depend d
              join pg_class dc on dc.oid = d.refobjid
              join pg_attribute da on da.attrelid = d.refobjid and da.attnum = d.refobjsubid
              where d.classid = 'pg_class'::regclass
                and d.objid = to_regclass(quote_ident(s.schemaname) || '.' || quote_ident(s.sequencename))
                and d.deptype in ('a', 'i')
              limit 1), '<none>')
  from pg_sequences s
  where s.schemaname in (select nspname from ns)

  -- 14 table privileges per grantee (from relacl; NULL acl = owner defaults) --
  union all
  select '14_table_grant', 0,
         t.nspname || '.' || t.relname || ' -> '
           || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee)::text end,
         string_agg(g.privilege_type, ',' order by g.privilege_type)
  from tbl t
  cross join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) g
  group by t.nspname, t.relname, g.grantee

  -- 15 publications (supabase_realtime etc.) ----------------------------------
  union all
  select '15_publication', 0, p.pubname::text,
         'all_tables=' || p.puballtables::text
         || ' insert=' || p.pubinsert::text || ' update=' || p.pubupdate::text
         || ' delete=' || p.pubdelete::text
  from pg_publication p
  union all
  select '15_publication', 1, pt.pubname || ' : ' || pt.schemaname || '.' || pt.tablename::text,
         'member'
  from pg_publication_tables pt

  -- 16 extensions -------------------------------------------------------------
  union all
  select '16_extension', 0, e.extname::text,
         'version=' || e.extversion::text || ' schema=' || e.extnamespace::regnamespace::text
  from pg_extension e

  -- 17 columns that could hold user ids (uuid type, or default mentions auth.)
  union all
  select '17_user_id_candidate', 0, t.nspname || '.' || t.relname || '.' || a.attname::text,
         format_type(a.atttypid, a.atttypmod)
         || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
  from tbl t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where a.atttypid = 'uuid'::regtype
     or coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') ilike '%auth.%'
  union all
  select '17_user_id_candidate', 1, 'policies referencing auth.* functions',
         coalesce(string_agg(pol.tablename || '.' || pol.policyname, ', '), '<none>')
  from pg_policies pol
  where pol.schemaname in (select nspname from ns)
    and (coalesce(pol.qual, '') ilike '%auth.%' or coalesce(pol.with_check, '') ilike '%auth.%')

  -- 18 API roles ----------------------------------------------------------------
  union all
  select '18_role', 0, r.rolname::text,
         'bypassrls=' || r.rolbypassrls::text || ' superuser=' || r.rolsuper::text
         || ' login=' || r.rolcanlogin::text || ' inherit=' || r.rolinherit::text
  from pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres')

  -- 19 default privileges (global + schema public) ----------------------------
  union all
  select '19_default_acl', 0,
         pg_get_userbyid(d.defaclrole)::text || ' in '
           || case when d.defaclnamespace = 0 then '<all schemas>'
                   else d.defaclnamespace::regnamespace::text end
           || ' objtype=' || d.defaclobjtype::text,
         d.defaclacl::text
  from pg_default_acl d
  where d.defaclnamespace = 0 or d.defaclnamespace = to_regnamespace('public')

  -- 20 explicit checks ----------------------------------------------------------
  union all
  select '20_check', 1, 'supabase_realtime publication exists',
         exists (select 1 from pg_publication where pubname = 'supabase_realtime')::text
  union all
  select '20_check', 2, 'public.shopping_list in supabase_realtime (L5)',
         exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public'
                   and tablename = 'shopping_list')::text
  union all
  select '20_check', 3, 'shopping_list.updated_at column exists',
         exists (select 1 from pg_attribute
                 where attrelid = to_regclass('public.shopping_list')
                   and attname = 'updated_at' and not attisdropped)::text
  union all
  select '20_check', 4, 'recipes.updated_at column exists',
         exists (select 1 from pg_attribute
                 where attrelid = to_regclass('public.recipes')
                   and attname = 'updated_at' and not attisdropped)::text
  union all
  select '20_check', 5, 'supabase_functions schema exists (Database Webhooks enabled)',
         (to_regnamespace('supabase_functions') is not null)::text
  union all
  select '20_check', 6, 'pg_net installed',
         exists (select 1 from pg_extension where extname = 'pg_net')::text
  union all
  select '20_check', 7, 'pg_cron installed',
         exists (select 1 from pg_extension where extname = 'pg_cron')::text
)
select section, name, detail
from report
order by section, ord, name;
