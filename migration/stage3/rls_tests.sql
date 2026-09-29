-- =============================================================================
-- rls_tests.sql  --  PLAN step 4.7: prove the grants, RLS and RPC guards
--
-- RUN IN:     wrapt's Supabase project -> SQL Editor, AFTER 001-004 and the
--             members insert (4.5). Ideally after the rehearsal load (4.6) so
--             the counts are real, but it works on empty tables too.
-- WRITES:     none that survive. The whole file is ONE `do` block, so it is
--             atomic on its own, and it always ends by raising an exception:
--             everything it did (test rows, role switches) is rolled back
--             whatever the editor's transaction behaviour is. pg_net sends
--             only after commit, so no rebuild is triggered either.
-- EXPECTED:   the editor shows an ERROR whose text starts
--               RESULTS: <n> PASS, 0 FAIL, <n> SKIP
--             followed by one line per case. Copy the whole message back.
--             A line starting "FAIL" names the case, what was expected and
--             what happened.
-- HOW:        each case runs in its own sub-block; roles are switched with
--             set_config('role', ..., true) (= SET LOCAL ROLE) plus
--             request.jwt.claims, exactly how PostgREST presents a request.
--             Results collect in a PL/pgSQL variable, not a table: variables
--             survive a sub-block's rollback and need no grants, whichever
--             role is active. A failing case rolls back only its own sub-block
--             (which also restores the role), so later cases still run.
--             Counts are compared with baselines taken as postgres at the
--             start, never hard-coded.
-- CASES:      A = anon, S = signed-up stranger (authenticated, not a member,
--             fabricated uuid — no real account is created), V = service_role
--             (wrapt's /ask), T = Tim (looked up by email), W = rebuild webhook
--             queue, R = wrapt's public.run_ask_sql (last, because a successful
--             call sets the transaction read-only).
-- =============================================================================
do $rls$
declare
  tim_email   constant text := 'timclaessen96@gmail.com';
  stranger_id constant uuid := '00000000-0000-4000-8000-000000000001';
  tim_id      uuid;
  tim_rows    integer;
  b_rec bigint; b_ing bigint; b_ri bigint; b_sl bigint; b_max_ri bigint;
  n bigint; n2 bigint; q0 bigint; q1 bigint;
  webhook_on  boolean := false;   -- pg_net installed, Vault secret set, and the queue readable
  webhook_note text := 'webhook off: pg_net or Vault secret yumlog_deploy_hook missing';
  has_ask     boolean := to_regprocedure('public.run_ask_sql(text)') is not null;
  got text; detail text; j jsonb;
  res text := '';
  n_pass integer := 0; n_fail integer := 0; n_skip integer := 0;
begin
  -- -------------------------------------------------------------------------
  -- Setup (as postgres)
  -- -------------------------------------------------------------------------
  if to_regnamespace('yumlog') is null then
    raise exception 'RESULTS: cannot run — schema yumlog does not exist (run 001-004 first)';
  end if;

  select count(*) into b_rec from yumlog.recipes;
  select count(*) into b_ing from yumlog.ingredients;
  select count(*) into b_ri  from yumlog.recipe_ingredients;
  select count(*) into b_sl  from yumlog.shopping_list;
  select coalesce(max(id), 0) into b_max_ri from yumlog.recipe_ingredients;

  select count(*) into tim_rows from auth.users where email = tim_email;
  if tim_rows <> 1 then
    raise exception 'RESULTS: cannot run — expected exactly 1 auth.users row for %, found %', tim_email, tim_rows;
  end if;
  select id into tim_id from auth.users where email = tim_email;

  -- The rebuild webhook is "on" only with pg_net installed and the Vault secret
  -- set. The W cases also need to count net.http_request_queue; if any of this
  -- can't be read, they SKIP (with the reason) instead of aborting the run.
  begin
    if exists (select 1 from pg_extension where extname = 'pg_net')
       and to_regclass('net.http_request_queue') is not null
       and to_regclass('vault.secrets') is not null then
      execute 'select count(*) > 0 from vault.secrets where name = ''yumlog_deploy_hook''' into webhook_on;
      execute 'select count(*) from net.http_request_queue' into q0;
    end if;
  exception when others then
    webhook_on := false;
    webhook_note := 'cannot check the webhook as postgres: ' || sqlerrm;
  end;

  -- One formatted result line; SKIP when exp = 'SKIP'.
  execute $f$
    create function pg_temp.rls_line(tcase text, exp text, got text, detail text)
    returns text language sql as $b$
      select case when exp = 'SKIP' then 'SKIP'
                  when got is not distinct from exp then 'PASS'
                  else 'FAIL' end
             || ' | ' || tcase || ' | expected: ' || exp || ' | got: ' || coalesce(got, '<null>')
             || coalesce(' | ' || nullif(detail, ''), '') || chr(10)
    $b$
  $f$;

  -- Tim must already be a member (step 4.5). If not, record a FAIL and add
  -- him for the duration of the test so the T cases still say something.
  got := exists (select 1 from yumlog.members where user_id = tim_id)::text;
  res := res || pg_temp.rls_line('T0 Tim is in yumlog.members (step 4.5 done)', 'true', got,
                                 case when got = 'false' then 'added temporarily for this run' end);
  if got = 'false' then
    insert into yumlog.members (user_id, note) values (tim_id, 'rls_tests temporary');
  end if;

  -- =========================================================================
  -- A: anon
  -- =========================================================================
  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    select count(*) into n from yumlog.recipes;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A1 anon reads recipes (count)', b_rec::text, got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    select count(*) into n from yumlog.ingredients;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A2 anon reads ingredients (count)', b_ing::text, got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    select count(*) into n from yumlog.recipe_ingredients;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A3 anon reads recipe_ingredients (count)', b_ri::text, got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    select count(*) into n from yumlog.shopping_list;
    got := 'no error, ' || n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A4 anon reads shopping_list', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    insert into yumlog.recipes (slug, title, method) values ('__rls-anon__', 'x', 'x');
    got := 'no error (row inserted)';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A5 anon inserts a recipe', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    update yumlog.recipes set title = title where slug = '__none__';
    got := 'no error';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A6 anon updates recipes', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    select count(*) into n from yumlog.members;
    got := 'no error, ' || n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A7 anon reads members', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    got := 'no error, returned ' || yumlog.is_member()::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A8 anon calls is_member()', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    perform yumlog.merge_ingredients('__rls_x__', '__rls_y__');
    got := 'no error';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A9 anon calls merge_ingredients', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'anon', true);
    perform yumlog.touch_recipes_for_ingredient('__rls_x__');
    got := 'no error';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('A10 anon calls touch_recipes_for_ingredient', 'ERROR 42501', got, detail);

  -- =========================================================================
  -- S: a signed-up stranger (authenticated, not in members)
  -- =========================================================================
  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    got := yumlog.is_member()::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S1 stranger is_member()', 'false', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from yumlog.recipes;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S2 stranger reads recipes (count)', b_rec::text, got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from yumlog.shopping_list;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S3 stranger sees 0 shopping_list rows', '0', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.ingredients (name, category) values ('__rls_stranger__', 'fridge');
    got := 'no error (row inserted)';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S4 stranger inserts an ingredient', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.recipes (slug, title, method) values ('__rls-stranger__', 'x', 'x');
    got := 'no error (row inserted)';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S5 stranger inserts a recipe', 'ERROR 42501', got, detail);

  -- S6 doubles as W1: a 0-row UPDATE still fires the statement trigger, which
  -- must NOT queue a rebuild for a non-member.
  detail := null; q0 := null; q1 := null;
  if webhook_on then execute 'select count(*) from net.http_request_queue' into q0; end if;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    update yumlog.recipes set title = title;
    get diagnostics n = row_count;
    got := n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S6 stranger updates every recipe', '0 rows', got, detail);
  if webhook_on then
    execute 'select count(*) from net.http_request_queue' into q1;
    res := res || pg_temp.rls_line('W1 stranger 0-row update queues no rebuild (queue delta)', '0', (q1 - q0)::text, null);
  else
    res := res || pg_temp.rls_line('W1 stranger 0-row update queues no rebuild', 'SKIP', null, webhook_note);
  end if;

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    delete from yumlog.recipe_ingredients;
    get diagnostics n = row_count;
    got := n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S7 stranger deletes every recipe line', '0 rows', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.shopping_list (ingredient, quantity, unit) values ('salt', 1, 'g');
    got := 'no error (row inserted)';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S8 stranger adds to the shopping list', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from yumlog.members;
    got := 'no error, ' || n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('S9 stranger reads members', 'ERROR 42501', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    perform yumlog.merge_ingredients('__rls_x__', '__rls_y__');
    got := 'no error';
    perform set_config('role', 'none', true);
  exception when others then
    got := 'ERROR ' || sqlstate || case when sqlerrm like '%not a yumlog member%' then ' not a yumlog member' else '' end;
    detail := sqlerrm;
  end;
  res := res || pg_temp.rls_line('S10 stranger calls merge_ingredients', 'ERROR 42501 not a yumlog member', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', stranger_id), true);
    perform set_config('request.jwt.claim.sub', stranger_id::text, true);
    perform set_config('role', 'authenticated', true);
    perform yumlog.touch_recipes_for_ingredient('__rls_x__');
    got := 'no error';
    perform set_config('role', 'none', true);
  exception when others then
    got := 'ERROR ' || sqlstate || case when sqlerrm like '%not a yumlog member%' then ' not a yumlog member' else '' end;
    detail := sqlerrm;
  end;
  res := res || pg_temp.rls_line('S11 stranger calls touch_recipes_for_ingredient', 'ERROR 42501 not a yumlog member', got, detail);

  -- =========================================================================
  -- V: service_role (what wrapt's /ask runs model SQL as)
  -- =========================================================================
  detail := null;
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('role', 'service_role', true);
    select count(*) into n from yumlog.recipes;
    got := 'no error, ' || n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then
    got := 'ERROR ' || sqlstate || case when sqlerrm like 'permission denied for schema yumlog%' then ' (schema)' else '' end;
    detail := sqlerrm;
  end;
  res := res || pg_temp.rls_line('V1 service_role reads yumlog.recipes', 'ERROR 42501 (schema)', got, detail);

  -- Documents PLAN R5: service_role CAN read Vault. Expected, low severity.
  -- The value is never selected — only a row count.
  detail := null;
  begin
    perform set_config('role', 'service_role', true);
    execute 'select count(*) from vault.decrypted_secrets where name = ''yumlog_deploy_hook''' into n;
    got := 'readable';
    detail := n || ' matching row(s); value not shown';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('V2 service_role can read Vault (R5, expected)', 'readable', got, detail);

  -- =========================================================================
  -- T: Tim — full CRUD, cascade rename, touch, merge. Throwaway names only;
  -- everything is rolled back at the end.
  -- =========================================================================
  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    got := yumlog.is_member()::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T1 Tim is_member()', 'true', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from yumlog.shopping_list;
    got := n::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T2 Tim reads the whole shopping list (count)', b_sl::text, got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.ingredients (name, category)
    values ('__rls_test_a__', 'fridge'), ('__rls_test_b__', 'fridge');
    get diagnostics n = row_count;
    got := n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T3 Tim inserts 2 ingredients', '2 rows', got, detail);

  -- T4 doubles as W2: one INSERT statement of 2 rows = exactly 1 queued POST
  -- (statement-level trigger), when the webhook is on.
  detail := null; q0 := null; q1 := null;
  if webhook_on then execute 'select count(*) from net.http_request_queue' into q0; end if;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.recipes (slug, title, method)
    values ('__rls-test-1__', 'RLS test 1', 'Step: test.'), ('__rls-test-2__', 'RLS test 2', 'Step: test.');
    get diagnostics n = row_count;
    got := n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T4 Tim inserts 2 recipes in one statement', '2 rows', got, detail);
  if webhook_on then
    execute 'select count(*) from net.http_request_queue' into q1;
    res := res || pg_temp.rls_line('W2 member insert queues exactly 1 rebuild (queue delta)', '1', (q1 - q0)::text,
                                   'rolled back with the test; nothing is sent');
  else
    res := res || pg_temp.rls_line('W2 member insert queues exactly 1 rebuild', 'SKIP', null, webhook_note);
  end if;

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.recipe_ingredients (recipe_slug, ingredient, display_name, quantity, unit)
    values ('__rls-test-1__', '__rls_test_a__', 'rls test a', 1, 'g')
    returning id into n;
    got := case when n > b_max_ri then 'new id above existing max' else 'id ' || n || ' <= existing max ' || b_max_ri end;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T5 Tim inserts a recipe line (identity id)', 'new id above existing max', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    insert into yumlog.shopping_list (ingredient, quantity, unit, checked)
    values ('__rls_test_a__', 1, 'g', false), ('__rls_test_b__', 2, 'g', false);
    get diagnostics n = row_count;
    update yumlog.shopping_list set checked = true where ingredient = '__rls_test_a__';
    get diagnostics n2 = row_count;
    got := n || ' inserted, ' || n2 || ' updated';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T6 Tim adds 2 shopping rows and ticks one', '2 inserted, 1 updated', got, detail);

  -- Rename with references: FK ON UPDATE CASCADE must work under RLS.
  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    update yumlog.ingredients set name = '__rls_test_a2__' where name = '__rls_test_a__';
    select count(*) into n  from yumlog.recipe_ingredients where ingredient = '__rls_test_a2__';
    select count(*) into n2 from yumlog.shopping_list      where ingredient = '__rls_test_a2__';
    got := n || ' recipe line / ' || n2 || ' shopping row';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T7 Tim renames an ingredient (cascade)', '1 recipe line / 1 shopping row', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    got := yumlog.touch_recipes_for_ingredient('__rls_test_a2__')::text;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T8 Tim touch_recipes_for_ingredient (recipes touched)', '1', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    j := yumlog.merge_ingredients('__rls_test_a2__', '__rls_test_b__');
    select coalesce(sum(quantity), 0) into n from yumlog.shopping_list where ingredient = '__rls_test_b__';
    select count(*) into n2 from yumlog.ingredients where name = '__rls_test_a2__';
    got := j::text || ', b qty ' || n || ', a2 rows ' || n2;
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T9 Tim merge_ingredients (merges shopping rows by unit)',
                                 '{"recipe_lines": 1, "shopping_list_rows": 1}, b qty 3, a2 rows 0', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    delete from yumlog.recipes where slug in ('__rls-test-1__', '__rls-test-2__');
    get diagnostics n = row_count;
    select count(*) into n2 from yumlog.recipe_ingredients where recipe_slug in ('__rls-test-1__', '__rls-test-2__');
    delete from yumlog.shopping_list where ingredient = '__rls_test_b__';
    delete from yumlog.ingredients where name = '__rls_test_b__';
    got := n || ' recipes deleted, ' || n2 || ' lines left';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T10 Tim deletes (recipe cascade, shopping row, ingredient)',
                                 '2 recipes deleted, 0 lines left', got, detail);

  detail := null;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s","role":"authenticated"}', tim_id), true);
    perform set_config('request.jwt.claim.sub', tim_id::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into n from yumlog.members;
    got := 'no error, ' || n || ' rows';
    perform set_config('role', 'none', true);
  exception when others then got := 'ERROR ' || sqlstate; detail := sqlerrm; end;
  res := res || pg_temp.rls_line('T11 even Tim cannot read members through the API', 'ERROR 42501', got, detail);

  -- Back as postgres: the throwaway rows are gone and the baselines hold.
  select count(*) into n from yumlog.recipes;
  select count(*) into n2 from yumlog.ingredients;
  res := res || pg_temp.rls_line('T12 counts back to baseline (recipes/ingredients)',
                                 b_rec || '/' || b_ing, n || '/' || n2, null);

  -- =========================================================================
  -- R: wrapt's public.run_ask_sql (callable by anon via PUBLIC). Last,
  -- because a successful call runs `set local transaction_read_only = on`:
  -- each case ends by raising a sentinel (SQLSTATE YT001) so its sub-block —
  -- and that setting — is rolled back.
  -- =========================================================================
  if not has_ask then
    res := res || pg_temp.rls_line('R1-R4 public.run_ask_sql cases', 'SKIP', null, 'run_ask_sql(text) not found');
  else
    detail := null;
    begin
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('role', 'anon', true);
      execute 'select public.run_ask_sql($1)' using 'select count(*) as n from yumlog.shopping_list'::text;
      raise exception using errcode = 'YT001', message = 'sentinel';
    exception when others then
      if sqlstate = 'YT001' then got := 'no error'; else got := 'ERROR ' || sqlstate; detail := sqlerrm; end if;
    end;
    res := res || pg_temp.rls_line('R1 anon run_ask_sql reads shopping_list', 'ERROR 42501', got, detail);

    detail := null;
    begin
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('role', 'anon', true);
      execute 'select public.run_ask_sql($1)' using 'select count(*) as n from yumlog.members'::text;
      raise exception using errcode = 'YT001', message = 'sentinel';
    exception when others then
      if sqlstate = 'YT001' then got := 'no error'; else got := 'ERROR ' || sqlstate; detail := sqlerrm; end if;
    end;
    res := res || pg_temp.rls_line('R2 anon run_ask_sql reads members', 'ERROR 42501', got, detail);

    -- Public data is public anyway (it's on the static site); documents it.
    detail := null;
    begin
      perform set_config('request.jwt.claims', '{"role":"anon"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('role', 'anon', true);
      execute 'select public.run_ask_sql($1)' using 'select count(*) as n from yumlog.recipes'::text;
      raise exception using errcode = 'YT001', message = 'sentinel';
    exception when others then
      if sqlstate = 'YT001' then got := 'no error'; else got := 'ERROR ' || sqlstate; detail := sqlerrm; end if;
    end;
    res := res || pg_temp.rls_line('R3 anon run_ask_sql reads recipes (public data)', 'no error', got, detail);

    detail := null;
    begin
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
      perform set_config('request.jwt.claim.sub', '', true);
      perform set_config('role', 'service_role', true);
      execute 'select public.run_ask_sql($1)' using 'select count(*) as n from yumlog.recipes'::text;
      raise exception using errcode = 'YT001', message = 'sentinel';
    exception when others then
      if sqlstate = 'YT001' then got := 'no error';
      else got := 'ERROR ' || sqlstate || case when sqlerrm like 'permission denied for schema yumlog%' then ' (schema)' else '' end;
           detail := sqlerrm;
      end if;
    end;
    res := res || pg_temp.rls_line('R4 service_role (/ask) run_ask_sql reads recipes', 'ERROR 42501 (schema)', got, detail);
  end if;

  -- -------------------------------------------------------------------------
  -- Report. Always raise, so nothing above is ever committed.
  -- -------------------------------------------------------------------------
  perform set_config('role', 'none', true);
  select count(*) filter (where l like 'PASS%'),
         count(*) filter (where l like 'FAIL%'),
         count(*) filter (where l like 'SKIP%')
    into n_pass, n_fail, n_skip
  from regexp_split_to_table(rtrim(res, chr(10)), chr(10)) as l;

  raise exception '%', format(E'RESULTS: %s PASS, %s FAIL, %s SKIP (webhook %s)\n%s',
                              n_pass, n_fail, n_skip,
                              case when webhook_on then 'on' else 'off' end, res);
end
$rls$;
