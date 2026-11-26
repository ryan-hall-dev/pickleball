-- Scores (migration 20261126150000): no ties, one standing score per game,
-- undoing the finish voids it, and each social sees only its own.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a1600000-0000-4000-8000-000000000001', 'scores-a@example.test'),
  ('a1600000-0000-4000-8000-000000000002', 'scores-b@example.test');
insert into public.socials (id, name) values
  ('51600000-0000-4000-8000-000000000001', 'Scores A'),
  ('51600000-0000-4000-8000-000000000002', 'Scores B');
insert into public.hosts (user_id, display_name, social_id) values
  ('a1600000-0000-4000-8000-000000000001', 'Host A', '51600000-0000-4000-8000-000000000001'),
  ('a1600000-0000-4000-8000-000000000002', 'Host B', '51600000-0000-4000-8000-000000000002');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, status, started_at) values
  ('d1600000-0000-4000-8000-000000000001', '51600000-0000-4000-8000-000000000001',
   'a1600000-0000-4000-8000-000000000001', 'Scores', 'Host A', now(), now() + interval '2 hours', 'live', now());
insert into public.matches (id, session_id, court_id, court_name, team_a, team_b, started_at, ended_at, duration_seconds, status) values
  ('f1600000-0000-4000-8000-000000000001', 'd1600000-0000-4000-8000-000000000001', gen_random_uuid(), 'Court 1',
   array[gen_random_uuid()], '{}', now(), now(), 600, 'completed');

set local role service_role;
select throws_ok(
  $$select public.host_set_match_score('a1600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001', 9, 9)$$,
  '22023', 'INVALID_SCORE', 'a tie is refused'
);
select throws_ok(
  $$select public.host_set_match_score('a1600000-0000-4000-8000-000000000002', 'f1600000-0000-4000-8000-000000000001', 11, 9)$$,
  'P0001', 'MATCH_NOT_FINISHED', 'another social''s host cannot score this game'
);
select is(
  public.host_set_match_score('a1600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001', 11, 9) ->> 'status',
  'recorded', 'a host records a score'
);
select is(
  public.host_set_match_score('a1600000-0000-4000-8000-000000000001', 'f1600000-0000-4000-8000-000000000001', 11, 7) ->> 'status',
  'corrected', 'a host corrects it'
);
reset role;

select set_config('request.jwt.claims', '{"sub":"a1600000-0000-4000-8000-000000000002","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.match_scores), 0::bigint, 'another social''s host sees no scores');
reset role;
select set_config('request.jwt.claims', '{"sub":"a1600000-0000-4000-8000-000000000001","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.match_scores), 1::bigint, 'the social''s own host sees its score');
reset role;

update public.matches set status = 'reverted' where id = 'f1600000-0000-4000-8000-000000000001';
select isnt(
  (select voided_at from public.match_scores where match_id = 'f1600000-0000-4000-8000-000000000001'),
  null, 'undoing the finish voids the score'
);

select * from finish();
rollback;
