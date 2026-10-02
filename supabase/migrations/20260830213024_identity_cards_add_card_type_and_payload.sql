-- 20260830213024  identity_cards_add_card_type_and_payload
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Let the new "Drawing the Picture" shape live beside the 16 backfilled worksheet cards.
alter table public.identity_cards
  add column if not exists card_type text not null default 'worksheet_v1',
  add column if not exists payload   jsonb not null default '{}'::jsonb;

alter table public.identity_cards drop constraint if exists identity_cards_card_type_check;
alter table public.identity_cards add constraint identity_cards_card_type_check
  check (card_type in ('worksheet_v1','discovery_v2'));

comment on column public.identity_cards.card_type is
  'worksheet_v1 = the original seven-field worksheet (archived). discovery_v2 = the Week 14 Drawing the Picture flow.';
comment on column public.identity_cards.payload is
  'discovery_v2 content: revelations, circled, season, namesAlreadyGiven, fields, fitsBest, name, instruction.';

create index if not exists identity_cards_type_idx on public.identity_cards (user_id, card_type);

-- Existing rows are all the old shape; make that explicit rather than relying on the default.
update public.identity_cards set card_type = 'worksheet_v1' where card_type is distinct from 'worksheet_v1';
