-- 20260831014352  identity_cards_allow_declaration_type
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- A synthesised declaration is a third kind of card. It stores the declaration
-- AND a frozen copy of the material it was generated from, so it can be read
-- back, compared, or regenerated against the same inputs later.
alter table public.identity_cards drop constraint if exists identity_cards_card_type_check;
alter table public.identity_cards add constraint identity_cards_card_type_check
  check (card_type in ('worksheet_v1','discovery_v2','declaration'));

comment on column public.identity_cards.card_type is
  'worksheet_v1 = original seven-field worksheet (archived). discovery_v2 = Drawing the Picture. declaration = AI-synthesised declaration, with its source material frozen in payload.generatedFrom.';
