-- 20260428124521  add_answered_prayers_and_updates
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Extend prayer_requests with outcome fields
ALTER TABLE prayer_requests ADD COLUMN IF NOT EXISTS outcome_note TEXT;
ALTER TABLE prayer_requests ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ;
ALTER TABLE prayer_requests ADD COLUMN IF NOT EXISTS share_publicly BOOLEAN DEFAULT true;

-- Update status check to include 'answered' and 'archived'
ALTER TABLE prayer_requests DROP CONSTRAINT IF EXISTS prayer_requests_status_check;
ALTER TABLE prayer_requests ADD CONSTRAINT prayer_requests_status_check
  CHECK (status = ANY (ARRAY['pending','active','answered','archived','completed']));

-- New table: visitor-authored ongoing updates
CREATE TABLE prayer_request_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prayer_request_id UUID NOT NULL REFERENCES prayer_requests(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  is_answer BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX prayer_request_updates_request_idx ON prayer_request_updates (prayer_request_id, created_at);

ALTER TABLE prayer_request_updates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "updates_no_direct_access" ON prayer_request_updates
  FOR SELECT TO anon, authenticated USING (false);

GRANT ALL ON prayer_request_updates TO service_role;

-- Public answered prayers view (only ones the visitor opted to share)
CREATE OR REPLACE VIEW answered_prayers_public WITH (security_invoker = true) AS
SELECT
  pr.id,
  pr.category,
  pr.title,
  pr.description,
  pr.outcome_note,
  pr.outcome_at,
  pr.created_at,
  COALESCE((SELECT count(*) FROM prayer_pickups pp WHERE pp.prayer_request_id = pr.id), 0)::int AS pickup_count
FROM prayer_requests pr
WHERE pr.status = 'answered' AND pr.share_publicly = true;

GRANT SELECT ON answered_prayers_public TO anon, authenticated, service_role;

-- RPC: add a visitor update (any status)
CREATE OR REPLACE FUNCTION add_request_update(
  p_request_id UUID,
  p_visitor_id UUID,
  p_content TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request prayer_requests;
  v_update prayer_request_updates;
BEGIN
  SELECT * INTO v_request FROM prayer_requests
  WHERE id = p_request_id AND visitor_id = p_visitor_id;
  IF v_request.id IS NULL THEN
    RETURN json_build_object('error', 'not_found_or_unauthorized');
  END IF;

  INSERT INTO prayer_request_updates (prayer_request_id, content)
  VALUES (p_request_id, p_content)
  RETURNING * INTO v_update;

  -- Notify any team members who picked this up that there's a new update
  -- (skipping for now — would clutter notifications; team sees on detail page)

  RETURN json_build_object('success', true, 'update_id', v_update.id);
END; $$;

-- RPC: mark a request as answered (visitor only) with testimony
CREATE OR REPLACE FUNCTION mark_request_answered(
  p_request_id UUID,
  p_visitor_id UUID,
  p_testimony TEXT,
  p_share_publicly BOOLEAN DEFAULT true
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_request prayer_requests;
BEGIN
  SELECT * INTO v_request FROM prayer_requests
  WHERE id = p_request_id AND visitor_id = p_visitor_id;
  IF v_request.id IS NULL THEN
    RETURN json_build_object('error', 'not_found_or_unauthorized');
  END IF;

  UPDATE prayer_requests
  SET status = 'answered',
      outcome_note = p_testimony,
      outcome_at = now(),
      share_publicly = p_share_publicly,
      updated_at = now()
  WHERE id = p_request_id;

  -- Also store the testimony as an update entry for full chronological visibility
  INSERT INTO prayer_request_updates (prayer_request_id, content, is_answer)
  VALUES (p_request_id, p_testimony, true);

  RETURN json_build_object('success', true);
END; $$;

-- RPC: archive a request (visitor only)
CREATE OR REPLACE FUNCTION archive_prayer_request(
  p_request_id UUID,
  p_visitor_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count INT;
BEGIN
  UPDATE prayer_requests
  SET status = 'archived', updated_at = now()
  WHERE id = p_request_id AND visitor_id = p_visitor_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RETURN json_build_object('error', 'not_found_or_unauthorized');
  END IF;
  RETURN json_build_object('success', true);
END; $$;

NOTIFY pgrst, 'reload schema';
