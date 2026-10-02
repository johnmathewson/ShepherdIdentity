import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Combined daily transcription limit. This pool is shared with audio transcriptions,
// and a two-sided worksheet costs two.
const DAILY_TRANSCRIBE_LIMIT = 30;

// USD per million tokens, used to record a real cost per transcription.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-sonnet-4-20250514": { in: 3, out: 15 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
};
function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model] || { in: 1, out: 5 };
  return (inTok / 1_000_000) * p.in + (outTok / 1_000_000) * p.out;
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

    // Rate limiting: daily pool shared with audio transcriptions (feature='transcribe').
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
        JSON.stringify({ error: "daily_limit", remaining: 0, limit: DAILY_TRANSCRIBE_LIMIT, message: `You've used all ${DAILY_TRANSCRIBE_LIMIT} transcriptions for today (audio + photo combined). Your limit resets at midnight.` }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const formData = await req.formData();
    const imageFile = formData.get("image") as File | null;

    if (!imageFile) {
      return new Response(
        JSON.stringify({ error: "No image file provided." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 10MB cap for images (photos of handwritten pages are usually ~2-5MB).
    if (imageFile.size > 10 * 1024 * 1024) {
      return new Response(
        JSON.stringify({ error: "Image file too large. Maximum size is 10MB. Try a smaller photo." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const arrayBuffer = await imageFile.arrayBuffer();
    // Use a chunked approach to avoid stack overflow on very large arrays
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    const base64Image = btoa(binary);

    // Determine media type. Claude supports jpeg, png, gif, webp natively.
    // HEIC from iPhone needs conversion; most modern browsers convert on upload.
    const fileName = imageFile.name.toLowerCase();
    const fileType = (imageFile.type || "").toLowerCase();
    let mediaType = "image/jpeg";
    if (fileType.includes("png") || fileName.endsWith(".png")) mediaType = "image/png";
    else if (fileType.includes("webp") || fileName.endsWith(".webp")) mediaType = "image/webp";
    else if (fileType.includes("gif") || fileName.endsWith(".gif")) mediaType = "image/gif";
    else if (fileType.includes("jpeg") || fileType.includes("jpg") || fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) mediaType = "image/jpeg";
    else if (fileName.endsWith(".heic") || fileName.endsWith(".heif")) {
      return new Response(
        JSON.stringify({ error: "HEIC photos aren't supported directly. Please save as JPEG or take a new photo with your camera set to 'Most Compatible' format." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Read model preference from app_settings (fallback to haiku for cost).
    let modelToUse = "claude-haiku-4-5";
    try {
      const { data: settingRow } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "ai_chat_model")
        .single();
      const v = String(settingRow?.value || "").toLowerCase().replace(/"/g, "");
      if (v.includes("sonnet")) modelToUse = "claude-sonnet-4-20250514";
      else if (v.startsWith("claude-")) modelToUse = v;
    } catch (_) { /* use default */ }

    const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelToUse,
        max_tokens: 4096,
        system: "You are an expert transcriber specializing in handwritten journal entries, prayers, and notes. Transcribe the text visible in the image exactly as written. Preserve line breaks, paragraph structure, and the writer's original wording (including misspellings, abbreviations, and informal language — do NOT correct these). If handwriting is unclear for a word, use [unclear]. If a section is completely illegible, use [illegible]. If the image contains no writing, respond with exactly: (no text detected). Output ONLY the transcribed text — no commentary, no preamble like 'Here is the transcription'.",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType,
                  data: base64Image
                }
              },
              {
                type: "text",
                text: "Please transcribe the writing in this image accurately, preserving the original wording and structure."
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

    // Log under 'transcribe' feature so it shares the daily pool with audio.
    // Record usage. This previously wrote a non-existent `tokens_used` column and
    // omitted the NOT NULL `model`, so every insert failed silently — which meant
    // the daily limit never counted up and no cost was tracked. Log the error now.
    const { error: usageError } = await supabase.from("ai_usage").insert({
      user_id: user.id,
      model: modelToUse,
      feature: "transcribe",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      estimated_cost: estimateCost(modelToUse, inputTokens, outputTokens),
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
