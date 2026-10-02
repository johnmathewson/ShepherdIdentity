-- 20260328032432  add_admin_role_and_resource_tables
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- =============================================
-- 1. ADD ADMIN ROLE TO PROFILES
-- =============================================
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user' 
CHECK (role IN ('user', 'admin'));

-- Set John as admin
UPDATE public.profiles SET role = 'admin' 
WHERE email = 'john@johnmathewson.co';

-- =============================================
-- 2. RESOURCES TABLE (sermons, dream symbols, etc.)
-- =============================================
CREATE TABLE public.resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('sermon', 'dream_symbol', 'scripture', 'spiritual_gift', 'skill', 'other')),
  title text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  -- For sermons: {series, date, scriptures[], identityStatements[], propheticDeclarations[], themes[], keyQuotes[]}
  -- For dream_symbol: {category, keywords[], meaning, scriptures[], identityStatement}
  -- For spiritual_gift: {category, scripture, description}
  tags text[] DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  sort_order int DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

-- Index for fast lookups by type
CREATE INDEX idx_resources_type ON public.resources(type) WHERE active = true;
CREATE INDEX idx_resources_tags ON public.resources USING gin(tags);

-- =============================================
-- 3. AI USAGE TRACKING
-- =============================================
CREATE TABLE public.ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model text NOT NULL, -- 'haiku' or 'sonnet'
  feature text NOT NULL CHECK (feature IN ('chat', 'identity_synthesis', 'dream_interpretation')),
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  estimated_cost numeric(10,6) NOT NULL DEFAULT 0, -- in USD
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for querying daily usage per user (rate limiting)
CREATE INDEX idx_ai_usage_user_daily ON public.ai_usage(user_id, created_at DESC);
CREATE INDEX idx_ai_usage_cost ON public.ai_usage(created_at DESC);

-- =============================================
-- 4. APP SETTINGS (admin-configurable)
-- =============================================
CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  description text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id)
);

-- Insert default settings
INSERT INTO public.app_settings (key, value, description) VALUES
  ('ai_daily_message_limit', '15', 'Max AI chat messages per user per day'),
  ('ai_chat_model', '"haiku"', 'Model for daily chat (haiku or sonnet)'),
  ('ai_synthesis_model', '"sonnet"', 'Model for identity synthesis (haiku or sonnet)'),
  ('ai_monthly_budget_alert', '100', 'Alert admin when monthly AI cost exceeds this USD amount');

-- =============================================
-- 5. ROW LEVEL SECURITY POLICIES
-- =============================================

-- Helper function: check if current user is admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- PROFILES: Admin can read ALL profiles
CREATE POLICY "Admins can view all profiles" ON public.profiles
  FOR SELECT USING (public.is_admin());

-- PROFILES: Admin can update any profile  
CREATE POLICY "Admins can update all profiles" ON public.profiles
  FOR UPDATE USING (public.is_admin());

-- RESOURCES: Enable RLS
ALTER TABLE public.resources ENABLE ROW LEVEL SECURITY;

-- Resources: Everyone can read active resources
CREATE POLICY "Anyone can read active resources" ON public.resources
  FOR SELECT USING (active = true);

-- Resources: Only admins can insert/update/delete
CREATE POLICY "Admins can manage resources" ON public.resources
  FOR ALL USING (public.is_admin());

-- AI USAGE: Enable RLS
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- AI Usage: Users can see own usage
CREATE POLICY "Users can view own AI usage" ON public.ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- AI Usage: Insert own usage (from edge function via service role, but also user)
CREATE POLICY "Users can insert own AI usage" ON public.ai_usage
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- AI Usage: Admins can view all usage
CREATE POLICY "Admins can view all AI usage" ON public.ai_usage
  FOR SELECT USING (public.is_admin());

-- APP SETTINGS: Enable RLS
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- Settings: Everyone can read
CREATE POLICY "Anyone can read settings" ON public.app_settings
  FOR SELECT USING (true);

-- Settings: Only admins can modify
CREATE POLICY "Admins can manage settings" ON public.app_settings
  FOR ALL USING (public.is_admin());
