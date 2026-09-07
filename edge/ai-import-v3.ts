/* =============================================================================
   ai-import v3 — R84 (S4 · P1)
   Deployed version at time of writing: 2 (no earlier source in edge/), so this is v3.

   CHANGES (each tagged // R84):
     1. REAL CALLER CHECK. v2 relied on the gateway's verify_jwt alone, which the public anon key
        satisfies. v3 resolves the caller with auth.getUser() through an RLS client and requires
        profiles.role in owner/admin/adviser. Anything else → 401.
     2. PER-USER DAILY CAP. 50 calls per London day per user via public.ai_usage_bump() (db/r84/
        30_ai_usage.sql). Over the cap → 429 { error: "daily_limit" }. Ledger unavailable → 503
        (fail closed).
     3. INPUT LIMIT 300k → 200k characters, and the refusal is a 413 (was 400). Message unchanged
        apart from the number. max_tokens stays 32000.
   Everything else — system prompt, model, parsing, response shape — byte-identical to v2.

   OWNER-FACING: an import chunk over 200k characters is now refused with the same "import in
   smaller chunks" message (the UI already chunks). Introducer logins can no longer call this.
   ============================================================================= */
import { createClient } from "jsr:@supabase/supabase-js@2";   // R84

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// R84: roles allowed to spend the AI budget, the per-user per-day cap, and the input ceiling.
const AI_ROLES = ["owner", "admin", "adviser"];   // R84
const DAILY_CAP = 50;                              // R84
const MAX_CONTENT_CHARS = 200000;                  // R84: was 300000

// R84: resolve the caller and meter the call. Returns a Response to send on refusal, else null.
async function gate(req: Request, fn: string, bytes: number): Promise<Response | null> {   // R84
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "unauthorized" }, 401);
  const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
  const { data: u, error: uErr } = await uc.auth.getUser();
  if (uErr || !u?.user) return json({ error: "unauthorized" }, 401);
  const { data: p } = await uc.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
  if (!p || !AI_ROLES.includes(String(p.role))) return json({ error: "unauthorized" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: calls, error: mErr } = await admin.rpc("ai_usage_bump", { p_uid: u.user.id, p_fn: fn, p_bytes: bytes });
  if (mErr) { console.error(`${fn}: ai_usage unavailable:`, mErr.message); return json({ error: "ai_usage unavailable — ask the Owner to apply db/r84/30_ai_usage.sql" }, 503); }
  if (Number(calls) > DAILY_CAP) return json({ error: "daily_limit", detail: `You have used today's ${DAILY_CAP} AI imports. Try again tomorrow.` }, 429);
  return null;
}

const SYSTEM = `You are a data-entry assistant for NexMoney, a UK mortgage broker. You receive messy client/case data (spreadsheet rows, email text, notes) and convert it into structured JSON for their CRM.

Return ONLY a JSON array (no markdown, no commentary). Each element is one mortgage case (or a bare client contact if there is no case information):
{
  "client_name": string,            // required, exactly as written e.g. "Mr I Bellamy & Mrs S Bellamy"
  "email": string|null,
  "phone": string|null,
  "case_kind": "purchase"|"remortgage"|"product_transfer"|"buy_to_let"|"first_time_buyer"|"other"|null,
  "stage": "enquiry"|"fact_find"|"decision_in_principle"|"application"|"offer"|"exchange"|"completed"|"not_proceeding"|null,
  "lender": string|null,
  "product_name": string|null,
  "rate_percent": number|null,
  "rate_type": "fixed"|"tracker"|"variable"|"discount"|null,
  "rate_end_date": "YYYY-MM-DD"|null,
  "rate_end_estimated": boolean,    // true if you inferred the date rather than it being stated
  "erc_end_date": "YYYY-MM-DD"|null,
  "loan_amount": number|null,
  "property_value": number|null,
  "broker_fee": number|null,
  "completed_date": "YYYY-MM-DD"|null,
  "note": string|null               // anything useful that doesn't fit the fields above
}

Rules:
- UK date convention: dd/mm/yyyy. Convert to YYYY-MM-DD.
- Common shorthand: T = product_transfer, R = remortgage, P = purchase; 2yr/5yr etc = fixed product term; Trk = tracker.
- If a rate end date is not stated but a completion date and product term are, you may estimate rate_end_date = completion + term and set rate_end_estimated = true. Never invent dates otherwise.
- If a row is clearly just contact details (name + email/phone), output it with stage null and no case fields.
- Skip header rows, totals, and empty rows. Do not fabricate data that is not present.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set. Add it in Supabase Dashboard → Edge Functions → Secrets." }, 400);

  let content = "";
  try {
    const body = await req.json();
    content = String(body.content ?? "");
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (!content.trim()) return json({ error: "No data provided" }, 400);
  if (content.length > MAX_CONTENT_CHARS) return json({ error: "Too much data at once — import in smaller chunks (max ~200k characters)." }, 413);   // R84: 200k, 413

  // R84: who is asking, and have they used today's allowance? After the cheap body checks,
  // before anything reaches Anthropic.
  const refused = await gate(req, "ai-import", content.length);   // R84
  if (refused) return refused;                                     // R84

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 32000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) return json({ error: data?.error?.message || `Anthropic API error ${resp.status}` }, 502);

  let text = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  text = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1) return json({ error: "AI did not return structured data — try again or use a smaller chunk.", raw: text.slice(0, 500) }, 502);
  try {
    const rows = JSON.parse(text.slice(start, end + 1));
    return json({ rows });
  } catch {
    return json({ error: "Could not parse AI output — try a smaller chunk.", raw: text.slice(0, 500) }, 502);
  }
});
