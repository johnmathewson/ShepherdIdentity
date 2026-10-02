-- 20260915064904  hub_apps_and_access
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

create table if not exists public.hub_apps (
  key            text primary key,
  name           text not null,
  handoff_url    text not null,
  landing_url    text not null,
  required_tags  text[] not null default '{}',
  enabled        boolean not null default true,
  created_at     timestamptz not null default now()
);
create table if not exists public.hub_access (
  email       text primary key,
  tags        text[] not null default '{}',
  source      text not null default 'manual',
  updated_at  timestamptz not null default now()
);
alter table public.hub_apps   enable row level security;
alter table public.hub_access enable row level security;
drop policy if exists "hub_apps readable by authenticated" on public.hub_apps;
create policy "hub_apps readable by authenticated" on public.hub_apps
  for select to authenticated using (enabled);
drop policy if exists "hub_access self read" on public.hub_access;
create policy "hub_access self read" on public.hub_access
  for select to authenticated using (email = lower(auth.jwt()->>'email'));
insert into public.hub_apps (key, name, handoff_url, landing_url, required_tags) values
  ('prayer-wall', 'Prayer Wall',
   'https://jyhjcsrpaaaddraeowjf.supabase.co/functions/v1/sso-handoff',
   'https://nwiprays.com/auth/continue',
   '{}')
on conflict (key) do update set handoff_url = excluded.handoff_url, landing_url = excluded.landing_url;
insert into public.hub_access (email, tags, source) values
  ('john@johnmathewson.co', '{#prayerteam}', 'manual')
on conflict (email) do nothing;
