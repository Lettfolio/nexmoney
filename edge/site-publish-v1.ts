// =============================================================================
// site-publish v1 — R93 · A (Website › Content › "Publish site")
// POST, caller JWT required. Gate = owner-digest v7's: resolve the user through the caller's own
// JWT, then session_ok() (R86 second factor) → 403, then profiles.role in owner/admin → 401.
// Reads settings.vercel_deploy_hook_secret (owner-only under "settings read staff"; read here as
// service_role), records a site_publishes row 'requested', POSTs the hook (no body — Vercel
// deploy hooks take none), then marks the row 'sent'/'failed' with a short detail.
// Missing hook → 400 { error: "no deploy hook set" } and a 'failed' row (the click is still recorded).
// Returns { ok, id, status, detail }. Never throws out of the handler.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MANUAL_ROLES = ["owner", "admin"];
const HOOK_TIMEOUT_MS = 10_000;

// "mfa" = signed in, second factor not verified (R86 · V1); null = refuse.
async function authorize(req: Request): Promise<{ uid: string } | "mfa" | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;
  const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: u } = await uc.auth.getUser();
  if (!u?.user) return null;
  const { data: ok, error: okErr } = await uc.rpc("session_ok");
  if (okErr || ok !== true) return "mfa";
  const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  if (p?.role && MANUAL_ROLES.includes(p.role)) return { uid: u.user.id };
  return null;
}

function short(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function finish(id: string | null, status: "sent" | "failed", detail: string) {
  if (!id) return;
  try { await admin.from("site_publishes").update({ status, detail: short(detail) }).eq("id", id); } catch { /* row stays 'requested' */ }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const who = await authorize(req);
    if (who === "mfa") return json({ error: "second factor required" }, 403);
    if (!who) return json({ error: "unauthorized" }, 401);

    const { data: hookRow } = await admin.from("settings").select("value").eq("key", "vercel_deploy_hook_secret").maybeSingle();
    const hook = String(hookRow?.value ?? "").trim();

    // Counts at request time — head-only, failures read as null rather than blocking the publish.
    const [pagesRes, postsRes] = await Promise.all([
      admin.from("site_pages").select("slug", { count: "exact", head: true }),
      admin.from("site_posts").select("id", { count: "exact", head: true }).eq("status", "published"),
    ]);
    const { data: row, error: insErr } = await admin.from("site_publishes").insert({
      requested_by: who.uid, status: "requested",
      pages: pagesRes.error ? null : pagesRes.count ?? null,
      posts: postsRes.error ? null : postsRes.count ?? null,
    }).select("id").single();
    const id: string | null = insErr ? null : (row?.id ?? null);

    if (!hook) {
      await finish(id, "failed", "no deploy hook set");
      return json({ error: "no deploy hook set", ok: false, id, status: "failed", detail: "no deploy hook set" }, 400);
    }
    // Only an https Vercel-style URL is ever POSTed to; anything else is a settings typo, not a target.
    let url: URL | null = null;
    try { url = new URL(hook); } catch { url = null; }
    if (!url || url.protocol !== "https:") {
      await finish(id, "failed", "deploy hook is not an https URL");
      return json({ error: "deploy hook is not an https URL", ok: false, id, status: "failed", detail: "deploy hook is not an https URL" }, 400);
    }

    let status: "sent" | "failed" = "failed";
    let detail = "";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), HOOK_TIMEOUT_MS);
    try {
      const res = await fetch(url.toString(), { method: "POST", signal: ctl.signal });
      const text = short(await res.text().catch(() => ""));
      status = res.ok ? "sent" : "failed";
      detail = short(`${res.status}${text ? " " + text : ""}`);
    } catch (e) {
      detail = (e instanceof Error && e.name === "AbortError") ? `deploy hook timed out after ${HOOK_TIMEOUT_MS / 1000}s` : short(e instanceof Error ? e.message : e);
    } finally {
      clearTimeout(timer);
    }
    await finish(id, status, detail);
    // 200 either way: a refused hook is a recorded outcome the UI toasts from `ok`/`detail`, and
    // supabase-js would hide the body of a non-2xx behind FunctionsHttpError.
    return json({ ok: status === "sent", id, status, detail });
  } catch (err) {
    return json({ ok: false, error: short(err instanceof Error ? err.message : err) }, 500);
  }
});
