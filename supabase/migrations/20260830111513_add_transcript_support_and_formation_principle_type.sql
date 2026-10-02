-- 20260830111513  add_transcript_support_and_formation_principle_type
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- 1. Transcript + provenance columns on resources
alter table public.resources add column if not exists transcript text;
alter table public.resources add column if not exists source_ref text;

comment on column public.resources.transcript is 'Full verbatim transcript text, when the resource originates from a recorded teaching.';
comment on column public.resources.source_ref is 'Origin identifier (e.g. Google Drive docId) for traceability back to the source.';

-- 2. Allow the new resource type
alter table public.resources drop constraint if exists resources_type_check;
alter table public.resources add constraint resources_type_check
  check (type = any (array[
    'sermon'::text,
    'dream_symbol'::text,
    'scripture'::text,
    'spiritual_gift'::text,
    'skill'::text,
    'formation_principle'::text,
    'other'::text
  ]));

-- 3. Full-text search across title + transcript
create index if not exists resources_transcript_fts
  on public.resources
  using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(transcript,'')));

-- 4. Lookup index for the principle sequence
create index if not exists resources_principle_number_idx
  on public.resources (((content->>'principleNumber')::int))
  where type = 'formation_principle';
