-- 20260530142007  add_devotional_views_counter
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Per-user view tracking
create table public.devotional_views (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  devotional_id uuid not null references public.devotionals(id) on delete cascade,
  viewed_at     timestamptz not null default now(),
  unique (user_id, devotional_id)
);

create index devotional_views_devotional_idx on public.devotional_views (devotional_id);

alter table public.devotional_views enable row level security;

-- Users can only see/write their own view rows
create policy devotional_views_select_own on public.devotional_views
  for select to authenticated using (user_id = auth.uid());

create policy devotional_views_insert_own on public.devotional_views
  for insert to authenticated with check (user_id = auth.uid());

-- SECURITY DEFINER function: exposes the aggregate count safely while RLS
-- keeps the raw rows private. Returns a single int — no PII can leak.
create or replace function public.devotional_view_count(p_devotional_id uuid)
returns int
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::int from public.devotional_views where devotional_id = p_devotional_id;
$$;

grant execute on function public.devotional_view_count(uuid) to authenticated;
