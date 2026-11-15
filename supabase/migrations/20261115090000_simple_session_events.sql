-- Engine-only event contract; no new write paths are enabled here.
alter type public.session_event_type add value 'NextGroupCalled';
alter type public.session_event_type add value 'NextGroupChanged';
alter type public.session_event_type add value 'NextGroupReleased';
