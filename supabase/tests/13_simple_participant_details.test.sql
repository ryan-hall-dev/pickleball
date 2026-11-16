-- New writes collect explicit details; historical nulls and logs remain intact.
-- Run in the parent's reviewed disposable rehearsal, never against hosted data.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a1300000-0000-4000-8000-000000000001', 'details-host@example.test'),
  ('a1300000-0000-4000-8000-000000000002', 'details-other@example.test'),
  ('a1300000-0000-4000-8000-000000000003', 'details-legacy@example.test');
insert into public.socials (id, name, checkin_tag) values
  ('51300000-0000-4000-8000-000000000001', 'Details', 'detailscheckin0001'),
  ('51300000-0000-4000-8000-000000000002', 'Other', 'detailscheckin0002'),
  ('51300000-0000-4000-8000-000000000003', 'Legacy', 'detailscheckin0003');
insert into public.hosts (user_id, display_name, social_id) values
  ('a1300000-0000-4000-8000-000000000001', 'Details Host', '51300000-0000-4000-8000-000000000001'),
  ('a1300000-0000-4000-8000-000000000002', 'Other Host', '51300000-0000-4000-8000-000000000002'),
  ('a1300000-0000-4000-8000-000000000003', 'Legacy Host', '51300000-0000-4000-8000-000000000003');
insert into public.sessions (id, social_id, host_id, name, host_name, planned_start, planned_end, config_snapshot) values
  ('d1300000-0000-4000-8000-000000000001', '51300000-0000-4000-8000-000000000001', 'a1300000-0000-4000-8000-000000000001', 'Details draft', 'Details Host', now(), now() + interval '2 hours', '{"courts":[{"courtId":"c1300000-0000-4000-8000-000000000001","name":"Court 1","format":"doubles"}]}'),
  ('d1300000-0000-4000-8000-000000000002', '51300000-0000-4000-8000-000000000002', 'a1300000-0000-4000-8000-000000000002', 'Other draft', 'Other Host', now(), now() + interval '2 hours', '{"courts":[]}'),
  ('d1300000-0000-4000-8000-000000000003', '51300000-0000-4000-8000-000000000003', 'a1300000-0000-4000-8000-000000000003', 'Legacy draft', 'Legacy Host', now(), now() + interval '2 hours', '{"courts":[]}');
insert into public.session_participants (id, session_id, social_id, first_name, last_name, skill_level) values
  ('e1300000-0000-4000-8000-000000000001', 'd1300000-0000-4000-8000-000000000001', '51300000-0000-4000-8000-000000000001', 'Old', 'Unknown', null),
  ('e1300000-0000-4000-8000-000000000002', 'd1300000-0000-4000-8000-000000000002', '51300000-0000-4000-8000-000000000002', 'Other', 'Unknown', null),
  ('e1300000-0000-4000-8000-000000000003', 'd1300000-0000-4000-8000-000000000003', '51300000-0000-4000-8000-000000000003', 'Legacy', 'Unknown', null);
insert into public.checkin_requests (id, session_id, social_id, first_name, last_name, skill_level, device_token_hash, ip_hash) values
  ('b1300000-0000-4000-8000-000000000001', 'd1300000-0000-4000-8000-000000000001', '51300000-0000-4000-8000-000000000001', 'Old', 'Request', 'beginner', repeat('a',64), repeat('b',64));

create function pg_temp.details_payload() returns jsonb language sql as $$
  select jsonb_build_object(
    'config', jsonb_build_object('policyVersion','simple-social-v1', 'courts', session.config_snapshot -> 'courts',
      'participants', (select coalesce(jsonb_agg(jsonb_build_object('participantId',id,'firstName',first_name,'lastName',last_name,'skill',skill_level,'gender',gender) order by id), '[]'::jsonb)
        from public.session_participants where session_id = session.id)),
    'initialAttendeeIds', (select coalesce(jsonb_agg(id::text order by id),'[]'::jsonb) from public.session_participants where session_id = session.id))
  from public.sessions session where session.id = 'd1300000-0000-4000-8000-000000000001';
$$;
grant execute on function pg_temp.details_payload() to service_role;

select col_is_null('public', 'session_participants', 'gender', 'historical participant gender remains nullable');
select col_is_null('public', 'checkin_requests', 'gender', 'historical request gender remains nullable');
select is((select count(*) from information_schema.columns where table_schema = 'public' and table_name in ('session_participants','checkin_requests') and column_name = 'gender' and column_default is not null), 0::bigint, 'no default fabricates historical gender');
select ok((select gender is null and skill_level is null from public.session_participants where id = 'e1300000-0000-4000-8000-000000000003'), 'legacy missing details remain unknown');

select is((select count(*) from pg_proc where oid in (
  'public.submit_checkin(text,uuid,text,text,text,text,public.skill_level,text)'::regprocedure,
  'public.add_draft_participant(uuid,uuid,uuid,text,text,public.skill_level,text)'::regprocedure,
  'public.add_participant_mid_session(uuid,uuid,uuid,text,text,public.skill_level,uuid,integer,timestamptz,text,boolean)'::regprocedure,
  'public.approve_checkin(uuid,uuid,uuid,uuid,integer,timestamptz,text)'::regprocedure,
  'public.start_session(uuid,uuid,uuid,timestamptz,jsonb,integer)'::regprocedure,
  'public.set_draft_participant_details(uuid,uuid,uuid,text,public.skill_level,integer)'::regprocedure,
  'public.list_checkin_requests_for_open_session(uuid)'::regprocedure,
  'public.append_session_event(uuid,uuid,uuid,integer,public.session_event_type,jsonb,timestamptz,jsonb)'::regprocedure
) and prosecdef and proconfig = array['search_path=""']
 and has_function_privilege('service_role',oid,'execute')
 and not has_function_privilege('anon',oid,'execute')
 and not has_function_privilege('authenticated',oid,'execute')), 8::bigint, 'all changed entry points are service-only security definers with empty search path');
select is(to_regprocedure('public.submit_checkin(text,uuid,text,text,text,text,public.skill_level)'), null::regprocedure, 'gender-free submit signature removed');
select is(to_regprocedure('public.add_draft_participant(uuid,uuid,uuid,text,text,public.skill_level)'), null::regprocedure, 'gender-free draft-add signature removed');
select is(to_regprocedure('public.add_participant_mid_session(uuid,uuid,uuid,text,text,public.skill_level,uuid,integer,timestamptz)'), null::regprocedure, 'gender-free live-add signature removed');
select is(to_regprocedure('public.approve_checkin(uuid,uuid,uuid,uuid,integer,timestamptz)'), null::regprocedure, 'old approval overload removed');
select is(to_regprocedure('public.start_session(uuid,uuid,uuid,timestamptz,jsonb)'), null::regprocedure, 'old start overload removed; defaulted revision preserves legacy calls');
select ok(not has_function_privilege('service_role','private.insert_session_participant(uuid,uuid,uuid,text,text,public.skill_level,text,boolean)','execute'), 'service role cannot execute private insert directly');
select ok(not has_function_privilege('anon','private.player_joined_payload(public.session_participants)','execute'), 'anon cannot execute payload helper');
select throws_ok($$update public.session_participants set gender = 'unknown' where id = 'e1300000-0000-4000-8000-000000000001'$$, '23514', null, 'participant gender has a database constraint');
select throws_ok($$update public.checkin_requests set gender = 'unknown' where id = 'b1300000-0000-4000-8000-000000000001'$$, '23514', null, 'request gender has a database constraint');

set local role service_role;
select throws_ok($$select public.submit_checkin('detailscheckin0001','d1300000-0000-4000-8000-000000000001',repeat('c',64),repeat('d',64),'New','Request','beginner',null)$$, '22023','INVALID_INPUT','new public request cannot omit gender');
select throws_ok($$select public.add_draft_participant('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),'New','Draft','beginner',null)$$, '22023','INVALID_INPUT','new host-add cannot omit gender');
select throws_ok($$select public.approve_checkin('a1300000-0000-4000-8000-000000000001','b1300000-0000-4000-8000-000000000001',gen_random_uuid())$$,'22023','INVALID_INPUT','legacy pending request requires explicit missing gender');
select throws_ok($$select public.set_draft_participant_details('a1300000-0000-4000-8000-000000000002','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','male','beginner',0)$$,'P0002','DRAFT_NOT_OPEN','another social cannot complete draft details');
select throws_ok($$select public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000002','male','beginner',0)$$,'22023','UNKNOWN_PARTICIPANT','setter scopes participant to the locked draft');
select is((select draft_revision from public.sessions where id = 'd1300000-0000-4000-8000-000000000001'),0,'failed cross-social edit does not bump revision');
select throws_ok($$select public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','male',null,0)$$,'22023','INVALID_INPUT','host must supply missing level too');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),pg_temp.details_payload())$$,'P0409','DRAFT_CHANGED_ELSEWHERE','new policy requires a checked revision');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),pg_temp.details_payload(),0)$$,'22023','INVALID_INPUT','new policy refuses missing stored details');
select is(public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','male','advanced',0),'{"status":"saved","draftRevision":1}'::jsonb,'explicit host detail completion bumps revision');
select throws_ok($$select public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','female','beginner',0)$$,'P0409','DRAFT_CHANGED_ELSEWHERE','stale co-host edit loses without overwriting');
select results_eq($$select first_name::text,last_name::text,gender,skill_level::text from public.session_participants where id='e1300000-0000-4000-8000-000000000001'$$,$$values ('Old','Unknown','male','advanced')$$,'detail edit preserves names and rejected edit preserves values');
select is(public.approve_checkin('a1300000-0000-4000-8000-000000000001','b1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000004',p_gender=>'female')->>'status','approved','host explicitly completes gender for old pending request');
select is((select gender from public.checkin_requests where id='b1300000-0000-4000-8000-000000000001'),null::text,'old request snapshot stays null rather than backfilled');
select is((select gender from public.session_participants where id='e1300000-0000-4000-8000-000000000004'),'female','approval uses explicit host gender');
select is(public.submit_checkin('detailscheckin0001','d1300000-0000-4000-8000-000000000001',repeat('c',64),repeat('d',64),'New','Request','beginner','female')->>'status','pending','new request records gender');
select is((select gender from public.list_checkin_requests_for_open_session('a1300000-0000-4000-8000-000000000001') where first_name='New'),'female','host tray exposes stored request gender');
select throws_ok($$select public.approve_checkin('a1300000-0000-4000-8000-000000000001',(select id from public.checkin_requests where first_name='New' and session_id='d1300000-0000-4000-8000-000000000001'),gen_random_uuid(),p_gender=>'male')$$,'22023','INVALID_INPUT','host cannot override a supplied gender');
select is(public.approve_checkin('a1300000-0000-4000-8000-000000000001',(select id from public.checkin_requests where first_name='New' and session_id='d1300000-0000-4000-8000-000000000001'),'e1300000-0000-4000-8000-000000000005')->>'status','approved','supplied request gender needs no override');

-- A second host could edit while a start is being prepared. Capture a client
-- snapshot, then exercise the lock/revision revalidation after another write.
create temp table stale_details_payload as select pg_temp.details_payload() as payload;
select is(public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','female','advanced',1)->>'draftRevision','2','another host can change details before start');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),(select payload from stale_details_payload),1)$$,'P0409','DRAFT_CHANGED_ELSEWHERE','stale revision cannot start');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),(select payload from stale_details_payload),2)$$,'P0001','STALE_DRAFT_ROSTER','even current revision cannot start a stale gender snapshot');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),jsonb_set(pg_temp.details_payload(),'{config,participants,0,firstName}','"Forged"'),2)$$,'P0001','STALE_DRAFT_ROSTER','names must match locked rows');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),jsonb_set(pg_temp.details_payload(),'{config,participants,0,skill}','"beginner"'),2)$$,'P0001','STALE_DRAFT_ROSTER','levels must match locked rows');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),jsonb_set(pg_temp.details_payload(),'{initialAttendeeIds}','[]'),2)$$,'P0001','STALE_DRAFT_ROSTER','attendees cannot omit draft participants');
select throws_ok($$select public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),now(),jsonb_set(pg_temp.details_payload(),'{config,courts,0,format}','"singles"'),2)$$,'22023','INVALID_PAYLOAD','new policy is doubles only');
select is((select status::text from public.sessions where id='d1300000-0000-4000-8000-000000000001'),'draft','failed starts preserve draft status');
select is((select count(*) from public.session_events where session_id='d1300000-0000-4000-8000-000000000001'),0::bigint,'failed starts write no events');
select is(public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','f1300000-0000-4000-8000-000000000001',now(),pg_temp.details_payload(),2)->>'status','appended','matching locked roster starts');
select is(public.start_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','f1300000-0000-4000-8000-000000000001',now(),'{}',null)->>'status','duplicate','start duplicate is checked before revision/payload/status');
select throws_ok($$select public.set_draft_participant_details('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001','male','advanced',2)$$,'P0002','DRAFT_NOT_OPEN','detail editor cannot change live snapshot');
select throws_ok($$select public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),'Late','Missing','beginner',gen_random_uuid(),1,now(),null)$$,'22023','INVALID_INPUT','new live participant needs gender');
select throws_ok($$select public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000006','Late','Stale','beginner',gen_random_uuid(),0,now(),'male')$$,'P0001','STALE_EXPECTED_SEQ','live add keeps sequence guard');
select is_empty($$select 1 from public.session_participants where id='e1300000-0000-4000-8000-000000000006'$$,'stale live add rolls back participant');
select is(public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000006','Late','Known','beginner','f1300000-0000-4000-8000-000000000002',1,now(),'male')->>'status','appended','live add inserts known gender and join atomically');
select is((select payload #>> '{participant,gender}' from public.session_events where event_id='f1300000-0000-4000-8000-000000000002'),'male','join payload includes stored gender');
select is(public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',null,null,null,null,'f1300000-0000-4000-8000-000000000002',0,now(),null)->>'status','duplicate','live add duplicate precedes detail validation');
select throws_ok($$select public.append_session_event('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),2,'PlayerJoined','{"participant":{"participantId":"e1300000-0000-4000-8000-000000000006","firstName":"Late","lastName":"Known","skill":"beginner","gender":"female"}}',now())$$,'22023','INVALID_PAYLOAD','generic join cannot forge stored gender');
select throws_ok($$select public.append_session_event('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),2,'PlayerJoined','{"participant":{"participantId":"e1300000-0000-4000-8000-000000000006","firstName":"Late","lastName":"Known","skill":"beginner"}}',now())$$,'22023','INVALID_PAYLOAD','generic join cannot omit gender');
select is(public.append_session_event('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','f1300000-0000-4000-8000-000000000002',0,'PlayerJoined','{}',now())->>'status','duplicate','generic duplicate precedes join validation');
select is(public.start_session('a1300000-0000-4000-8000-000000000003','d1300000-0000-4000-8000-000000000003',gen_random_uuid(),now(),'{"config":{"courts":[],"participants":[{"participantId":"e1300000-0000-4000-8000-000000000003"}]},"initialAttendeeIds":["e1300000-0000-4000-8000-000000000003"]}')->>'status','appended','legacy start still accepts historical missing details without policy upgrade');
select ok((select gender is null and skill_level is null from public.session_participants where id='e1300000-0000-4000-8000-000000000003'),'legacy missing fields remain untouched');
select ok((select not (config_snapshot ? 'policyVersion') from public.sessions where id='d1300000-0000-4000-8000-000000000003'),'legacy session is never implicitly upgraded');
-- Two different people may share a name when a host adds them live: UUID and event id identify them.
select throws_ok($$select public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001',gen_random_uuid(),'late','KNOWN','beginner',gen_random_uuid(),2,now(),'female')$$,'P0001','NAME_ALREADY_IN_SESSION','the default live add keeps the one-name rule');
select is(public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000007','Late','Known','beginner','f1300000-0000-4000-8000-000000000007',2,now(),'female',true)->>'status','appended','a host may add a second person with the same name');
select is(public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000008','Late','Known','intermediate','f1300000-0000-4000-8000-000000000008',3,now(),'male',true)->>'status','appended','and a third');
select is((select count(*) from public.session_participants where session_id='d1300000-0000-4000-8000-000000000001' and first_name='Late' and last_name='Known'),3::bigint,'three distinct participant rows share the name');
select is(public.add_participant_mid_session('a1300000-0000-4000-8000-000000000001','d1300000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000009','Late','Known','intermediate','f1300000-0000-4000-8000-000000000008',3,now(),'male',true)->>'session_participant_id','e1300000-0000-4000-8000-000000000008','a retried event id returns the original person');
select is((select count(*) from public.session_participants where session_id='d1300000-0000-4000-8000-000000000001' and first_name='Late' and last_name='Known'),3::bigint,'the retry added nobody');
select is((select count(*) from public.session_events where session_id='d1300000-0000-4000-8000-000000000001' and event_id in ('f1300000-0000-4000-8000-000000000007','f1300000-0000-4000-8000-000000000008')),2::bigint,'one join event per event id');
reset role;
select * from finish();
rollback;
