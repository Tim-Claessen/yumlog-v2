-- =============================================================================
-- 005_optional_revoke_net_http.sql  --  OPTIONAL hardening of pg_net grants
--
-- RUN ONLY IF: the 003 verification report (rows "net.http_* EXECUTE
--             anon/authenticated/public") shows anon or authenticated = true
--             on net.http_post. Otherwise there's nothing to do.
-- PURPOSE:    Enabling pg_net for the rebuild webhook (003) may let anon and
--             authenticated call net.http_get/http_post directly (Supabase's
--             install hook grants them; PLAN R19/Q7). The only anon SQL path
--             into wrapt (public.run_ask_sql) runs read-only, so a queued
--             request would fail anyway — this closes the door properly.
--             Yumlog doesn't need them: request_site_rebuild() is SECURITY
--             DEFINER and runs as postgres.
-- CAVEAT:     if the "public" column in 003's report is true, anon keeps access
--             through PUBLIC even after this. That case is left alone on
--             purpose (revoking from PUBLIC could cut off postgres, and so the
--             webhook, if postgres only has it via PUBLIC): stop and ask.
--             If postgres doesn't hold the grant option, REVOKE only warns
--             "no privileges could be revoked"; the report below shows the
--             real state either way.
-- RUN IN:     wrapt's Supabase project. This touches the pg_net extension's
--             grants, which are project-wide — not just yumlog's.
-- IDEMPOTENT: yes; skips cleanly if pg_net isn't installed.
-- ROLLBACK:   grant execute on function net.http_get(text, jsonb, jsonb, integer),
--             net.http_post(text, jsonb, jsonb, jsonb, integer) to anon, authenticated;
--             (signatures as listed in the report below)
-- =============================================================================

do $$
declare
  f regprocedure;
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
    execute format('revoke execute on function %s from anon, authenticated', f);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Verification. anon/authenticated should be false; postgres must stay true
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
