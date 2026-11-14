-- One name per session (session-only participants, 20261112090000): the
-- unique index on (session_id, normalised full name) is the database
-- guarantee behind every write path's NAME_ALREADY_IN_SESSION. Case, accents
-- and spacing are ignored; the same name in another session is fine.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into public.socials (id, name) values ('50000000-0000-4000-8000-000000000006', 'pgTAP Social');
insert into public.sessions (id, social_id, name, host_name, planned_start, planned_end, status) values
  ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Tuesday social', 'Hal Host', now(), now() + interval '2 hours', 'draft'),
  ('d0000000-0000-4000-8000-000000000062', '50000000-0000-4000-8000-000000000006', 'Last week', 'Hal Host', now() - interval '7 days', now() - interval '7 days' + interval '2 hours', 'cancelled');
insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level) values
  ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Élodie', 'Durand', 'advanced'),
  ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Anne Marie', 'O''Brien', 'beginner');

select is(
  (select indisunique from pg_index where indexrelid = 'public.session_participants_unique_name_per_session_idx'::regclass),
  true,
  'session_participants has a unique name-per-session index'
);
select is(
  (select provolatile::text from pg_proc where oid = 'private.normalise_name_for_search(text)'::regprocedure),
  'i',
  'the name normaliser is immutable (required for the index)'
);
select is(
  private.normalise_name_for_search('  ÉLODIE   durand '),
  'elodie durand',
  'the normaliser folds case, accents and spacing'
);

select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'elodie', 'DURAND', 'beginner')$$,
  '23505', null, 'the same name in another case is refused in the same session'
);
select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Elodie', 'Durand', 'beginner')$$,
  '23505', null, 'the same name without accents is refused in the same session'
);
select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Anne  Marie', 'O''Brien', 'beginner')$$,
  '23505', null, 'the same name with extra inner spaces is refused in the same session'
);
-- The full name is what counts, however it is split between the two fields.
select throws_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Anne', 'Marie O''Brien', 'beginner')$$,
  '23505', null, 'the same full name split differently is refused in the same session'
);
select lives_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000061', '50000000-0000-4000-8000-000000000006', 'Élodie', 'Durand B', 'beginner')$$,
  'a distinguishing initial makes a different name'
);
select lives_ok(
  $$insert into public.session_participants (session_id, social_id, first_name, last_name, skill_level)
    values ('d0000000-0000-4000-8000-000000000062', '50000000-0000-4000-8000-000000000006', 'Élodie', 'Durand', 'beginner')$$,
  'the same name is fine in another session'
);
select is(
  (select count(*) from public.session_participants where session_id = 'd0000000-0000-4000-8000-000000000061'),
  3::bigint,
  'only the distinct names were added'
);

select * from finish();
rollback;
