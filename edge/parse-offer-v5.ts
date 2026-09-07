/* =============================================================================
   parse-offer v5 — R84 (S4 · P1)
   Deployed version at time of writing: 4 (no earlier source in edge/), so this is v5.

   CHANGES (each tagged // R84):
     1. REAL CALLER CHECK. v4 relied on the gateway's verify_jwt alone, which the public anon key
        satisfies (pg_cron calls sibling functions with exactly that key). v5 resolves the caller
        with auth.getUser() through an RLS client and requires profiles.role in owner/admin/adviser.
        Anything else → 401. No role check = open Anthropic proxy on the firm's key.
     2. PER-USER DAILY CAP. 50 calls per London day per user via public.ai_usage_bump() (db/r84/
        30_ai_usage.sql), service-role client. Over the cap → 429 { error: "daily_limit" }. If the
        ledger call itself fails the request is refused (fail closed) — the owner sees "ai_usage
        unavailable" rather than an unmetered call.
     3. 413 (not 400) for an oversize PDF. Limit unchanged: 20,000,000 base64 chars (~15 MB).
   Everything else — system prompt, model, parsing, response shape — byte-identical to v4.

   OWNER-FACING: nothing changes for a signed-in adviser under 50 uploads a day. An introducer
   login can no longer call this endpoint (it never had a button for it).
   ============================================================================= */
import { createClient } from "jsr:@supabase/supabase-js@2";   // R84

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// R84: roles allowed to spend the AI budget, and the per-user per-day cap.
const AI_ROLES = ["owner", "admin", "adviser"];   // R84
const DAILY_CAP = 50;                              // R84
const MAX_PDF_CHARS = 20000000;                    // R84: unchanged limit (~15 MB), now a 413

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
  if (Number(calls) > DAILY_CAP) return json({ error: "daily_limit", detail: `You have used today's ${DAILY_CAP} AI document reads. Try again tomorrow.` }, 429);
  return null;
}

const SYSTEM = `You read UK mortgage offer documents for a mortgage broker and extract the key facts.

Return ONLY a JSON object (no markdown):
{
  "lender": string|null,
  "borrower_names": string|null,
  "property_address": string|null,      // the security property, full postal address as printed
  "product_name": string|null,          // e.g. "5 Year Fixed Rate until 31/08/2031"
  "rate_percent": number|null,          // the initial/product interest rate
  "rate_type": "fixed"|"tracker"|"variable"|"discount"|null,
  "rate_end_date": "YYYY-MM-DD"|null,   // when the initial product rate ends
  "erc_end_date": "YYYY-MM-DD"|null,    // the LAST date an early repayment charge applies
  "erc_summary": string|null,           // e.g. "5%/4%/3%/2%/1% stepping down annually"
  "loan_amount": number|null,           // the amount being borrowed / advanced
  "current_balance": number|null,       // outstanding mortgage balance stated on the offer, if given (e.g. the amount being repaid on a remortgage or product transfer). Null if not stated.
  "monthly_payment": number|null,       // the initial monthly payment (during the product period), in £
  "reversion_rate": number|null,        // the reversion / follow-on rate (lender's SVR or the rate that applies AFTER the product ends), as a percent
  "repayment_method": "repayment"|"interest_only"|"part_and_part"|null,  // capital & interest = "repayment"
  "property_value": number|null,
  "term_years": number|null,            // total mortgage term
  "offer_issued_date": "YYYY-MM-DD"|null,   // the date the offer was produced / issued / dated
  "offer_expiry_date": "YYYY-MM-DD"|null,
  "mortgage_account_number": string|null,   // the mortgage account / roll number, if the offer shows one
  "lender_reference": string|null,          // the lender's application / offer / case reference, if shown (distinct from the account number)
  "confidence_notes": string|null       // anything ambiguous the broker should double-check
}

Rules: UK dates (dd/mm/yyyy on the page → YYYY-MM-DD). Only extract what the document states — use null when absent, never guess a figure. property_address is the security (mortgaged) property the offer is secured on, given as the full postal address exactly as printed — house number or name, street, town, county and postcode — on a single comma-separated line; do not substitute the borrower's correspondence address if the document shows them separately. The ERC end date matters greatly: if the ERC period differs from the rate end date, say so in confidence_notes. repayment_method must be one of the three codes (a "capital and interest" / "capital repayment" mortgage is "repayment"); use null if the document does not state it. For monthly_payment give the initial payment during the product period (not any later reverted figure). For reversion_rate give the follow-on/SVR percentage, not the initial product rate. mortgage_account_number and lender_reference are different things — only fill each from a value the document actually labels as such.`;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set. Add it in Supabase Dashboard → Edge Functions → Secrets." }, 400);

  let pdf = "";
  try {
    const body = await req.json();
    pdf = String(body.pdf_base64 ?? "");
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  if (!pdf) return json({ error: "No PDF provided" }, 400);
  if (pdf.length > MAX_PDF_CHARS) return json({ error: "PDF too large (max ~15MB)" }, 413);   // R84: 413, same limit

  // R84: who is asking, and have they used today's allowance? Checked AFTER the cheap body
  // validation so a malformed request costs nothing, BEFORE anything reaches Anthropic.
  const refused = await gate(req, "parse-offer", pdf.length);   // R84
  if (refused) return refused;                                   // R84

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
          { type: "text", text: "Extract the mortgage offer details as specified." },
        ],
      }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) return json({ error: data?.error?.message || `Anthropic API error ${resp.status}` }, 502);

  let text = (data.content ?? []).map((b: any) => b.text ?? "").join("");
  text = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return json({ error: "Could not read the document", raw: text.slice(0, 300) }, 502);
  try {
    return json({ offer: JSON.parse(text.slice(start, end + 1)) });
  } catch {
    return json({ error: "Could not parse extraction", raw: text.slice(0, 300) }, 502);
  }
});
