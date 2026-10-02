import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Retired probe.
Deno.serve(() => new Response(JSON.stringify({ error: "retired" }), { status: 410, headers: { "Content-Type": "application/json" } }));
