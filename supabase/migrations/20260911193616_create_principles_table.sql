-- 20260911193616  create_principles_table
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

create table if not exists public.principles (
  number int primary key check (number between 1 and 13),
  week_number int not null,
  statement text,
  title text,
  anchor_ref text,
  anchor_text text,
  memory_verse_ref text,
  teaching_md text,
  status text not null check (status in ('transcript','distilled','missing')),
  source_doc_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.principles is '13 Formation Principles from the summer 2026 Discovery series. teaching_md is the print-adapted Sunday-night teaching; status: transcript = adapted from full transcript, distilled = reconstructed from review sections, missing = no source material yet.';
alter table public.principles enable row level security;
create policy principles_select on public.principles for select to authenticated using (true);
create policy principles_insert_admin on public.principles for insert to authenticated
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
create policy principles_update_admin on public.principles for update to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'))
  with check (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
create policy principles_delete_admin on public.principles for delete to authenticated
  using (exists (select 1 from profiles where profiles.id = auth.uid() and profiles.role = 'admin'));
