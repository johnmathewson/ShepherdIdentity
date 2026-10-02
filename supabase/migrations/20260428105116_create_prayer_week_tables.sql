-- 20260428105116  create_prayer_week_tables
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


CREATE TABLE prayer_week_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  helps TEXT,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  slot_duration_minutes INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  created_at TIMESTAMPTZ DEFAULT now()
);
COMMENT ON TABLE prayer_week_events IS 'Day/Night prayer week events';

CREATE TABLE prayer_week_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES prayer_week_events(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  UNIQUE (event_id, starts_at)
);
CREATE INDEX prayer_week_slots_event_idx ON prayer_week_slots (event_id, starts_at);
COMMENT ON TABLE prayer_week_slots IS 'Day/Night hourly slots';

CREATE TABLE prayer_week_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id UUID NOT NULL UNIQUE REFERENCES prayer_week_slots(id) ON DELETE CASCADE,
  visitor_id UUID REFERENCES visitors(id) ON DELETE SET NULL,
  display_name TEXT,
  email TEXT,
  planning_center_id TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('held', 'confirmed')),
  hold_token UUID,
  hold_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX prayer_week_signups_visitor_idx ON prayer_week_signups (visitor_id);
CREATE INDEX prayer_week_signups_held_idx ON prayer_week_signups (hold_token) WHERE status = 'held';
COMMENT ON TABLE prayer_week_signups IS 'Day/Night signups (confirmed and held)';

ALTER TABLE prayer_week_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE prayer_week_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE prayer_week_signups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "events_public_read" ON prayer_week_events
  FOR SELECT TO anon, authenticated USING (status = 'published');
CREATE POLICY "slots_public_read" ON prayer_week_slots
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "signups_no_direct_read" ON prayer_week_signups
  FOR SELECT TO anon, authenticated USING (false);

CREATE VIEW prayer_week_public_slots WITH (security_invoker = true) AS
SELECT
  sl.id, sl.event_id, sl.starts_at, sl.ends_at,
  CASE
    WHEN sg.id IS NULL THEN 'open'
    WHEN sg.status = 'held' AND sg.hold_expires_at > now() THEN 'open'
    WHEN sg.status = 'held' AND sg.hold_expires_at <= now() THEN 'open'
    ELSE 'filled'
  END AS public_status
FROM prayer_week_slots sl
LEFT JOIN prayer_week_signups sg ON sg.slot_id = sl.id;
COMMENT ON VIEW prayer_week_public_slots IS 'Anonymous slot status';

GRANT ALL ON prayer_week_events, prayer_week_slots, prayer_week_signups TO anon, authenticated, service_role;
GRANT SELECT ON prayer_week_public_slots TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION hold_prayer_slot(p_slot_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold_token UUID;
  v_existing prayer_week_signups;
BEGIN
  DELETE FROM prayer_week_signups
    WHERE slot_id = p_slot_id AND status = 'held' AND hold_expires_at < now();
  SELECT * INTO v_existing FROM prayer_week_signups WHERE slot_id = p_slot_id;
  IF FOUND THEN RETURN json_build_object('error', 'slot_taken'); END IF;
  v_hold_token := gen_random_uuid();
  INSERT INTO prayer_week_signups (slot_id, status, hold_token, hold_expires_at)
  VALUES (p_slot_id, 'held', v_hold_token, now() + interval '5 minutes');
  RETURN json_build_object('success', true, 'hold_token', v_hold_token, 'expires_in_seconds', 300);
END; $$;

CREATE OR REPLACE FUNCTION claim_prayer_slot(
  p_hold_token UUID, p_visitor_id UUID, p_display_name TEXT, p_email TEXT,
  p_planning_center_id TEXT DEFAULT NULL, p_notes TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_signup prayer_week_signups;
BEGIN
  UPDATE prayer_week_signups
  SET visitor_id = p_visitor_id, display_name = p_display_name, email = p_email,
      planning_center_id = p_planning_center_id, notes = p_notes,
      status = 'confirmed', hold_token = NULL, hold_expires_at = NULL
  WHERE hold_token = p_hold_token AND status = 'held' AND hold_expires_at > now()
  RETURNING * INTO v_signup;
  IF v_signup.id IS NULL THEN RETURN json_build_object('error', 'hold_expired_or_invalid'); END IF;
  RETURN json_build_object('success', true, 'signup_id', v_signup.id, 'slot_id', v_signup.slot_id);
END; $$;

CREATE OR REPLACE FUNCTION direct_claim_prayer_slot(
  p_slot_id UUID, p_visitor_id UUID, p_display_name TEXT, p_email TEXT,
  p_planning_center_id TEXT DEFAULT NULL, p_notes TEXT DEFAULT NULL
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_signup prayer_week_signups;
BEGIN
  DELETE FROM prayer_week_signups
    WHERE slot_id = p_slot_id AND status = 'held' AND hold_expires_at < now();
  BEGIN
    INSERT INTO prayer_week_signups (slot_id, visitor_id, display_name, email, planning_center_id, notes, status)
    VALUES (p_slot_id, p_visitor_id, p_display_name, p_email, p_planning_center_id, p_notes, 'confirmed')
    RETURNING * INTO v_signup;
  EXCEPTION WHEN unique_violation THEN
    RETURN json_build_object('error', 'slot_taken');
  END;
  RETURN json_build_object('success', true, 'signup_id', v_signup.id);
END; $$;

CREATE OR REPLACE FUNCTION release_prayer_slot(p_signup_id UUID, p_visitor_id UUID)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted INTEGER;
BEGIN
  DELETE FROM prayer_week_signups
    WHERE id = p_signup_id AND visitor_id = p_visitor_id AND status = 'confirmed';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted = 0 THEN RETURN json_build_object('error', 'not_found_or_unauthorized'); END IF;
  RETURN json_build_object('success', true);
END; $$;

NOTIFY pgrst, 'reload schema';
