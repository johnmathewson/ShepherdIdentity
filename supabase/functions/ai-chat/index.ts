import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ai-chat v20 (canonical, shared by Shepherd + Go Find Jesus)
// v17 FIX: userContext (an object) was interpolated as `${userContext}` -> "[object Object]",
//   so the Guide never saw the user's journal. Now formatted via formatUserContext().
// v18 FIX 1: ai_usage insert wrote a non-existent tokens_used column (real cols are
//   model/input_tokens/output_tokens) - usage silently never logged and the daily limit
//   never counted. Insert now matches the schema and its error is surfaced (not swallowed).
// v18 FIX 2: identityWorksheet (passion/callings/ministry/vocation/identity statement) is
//   now included in the context so the Guide can help draft an identity statement.
// v20: added NAMED_PEOPLE_POLICY - a non-overridable safety block about real, identifiable
//   people in dreams, appended after the base prompt and journal context on every request.
// Model-resilient: tries primary, falls back on "model not found". Admin overrides via
// public.app_settings keys ai_chat_model / ai_synthesis_model still honored.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DAILY_LIMIT_DEFAULT = 50;

const CHAT_CHAIN  = ["claude-haiku-4-5-20251001", "claude-sonnet-4-6"];
const SYNTH_CHAIN = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"];

// Applies to every request regardless of feature, and is appended AFTER any
// client-supplied system prompt so it cannot be overridden. Dreams routinely
// contain real, identifiable people; the model must not assert biography.
const NAMED_PEOPLE_POLICY = `

NAMED REAL PEOPLE. Dreams and visions often contain real, identifiable people — public figures, former pastors, family members, exes, colleagues. When one appears:

- Do NOT state or imply facts about that person's real life, character, history, ministry, or conduct. Do not repeat allegations, crimes, scandals, or reputational claims, and do not confirm or deny anything the dreamer says about them. You may be wrong, you may be out of date, and this is a pastoral setting where being wrong about a named person causes real harm.
- DO work with what that person REPRESENTS to this dreamer — the authority, the season, the wound, the system, the relationship they stand for in the dream. That is what the dream is actually about.
- If who they are matters to the interpretation and you do not know it from the dreamer's own words, ask. "What does he represent to you?" is more useful than anything you could supply.
- If the dreamer has already named the significance themselves, you may reflect their framing back to them as theirs — "the authority you experienced there" — without adding independent claims of your own.

This applies even when you believe you know who the person is, and even when what you know appears to fit the dream.`;

// USD per million tokens. Keys are matched by prefix so dated model ids
// (e.g. claude-haiku-4-5-20251001) resolve to the right row.
const PRICING: Array<{ prefix: string; in: number; out: number }> = [
  { prefix: "claude-haiku-4-5", in: 1, out: 5 },
  { prefix: "claude-haiku", in: 0.8, out: 4 },
  { prefix: "claude-sonnet-4-6", in: 3, out: 15 },
  { prefix: "claude-sonnet", in: 3, out: 15 },
  { prefix: "claude-opus", in: 15, out: 75 },
];
function estimateCost(model: string, inTok: number, outTok: number): number {
  const m = String(model || "").toLowerCase();
  const row = PRICING.find((p) => m.startsWith(p.prefix))
    || (m.includes("sonnet") ? { in: 3, out: 15 }
    :   m.includes("opus")   ? { in: 15, out: 75 }
    :                          { in: 1, out: 5 });
  return (inTok / 1_000_000) * row.in + (outTok / 1_000_000) * row.out;
}

function resolveNamedModel(v: string): string | null {
  const s = v.toLowerCase().replace(/"/g, "");
  if (s.startsWith("claude-")) return s;
  if (s.includes("haiku"))  return "claude-haiku-4-5-20251001";
  if (s.includes("sonnet")) return "claude-sonnet-4-6";
  if (s.includes("opus"))   return "claude-opus-4-8";
  return null;
}

function fmtItem(x: any): string {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "object") {
    const meta: string[] = [];
    if (x.date) meta.push(String(x.date));
    if (x.tone) meta.push(String(x.tone));
    if (x.source) meta.push(`via ${x.source}`);
    const head = meta.length ? `(${meta.join(", ")}) ` : "";
    const text = x.content ?? x.text ?? x.name ?? x.title ?? x.value ?? "";
    const bodyTxt = typeof text === "string" && text.trim() ? text.trim() : JSON.stringify(x);
    const sym = Array.isArray(x.symbols) && x.symbols.length ? ` [symbols: ${x.symbols.join(", ")}]` : "";
    return `${head}${bodyTxt}${sym}`;
  }
  return String(x);
}

function fmtList(label: string, arr: any): string {
  if (!Array.isArray(arr) || arr.length === 0) return "";
  const lines = arr
    .map((x) => fmtItem(x))
    .filter((s) => s && s.length)
    .map((s, i) => `  ${i + 1}. ${s}`)
    .join("\n");
  if (!lines) return "";
  return `${label} (${arr.length}):\n${lines}`;
}

function fmtWorksheet(ws: any): string {
  if (!ws || typeof ws !== "object") return "";
  const fields: Array<[string, any]> = [
    ["Identity statement (draft)", ws.identityStatement],
    ["Passion", ws.passion],
    ["Callings", ws.callings],
    ["Ministry", ws.ministry],
    ["Vocation", ws.vocation],
    ["Spiritual gifts (worksheet)", ws.spiritualGifts],
    ["Natural abilities", ws.naturalAbilities],
  ];
  const lines = fields
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `  - ${k}: ${String(v).trim()}`);
  return lines.length ? `Identity worksheet:\n${lines.join("\n")}` : "";
}

function formatUserContext(ctx: any): string {
  if (ctx == null) return "";
  if (typeof ctx === "string") return ctx.trim();
  const sections: string[] = [];
  if (ctx.name)  sections.push(`Name: ${ctx.name}`);
  if (ctx.stage) sections.push(`Journey stage: ${ctx.stage}`);
  const lists: Array<[string, any]> = [
    ["Prophetic words received", ctx.prophetic],
    ["Dreams", ctx.dreams],
    ["Visions", ctx.visions],
    ["Prayer / encounters", ctx.prayer],
    ["Stirred / burdens", ctx.stirred],
    ["Spiritual gifts", ctx.gifts],
    ["Natural skills & abilities", ctx.skills],
  ];
  for (const [label, arr] of lists) {
    const s = fmtList(label, arr);
    if (s) sections.push(s);
  }
  const ws = fmtWorksheet(ctx.identityWorksheet);
  if (ws) sections.push(ws);
  return sections.join("\n\n").trim();
}

interface ClaudeCallParams {
  system: string;
  messages: Array<{ role: string; content: string }>;
  max_tokens: number;
}

async function callClaudeWithFallback(
  apiKey: string,
  modelChain: string[],
  params: ClaudeCallParams,
) {
  let lastErr = "";
  let lastStatus = 0;
  let lastModel = "";
  for (const model of modelChain) {
    if (!model) continue;
    lastModel = model;
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, ...params }),
      });
      if (resp.ok) return { ok: true as const, data: await resp.json(), model };
      const errText = await resp.text();
      lastErr = errText.slice(0, 400);
      lastStatus = resp.status;
      const isRetired = resp.status === 404
        || /not[_ ]?found|model.*not.*found|invalid.*model|deprecated/i.test(errText);
      if (isRetired) {
        console.warn(`Claude model ${model} unavailable (${resp.status}). Falling back.`);
        continue;
      }
      return { ok: false as const, status: resp.status, error: errText, lastModel: model };
    } catch (e) {
      lastErr = (e as Error).message;
      console.warn(`Network error with ${model}:`, lastErr);
    }
  }
  return { ok: false as const, status: lastStatus || 500, error: `All models exhausted: ${lastErr}`, lastModel };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");

    if (!anthropicKey) {
      return new Response(
        JSON.stringify({ reply: "AI service is not configured. Please contact the administrator." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ reply: "Please sign in to use AI features.", sessionExpired: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ reply: "Your session has expired. Please sign out and sign back in.", sessionExpired: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { messages, userContext, feature } = body;
    const effectiveFeature = feature || "chat";

    let dailyLimit = DAILY_LIMIT_DEFAULT;
    try {
      const { data: settingRow } = await supabase
        .from("app_settings").select("value").eq("key", "ai_daily_message_limit").single();
      const parsed = Number(settingRow?.value);
      if (Number.isFinite(parsed) && parsed > 0) dailyLimit = parsed;
    } catch (_) { /* use default */ }

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const { count } = await supabase
      .from("ai_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .in("feature", ["chat", "interpret", "identity_synthesis"])
      .gte("created_at", startOfDay);

    const used = count || 0;
    if (used >= dailyLimit) {
      return new Response(
        JSON.stringify({ reply: `You've reached today's AI usage limit (${dailyLimit} per day). Your limit resets at midnight - keep journaling and come back tomorrow.` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let chatChain  = [...CHAT_CHAIN];
    let synthChain = [...SYNTH_CHAIN];
    try {
      const { data: rows } = await supabase
        .from("app_settings").select("key,value").in("key", ["ai_chat_model", "ai_synthesis_model"]);
      if (rows) {
        for (const r of rows) {
          const v = String(r.value || "");
          if (r.key === "ai_chat_model") {
            const m = resolveNamedModel(v);
            if (m && !chatChain.includes(m)) chatChain = [m, ...chatChain];
          } else if (r.key === "ai_synthesis_model") {
            const m = resolveNamedModel(v);
            if (m && !synthChain.includes(m)) synthChain = [m, ...synthChain];
          }
        }
      }
    } catch (_) { /* use defaults */ }

    const chain = (effectiveFeature === "identity_synthesis" || effectiveFeature === "interpret")
      ? synthChain
      : chatChain;

    let systemPrompt = "";
    if (effectiveFeature === "interpret") {
      systemPrompt = `You are a wise, compassionate spiritual guide helping someone understand their prophetic experiences. You draw from biblical wisdom, Christian prophetic tradition, and spiritual discernment. Provide a thoughtful interpretation of the following entry. Be encouraging but also honest. Keep your response concise (2-4 paragraphs). Use warm, personal language as if speaking to a friend.`;
    } else if (effectiveFeature === "identity_synthesis") {
      systemPrompt = `You are a wise, compassionate spiritual guide and identity coach specializing in helping people discover and articulate their God-given identity. You draw from biblical wisdom, Christian prophetic tradition, and practical identity development. Synthesize the user's prophetic words, dreams, visions, and prayer experiences into a cohesive identity portrait.`;
    } else {
      systemPrompt = `You are a wise, compassionate spiritual guide and identity coach. You help people discover their God-given identity through prophetic words, dreams, visions, and prayer experiences. You draw from biblical wisdom, Christian prophetic tradition, and practical identity development. Be encouraging, insightful, and personal. Keep responses concise but meaningful.`;
    }

    const claudeMessages: Array<{ role: string; content: string }> = [];
    let customSystemPrompt = "";
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        if (msg.role === "system") customSystemPrompt = msg.content;
        else if (msg.role === "user" || msg.role === "assistant") {
          claudeMessages.push({ role: msg.role, content: msg.content || "" });
        }
      }
    }

    if (claudeMessages.length === 0) {
      return new Response(
        JSON.stringify({ reply: "No message provided. Please try again." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const base = customSystemPrompt || systemPrompt;
    const contextText = formatUserContext(userContext);
    const finalSystemPrompt = (contextText
      ? `${base}\n\n---\nThe following is the user's own journal from this app - their recorded prophetic words, dreams, visions, gifts, worksheet, and reflections. You DO have access to this; use it directly and refer to specific entries when helpful. If they ask you to synthesize their words and dreams (for example into an identity statement), draw on the entries below rather than asking them to paste them.\n\n${contextText}`
      : `${base}\n\n(Note: the user has not recorded any journal entries yet, so gently invite them to share.)`) + NAMED_PEOPLE_POLICY;

    const result = await callClaudeWithFallback(anthropicKey, chain, {
      system: finalSystemPrompt,
      messages: claudeMessages,
      max_tokens: 1024,
    });

    if (!result.ok) {
      console.error("Claude API error after fallbacks:", result.status, result.error);
      return new Response(
        JSON.stringify({ reply: `AI service error (${result.status}): ${result.error.substring(0, 200)}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const reply = result.data.content?.[0]?.text || "I wasn't able to generate a response. Please try again.";

    try {
      const { error: usageErr } = await supabase.from("ai_usage").insert({
        user_id: user.id,
        model: result.model,
        feature: effectiveFeature,
        input_tokens: result.data.usage?.input_tokens || 0,
        output_tokens: result.data.usage?.output_tokens || 0,
        estimated_cost: estimateCost(
          result.model,
          result.data.usage?.input_tokens || 0,
          result.data.usage?.output_tokens || 0,
        ),
      });
      if (usageErr) console.warn("ai_usage insert failed:", usageErr.message);
    } catch (e) {
      console.warn("ai_usage insert threw:", (e as Error).message);
    }

    return new Response(
      JSON.stringify({ reply, model: result.model }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ reply: `Something went wrong: ${(err as Error).message}` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
