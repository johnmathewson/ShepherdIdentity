-- 20260518141652  redesign_people_and_team_membership
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- ─────────────────────────────────────────────────────────────────────────
-- Redesign schema — additive, doesn't touch prod tables.
-- Production code keeps using `visitors` + `team_members`.
-- Redesign code (the new /app) uses `people` + `team_membership`.
-- A migration script will fold the old tables into these at cutover.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.people (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id    uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text NOT NULL UNIQUE,
  display_name    text NOT NULL DEFAULT 'Friend',
  planning_center_id text UNIQUE,
  email_notifications boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS people_email_idx ON public.people (lower(email));
CREATE INDEX IF NOT EXISTS people_planning_center_idx ON public.people (planning_center_id)
  WHERE planning_center_id IS NOT NULL;

ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;

-- A person can read their own row.
DROP POLICY IF EXISTS "people_select_own" ON public.people;
CREATE POLICY "people_select_own" ON public.people
  FOR SELECT USING (auth_user_id = auth.uid());

-- A person can update their own profile fields (display_name, email_notifications).
DROP POLICY IF EXISTS "people_update_own" ON public.people;
CREATE POLICY "people_update_own" ON public.people
  FOR UPDATE USING (auth_user_id = auth.uid());

-- Service role bypasses RLS so server-side onboarding can insert/upsert.

-- ─────────────────────────────────────────────────────────────────────────
-- team_membership: additive role facet for people on the prayer team.
-- Missing row = visitor. Present row with role='member' = prayer team.
-- Present row with role='admin' = admin.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.team_membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL UNIQUE REFERENCES public.people(id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member'
                  CHECK (role IN ('member', 'admin')),
  approved        boolean NOT NULL DEFAULT true,
  invited_email   text,  -- when an admin invited by email before the person ever signed in
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS team_membership_invited_email_idx
  ON public.team_membership (lower(invited_email))
  WHERE invited_email IS NOT NULL;

ALTER TABLE public.team_membership ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_membership_select_own" ON public.team_membership;
CREATE POLICY "team_membership_select_own" ON public.team_membership
  FOR SELECT USING (
    person_id IN (SELECT id FROM public.people WHERE auth_user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at auto-bump trigger (used by both tables)
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS people_set_updated_at ON public.people;
CREATE TRIGGER people_set_updated_at
  BEFORE UPDATE ON public.people
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS team_membership_set_updated_at ON public.team_membership;
CREATE TRIGGER team_membership_set_updated_at
  BEFORE UPDATE ON public.team_membership
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- ensure_person — server-side RPC called from /api/auth after every
-- successful verifyOtp. Idempotent. If the auth user already has a
-- people row, return it. Otherwise create one. If a stale unlinked
-- visitors row exists for the same email (legacy), the migration script
-- will link it later — we don't need to handle that here.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_person(
  p_auth_user_id uuid,
  p_email text,
  p_display_name text DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_person people;
  v_name text;
BEGIN
  -- Path 1: already exists
  SELECT * INTO v_person FROM people WHERE auth_user_id = p_auth_user_id;
  IF FOUND THEN
    RETURN json_build_object(
      'id', v_person.id,
      'email', v_person.email,
      'display_name', v_person.display_name,
      'created', false
    );
  END IF;

  v_name := COALESCE(NULLIF(p_display_name, ''), split_part(p_email, '@', 1), 'Friend');

  -- Path 2: net new
  INSERT INTO people (auth_user_id, email, display_name)
  VALUES (p_auth_user_id, lower(p_email), v_name)
  RETURNING * INTO v_person;

  RETURN json_build_object(
    'id', v_person.id,
    'email', v_person.email,
    'display_name', v_person.display_name,
    'created', true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_person TO service_role;
