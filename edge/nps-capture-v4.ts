// nps-capture v4 (R84) — public endpoint behind the rating links in the review-request email.
//
// R84 CHANGES (deployed v3 → v4):
//   1. GET ?case=&score=&token=  is now SIDE-EFFECT-FREE. It only validates the shape of the
//      three values and 302-redirects to {site_url}/feedback?case=&token=&score= — the same
//      static page detractors already landed on. Nothing is read or written. WHY: every URL in
//      a delivered email is fetched by link scanners (Outlook Safe Links, Defender, Proofpoint)
//      before the client sees it; v3 recorded whichever of the five score links a scanner
//      fetched first, write-once, and raised "Unhappy review score" tasks for scores the client
//      never gave (the same defect unsubscribe v1 had).
//   2. POST now carries the score. Body {case|case_id, token, score?, text|reason?}. The page
//      POSTs the score on load (JavaScript, which scanners do not execute); the server records it
//      write-once exactly as v3 did on GET, and answers {score, detractor, note_created, redirect}
//      so the page can branch client-side (promoters → review link via `redirect`).
//      v3 read `case`/`text` while feedback.html has been sending `case_id`/`reason` — v4 accepts
//      both spellings, so the comment box works again.
//   3. The review comment is stored RAW in case_notes.body (v3 HTML-escaped it at storage; the
//      app escapes on render, so "Tom & Jerry's" showed as "Tom &amp; Jerry&#39;s").
//   4. Task due dates use the Europe/London calendar date, not the UTC one.
//   5. Only the four settings keys this function uses are read (v3 pulled every settings row,
//      cron_key and API keys included, into memory on each anonymous request).
//   6. OWNER-FACING BEHAVIOUR: a 7–8 ("passive") score now lands on the feedback page (which
//      already has copy for that band) instead of {site}?thanks=1; 9–10 still ends on the review
//      link; 0–6 still gets the "what went wrong" box and the adviser task.
//
// verify_jwt is disabled: auth is the per-case nps_token, compared in code, never in the filter.
import { createClient } from "jsr:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
}

const uuidRe = /^[0-9a-fA-F-]{36}$/;
const MAX_FEEDBACK = 4000;
const NOTE_PREFIX = "Review feedback (";

// R84: the firm's calendar date (Europe/London), YYYY-MM-DD. toISOString().slice(0,10) is the UTC
// date, which is yesterday's between 23:00 and 00:00 BST.
const londonDate = (d: Date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// R84: read only the keys this function uses.
const SETTING_KEYS = ["site_url", "review_platform_link", "google_review_link", "company_name"];
async function settings(): Promise<Record<string, string>> {
  const { data } = await supabase.from("settings").select("key,value").in("key", SETTING_KEYS);
  const s: Record<string, string> = {};
  (data ?? []).forEach((r: any) => (s[r.key] = r.value));
  return s;
}

const parseScore = (v: unknown): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : NaN;
};

const clientName = async (clientId: string | null) => {
  if (!clientId) return "client";
  const { data: cl } = await supabase.from("clients").select("first_name,last_name").eq("id", clientId).maybeSingle();
  return cl ? `${cl.first_name ?? ""} ${cl.last_name ?? ""}`.trim() || "client" : "client";
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const s = await settings();
  const site = s.site_url || "https://nexmoney.co.uk";
  const reviewLink = s.review_platform_link || s.google_review_link || site;

  // ---- R84: POST — the score (write-once) and/or the detractor's written answer ------------
  if (req.method === "POST") {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "bad body" }, 400); }

    // Honeypot: a hidden field no real client fills in. Look successful to bots.
    if (String(b.website ?? "").trim()) return json({ ok: true });

    const caseId = String(b.case ?? b.case_id ?? "");          // R84: both spellings
    const token = String(b.token ?? "");
    const text = String(b.text ?? b.reason ?? "").trim();       // R84: both spellings
    const score = parseScore(b.score);
    if (!uuidRe.test(caseId) || !uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    if (score !== null && Number.isNaN(score)) return json({ error: "invalid score" }, 400);
    if (score === null && !text) return json({ error: "nothing to save" }, 400);
    if (text.length > MAX_FEEDBACK) return json({ error: "too long" }, 413);

    const { data: kase } = await supabase.from("cases")
      .select("id, client_id, assigned_to, nps_token, nps_score")
      .eq("id", caseId).maybeSingle();
    if (!kase || !kase.nps_token || kase.nps_token !== token) return json({ error: "not_found" }, 404);

    // R84: record the score — first response wins; a second submission just reads it back.
    // This is exactly the v3 GET write, moved behind a POST that scanners never make.
    let effective: number | null = kase.nps_score;
    if (effective == null && score !== null) {
      const { data: rec } = await supabase.from("cases")
        .update({ nps_score: score, nps_score_at: new Date().toISOString() })
        .eq("id", caseId).is("nps_score", null).select("nps_score").maybeSingle();
      if (rec) {
        effective = score;
        // Unhappy (0-6) -> internal follow-up task; passives/promoters -> none.
        if (score <= 6) {
          const name = await clientName(kase.client_id);
          await supabase.from("case_tasks").insert({
            case_id: caseId,
            title: `Unhappy review score (${score}/10) — call ${name}`,
            due_date: londonDate(),                                       // R84
            assigned_to: kase.assigned_to,
          });
        }
      } else {
        // Lost a race with another submission: re-read what is on record.
        const { data: again } = await supabase.from("cases").select("nps_score").eq("id", caseId).maybeSingle();
        effective = again?.nps_score ?? null;
      }
    }
    if (effective == null) return json({ error: "no score on record" }, 400);
    const detractor = effective <= 6;

    // The written answer. Only a recorded detractor score opens this box. Without that guard
    // the endpoint would be an unauthenticated "write a note on this case" API for anyone
    // holding any nps link.
    let noteCreated = false;
    if (text && detractor) {
      // One answer per case: also the rate cap, with no new table.
      const { count: already } = await supabase.from("case_notes")
        .select("id", { count: "exact", head: true })
        .eq("case_id", caseId).like("body", NOTE_PREFIX + "%");
      if ((already ?? 0) === 0) {
        const name = await clientName(kase.client_id);
        // R84: stored RAW. The app HTML-escapes note bodies at render time (app.js esc()); escaping
        // here as well double-encoded ampersands and apostrophes in the timeline.
        const { error: noteErr } = await supabase.from("case_notes").insert({
          case_id: caseId,
          body: `${NOTE_PREFIX}${effective}/10): ${text}`,
        });
        if (noteErr) return json({ error: "could not save" }, 500);
        noteCreated = true;

        // The owner, not the adviser: an unhappy client who has bothered to write something is
        // the owner's problem. Fall back to nobody only if no owner profile exists.
        const { data: owner } = await supabase.from("profiles")
          .select("id").eq("role", "owner").order("created_at", { ascending: true }).limit(1).maybeSingle();
        await supabase.from("case_tasks").insert({
          case_id: caseId,
          title: `Call ${name} — review feedback needs attention`,
          due_date: londonDate(new Date(Date.now() + 86400000)),          // R84
          assigned_to: owner?.id ?? null,
        });
      }
    }

    return json({
      ok: true,
      score: effective,
      detractor,
      note_created: noteCreated,
      redirect: effective >= 9 ? reviewLink : null,                       // R84: promoters → review site
    });
  }

  const caseId = url.searchParams.get("case") ?? "";
  const token = url.searchParams.get("token") ?? "";
  const scoreParam = url.searchParams.get("score") ?? "";
  const score = parseInt(scoreParam, 10);
  const wantsJson = url.searchParams.get("format") === "json";

  // ---- The feedback page asking whether it may show its box --------------------------------
  // Deliberately thin: a first name to greet with, the score already recorded, and nothing else.
  if (wantsJson) {
    if (!uuidRe.test(caseId) || !uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    const { data: kase } = await supabase.from("cases")
      .select("id, client_id, nps_token, nps_score").eq("id", caseId).maybeSingle();
    if (!kase || !kase.nps_token || kase.nps_token !== token) return json({ error: "not_found" }, 404);
    const { data: cl } = await supabase.from("clients").select("first_name").eq("id", kase.client_id).maybeSingle();
    const { count: already } = await supabase.from("case_notes")
      .select("id", { count: "exact", head: true })
      .eq("case_id", caseId).like("body", NOTE_PREFIX + "%");
    return json({
      ok: true,
      first_name: (cl?.first_name ?? "").trim(),
      company: s.company_name || "NexMoney",
      score: kase.nps_score,
      can_comment: kase.nps_score != null && kase.nps_score <= 6 && (already ?? 0) === 0,
    });
  }

  // ---- R84: the email link. LOOK, DON'T TOUCH — hand the three values to the page, which
  // records the score with a POST once a real browser has run its script. No lookup here either:
  // a wrong token is the page's 404, and this endpoint must not be an "is this id real" oracle.
  if (!uuidRe.test(caseId) || !uuidRe.test(token) || isNaN(score) || score < 0 || score > 10) {
    return redirect(site);
  }
  return redirect(`${site}/feedback?case=${caseId}&token=${token}&score=${score}`);
});
