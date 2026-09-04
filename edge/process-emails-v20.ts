import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FN_BASE = (Deno.env.get("SUPABASE_URL") || "") + "/functions/v1";

// Round-4 staff roles. Production has no 'staff' rows; the pre-v8 hardcoded
// 'staff' check matched nobody, breaking interactive sends and per-adviser From/Reply-To.
const STAFF_ROLES = ["owner", "admin", "adviser", "staff"];

/* v19: the four marketing-adjacent types. Opt-out is honoured for ALL FOUR (owner decision),
   and each carries the unsubscribe footer below the sign-off. */
const MARKETING_TYPES = ["birthday_greeting", "completion_anniversary", "referral_request", "review_request"];

/* v20: THE FINANCIAL PROMOTIONS. A different list from MARKETING_TYPES above and deliberately so:
   MARKETING_TYPES is "emails a client may unsubscribe from"; this is "emails that are regulated
   financial promotions and may not leave at all until the firm's network has approved the
   templates". The three are exactly the three settings names in its own paragraph — the referral
   nudge, the protection intro and the GI email — and nothing else. A rate-end reminder, a document
   request, a fact-find, a fee request, a review request, a birthday or an anniversary note are all
   servicing/relationship mail about business the client already has, not a promotion of new
   business, so none of them is gated here.
   WHY IT EXISTS: settings.financial_promotions_approved was read in exactly ONE place in the whole
   system — queue_automated_emails, gating referral_request only — while both `protection_offer`
   queue paths in the admin app inserted straight into email_queue and fired a scoped send. Those
   paths now refuse client-side (R82 · A1), and this is the belt to that pair of braces: a row that
   reached the queue by any other route — queued before the switch was turned off, written by a
   script, inserted by a future surface — is CANCELLED at send time rather than delivered.
   Note the asymmetry with the hold (settings.email_hold): the hold PARKS mail and releases it
   later, so its rows stay 'queued'. This is a refusal, not a pause — the promotion was never
   approved, so the row is closed out with the reason on it. */
const FIN_PROMO_TYPES = ["referral_request", "protection_offer", "gi_exchange"];

// Allow a signed-in staff member OR a server caller with the shared cron key.
async function authorize(req: Request): Promise<boolean> {
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data } = await supabase.from("settings").select("value").eq("key", "cron_key").maybeSingle();
    if (data?.value && cronKey === data.value) return true;
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (token) {
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await uc.auth.getUser();
    if (u?.user) {
      const { data: p } = await supabase.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (p?.role && STAFF_ROLES.includes(p.role)) return true;
    }
  }
  return false;
}

const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";
const money = (n: number | null) => n == null ? "" : new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(n);
const escapeHtml = (t: string) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

function wrap(inner: string, company: string) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#0f2a4a;padding:20px 28px;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">${company}</span></div>
    <div style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">${inner}</div>
    <div style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px;">${company} &middot; This email was sent regarding your mortgage. If anything looks wrong, just reply and let us know.</div>
  </div></body></html>`;
}

function npsScale(caseId: string, tok: string) {
  const opts = [[10, "😍 Loved it"], [8, "😊 Good"], [6, "😐 OK"], [4, "😕 Meh"], [2, "😞 Poor"]];
  const btns = opts.map(([n, label]) =>
    `<a href="${FN_BASE}/nps-capture?case=${caseId}&score=${n}&token=${tok}" style="display:inline-block;margin:4px;padding:10px 14px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;color:#0f2a4a;text-decoration:none;font-size:14px;">${label}</a>`
  ).join("");
  return `<p style="text-align:center;margin:20px 0 6px;font-weight:bold;">How likely are you to recommend us to a friend?</p><div style="text-align:center;">${btns}</div>`;
}

function compose(type: string, c: any, cl: any, s: Record<string, string>, adv: any, extra: any = {}) {
  const company = s.company_name || "NexMoney";
  const adviser = (adv && adv.full_name) || s.adviser_name || "NexMoney";
  // Per-adviser phone falls back to the firm-wide number.
  const advPhone = (adv && adv.phone) || s.adviser_phone || "";
  const phone = advPhone ? ` or call ${advPhone}` : "";
  const first = (cl.first_name || "").trim() || (cl.last_name || "").trim();
  // Per-adviser sign-off block (multi-line, HTML-escaped) when set, else the firm default.
  const advSignoff = (adv && adv.email_signoff && adv.email_signoff.trim()) || "";
  const signoff = advSignoff
    ? `<p>${advSignoff.split(/\r?\n/).map(escapeHtml).join("<br>")}</p>`
    : `<p>Best regards,<br>${adviser}<br>${company}</p>`;

  /* v19: unsubscribe footer for the four marketing-adjacent types — one small line above the
     existing grey footer (wrap() adds that, so this line closes the inner body). comms_token
     comes from the clients row already joined onto the queue row. */
  const unsub = MARKETING_TYPES.includes(type) && cl && cl.id && cl.comms_token
    ? `<p style="margin:24px 0 0;color:#6b7280;font-size:12px;">Prefer not to get emails like this? <a href="${FN_BASE}/unsubscribe?c=${cl.id}&t=${cl.comms_token}" style="color:#6b7280;">Unsubscribe</a>.</p>`
    : "";

  // R6: security-property naming on client-facing, case-scoped templates.
  // `prop` is the full postal address, HTML-escaped. When the case has no
  // property_address every template below falls back to the exact v8 wording.
  const prop = escapeHtml(String((c && c.property_address) || "").trim()).trim();
  // Reference line used where an in-sentence mention would read awkwardly.
  const regarding = prop ? `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">Regarding: ${prop}</p>` : "";
  // In-sentence fragments (empty string keeps v8 wording byte-for-byte).
  const onProp = prop ? ` on ${prop}` : "";
  const forProp = prop ? ` for ${prop}` : "";
  const ofProp = prop ? ` of ${prop}` : "";

  // R7: instant acknowledgement for a brand-new website lead. There is no case
  // and no adviser assigned yet, so this always uses the firm-level fallbacks.
  if (type === "lead_ack") {
    const greet = first || "there";
    const subject = `Thank you for your enquiry – ${company}`;
    const inner = `<p>Hi ${greet},</p><p>Thank you for getting in touch with ${company}. Your enquiry has reached us and it is in hand.</p><p>${adviser} will call you shortly to talk through what you are looking for and answer any questions. There is nothing you need to do in the meantime.</p><p>If it is easier to speak sooner, just reply to this email${phone}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "welcome") {
    const subject = `Welcome to ${company} – here's what happens next`;
    const inner = `<p>Hi ${first},</p><p>Thanks for your enquiry – it's great to have you on board. I'll be looking after your mortgage personally.</p><p>Here's how it works: we'll have a quick chat about your situation, I'll search the market for the right deal, handle the application and paperwork, and keep you updated at every step – you won't need to chase us.</p><p>I'll be in touch very shortly. In the meantime, just reply to this email${phone} if there's anything you'd like to ask.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  /* R66 (v17) — an email the adviser WROTE from the case. The queue row carries the adviser's
     own subject and body: the app has already HTML-escaped the text and split it into <p>/<br>
     paragraphs (nothing else can appear in it). This wraps that body in the house template with
     the usual "Regarding:" line and sign-off and never rewrites the subject or the words. */
  if (type === "custom") {
    if (!extra.customSubject || !extra.customBody) throw new Error("custom email row has no subject or body");
    const inner = `${regarding}${extra.customBody}${signoff}`;
    return { subject: String(extra.customSubject), html: wrap(inner, company) };
  }
  /* R12a (D3): the digital fact-find finally goes out through the queue like every
     other client email — the old path was a bare mailto: that recorded nothing and
     signed off as the firm owner regardless of whose case it was. The link is built
     server-side from the case's fact_finds row (minted here if the app didn't create
     one), so the email always carries a token that actually authenticates. If
     site_url is not configured the send FAILS with a stated reason rather than
     sending a letter with no link — a fact-find email without its link is noise. */
  if (type === "factfind") {
    if (!extra.ffLink) throw new Error("site_url not set — cannot build the fact-find link");
    const subject = `${company} – your mortgage fact find (5–10 minutes)`;
    const inner = `${regarding}<p>Hi ${first},</p><p>To get your mortgage moving, the next step is a short fact find — it tells us about you, your income and what you're looking to do, so the advice we give you actually fits.</p><p style="text-align:center;margin:24px 0;"><a href="${extra.ffLink}" style="background:#0f2a4a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold;display:inline-block;">Start your fact find</a></p><p style="color:#6b7280;font-size:13px;">The link is personal to you — there's no login and nothing to install. It saves as you go, so you can stop and come back any time. On a phone is fine.</p><p>If you'd rather do it over the phone, just reply to this email${phone} and we'll take the details together.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "docs_request") {
    // R9: checklist-aware. When the case carries outstanding case_documents rows
    // we name ONLY what is still missing, so a client who has already sent three
    // of five things is never asked for all five again. With no checklist on the
    // case the wording below falls back to the exact v10 email, byte for byte.
    const outstanding: string[] = Array.isArray(extra.docs) ? extra.docs.filter(Boolean) : [];
    if (outstanding.length) {
      const site = (s.site_url || "").replace(/\/+$/, "");
      const link = extra.docToken && site ? `${site}/docs?token=${extra.docToken}` : "";
      const chase = extra.docChase === true;
      const n = outstanding.length;
      const subject = chase
        ? `${company} – still waiting on ${n} document${n === 1 ? "" : "s"}`
        : `${company} – documents we'll need from you`;
      const opening = chase
        ? `<p>Just a gentle nudge – we're still missing ${n === 1 ? "one thing" : "a few things"} before we can move your mortgage forward:</p>`
        : `<p>To get your mortgage moving we'll need a few documents. Here's what we're still missing:</p>`;
      const cta = link
        ? `<p style="text-align:center;margin:24px 0;"><a href="${link}" style="background:#0f2a4a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold;display:inline-block;">Send your documents</a></p><p style="color:#6b7280;font-size:13px;">The link is personal to you – there's no login and nothing to install. Photos taken on your phone are fine. If you'd rather, just reply to this email with the files attached.</p>`
        : `<p>Photos or scans are both fine – just reply to this email with them attached.</p>`;
      const inner = `<p>Hi ${first},</p>${opening}<ul>${outstanding.map((d) => `<li>${escapeHtml(String(d))}</li>`).join("")}</ul>${cta}<p>The sooner we have these, the sooner we can secure your deal${phone ? " – any questions, just reply" + phone : ""}.</p>${signoff}`;
      return { subject, html: wrap(inner, company) };
    }
    const docs = (s.docs_list || "").split("|").filter(Boolean);
    const subject = `${company} – documents we'll need from you`;
    const inner = `<p>Hi ${first},</p><p>To get your mortgage moving we'll need a few documents. Could you reply to this email attaching:</p><ul>${docs.map((d) => `<li>${d.trim()}</li>`).join("")}</ul><p>Photos or scans are both fine. The sooner we have these, the sooner we can secure your deal${phone ? " – any questions, just reply" + phone : ""}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "submitted_update") {
    const subject = `Good news – your mortgage application has been submitted`;
    const inner = `<p>Hi ${first},</p><p>A quick update: your application${c.lender ? ` to <strong>${c.lender}</strong>` : ""}${forProp} has been submitted. 🎉</p><p>The lender will now assess it – typically they come back to us within a few working days, sometimes with requests for extra information (that's completely normal). We'll handle all of that and let you know the moment there's news.</p><p>Nothing is needed from you right now. Any questions, just reply${phone}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "offer_update") {
    /* R54 — when the queued row carries the offer PDF (attachment_path), say so: an attachment
       with no sentence explaining it looks like a phishing red flag to a nervous client. Without
       an attachment the wording stays byte-for-byte the pre-R54 email. */
    const attachNote = extra.offerAttached ? `<p>We've attached a copy of your offer document to this email for your records.</p>` : "";
    const subject = `Your mortgage offer has been issued 🎉`;
    const inner = `<p>Hi ${first},</p><p>Excellent news – ${c.lender ? `<strong>${c.lender}</strong> has` : "the lender has"} issued your mortgage offer${forProp}.</p>${attachNote}<p>From here the legal work takes over: the solicitors will work towards completion and we'll chase them regularly so things keep moving. We'll keep you posted at every milestone.</p><p>Any questions at all, just reply${phone}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "protection_offer") {
    const subject = `Your mortgage is agreed – have you protected it?`;
    const inner = `${regarding}<p>Hi ${first},</p><p>With your mortgage${c.lender ? ` from <strong>${c.lender}</strong>` : ""} now agreed, this is a natural moment to think about protecting it.</p><p>A mortgage is one of the biggest financial commitments most of us ever take on. Many of our clients choose to put cover in place – such as life cover, critical illness cover or income protection – so that the mortgage would be taken care of if the unexpected happened.</p><p>If you'd like, we can review the options alongside your mortgage with no obligation – it usually takes one short conversation. Just reply to this email${phone} and we'll arrange a time.</p><p style="color:#6b7280;font-size:13px;">This email is for information only and is not personal advice or a recommendation. Any recommendation would only follow a full review of your circumstances.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "gi_exchange") {
    const subject = `Buildings insurance needs to be in place when you exchange`;
    const inner = `<p>Hi ${first},</p><p>As you approach exchange of contracts on your purchase${ofProp}, a quick but important reminder: <strong>buildings insurance must be in place from the moment you exchange</strong> – it's a standard condition of your mortgage.</p><p>If you haven't arranged cover yet, we can help you compare quotes quickly, and look at contents cover at the same time if useful.</p><p>Just reply to this email${phone} and we'll get it sorted well before your exchange date.</p><p style="color:#6b7280;font-size:13px;">This email is for information only and is not personal advice or a recommendation.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "completion_congrats") {
    const subject = `Congratulations – your mortgage has completed! 🏡`;
    const inner = `<p>Hi ${first},</p><p>Wonderful news – your mortgage${onProp} has completed. Congratulations!</p><p>We'll stay in touch: before your current rate ends we'll automatically review the market for you, so you'll never drift onto an expensive standard variable rate.</p><p>It's been a pleasure – and if you ever need anything in the meantime, just reply${phone}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "referral_request") {
    const subject = `Know someone who needs mortgage help?`;
    const inner = `<p>Hi ${first},</p><p>I hope you're settling in well since your mortgage completed.</p><p>A small favour: most of our clients come to us through recommendations from people like you. If a friend, family member or colleague needs a mortgage or is coming to the end of their rate, we'd love to help them the same way we helped you – just pass on this email or our number${advPhone ? " (" + advPhone + ")" : ""}.</p><p>Thank you – it genuinely makes a difference to a small firm like ours.</p>${signoff}${unsub}`; // v19: unsubscribe footer
    return { subject, html: wrap(inner, company) };
  }
  if (type === "birthday_greeting") {
    const subject = `Happy birthday from ${company}! 🎂`;
    const inner = `<p>Hi ${first},</p><p>Just a quick note from all of us at ${company} to wish you a very happy birthday. We hope you have a wonderful day.</p><p>We're always here if your mortgage or protection needs ever change – but today, no business, just our best wishes!</p>${signoff}${unsub}`; // v19: unsubscribe footer
    return { subject, html: wrap(inner, company) };
  }
  if (type === "completion_anniversary") {
    const subject = `A year on – how's the home? 🏡`;
    const inner = `<p>Hi ${first},</p><p>It's been a year since your mortgage${c && c.lender ? ` with <strong>${c.lender}</strong>` : ""} completed – we hope the home is treating you well!</p><p>A quick reminder that we keep an eye on your rate for you and will be in touch well before it ends. If anything has changed – a move, home improvements, or you're thinking about protection – just reply${phone} and we'll help.</p>${signoff}${unsub}`; // v19: unsubscribe footer
    return { subject, html: wrap(inner, company) };
  }
  if (type === "rate_end_reminder") {
    const subject = `Your mortgage rate ends on ${fmtDate(c.rate_end_date)} – let's review your options`;
    const inner = `<p>Hi ${first},</p><p>Your current ${c.rate_type || "fixed"} rate${c.lender ? ` with <strong>${c.lender}</strong>` : ""}${c.rate_percent ? ` (${c.rate_percent}%)` : ""}${prop ? ` for your mortgage on ${prop}` : ""} is due to end on <strong>${fmtDate(c.rate_end_date)}</strong>.</p><p>When it ends you'll usually move onto your lender's standard variable rate, which is often significantly more expensive. The good news: we can typically secure a new deal up to 6 months in advance, so now is the perfect time to review your options.</p><p>Simply reply to this email${phone} and we'll take care of the rest – including checking whether staying with your current lender or switching gets you the better deal.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "rate_end_chase") {
    const subject = `Still time to sort your new rate before ${fmtDate(c.rate_end_date)}`;
    const inner = `<p>Hi ${first},</p><p>Just a friendly nudge – your ${c.rate_type || "fixed"} rate${c.lender ? ` with <strong>${c.lender}</strong>` : ""}${prop ? ` for your mortgage on ${prop}` : ""} ends on <strong>${fmtDate(c.rate_end_date)}</strong>, and we haven't yet locked anything in for you.</p><p>Rates can be secured months in advance and re-checked right up to completion – so there's no downside to getting something reserved now.</p><p>Reply to this email${phone} and we'll take it from there. If you've already sorted a new deal elsewhere, just let us know and we'll close your file.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  if (type === "review_request") {
    const link = s.review_platform_link || s.google_review_link || "";
    // R9: the reminder rides on the SAME email_type. compose() only ever sees the
    // type, and email_queue has no variant column, so process-emails works out
    // downstream that this case already had a review request go out and flags it
    // here. That avoids both a new email_type enum value and a schema change.
    const reminder = extra.reviewReminder === true;
    const subject = reminder
      ? `A quick nudge – how did we do?`
      : `Thanks for choosing ${company} – how did we do?`;
    const useNps = s.nps_enabled === "on" && c && c.id && c.nps_token;
    const cta = useNps
      ? npsScale(c.id, c.nps_token)
      : (link ? `<p style="text-align:center;margin:24px 0;"><a href="${link}" style="background:#0f2a4a;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:bold;display:inline-block;">Leave a review</a></p>` : "");
    const inner = reminder
      ? `<p>Hi ${first},</p><p>I dropped you a note a little while ago asking how we did with your mortgage. I know how easily these things slide down the list, so this is just one gentle reminder – and the last time we'll ask.</p><p>It really does take 60 seconds, and it makes a genuine difference to a small business like ours.</p>${cta}<p>Either way, thank you – we're here whenever you need us next.</p>${signoff}${unsub}` // v19: unsubscribe footer
      : `<p>Hi ${first},</p><p>Congratulations on completing your mortgage – it's been a pleasure helping you.</p><p>If you have 60 seconds, letting us know how we did makes a huge difference to a small business like ours.</p>${cta}<p>Thank you – and remember we're here whenever you need us next.</p>${signoff}${unsub}`; // v19: unsubscribe footer
    return { subject, html: wrap(inner, company) };
  }
  if (type === "fee_request") {
    const ref = `${(cl.last_name || "").replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase()}-${String(c.id).slice(0, 6).toUpperCase()}`;
    const subject = `${company} – broker fee payment details`;
    const inner = `${regarding}<p>Hi ${first},</p><p>As agreed, our broker fee for arranging your mortgage is <strong>${money(c.broker_fee)}</strong>.</p><p>You can pay by bank transfer using the details below:</p><table style="border-collapse:collapse;margin:16px 0;"><tr><td style="padding:6px 16px 6px 0;color:#6b7280;">Account name</td><td style="padding:6px 0;"><strong>${s.bank_account_name || ""}</strong></td></tr><tr><td style="padding:6px 16px 6px 0;color:#6b7280;">Sort code</td><td style="padding:6px 0;"><strong>${s.bank_sort_code || ""}</strong></td></tr><tr><td style="padding:6px 16px 6px 0;color:#6b7280;">Account number</td><td style="padding:6px 0;"><strong>${s.bank_account_number || ""}</strong></td></tr><tr><td style="padding:6px 16px 6px 0;color:#6b7280;">Reference</td><td style="padding:6px 0;"><strong>${ref}</strong></td></tr></table><p>Please use the reference above so we can match your payment. Any questions, just reply${phone}.</p>${signoff}`;
    return { subject, html: wrap(inner, company) };
  }
  throw new Error(`Unknown email type: ${type}`);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await authorize(req))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Scoped send (R5-1): { queue_ids: [...] } sends ONLY those rows and queues nothing new.
  // An absent/empty body keeps the full cron behaviour. A malformed body fails closed
  // rather than silently flushing the whole firm's queue.
  let queueIds: string[] | null = null;
  try {
    const raw = await req.text();
    if (raw && raw.trim()) {
      const body = JSON.parse(raw);
      if (body && Array.isArray(body.queue_ids)) queueIds = body.queue_ids.map((x: any) => String(x));
    }
  } catch (_err) {
    return new Response(JSON.stringify({ error: "malformed JSON body" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  const scoped = queueIds !== null;

  const results: any = { queued: null, comms: null, sent: 0, failed: 0, scoped, skipped_optout: 0, skipped_promos: 0 }; // v19: skipped_optout counter · v20: skipped_promos counter

  if (!scoped) {
    const { data: queued, error: qErr } = await supabase.rpc("queue_automated_emails");
    if (qErr) results.queue_error = qErr.message; else results.queued = queued;
    const { data: extra } = await supabase.rpc("queue_comms_extras");
    results.comms = extra;
    /* R13 (M-43): the cron heartbeat. A dead 8am cron previously looked exactly
       like a quiet week — nothing on any screen distinguished "nothing to send"
       from "nothing ran". Every FULL (unscoped) run stamps last_cron_run_at the
       moment its queueing pass completes — before the Resend key check, so the
       heartbeat proves the CRON fired even while sending is unconfigured. The
       Today page shows an amber notice when this is stale. Scoped interactive
       sends deliberately do not stamp it: a human pressing a button is not the
       automation working. */
    await supabase.from("settings").upsert({ key: "last_cron_run_at", value: new Date().toISOString() }, { onConflict: "key" });
  }

  const { data: settingsRows } = await supabase.from("settings").select("key,value");
  const s: Record<string, string> = {};
  (settingsRows ?? []).forEach((r: any) => (s[r.key] = r.value));

  const { data: staff } = await supabase.from("profiles").select("id,full_name,email,phone,email_signoff").in("role", STAFF_ROLES);
  const staffById: Record<string, any> = {};
  (staff ?? []).forEach((p: any) => (staffById[p.id] = p));

  const fromDefault = s.from_email || "onboarding@resend.dev";
  const fromDomain = (fromDefault.match(/@([^>\s]+)/) || [])[1] || "";
  const fromFor = (adv: any) => {
    if (adv && adv.email && fromDomain && adv.email.endsWith("@" + fromDomain)) return `${adv.full_name || "NexMoney"} <${adv.email}>`;
    if (adv && adv.full_name && fromDefault.includes("<")) return `${adv.full_name} ${fromDefault.slice(fromDefault.indexOf("<"))}`;
    return fromDefault;
  };
  const replyFor = (adv: any) => (adv && adv.email) || s.reply_to_email || undefined;

  const apiKey = Deno.env.get("RESEND_API_KEY");
  /* R53 — GLOBAL SEND HOLD. While settings.email_hold is anything other than "off" (default when the
     row is absent: HELD), NOTHING is sent — every queued client email and offer-PDF email stays
     exactly where it is, the same behaviour as when no Resend key is set. This is the switch that
     lets the RESEND_API_KEY be added and the sending domain verified with zero risk of a live send:
     the queueing pass and cron heartbeat above still run, only the send below is skipped. To go live,
     set settings.email_hold = 'off' (a deliberate, reviewed act) and the very next run flushes the
     due queue. Covers BOTH the cron path and interactive scoped sends. */
  const sendHeld = (s.email_hold ?? "on") !== "off";
  if (!apiKey || sendHeld) {
    let pendingQ = supabase.from("email_queue").select("id", { count: "exact", head: true }).eq("status", "queued");
    /* R68 · M15 — the Settings "Email sending" strip probes with {queue_ids: []}. An EMPTY scoped list
       used to be counted as .in("id", []) = always 0, so the strip said "0 emails are queued" beside an
       ops chip saying 22. An empty scope names nothing to send, so the honest count for it is the same
       as the cron's: every queued row that is due now. A NON-empty scope still counts only its own ids. */
    pendingQ = (scoped && queueIds!.length) ? pendingQ.in("id", queueIds!) : pendingQ.lte("scheduled_for", new Date().toISOString());
    const { count } = await pendingQ;
    const warning = !apiKey
      ? "RESEND_API_KEY not set – emails remain queued"
      : "email sending is HELD (settings.email_hold ≠ 'off') – emails remain queued";
    return new Response(JSON.stringify({ ...results, warning, held: sendHeld, pending: count ?? 0 }), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  // Nothing to do: a scoped call with an empty list must never touch the queue.
  if (scoped && queueIds!.length === 0) {
    return new Response(JSON.stringify(results), { headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let reclaim = supabase.from("email_queue").update({ status: "queued", claimed_at: null }).eq("status", "sending").lt("claimed_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());
  if (scoped) reclaim = reclaim.in("id", queueIds!);
  await reclaim;

  let candQ = supabase.from("email_queue").select("id").eq("status", "queued");
  // v19: the unscoped run takes the OLDEST-due 50, not an arbitrary 50 (scoped path unchanged).
  candQ = scoped ? candQ.in("id", queueIds!) : candQ.lte("scheduled_for", new Date().toISOString()).order("scheduled_for", { ascending: true }).limit(50);
  const { data: candidates } = await candQ;
  const ids = (candidates ?? []).map((r: any) => r.id);
  if (ids.length === 0) return new Response(JSON.stringify(results), { headers: { ...CORS, "Content-Type": "application/json" } });

  const { data: emails, error } = await supabase.from("email_queue").update({ status: "sending", claimed_at: new Date().toISOString() }).in("id", ids).eq("status", "queued").select("*, cases(*), clients(*), leads(*)");
  if (error) return new Response(JSON.stringify({ ...results, error: error.message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });

  for (const e of emails ?? []) {
    const c = e.cases;
    const ld = e.leads;
    // R7: a website lead has no client record yet — present its first name to
    // the templates so the acknowledgement reads like every other email.
    const cl = e.clients ?? (ld ? { first_name: String(ld.name || "").trim().split(/\s+/)[0] || "", last_name: "", email: ld.email } : null);
    const to = e.to_email || cl?.email;
    if (!cl || !to) {
      await supabase.from("email_queue").update({ status: "failed", error: "Missing client or email address" }).eq("id", e.id);
      results.failed++; continue;
    }
    /* v19: opt-out is checked AT SEND TIME for the four marketing-adjacent types — the stored
       clients row on this claim was read moments ago, but an unsubscribe can land between queueing
       and sending, so re-read the single flag rather than trust the join. A re-read that fails
       falls back to the joined row's value (never blocks a send on a transient read error). */
    if (MARKETING_TYPES.includes(e.email_type) && e.client_id) {
      let optout = !!(e.clients && e.clients.comms_optout);
      const { data: oc } = await supabase.from("clients").select("comms_optout").eq("id", e.client_id).maybeSingle();
      if (oc) optout = !!oc.comms_optout;
      if (optout) {
        await supabase.from("email_queue").update({ status: "cancelled", error: "client opted out of these emails" }).eq("id", e.id);
        results.skipped_optout++; continue;
      }
    }
    /* v20: THE FINANCIAL-PROMOTIONS GATE, at send time. `s` is the settings map read above (the
       same read the hold uses), so this costs no extra query. Default OFF when the row is absent —
       the same fail-closed default the hold takes, and the same default the admin app applies:
       an unset master switch means nobody has approved anything yet. Cancelled, not failed and not
       left queued: a failure invites a retry and a queued row invites a release, and neither is
       what an unapproved promotion should get. The error string is the one the Emails page shows
       in its own column, so it names the setting the reader has to change. */
    if (FIN_PROMO_TYPES.includes(e.email_type) && (s.financial_promotions_approved ?? "off") !== "on") {
      await supabase.from("email_queue").update({ status: "cancelled", error: "financial promotions not approved (settings.financial_promotions_approved)" }).eq("id", e.id);
      results.skipped_promos++; continue;
    }
    try {
      const adv = c?.assigned_to ? staffById[c.assigned_to] : null;
      // R9: per-row context that compose() cannot fetch for itself (it is sync).
      const extra: any = {};
      /* R66 (v17) — the adviser-written email carries its own subject and body on the row. */
      if (e.email_type === "custom") {
        extra.customSubject = e.subject;
        extra.customBody = e.body_html;
      }
      if (e.email_type === "docs_request" && c?.id) {
        const { data: outstanding } = await supabase.from("case_documents")
          .select("item, created_at").eq("case_id", c.id).eq("status", "requested")
          .order("created_at", { ascending: true });
        if (outstanding && outstanding.length) {
          extra.docs = outstanding.map((d: any) => d.item);
          // Mint the upload token on first use; it then lives for the case's life.
          let tok: string | null = c.doc_token ?? null;
          if (!tok) {
            const minted = crypto.randomUUID();
            const { data: got } = await supabase.from("cases").update({ doc_token: minted })
              .eq("id", c.id).is("doc_token", null).select("doc_token").maybeSingle();
            if (got?.doc_token) {
              tok = got.doc_token;
            } else {
              // Someone minted it between our read and our write — use theirs, not
              // ours, or the link in this email would authenticate against nothing.
              const { data: re } = await supabase.from("cases").select("doc_token").eq("id", c.id).maybeSingle();
              tok = re?.doc_token ?? null;
            }
            c.doc_token = tok;
          }
          extra.docToken = tok;
          // Anything after the first docs_request on a case is a chase, so the
          // copy switches from "here's what we need" to "still waiting on".
          const { count: priorDocs } = await supabase.from("email_queue")
            .select("id", { count: "exact", head: true })
            .eq("case_id", c.id).eq("email_type", "docs_request")
            .neq("status", "cancelled").lt("created_at", e.created_at);
          extra.docChase = (priorDocs ?? 0) > 0;
        }
      }
      /* R12a (D3): factfind rows need a link compose() can't fetch (it is sync).
         Use the case's newest fact_finds row; mint one if the app didn't. The row's
         status stays 'created' until Resend accepts the send — the write below the
         send is what moves it to 'sent', so the case modal can finally tell the
         truth about whether the client was actually asked. */
      if (e.email_type === "factfind" && c?.id) {
        const site = (s.site_url || "").replace(/\/+$/, "");
        let ff: any = null;
        const { data: ffRows } = await supabase.from("fact_finds")
          .select("id, token, status").eq("case_id", c.id)
          .order("created_at", { ascending: false }).limit(1);
        ff = (ffRows && ffRows[0]) || null;
        if (!ff) {
          const { data: made } = await supabase.from("fact_finds")
            .insert({ case_id: c.id, client_id: e.client_id ?? c.client_id ?? null, status: "created" })
            .select("id, token, status").maybeSingle();
          ff = made || null;
        }
        if (ff && site) extra.ffLink = `${site}/factfind?token=${ff.token}`;
        extra.ffRowId = ff ? ff.id : null;
        extra.ffStatus = ff ? ff.status : null;
      }
      if (e.email_type === "review_request" && c?.id) {
        const { count: priorReviews } = await supabase.from("email_queue")
          .select("id", { count: "exact", head: true })
          .eq("case_id", c.id).eq("email_type", "review_request")
          .neq("status", "cancelled").lt("created_at", e.created_at);
        extra.reviewReminder = (priorReviews ?? 0) > 0;
      }
      /* R54 — a queued row carrying attachment_path promises the client a document (today: the
         mortgage offer PDF queued from the case modal). Fetch it from the offers bucket and attach
         it to the send; if the document cannot be read the send FAILS with a stated reason rather
         than going out without the attachment it promises. */
      let attachments: any[] | undefined;
      if (e.attachment_path) {
        const { data: blob, error: dlErr } = await supabase.storage.from("offers").download(e.attachment_path);
        if (dlErr || !blob) throw new Error(`Could not read the attached document (${e.attachment_path}): ${dlErr?.message || "not found"}`);
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        const base = e.attachment_path.split("/").pop() || "mortgage-offer.pdf";
        attachments = [{ filename: /\.[a-z0-9]{2,5}$/i.test(base) ? base : base + ".pdf", content: btoa(bin) }];
        extra.offerAttached = true;
      }
      const { subject, html } = compose(e.email_type, c ?? {}, cl, s, adv, extra);
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: fromFor(adv), to: [to], reply_to: replyFor(adv), subject, html, ...(attachments ? { attachments } : {}) }),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body?.message || `Resend error ${resp.status}`);
      await supabase.from("email_queue").update({ status: "sent", sent_at: new Date().toISOString(), to_email: to, subject, body_html: html }).eq("id", e.id);
      if (e.email_type === "fee_request" && c?.id) {
        await supabase.from("cases").update({ fee_status: "requested", fee_requested_at: new Date().toISOString() }).eq("id", c.id).eq("fee_status", "not_requested");
      }
      // R12a (D3): only a real accepted send moves the fact-find to 'sent' — and
      // never backwards from 'started'/'submitted' if the client got there first.
      if (e.email_type === "factfind" && extra.ffRowId && (extra.ffStatus === "created" || extra.ffStatus === "sent")) {
        await supabase.from("fact_finds").update({ status: "sent", updated_at: new Date().toISOString() })
          .eq("id", extra.ffRowId).in("status", ["created", "sent"]);
      }
      /* v19: link expiry (owner decision: 30 days). A successful factfind send restarts that
         fact-find link's 30-day clock; a successful docs_request send that carried an upload link
         restarts the case's doc-link clock. Stamped only on success — a failed send changes nothing. */
      if (e.email_type === "factfind" && extra.ffRowId) {
        await supabase.from("fact_finds").update({ expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }).eq("id", extra.ffRowId);
      }
      if (e.email_type === "docs_request" && extra.docToken && (s.site_url || "").trim() && c?.id) {
        await supabase.from("cases").update({ doc_token_expires_at: new Date(Date.now() + 30 * 86400000).toISOString() }).eq("id", c.id);
      }
      // R7: stamp the SLA clock only once the acknowledgement has actually gone out.
      if (e.email_type === "lead_ack" && ld?.id) {
        await supabase.from("leads").update({ acknowledged_at: new Date().toISOString() }).eq("id", ld.id).is("acknowledged_at", null);
      }
      results.sent++;
    } catch (err) {
      await supabase.from("email_queue").update({ status: "failed", error: String(err) }).eq("id", e.id);
      results.failed++;
    }
  }
  return new Response(JSON.stringify(results), { headers: { ...CORS, "Content-Type": "application/json" } });
});
