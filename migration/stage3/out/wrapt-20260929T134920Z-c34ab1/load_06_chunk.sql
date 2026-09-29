-- yumlog load, run 20260929T134920Z-c34ab1: chunk 6 of 6 — shopping_list part 1/1
-- RUN IN: WRAPT project -> SQL Editor. Paste the whole file, Run.
-- Order doesn't matter and re-running a chunk is harmless. Then run load_99_swap.sql.
create table if not exists yumlog._load (
  run_id text not null,
  tbl text not null,
  part integer not null,
  body text not null,
  primary key (run_id, tbl, part)
);
alter table yumlog._load enable row level security;
revoke all on yumlog._load from public, anon, authenticated, service_role;
-- Leftovers from an earlier run (e.g. the rehearsal) can't mix in.
delete from yumlog._load where run_id <> '20260929T134920Z-c34ab1';
insert into yumlog._load (run_id, tbl, part, body)
values ('20260929T134920Z-c34ab1', 'shopping_list', 1, $yl_117641f30d71$[{"id": 88, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.144565+00:00", "position": 1, "quantity": 15, "ingredient": "coconut sugar", "updated_at": "2026-07-30T07:46:55.144565+00:00"}, {"id": 89, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.256288+00:00", "position": 2, "quantity": 30, "ingredient": "flaxseed meal", "updated_at": "2026-07-30T07:46:55.256288+00:00"}, {"id": 90, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.351927+00:00", "position": 3, "quantity": 45, "ingredient": "dried fruit", "updated_at": "2026-07-30T07:46:55.351927+00:00"}, {"id": 91, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.479452+00:00", "position": 4, "quantity": 60, "ingredient": "maple syrup", "updated_at": "2026-07-30T07:46:55.479452+00:00"}, {"id": 92, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.570032+00:00", "position": 5, "quantity": 420, "ingredient": "milk", "updated_at": "2026-07-30T07:46:55.570032+00:00"}, {"id": 93, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.659099+00:00", "position": 6, "quantity": 60, "ingredient": "neutral oil", "updated_at": "2026-07-30T07:46:55.659099+00:00"}, {"id": 94, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.758702+00:00", "position": 7, "quantity": 480, "ingredient": "oat", "updated_at": "2026-07-30T07:46:55.758702+00:00"}, {"id": 95, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.847562+00:00", "position": 8, "quantity": 1.25, "ingredient": "salt", "updated_at": "2026-07-30T07:46:55.847562+00:00"}, {"id": 96, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:55.951654+00:00", "position": 9, "quantity": 160.08, "ingredient": "shredded coconut", "updated_at": "2026-07-30T07:46:55.951654+00:00"}, {"id": 97, "unit": "g", "checked": false, "added_at": "2026-07-30T07:46:56.037204+00:00", "position": 10, "quantity": 160.08, "ingredient": "slivered almond", "updated_at": "2026-07-30T07:46:56.037204+00:00"}]$yl_117641f30d71$)
on conflict (run_id, tbl, part) do update set body = excluded.body;

select tbl, count(*) as parts_loaded, sum(length(body)) as chars
from yumlog._load where run_id = '20260929T134920Z-c34ab1' group by tbl order by tbl;
