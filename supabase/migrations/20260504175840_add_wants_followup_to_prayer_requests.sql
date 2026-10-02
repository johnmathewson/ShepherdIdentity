-- 20260504175840  add_wants_followup_to_prayer_requests
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

alter table prayer_requests
  add column if not exists wants_followup boolean not null default false;

comment on column prayer_requests.wants_followup is
  'Submitter has explicitly opted in to pastoral follow-up. When false (default), admin views show the request anonymously.';

create index if not exists prayer_requests_wants_followup_idx
  on prayer_requests (wants_followup) where wants_followup = true;
