import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Per-user daily transcription limit. This pool is shared with photo transcriptions.
const DAILY_TRANSCRIBE_LIMIT = 30;

// USD per million tokens, used to record a real cost per transcription.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-20250514": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
};
function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] || { in: 3, out: 15 };
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
}

const MODEL = "claude-sonnet-4-20250514";

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
        JSON.stringify({ error: "AI service is not configured." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Please sign in to use transcription.", sessionExpired: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Your session has expired. Please sign out and sign back in.", sessionExpired: true }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Rate limiting: DAILY_TRANSCRIBE_LIMIT transcriptions per day
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const { count } = await supabase
      .from("ai_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("feature", "transcribe")
      .gte("created_at", startOfDay);

    const used = count || 0;
    const remaining = Math.max(0, DAILY_TRANSCRIBE_LIMIT - used);

    if (used >= DAILY_TRANSCRIBE_LIMIT) {
      return new Response(
        JSON.stringify({ error: "daily_limit", remaining: 0, limit: DAILY_TRANSCRIBE_LIMIT, message: `You've used all ${DAILY_TRANSCRIBE_LIMIT} transcriptions for today. Your limit resets at midnight.` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;

    if (!audioFile) {
      return new Response(
        JSON.stringify({ error: "No audio file provided." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (audioFile.size > 25 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Audio file too large. Maximum size is 25MB." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const arrayBuffer = await audioFile.arrayBuffer();
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    const fileName = audioFile.name.toLowerCase();
    let mediaType = "audio/mp3";
    if (fileName.endsWith(".wav")) mediaType = "audio/wav";
    else if (fileName.endsWith(".m4a") || fileName.endsWith(".mp4")) mediaType = "audio/mp4";
    else if (fileName.endsWith(".ogg") || fileName.endsWith(".oga")) mediaType = "audio/ogg";
    else if (fileName.endsWith(".webm")) mediaType = "audio/webm";
    else if (fileName.endsWith(".flac")) mediaType = "audio/flac";
    else if (fileName.endsWith(".aac")) mediaType = "audio/aac";

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2025-01-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: "You are an expert audio transcriber. Transcribe the following audio recording accurately and completely. Output ONLY the transcribed text with no commentary, labels, timestamps, or explanation. Preserve the speaker's words exactly as spoken. If multiple speakers are present, separate their words with paragraph breaks. If you cannot understand a portion, write [inaudible]. Do not add any preamble like 'Here is the transcription' — just output the raw transcribed text.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "audio",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Audio
                }
              },
              {
                type: "text",
                text: "Please transcribe this audio recording accurately."
              }
            ]
          }
        ],
      }),
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error("Claude API error:", claudeResponse.status, errText);
      return new Response(
        JSON.stringify({ error: `Transcription failed (${claudeResponse.status}): ${errText.substring(0, 200)}` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const claudeData = await claudeResponse.json();
    const transcript = claudeData.content?.[0]?.text || "";
    const inputTokens = claudeData.usage?.input_tokens || 0;
    const outputTokens = claudeData.usage?.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;

    // Record usage. This previously wrote a non-existent `tokens_used` column and
    // omitted the NOT NULL `model`, so every insert failed silently — which meant
    // the daily limit never counted up and no cost was tracked. Log the error now.
    const { error: usageError } = await supabase.from("ai_usage").insert({
      user_id: user.id,
      model: MODEL,
      feature: "transcribe",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost: estimateCost(MODEL, inputTokens, outputTokens),
    });
    if (usageError) console.error("ai_usage insert failed:", usageError);

    return new Response(
      JSON.stringify({
        transcript,
        remaining: remaining - 1,
        limit: DAILY_TRANSCRIBE_LIMIT,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens }
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: `Something went wrong: ${err.message}` }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
