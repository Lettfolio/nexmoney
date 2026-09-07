// new-lead v4 (R84) — public enquiry-form endpoint (contact.html).
//
// R84 CHANGES (deployed v3 → v4):
//   1. The per-IP limiter keyed on the FIRST X-Forwarded-For entry, which is whatever the caller
//      sent (proxies append the real address after it). A caller rotating a fake XFF per request
//      sidestepped the 5/hour cap, leaving only the 120/hour global valve — which then dropped
//      genuine enquiries for the rest of the hour. v4 keys on cf-connecting-ip (set by the edge),
//      else x-real-ip, else the LAST X-Forwarded-For hop.
//   2. When the global valve trips, every swallowed enquiry is logged with the hashed source so
//      the owner can see it in the function logs rather than lose leads silently. Response to the
//      caller is unchanged ({ok:true}).
//   No behaviour change for a genuine visitor.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);

// Privacy-friendly IP fingerprint (SHA-256 hex, truncated) for per-IP rate limiting.
async function ipHash(req: Request): Promise<string> {
  // R84: trust the edge-set header first; the client-supplied head of X-Forwarded-For is spoofable,
  // the LAST hop is the one the platform's proxy appended.
  const fwd = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || fwd[fwd.length - 1] || "unknown";   // R84
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nexmoney:" + ip));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }

  // Honeypot: hidden field real users never fill in
  if (clip(b.website, 50)) return json({ ok: true });

  const name = clip(b.name, 120);
  const email = clip(b.email, 200);
  const phone = clip(b.phone, 40);
  if (!name || (!email && !phone)) return json({ error: "Name and a contact method are required" }, 400);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Invalid email" }, 400);

  const hour = new Date(Date.now() - 3600000).toISOString();
  const src = await ipHash(req);

  // Per-IP cap: one source can't flood, and (crucially) can't push genuine leads
  // from other visitors past a global ceiling. 5/hour per IP.
  const { count: ipCount } = await admin.from("leads")
    .select("id", { count: "exact", head: true })
    .eq("source_ip", src).gte("created_at", hour);
  if ((ipCount ?? 0) >= 5) return json({ ok: true }); // swallow silently

  // Generous global safety valve (raised from 15) so a single spammer can't block everyone.
  const { count: total } = await admin.from("leads")
    .select("id", { count: "exact", head: true }).gte("created_at", hour);
  if ((total ?? 0) >= 120) {
    // R84: name the dropped enquiry (hashed source + page, no PII) so the loss is visible in the logs.
    console.error(`new-lead global hourly ceiling hit (${total}) — enquiry DROPPED src=${src} page=${clip(b.page, 200)} — possible attack`);
    return json({ ok: true });
  }

  const { error } = await admin.from("leads").insert({
    name,
    email: email || null,
    phone: phone || null,
    enquiry_type: clip(b.enquiry_type, 80) || null,
    property_value: clip(b.property_value, 40) || null,
    message: clip(b.message, 2000) || null,
    source_page: clip(b.page, 200) || null,
    source_ip: src,
  });
  if (error) return json({ error: "Could not save enquiry" }, 500);
  return json({ ok: true });
});
