-- =============================================================================
-- 003_yumlog_rebuild_webhook.sql  --  recipes change -> Cloudflare deploy hook
--
-- PURPOSE:    Recipe pages are static, so a change to yumlog.recipes must
--             trigger a rebuild. A statement-level trigger calls
--             request_site_rebuild(), which POSTs to the Cloudflare deploy
--             hook via pg_net. The hook URL lives in Supabase Vault as
--             `yumlog_deploy_hook` and NEVER appears in SQL: function and
--             trigger source is readable by anyone who can call wrapt's
--             public.run_ask_sql (anon included), and the SQL editor keeps
--             query history. Create/edit the secret in the dashboard Vault UI.
--
--             Designed so a rebuild problem can never break a recipe save:
--               * no pg_net installed      -> no-op
--               * no Vault / no secret     -> no-op (this is how the webhook is
--                                             "off" during loads and tests)
--               * caller is an API user who is not a yumlog member -> no-op
--                 (a statement trigger fires even when RLS filters the UPDATE
--                 to 0 rows, so without this any wrapt sign-up could spam
--                 rebuilds with an UPDATE that matches nothing)
--               * anything else fails  -> WARNING, and the save still commits
--             pg_net sends after commit, so a rolled-back transaction (dry run,
--             RLS tests) sends nothing.
--             Statement-level: a merge touching 10 recipes = 1 POST, not 10.
-- RUN IN:     wrapt's Supabase project, after 002. pg_net should be enabled
--             first (Database -> Extensions -> pg_net), but this file does not
--             need it: without pg_net the trigger simply does nothing.
-- IDEMPOTENT: yes (create or replace; drop trigger if exists then create).
-- RESULT:     verification SELECT; rows marked INFO are facts to copy back,
--             not pass/fail. The pg_net rows answer PLAN Q7/R19: if anon or
--             authenticated show EXECUTE = true on net.http_post, that is
--             expected and accepted: Supabase grants it to PUBLIC and postgres
--             can't revoke it (see docs/archive/2026-09-supabase-to-wrapt/stage3/005_revoke_net_http_not_applied.sql).
-- ROLLBACK:   drop trigger if exists yumlog_rebuild_site on yumlog.recipes;
--             drop function if exists yumlog.request_site_rebuild();
-- =============================================================================

create or replace function yumlog.request_site_rebuild()
returns trigger
language plpgsql
security definer          -- needs to read vault.decrypted_secrets and call net.*
set search_path = ''
as $$
declare
  hook text;
begin
  begin
    -- pg_net not installed: nothing to send with.
    if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_net') then
      return null;
    end if;

    -- Requests through the Data API carry JWT claims; only members may cause
    -- a rebuild. SQL-editor / dashboard edits carry no claims and always may.
    if coalesce(pg_catalog.current_setting('request.jwt.claims', true), '') <> ''
       and not yumlog.is_member() then
      return null;
    end if;

    if pg_catalog.to_regclass('vault.decrypted_secrets') is null then
      return null;
    end if;

    select s.decrypted_secret into hook
    from vault.decrypted_secrets s
    where s.name = 'yumlog_deploy_hook'
    limit 1;

    -- No secret = webhook off (preview setup, data loads, rollback).
    if hook is null or hook = '' then
      return null;
    end if;

    perform net.http_post(
      url                  := hook,
      body                 := '{}'::jsonb,
      headers              := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Never fail the recipe write over a rebuild. SQLSTATE only: the message
    -- could echo the hook URL.
    raise warning 'yumlog_rebuild_site: rebuild request not queued (SQLSTATE %)', sqlstate;
  end;
  return null;
end;
$$;

-- Trigger-only. EXECUTE isn't checked when a trigger fires, so nobody needs it.
revoke execute on function yumlog.request_site_rebuild() from public, anon, authenticated, service_role;

drop trigger if exists yumlog_rebuild_site on yumlog.recipes;
create trigger yumlog_rebuild_site
  after insert or update or delete on yumlog.recipes
  for each statement execute function yumlog.request_site_rebuild();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification (the grid the editor shows). status = OK / MISMATCH / INFO.
-- Never selects the secret's value — only whether it exists.
-- ---------------------------------------------------------------------------
with
net_fns as (
  select p.oid, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn
  from pg_proc p
  where p.pronamespace = to_regnamespace('net')
    and p.proname in ('http_post', 'http_get', 'http_delete')
),
report(ord, item, expected, actual) as (
  select 10, 'fn request_site_rebuild: security_definer / config', 'true / search_path=""',
         coalesce((select p.prosecdef::text || ' / ' || coalesce(array_to_string(p.proconfig, ','), '<none>')
                   from pg_proc p where p.oid = to_regprocedure('yumlog.request_site_rebuild()')), '<missing>')
  union all
  select 11, 'fn request_site_rebuild: EXECUTE anon/authenticated/service_role/public', 'false/false/false/false',
         coalesce((select has_function_privilege('anon', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('public', p.oid, 'EXECUTE')::text
                   from pg_proc p where p.oid = to_regprocedure('yumlog.request_site_rebuild()')), '<missing>')
  union all
  select 12, 'fn request_site_rebuild: source has no URL', 'true',
         coalesce((select (pg_get_functiondef(p.oid) !~* 'https?://')::text
                   from pg_proc p where p.oid = to_regprocedure('yumlog.request_site_rebuild()')), '<missing>')
  union all
  select 20, 'trigger yumlog_rebuild_site', 'enabled AFTER INSERT/UPDATE/DELETE FOR EACH STATEMENT',
         coalesce((select case tg.tgenabled when 'D' then 'disabled' else 'enabled' end
                          || case when (tg.tgtype & 2) <> 0 then ' BEFORE' else ' AFTER' end
                          || ' ' || concat_ws('/',
                               case when (tg.tgtype & 4) <> 0 then 'INSERT' end,
                               case when (tg.tgtype & 16) <> 0 then 'UPDATE' end,
                               case when (tg.tgtype & 8) <> 0 then 'DELETE' end)
                          || case when (tg.tgtype & 1) <> 0 then ' FOR EACH ROW' else ' FOR EACH STATEMENT' end
                   from pg_trigger tg
                   where tg.tgrelid = to_regclass('yumlog.recipes') and tg.tgname = 'yumlog_rebuild_site'), '<missing>')
  union all
  select 21, 'other triggers on yumlog.recipes', '0',
         (select count(*) from pg_trigger tg
          where tg.tgrelid = to_regclass('yumlog.recipes') and not tg.tgisinternal
            and tg.tgname <> 'yumlog_rebuild_site')::text
  -- facts (INFO): copy these back
  union all
  select 30, 'pg_net installed (INFO; needed before the webhook can fire)', 'INFO',
         coalesce((select 'true, version ' || e.extversion || ', schema ' || e.extnamespace::regnamespace::text
                   from pg_extension e where e.extname = 'pg_net'), 'false')
  union all
  select 31, 'Vault secret yumlog_deploy_hook present (INFO; value not shown)', 'INFO',
         -- dynamic (query_to_xml) so this row can't fail at parse time if Vault is absent
         case when to_regclass('vault.secrets') is null then 'vault not installed'
              when not has_table_privilege('vault.secrets', 'SELECT') then 'cannot check (no SELECT on vault.secrets)'
              else (xpath('/row/c/text()', query_to_xml(
                      'select count(*) as c from vault.secrets where name = ''yumlog_deploy_hook''',
                      false, true, '')))[1]::text || ' row(s)' end
  union all
  -- the trigger function runs as its owner, postgres: both must be true for
  -- the webhook to fire at all
  select 32, 'postgres can read vault.decrypted_secrets (INFO; must be true)', 'INFO',
         case when to_regclass('vault.decrypted_secrets') is null then 'vault not installed'
              else has_table_privilege('postgres', 'vault.decrypted_secrets', 'SELECT')::text end
  union all
  select 40, 'net.' || n.fn || ' EXECUTE anon/authenticated/public/postgres (INFO; anon/authenticated true is expected on Supabase; postgres must be true)', 'INFO',
         has_function_privilege('anon', n.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', n.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('public', n.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('postgres', n.oid, 'EXECUTE')::text
  from net_fns n
  union all
  select 41, 'schema net USAGE anon/authenticated (INFO)', 'INFO',
         case when to_regnamespace('net') is null then 'schema net absent'
              else has_schema_privilege('anon', 'net', 'USAGE')::text
                   || '/' || has_schema_privilege('authenticated', 'net', 'USAGE')::text end
)
select ord, item, expected, actual,
       case when expected = 'INFO' then 'INFO'
            when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
