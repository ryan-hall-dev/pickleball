-- Members directory search column (migration 20261109090000): search_name is
-- the lowercased, accent-stripped, whitespace-collapsed full name, kept in sync
-- by Postgres and never writable directly; hosts read it under RLS.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000061', 'pgtap-members-host@example.test'),
  ('a0000000-0000-4000-8000-000000000062', 'pgtap-members-outsider@example.test');
insert into public.hosts (user_id, display_name, role) values
  ('a0000000-0000-4000-8000-000000000061', 'Mel Members', 'host');
insert into public.members (id, first_name, last_name, skill_level) values
  ('b0000000-0000-4000-8000-000000000061', 'Élodie', 'Durand-Çelik', 'advanced'),
  ('b0000000-0000-4000-8000-000000000062', 'Anne  Marie', 'O''Brien', null),
  ('b0000000-0000-4000-8000-000000000063', 'ZOË', 'Ñúñez', 'beginner');

select has_column('public', 'members', 'search_name', 'members has search_name');
select col_not_null('public', 'members', 'search_name', 'search_name is never null');
select is(
  (select attgenerated::text from pg_attribute
   where attrelid = 'public.members'::regclass and attname = 'search_name'),
  's', 'search_name is a stored generated column'
);

select is(
  (select search_name from public.members where id = 'b0000000-0000-4000-8000-000000000061'),
  'elodie durand-celik', 'accents removed, lowercased, punctuation kept'
);
select is(
  (select search_name from public.members where id = 'b0000000-0000-4000-8000-000000000062'),
  'anne marie o''brien', 'internal whitespace collapsed to one space'
);
select is(
  (select search_name from public.members where id = 'b0000000-0000-4000-8000-000000000063'),
  'zoe nunez', 'uppercase accented letters fold too'
);

-- The server's search: contains, on first, last or full name.
select results_eq(
  $$select id from public.members where search_name like '%' || 'celik' || '%' order by id$$,
  $$values ('b0000000-0000-4000-8000-000000000061'::uuid)$$,
  'a contains search on the last name finds the member without accents'
);

update public.members set last_name = 'Lefèvre' where id = 'b0000000-0000-4000-8000-000000000061';
select is(
  (select search_name from public.members where id = 'b0000000-0000-4000-8000-000000000061'),
  'elodie lefevre', 'search_name follows name edits'
);

set local role service_role;
select throws_ok(
  $$update public.members set search_name = 'spoofed' where id = 'b0000000-0000-4000-8000-000000000061'$$,
  '428C9', null, 'search_name cannot be written directly, even by the server'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000061","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select search_name from public.members where id = 'b0000000-0000-4000-8000-000000000063'),
  'zoe nunez', 'a host reads search_name with their own session'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a0000000-0000-4000-8000-000000000062","role":"authenticated"}', true);
set local role authenticated;
select is_empty(
  $$select search_name from public.members$$,
  'a signed-in non-host reads no member names'
);
reset role;

select * from finish();
rollback;
