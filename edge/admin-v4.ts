// admin v4 (R84) — RETIRED. The 2026-07 back-office SPA this function served (and that
// install-web copied into the public `web` bucket) was a live shadow login against production
// on a supabase.co origin, outside every later app-layer control. Deploy this stub, then delete
// the function outright (`supabase functions delete admin`) once nothing 410s in the logs.
// Also remove functions/v1/admin from the Auth redirect allow-list.
Deno.serve(() =>
  new Response(JSON.stringify({ error: "retired" }), {
    status: 410,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
