-- =============================================================================
-- hotfix_revoke_anon_rpc.sql  --  OPTIONAL, run only with Tim's approval
--
-- RUN IN:  the YUMLOG Supabase project (ref nrmimftrjulvsgonrlzg)
-- WHY:     merge_ingredients and touch_recipes_for_ingredient are SECURITY DEFINER
--          (they bypass RLS) and are currently executable by PUBLIC and anon
--          (01_yumlog_schema.sql output, section 08). Anyone holding the public anon
--          key can merge/delete ingredients or spam site rebuilds via the recipes
--          webhook. The app only calls them while logged in, so authenticated keeps
--          its grant and nothing in the app changes.
-- IDEMPOTENT: revoking an absent privilege is a no-op; safe to re-run.
-- ROLLBACK:   grant execute on function public.merge_ingredients(text, text) to anon, public;
--             grant execute on function public.touch_recipes_for_ingredient(text) to anon, public;
-- =============================================================================
revoke execute on function public.merge_ingredients(text, text) from public, anon;
revoke execute on function public.touch_recipes_for_ingredient(text) from public, anon;

-- Verify (this is the result the editor shows): anon=false, authenticated=true.
select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('merge_ingredients', 'touch_recipes_for_ingredient');
