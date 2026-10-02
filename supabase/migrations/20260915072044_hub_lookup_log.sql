-- 20260915072044  hub_lookup_log
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

create table if not exists public.hub_lookup_log (
  id bigserial primary key,
  ip text not null,
  email text not null,
  at timestamptz not null default now()
);
create index if not exists hub_lookup_log_ip_at on public.hub_lookup_log (ip, at desc);
alter table public.hub_lookup_log enable row level security;
