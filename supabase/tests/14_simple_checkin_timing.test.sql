-- Transaction-only fixtures for get_checkin_page timing (migrations 20261115110000, 20261115120000).
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id,email) values ('a1400000-0000-4000-8000-000000000001','timing@example.test');
insert into public.socials (id,name,checkin_tag) values
  ('51400000-0000-4000-8000-000000000001','Timing social','timingcheckin0001'),
  ('51400000-0000-4000-8000-000000000002','Other timing social','timingcheckin0002');
insert into public.hosts(user_id,display_name,social_id) values
  ('a1400000-0000-4000-8000-000000000001','Timing host','51400000-0000-4000-8000-000000000001');
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000001','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Timing session','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','{"courts":[]}');
insert into public.checkin_requests(id,session_id,social_id,first_name,last_name,skill_level,gender,device_token_hash,ip_hash) values
  ('b1400000-0000-4000-8000-000000000001','d1400000-0000-4000-8000-000000000001','51400000-0000-4000-8000-000000000001','Private','Player','beginner','female',repeat('a',64),repeat('b',64));

select ok((select prosecdef and proconfig = array['search_path=""'] from pg_proc where oid = 'public.get_checkin_page(text,text)'::regprocedure),'page read remains security definer with empty search path');
select ok(has_function_privilege('service_role','public.get_checkin_page(text,text)','execute'),'service role can read page');
select ok(not has_function_privilege('anon','public.get_checkin_page(text,text)','execute'),'anon cannot execute directly');
select ok(not has_function_privilege('authenticated','public.get_checkin_page(text,text)','execute'),'authenticated cannot execute directly');
select is(public.get_checkin_page('timingcheckin0001',null)#>>'{session,status}','draft','past placeholder does not make draft live');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,duration_minutes}')::numeric,75::numeric,'draft shows chosen duration');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,started_at}','null'::jsonb,'draft has no actual start');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,ends_at}','null'::jsonb,'draft has no actual end');
select is(public.get_checkin_page('timingcheckin0001',null)#>>'{session,id}','d1400000-0000-4000-8000-000000000001','session id retained for scoped cookie');
select is(public.get_checkin_page('timingcheckin0001',repeat('a',64))#>>'{current_request,first_name}','Private','own request still available');
select is(public.get_checkin_page('timingcheckin0001',repeat('c',64))->'current_request','null'::jsonb,'another phone sees no private request');
select is(public.get_checkin_page('timingcheckin0002',repeat('a',64))->>'status','no_open_session','other social does not find this session');
select is(public.get_checkin_page('notavalidtag00000',null)->>'status','inactive','unknown tag stays inactive');

update public.sessions set status='live',started_at='2026-11-15T15:00:00Z',config_snapshot='{"policyVersion":"simple-social-v1","plannedDurationMinutes":90,"courts":[]}' where id='d1400000-0000-4000-8000-000000000001';
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,started_at}')::timestamptz,'2026-11-15T15:00:00Z'::timestamptz,'simple live exposes actual start');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,ends_at}')::timestamptz,'2026-11-15T16:30:00Z'::timestamptz,'simple live deadline uses actual start plus saved duration');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,duration_minutes}')::numeric,90::numeric,'live uses saved duration instead of placeholder');
select is((select planned_start from public.sessions where id='d1400000-0000-4000-8000-000000000001'),'2026-11-14T10:00:00Z'::timestamptz,'read never rewrites historical placeholder start');
select is((select planned_end from public.sessions where id='d1400000-0000-4000-8000-000000000001'),'2026-11-14T11:15:00Z'::timestamptz,'read never rewrites historical placeholder end');
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000001';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,status,started_at,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000002','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Legacy with duration','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','live','2026-11-15T15:00:00Z','{"plannedDurationMinutes":60,"courts":[]}');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,ends_at}')::timestamptz,'2026-11-15T16:00:00Z'::timestamptz,'legacy live uses saved duration and actual start');
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000002';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,status,started_at,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000003','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Legacy without duration','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','live','2026-11-15T15:00:00Z','{"courts":[]}');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,ends_at}')::timestamptz,'2026-11-15T16:15:00Z'::timestamptz,'legacy missing duration uses preserved planned duration');
select throws_ok($$update public.sessions set started_at=null where id='d1400000-0000-4000-8000-000000000003'$$,'23514',null,'live sessions require an actual start timestamp');

-- An out-of-range duration hides the duration and end instead of raising.
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000003';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000004','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','One second draft','Timing host','2026-11-14T10:00:00Z','2026-11-14T10:00:01Z','{"courts":[]}');
select lives_ok($$select public.get_checkin_page('timingcheckin0001',null)$$,'sub-minute draft duration does not raise');
select is(public.get_checkin_page('timingcheckin0001',null)->>'status','open','sub-minute draft page stays open');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,duration_minutes}','null'::jsonb,'sub-minute draft duration is null');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,ends_at}','null'::jsonb,'sub-minute draft has no end');
update public.sessions set status='live',started_at='2026-11-15T15:00:00Z' where id='d1400000-0000-4000-8000-000000000004';
select lives_ok($$select public.get_checkin_page('timingcheckin0001',null)$$,'sub-minute live duration does not raise');
select is(public.get_checkin_page('timingcheckin0001',null)#>>'{session,status}','live','sub-minute live session still shown as live');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,duration_minutes}','null'::jsonb,'sub-minute live duration is null');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,ends_at}','null'::jsonb,'sub-minute live has no invented end');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,started_at}')::timestamptz,'2026-11-15T15:00:00Z'::timestamptz,'sub-minute live keeps actual start');
-- Saved live durations outside 1..720 minutes are hidden too; 720 is still valid.
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000004';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,status,started_at,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000005','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Over-long live','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','live','2026-11-15T15:00:00Z','{"plannedDurationMinutes":721,"courts":[]}');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,duration_minutes}','null'::jsonb,'over-720 saved duration is null');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,ends_at}','null'::jsonb,'over-720 saved duration has no end');
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000005';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,status,started_at,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000006','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Zero live','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','live','2026-11-15T15:00:00Z','{"plannedDurationMinutes":0,"courts":[]}');
select is(public.get_checkin_page('timingcheckin0001',null)#>'{session,duration_minutes}','null'::jsonb,'zero saved duration is null');
update public.sessions set status='ended',ended_at='2026-11-15T17:00:00Z' where id='d1400000-0000-4000-8000-000000000006';
insert into public.sessions(id,social_id,host_id,name,host_name,planned_start,planned_end,status,started_at,config_snapshot) values
  ('d1400000-0000-4000-8000-000000000007','51400000-0000-4000-8000-000000000001','a1400000-0000-4000-8000-000000000001','Max live','Timing host','2026-11-14T10:00:00Z','2026-11-14T11:15:00Z','live','2026-11-15T15:00:00Z','{"plannedDurationMinutes":720,"courts":[]}');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,duration_minutes}')::numeric,720::numeric,'720 minutes is still a valid duration');
select is((public.get_checkin_page('timingcheckin0001',null)#>>'{session,ends_at}')::timestamptz,'2026-11-16T03:00:00Z'::timestamptz,'720 minutes keeps its end');

select * from finish();
rollback;
