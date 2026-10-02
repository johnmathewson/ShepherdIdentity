-- 20260529000053  create_devotionals_and_notes
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Generic updated_at trigger function (idempotent)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- devotionals: one row per day; pre-loaded by admins
-- ─────────────────────────────────────────────────────────────
create table public.devotionals (
  id              uuid primary key default gen_random_uuid(),
  publish_date    date not null unique,
  title           text not null,
  teaser          text,
  scripture_ref   text,
  scripture_text  text,
  body            text,
  worship_video_url text,
  sermon_video_url  text,
  author          text,
  published       boolean not null default true,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index devotionals_publish_date_idx on public.devotionals (publish_date desc);

create trigger devotionals_set_updated_at
  before update on public.devotionals
  for each row execute function public.set_updated_at();

alter table public.devotionals enable row level security;

-- Members: read only past/today & published. Admins: read everything.
create policy devotionals_select on public.devotionals
  for select
  to authenticated
  using (
    (publish_date <= current_date and published = true)
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- Admins only: insert/update/delete
create policy devotionals_insert_admin on public.devotionals
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

create policy devotionals_update_admin on public.devotionals
  for update
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

create policy devotionals_delete_admin on public.devotionals
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'admin'
    )
  );

-- ─────────────────────────────────────────────────────────────
-- devotional_notes: per-user, per-devotional, synced across devices
-- ─────────────────────────────────────────────────────────────
create table public.devotional_notes (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  devotional_id   uuid not null references public.devotionals(id) on delete cascade,
  notes           text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, devotional_id)
);

create index devotional_notes_user_idx on public.devotional_notes (user_id);

create trigger devotional_notes_set_updated_at
  before update on public.devotional_notes
  for each row execute function public.set_updated_at();

alter table public.devotional_notes enable row level security;

-- Users only see/write their own notes
create policy devotional_notes_select_own on public.devotional_notes
  for select
  to authenticated
  using (user_id = auth.uid());

create policy devotional_notes_insert_own on public.devotional_notes
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy devotional_notes_update_own on public.devotional_notes
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy devotional_notes_delete_own on public.devotional_notes
  for delete
  to authenticated
  using (user_id = auth.uid());
