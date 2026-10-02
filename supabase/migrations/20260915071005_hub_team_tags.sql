-- 20260915071005  hub_team_tags
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

create table if not exists public.hub_team_tags (
  pco_team_name  text primary key,
  pco_team_id    text,
  tag            text not null,
  admin_tag      text,
  enabled        boolean not null default true
);
alter table public.hub_team_tags enable row level security;
drop policy if exists "hub_team_tags readable by authenticated" on public.hub_team_tags;
create policy "hub_team_tags readable by authenticated" on public.hub_team_tags
  for select to authenticated using (enabled);
create table if not exists public.hub_pco_teams (
  pco_team_id   text primary key,
  name          text not null,
  service_type  text,
  archived      boolean not null default false,
  synced_at     timestamptz not null default now()
);
alter table public.hub_pco_teams enable row level security;
alter table public.hub_access
  add column if not exists pco_person_id text,
  add column if not exists teams jsonb not null default '[]'::jsonb,
  add column if not exists pco_synced_at timestamptz;
insert into public.hub_team_tags (pco_team_name, tag, admin_tag) values
  ('Worship',       '#worship',      '#worshipadmin'),
  ('Safety',        '#safety',       null),
  ('Prayer Team',   '#prayerteam',   null),
  ('Go Find Jesus', '#gofindjesus',  '#gofindjesusadmin'),
  ('The Flock',     '#flock',        null),
  ('The Fold',      '#thefold',      null)
on conflict (pco_team_name) do nothing;
