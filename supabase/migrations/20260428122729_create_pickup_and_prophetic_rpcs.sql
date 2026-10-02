-- 20260428122729  create_pickup_and_prophetic_rpcs
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Pickup a prayer request (idempotent: if same team member already picked it up, return existing)
CREATE OR REPLACE FUNCTION pickup_prayer_request(
  p_request_id UUID,
  p_team_member_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pickup prayer_pickups;
  v_request prayer_requests;
  v_existing_count INT;
BEGIN
  SELECT * INTO v_request FROM prayer_requests WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN json_build_object('error', 'request_not_found');
  END IF;

  -- Insert pickup (idempotent on (request, team_member))
  INSERT INTO prayer_pickups (prayer_request_id, team_member_id)
  VALUES (p_request_id, p_team_member_id)
  ON CONFLICT (prayer_request_id, team_member_id) DO NOTHING
  RETURNING * INTO v_pickup;

  -- Mark request active when first picked up
  IF v_request.status = 'pending' THEN
    UPDATE prayer_requests SET status = 'active', updated_at = now() WHERE id = p_request_id;
  END IF;

  -- Create a notification for the visitor (only on the very first pickup)
  SELECT count(*) INTO v_existing_count FROM prayer_pickups WHERE prayer_request_id = p_request_id;
  IF v_existing_count = 1 AND v_request.visitor_id IS NOT NULL THEN
    INSERT INTO notifications (visitor_id, prayer_request_id, type, message)
    VALUES (
      v_request.visitor_id,
      p_request_id,
      'pickup',
      'Someone from the prayer team is now praying for your request.'
    );
  END IF;

  RETURN json_build_object('success', true);
END;
$$;

-- Add prophetic word + create notification for visitor
CREATE OR REPLACE FUNCTION add_prophetic_word(
  p_request_id UUID,
  p_team_member_id UUID,
  p_content TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_word prophetic_words;
  v_request prayer_requests;
BEGIN
  SELECT * INTO v_request FROM prayer_requests WHERE id = p_request_id;
  IF v_request.id IS NULL THEN
    RETURN json_build_object('error', 'request_not_found');
  END IF;

  INSERT INTO prophetic_words (prayer_request_id, team_member_id, content)
  VALUES (p_request_id, p_team_member_id, p_content)
  RETURNING * INTO v_word;

  IF v_request.visitor_id IS NOT NULL THEN
    INSERT INTO notifications (visitor_id, prayer_request_id, type, message)
    VALUES (
      v_request.visitor_id,
      p_request_id,
      'prophetic',
      'A prayer team member shared a word for your request.'
    );
  END IF;

  RETURN json_build_object('success', true, 'word_id', v_word.id);
END;
$$;

-- Required unique constraint for the ON CONFLICT in pickup_prayer_request
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prayer_pickups_unique_pair'
  ) THEN
    ALTER TABLE prayer_pickups
      ADD CONSTRAINT prayer_pickups_unique_pair UNIQUE (prayer_request_id, team_member_id);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
