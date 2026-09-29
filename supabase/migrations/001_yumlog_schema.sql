-- =============================================================================
-- 001_yumlog_schema.sql  --  yumlog schema, tables, constraints, FK indexes,
--                            members allowlist, shopping_list updated_at trigger
--
-- PURPOSE:    Yumlog's data lives in its own `yumlog` schema inside wrapt's
--             Supabase project (see CLAUDE.md "Database schema"). This file
--             creates the objects only; who may touch them is 002.
--             Tables, columns (incl. column order), defaults, identity, the
--             category CHECK and the FKs match the old yumlog project's live
--             `public` schema exactly (migration/stage1 facts, 2026-09-28),
--             with the FKs repointed at yumlog.*. New vs the old project:
--             three FK indexes and yumlog.members.
-- RUN IN:     wrapt's Supabase project -> SQL Editor -> New query -> paste all -> Run.
--             Run order: 001 -> 002 -> 003 -> 004 (005 is optional).
-- IDEMPOTENT: yes. `if not exists` / `create or replace` / drop-then-create
--             throughout; safe to re-run. It never alters an existing table's
--             columns, so re-running is not a way to change them.
-- RESULT:     the last statement is a verification SELECT (one grid). Every row
--             should read status = OK.
-- ROLLBACK:   drop schema yumlog cascade;   (destroys all yumlog data)
-- =============================================================================

create schema if not exists yumlog;

-- Postgres grants EXECUTE on every new function to PUBLIC. Supabase's usual
-- schema-level default ACLs exist only for `public`, so nothing else is
-- granted by accident here. Note: per the ALTER DEFAULT PRIVILEGES docs, a
-- per-schema REVOKE cannot remove the built-in global PUBLIC default, so this
-- line alone does not stop PUBLIC getting EXECUTE — the explicit REVOKEs after
-- each function (here, 002 and 003) do that, and the verification SELECTs
-- prove it. Kept as the documented intent, and harmless.
alter default privileges for role postgres in schema yumlog
  revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Tables (FK order: ingredients, recipes, recipe_ingredients, shopping_list)
-- ---------------------------------------------------------------------------

-- Canonical ingredient registry (one row per normalised name).
create table if not exists yumlog.ingredients (
  name      text not null,
  category  text,              -- shopping-list aisle; null = valid in recipes but not shopped
  constraint ingredients_pkey primary key (name),
  constraint ingredients_category_check check (
    category is null or category = any (array[
      'fresh produce'::text, 'fridge'::text, 'freezer'::text, 'snacks'::text,
      'baking'::text, 'international food'::text, 'breakfast'::text, 'drinks'::text,
      'spices'::text, 'tinned'::text, 'other pantry'::text
    ])
  )
);

-- Recipes, keyed by a readable slug. Column order matches the old project
-- (tips / substitutions / updated_at were added later, hence their position).
create table if not exists yumlog.recipes (
  slug           text not null,
  title          text not null,
  category       text,
  protein        text,
  cook_time_min  integer,
  method         text not null,
  source_url     text,
  created_at     timestamptz default now(),
  tips           text,
  substitutions  text,
  updated_at     timestamptz not null default now(),   -- bumped to trigger rebuilds (003)
  constraint recipes_pkey primary key (slug)
);

-- Per-recipe ingredient lines.
create table if not exists yumlog.recipe_ingredients (
  id            bigint generated always as identity,
  recipe_slug   text not null,
  ingredient    text not null,
  display_name  text,
  quantity      numeric,
  unit          text,
  constraint recipe_ingredients_pkey primary key (id),
  constraint recipe_ingredients_recipe_slug_fkey foreign key (recipe_slug)
    references yumlog.recipes (slug) on delete cascade,
  constraint recipe_ingredients_ingredient_fkey foreign key (ingredient)
    references yumlog.ingredients (name) on update cascade on delete restrict
);

-- The single shared shopping list.
create table if not exists yumlog.shopping_list (
  id          bigint generated always as identity,
  ingredient  text not null,
  quantity    numeric,
  unit        text,
  checked     boolean not null default false,
  position    integer,
  added_at    timestamptz default now(),
  updated_at  timestamptz not null default now(),
  constraint shopping_list_pkey primary key (id),
  constraint shopping_list_ingredient_fkey foreign key (ingredient)
    references yumlog.ingredients (name) on update cascade on delete restrict
);

-- FK indexes (none existed in the old project). Cascades on rename and the
-- per-recipe ingredient reads both use them.
create index if not exists recipe_ingredients_recipe_slug_idx on yumlog.recipe_ingredients (recipe_slug);
create index if not exists recipe_ingredients_ingredient_idx  on yumlog.recipe_ingredients (ingredient);
create index if not exists shopping_list_ingredient_idx       on yumlog.shopping_list (ingredient);

-- Who may write. Wrapt has public sign-ups, so "authenticated" is not enough;
-- only auth users listed here are yumlog members (see 002 is_member()).
-- RLS on with NO policies and (002) NO grants: only postgres can read or
-- change it, via the SQL editor.
create table if not exists yumlog.members (
  user_id   uuid not null,
  note      text,
  added_at  timestamptz not null default now(),
  constraint members_pkey primary key (user_id),
  constraint members_user_id_fkey foreign key (user_id)
    references auth.users (id) on delete cascade
);

alter table yumlog.ingredients        enable row level security;
alter table yumlog.recipes            enable row level security;
alter table yumlog.recipe_ingredients enable row level security;
alter table yumlog.shopping_list      enable row level security;
alter table yumlog.members            enable row level security;

-- ---------------------------------------------------------------------------
-- shopping_list.updated_at auto-touch (drives "Shopping list last changed")
-- ---------------------------------------------------------------------------

create or replace function yumlog.shopping_list_set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Trigger-only: nobody needs to call it directly (EXECUTE isn't checked when
-- a trigger fires).
revoke execute on function yumlog.shopping_list_set_updated_at() from public, anon, authenticated, service_role;

drop trigger if exists shopping_list_set_updated_at on yumlog.shopping_list;
create trigger shopping_list_set_updated_at
  before update on yumlog.shopping_list
  for each row execute function yumlog.shopping_list_set_updated_at();

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification (the grid the editor shows). Every row: status = OK.
-- ---------------------------------------------------------------------------
with
expected_cols(tbl, cols) as (
  values
    ('ingredients',        'name text NOT NULL | category text NULL'),
    ('recipes',            'slug text NOT NULL | title text NOT NULL | category text NULL | protein text NULL | cook_time_min integer NULL | method text NOT NULL | source_url text NULL | created_at timestamp with time zone NULL DEFAULT now() | tips text NULL | substitutions text NULL | updated_at timestamp with time zone NOT NULL DEFAULT now()'),
    ('recipe_ingredients', 'id bigint NOT NULL IDENTITY ALWAYS | recipe_slug text NOT NULL | ingredient text NOT NULL | display_name text NULL | quantity numeric NULL | unit text NULL'),
    ('shopping_list',      'id bigint NOT NULL IDENTITY ALWAYS | ingredient text NOT NULL | quantity numeric NULL | unit text NULL | checked boolean NOT NULL DEFAULT false | position integer NULL | added_at timestamp with time zone NULL DEFAULT now() | updated_at timestamp with time zone NOT NULL DEFAULT now()'),
    ('members',            'user_id uuid NOT NULL | note text NULL | added_at timestamp with time zone NOT NULL DEFAULT now()')
),
actual_cols as (
  select c.relname::text as tbl,
         string_agg(
           a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
           || case when a.attnotnull then ' NOT NULL' else ' NULL' end
           || coalesce(' DEFAULT ' || pg_get_expr(ad.adbin, ad.adrelid), '')
           || case a.attidentity when 'a' then ' IDENTITY ALWAYS' when 'd' then ' IDENTITY BY DEFAULT' else '' end,
           ' | ' order by a.attnum) as cols
  from pg_class c
  join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
  where c.relnamespace = to_regnamespace('yumlog') and c.relkind = 'r'
  group by c.relname
),
expected_cons(name, def) as (
  values
    ('ingredients.ingredients_pkey',                           'PRIMARY KEY (name)'),
    ('ingredients.ingredients_category_check',                 'CHECK (category IS NULL OR (category = ANY (ARRAY[''fresh produce''::text, ''fridge''::text, ''freezer''::text, ''snacks''::text, ''baking''::text, ''international food''::text, ''breakfast''::text, ''drinks''::text, ''spices''::text, ''tinned''::text, ''other pantry''::text])))'),
    ('recipes.recipes_pkey',                                   'PRIMARY KEY (slug)'),
    ('recipe_ingredients.recipe_ingredients_pkey',             'PRIMARY KEY (id)'),
    ('recipe_ingredients.recipe_ingredients_recipe_slug_fkey', 'FOREIGN KEY (recipe_slug) REFERENCES yumlog.recipes(slug) ON DELETE CASCADE'),
    ('recipe_ingredients.recipe_ingredients_ingredient_fkey',  'FOREIGN KEY (ingredient) REFERENCES yumlog.ingredients(name) ON UPDATE CASCADE ON DELETE RESTRICT'),
    ('shopping_list.shopping_list_pkey',                       'PRIMARY KEY (id)'),
    ('shopping_list.shopping_list_ingredient_fkey',            'FOREIGN KEY (ingredient) REFERENCES yumlog.ingredients(name) ON UPDATE CASCADE ON DELETE RESTRICT'),
    ('members.members_pkey',                                   'PRIMARY KEY (user_id)'),
    ('members.members_user_id_fkey',                           'FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE')
),
report(ord, item, expected, actual) as (
  select 1, 'schema yumlog exists', 'true', (to_regnamespace('yumlog') is not null)::text
  union all
  select 2, 'schema owner', 'postgres',
         coalesce((select pg_get_userbyid(n.nspowner)::text from pg_namespace n where n.nspname = 'yumlog'), '<none>')
  -- columns, in order, per table (pg_get_constraintdef qualifies names outside
  -- the search_path, so FKs read yumlog.* / auth.* below)
  union all
  select 10, 'columns ' || e.tbl, e.cols, coalesce(a.cols, '<table missing>')
  from expected_cols e left join actual_cols a on a.tbl = e.tbl
  union all
  select 20, 'constraint ' || e.name, e.def,
         coalesce((select pg_get_constraintdef(co.oid, true)
                   from pg_constraint co
                   where co.conrelid = to_regclass('yumlog.' || split_part(e.name, '.', 1))
                     and co.conname = split_part(e.name, '.', 2)), '<missing>')
  from expected_cons e
  union all
  select 30, 'constraint count (all 5 tables)', '10',
         (select count(*) from pg_constraint co
          join pg_class c on c.oid = co.conrelid
          where c.relnamespace = to_regnamespace('yumlog')
            and co.contype in ('p', 'f', 'c', 'u'))::text
  union all
  select 40, 'index ' || i.idx, 'present',
         case when to_regclass('yumlog.' || i.idx) is null then '<missing>' else 'present' end
  from (values ('recipe_ingredients_recipe_slug_idx'), ('recipe_ingredients_ingredient_idx'),
               ('shopping_list_ingredient_idx')) as i(idx)
  union all
  select 50, 'RLS enabled ' || c.relname, 'true', c.relrowsecurity::text
  from pg_class c
  where c.relnamespace = to_regnamespace('yumlog') and c.relkind = 'r'
  union all
  select 60, 'identity sequence ' || s.seq, 'present',
         case when to_regclass('yumlog.' || s.seq) is null then '<missing>' else 'present' end
  from (values ('recipe_ingredients_id_seq'), ('shopping_list_id_seq')) as s(seq)
  union all
  select 70, 'trigger shopping_list_set_updated_at', 'BEFORE UPDATE FOR EACH ROW',
         coalesce((select case when (tg.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end
                          || case when (tg.tgtype & 16) <> 0 then ' UPDATE' else ' <not update>' end
                          || case when (tg.tgtype & 1) <> 0 then ' FOR EACH ROW' else ' FOR EACH STATEMENT' end
                   from pg_trigger tg
                   where tg.tgrelid = to_regclass('yumlog.shopping_list')
                     and tg.tgname = 'shopping_list_set_updated_at'), '<missing>')
  union all
  select 80, 'fn shopping_list_set_updated_at: definer / search_path', 'false / search_path=""',
         coalesce((select p.prosecdef::text || ' / ' || coalesce(array_to_string(p.proconfig, ','), '<none>')
                   from pg_proc p
                   where p.oid = to_regprocedure('yumlog.shopping_list_set_updated_at()')), '<missing>')
  union all
  select 81, 'fn shopping_list_set_updated_at: EXECUTE public/anon/authenticated/service_role',
         'false/false/false/false',
         coalesce((select has_function_privilege('public', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('anon', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                          || '/' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
                   from pg_proc p
                   where p.oid = to_regprocedure('yumlog.shopping_list_set_updated_at()')), '<missing>')
)
select ord, item, expected, actual,
       case when expected = actual then 'OK' else 'MISMATCH' end as status
from report
order by ord, item;
