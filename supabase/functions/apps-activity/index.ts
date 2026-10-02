import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// apps-activity
// Admin-only read-only dashboard feed for the Shepherd Apps Hub.
//
// CURRENTLY DISABLED: ADMIN_EMAILS is intentionally empty so no caller passes
// the gate. The function returns 403 to everyone, which keeps the hub's admin
// section hidden. To re-enable, add your email to the array below and redeploy.
//
// - Hardcoded email allowlist (not driven by profiles.role) so this is locked
//   to specific people regardless of any DB state.
// - Performs SELECT queries only. No writes anywhere. No schema changes.
// - 30s in-memory cache to prevent refresh-spam from hitting Supabase.
// - Returns 401 (no/invalid JWT), 403 (not on allowlist), 200 (payload).

const ADMIN_EMAILS: string[] = [
  // Empty for now — dashboard is built but not live.
  // Add 'john@johnmathewson.com' to enable.
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CACHE_TTL_MS = 30_000;
let _cache: { at: number; payload: unknown } | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

type Profile = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string | null;
  created_at: string;
  state: Record<string, unknown> | null;
};

type EntryItem = {
  id?: number | string;
  date?: string;
  content?: string;
  tone?: string;
  symbols?: string[];
  context?: string;
  scripture?: string;
  source?: string;
  clarity?: string;
  interpretation?: string;
  text?: string;
};

type AiUsage = {
  id: string;
  user_id: string;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | string;
  created_at: string;
};

type AuthUser = {
  id: string;
  email: string | null | undefined;
  last_sign_in_at: string | null | undefined;
  created_at: string | undefined;
};

type Event = {
  id: string;
  type: string;
  user: { id: string; display_name: string | null; email: string | null };
  timestamp: string;
  entry_id?: number | string;
  preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

const toNum = (v: unknown): number => (typeof v === "number" ? v : parseFloat(String(v ?? 0)) || 0);
const hoursAgoIso = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const todayLocalDate = (): string => new Date().toISOString().slice(0, 10);
const preview = (s: string | undefined, n = 140): string => {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function eventsFromUserState(p: Profile): Event[] {
  const events: Event[] = [];
  const state = p.state || {};
  const u = { id: p.id, display_name: p.display_name, email: p.email };

  const pushArr = (arr: unknown, type: string, mapMeta: (it: EntryItem) => Record<string, unknown>) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr as EntryItem[]) {
      if (!it || typeof it !== "object") continue;
      const date = it.date || "";
      const ts = date ? `${date}T12:00:00Z` : new Date().toISOString();
      const content = it.content || it.text || "";
      events.push({
        id: `${type}-${p.id}-${it.id ?? Math.random().toString(36).slice(2)}`,
        type,
        user: u,
        timestamp: ts,
        entry_id: it.id,
        preview: preview(content),
        content: content,
        metadata: mapMeta(it),
      });
    }
  };

  pushArr((state as { dreams?: unknown }).dreams, "dream", (it) => ({
    tone: it.tone, symbols: it.symbols,
  }));
  pushArr((state as { visions?: unknown }).visions, "vision", (it) => ({
    context: it.context, scripture: it.scripture, clarity: it.clarity, interpretation: it.interpretation,
  }));
  pushArr((state as { prayer?: unknown }).prayer, "prayer", (it) => ({
    context: it.context, scripture: it.scripture,
  }));
  pushArr((state as { prophetic?: unknown }).prophetic, "prophetic", (it) => ({
    source: it.source, scripture: it.scripture, context: it.context,
  }));
  pushArr((state as { brainDumps?: unknown }).brainDumps, "journal", () => ({}));

  return events;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return json({ error: "missing_bearer_token" }, 401);
  const jwt = match[1];

  const supaUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supaUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "invalid_jwt" }, 401);
  const callerEmail = (userData.user.email || "").toLowerCase();

  if (!ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(callerEmail)) {
    return json({ error: "forbidden" }, 403);
  }

  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) {
    return json({ ...(_cache.payload as object), cached: true });
  }

  const admin = createClient(supaUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const [profilesRes, aiRes, authRes] = await Promise.all([
    admin.from("profiles").select("id,email,display_name,role,created_at,state"),
    admin.from("ai_usage").select("*").gte("created_at", hoursAgoIso(24 * 7)).order("created_at", { ascending: false }),
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);
  if (profilesRes.error) return json({ error: `profiles: ${profilesRes.error.message}` }, 500);
  if (aiRes.error) return json({ error: `ai_usage: ${aiRes.error.message}` }, 500);
  if (authRes.error) return json({ error: `authUsers: ${authRes.error.message}` }, 500);

  const profiles = (profilesRes.data || []) as Profile[];
  const aiUsage = (aiRes.data || []) as AiUsage[];
  const authUsers = (authRes.data?.users || []) as unknown as AuthUser[];

  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const today = todayLocalDate();
  const since24hMs = Date.now() - 24 * 3600_000;

  const events: Event[] = [];
  for (const p of profiles) events.push(...eventsFromUserState(p));

  for (const a of aiUsage) {
    if (new Date(a.created_at).getTime() < since24hMs) continue;
    const p = profileById.get(a.user_id);
    events.push({
      id: `ai-${a.id}`,
      type: "ai_call",
      user: { id: a.user_id, display_name: p?.display_name || null, email: p?.email || null },
      timestamp: a.created_at,
      metadata: {
        feature: a.feature,
        model: a.model,
        input_tokens: a.input_tokens,
        output_tokens: a.output_tokens,
        cost: toNum(a.estimated_cost),
      },
    });
  }

  for (const u of authUsers) {
    if (!u.last_sign_in_at) continue;
    if (new Date(u.last_sign_in_at).getTime() < since24hMs) continue;
    const p = profileById.get(u.id);
    events.push({
      id: `signin-${u.id}-${u.last_sign_in_at}`,
      type: "signin",
      user: { id: u.id, display_name: p?.display_name || u.email || null, email: u.email || null },
      timestamp: u.last_sign_in_at,
    });
  }

  events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const topEvents = events.slice(0, 20);

  const signups_today = profiles.filter((p) => p.created_at.slice(0, 10) === today).length;

  let entries_today = 0;
  for (const p of profiles) {
    const s = (p.state || {}) as Record<string, unknown>;
    for (const key of ["dreams", "visions", "prayer", "prophetic", "brainDumps"]) {
      const arr = s[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr as EntryItem[]) {
        if (item && item.date === today) entries_today++;
      }
    }
  }

  const aiToday = aiUsage.filter((a) => a.created_at.slice(0, 10) === today);
  const ai_calls_today = aiToday.length;
  const ai_cost_today = aiToday.reduce((s, a) => s + toNum(a.estimated_cost), 0);

  const activeUserIds = new Set<string>();
  for (const u of authUsers) {
    if (u.last_sign_in_at && u.last_sign_in_at.slice(0, 10) === today) activeUserIds.add(u.id);
  }
  for (const p of profiles) {
    const s = (p.state || {}) as Record<string, unknown>;
    for (const key of ["dreams", "visions", "prayer", "prophetic", "brainDumps"]) {
      const arr = s[key];
      if (!Array.isArray(arr)) continue;
      if ((arr as EntryItem[]).some((it) => it && it.date === today)) {
        activeUserIds.add(p.id);
        break;
      }
    }
  }
  const active_users_today = activeUserIds.size;

  const payload = {
    stats: { signups_today, entries_today, ai_calls_today, ai_cost_today, active_users_today },
    events: topEvents,
    generated_at: new Date().toISOString(),
  };
  _cache = { at: Date.now(), payload };
  return json(payload);
});
