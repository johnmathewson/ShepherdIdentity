// generate-social-share v9 — TEXT ONLY (no AI image generation)
//
// Hard reset from the previous approach: stop generating abstract painterly
// AI backgrounds. The Shepherd brand is real photos + typographic event
// posters. The admin UI now renders three designed templates (dark sage,
// cream, photo overlay) client-side. This function's job is text + a photo
// suggestion only.
//
// Pipeline:
//   1) Claude — pull-quote (3-7 words, focal text on graphic)
//   2) Claude — IG caption + hashtags
//   3) Claude — photo suggestion (if library has photos)
//
// Output: { pull_quote, caption, hashtags, photo_id (or null), template_id }
// Cost: ~$0.01 per generation. No more OpenAI image bill. No more 30s wait.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

const MODEL_CHAIN: string[] = [
  Deno.env.get("SOCIAL_SHARE_CLAUDE_MODEL") || "",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
].filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const reqHdrs = req.headers.get("access-control-request-headers")
    || "authorization,content-type,apikey,x-client-info,x-supabase-api-version";
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": reqHdrs,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}
function jsonResp(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch (_e) { return null; }
}

async function isAuthorized(req: Request): Promise<{ ok: boolean; userId?: string }> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/, "");
  if (!token) return { ok: false };
  const payload = decodeJwtPayload(token);
  if (payload && payload.role === "service_role" && payload.iss === "supabase") {
    try {
      const sb = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
      const { error } = await sb.from("profiles").select("id", { count: "exact", head: true });
      if (!error) return { ok: true };
    } catch (_e) { /* fall through */ }
  }
  if (!ANON_KEY) return { ok: false };
  try {
    const userSupa = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: uErr } = await userSupa.auth.getUser();
    if (uErr || !user) return { ok: false };
    const supaAdmin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: profile } = await supaAdmin
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role === "admin") return { ok: true, userId: user.id };
  } catch (_e) { /* deny */ }
  return { ok: false };
}

async function claudeOneShot(systemPrompt: string, userPrompt: string, maxTokens = 512): Promise<string> {
  let lastErr = "";
  for (const model of MODEL_CHAIN) {
    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return (data.content?.[0]?.text || "").trim();
      }
      const errText = await resp.text();
      lastErr = `${model}: ${resp.status} ${errText.slice(0, 250)}`;
      const isRetired = resp.status === 404
        || /not[_ ]?found|model.*not.*found|invalid.*model|deprecated/i.test(errText);
      if (isRetired) {
        console.warn(`Claude model ${model} unavailable, falling back`);
        continue;
      }
      throw new Error(`Claude API ${lastErr}`);
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  throw new Error(`Claude exhausted all models. Last error: ${lastErr}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }

  try {
    const auth = await isAuthorized(req);
    if (!auth.ok) return jsonResp({ error: "unauthorized" }, 401, req);
    if (!ANTHROPIC_KEY) return jsonResp({ error: "ANTHROPIC_API_KEY not configured." }, 500, req);
    if (MODEL_CHAIN.length === 0) return jsonResp({ error: "No Claude models in chain." }, 500, req);

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* empty body */ }
    const devotionalId = body.devotional_id as string | undefined;
    const regenerate = Boolean(body.regenerate);
    const customPrompt = ((body.custom_prompt as string) || "").trim();

    if (!devotionalId) return jsonResp({ error: "devotional_id is required" }, 400, req);

    const { data: dev, error: devErr } = await supa
      .from("devotionals").select("*").eq("id", devotionalId).maybeSingle();
    if (devErr) throw devErr;
    if (!dev) return jsonResp({ error: "devotional not found" }, 404, req);

    if (!regenerate) {
      const { data: cached } = await supa
        .from("devotional_social_share")
        .select("variant, candidate_index, caption, hashtags, pull_quote, custom_prompt, template_id, photo_id")
        .eq("devotional_id", devotionalId)
        .order("candidate_index");
      if (cached && cached.length > 0) {
        const variants: Record<string, unknown> = {};
        for (const row of cached) {
          const v = row.variant as string;
          if (!variants[v]) variants[v] = {
            caption: row.caption, hashtags: row.hashtags,
            pull_quote: row.pull_quote, custom_prompt: row.custom_prompt,
            template_id: row.template_id || "dark_sage",
            photo_id: row.photo_id || null,
          };
        }
        return jsonResp({
          ok: true, cached: true,
          devotional: { id: dev.id, title: dev.title, publish_date: dev.publish_date },
          variants,
        }, 200, req);
      }
    }

    // Pull-quote
    const pullSystem = "You extract short pull-quotes for social-media graphics that accompany Christian devotionals. Output ONLY the pull-quote text, no quotes, no attribution, no explanation. 3 to 7 words MAX.";
    const pullUser = `Devotional content:\nTitle: ${dev.title || ""}\nScripture: ${dev.scripture_ref || ""} — "${dev.scripture_text || ""}"\nReflection: ${(dev.body || "").slice(0, 1500)}\n${customPrompt ? `\nADMIN NOTE: ${customPrompt}\n` : ""}\nWrite a 3-7 word pull-quote for the graphic. The pull-quote is the ONLY large text on the image; it must read instantly and carry emotional weight.\n\nTwo good strategies (pick whichever serves this devotional better):\n  A) Excerpt the most resonant 3-7 words DIRECTLY from the scripture verse (e.g. \"I AM EL-SHADDAI\", \"I am the vine\", \"He restores my soul\")\n  B) Distill the devotional's core truth into a fresh 3-7 word phrase (e.g. \"He is enough\", \"Named, not forgotten\")\n\n3 to 7 words MAX. No quotation marks, no attribution. Plain language. No exclamation marks. Output JUST the pull-quote.`;
    const pullQuoteRaw = await claudeOneShot(pullSystem, pullUser, 50);
    const pullQuote = pullQuoteRaw.replace(/^["“‘']\s*/, "").replace(/\s*["”’']$/, "").trim();

    // Caption
    const captionSystem = "You write warm, scripture-anchored Instagram captions for daily devotionals from Shepherd Church NWI. Voice: conversational but not casual. Theologically grounded. Output ONLY the caption followed by a blank line and 5-8 hashtags. No explanations, no labels.";
    const captionUser = `Devotional content:\nTitle: ${dev.title || ""}\nScripture: ${dev.scripture_ref || ""} — "${dev.scripture_text || ""}"\nReflection: ${dev.body || ""}\n\nWrite an Instagram caption that:\n- Opens with a hook in the first 1-2 lines (visible before 'more')\n- Runs 100-130 words\n- Includes the scripture reference at least once\n- Ends with a reflective question OR a brief CTA to open the app\n- Uses one or zero emoji\n\nThen on a new line, write 5-8 hashtags. Mix #ShepherdChurch #ShepherdFormation #KnowWhoYouAre and broader (#DailyDevotional #ScriptureReflection #ChristianLife #Discipleship #Faith).`;
    const captionRaw = await claudeOneShot(captionSystem, captionUser, 800);

    let caption = captionRaw.trim();
    let hashtags = "";
    const hashLineMatch = caption.match(/\n+(#[^\n]+(?:\n#[^\n]+)*)$/);
    if (hashLineMatch) {
      hashtags = hashLineMatch[1].replace(/\n/g, " ").trim();
      caption = caption.slice(0, hashLineMatch.index).trim();
    } else {
      const lines = caption.split(/\n/);
      const lastLine = lines[lines.length - 1] || "";
      if (/^#\w/.test(lastLine.trim())) {
        hashtags = lastLine.trim();
        caption = lines.slice(0, -1).join("\n").trim();
      }
    }

    // Photo suggestion: pick best photo from library if any exist
    let suggestedPhotoId: string | null = null;
    try {
      const { data: photos } = await supa
        .from("social_photo_assets")
        .select("id, title, tags")
        .eq("active", true)
        .order("sort_order");
      if (photos && photos.length > 0) {
        const photoList = photos.map((p: any, i: number) =>
          `${i + 1}. ID:${p.id} — ${p.title || "(no title)"} [tags: ${(p.tags || []).join(", ") || "none"}]`
        ).join("\n");
        const photoSystem = "You match Christian devotionals to a photo from a curated library. Output ONLY the photo ID (a UUID), nothing else. If none of the photos clearly fit, output the word: NONE";
        const photoUser = `Devotional:\nTitle: ${dev.title || ""}\nPull-quote: ${pullQuote}\nScripture: ${dev.scripture_ref || ""}\nReflection (excerpt): ${(dev.body || "").slice(0, 600)}\n\nAvailable photos:\n${photoList}\n\nPick the photo whose mood and content best fits this devotional. Consider tags as the strongest signal. If two are close, prefer the more atmospheric / less literal one. If no photo clearly fits, output: NONE\n\nOutput JUST the UUID (or NONE).`;
        const pick = await claudeOneShot(photoSystem, photoUser, 60);
        const cleaned = pick.trim();
        if (cleaned && cleaned !== "NONE" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)) {
          // Verify it's in the list (Claude sometimes hallucinates)
          if (photos.some((p: any) => p.id === cleaned)) {
            suggestedPhotoId = cleaned;
          }
        }
      }
    } catch (e) {
      console.warn("photo suggestion failed (non-fatal):", (e as Error).message);
    }

    // If regenerating, wipe existing rows so the new content takes over
    if (regenerate) {
      await supa.from("devotional_social_share").delete().eq("devotional_id", devotionalId);
    }

    // Save row. variant = instagram_square is the canonical row; story
    // reuses the same content client-side. Keep one row per devotional.
    const row = {
      devotional_id: devotionalId,
      variant: "instagram_square" as const,
      candidate_index: 0,
      caption, hashtags, pull_quote: pullQuote,
      custom_prompt: customPrompt || null,
      template_id: "dark_sage",
      photo_id: suggestedPhotoId,
      mood_prompt: null, image_path: null, image_url: null, quality: null,
      generated_by: auth.userId || null,
    };
    const { error: insErr } = await supa.from("devotional_social_share").insert(row);
    if (insErr) throw insErr;

    return jsonResp({
      ok: true, cached: false,
      devotional: { id: dev.id, title: dev.title, publish_date: dev.publish_date },
      variants: {
        instagram_square: {
          caption, hashtags, pull_quote: pullQuote,
          custom_prompt: customPrompt || null,
          template_id: "dark_sage",
          photo_id: suggestedPhotoId,
        },
      },
    }, 200, req);
  } catch (e) {
    console.error("generate-social-share:", e);
    return jsonResp({ error: String((e as Error)?.message || e) }, 500, req);
  }
});
