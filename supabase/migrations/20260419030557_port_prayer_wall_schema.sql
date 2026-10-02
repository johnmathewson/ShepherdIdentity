-- 20260419030557  port_prayer_wall_schema
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- ============================================================
-- Port Prayer Wall schema from kugzjuggexyugpfflmyy (Prayer-Requests project)
-- into epkuvykamufrrgbacbel (Identity Tool / unified hub project).
-- ============================================================

-- visitors: end users who submit prayer requests.
-- auth_user_id links to auth.users — same as Identity Tool users.
create table if not exists public.visitors (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email text unique,
  auth_token uuid default gen_random_uuid(),
  created_at timestamptz default now(),
  auth_user_id uuid references auth.users(id) on delete cascade,
  email_notifications boolean default true,
  planning_center_id text
);

-- team_members: Shepherd prayer team (manages requests).
create table if not exists public.team_members (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email text unique,
  role text default 'member' check (role in ('member','admin')),
  approved boolean default false,
  auth_token uuid default gen_random_uuid(),
  created_at timestamptz default now(),
  planning_center_id text,
  auth_user_id uuid references auth.users(id) on delete cascade
);

-- prayer_requests: submitted by visitors.
create table if not exists public.prayer_requests (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid references public.visitors(id) on delete cascade,
  category text check (category in ('spiritual','emotional','physical','other')),
  title text,
  description text,
  status text default 'pending' check (status in ('pending','active','completed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- prayer_pickups: log of team members picking up a request.
create table if not exists public.prayer_pickups (
  id uuid primary key default gen_random_uuid(),
  prayer_request_id uuid references public.prayer_requests(id) on delete cascade,
  team_member_id uuid references public.team_members(id) on delete cascade,
  created_at timestamptz default now()
);

-- prophetic_words: encouragement left by team members.
create table if not exists public.prophetic_words (
  id uuid primary key default gen_random_uuid(),
  prayer_request_id uuid references public.prayer_requests(id) on delete cascade,
  team_member_id uuid references public.team_members(id) on delete cascade,
  content text,
  created_at timestamptz default now()
);

-- notifications: for visitors (pickup + prophetic_word alerts).
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid references public.visitors(id) on delete cascade,
  prayer_request_id uuid references public.prayer_requests(id) on delete cascade,
  type text check (type in ('pickup','prophetic_word')),
  message text,
  read boolean default false,
  created_at timestamptz default now()
);

-- Enable RLS on all tables.
alter table public.visitors enable row level security;
alter table public.team_members enable row level security;
alter table public.prayer_requests enable row level security;
alter table public.prayer_pickups enable row level security;
alter table public.prophetic_words enable row level security;
alter table public.notifications enable row level security;

-- ============================================================
-- RLS policies (ported from Prayer-Requests project)
-- ============================================================

-- visitors: users manage only their own row (matched by auth_user_id).
create policy visitors_insert_own on public.visitors
  for insert with check (auth_user_id = auth.uid());
create policy visitors_select_own on public.visitors
  for select using (auth_user_id = auth.uid());
create policy visitors_update_own on public.visitors
  for update using (auth_user_id = auth.uid());

-- team_members: NO anon/authenticated policies — managed only via service_role.
-- (Faithful port: original project also had RLS enabled with zero policies.)

-- prayer_requests: visitors can create and view their own requests.
create policy prayer_requests_visitor_insert on public.prayer_requests
  for insert with check (
    visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
  );
create policy prayer_requests_visitor_select on public.prayer_requests
  for select using (
    visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
  );

-- prayer_pickups: visitors can see pickups on their own requests.
create policy prayer_pickups_visitor_select on public.prayer_pickups
  for select using (
    prayer_request_id in (
      select id from public.prayer_requests
      where visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
    )
  );

-- prophetic_words: visitors can see words left on their own requests.
create policy prophetic_words_visitor_select on public.prophetic_words
  for select using (
    prayer_request_id in (
      select id from public.prayer_requests
      where visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
    )
  );

-- notifications: visitors can see + mark-read their own notifications.
create policy notifications_visitor_select on public.notifications
  for select using (
    visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
  );
create policy notifications_visitor_update on public.notifications
  for update using (
    visitor_id in (select id from public.visitors where auth_user_id = auth.uid())
  );
