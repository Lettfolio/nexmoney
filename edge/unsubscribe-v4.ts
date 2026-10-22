// R95 · A: v4 = v3 with the HTML pages moved to the site (Supabase serves function HTML as text/plain): GET → 302 to {site_url}/unsubscribe, GET ?format=json → {ok,valid}, POST → JSON.
// R94 · D: v3 = v2 + CORS allow-list (a no-Origin email click still gets 200 HTML) + 8 KB body cap + uuid shape check on c/t. Nothing else.
/* =============================================================================
   unsubscribe v2 (R83 · fixH) — the public opt-out endpoint the v19+ marketing
   footer links to, and the target of the v21 List-Unsubscribe headers.

   WHAT CHANGED FROM v1: v1 performed the opt-out on GET. Every URL in a delivered
   email is fetched by link scanners (Outlook Safe Links, Defender, Proofpoint…)
   before the person ever sees it, so v1 silently unsubscribed whole domains the
   moment a birthday note landed. v2:
     · GET  /unsubscribe?c=<client_id>&t=<comms_token>  is SIDE-EFFECT-FREE. (v4: it
       302s to the site's /unsubscribe page; ?format=json answers {ok, valid}.)
     · POST /unsubscribe  (JSON or form body c=&t=, or the same query string, or the
       RFC 8058 one-click body "List-Unsubscribe=One-Click") performs the opt-out
       (v4: answers JSON {ok:true}).
     · The opt-out sets BOTH clients.comms_optout AND clients.marketing_opt_out —
       the second is the flag staff see on the client record, so an unsubscribe is
       visible in the back office instead of invisible (review finding 1).

   Everything v1 promised still holds:
     · PUBLIC — no auth. The only credential is the per-client comms_token.
     · The token is compared constant-time-ish, never used in the query filter.
     · No name or email is echoed back — the page may be opened from a forwarded
       email and must not become a "does this id exist and who is it" oracle.
     · A wrong or missing token gets the generic {ok:true, valid:false}, same
       status code, no detail. ALWAYS 200 (except the GET redirect and CORS
       preflight), even on an unexpected failure.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";

// R94 · D: browsers may call this only from the site (vercel.app origin: one week after cutover, then delete it).
const ORIGINS = ["https://www.nexmoney.co.uk", "https://nexmoney.co.uk", "https://nexmoney-two.vercel.app"];
const withCors = (req: Request, res: Response): Response => {
  const o = req.headers.get("origin") ?? "";
  res.headers.set("Access-Control-Allow-Origin", ORIGINS.includes(o) ? o : ORIGINS[0]);
  res.headers.set("Vary", "Origin");
  return res;
};
// R94 · D: refuse an oversized body from its Content-Length before buffering it (the form posts two uuids).
const MAX_BODY = 8 * 1024;
const tooBig = (req: Request) => Number(req.headers.get("content-length") ?? 0) > MAX_BODY;

const CORS = {
  "Access-Control-Allow-Origin": ORIGINS[0],   // R94 · D: withCors() sets the per-request value
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const uuidRe = /^[0-9a-fA-F-]{36}$/;   // R94 · D: clients.id and clients.comms_token are uuid columns

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Constant-time-ish string compare: length-independent early exit avoided by
// always walking the longer string; every character contributes to the result.
function tokenMatches(a: string, b: string): boolean {
  const x = String(a || "");
  const y = String(b || "");
  const n = Math.max(x.length, y.length);
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const json = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
// R95 · A: one answer for every bad link (shape, unknown id, wrong token, oversized body) — no oracle.
const NOT_RECOGNISED = () => json({ ok: true, valid: false });

// R95 · A: the page lives on the site; read site_url the way nps-capture does.
async function siteUrl(): Promise<string> {
  const { data } = await supabase.from("settings").select("value").eq("key", "site_url").maybeSingle();
  return String((data && data.value) || "https://www.nexmoney.co.uk").replace(/\/+$/, "");
}

/* Read c / t from wherever this request carries them: the query string (GET, and the
   RFC 8058 one-click POST, whose body is only "List-Unsubscribe=One-Click"), or a
   form-encoded / JSON POST body. Query values win only when the body has none. */
async function readParams(req: Request, url: URL): Promise<{ clientId: string; token: string }> {
  let c = (url.searchParams.get("c") || "").trim();
  let t = (url.searchParams.get("t") || "").trim();
  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        c = String(fd.get("c") ?? c).trim();
        t = String(fd.get("t") ?? t).trim();
      } else if (ct.includes("application/json")) {
        const j = await req.json();
        if (j && typeof j === "object") {
          c = String(j.c ?? c).trim();
          t = String(j.t ?? t).trim();
        }
      }
    } catch (_e) { /* unreadable body: fall back to the query string values */ }
  }
  return { clientId: c, token: t };
}

async function lookup(clientId: string, token: string): Promise<{ id: string } | null> {
  if (!clientId || !token) return null;
  const { data: cl } = await supabase.from("clients").select("id, comms_token").eq("id", clientId).maybeSingle();
  if (!cl || !cl.comms_token || !tokenMatches(token, String(cl.comms_token))) return null;
  return { id: cl.id };
}

const handle = async (req: Request): Promise<Response> => {   // R94 · D: served via withCors() below
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (tooBig(req)) return NOT_RECOGNISED();   // R94 · D: still the generic 200 answer
  try {
    const url = new URL(req.url);
    if (req.method !== "POST" && url.searchParams.get("format") !== "json") {
      // R95 · A: an email click (or a scanner) lands on the site page, which asks again as JSON. Nothing is touched.
      const c = url.searchParams.get("c") || "", t = url.searchParams.get("t") || "";
      const to = `${await siteUrl()}/unsubscribe?c=${encodeURIComponent(c)}&t=${encodeURIComponent(t)}`;
      return new Response(null, { status: 302, headers: { ...CORS, Location: to, "Cache-Control": "no-store" } });
    }
    const { clientId, token } = await readParams(req, url);
    if (!uuidRe.test(clientId) || !uuidRe.test(token)) return NOT_RECOGNISED();   // R94 · D
    const cl = await lookup(clientId, token);
    if (!cl) return NOT_RECOGNISED();

    // GET ?format=json: look, don't touch — the page shows its button only for a real pair.
    if (req.method !== "POST") return json({ ok: true, valid: true });

    // POST (the page's fetch, or the RFC 8058 one-click): the opt-out. Both flags, so the staff-facing record agrees with the send-time gate.
    const { error } = await supabase.from("clients").update({ comms_optout: true, marketing_opt_out: true }).eq("id", cl.id);
    return json(error ? { ok: false } : { ok: true });   // R95 · A: a failed write must not say "done"
  } catch (_err) {
    // Never a stack, never a 500: the page offers a retry.
    return json({ ok: false });
  }
};
Deno.serve(async (req: Request) => withCors(req, await handle(req)));   // R94 · D
