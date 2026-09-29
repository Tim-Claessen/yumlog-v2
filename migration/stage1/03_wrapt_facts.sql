-- =============================================================================
-- 03_wrapt_facts.sql  --  Stage 1 recon, target-project snapshot
--
-- RUN IN:    the WRAPT Supabase project (NOT yumlog)
--            Dashboard -> SQL Editor -> New query -> paste all -> Run
-- READ-ONLY: SELECTs against system catalogs + auth.users only. cron.job is
--            read via query_to_xml only if the cron schema exists. No DDL,
--            no DML, no SET.
-- OUTPUT:    ONE statement -> ONE result grid (section, name, detail).
-- PRIVACY:   no password hashes or tokens. Only auth users whose email matches
--            a pattern below are listed individually; everyone else is counted.
--            Bearer tokens / URL paths in trigger or cron text are redacted.
--
-- >>> EDIT BEFORE RUNNING: put Zoe's email (or an ILIKE pattern) in `params`.
-- =============================================================================
with
params(pat) as (
  values ('%claessen%'),
         ('%REPLACE_WITH_ZOE_EMAIL_OR_PATTERN%')   -- <<< EDIT ME (ILIKE pattern)
),
managed(nspname) as (
  values ('pg_catalog'), ('information_schema'), ('auth'), ('storage'), ('realtime'),
         ('_realtime'), ('graphql'), ('graphql_public'), ('vault'), ('pgsodium'),
         ('pgsodium_masks'), ('extensions'), ('supabase_functions'), ('supabase_migrations'),
         ('net'), ('cron'), ('pgbouncer'), ('_analytics'), ('pgtle'), ('topology'),
         ('tiger'), ('tiger_data')
),
ns as (
  select n.oid, n.nspname
  from pg_namespace n
  where n.nspname not in (select m.nspname from managed m)
    and n.nspname not like 'pg\_toast%'
    and n.nspname not like 'pg\_temp%'
),
ext_obj as (
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
  select p.oid, n.nspname, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proacl
  from pg_proc p
  join ns n on n.oid = p.pronamespace
  where p.prokind in ('f', 'p', 'w')
    and not exists (select 1 from ext_obj e where e.classid = 'pg_proc'::regclass and e.objid = p.oid)
),
api_role(rolname) as (
  values ('anon'), ('authenticated'), ('service_role')
),
-- yumlog object names that must not already exist in wrapt (kind, name)
yumlog_names(kind, name) as (
  values ('relation', 'recipes'), ('relation', 'ingredients'), ('relation', 'recipe_ingredients'),
         ('relation', 'shopping_list'), ('relation', 'yumlog_members'),
         ('relation', 'recipes_pkey'), ('relation', 'ingredients_pkey'),
         ('relation', 'recipe_ingredients_pkey'), ('relation', 'shopping_list_pkey'),
         ('relation', 'recipe_ingredients_id_seq'), ('relation', 'shopping_list_id_seq'),
         ('function', 'touch_recipes_for_ingredient'), ('function', 'merge_ingredients'),
         ('function', 'shopping_list_set_updated_at'), ('function', 'is_yumlog_member'),
         ('function', 'set_updated_at'),
         ('trigger', 'shopping_list_set_updated_at'),
         ('schema', 'yumlog'),
         ('type', 'recipes'), ('type', 'ingredients'), ('type', 'recipe_ingredients'),
         ('type', 'shopping_list')
),
sensitive(relname) as (
  values ('auth.users'), ('auth.identities'), ('auth.sessions'), ('auth.refresh_tokens'),
         ('vault.secrets'), ('vault.decrypted_secrets'), ('storage.objects'),
         ('public.spotify_profiles'), ('public.plays'), ('public.ai_usage'),
         ('public.artists_cache')
),
report(section, ord, name, detail) as (
  -- 00 meta / size -----------------------------------------------------------
  select '00_meta'::text, 1, 'server'::text, version()::text
  union all
  select '00_meta', 2, 'database', current_database()::text
  union all
  select '00_meta', 3, 'db_size',
         pg_size_pretty(pg_database_size(current_database())) || ' ('
         || pg_database_size(current_database())::text || ' bytes)'
  union all
  select '00_meta', 4, 'public schema total (tables+indexes+toast)',
         pg_size_pretty(coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint) || ' ('
         || coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint::text || ' bytes)'
  from pg_class c
  where c.relnamespace = to_regnamespace('public') and c.relkind in ('r', 'p', 'm')
  union all
  select '00_meta', 5, 'run_at', now()::text

  -- 01 top 20 relations by total size, any schema -----------------------------
  union all
  select '01_top_size', z.rn::int, z.relname, z.detail
  from (
    select row_number() over (order by pg_total_relation_size(c.oid) desc) as rn,
           c.relnamespace::regnamespace::text || '.' || c.relname::text as relname,
           pg_size_pretty(pg_total_relation_size(c.oid)) || ' ('
             || pg_total_relation_size(c.oid)::text || ' bytes) est_rows='
             || c.reltuples::bigint::text as detail
    from pg_class c
    where c.relkind in ('r', 'p', 'm')
  ) z
  where z.rn <= 20

  -- 02 schemas -----------------------------------------------------------------
  union all
  select '02_schema', 0, n.nspname::text,
         'owner=' || pg_get_userbyid(n.nspowner)::text
         || ' managed=' || (n.nspname in (select m.nspname from managed m))::text
         || ' relations=' || (select count(*) from pg_class c where c.relnamespace = n.oid)::text
         || ' functions=' || (select count(*) from pg_proc p where p.pronamespace = n.oid)::text
  from pg_namespace n
  where n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'

  -- 03 tables in user schemas ---------------------------------------------------
  union all
  select '03_table', 0, t.nspname || '.' || t.relname,
         'relkind=' || t.relkind::text
         || ' rls_enabled=' || t.relrowsecurity::text
         || ' rls_forced=' || t.relforcerowsecurity::text
         || ' est_rows=' || t.reltuples::bigint::text
         || ' total_size=' || pg_size_pretty(pg_total_relation_size(t.oid))
  from tbl t

  -- 04 views ------------------------------------------------------------------
  union all
  select '04_view', 0, n.nspname || '.' || c.relname::text,
         'relkind=' || c.relkind::text || ' :: ' || pg_get_viewdef(c.oid, true)
  from pg_class c
  join ns n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm')
    and not exists (select 1 from ext_obj e where e.classid = 'pg_class'::regclass and e.objid = c.oid)

  -- 05 functions (identity signature + security/ACL) ---------------------------
  union all
  select '05_function', 0,
         f.nspname || '.' || f.proname || '(' || pg_get_function_identity_arguments(f.oid) || ')',
         'security_definer=' || f.prosecdef::text
         || ' volatility=' || f.provolatile::text
         || ' config=' || coalesce(array_to_string(f.proconfig, ','), '<none>')
         || ' acl=' || coalesce(f.proacl::text, '<NULL = default: PUBLIC has EXECUTE>')
         || ' | exec: PUBLIC=' || (f.proacl is null
                                  or exists (select 1 from aclexplode(f.proacl) x
                                             where x.grantee = 0 and x.privilege_type = 'EXECUTE'))::text
         || ' anon=' || case when to_regrole('anon') is null then 'n/a'
                             else has_function_privilege(to_regrole('anon'), f.oid, 'EXECUTE')::text end
         || ' authenticated=' || case when to_regrole('authenticated') is null then 'n/a'
                             else has_function_privilege(to_regrole('authenticated'), f.oid, 'EXECUTE')::text end
         || ' service_role=' || case when to_regrole('service_role') is null then 'n/a'
                             else has_function_privilege(to_regrole('service_role'), f.oid, 'EXECUTE')::text end
  from fn f

  -- 06 triggers on user-schema tables -------------------------------------------
  union all
  select '06_trigger', 0, t.nspname || '.' || t.relname || '.' || tg.tgname::text,
         'enabled=' || tg.tgenabled::text
         || ' function=' || tg.tgfoid::regprocedure::text || ' :: '
         || regexp_replace(
              regexp_replace(pg_get_triggerdef(tg.oid, true),
                             '(https?://[^/''" ]+)[^''" ]*', '\1/<path-redacted>', 'g'),
              '(Bearer\s+)[^''" ]+', '\1<redacted>', 'gi')
  from tbl t
  join pg_trigger tg on tg.tgrelid = t.oid and not tg.tgisinternal

  -- 07 triggers on auth.users (L4) ---------------------------------------------
  union all
  select '07_auth_users_trigger', 0, tg.tgname::text,
         'enabled=' || tg.tgenabled::text
         || ' function=' || tg.tgfoid::regprocedure::text || ' :: '
         || pg_get_triggerdef(tg.oid, true)
  from pg_trigger tg
  where tg.tgrelid = to_regclass('auth.users') and not tg.tgisinternal
  union all
  select '07_auth_users_trigger', 99, '(count of non-internal triggers on auth.users)',
         count(*)::text
  from pg_trigger tg
  where tg.tgrelid = to_regclass('auth.users') and not tg.tgisinternal

  -- 08 types ------------------------------------------------------------------
  union all
  select '08_type', 0, n.nspname || '.' || ty.typname::text,
         'typtype=' || ty.typtype::text
         || coalesce(' labels=' || (select string_agg(e.enumlabel::text, ',' order by e.enumsortorder)
                                     from pg_enum e where e.enumtypid = ty.oid), '')
  from pg_type ty
  join ns n on n.oid = ty.typnamespace
  where (ty.typtype in ('e', 'd', 'r')
         or (ty.typtype = 'c' and exists (select 1 from pg_class c2
                                           where c2.oid = ty.typrelid and c2.relkind = 'c')))
    and not exists (select 1 from ext_obj e where e.classid = 'pg_type'::regclass and e.objid = ty.oid)

  -- 09 policies ---------------------------------------------------------------
  union all
  select '09_policy', 0, pol.schemaname || '.' || pol.tablename || '.' || pol.policyname::text,
         'permissive=' || pol.permissive::text
         || ' roles=' || pol.roles::text
         || ' cmd=' || pol.cmd::text
         || ' using=' || coalesce(pol.qual, '<none>')
         || ' with_check=' || coalesce(pol.with_check, '<none>')
  from pg_policies pol
  where pol.schemaname in (select nspname from ns)

  -- 10 sequences ----------------------------------------------------------------
  union all
  select '10_sequence', 0, s.schemaname || '.' || s.sequencename::text,
         'type=' || s.data_type::text || ' last_value=' || coalesce(s.last_value::text, '<never used>')
  from pg_sequences s
  where s.schemaname in (select nspname from ns)

  -- 11 extensions ---------------------------------------------------------------
  union all
  select '11_extension', 0, e.extname::text,
         'version=' || e.extversion::text || ' schema=' || e.extnamespace::regnamespace::text
  from pg_extension e

  -- 12 publications -------------------------------------------------------------
  union all
  select '12_publication', 0, p.pubname::text,
         'all_tables=' || p.puballtables::text
         || ' insert=' || p.pubinsert::text || ' update=' || p.pubupdate::text
         || ' delete=' || p.pubdelete::text
  from pg_publication p
  union all
  select '12_publication', 1, pt.pubname || ' : ' || pt.schemaname || '.' || pt.tablename::text,
         'member'
  from pg_publication_tables pt
  union all
  select '12_publication', 2, 'supabase_realtime exists',
         exists (select 1 from pg_publication where pubname = 'supabase_realtime')::text

  -- 13 pg_cron jobs (guarded: only if cron.job exists) ---------------------------
  union all
  select '13_cron', 0, 'cron.job table exists', (to_regclass('cron.job') is not null)::text
  union all
  select '13_cron', 1, 'job',
         regexp_replace(
           regexp_replace(j.x::text, '(https?://[^/''"<> ]+)[^''"<> ]*', '\1/<path-redacted>', 'g'),
           '(Bearer\s+)[^''"<> ]+', '\1<redacted>', 'gi')
  from unnest(xpath('/table/row',
         case when to_regclass('cron.job') is not null
              then query_to_xml('select * from cron.job', false, false, '')
         end)) as j(x)

  -- 14 CLASH CHECK against yumlog names (any schema) ---------------------------
  union all
  select '14_clash', 0, y.kind || ':' || y.name,
         coalesce('CLASH -> ' || (
           case y.kind
             when 'relation' then (select string_agg(c.relnamespace::regnamespace::text || '.' || c.relname
                                                     || ' (relkind ' || c.relkind::text || ')', ', ')
                                   from pg_class c where c.relname = y.name)
             when 'function' then (select string_agg(p.pronamespace::regnamespace::text || '.' || p.proname
                                                     || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
                                   from pg_proc p where p.proname = y.name)
             when 'trigger'  then (select string_agg(tg.tgrelid::regclass::text || '.' || tg.tgname, ', ')
                                   from pg_trigger tg where tg.tgname = y.name and not tg.tgisinternal)
             when 'schema'   then (select string_agg(n.nspname::text, ', ')
                                   from pg_namespace n where n.nspname = y.name)
             when 'type'     then (select string_agg(ty.typnamespace::regnamespace::text || '.' || ty.typname, ', ')
                                   from pg_type ty where ty.typname = y.name)
           end), 'free')
  from yumlog_names y
  union all
  select '14_clash', 1, 'relations in user schemas named recipe*/ingredient*/shopping*',
         coalesce(string_agg(t.nspname || '.' || t.relname, ', '), 'none')
  from tbl t
  where t.relname ~ '^(recipe|ingredient|shopping)'
  union all
  select '14_clash', 2, 'policies on tables named recipe*/ingredient*/shopping*',
         coalesce(string_agg(pol.schemaname || '.' || pol.tablename || '.' || pol.policyname, ', '), 'none')
  from pg_policies pol
  where pol.tablename ~ '^(recipe|ingredient|shopping)'

  -- 15 L2: run_ask_sql + what the API roles can reach ---------------------------
  union all
  select '15_L2', 1, p.pronamespace::regnamespace::text || '.run_ask_sql('
                     || pg_get_function_identity_arguments(p.oid) || ')',
         'security_definer=' || p.prosecdef::text
         || ' config=' || coalesce(array_to_string(p.proconfig, ','), '<none>')
         || ' proacl=' || coalesce(p.proacl::text, '<NULL = default: PUBLIC has EXECUTE>')
  from pg_proc p
  where p.proname = 'run_ask_sql'
  union all
  select '15_L2', 2, 'run_ask_sql exists', exists (select 1 from pg_proc where proname = 'run_ask_sql')::text
  union all
  select '15_L2', 3, 'has_table_privilege(service_role, auth.users, SELECT)',
         case when to_regrole('service_role') is null or to_regclass('auth.users') is null then 'n/a'
              else has_table_privilege(to_regrole('service_role'), to_regclass('auth.users'), 'SELECT')::text end
  union all
  select '15_L2', 4, 'has_schema_privilege(service_role, auth, USAGE)',
         case when to_regrole('service_role') is null or to_regnamespace('auth') is null then 'n/a'
              else has_schema_privilege(to_regrole('service_role'), to_regnamespace('auth'), 'USAGE')::text end
  union all
  select '15_L2', 5, 'role ' || r.rolname::text,
         'bypassrls=' || r.rolbypassrls::text || ' superuser=' || r.rolsuper::text
         || ' inherit=' || r.rolinherit::text
         || ' member_of=' || coalesce((select string_agg(pg_get_userbyid(m.roleid)::text, ',')
                                       from pg_auth_members m where m.member = r.oid), '<none>')
  from pg_roles r
  where r.rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
  union all
  -- per sensitive relation x API role: SELECT privilege (+ schema USAGE)
  select '15_L2', 6, 'SELECT on ' || s.relname || ' by ' || ar.rolname,
         case when to_regclass(s.relname) is null then 'relation absent'
              when to_regrole(ar.rolname) is null then 'role absent'
              else 'select=' || has_table_privilege(to_regrole(ar.rolname), to_regclass(s.relname), 'SELECT')::text
                   || ' schema_usage=' || has_schema_privilege(to_regrole(ar.rolname),
                        split_part(s.relname, '.', 1), 'USAGE')::text
         end
  from sensitive s
  cross join api_role ar
  union all
  select '15_L2', 7, 'SELECT on public.spotify_profiles.refresh_token_enc by ' || ar.rolname,
         case when to_regrole(ar.rolname) is null then 'role absent'
              when not exists (select 1 from pg_attribute
                               where attrelid = to_regclass('public.spotify_profiles')
                                 and attname = 'refresh_token_enc' and not attisdropped)
                then 'column absent'
              else has_column_privilege(to_regrole(ar.rolname), to_regclass('public.spotify_profiles'),
                                        'refresh_token_enc', 'SELECT')::text
         end
  from api_role ar
  union all
  -- per schema x API role: how many tables/views the role can SELECT (with USAGE)
  select '15_L2', 8, 'readable relations in schema ' || n.nspname::text || ' by ' || ar.rolname,
         count(*) filter (where has_schema_privilege(to_regrole(ar.rolname), n.oid, 'USAGE')
                            and has_table_privilege(to_regrole(ar.rolname), c.oid, 'SELECT'))::text
         || ' of ' || count(*)::text
  from pg_namespace n
  join pg_class c on c.relnamespace = n.oid and c.relkind in ('r', 'p', 'v', 'm', 'f')
  cross join api_role ar
  where n.nspname not like 'pg\_toast%' and n.nspname not like 'pg\_temp%'
    and n.nspname not in ('pg_catalog', 'information_schema')
    and to_regrole(ar.rolname) is not null
  group by n.nspname, ar.rolname

  -- 16 table privileges for API roles in user schemas ---------------------------
  union all
  select '16_table_grant', 0,
         t.nspname || '.' || t.relname || ' -> '
           || case when g.grantee = 0 then 'PUBLIC' else pg_get_userbyid(g.grantee)::text end,
         string_agg(g.privilege_type, ',' order by g.privilege_type)
  from tbl t
  cross join lateral aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) g
  group by t.nspname, t.relname, g.grantee

  -- 17 default privileges (global + schema public) ------------------------------
  union all
  select '17_default_acl', 0,
         pg_get_userbyid(d.defaclrole)::text || ' in '
           || case when d.defaclnamespace = 0 then '<all schemas>'
                   else d.defaclnamespace::regnamespace::text end
           || ' objtype=' || d.defaclobjtype::text,
         d.defaclacl::text
  from pg_default_acl d
  where d.defaclnamespace = 0 or d.defaclnamespace = to_regnamespace('public')

  -- 18 auth users -----------------------------------------------------------------
  union all
  select '18_auth_user', 0, '(total auth.users rows)', count(*)::text
  from auth.users
  union all
  select '18_auth_user', 1, '(users NOT matching params: count / first / last created)',
         count(*)::text || ' / ' || coalesce(min(u.created_at)::text, '-') || ' / '
         || coalesce(max(u.created_at)::text, '-')
  from auth.users u
  where not exists (select 1 from params p where u.email ilike p.pat)
  union all
  select '18_auth_user', 2, '(spotify_profiles rows / auth users without one)',
         case when to_regclass('public.spotify_profiles') is null then 'spotify_profiles absent'
              else (xpath('/row/c/text()', query_to_xml(
                      'select count(*) as c from public.spotify_profiles', false, true, '')))[1]::text
                   || ' / '
                   || (xpath('/row/c/text()', query_to_xml(
                      'select count(*) as c from auth.users u where not exists '
                      || '(select 1 from public.spotify_profiles s where s.user_id = u.id)',
                      false, true, '')))[1]::text
         end
  union all
  select '18_auth_user',
         (10 + row_number() over (order by u.created_at))::int,
         coalesce(u.email::text, '<no email>'),
         'id=' || u.id::text
         || ' created_at=' || coalesce(u.created_at::text, '<null>')
         || ' last_sign_in_at=' || coalesce(u.last_sign_in_at::text, '<null>')
         || ' email_confirmed_at=' || coalesce(u.email_confirmed_at::text, '<null>')
         || ' provider=' || coalesce(u.raw_app_meta_data ->> 'provider', '<null>')
         || ' has_password=' || (coalesce(u.encrypted_password, '') <> '')::text
         || ' identities=' || (select count(*) from auth.identities i where i.user_id = u.id)::text
  from auth.users u
  where exists (select 1 from params p where u.email ilike p.pat)
)
select section, name, detail
from report
order by section, ord, name;
