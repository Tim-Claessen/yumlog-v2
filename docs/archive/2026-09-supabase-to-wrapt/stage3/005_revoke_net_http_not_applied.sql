-- =============================================================================
-- 005_revoke_net_http_not_applied.sql (was supabase/migrations/005_optional_revoke_net_http.sql)
--   OPTIONAL hardening of pg_net grants
--
-- STATUS:     DOES NOT WORK ON SUPABASE — NOT APPLIED (decision 2026-09-28).
--             Run in wrapt, it aborted with "005 ABORTED (nothing changed)":
--             anon/authenticated kept EXECUTE. The ACL shows why: the net.http_*
--             functions are owned by supabase_admin, which granted EXECUTE to
--             PUBLIC (grantor supabase_admin; no per-role grants). A REVOKE only
--             removes grants the revoking role made, and postgres isn't a
--             superuser on Supabase, so the SQL editor can't remove them. The
--             functions are SECURITY INVOKER (prosecdef = false). Residual risk
--             accepted as PLAN R19. Kept for the record; running it again is
--             harmless (it aborts and rolls back).
--
-- RUN ONLY IF: the 003 verification report (rows "net.http_* EXECUTE
--             anon/authenticated/public/postgres") shows anon or authenticated
--             = true. On 2026-09-28 in wrapt it showed true/true/true/true, i.e.
--             everyone holds EXECUTE through PUBLIC.
-- PURPOSE:    Enabling pg_net for the rebuild webhook (003) left net.http_get /
--             http_post / http_delete executable by PUBLIC (so anon and
--             authenticated too). The net schema isn't exposed through the Data
--             API, and the only anon SQL path into wrapt (public.run_ask_sql)
--             runs read-only, so a queued request would fail anyway — this
--             closes the door properly. Yumlog doesn't need them for API roles:
--             request_site_rebuild() is SECURITY DEFINER and runs as postgres.
-- HOW:        all-or-nothing. One `do` block:
--               1. grant EXECUTE to postgres explicitly (so it doesn't depend
--                  on PUBLIC — otherwise revoking PUBLIC would switch the
--                  webhook off),
--               2. revoke EXECUTE from PUBLIC, anon, authenticated,
--               3. check: postgres must still have EXECUTE and anon /
--                  authenticated must not. If either check fails (e.g. postgres
--                  lacks the grant option, so a GRANT/REVOKE only warned), it
--                  raises and the whole block rolls back — nothing changes.
-- RUN IN:     wrapt's Supabase project. This touches the pg_net extension's
--             grants, which are project-wide — not just yumlog's. Nothing else
--             in wrapt uses pg_net (it was enabled for yumlog, PLAN step 4.2).
-- IDEMPOTENT: yes; skips cleanly if pg_net isn't installed.
-- RESULT:     if the block raises "005 ABORTED …", nothing changed — send the
--             message back. Otherwise the verification grid: every row OK.
-- ROLLBACK:   grant execute on function <each net.http_* signature in the grid>
--             to public;
-- =============================================================================

do $$
declare
  f regprocedure;
  problems text := '';
begin
  if to_regnamespace('net') is null then
    raise notice 'pg_net is not installed; nothing to revoke';
    return;
  end if;

  for f in
    select p.oid::regprocedure
    from pg_proc p
    where p.pronamespace = to_regnamespace('net')
      and p.proname in ('http_get', 'http_post', 'http_delete')
  loop
    execute format('grant execute on function %s to postgres', f);
    execute format('revoke execute on function %s from public, anon, authenticated', f);

    if not has_function_privilege('postgres', f, 'EXECUTE') then
      problems := problems || format('postgres would lose EXECUTE on %s; ', f);
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      problems := problems || format('anon still has EXECUTE on %s; ', f);
    end if;
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('authenticated still has EXECUTE on %s; ', f);
    end if;
  end loop;

  if problems <> '' then
    raise exception '005 ABORTED (nothing changed): %', problems;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Verification. anon/authenticated/public false; postgres must stay true
-- (the webhook runs as postgres).
-- ---------------------------------------------------------------------------
with report(ord, item, expected, actual) as (
  select 1, 'pg_net installed', 'true',
         exists (select 1 from pg_extension where extname = 'pg_net')::text
  union all
  select 10, 'net.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') EXECUTE anon/authenticated/public/postgres',
         'false/false/false/true',
         has_function_privilege('anon', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('public', p.oid, 'EXECUTE')::text
         || '/' || has_function_privilege('postgres', p.oid, 'EXECUTE')::text
  from pg_proc p
  where p.pronamespace = to_regnamespace('net')
    and p.proname in ('http_get', 'http_post', 'http_delete')
)
select ord, item, expected, actual,
       case when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
