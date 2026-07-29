/* NexMoney Back Office v2 — Watchtower */
const SUPABASE_URL = "https://sclghkmvzpwtmnzbkaoe.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjbGdoa212enB3dG1uemJrYW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNzI1MDEsImV4cCI6MjA5ODc0ODUwMX0.LNm4vE071b359t8ACq459nVmQCUkk7BSVeGjddqNztg";
let db;
try {
  db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  // Supabase SDK failed to load (CDN outage, ad-blocker, proxy, SRI mismatch).
  // Show a visible message instead of a silent blank page, then stop.
  const showFail = () => {
    document.body.innerHTML = '<div style="max-width:460px;margin:15vh auto;padding:24px;font-family:system-ui,sans-serif;text-align:center;color:#333"><h1 style="font-size:20px;margin:0 0 12px">Something went wrong loading the app</h1><p style="margin:0 0 16px;color:#666">We couldn\'t load a required component. Check your connection and reload.</p><button onclick="location.reload()" style="padding:10px 20px;border:0;border-radius:6px;background:#1a5;color:#fff;font-size:15px;cursor:pointer">Reload</button></div>';
  };
  if (document.body) showFail(); else document.addEventListener("DOMContentLoaded", showFail);
  throw e;
}
// Derived at runtime so it can never drift from the deployed origin
// (works on nexmoney-two.vercel.app now and www.nexmoney.co.uk later).
// The origin(s) must be listed in Supabase Auth -> URL Configuration -> Redirect URLs.
const ADMIN_URL = new URL("/admin/", window.location.origin).href;

const STAGES = [
  ["enquiry", "Enquiry"],
  ["fact_find", "Fact Find"],
  ["decision_in_principle", "DIP"],
  ["application", "Application"],
  ["offer", "Offer"],
  ["exchange", "Exchange"],
  ["completed", "Completed"],
  ["not_proceeding", "Not Proceeding"],
];
const STAGE_LABEL = Object.fromEntries(STAGES);
/* BUILD 5a — pipeline focus segments. A view filter (NOT permissions/pages): deals flow across
   groups and the 4-person team wears multiple hats, so this just narrows which stage columns/tabs
   show. Grouping tracks the code's own stage boundaries: the New→Current boundary is exactly where
   the protection gate + protection badges fire (stage === application), and Completed = the two
   terminal stages the app treats as "not live" (completed/not_proceeding) and never ages. */
const SEGMENTS = [
  ["all", "All"],
  ["new", "New business"],
  ["current", "Current"],
  ["completed", "Completed & closed"],
];
const SEGMENT_STAGES = {
  new: ["enquiry", "fact_find", "decision_in_principle"],
  current: ["application", "offer", "exchange"],
  completed: ["completed", "not_proceeding"],
};
const inSegment = (stage, seg) => seg === "all" || (SEGMENT_STAGES[seg] || []).includes(stage);
const segmentStageList = (seg) => (seg === "all" ? STAGES : STAGES.filter(([k]) => inSegment(k, seg)));
/* Board time-in-stage aging (SP2b, senior-broker spec). Per-stage days-in-stage thresholds:
   card goes amber past the threshold, red at 2×. completed/not_proceeding are intentionally
   absent → those cards are never aged. Tune these numbers here. */
const AGE_THRESHOLDS = { enquiry: 5, fact_find: 7, decision_in_principle: 10, application: 21, offer: 14, exchange: 30 };
const daysSince = (iso) => { if (!iso) return null; const t = new Date(iso).getTime(); if (isNaN(t)) return null; return Math.max(0, Math.floor((Date.now() - t) / 86400000)); };
/* Build the muted age line + colour level for a board card / table row. stageEntryIso is when
   the case entered its current stage (most-recent stage_change case_event); null when unknown →
   we show last-touched only and apply NO colour (honest: we can't claim days-in-stage).
   T1-finalfix (finding 2) — an earlier "polish" pass suppressed the days-in-stage figure entirely
   whenever the case row's updated_at was newer than the last recorded stage event. Any ordinary
   edit makes that true (changing only the lender bumps updated_at), so it wiped both the figure AND
   the amber/red stalled-case colour off the card for good, on every case the team touches. That
   colouring is the administrator's main tool for spotting stalled work, so deleting the signal is
   worse than carrying a slightly stale one — the suppression is reverted here.
   What was genuinely missing is that the figure's BASIS was implied rather than stated, so every
   age line now carries a tooltip (`basis`) naming the date it is measured from. BACKEND-R4 §2 —
   round 3 asserted here that stage moves are never written to the event log; that was false and is
   corrected: the database's log_case_event trigger records every stage change with its actor, so
   stageEntryIso IS the date the case entered its current stage. The figure is still NEVER derived
   from updated_at: an ordinary edit is not a stage change, and reporting one as "in stage" would be
   a worse lie than a stale date. */
function cardAge(c, stageEntryIso) {
  const touched = daysSince(c.updated_at);
  const inStage = daysSince(stageEntryIso);
  const th = AGE_THRESHOLDS[c.stage];
  let level = "";
  if (th != null && inStage != null) {
    if (inStage >= th * 2) level = "red";
    else if (inStage >= th) level = "amber";
  }
  const parts = [];
  if (inStage != null) parts.push(`${inStage}d in stage`);
  if (touched != null) parts.push(`touched ${touched}d ago`);
  // True when the case row has been written since the last recorded stage event: the figure is then
  // measured from a date that predates at least one edit, and the tooltip says so.
  const stale = !!(stageEntryIso && c.updated_at && new Date(c.updated_at).getTime() > new Date(stageEntryIso).getTime());
  const basis = inStage == null
    ? "No stage change is recorded for this case, so there is no days-in-stage figure — only when the case was last edited."
    : `Days in stage is measured from the last recorded stage change (${fmtD(stageEntryIso)})`
      + (stale ? ", and the case has been edited since" : "")
      + ". Stage moves are written to the event log automatically, with who made them, so this is when the case entered its current stage — not simply when it was last edited.";
  return { level, text: parts.join(" · "), inStage, touched, stale, basis };
}
/* Batched, best-effort lookup of when each case entered its current stage, derived from the most
   recent stage_change case_event. ONE query for the whole board — never a per-card query. Wrapped
   so that if case_events is unavailable/blocked in prod the age feature silently degrades to
   last-touched-only rather than breaking the board. */
async function loadStageEntries(cases) {
  const map = {};
  const ids = (cases || []).map((c) => c.id);
  if (!ids.length) return map;
  try {
    const { data, error } = await db.from("case_events").select("case_id,event,created_at").in("case_id", ids).in("event", ["stage_changed", "stage_change", "case_created"]);
    if (error) return map;
    (data || []).forEach((e) => {
      if (!e || !e.case_id || !e.created_at) return;
      if (!map[e.case_id] || e.created_at > map[e.case_id]) map[e.case_id] = e.created_at;
    });
  } catch (_) { /* degrade gracefully — no age line, no colour */ }
  return map;
}
const KINDS = [
  ["purchase", "Purchase"], ["remortgage", "Remortgage"], ["product_transfer", "Product Transfer"],
  ["buy_to_let", "Buy to Let"], ["first_time_buyer", "First Time Buyer"], ["other", "Other"],
];
const EMAIL_LABEL = {
  rate_end_reminder: "Rate-end reminder", review_request: "Review request", fee_request: "Fee request",
  welcome: "Welcome", docs_request: "Document request", submitted_update: "Application submitted",
  offer_update: "Offer received", completion_congrats: "Completion congratulations",
  referral_request: "Referral request", rate_end_chase: "Rate-end chase",
  protection_offer: "Protection intro", gi_exchange: "GI / buildings insurance",
  birthday_greeting: "Birthday greeting", completion_anniversary: "Completion anniversary",
};
const SMS_LABEL = {
  rate_end: "Rate-end reminder", rate_end_reminder: "Rate-end reminder",
  appointment: "Appointment reminder", appointment_reminder: "Appointment reminder",
};
const smsTypeLabel = (t) => SMS_LABEL[t] || (t ? String(t).replace(/_/g, " ") : "SMS");
/* Plain-English tooltips for jargon a new starter hits constantly (QW7). Used as native title= attributes. */
const TIP_DIP = "Decision in Principle — a lender's early indication of how much they'll lend, before a full application";
const TIP_ERC = "Early Repayment Charge — a penalty for leaving a mortgage deal before its end date";
const TIP_GI = "General Insurance — buildings & contents cover";
const TIP_SUB = "Submitted — the date the application was sent to the lender";
const TIP_APPROX = "estimated — needs checking";
// Inline "≈" marker with a tooltip, used wherever a rate-end date is only estimated.
const APPROX = `<span class="approx" title="${TIP_APPROX}">≈</span>`;
// Each entry: [key, label, type?]. type: "email" / "url" light-validates on save;
// "bool10" renders the same On/Off <select> pattern used across the page, stored as "1"/"0".
const SETTING_FIELDS = [
  ["company_name", "Company name"],
  ["adviser_name", "Adviser name (email sign-off)"],
  ["adviser_phone", "Adviser phone"],
  ["from_email", "From email (verified in Resend)", "email"],
  ["reply_to_email", "Reply-to email", "email"],
  ["google_review_link", "Google review link", "url"],
  ["bank_account_name", "Bank account name"],
  ["bank_sort_code", "Sort code"],
  ["bank_account_number", "Account number"],
  // R5-F2 — the bar this setting drives now measures fees EARNED on the month's completions, with
  // cash collected shown beneath it. The label says so, so the number being typed in means the
  // same thing as the number being measured against it.
  ["monthly_fee_target", "Monthly fee target (£ earned on completions, blank = off)"],
  ["rate_reminder_months", "Rate reminder lead time (months)"],
  ["review_delay_days", "Review request delay after completion (days)"],
  ["referral_delay_days", "Referral nudge delay after review request (days)"],
  ["solicitor_chase_days", "Solicitor chase task after exchange (days)"],
  ["auto_docs_request", "Auto document-request email at Fact Find", "bool10"],
  ["auto_submitted_update", "Auto submitted email at Application", "bool10"],
  ["auto_offer_update", "Auto offer email at Offer", "bool10"],
  ["auto_completion_email", "Auto completion email", "bool10"],
  ["auto_referral", "Auto referral nudge after review", "bool10"],
  ["docs_list", "Document checklist (separate items with |)"],
];
// Friendly labels for the light save-time validation (email-shaped / URL-shaped fields
// that live outside SETTING_FIELDS, e.g. rendered inline further down in renderSettings()).
const SETTING_EMAIL_FIELDS = { from_email: "From email", reply_to_email: "Reply-to email", owner_digest_email: "Owner digest email address" };
const SETTING_URL_FIELDS = { google_review_link: "Google review link", review_platform_link: "Review platform link", site_url: "Site URL" };
/* T1-10 — these two categories BLOCK the save (unlike the email/URL checks above, which only warn):
   a bad number here corrupts a live metric (the rate-reminder KPI renders "≤ NaNmo" and the whole
   "ending soon" bucket vanishes), and a bad bank field is the one setting with direct
   misdirected-payment risk once queueEmail lets a fee-request email through on it. */
const SETTING_NUMERIC_FIELDS = { rate_reminder_months: "Rate reminder lead time", review_delay_days: "Review request delay", referral_delay_days: "Referral nudge delay", solicitor_chase_days: "Solicitor chase task delay", monthly_fee_target: "Monthly fee target", protection_avg_commission: "Average protection commission" };
const SETTING_BANK_FIELDS = { bank_sort_code: { label: "Sort code", re: /^\d{2}-?\d{2}-?\d{2}$/ }, bank_account_number: { label: "Account number", re: /^\d{8}$/ } };
function isValidEmailLike(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function isValidUrlLike(v) { return /^https?:\/\/[^\s]+\.[^\s]+/i.test(v); }
function settingFieldHtml([k, label, type]) {
  if (type === "bool10") return `<label>${esc(label)} (on/off)
      <select name="${k}">
        <option value="0" ${settings[k] === "1" ? "" : "selected"}>Off</option>
        <option value="1" ${settings[k] === "1" ? "selected" : ""}>On</option>
      </select>
    </label>`;
  const inputType = type === "email" ? "email" : type === "url" ? "url" : SETTING_NUMERIC_FIELDS[k] ? "number" : "text";
  return `<label>${esc(label)}<input name="${k}" type="${inputType}" value="${esc(settings[k] ?? "")}"></label>`;
}

const $ = (s) => document.querySelector(s);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
/* T1-21 — fmtD no longer hands a non-ISO string to new Date(). `new Date("01/02/2026")` is parsed
   by the engine as US month-first and silently renders "2 Jan 2026" for a UK 1 February, which is
   exactly how a mis-read import date survived review. Date objects, timestamps and ISO strings
   (the only thing the database ever stores) format as before; anything else is shown verbatim
   (esc'd, since the only source of non-ISO values is un-normalised imported text). */
const fmtD = (d) => {
  if (!d) return "—";
  if (typeof d === "string" && !/^\d{4}-\d{2}-\d{2}/.test(d)) return esc(d);
  const t = new Date(d);
  return isNaN(t.getTime()) ? esc(String(d)) : t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
/* T1-21 — UK-first date parsing for imported values. Returns
     { iso, ambiguous, ok, empty, raw, note }
   iso is always YYYY-MM-DD (never a raw string), so nothing but a real date reaches the cases
   table. `ambiguous` means the same text has a plausible US reading (both parts <= 12): the
   preview shows the interpretation and unticks the row until a human confirms it. */
function parseUkDate(s) {
  const raw = s == null ? "" : String(s).trim();
  if (!raw) return { ok: true, empty: true, iso: null, ambiguous: false, raw: raw };
  const bad = (note) => ({ ok: false, empty: false, iso: null, ambiguous: true, raw: raw, note: note });
  const mk = (y, mo, d, ambiguous, note) => {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return bad("not a real date");
    const p2 = (n) => (n < 10 ? "0" + n : String(n));
    return { ok: true, empty: false, iso: y + "-" + p2(mo) + "-" + p2(d), ambiguous: !!ambiguous, raw: raw, note: note || "" };
  };
  // ISO passthrough (with or without a time component) — already unambiguous.
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\s\S]*)?$/);
  if (m) return mk(Number(m[1]), Number(m[2]), Number(m[3]), false);
  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yy — UK order first.
  m = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (m) {
    let a = Number(m[1]), b = Number(m[2]), y = Number(m[3]);
    if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
    if (a > 12 && b > 12) return bad("neither part can be a month");
    // Second part > 12 can only be a day, so the text is month-first (US) however it was meant.
    if (b > 12) return mk(y, a, b, true, "read as month/day — UK order would be invalid");
    if (a > 12) return mk(y, b, a, false); // unambiguous UK
    return mk(y, b, a, a !== b, "UK day/month order"); // both <= 12: UK reading, flagged
  }
  // "1 Feb 2026" / "Feb 1 2026" / "1 February 2026" — word months are never ambiguous.
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/) || raw.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const dayFirst = /^\d/.test(m[1]);
    const mi = MONTHS.indexOf(String(dayFirst ? m[2] : m[1]).slice(0, 3).toLowerCase());
    if (mi >= 0) return mk(Number(m[3]), mi + 1, Number(dayFirst ? m[1] : m[2]), false);
  }
  return bad("unrecognised date format");
}
// UK-local (Europe/London) date-only string YYYY-MM-DD. en-CA gives ISO-style ordering.
// Used for "today"/overdue/horizon comparisons so they don't drift to the UTC calendar date after midnight BST.
const localDateStr = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d ? new Date(d) : new Date());
// UK-local YYYY-MM month bucket for report grouping.
const localMonthStr = (d) => localDateStr(d).slice(0, 7);
// Normalise a UK phone number for comparison/search: strip spaces/punctuation and map +44/0044 → 0.
const normPhone = (p) => (p == null ? "" : String(p).replace(/[\s()\-.]/g, "").replace(/^\+44/, "0").replace(/^0044/, "0"));
/* T1-9 — "could we actually text this?", built on normPhone rather than a second phone rule.
   normPhone already maps +44/0044 → 0, so a UK number lands as 11 digits starting 0. A value that
   still carries a leading + is a non-UK international number: accept 10-15 digits there rather than
   rejecting a legitimate foreign client. Deliberately permissive about formatting — spaces,
   brackets and dashes are all fine; only the digit count has to make sense. */
const isValidPhoneLike = (p) => {
  const n = normPhone(p);
  if (!n) return false;
  const digits = n.replace(/\D/g, "");
  if (n.charAt(0) === "+") return digits.length >= 10 && digits.length <= 15;
  return digits.length === 11;
};
/* T1-22 — ONE name splitter for both doors into the system (lead accept and bulk import).
   Bulk import used to file everyone as {first_name:"", last_name:"<whole name>"}, which broke the
   Clients sort, every "Hi {first_name}" template, and the duplicate detector's own name key.
   Single-token names stay on the surname line so last_name is never blank. */
function splitName(raw) {
  const s = (raw == null ? "" : String(raw)).trim().replace(/\s+/g, " ");
  if (!s) return { first_name: "", last_name: "" };
  const parts = s.split(" ");
  if (parts.length === 1) return { first_name: "", last_name: s };
  return { first_name: parts.shift(), last_name: parts.join(" ") };
}
// "Deborah & Michael Ashworth" / "John and Jane Smith" — a joint enquiry, not one person's name.
function isJointName(raw) {
  const s = raw == null ? "" : String(raw);
  return /&/.test(s) || /\s\band\b\s/i.test(s);
}
/* Best guess for a joint enquiry: first applicant's forename + the shared surname, with the second
   applicant returned separately so it can be written to the case note instead of into last_name
   (which used to produce "Deborah — Deborah & Michael Ashworth" on every card and template). */
function splitJointName(raw) {
  const s = (raw == null ? "" : String(raw)).trim().replace(/\s+/g, " ");
  const parts = s.split(/\s*&\s*|\s+\band\b\s+/i);
  const left = (parts[0] || "").trim();
  const right = parts.slice(1).join(" & ").trim();
  const leftTok = left ? left.split(" ") : [];
  const rightTok = right ? right.split(" ") : [];
  const first = leftTok[0] || "";
  // Surname: whatever trails the second applicant's forename, else whatever trails the first's.
  let last = rightTok.length > 1 ? rightTok.slice(1).join(" ") : (leftTok.length > 1 ? leftTok.slice(1).join(" ") : "");
  if (!last) last = right || first;
  return { first_name: first, last_name: last, second: right };
}

/* ---------- R5-23a / R5-10 — one matcher for both doors into the system ----------
   Bulk import deduped on a save-time index (exact email OR exact sorted name key) that the operator
   never saw, and lead accept looked up email only — so a returning client who gave a different
   address at the website form became a second record, silently, from either door.

   findClientMatches() is that one rule, shared by the import preview and acceptLead:
     EXACT  — same email, or same normalised phone, or the same canonical name key. A name-key hit
              is DOWNGRADED to a possible match when the incoming row contradicts what we hold
              (different email or different phone): "Ruby Sinclair, ruby@newjob.com" is probably the
              same Ruby, but attaching to her record and quietly keeping the old address is exactly
              the silent-loss failure this round exists to stop — so it asks.
     POSSIBLE — same surname AND (same forename initial, or a shared phone, or a shared postcode).
   It NEVER writes and NEVER decides: it returns candidates with the reason each one matched, and
   the caller shows them to a human. Pass `rows` (one clients fetch) to keep it synchronous. */
const clientNameKey = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const clientFullName = (c) => [c && c.first_name, c && c.last_name].filter(Boolean).join(" ").trim();
// UK postcode (or bare outcode) lifted out of a free-text address, uppercased and space-stripped.
const postcodeOf = (s) => {
  const m = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})?\b/i.exec(String(s == null ? "" : s).toUpperCase());
  return m ? (m[1] + (m[2] || "")) : "";
};
async function fetchMatchClients() {
  const { data, error } = await db.from("clients").select("id,first_name,last_name,email,phone,address");
  if (error) { console.error(error); return []; }
  return data || [];
}
function findClientMatches(q, rows) {
  const list = rows || [];
  const name = (q.name || [q.first, q.last].filter(Boolean).join(" ") || "").trim();
  const parts = name ? splitName(name) : { first_name: q.first || "", last_name: q.last || "" };
  const first = (q.first || parts.first_name || "").trim();
  const last = (q.last || parts.last_name || "").trim();
  const email = (q.email || "").trim().toLowerCase();
  const phone = normPhone(q.phone);
  const nk = clientNameKey(name || (first + " " + last));
  const pc = postcodeOf(q.address || q.postcode || "");

  const byEmail = email ? list.filter((c) => (c.email || "").trim().toLowerCase() === email) : [];
  const byPhone = phone && phone.replace(/\D/g, "").length >= 9 ? list.filter((c) => normPhone(c.phone) === phone) : [];
  const byName = nk ? list.filter((c) => clientNameKey(clientFullName(c)) === nk) : [];

  const contradicts = (c) =>
    (email && c.email && (c.email || "").trim().toLowerCase() !== email) ||
    (phone && c.phone && normPhone(c.phone) !== phone);

  let exact = null, reason = "";
  if (byEmail.length) { exact = byEmail[0]; reason = "same email address"; }
  else if (byPhone.length) { exact = byPhone[0]; reason = "same phone number"; }
  else if (byName.length && !contradicts(byName[0])) { exact = byName[0]; reason = "same name"; }

  const near = [], seen = new Set(exact ? [exact.id] : []);
  const add = (c, why) => { if (c && !seen.has(c.id)) { seen.add(c.id); near.push({ client: c, reason: why }); } };
  // A name we already hold, but the row disagrees about how to reach them.
  byName.forEach((c) => add(c, contradicts(c) ? "same name, different contact details" : "same name"));
  if (last) {
    const lastLc = last.toLowerCase();
    const ini = (first || "").trim().charAt(0).toLowerCase();
    list.forEach((c) => {
      if ((c.last_name || "").trim().toLowerCase() !== lastLc) return;
      const cIni = (c.first_name || "").trim().charAt(0).toLowerCase();
      if (ini && cIni && ini === cIni) add(c, "same surname and first initial");
      else if (phone && normPhone(c.phone) === phone) add(c, "same surname and phone number");
      else if (pc && postcodeOf(c.address) === pc) add(c, "same surname and postcode");
    });
  }
  return { exact, reason, near: near.slice(0, 5) };
}

// Inline-onclick-safe string argument: escape for the JS string literal first, then for the HTML
// attribute (esc() turns ' into &#39;, which the parser hands back to JS as a bare quote).
const jsArg = (v) => esc(String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
// Tap-to-call / tap-to-email links (M2). Displays the number/address verbatim; the tel: href is
// space-stripped so the dialler gets a clean value. Returns "" for empty input so callers can guard.
const telLink = (p) => { if (!p) return ""; const raw = String(p).trim(); const href = raw.replace(/[^\d+]/g, ""); return `<a class="contact-link" href="tel:${esc(href)}">${esc(raw)}</a>`; };
const mailLink = (e) => { if (!e) return ""; const raw = String(e).trim(); return `<a class="contact-link" href="mailto:${encodeURIComponent(raw).replace(/%40/g, "@")}">${esc(raw)}</a>`; };
const fmtM = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }));
// Exact-pence money — for fee figures on the case detail / evidence pack only. Dashboards keep fmtM (whole pounds).
const fmtM2 = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }));
let settings = {};
let ME = null, TEAM = [], tasksScope = "mine";
/* ---------- BACKEND-R4 §1 — role awareness ----------
   MY_ROLE is resolved ONCE at sign-in from the my_role() RPC (never by reading profiles.role
   directly), so the UI's idea of the caller's role is literally the same value the RLS policies
   test. If it cannot be resolved we assume the LEAST privilege ("none"), which switches every
   owner/admin-only surface off and fails the sign-in gate — never the most.

   NONE OF THESE HELPERS IS A SECURITY CONTROL. The database enforces every rule they mirror
   (settings/profiles writes are Owner-only, client/case deletes are Owner/Admin-only, invite-user
   is Owner-only, profiles_guard_role polices role changes). Their only job is to stop the UI
   offering an action the database will refuse. The money gate on Reports is weaker still — a
   PRESENTATION choice: get_reports stays readable by every staff account, so it must never be
   described as a control. */
let MY_ROLE = "none";
const STAFF_ROLES = ["owner", "admin", "adviser", "staff"]; // 'staff' = legacy alias, kept so no login is locked out
const isOwner = () => MY_ROLE === "owner";
const isAdminOrOwner = () => MY_ROLE === "owner" || MY_ROLE === "admin";
const ROLE_LABEL = { owner: "Owner", admin: "Administrator", adviser: "Adviser", staff: "Staff (legacy)", introducer: "Introducer", none: "No access" };
/* Roles an Owner may set from the team roster. `owner` is here (promoting a colleague is exactly
   how a second Owner is created — the invite edge function deliberately refuses to mint one).
   `introducer` is NOT: an introducer profile needs an introducer_id, which this control can't set,
   and moving a colleague onto the portal-only tier from a staff roster is not a thing anyone wants. */
const ASSIGNABLE_ROLES = [["owner", "Owner"], ["admin", "Administrator"], ["adviser", "Adviser"], ["none", "No access"]];
// BUILD 7c — bulk-select selections, one Set of ids per surface. Pruned to what's currently
// rendered on each re-render (so selections never act on rows the user can no longer see) and
// cleared after a completed bulk action. Session-only; never persisted.
let pipeSel = new Set(), emailSel = new Set(), dhSel = new Set(), protBulkSel = new Set();
// BUILD 4b: which Today drawers the user has manually opened/closed this session (session-only,
// never persisted — resets on reload). Keyed by drawer id (e.g. "watchtower", "leads").
let dashDrawerTouched = {};
let pipelineView = "board", stageTab = "all", sortKey = "updated_at", sortDir = -1;
// BUILD 5a: pipeline focus segment (session-only JS var, default "all"). Persists across page
// switches because it's module-scoped. viewBeforeCompleted remembers the board/table choice we
// force-overrode when entering the Completed segment (its board makes no sense → auto-table).
let pipelineSegment = "all", viewBeforeCompleted = null;
// T1-19 — id → introducer name, populated by loadReports. Lets the pipeline search box match an
// introducer by name so the Introducers table can link into a genuinely filtered pipeline. Empty
// until Reports has been opened; then the search simply doesn't match introducers, as before.
let introducerNames = {};
// BUILD 6d — per-user persisted pipeline prefs (segment + board/table view). localStorage is a
// normal feature of this web app, but every key is namespaced with the signed-in user's id (so a
// shared machine never leaks one adviser's choice to another) and every access is try/catch-guarded
// (file://, private-mode, or storage blocked by policy must all degrade to plain session behaviour).
let authUid = null;
function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable — degrade to session-only */ } }
const segStoreKey = (uid) => `nx_seg_${uid}`;
const viewStoreKey = (uid) => `nx_view_${uid}`;
// B9 (R5-31) — Month/Day diary toggle, persisted per user the same way as the pipeline prefs above.
const diaryViewStoreKey = (uid) => `nx_diaryview_${uid}`;
/* R5-5 — a `nx_lead_adviser_<uid>` key used to live here holding "the adviser the last lead was
   routed to", and every lead select defaulted to it. Routing ONE lead to a colleague therefore
   silently re-pointed every OTHER lead in the inbox at that colleague, for good. The sticky store
   is deleted: a lead select always defaults to me, and a hand-made per-row choice survives only the
   repaint that follows an Accept (captureLeadAdvSel/restoreLeadAdvSel below). */
// Called once, right after auth resolves (showApp) and before the first page render, so the
// restored values are scoped to the right account. Leaves the existing session defaults
// ("all" / "board") in place when nothing saved, invalid, or storage is unavailable.
function restoreUserPrefs(uid) {
  authUid = uid || null;
  if (!uid) return;
  const seg = lsGet(segStoreKey(uid));
  if (seg && SEGMENTS.some(([k]) => k === seg)) pipelineSegment = seg;
  const view = lsGet(viewStoreKey(uid));
  if (view === "board" || view === "table") pipelineView = view;
  // B9 (R5-31) — just the mode string here; the toggle's DOM classes and the staff-filter select
  // (which doesn't exist populated yet — loadTeam runs after this) are synced by
  // initDiaryViewFromPrefs(), called once loadTeam has rebuilt #diary-staff.
  const dv = lsGet(diaryViewStoreKey(uid));
  if (dv === "day" || dv === "month") diaryViewMode = dv;
}
function staffName(id) { const p = TEAM.find((x) => x.id === id); return p ? (p.full_name || p.email) : "—"; }
/* ---------- Assignment safety: ids that live OUTSIDE TEAM ----------
   TEAM only ever contains STAFF_ROLES, but `assigned_to` / `staff_id` can legitimately point at
   somebody who is no longer in it — set to "No access" (role `none`) in the roster, or re-tiered.
   A select built purely from TEAM has no <option> carrying that id, so the browser falls back to
   the first option and an ORDINARY SAVE of an unrelated field silently rewrites the assignee
   (to null where there is a "— unassigned —" option, to whoever sorts first where there isn't),
   writing a case_assigned event and an audit row that name the saver as having done it on purpose.
   Every select below that renders a STORED id therefore keeps that id as an explicit, labelled
   option. This is data integrity, not access control — the roster still removes their access, and
   RLS is what stops them signing in. */
let PROFILES = []; // every profile row, staff or not — TEAM is the STAFF_ROLES subset of this
/* B4 UI (R5-8) — whether this database has M1's profiles.phone / profiles.email_signoff columns.
   Set by loadProfileContactFields(); gates both the "My details" card and the Owner roster's
   phone/sign-off inputs so an un-migrated database shows neither rather than a write that 42703s. */
let PROFILE_CONTACT_SUPPORTED = false;
function profileName(id) {
  const p = TEAM.find((x) => x.id === id) || PROFILES.find((x) => x.id === id);
  return p ? (p.full_name || p.email || "") : "";
}
const onTeam = (id) => !!id && TEAM.some((p) => p.id === id);
// <option>s for an assignee select that must be able to represent `currentId` even when that
// person has left the team. Appends the stray, selected and labelled, after the team.
function assigneeOptionsHtml(currentId) {
  const opts = TEAM.map((p) => `<option value="${esc(p.id)}"${p.id === currentId ? " selected" : ""}>${esc(staffName(p.id))}</option>`).join("");
  if (!currentId || onTeam(currentId)) return opts;
  const nm = profileName(currentId) || "Former colleague";
  return opts + `<option value="${esc(currentId)}" selected>${esc(nm)} — no access (still assigned)</option>`;
}
/* The default assignee for NEW work started from a case (follow-up task, case task, appointment).
   Unlike the selects above this is not a stored value, so a colleague with no access must never be
   the default — fall back to the signed-in user when the case's own assignee has left the team. */
const defaultAssignee = (id) => (onTeam(id) ? id : ((ME && ME.id) || ""));
// BUILD 7c — adviser <option>s for the bulk "Assign to…" selects. Current user surfaces first as
// "Me (name)"; the rest of the team follows. `placeholder` is the disabled first option.
function adviserOptionsHtml(placeholder) {
  const meOpt = authUid && TEAM.some((p) => p.id === authUid) ? `<option value="${authUid}">Me (${esc(staffName(authUid))})</option>` : "";
  const others = TEAM.filter((p) => p.id !== authUid).map((p) => `<option value="${p.id}">${esc(staffName(p.id))}</option>`).join("");
  return `<option value="" selected>${esc(placeholder)}</option>${meOpt}${others}`;
}
/* T1-3 — the "route this lead to…" select. Unlike adviserOptionsHtml there is no blank placeholder:
   a lead always lands on somebody. R5-5: that somebody is ALWAYS me until a human says otherwise —
   the previous "whoever the last lead went to" default made one routing decision leak onto every
   other lead in the inbox, so leads quietly piled up on a colleague nobody chose for them. */
function leadAdviserOptionsHtml() {
  const sel = (ME && ME.id) || (TEAM[0] && TEAM[0].id) || "";
  return TEAM.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(staffName(p.id))}${p.id === (ME && ME.id) ? " (me)" : ""}</option>`).join("");
}
/* R5-5 — accepting a lead repaints the whole inbox (and My Day), which throws away any selection a
   human made on the OTHER rows. Capture them by lead id first, put them back after the repaint.
   Only selections that are still offered as an option are restored; everything else falls back to
   the default (me), never to a stale cross-lead value. */
function captureLeadAdvSel() {
  const map = {};
  document.querySelectorAll("select.lead-adviser[data-lead]").forEach((s) => { if (s.dataset.lead) map[s.dataset.lead] = s.value; });
  return map;
}
function restoreLeadAdvSel(map) {
  if (!map) return;
  document.querySelectorAll("select.lead-adviser[data-lead]").forEach((s) => {
    const want = map[s.dataset.lead];
    if (want && Array.prototype.some.call(s.options, (o) => o.value === want)) s.value = want;
  });
}
// The lead-adviser select that sits beside an Accept button (same row), if there is one.
function leadAdviserFor(btn) {
  const row = btn && btn.closest && btn.closest(".row-item");
  return (row && row.querySelector(".lead-adviser")) || null;
}
// Compact relative age ("3d ago", "2mo ago") for the case summary's last-note line.
function fmtAgo(d) {
  if (!d) return "";
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(ms / 3600000);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(ms / 86400000);
  if (days < 30) return days + "d ago";
  const mos = Math.floor(days / 30);
  if (mos < 12) return mos + "mo ago";
  return Math.floor(days / 365) + "y ago";
}
function initials(id) { const n = staffName(id); return n === "—" ? "" : n.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }
// Author/owner attribution (defect #7). Both return "" for an unknown/absent id — old rows
// without created_by/assigned_to render nothing rather than an "unknown" avatar.
function assigneeChipHtml(id) { const ini = initials(id); return ini ? `<span class="chip" title="${esc(staffName(id))}">${esc(ini)}</span>` : ""; }
/* T1-6 — a task's assignee chip is also the reassign control. Renders a real chip when the task
   has an owner and a "＋" placeholder when it doesn't (so an unassigned task can be claimed at
   all); clicking either swaps it for an adviser select in place. `reloadKey` tells reassignTask
   which list to refresh afterwards ("tasks" = Today's panel, "" = in-place only, e.g. case modal). */
function taskAssigneeHtml(taskId, assignedTo, reloadKey) {
  const ini = initials(assignedTo);
  const tip = assignedTo && ini ? staffName(assignedTo) + " — click to reassign" : "Unassigned — click to assign";
  return `<span class="chip chip-set" role="button" tabindex="0" title="${esc(tip)}" onclick="openReassign(event,'${taskId}','${assignedTo || ""}','${reloadKey || ""}')">${ini ? esc(ini) : "＋"}</span>`;
}
window.openReassign = function (ev, taskId, currentId, reloadKey) {
  ev.stopPropagation();
  const chip = ev.currentTarget;
  if (!chip || !chip.parentNode) return;
  const sel = document.createElement("select");
  sel.className = "task-reassign";
  /* R5-54 — reassigning was a one-way door: a task picked up by mistake, or handed back because it
     belongs to whoever gets to it first, could not be returned to the Unassigned queue the Tasks
     panel already has a scope for. Only this chip offers it (a case's own "Assigned to" select and
     the appointment "Who" select have their own rules). */
  sel.innerHTML = `<option value=""${currentId ? "" : " selected"}>— unassigned —</option>` + assigneeOptionsHtml(currentId);
  const restore = (id) => {
    if (!sel.parentNode) return;
    const wrap = document.createElement("span");
    wrap.innerHTML = taskAssigneeHtml(taskId, id, reloadKey);
    sel.parentNode.replaceChild(wrap.firstChild, sel);
  };
  let saving = false;
  sel.onchange = async () => {
    saving = true;
    const ok = await window.reassignTask(taskId, sel.value, reloadKey);
    restore(ok ? sel.value : currentId);
  };
  sel.onblur = () => setTimeout(() => { if (!saving) restore(currentId); }, 120); // click-away cancels
  chip.parentNode.replaceChild(sel, chip);
  sel.focus();
};
window.reassignTask = async function (taskId, adviserId, reloadKey) {
  // R5-54 — "" is now a real choice (put it back in the Unassigned queue), not a no-op.
  const { error } = await db.from("case_tasks").update({ assigned_to: adviserId || null }).eq("id", taskId);
  if (error) { toast("Error: " + error.message); return false; }
  toast(adviserId ? "Task assigned to " + staffName(adviserId) : "Task returned to Unassigned");
  if (reloadKey === "tasks") loadTasks();
  return true;
};
// Compact inline variant for note/timeline meta lines (reuses .chip, shrunk inline — no new CSS).
function authorChipHtml(id) { const ini = initials(id); return ini ? ` <span class="chip" title="${esc(staffName(id))}" style="width:16px;height:16px;font-size:8.5px;vertical-align:middle;">${esc(ini)}</span>` : ""; }
/* BACKEND-R4 §2 — case_events.actor is auth.uid() at the moment the log_case_event trigger fired.
   It is NULL only when nobody was signed in (the 8am cron, an edge function, the service role), so
   a missing chip is stated as "system" rather than left blank — "no chip" and "the cron did it"
   must not look the same on a compliance timeline. */
function eventActorHtml(actor) {
  if (!actor) return ' <span class="tl-muted" title="No signed-in user — written by the 8am cron or an edge function">· system</span>';
  return authorChipHtml(actor);
}
// The same answer in plain text, for the printed evidence pack.
function actorName(id) {
  if (!id) return "System (automation)";
  const n = staffName(id);
  return n === "—" ? "Unknown user" : n;
}

/* ---------- Typed notes (SP3a) — prefix convention, NO schema change ----------
   Classify a note body by a leading "Call:/Email:/Meeting:" prefix (case-insensitive —
   matching Sprint 2's "Call: " convention). Un-prefixed bodies = generic note. Returns the
   display icon and the body with the prefix stripped, so ONE helper drives both the case-modal
   notes list and the client timeline. */
const NOTE_ICON = { call: "📞", email: "✉️", meeting: "🤝", note: "📝" };
const NOTE_PREFIX = { note: "", call: "Call: ", email: "Email: ", meeting: "Meeting: " };
function noteType(body) {
  const b = body == null ? "" : String(body);
  const m = b.match(/^\s*(call|email|meeting)\s*:\s*/i);
  const type = m ? m[1].toLowerCase() : "note";
  return { type, icon: NOTE_ICON[type], cleanBody: m ? b.slice(m[0].length) : b };
}
// A single case-modal note row (icon + prefix-stripped body + timestamp). Shared by the initial
// render and the in-place prepend paths so typed icons stay consistent everywhere notes render.
function noteRowHtml(body, whenStr, createdBy) {
  const nt = noteType(body);
  return `<div class="note"><span class="note-ic" title="${nt.type}">${nt.icon}</span>${esc(nt.cleanBody)}<div class="nd">${esc(whenStr)}${authorChipHtml(createdBy)}</div></div>`;
}
// Timeline day-divider label, e.g. "Mon 20 Jul" (Europe/London — matches localDateStr grouping).
const tlDayLabel = (ts) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short" }).format(new Date(ts)).replace(",", "");
// Relative age that reads correctly for FUTURE items (upcoming appointments show "in Nd").
const tlWhen = (ts) => { const t = new Date(ts).getTime(); if (isNaN(t)) return ""; return t > Date.now() ? "in " + Math.max(1, Math.ceil((t - Date.now()) / 86400000)) + "d" : fmtAgo(ts); };

const LENDER_DOMAINS = {
  "halifax": "halifax.co.uk", "hsbc": "hsbc.co.uk", "santander": "santander.co.uk",
  "natwest": "natwest.com", "nationwide": "nationwide.co.uk", "barclays": "barclays.co.uk",
  "coventry": "coventrybuildingsociety.co.uk", "godiva": "coventrybuildingsociety.co.uk",
  "aldermore": "aldermore.co.uk", "leeds": "leedsbuildingsociety.co.uk", "atom": "atombank.co.uk",
  "saffron": "saffronbs.co.uk", "skipton": "skipton.co.uk", "precise": "precisemortgages.co.uk",
  "tml": "themortgagelender.com", "mortgage lender": "themortgagelender.com",
  "bms": "bmsolutions.co.uk", "birmingham midshires": "bmsolutions.co.uk",
  "accord": "accordmortgages.com", "virgin": "virginmoney.com", "kent reliance": "krbs.com",
  "mortgage works": "themortgageworks.co.uk", "tmw": "themortgageworks.co.uk",
  "paragon": "paragonbank.co.uk", "pepper": "pepper.money", "lendinvest": "lendinvest.com",
  "newcastle": "newcastle.co.uk", "scottish widows": "scottishwidows.co.uk",
  "newbury": "newburybuildingsociety.co.uk", "kensington": "kensingtonmortgages.co.uk",
  "metro": "metrobankonline.co.uk", "yorkshire": "ybs.co.uk", "ybs": "ybs.co.uk",
  "principality": "principality.co.uk", "fleet": "fleetmortgages.co.uk",
  "foundation": "foundationhomeloans.co.uk", "vida": "vidahomeloans.co.uk",
  "bank of ireland": "bankofireland.co.uk", "clydesdale": "cbonline.co.uk",
};
function lenderIcon(lender, size = 16) {
  const l = (lender || "").toLowerCase();
  let dom = null;
  for (const k in LENDER_DOMAINS) { if (l.includes(k)) { dom = LENDER_DOMAINS[k]; break; } }
  return dom ? `<img class="lfav" src="https://www.google.com/s2/favicons?domain=${dom}&sz=32" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.display='none'">` : "";
}
function panelCount(listSel, n, hot = false) {
  const el = $(listSel);
  if (!el) return;
  const panel = el.closest(".panel");
  if (!panel) return;
  let chip = panel.querySelector("h3 .count");
  if (!chip) {
    chip = document.createElement("span");
    chip.className = "count";
    const h3 = panel.querySelector("h3");
    const btn = h3.querySelector("button");
    h3.insertBefore(chip, btn || null);
  }
  chip.textContent = n;
  chip.classList.toggle("hot", hot && n > 0);
  panel.classList.toggle("slim", n === 0);
}

/* ---------- Today drawers (BUILD 4b) ---------- */
// Click on a drawer's <h3> collapses/expands it (clicks on buttons inside the header — e.g.
// "Run checks", the Tasks "Mine/All" toggle — are left alone so they keep working as before).
// The open/closed state lives only on the DOM (the .collapsed class), so it survives the
// panel's own re-renders (which only replace the inner list, never the drawer element) for the
// rest of the session; dashDrawerTouched just remembers that the user has taken manual control
// of a drawer that would otherwise be auto-opened/closed (Watchtower, New website leads).
window.toggleDrawer = function (ev, key) {
  if (ev && ev.target.closest("button")) return;
  const panel = (ev && ev.currentTarget && ev.currentTarget.closest(".panel")) || document.getElementById(key + "-panel");
  if (!panel) return;
  panel.classList.toggle("collapsed");
  dashDrawerTouched[key] = true;
};
// Auto-open/close a drawer based on whether it currently holds anything attention-worthy —
// unless the user has already manually toggled it this session, in which case leave it alone.
function autoDrawer(key, shouldOpen) {
  if (dashDrawerTouched[key]) return;
  const panel = document.getElementById(key + "-panel");
  if (!panel) return;
  panel.classList.toggle("collapsed", !shouldOpen);
}
// The Protection/Fees drawer combines two independently-loading tabs — recompute its header
// count from whichever of the two tab counts have rendered so far (called from both loaders).
function updateRevenueDrawerCount() {
  const p = Number(($("#tab-protection-count") || {}).textContent) || 0;
  const f = Number(($("#tab-fees-count") || {}).textContent) || 0;
  const el = $("#revenue-count");
  if (el) el.textContent = p + f;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 3200);
}

/* Stronger confirmation for irreversible hard-deletes of regulated records.
   Requires the user to type DELETE (guards against a misclick past a plain confirm)
   and flags FCA / MCOB record-retention. `extra` adds a record-specific warning line. */
function confirmHardDelete(what, extra) {
  const typed = prompt(
    `${what}\n\n` +
    "This permanently deletes the record and CANNOT be undone. Completed cases may be " +
    "subject to FCA / MCOB record-retention rules — check before deleting." +
    (extra ? `\n\n${extra}` : "") +
    "\n\nType DELETE to confirm:"
  );
  return typed != null && typed.trim().toUpperCase() === "DELETE";
}

/* Explicit error state for a view container — never show a reassuring
   empty state when the underlying query actually failed. */
function renderLoadError(containerSelector, error, retryFn) {
  const el = $(containerSelector);
  if (!el) return;
  const id = "retry-" + Math.random().toString(36).slice(2);
  const msg = (error && error.message) || String(error || "Unknown error");
  el.innerHTML = `<div class="load-error">⚠️ Couldn't load this — ${esc(msg)} <button class="btn btn-sm" id="${id}">Try again</button></div>`;
  const btn = document.getElementById(id);
  if (btn && retryFn) btn.onclick = retryFn;
}

/* ---------- Auth ---------- */
async function init() {
  const isRecovery = location.hash.includes("type=recovery");
  db.auth.onAuthStateChange((event, s) => {
    if (event === "PASSWORD_RECOVERY") return showRecovery();
    if (!s) showLogin();
  });
  if (isRecovery) { showLogin(); return; } // wait for PASSWORD_RECOVERY event
  const { data: { session } } = await db.auth.getSession();
  if (session) showApp(session); else showLogin();
}
function showRecovery() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  const card = $("#login-form");
  card.innerHTML = `
    <div class="login-logo">Nex<span>Money</span></div>
    <h1>Choose a new password</h1>
    <label>New password
      <span class="pw-wrap">
        <input type="password" id="new-pass" required minlength="8" autocomplete="new-password">
        <button type="button" class="pw-toggle" data-target="new-pass" aria-label="Show password" title="Show password">&#128065;</button>
      </span>
    </label>
    <button type="submit" class="btn btn-primary btn-block">Save password</button>
    <p id="login-error" class="error hidden"></p>`;
  card.onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await db.auth.updateUser({ password: $("#new-pass").value });
    if (error) {
      $("#login-error").textContent = error.message;
      $("#login-error").classList.remove("hidden");
      return;
    }
    history.replaceState(null, "", location.pathname);
    location.reload();
  };
}
function showLogin() {
  $("#login-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
  $("#assistant-fab").classList.add("hidden");
  $("#assistant-drawer").classList.add("hidden");
}
/* BACKEND-R4 §1 — resolve the caller's role from the my_role() RPC, which is the same expression
   the RLS policies evaluate. Falls back to profiles.role only if the RPC is unavailable (an older
   database), and to "none" if neither answers — least privilege, so an unresolvable role can never
   unlock a surface. Sets MY_ROLE and returns it. */
async function resolveMyRole(session) {
  MY_ROLE = "none";
  try {
    const { data, error } = await db.rpc("my_role");
    if (!error && typeof data === "string" && data) { MY_ROLE = data; return MY_ROLE; }
  } catch (e) { /* RPC missing/blocked — fall through to the profiles read below */ }
  try {
    const { data: p } = await db.from("profiles").select("role").eq("id", session.user.id).single();
    if (p && p.role) MY_ROLE = p.role;
  } catch (e) { /* leave MY_ROLE at "none" */ }
  return MY_ROLE;
}
async function showApp(session) {
  // Gate FIRST: only back-office staff may use the admin SPA (mirrors introducer.html).
  // Done before revealing the shell or reading settings/team so a non-staff account
  // never sees the admin UI or triggers those reads.
  // BACKEND-R4 §1 — the tiers are owner/admin/adviser (+ the legacy 'staff' alias). The old
  // ["staff","admin"] allow-list locked the Owner and both advisers out of their own back office.
  // This is a courtesy gate, not a control: RLS is what actually stops a non-staff account.
  await resolveMyRole(session);
  if (!STAFF_ROLES.includes(MY_ROLE)) {
    await db.auth.signOut();
    showLogin();
    toast("This login doesn't have back-office access.");
    return;
  }
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#assistant-fab").classList.remove("hidden");
  $("#user-email").textContent = session.user.email;
  // BUILD 6d — restore this user's pipeline segment/view prefs now that their id is known.
  restoreUserPrefs(session.user.id);
  await loadSettings();
  await loadTeam(session);
  await routeFromHash(); // BUILD 7a — honour deep links (#reports, #case/<id>, …); no hash → dashboard
}
async function loadTeam(session) {
  // T1-1: 'admin' is a first-class back-office role (the login gate at showApp already admits it),
  // so it must appear in TEAM or ME resolves to null and every "Mine" scope silently matches
  // nothing. Deliberately an explicit allow-list — an 'introducer' profile can never leak in.
  // BACKEND-R4 §5.1 — 'owner' and 'adviser' belong here too. Without them the Owner and every
  // adviser vanish from the adviser dropdowns, the diary legend and the scoreboard; worse, saving
  // a case assigned to a missing adviser silently unassigned it, because the select had no option
  // carrying that id.
  // One fetch, two lists. PROFILES keeps everybody (including anyone moved to "No access") so a
  // record still assigned to them can be shown, named and restored instead of silently orphaned;
  // TEAM stays exactly the STAFF_ROLES subset it always was, so every dropdown is unchanged.
  const { data: team } = await db.from("profiles").select("id,full_name,email,role").order("full_name");
  PROFILES = team || [];
  // B4 UI (R5-8) — phone/email_signoff live behind M1 and are fetched in their OWN small query
  // (see loadProfileContactFields) so an un-migrated database costs only the sign-off UI, never
  // this fetch that every adviser dropdown on the page depends on. Re-merged on every loadTeam()
  // call (initial load, post-invite, post-role-change) so the roster and "My details" card never
  // go stale relative to PROFILES being rebuilt from scratch here.
  const contact = await loadProfileContactFields();
  PROFILE_CONTACT_SUPPORTED = contact.supported;
  PROFILES.forEach((p) => { const c = contact.map[p.id]; if (c) { p.phone = c.phone; p.email_signoff = c.email_signoff; } });
  TEAM = PROFILES.filter((p) => STAFF_ROLES.includes(p.role));
  ME = TEAM.find((p) => p.id === session.user.id) || null;
  // Safe degradation: if this login still isn't in TEAM (profile row missing/renamed role), a
  // "Mine" scope can only ever show an empty screen — start everything on "All" instead.
  if (!ME) {
    briefingScope = "all"; tasksScope = "all"; protScope = "all";
    ["#brief-scope-mine", "#tasks-scope-mine", "#prot-scope-mine"].forEach((s) => $(s).classList.remove("scope-active"));
    ["#brief-scope-all", "#tasks-scope-all", "#prot-scope-all"].forEach((s) => $(s).classList.add("scope-active"));
  }
  const first = ((ME && ME.full_name) || session.user.email).split(/[\s@]/)[0];
  $("#today-heading").textContent = `Today — ${first}`;
  // Somebody moved to "No access" can still be HOLDING work — the Owner is allowed to leave it
  // with them. They stay in these two filters, marked, so that work can still be found and worked;
  // without an option carrying their id it is reachable only as "everyone else's". Nobody has this
  // role in an untouched team, so the lists are unchanged until someone is actually deactivated.
  const formerOpts = PROFILES.filter((p) => p.role === "none")
    .map((p) => `<option value="${esc(p.id)}">${esc(p.full_name || p.email || p.id)} — no access</option>`);
  $("#board-adviser").innerHTML = ['<option value="all">All advisers</option>', '<option value="unassigned">Unassigned</option>']
    .concat(TEAM.map((p) => `<option value="${p.id}">${esc(staffName(p.id))}</option>`)).concat(formerOpts).join("");
  $("#diary-staff").innerHTML = ['<option value="all">Everyone</option>']
    .concat(TEAM.map((p) => `<option value="${p.id}">${esc(staffName(p.id))}</option>`)).concat(formerOpts).join("");
  // B9 (R5-31) — #diary-staff was just rebuilt from scratch (any prior selection is gone), so this
  // is the one safe place to apply the restored Month/Day mode's own default selection.
  initDiaryViewFromPrefs();
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!$("#login-email")) return; // recovery form has taken over
  $("#login-error").classList.add("hidden");
  const { data, error } = await db.auth.signInWithPassword({
    email: $("#login-email").value.trim(),
    password: $("#login-password").value,
  });
  if (error) { $("#login-error").textContent = error.message; $("#login-error").classList.remove("hidden"); return; }
  showApp(data.session);
});
$("#logout-btn").addEventListener("click", () => db.auth.signOut());
$("#forgot-btn").addEventListener("click", async () => {
  const email = $("#login-email").value.trim() || prompt("Your account email:");
  if (!email) return;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: ADMIN_URL });
  toast(error ? "Error: " + error.message : "Password reset link sent — check your inbox.");
});

/* ---------- Navigation + SPA history / deep links (BUILD 7a — defect 15) ----------
   Minimal hash routing. Page switches push #<hash>; opening a case/client/appt modal pushes a
   history entry (SAME page hash + a {modal,id} state flag) so browser Back CLOSES THE MODAL
   instead of leaving the app — the single most valuable Back behaviour. Deep links
   (#case/<id>, #reports, …) are honoured on cold load. Everything is hash-only (no pathname
   routing) so file:// and the https edge review-gate behave identically; hash changes never hit
   the PWA service worker. All history.* calls are wrapped — if the History API is unavailable or
   blocked (some file:// contexts), modal history is simply not tracked and the app still works.
   Segments/filters stay OUT of the hash (session/localStorage already persists those). */
const PAGE_HASH = { dashboard: "today", pipeline: "pipeline", protection: "protection", diary: "diary", clients: "clients", import: "import", reports: "reports", data: "data", emails: "emails", settings: "settings" };
const HASH_PAGE = Object.fromEntries(Object.entries(PAGE_HASH).map(([p, h]) => [h, p]));
const MODAL_DEFAULT_PAGE = { case: "pipeline", client: "clients", appt: "diary" };
let currentPage = "dashboard";
let currentModal = null; // {type,id} while a case/client/appt modal owns a history entry; null otherwise
// Defect 5 — closeModal() (Save / Delete / Cancel) has to remove the entry pushModalHistory pushed,
// or the user's first Back afterwards does nothing visible. Two flags keep that from double-popping:
//   closingFromPopstate  — the browser already popped the entry; closeModal must not pop again.
//   modalHistoryPopPending — the pop currently in flight is ours, so the popstate it raises is a
//                            tidy-up, not a user Back, and must not re-navigate the page underneath.
let closingFromPopstate = false;
let modalHistoryPopPending = false;
/* G1R-1 — the second-layer captures (openOverlay: lost reason, snooze, bulk task, mark-fee-paid) sit
   on their own backdrop ABOVE the record modal and deliberately swallow Escape and backdrop clicks
   so those cancel the CAPTURE, never the modal underneath. Browser Back — and the Android back
   gesture, which on a phone is the primary dismissal and where there is no Escape key — was the one
   route they did not intercept: it popped the modal's entry, or with no modal open navigated the
   whole SPA, and left the dialog floating over the wrong page. Every open overlay records the
   history entry it was raised on; the popstate handler re-pushes that entry and cancels the capture
   instead. A stack, not a single slot, so a nested capture can never orphan its parent's anchor. */
const overlayStack = [];
const pageHash = (page) => "#" + (PAGE_HASH[page] || "today");
function histPush(state, hash) { try { history.pushState(state, "", hash); return true; } catch (e) { return false; } }
function histReplace(state, hash) { try { history.replaceState(state, "", hash); return true; } catch (e) { return false; } }
// Push (or, while a modal is already open, replace) the modal's history entry. currentModal is only
// set when the push actually succeeded, so a blocked History API degrades to "no back-to-close".
function pushModalHistory(type, id) {
  const state = { modal: type, id: id ?? null, page: currentPage };
  const ok = currentModal ? histReplace(state, pageHash(currentPage)) : histPush(state, pageHash(currentPage));
  currentModal = ok ? { type, id: id ?? null } : null;
}
// Cold-load / deep-link entrypoint: land on the hash's page (and open the record modal for
// #case|#client|#appt/<id>). Called from showApp once auth + settings/team are ready.
async function routeFromHash() {
  const [head, id] = (location.hash || "").replace(/^#/, "").split("/");
  if (MODAL_DEFAULT_PAGE[head] && id) {
    const dp = MODAL_DEFAULT_PAGE[head];
    nav(dp, false);                        // show the default page (no history push)…
    histReplace({ page: dp }, pageHash(dp)); // …and rewrite the initial entry into a clean page base
    currentModal = null;
    if (head === "case") await openCase(id);
    else if (head === "client") await openClient(id);
    else await openAppt(id);
    return;
  }
  const page = HASH_PAGE[head] || "dashboard";
  nav(page, false);
  histReplace({ page }, pageHash(page)); // establish a clean base entry (also normalises unknown hashes)
}
// Browser Back / Forward. Modal open → close it (honouring the log-call dirty guard; cancel re-pushes
// the entry). Otherwise switch to the target page. Never traps: a Back past the first entry exits.
window.addEventListener("popstate", (e) => {
  // Defect 5 — this pop is closeModal() tidying up its own entry, not a user Back: swallow it so
  // the page underneath isn't re-navigated (and re-loaded) on every Save/Cancel.
  if (modalHistoryPopPending) { modalHistoryPopPending = false; return; }
  if ($("#app-view").classList.contains("hidden")) return; // not in the app (login screen) — ignore
  /* G1R-1 — a second-layer capture is up: Back cancels the CAPTURE, exactly as Escape and a
     backdrop click already do, and never the modal or the page underneath it. Undo the Back by
     re-pushing the entry the overlay was raised on, so the history stack still matches the screen
     (with no modal open that entry is the page's own — without this, Back navigated the SPA out
     from under a dialog that was still asking a question). */
  const ovl = overlayStack[overlayStack.length - 1];
  const overlayBackdrop = $("#overlay-backdrop");
  if (ovl && overlayBackdrop && !overlayBackdrop.classList.contains("hidden")) {
    histPush(ovl.state, ovl.hash);
    ovl.finish(null);
    return;
  }
  const modalOpen = !$("#modal-backdrop").classList.contains("hidden");
  if (currentModal && modalOpen) {
    if (hasUnsavedModalEdits() && !confirm(DISCARD_PROMPT)) {
      histPush({ modal: currentModal.type, id: currentModal.id, page: currentPage }, pageHash(currentPage));
      return; // cancelled — re-push to undo the Back and keep the modal open
    }
    closingFromPopstate = true;             // the entry is already gone — closeModal must not pop again
    try { closeModal(); } finally { closingFromPopstate = false; }
    return;
  }
  const st = e.state || {};
  const page = st.page || HASH_PAGE[(location.hash || "#today").replace(/^#/, "").split("/")[0]] || "dashboard";
  nav(page, false);
});
$("#topnav").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-page]");
  if (b) nav(b.dataset.page);
});

/* ---------- Dashboard tab widgets (e.g. Protection / Fees due) ---------- */
document.addEventListener("click", (e) => {
  const t = e.target.closest(".dash-tab");
  if (!t) return;
  const card = t.closest(".dash-card");
  card.querySelectorAll(".dash-tab").forEach((b) => b.classList.toggle("active", b === t));
  card.querySelectorAll(".dash-tab-panel").forEach((p, i) => p.classList.toggle("hidden", i !== [...t.parentElement.children].indexOf(t)));
});
function nav(page, push = true) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  $("#page-" + page).classList.remove("hidden");
  document.querySelectorAll("#topnav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  currentPage = page;
  currentModal = null; // switching pages dismisses any modal history ownership
  if (push) {
    const hash = pageHash(page);
    // Already sitting on this page's hash with no modal → replace (avoid stacking duplicate entries).
    if (location.hash === hash) histReplace({ page }, hash);
    else histPush({ page }, hash);
  }
  // B9 (R5-31) — the diary page can be showing either the month grid or the Day view; route to
  // whichever loader matches the persisted toggle so navigating back into #diary doesn't silently
  // flip it back to Month.
  ({ dashboard: loadDashboard, pipeline: loadPipeline, protection: loadProtectionPage, diary: () => (diaryViewMode === "day" ? loadDiaryDay() : loadDiary()), clients: () => loadClients($("#client-search").value), import: () => {}, reports: loadReports, data: loadDataHealth, emails: loadEmails, settings: renderSettings }[page])();
}

/* ---------- Settings ---------- */
async function loadSettings() {
  const { data } = await db.from("settings").select("*");
  settings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
/* B4 UI (R5-8) — profiles.phone / profiles.email_signoff live behind M1. Fetched in a SEPARATE
   small query (same discipline as loadCaseExtraColumns for M2) so an un-migrated database costs
   only the sign-off UI, never loadTeam's main profiles fetch that every adviser dropdown depends
   on. `supported` is decided by column PRESENCE, not merely the absence of an error: a database
   where the columns exist returns the key on every row (even null); one where they don't simply
   omits the key from the row entirely, with no error raised. */
async function loadProfileContactFields() {
  try {
    const { data, error } = await db.from("profiles").select("id,phone,email_signoff");
    if (error) return { map: {}, supported: false };
    const rows = data || [];
    const supported = rows.some((r) => r && Object.prototype.hasOwnProperty.call(r, "phone"));
    const map = {};
    rows.forEach((r) => { if (r && r.id) map[r.id] = r; });
    return { map, supported };
  } catch (e) { return { map: {}, supported: false }; }
}
/* BACKEND-R4 §1/§5.3 — writing `settings` is Owner-only, enforced by RLS. A non-Owner opening this
   page used to get the full form and a "new row violates row-level security policy" toast the
   moment they pressed Save. The page below is what they see instead: a coherent read-only view of
   the operational settings, with the bank details, the financial-promotions master switch and the
   whole user-management block absent rather than present-and-broken. Hiding them is presentation;
   the refusal is the database's. */
const OWNER_ONLY_SETTING_KEYS = ["bank_account_name", "bank_sort_code", "bank_account_number"];
async function renderSettings() {
  const owner = isOwner();
  const visibleFields = owner ? SETTING_FIELDS : SETTING_FIELDS.filter(([k]) => !OWNER_ONLY_SETTING_KEYS.includes(k));
  const general = visibleFields.map(settingFieldHtml).join("") + `
    <h3 style="grid-column:1/-1;margin:10px 0 0;">Protection &amp; GI</h3>
    <label>Protection gate — block moves to Application+ until protection is recorded
      <select name="protection_gate">
        <option value="" ${(settings.protection_gate ?? "on") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${(settings.protection_gate ?? "on") === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Average protection commission (£, used for estimates)
      <input name="protection_avg_commission" type="number" value="${esc(settings.protection_avg_commission ?? "850")}">
    </label>
    <label>Auto protection intro email at Offer (on/off)
      <select name="auto_protection_email">
        <option value="" ${settings.auto_protection_email === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.auto_protection_email === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Auto GI / buildings insurance email at Exchange (on/off)
      <select name="auto_gi_email">
        <option value="" ${settings.auto_gi_email === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.auto_gi_email === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">⚠️ The automated protection and GI emails are financial promotions — get principal approval for the templates before switching them on.</p>
    <h3 style="grid-column:1/-1;margin:10px 0 0;">Owner digest</h3>
    <label>Daily owner digest email (on/off)
      <select name="owner_digest">
        <option value="" ${(settings.owner_digest ?? "on") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${(settings.owner_digest ?? "on") === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Owner digest email address
      <input name="owner_digest_email" type="email" value="${esc(settings.owner_digest_email ?? "")}" placeholder="you@nexmoney.co.uk">
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">Sent daily at ~07:30 UK time. Requires RESEND_API_KEY.</p>
    <div style="grid-column:1/-1;"><button type="button" class="btn btn-sm" id="send-digest-btn">Send digest now</button></div>
    <h3 style="grid-column:1/-1;margin:10px 0 0;">Client comms &amp; sales</h3>
    ${owner ? `<h4 style="grid-column:1/-1;margin:0;">Regulated financial promotions</h4>
    <label>Financial promotions approved (master switch)
      <select name="financial_promotions_approved">
        <option value="off" ${(settings.financial_promotions_approved ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.financial_promotions_approved === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">Master switch — no marketing email sends until this is on. It gates exactly these three email types: <strong>Referral request</strong> (auto referral nudge, above), <strong>Protection intro email</strong> and <strong>GI / buildings insurance email</strong> (both in Protection &amp; GI, above). Confirm your network has approved the templates before switching on.</p>` : ""}
    <h4 style="grid-column:1/-1;margin:10px 0 0;">Other automated client comms${owner ? " — not gated by the switch above" : ""}</h4>
    <label>Auto SMS — rate-end reminder
      <select name="auto_sms_rate_end">
        <option value="off" ${(settings.auto_sms_rate_end ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.auto_sms_rate_end === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Auto SMS — appointment reminder
      <select name="auto_sms_appointment">
        <option value="off" ${(settings.auto_sms_appointment ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.auto_sms_appointment === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Birthday greetings
      <select name="birthday_enabled">
        <option value="off" ${(settings.birthday_enabled ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.birthday_enabled === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Completion anniversary emails
      <select name="anniversary_enabled">
        <option value="off" ${(settings.anniversary_enabled ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.anniversary_enabled === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Review requests (NPS)
      <select name="nps_enabled">
        <option value="off" ${(settings.nps_enabled ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.nps_enabled === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">Review-request emails ask for a 1–5 rating; happy clients are routed to your review link, unhappy ones create a call-back task.</p>
    <label>Review platform link (Google / Trustpilot)
      <input name="review_platform_link" type="url" value="${esc(settings.review_platform_link ?? "")}" placeholder="https://g.page/r/…">
    </label>
    <label>Site URL
      <input name="site_url" type="url" value="${esc(settings.site_url ?? "")}" placeholder="https://www.nexmoney.co.uk">
    </label>`;
  const advanced = `
    <h3 style="grid-column:1/-1;margin:0;">Outlook &amp; AI</h3>
    <label>Outlook inbox sync (pulls client emails into My Day)
      <select name="outlook_enabled">
        <option value="0" ${settings.outlook_enabled === "1" ? "" : "selected"}>Off</option>
        <option value="1" ${settings.outlook_enabled === "1" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>Outlook mailboxes to scan
      <input name="outlook_mailboxes" value="${esc(settings.outlook_mailboxes ?? "")}" placeholder="daniel@nexmoney.co.uk, wayne@nexmoney.co.uk — blank = all staff">
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">Outlook sync and the AI assistant need Supabase secrets: ANTHROPIC_API_KEY, MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET — plus an Azure app registration with Graph <em>Application</em> permission Mail.Read and admin consent.</p>
    <h3 style="grid-column:1/-1;margin:10px 0 0;">SMS provider</h3>
    <label>SMS enabled
      <select name="sms_enabled">
        <option value="off" ${(settings.sms_enabled ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.sms_enabled === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <label>SMS provider
      <select name="sms_provider">
        <option value="twilio" ${(settings.sms_provider ?? "twilio") === "clicksend" ? "" : "selected"}>Twilio</option>
        <option value="clicksend" ${settings.sms_provider === "clicksend" ? "selected" : ""}>ClickSend</option>
      </select>
    </label>
    <label>SMS sender (number / sender ID)
      <input name="sms_from" value="${esc(settings.sms_from ?? "")}" placeholder="e.g. +447700900123 or NexMoney">
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">SMS also needs provider credentials set as Supabase secrets (Twilio: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN; ClickSend: CLICKSEND_USERNAME / CLICKSEND_API_KEY). Nothing sends until sms_enabled is on and credentials are set.</p>`;
  // R5-24 — Admin now has a read-only view of the roster below (name, role, holdings — no
  // controls), so the blanket "team logins are also Owner-only and are not shown" line no longer
  // holds for that tier; only invite/role-change/handover stay Owner-only.
  const readOnlyNote = owner ? "" : `
    <div class="dq-notice" id="settings-readonly-note">🔒 <strong>Read-only — you are signed in as ${esc(ROLE_LABEL[MY_ROLE] || MY_ROLE)}.</strong>
      Only the Owner can change settings; the database refuses the write, so this page shows you the current
      configuration rather than a form that would fail on Save. The bank details are Owner-only in the database
      itself — their values are never sent to this session, so there is nothing here to show. The
      financial-promotions master switch, inviting new logins and role changes / handovers are also Owner-only.
      ${isAdminOrOwner() ? "You can view the team roster below (read-only)." : ""} Ask an Owner to make a change.
      Your own contact details (My details, below) are a personal setting, not a firm one — you can still edit
      and save those.</div>`;
  $("#settings-form").innerHTML = readOnlyNote + `
    <details class="case-details settings-details" open>
      <summary>General</summary>
      <div class="settings-grid">${general}</div>
    </details>
    <details class="case-details settings-details">
      <summary>Advanced — API keys &amp; integrations</summary>
      <div class="settings-grid">${advanced}</div>
    </details>`;
  if (!owner) {
    // Presentation only — the fields are shown so the configuration is legible, but nothing here
    // can be submitted (the Save button below is hidden, and RLS would refuse it anyway).
    $("#settings-form").querySelectorAll("input, select, textarea").forEach((el) => { el.disabled = true; });
  }
  const saveBtn = $("#save-settings-btn");
  if (saveBtn) saveBtn.classList.toggle("hidden", !owner);
  const savedMsg = $("#settings-saved");
  if (savedMsg) savedMsg.classList.add("hidden");
  $("#send-digest-btn").onclick = sendDigestNow;
  // BACKEND-R4 §1 — inviting/editing OTHER logins is Owner-only, and invite-user v3 refuses a
  // non-Owner caller outright, so that block stays hidden. R5-24 — the panel itself now also opens
  // for an Admin (isAdminOrOwner()), who gets a read-only roster instead of nothing.
  const teamPanel = $("#team-logins-panel");
  if (teamPanel) teamPanel.classList.toggle("hidden", !isAdminOrOwner());
  const teamInvite = $("#team-invite-block");
  if (teamInvite) teamInvite.classList.toggle("hidden", !owner);
  const rosterCaption = $("#team-roster-caption");
  if (rosterCaption) rosterCaption.textContent = owner
    ? "Change a colleague's role here. Only an Owner can, and the last Owner can't be demoted — promote someone else first."
    : "Role changes and handovers are Owner-only.";
  renderInviteRoleHint();
  // B4 UI (R5-8) — phone/email_signoff and PROFILE_CONTACT_SUPPORTED are kept current by loadTeam()
  // (called at sign-in and after every invite/role-change refresh), so both the roster (Owner) and
  // the "My details" card (everyone) already have what they need.
  renderTeamRoster();
  renderMyDetailsCard();
  loadIntroducers();
  /* The whole audit trail, including the settings and login entries that carry no case or client
     and so appear on no other screen. Owner-only in the UI; the database is what actually
     withholds those rows from everyone else. */
  loadChangeHistory();
}
async function sendDigestNow() {
  const btn = $("#send-digest-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/owner-digest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    const j = await r.json();
    if (j.sent) toast(`Digest sent to ${j.to || settings.owner_digest_email || "owner"}`);
    else if (j.skipped === "no_resend_key") toast("RESEND_API_KEY missing — digest not sent");
    else if (j.skipped === "disabled") toast("Digest is disabled in settings");
    else if (j.skipped) toast("Digest skipped: " + j.skipped);
    else toast("Error: " + (j.error || r.status));
  } catch (e) {
    toast("Error: " + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Send digest now"; }
  }
}
$("#save-settings-btn").addEventListener("click", async () => {
  // Presentation guard only — the button is already hidden for a non-Owner and RLS refuses the
  // upsert regardless. This stops a stale/forced click producing a raw policy-violation toast.
  if (!isOwner()) return toast("Only the Owner can change settings.");
  const fields = [...$("#settings-form").querySelectorAll("input, select")];
  // Light validation — warns but never blocks the save (nothing here should stop a workflow).
  const warnings = [];
  // T1-10 — numeric / bank fields are a different class of risk (a corrupted live metric, or a
  // misdirected-payment field) so these BLOCK: the offending key is dropped from the upsert and the
  // previously-saved value stands, instead of being warned about and saved anyway.
  const blocked = [];
  const blockedKeys = new Set();
  fields.forEach((i) => {
    const v = i.value.trim();
    if (SETTING_NUMERIC_FIELDS[i.name] && v && isNaN(Number(v))) {
      blocked.push(`${SETTING_NUMERIC_FIELDS[i.name]} must be a number — not saved`);
      blockedKeys.add(i.name);
      return;
    }
    if (SETTING_BANK_FIELDS[i.name] && v && !SETTING_BANK_FIELDS[i.name].re.test(v)) {
      blocked.push(`${SETTING_BANK_FIELDS[i.name].label} doesn't look right — not saved`);
      blockedKeys.add(i.name);
      return;
    }
    if (!v) return;
    if (SETTING_EMAIL_FIELDS[i.name] && !isValidEmailLike(v)) warnings.push(`${SETTING_EMAIL_FIELDS[i.name]} doesn't look like a valid email`);
    if (SETTING_URL_FIELDS[i.name] && !isValidUrlLike(v)) warnings.push(`${SETTING_URL_FIELDS[i.name]} doesn't look like a valid URL`);
  });
  // toast() shows one message at a time, so combine — blocking issues are the more important half.
  const allMsgs = blocked.concat(warnings);
  if (allMsgs.length) toast(allMsgs.join(" · "));
  const rows = fields.filter((i) => !blockedKeys.has(i.name)).map((i) => ({ key: i.name, value: i.value.trim() }));
  const btn = $("#save-settings-btn"); // T1-15 — in-flight guard
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const { error } = await db.from("settings").upsert(rows);
    if (error) return toast("Error: " + error.message);
    await loadSettings();
    $("#settings-saved").classList.remove("hidden");
    setTimeout(() => $("#settings-saved").classList.add("hidden"), 2500);
    refreshChangeHistory(); // the save just wrote to the log shown at the bottom of this page

  } finally { btn.disabled = false; }
});

/* B4 UI (R5-8) — every signed-in staff member's own phone + email sign-off, independent of the
   Owner-only form above: M1's "profiles self edit" policy covers exactly this row (update where
   id = auth.uid()), and guard_role_change still refuses a role change even from here (there is no
   role field on this card to attempt one with). Hidden outright when PROFILE_CONTACT_SUPPORTED is
   false — there is no column on this database to write to yet. */
function renderMyDetailsCard() {
  const card = $("#my-details-panel");
  if (!card) return;
  if (!PROFILE_CONTACT_SUPPORTED || !ME) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const mine = PROFILES.find((p) => p.id === ME.id);
  $("#my-phone").value = (mine && mine.phone) || "";
  $("#my-signoff").value = (mine && mine.email_signoff) || "";
}
async function saveMyDetails() {
  if (!ME) return;
  const btn = $("#save-my-details-btn"); // in-flight guard, same pattern as #save-settings-btn
  if (!btn || btn.disabled) return;
  const phone = $("#my-phone").value.trim();
  const signoff = $("#my-signoff").value.trim();
  btn.disabled = true;
  try {
    const { error } = await db.from("profiles").update({ phone: phone || null, email_signoff: signoff || null }).eq("id", ME.id);
    if (error) {
      if (isMissingColumnError(error)) {
        toast("Your details need migration M1 — ask an Owner to run it.");
        PROFILE_CONTACT_SUPPORTED = false;
        $("#my-details-panel").classList.add("hidden");
      } else toast("Error: " + error.message);
      return;
    }
    const mine = PROFILES.find((p) => p.id === ME.id);
    if (mine) { mine.phone = phone || null; mine.email_signoff = signoff || null; }
    $("#my-details-saved").classList.remove("hidden");
    setTimeout(() => $("#my-details-saved").classList.add("hidden"), 2500);
  } finally { btn.disabled = false; }
}
if ($("#save-my-details-btn")) $("#save-my-details-btn").addEventListener("click", saveMyDetails);

/* ---------- Dashboard ---------- */
/* R5-28 — has_bank_details() answered once per dashboard load. null = not asked / the RPC failed,
   in which case nothing is hidden (see briefActions). */
let hasBankDetails = null;
/* R5-6 — source case ids that already have a retention successor (populated by loadDashboard). */
let retentionSourceIds = new Set();
async function loadDashboard() {
  const reminderMonths = Number(settings.rate_reminder_months) || 6; // T1-10 — a stray already-stored non-numeric value can't render "≤ NaNmo"
  const [{ data: cases, error: casesErr }, { data: alerts, error: alertsErr }, bank] = await Promise.all([
    db.from("cases").select("id,stage,fee_status,broker_fee,completed_at,retention_source_case_id"),
    db.from("v_alerts").select("*").order("rate_end_date"),
    /* R5-28 — one firm-wide question, asked once per dashboard load and cached for the briefing's
       "Chase fee" buttons (see briefActions). A failed RPC leaves the answer unknown (null), which
       renders the buttons as before rather than blanking a working action on a network hiccup. */
    db.rpc("has_bank_details").then((r) => r).catch(() => ({ data: null, error: true })),
  ]);
  hasBankDetails = bank && !bank.error ? !!bank.data : null;
  /* R5-6 — which completed cases already have a retention successor, so the "Start retention case"
     button can't offer to create a second one. Derived from the rows already fetched above. */
  retentionSourceIds = new Set((cases || []).filter((c) => c.retention_source_case_id).map((c) => c.retention_source_case_id));
  if (casesErr || alertsErr) {
    renderLoadError("#kpi-row", casesErr || alertsErr, loadDashboard);
    renderLoadError("#alerts-rateerc", casesErr || alertsErr, loadDashboard);
    // The independent dashboard widgets self-report their own errors.
    loadRetention(); loadTasks(); loadProtection(); loadLeads(); loadTodayAppts(); loadBriefing(); loadWatchtower();
    return;
  }
  const active = (cases || []).filter((c) => !["completed", "not_proceeding"].includes(c.stage));
  const yr = new Date().getFullYear();
  const completedThisYear = (cases || []).filter((c) => c.completed_at && new Date(c.completed_at).getFullYear() === yr);
  const feesDue = (cases || []).filter((c) => ["not_requested", "requested"].includes(c.fee_status) && c.broker_fee > 0 && c.stage !== "not_proceeding");
  const feesDueTotal = feesDue.reduce((s, c) => s + Number(c.broker_fee || 0), 0);
  const ratesSoon = (alerts || []).filter((a) => a.days_to_rate_end != null && a.days_to_rate_end <= reminderMonths * 30);
  const ercFlags = (alerts || []).filter((a) => a.erc_outlasts_rate);

  // KPI cards clickable (defect 19) — each jumps to where that number can be worked, rather than
  // being a dead-end. The "Fees outstanding" card and the Protection & Fees drawer's "Fees due" tab
  // count different scopes (see loadProtection below) — captioned here so the gap reads as scope,
  // not a bug.
  // BACKEND-R4 §1 (owner's decision) — firm-wide money is Owner-only IN THE UI, and that rule was
  // being enforced on Reports but skipped here, so the same fee total the Reports page withholds
  // was the biggest number on every adviser's home screen. Same gate, same caveat: PRESENTATION
  // ONLY. The cases table still carries broker_fee to every staff session; this is not a control.
  const money = showMoney();
  $("#kpi-row").innerHTML = `
    <div class="kpi" style="cursor:pointer;" onclick="kpiGoto('active')" title="View the pipeline"><div class="num">${active.length}</div><div class="lbl">Active cases</div></div>
    <div class="kpi" style="cursor:pointer;" onclick="kpiGoto('completions')" title="View Reports"><div class="num">${completedThisYear.length}</div><div class="lbl">Completions in ${yr}</div></div>
    <div class="kpi ${ratesSoon.length ? "warn" : ""}" style="cursor:pointer;" onclick="kpiGoto('rates')" title="View Rate &amp; ERC alerts"><div class="num">${ratesSoon.length}</div><div class="lbl">Rates ending ≤ ${reminderMonths}mo (or overdue)</div></div>
    <div class="kpi ${ercFlags.length ? "bad" : ""}" style="cursor:pointer;" onclick="kpiGoto('erc')" title="View Rate &amp; ERC alerts"><div class="num">${ercFlags.length}</div><div class="lbl">ERC outlasts rate</div></div>
    ${money ? `<div class="kpi ${feesDue.length ? "warn" : ""}" style="cursor:pointer;" onclick="kpiGoto('fees')" title="View the Protection &amp; Fees drawer — Fees due tab"><div class="num">${fmtM(feesDueTotal)}</div><div class="lbl">Fees outstanding (${feesDue.length}) <span style="font-weight:400;opacity:.7;">· all stages</span></div></div>` : ""}`;

  const ercIds = new Set(ercFlags.map((a) => a.case_id));
  const rateErcMerged = [...ratesSoon];
  ercFlags.forEach((a) => { if (!rateErcMerged.some((x) => x.case_id === a.case_id)) rateErcMerged.push(a); });
  rateErcMerged.sort((a, b) => (a.rate_end_date || "") < (b.rate_end_date || "") ? -1 : 1);
  const rateErcH3 = $("#rate-erc-panel h3");
  rateErcH3.innerHTML = `⚠️ Rate &amp; ERC alerts
    ${ratesSoon.length ? `<span class="count hot">${ratesSoon.length} ending soon</span>` : ""}
    ${ercFlags.length ? `<span class="count" style="background:#fbe9e7;color:var(--red);">${ercFlags.length} ERC conflict</span>` : ""}`;
  $("#alerts-rateerc").innerHTML = rateErcMerged.length ? rateErcMerged.slice(0, 15).map((a) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${a.case_id}')">${esc(a.client_name)}</div>
        <div class="s">${lenderIcon(a.lender)}${esc(a.lender || "")} ${a.rate_percent ? a.rate_percent + "%" : ""} — ends ${fmtD(a.rate_end_date)}${a.days_to_rate_end != null ? ` (${a.days_to_rate_end < 0 ? Math.abs(a.days_to_rate_end) + " days ago" : "in " + a.days_to_rate_end + " days"})` : ""}${ercIds.has(a.case_id) ? ` — ERC runs until ${fmtD(a.erc_end_date)}` : ""}</div>
      </div>
      ${a.days_to_rate_end < 0 ? '<span class="badge red">OVERDUE</span>' : ""}
      ${ercIds.has(a.case_id) ? `<span class="badge red" title="${TIP_ERC}">ERC conflict</span>` : ""}
      ${a.rate_end_estimated ? `<span class="badge purple" title="${TIP_APPROX}">≈ estimate</span>` : ""}
      ${a.stage === "completed"
        ? (a.rate_reminder_queued_at ? '<span class="badge green">Reminder sent</span>' : '<span class="badge amber">Reminder pending</span>')
        : `<span class="badge blue">${STAGE_LABEL[a.stage] || a.stage}</span>`}
      ${/* R5-6 — the backend auto-creates a retention case only while the rate is still in FUTURE
           reminder window; a rate that has already ended is never picked up, and these rows sat
           here saying "reminder pending" forever. This is the manual path for exactly those. */ ""}
      ${a.stage === "completed" && !a.rate_reminder_queued_at && a.rate_end_date && !retentionSourceIds.has(a.case_id)
        ? `<button class="btn btn-sm btn-retention" onclick="event.stopPropagation();startRetentionCase('${a.case_id}', event)" title="Create the follow-on remortgage case, the call task and a queued reminder">🔁 Start retention case</button>` : ""}
      ${/* G1I-R5 — the recovery control. A retention case already exists for this one, so the
           button above is (correctly) gone, but the source was never stamped: the row nags
           "Reminder pending" forever and the nightly RPC will never pick it up either, because
           the rate has ended and a successor exists. Without this the only way out was to send the
           client a SECOND reminder email. */ ""}
      ${a.stage === "completed" && !a.rate_reminder_queued_at && retentionSourceIds.has(a.case_id)
        ? `<button class="btn btn-sm btn-retention" onclick="event.stopPropagation();markRateReminded('${a.case_id}', event)" title="This case already has a retention case, but it was never marked as reminded — clear the nag without emailing the client again">✓ Mark as reminded</button>` : ""}
    </div>`).join("") + (rateErcMerged.length > 15 ? `<div class="empty">…and ${rateErcMerged.length - 15} more — see Pipeline table view.</div>` : "") : '<div class="empty">Nothing ending in the reminder window, and no ERC conflicts. 👍</div>';

  loadRetention();
  loadTasks();
  loadProtection();
  loadLeads();
  loadTodayAppts();
  loadBriefing();
  // T1-11 — "resolves itself when fixed" is what #watchtower-sub promises, but the checker only ran
  // from the Run checks button, so a list the administrator was actively working never shrank.
  // Re-run it before reading the alerts; if the RPC fails, still render whatever rows exist.
  try { await db.rpc("run_watchtower"); } catch (e) { /* degraded: show the last known alerts */ }
  loadWatchtower();
  if (settings.outlook_enabled === "1") {
    const last = Number(localStorage.getItem("nm_last_outlook_sync") || 0);
    if (Date.now() - last > 10 * 60000) {
      localStorage.setItem("nm_last_outlook_sync", String(Date.now()));
      syncOutlook(true);
    }
  }

  // This tab is narrower than the Today KPI's "Fees outstanding" card by design, not by bug: it
  // comes from v_alerts, which only carries COMPLETED cases that also have a tracked rate_end_date.
  // The KPI counts every outstanding fee at any live stage — the two numbers describe different scopes.
  const feeAlerts = (alerts || []).filter((a) => a.stage === "completed" && ["not_requested", "requested"].includes(a.fee_status) && a.broker_fee > 0);
  // Same Owner-only money rule as the KPI above — this tab is a firm-wide list of broker fees on
  // colleagues' clients, so the whole tab (button and panel) goes rather than being left as a door
  // to the figures the tile just withheld. Presentation only; v_alerts is unchanged.
  const feesTabBtn = $('#revenue-panel .dash-tab[data-tab="fees"]');
  if (feesTabBtn) feesTabBtn.classList.toggle("hidden", !money);
  if (!money) {
    // Leave the Protection tab selected and its panel showing — hiding the button alone would let a
    // previously-clicked Fees tab keep an empty panel on screen.
    document.querySelectorAll("#revenue-panel .dash-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
    document.querySelectorAll("#revenue-panel .dash-tab-panel").forEach((p, i) => p.classList.toggle("hidden", i !== 0));
    $("#alerts-fees").innerHTML = "";
    $("#tab-fees-count").textContent = "0";
    updateRevenueDrawerCount();
    return;
  }
  const feesTabCaption = '<div class="panel-sub" style="margin:0 0 8px;">Completed cases with a tracked rate only. The Today KPI\'s "Fees outstanding" total is broader — it also counts fees due earlier in the pipeline.</div>';
  $("#alerts-fees").innerHTML = feesTabCaption + (feeAlerts.length ? feeAlerts.map((a) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${a.case_id}')">${esc(a.client_name)}</div>
        <div class="s">${fmtM(a.broker_fee)} — ${lenderIcon(a.lender)}${esc(a.lender || "")}</div>
      </div>
      <span class="badge ${a.fee_status === "requested" ? "amber" : "grey"}">${a.fee_status === "requested" ? "Requested" : "Not requested"}</span>
    </div>`).join("") : '<div class="empty">No outstanding fees on completed cases.</div>');
  $("#tab-fees-count").textContent = feeAlerts.length;
  updateRevenueDrawerCount();
}

async function loadRetention() {
  const { data: rets, error } = await db.from("cases")
    .select("id,stage,lender,rate_end_date,rate_end_estimated,clients(first_name,last_name)")
    .not("retention_source_case_id", "is", null)
    .order("rate_end_date");
  if (error) { renderLoadError("#retention-list", error, loadRetention); return; }
  const all = rets || [];
  const open = all.filter((c) => !["completed", "not_proceeding"].includes(c.stage));
  const won = all.filter((c) => c.stage === "completed").length;
  const lost = all.filter((c) => c.stage === "not_proceeding").length;
  const rate = won + lost ? Math.round((won / (won + lost)) * 100) : null;
  /* R5-6 — the old copy here ("nothing creates these for you") was simply untrue: the nightly
     queue_automated_emails() RPC creates a retention case, its note, its call task and a queued
     reminder as soon as a completed client's rate enters the reminder window. What it genuinely
     cannot do is reach back for a rate that has ALREADY ended — that is what the button is for. */
  $("#retention-stats").textContent =
    `${open.length} open · ${won} won · ${lost} lost${rate != null ? ` · ${rate}% conversion` : ""}. Created automatically when a completed client's rate enters the reminder window. For rates already past, open the case and press Start retention case.`;
  $("#retention-list").innerHTML = open.length ? open.slice(0, 12).map((c) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${c.id}')">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</div>
        <div class="s">${lenderIcon(c.lender)}${esc(c.lender || "")} — rate ends ${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""}</div>
      </div>
      <span class="badge blue">${STAGE_LABEL[c.stage] || c.stage}</span>
    </div>`).join("") + (open.length > 12 ? `<div class="empty">…and ${open.length - 12} more in the pipeline.</div>` : "")
    : '<div class="empty">No open retention opportunities. One is created for you when a completed client\'s rate enters the reminder window; for a rate that has already ended, use Start retention case on the completed case (see Rate &amp; ERC alerts above).</div>';
  panelCount("#retention-list", open.length);
}

/* R5-6 — the manual half of the retention loop.
   `queue_automated_emails()` (the nightly RPC) creates a successor case + note + call task +
   queued reminder for every completed case whose rate end date falls between TODAY and the
   reminder window's edge. A rate that ended last month is permanently out of that window, so those
   cases nag "Reminder pending" forever and nobody ever books the conversation. This replicates the
   RPC's behaviour for ONE case, on demand, with the same shapes so the automatic and manual rows
   are indistinguishable afterwards. It QUEUES the reminder — it never sends (R5-1). */
window.startRetentionCase = async function (caseId, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try {
    const { data: c } = await db.from("cases").select("*").eq("id", caseId).single();
    if (!c) return toast("Case not found — it may have been deleted or you don't have access.");
    if (c.stage !== "completed") return toast("A retention case starts from a completed case.");
    if (!c.rate_end_date) return toast("Set the rate end date on this case first.");
    const { data: already } = await db.from("cases").select("id").eq("retention_source_case_id", caseId).limit(1);
    if (already && already.length) { toast("This case already has a retention case."); return; }
    const { data: cl } = await db.from("clients").select("id,first_name,last_name,email").eq("id", c.client_id).single();
    const clientName = [cl?.first_name, cl?.last_name].filter(Boolean).join(" ") || "this client";
    // Same due-date formula as the RPC: three months before the rate ends, never in the past.
    const due = new Date(c.rate_end_date + "T12:00:00");
    due.setMonth(due.getMonth() - 3);
    const tomorrow = Date.now() + 86400000;
    const dueStr = localDateStr(Math.max(due.getTime(), tomorrow));
    const taskTitle = `Call client — rate ends ${c.rate_end_date}`;
    const kind = c.case_kind === "buy_to_let" ? "buy_to_let" : "remortgage";
    const kindLabel = (KINDS.find((k) => k[0] === kind) || [])[1] || kind;
    if (!confirm([
      `Start a retention case for ${clientName}?`,
      "",
      "This creates:",
      `• a new ${kindLabel} case at Enquiry, linked back to this one`,
      `• a task "${taskTitle}" due ${fmtD(dueStr)}`,
      cl && cl.email
        ? `• a rate-end reminder QUEUED to ${cl.email} — it goes out with the next automation run, nothing is sent now`
        : `• no reminder email — ${clientName} has no email address on file`,
      "",
      "This case will stop showing as \"reminder pending\".",
    ].join("\n"))) return;

    const successor = {
      client_id: c.client_id,
      case_kind: kind,
      stage: "enquiry",
      lender: c.lender, product_name: c.product_name,
      loan_amount: c.loan_amount, property_value: c.property_value,
      rate_percent: c.rate_percent, rate_type: c.rate_type,
      rate_end_date: c.rate_end_date, rate_end_estimated: !!c.rate_end_estimated,
      erc_end_date: c.erc_end_date, term_years: c.term_years,
      lead_source: "Repeat client",
      assigned_to: c.assigned_to || (ME && ME.id) || null,
      retention_source_case_id: caseId,
    };
    let ins = await db.from("cases").insert(successor).select("id").single();
    if (ins.error && isMissingColumnError(ins.error)) {
      // Older DB: drop the optional carry-over fields and keep the link, which is the point of it.
      const lean = { client_id: successor.client_id, case_kind: kind, stage: "enquiry", lender: c.lender,
        loan_amount: c.loan_amount, rate_end_date: c.rate_end_date, lead_source: "Repeat client",
        assigned_to: successor.assigned_to, retention_source_case_id: caseId };
      ins = await db.from("cases").insert(lean).select("id").single();
    }
    if (ins.error || !ins.data) return toast("Could not create the retention case: " + ((ins.error && ins.error.message) || "unknown error"));
    const newId = ins.data.id;

    /* G1I-R7 — toast() writes to a single #toast node, so a warning emitted here and a success
       emitted a few lines later in the same task never both reach the screen: the browser paints
       once, and what it paints is the LAST message. A MutationObserver caught the queue-failure
       warning being replaced by "Retention case created ✓" with no paint at all, and the call-task
       warning surviving for 9ms. Every part-failure below is therefore collected and reported in
       ONE final sentence, so nothing can silently overwrite anything else. */
    const warn = [];
    // The note the RPC writes, worded honestly for a hand-started one — a compliance timeline must
    // not claim the 8am cron did something a person did.
    // G1I-R2 — unchecked, this insert could fail and leave the successor with an empty timeline,
    // indistinguishable from an auto-created one, under an unqualified success message.
    const { error: noteErr } = await db.from("case_notes").insert({
      case_id: newId,
      body: `Retention case started from the completed case — ${clientName}'s rate ends ${c.rate_end_date}.`,
      created_by: (ME && ME.id) || null,
    });
    if (noteErr) warn.push(`the note recording where it came from was NOT saved (${noteErr.message}) — add it by hand so the timeline explains the case`);
    const { error: taskErr } = await db.from("case_tasks").insert({
      case_id: newId, title: taskTitle, due_date: dueStr,
      assigned_to: successor.assigned_to, created_by: (ME && ME.id) || null,
    });
    if (taskErr) warn.push(`the call task could not be added — "${taskTitle}" (${taskErr.message}), so nothing holds the conversation`);
    // Stamping the SOURCE retires the My Day "rate ended, not contacted" nag and Watchtower's
    // un-reminded count — the same stamp the RPC makes.
    // G1I-R5 — unchecked, a failed stamp left the source case nagging "Reminder pending" forever:
    // the successor now exists, so the "Start retention case" button is gone from the row, and the
    // nightly RPC will never pick the case up either (the rate has ended and a successor exists).
    // Say so, and leave a way out: the row keeps a "Mark as reminded" control in exactly this state
    // (see the Rate & ERC alerts renderer) rather than silently nagging with no control at all.
    const { error: stampErr } = await db.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", caseId);
    if (stampErr) warn.push(`the completed case could not be marked as reminded (${stampErr.message}) — it will keep showing "Reminder pending" until you press "Mark as reminded" on that row`);
    let queued = false;
    if (cl && cl.email) {
      const { error: qErr } = await db.from("email_queue").insert({
        case_id: newId, client_id: c.client_id, email_type: "rate_end_reminder", to_email: cl.email,
      });
      if (qErr) warn.push(`the rate-end reminder to ${cl.email} was NOT queued (${qErr.message}) — the client will not hear from us until you queue it from the case`);
      else queued = true;
    }
    toast(warn.length
      ? `Retention case created, but ${warn.join("; and ")}`
      : `Retention case created ✓${queued ? " — reminder queued, not sent" : ""}`);
    if (currentModal && currentModal.type === "case" && currentModal.id === caseId) openCase(caseId);
    if (!$("#page-dashboard").classList.contains("hidden")) loadDashboard();
    else { loadRetention(); loadBriefing(); }
  } finally {
    if (btn) btn.disabled = false;
  }
};
/* G1I-R5 — the one-line repair for a source case that has a retention case but was never stamped
   (the stamp failed when it was created). It is deliberately NOT a send: it records that the client
   has been dealt with, exactly as the RPC's stamp does, so the row stops nagging without a second
   email landing in the client's inbox. */
window.markRateReminded = async function (caseId, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try {
    const { error } = await db.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", caseId);
    if (error) return toast("Could not mark it as reminded: " + error.message);
    toast("Marked as reminded — no email was sent.");
    if (currentModal && currentModal.type === "case" && currentModal.id === caseId) openCase(caseId);
    if (!$("#page-dashboard").classList.contains("hidden")) loadDashboard();
  } finally {
    if (btn) btn.disabled = false;
  }
};

async function loadTasks() {
  const horizon = localDateStr(Date.now() + 14 * 86400000);
  const { data: raw, error } = await db.from("case_tasks")
    .select("id,title,due_date,case_id,assigned_to,cases(clients(first_name,last_name))")
    .is("done_at", null)
    .lte("due_date", horizon)
    .order("due_date")
    .limit(200); // sane fetch cap; the "mine" scope filter is applied client-side below, so limit AFTER filtering (was .limit(40) which truncated busy advisers' lists/badges before scoping)
  if (error) { renderLoadError("#tasks-list", error, loadTasks); return; }
  // T1-5: "Mine" means mine. Ownerless tasks are no longer silently everyone's — they live behind
  // the explicit Unassigned scope so they get claimed deliberately.
  const filtered = (raw || []).filter((t) => tasksScope === "all" || (tasksScope === "unassigned" ? !t.assigned_to : t.assigned_to === (ME && ME.id)));
  const tasks = filtered.slice(0, 15);
  const todayStr = localDateStr();
  $("#tasks-list").innerHTML = (tasks || []).length ? tasks.map((t) => {
    const overdue = t.due_date && t.due_date < todayStr;
    const who = t.cases?.clients ? [t.cases.clients.first_name, t.cases.clients.last_name].filter(Boolean).join(" ") : "";
    return `<div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${t.case_id}')">${esc(who)}</div>
        <div class="s">${esc(t.title)} — due ${fmtD(t.due_date)}</div>
      </div>
      ${overdue ? '<span class="badge red">overdue</span>' : ""}
      ${taskAssigneeHtml(t.id, t.assigned_to, "tasks")}
      <button class="btn btn-sm" onclick="doneTask('${t.id}')">✓ Done</button>
    </div>`;
  }).join("") + (filtered.length > tasks.length ? `<div class="empty">…and ${filtered.length - tasks.length} more due.</div>` : "") : '<div class="empty">Nothing due in the next 14 days.</div>';
  panelCount("#tasks-list", filtered.length, true);
}
window.doneTask = async function (id) {
  await db.from("case_tasks").update({ done_at: new Date().toISOString() }).eq("id", id);
  toast("Task done");
  loadTasks();
};
window.doneTaskInCase = async function (taskId, caseId) {
  await db.from("case_tasks").update({ done_at: new Date().toISOString() }).eq("id", taskId);
  openCase(caseId);
};

async function loadProtection() {
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data: opps, error } = await db.from("cases")
    .select("id,stage,lender,completed_at,clients(first_name,last_name)")
    .eq("protection_status", "not_discussed")
    .or(`stage.in.(application,offer),and(stage.eq.completed,completed_at.gte.${cutoff})`)
    .order("updated_at", { ascending: false })
    .limit(12);
  if (error) { renderLoadError("#protection-list", error, loadProtection); return; }
  $("#protection-list").innerHTML = (opps || []).length ? opps.map((c) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${c.id}')">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</div>
        <div class="s">${lenderIcon(c.lender)}${esc(c.lender || "")} — ${STAGE_LABEL[c.stage] || c.stage}${c.stage === "completed" ? " " + fmtD(c.completed_at) : ""}</div>
      </div>
      <span class="badge amber">discuss protection</span>
    </div>`).join("") : '<div class="empty">All live cases have protection recorded. 👍</div>';
  $("#tab-protection-count").textContent = (opps || []).length;
  updateRevenueDrawerCount();
}

/* ---------- My Day briefing ---------- */
let briefingScope = "mine";
// BUILD 7d (defect 18) — the last-fetched briefing items, kept so toggling a group's expand state
// can re-render instantly without re-hitting the RPC. Session-only.
let lastBriefItems = [];
// Case ids the user has manually expanded to see every item behind a grouped row. Pruned to only
// cases still present in the briefing on every reload, so a stale key can't linger.
let briefExpanded = new Set();
// T1-23 — case_id → "Product Transfer · DIP", populated only for clients with >1 open case.
let briefCaseMeta = {};
function briefCaseDisc(it) {
  const d = it && it.case_id && briefCaseMeta[it.case_id];
  return d ? ` <span class="cs-muted">(${esc(d)})</span>` : "";
}
const BRIEF_KIND_SHORT = {
  task_overdue: "overdue task", task_today: "task today", lead_new: "lead", email_new: "email",
  appt_today: "appointment", rate_urgent: "rate-end", stalled: "stalled", fee_chase: "fee",
  protection_hot: "protection", no_completion_date: "completion date",
};
function briefKindShort(kind) { return BRIEF_KIND_SHORT[kind] || String(kind || "").replace(/_/g, " "); }

function briefBadge(it) {
  switch (it.kind) {
    case "task_overdue": return '<span class="badge red">OVERDUE</span>';
    case "task_today": return '<span class="badge amber">TODAY</span>';
    case "lead_new": return '<span class="badge green">NEW LEAD</span>';
    case "email_new": return '<span class="badge blue">EMAIL</span>';
    case "appt_today": return '<span class="badge purple">APPT</span>';
    case "rate_urgent": return it.days != null && it.days < 0 ? '<span class="badge red">RATE ENDED</span>' : '<span class="badge amber">RATE</span>';
    case "stalled": return '<span class="badge grey">STALLED</span>';
    case "fee_chase": return '<span class="badge amber">FEE</span>';
    case "protection_hot": return '<span class="badge green">PROTECTION</span>';
    default: return "";
  }
}
function briefActions(it) {
  const open = it.case_id ? `<button class="btn btn-sm" onclick="openCase('${it.case_id}')">Open</button>` : "";
  switch (it.kind) {
    case "task_overdue":
    case "task_today":
      return `<button class="btn btn-sm" onclick="briefDone('${it.task_id}')">✓ Done</button>${open}`;
    case "lead_new":
      return `<select class="lead-adviser" data-lead="${esc(it.lead_id || "")}" aria-label="Assign this lead to" title="Which adviser this lead's case is created for" style="width:auto;">${leadAdviserOptionsHtml()}</select><button class="btn btn-sm btn-primary" onclick="acceptLead('${it.lead_id}', event)">Accept</button>`;
    case "email_new":
      return `${it.case_id ? `<button class="btn btn-sm" onclick="openCase('${it.case_id}')">Open case</button>` : ""}<button class="btn btn-sm" onclick="markEmailHandled('${it.email_id}')">Handled</button>${it.case_id ? `<button class="btn btn-sm" onclick="askAI('Draft a reply to the latest email from this client. Case id: ${it.case_id}')">Draft reply</button>` : ""}`;
    case "appt_today":
      // Defect 27: the row title now opens the same destination (the appointment editor) as this
      // button — a small secondary "Case" link is offered too when a case is linked, rather than
      // the title and button silently disagreeing on where "Open" means.
      return (it.appt_id ? `<button class="btn btn-sm" onclick="openAppt('${it.appt_id}')">Open</button>` : "")
        + (it.case_id ? `<button class="btn btn-sm btn-ghost" onclick="openCase('${it.case_id}')" title="Open the linked case">Case</button>` : "");
    case "rate_urgent":
      return `${(it.sub || "").includes("not contacted") ? `<button class="btn btn-sm" onclick="briefQueueEmail('${it.case_id}','rate_end_reminder', event)">Send reminder</button>` : ""}${open}`;
    case "fee_chase":
      /* R5-28 — a fee request is composed server-side from the firm's bank details, so with none
         set queueEmail refuses every one of these. The button used to be offered anyway: click,
         toast, nothing happens, repeat per row. State the blocker once instead, and (for the one
         person who can clear it) point at where. hasBankDetails === null means "not asked yet /
         the check failed" — nothing is hidden on an unknown. */
      if (hasBankDetails === false) {
        return `<span class="badge grey" title="Fee-request emails are composed from the firm's bank details, and none are set in Settings.">fee requests blocked — no bank details</span>`
          + (isOwner() ? `<button class="btn btn-sm" onclick="gotoSettings()" title="Add the bank details">Open Settings</button>` : "")
          + open;
      }
      return `<button class="btn btn-sm" onclick="briefQueueEmail('${it.case_id}','fee_request', event)">Chase fee</button>${open}`;
    case "protection_hot":
      return `<button class="btn btn-sm" onclick="setProtStatus('${it.case_id}','quoted').then(()=>loadBriefing())">Mark quoted</button>${open}`;
    case "no_completion_date":
      return `<button class="btn btn-sm" onclick="gotoPipelineSegment('current')">View pipeline</button>`;
    default:
      return open;
  }
}
// Inline handlers run in global scope, so the one nav target the briefing offers needs a window hook.
window.gotoSettings = function () { nav("settings"); };
async function loadBriefing() {
  $("#briefing-date").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const { data, error } = await db.rpc("get_briefing", { p_scope: briefingScope });
  if (error) {
    $("#briefing-list").innerHTML = `<div class="empty">Briefing unavailable — ${esc(error.message)}</div>`;
    return;
  }
  /* R5-35 — get_briefing's "mine" scope hands back every OWNERLESS row as well as mine, so an
     unassigned task on Wayne's case sat in Luke's My Day looking like his job, and in Wayne's, and
     in Kim's. Same post-filter the Tasks panel and get_protection_pipeline already apply: Mine
     means owner === me, full stop. Ownerless work is visible under All, labelled "· unassigned".
     ONE exception, deliberate and narrow: a new website lead has no owner by nature — it is the
     firm's shared inbox, it is what the Accept dropdown on the row is for, and R5-21 (Batch 1)
     depends on it being in My Day. Leads are therefore kept in both scopes. */
  const items = (Array.isArray(data) ? data : []).filter((it) =>
    briefingScope === "all" || it.kind === "lead_new" || it.owner === (ME && ME.id));
  // BUILD 6c — completion-date chaser. get_briefing is RPC-driven (mirrored to prod, no schema
  // access to add a bucket there), so this one extra item is computed client-side from the same
  // `cases` table every other Today widget already queries directly, then merged in by priority —
  // purely additive, doesn't touch/duplicate anything the RPC itself returns. Degrades silently:
  // if this query errors, the rest of the briefing still renders untouched.
  try {
    const { data: openCases } = await db.from("cases")
      .select("id,stage,assigned_to")
      .in("stage", ["offer", "exchange"])
      .is("expected_completion_date", null);
    // R5-35 — the same strict rule: under Mine this counts MY offer/exchange cases, not the
    // ownerless ones as well. The row itself is an aggregate, so it carries no owner suffix.
    const mine = (owner) => briefingScope === "all" || owner === (ME && ME.id);
    const n = (openCases || []).filter((c) => mine(c.assigned_to)).length;
    if (n > 0) {
      items.push({
        kind: "no_completion_date", pri: 45,
        title: `${n} offer/exchange case${n === 1 ? "" : "s"} missing an expected completion date`,
        sub: "Chase for a completion date — sharpens the commission forecast",
        goto_segment: "current", owner: null, aggregate: true,
      });
      items.sort((a, b) => a.pri - b.pri);
    }
  } catch (e) { /* graceful degradation — the RPC-driven items above still render */ }
  // T1-23 — a client with more than one open case (Duncan Armitage's rate-end sits on two of them,
  // Ruby Sinclair has four) produces briefing rows whose titles are word-for-word identical and
  // whose Send-reminder buttons act on different cases. Look up kind + stage for every case behind
  // a row and hand briefRowHtml a discriminator for exactly those clients. Best-effort: on error
  // the rows render as before rather than not at all.
  briefCaseMeta = {};
  try {
    const clientIds = [...new Set(items.filter((it) => it.client_id).map((it) => it.client_id))];
    if (clientIds.length) {
      const { data: cs } = await db.from("cases").select("id,client_id,stage,case_kind").in("client_id", clientIds);
      const live = (cs || []).filter((c) => c.stage !== "not_proceeding");
      const perClient = {};
      live.forEach((c) => { perClient[c.client_id] = (perClient[c.client_id] || 0) + 1; });
      live.forEach((c) => {
        if (perClient[c.client_id] < 2) return;
        const kind = (KINDS.find((k) => k[0] === c.case_kind) || [])[1] || "";
        briefCaseMeta[c.id] = [kind, STAGE_LABEL[c.stage] || c.stage].filter(Boolean).join(" · ");
      });
    }
  } catch (e) { /* graceful degradation — rows just render without the discriminator */ }
  /* R5-9 + R5-25 — the appointment rows. get_briefing returns the appointment's own title and a
     time, which for a title like "Protection review" leaves "who with?" unanswered on the one
     screen an adviser reads before the day starts — and says nothing about the fact that two of
     them are at 10:00 with the same adviser. One clients fetch (names) + one appointments fetch
     (real start/end times) answers both. Best-effort throughout: on error the rows render as they
     did before. */
  try {
    const apptItems = items.filter((it) => it.kind === "appt_today" && it.appt_id);
    if (apptItems.length) {
      const clientIds = [...new Set(apptItems.filter((it) => it.client_id).map((it) => it.client_id))];
      const [{ data: cls }, { data: aps }] = await Promise.all([
        clientIds.length ? db.from("clients").select("id,first_name,last_name").in("id", clientIds) : Promise.resolve({ data: [] }),
        db.from("appointments").select("id,starts_at,ends_at,staff_id").in("id", apptItems.map((it) => it.appt_id)),
      ]);
      const nameById = {};
      (cls || []).forEach((cl) => { nameById[cl.id] = [cl.first_name, cl.last_name].filter(Boolean).join(" "); });
      const apById = {};
      (aps || []).forEach((ap) => { apById[ap.id] = ap; });
      // R5-9 — name the client, unless whoever booked it already typed the name into the title.
      apptItems.forEach((it) => {
        const nm = nameById[it.client_id];
        if (!nm) return;
        const t = String(it.title || "");
        const last = nm.split(" ").slice(-1)[0];
        if (t.toLowerCase().includes(nm.toLowerCase()) || (last && t.toLowerCase().includes(last.toLowerCase()))) return;
        it.title = `${t} — ${nm}`;
      });
      // R5-25 — the diary already flags a double-booking (⚠ + a title tooltip); My Day, which is
      // where the clash is still fixable, said nothing. Same rule: same adviser, overlapping
      // [start, end). Compared pairwise — a day's appointment list is tiny.
      apptItems.forEach((a) => {
        const ra = apById[a.appt_id]; if (!ra || !ra.starts_at) return;
        const aStart = new Date(ra.starts_at), aEnd = new Date(ra.ends_at || ra.starts_at);
        const clash = apptItems.some((b) => {
          if (b === a) return false;
          const rb = apById[b.appt_id]; if (!rb || !rb.starts_at) return false;
          if ((rb.staff_id || null) !== (ra.staff_id || null)) return false;
          return new Date(rb.starts_at) < aEnd && new Date(rb.ends_at || rb.starts_at) > aStart;
        });
        if (clash) { a.clash = true; a.title = `⚠ ${a.title}`; }
      });
    }
  } catch (e) { /* graceful degradation — appointment rows render un-enriched */ }
  lastBriefItems = items;
  // Prune expand-state to cases still present, so a stale key from a since-resolved case can't
  // silently keep a future unrelated case pre-expanded.
  const liveCaseIds = new Set(items.filter((it) => it.case_id).map((it) => it.case_id));
  [...briefExpanded].forEach((k) => { if (!liveCaseIds.has(k)) briefExpanded.delete(k); });
  renderBriefing();
}
// BUILD 7d (defect 18) — one case (e.g. Ruby Sinclair: overdue task + rate-end + protection, all
// on the same case) otherwise surfaces as several separate briefing rows, inviting a double-contact.
// Group consecutive-by-priority items sharing a case_id into ONE row (the highest-priority item's
// title/badge/actions), with the rest folded behind a "+N more" toggle. Items has already been
// sorted by priority (RPC + the client-side merge above), so the first occurrence of a case_id is
// always its highest-priority item — no extra sort needed here.
function groupBriefRows(items) {
  const seen = new Set();
  const rows = [];
  items.forEach((it) => {
    if (!it.case_id) { rows.push({ key: null, head: it, extra: [] }); return; }
    if (seen.has(it.case_id)) return;
    seen.add(it.case_id);
    const group = items.filter((x) => x.case_id === it.case_id);
    rows.push({ key: it.case_id, head: it, extra: group.filter((x) => x !== it) });
  });
  return rows;
}
function briefTitleClickAttr(it) {
  if (it.kind === "appt_today" && it.appt_id) return `onclick="openAppt('${it.appt_id}')"`;
  if (it.case_id) return `onclick="openCase('${it.case_id}')"`;
  if (it.client_id) return `onclick="openClient('${it.client_id}')"`;
  if (it.goto_segment) return `onclick="gotoPipelineSegment('${it.goto_segment}')"`;
  return "";
}
/* R5-25 — the ⚠ prefix on a clashing appointment gets the diary's own explanation on hover. */
function briefTitleAttrs(it) {
  return `${briefTitleClickAttr(it)}${it.clash ? ' title="double-booked"' : ""}`;
}
/* R5-35 — under All, a row with no owner says so rather than reading as "everyone's / nobody's".
   Aggregate rows (the completion-date chaser) count cases, so they carry no owner at all. */
function briefOwnerSuffix(it) {
  if (briefingScope !== "all" || it.aggregate) return "";
  return it.owner ? " · " + esc(staffName(it.owner)) : ' · <span class="cs-muted">unassigned</span>';
}
function briefSubRowHtml(it) {
  return `<div class="row-item brief-row brief-subrow">
      <div class="row-main">
        <div class="t" ${briefTitleAttrs(it)}>${esc(it.title)}${briefCaseDisc(it)}</div>
        <div class="s">${esc(it.sub || "")}${briefOwnerSuffix(it)}</div>
      </div>
      ${briefBadge(it)}
      ${briefActions(it)}
    </div>`;
}
function briefRowHtml(row) {
  const it = row.head;
  const expanded = row.key && briefExpanded.has(row.key);
  const moreHtml = row.extra.length
    ? `<button type="button" class="brief-more" onclick="event.stopPropagation();toggleBriefGroup('${row.key}')">${expanded ? "▾ " : "▸ "}+${row.extra.length} more: ${row.extra.map((x) => briefKindShort(x.kind)).join(" · ")}</button>`
    : "";
  return `<div class="row-item brief-row ${it.pri < 15 ? "hot" : it.pri < 35 ? "warm" : ""}">
      <div class="row-main">
        <div class="t" ${briefTitleAttrs(it)}>${esc(it.title)}${briefCaseDisc(it)}</div>
        <div class="s">${esc(it.sub || "")}${briefOwnerSuffix(it)}</div>
        ${moreHtml}
      </div>
      ${briefBadge(it)}
      ${briefActions(it)}
    </div>${expanded ? row.extra.map(briefSubRowHtml).join("") : ""}`;
}
// Renders from the cached lastBriefItems (no refetch) — used both after a fresh load and when a
// group's expand toggle changes. The count badge stays on the real item total (rows collapse
// visually, but nothing is hidden from the honest workload count).
function renderBriefing() {
  const items = lastBriefItems;
  const rows = groupBriefRows(items);
  $("#briefing-list").innerHTML = rows.length ? rows.map(briefRowHtml).join("") : '<div class="empty">All clear — nothing needs you right now 🎉</div>';
  panelCount("#briefing-list", items.length, items.some((it) => it.pri < 15));
}
window.toggleBriefGroup = function (caseId) {
  if (briefExpanded.has(caseId)) briefExpanded.delete(caseId); else briefExpanded.add(caseId);
  renderBriefing();
};
window.briefDone = async function (id) {
  await window.doneTask(id);
  loadBriefing();
};
window.markEmailHandled = async function (id) {
  const { error } = await db.from("case_emails").update({ triage_status: "handled" }).eq("id", id);
  if (error) return toast("Error: " + error.message);
  toast("Email marked handled");
  loadBriefing();
};
window.queueEmail = queueEmail;
window.briefQueueEmail = async function (caseId, type, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; } // guard against double-click double-insert
  try {
    const { data: c } = await db.from("cases").select("*").eq("id", caseId).single();
    if (!c) return toast("Could not load case");
    await queueEmail(caseId, c.client_id, type, c);
    loadBriefing();
  } finally {
    if (btn) btn.disabled = false;
  }
};
async function syncOutlook(silent) {
  const btn = $("#sync-outlook-btn");
  if (!silent && btn) { btn.disabled = true; btn.textContent = "Syncing…"; }
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/outlook-sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const j = await r.json();
    if (j.error === "not_configured") { if (!silent) toast("Outlook not configured — add MS secrets (see Settings)"); return; }
    if (!r.ok || j.error) { if (!silent) toast("Outlook sync error: " + (j.error || r.status)); return; }
    if (!silent || (j.inserted || 0) > 0) toast(`Synced ${j.matched} client emails (${j.fetched} scanned)`);
    loadBriefing();
  } catch (e) {
    if (!silent) toast("Outlook sync error: " + e.message);
  } finally {
    if (!silent && btn) { btn.disabled = false; btn.textContent = "⟳ Sync Outlook"; }
  }
}
$("#sync-outlook-btn").addEventListener("click", () => syncOutlook(false));
function setBriefScope(s) {
  briefingScope = s;
  $("#brief-scope-mine").classList.toggle("scope-active", s === "mine");
  $("#brief-scope-all").classList.toggle("scope-active", s === "all");
  loadBriefing();
}
$("#brief-scope-mine").addEventListener("click", () => setBriefScope("mine"));
$("#brief-scope-all").addEventListener("click", () => setBriefScope("all"));

/* ---------- Watchtower ---------- */
const WATCH_SEV = { crit: 0, warn: 1, info: 2 };
const WATCH_BADGE = {
  crit: '<span class="badge red">CRITICAL</span>',
  warn: '<span class="badge amber">WARNING</span>',
  info: '<span class="badge blue">FYI</span>',
};
async function loadWatchtower() {
  const { data, error } = await db.from("watch_alerts")
    .select("*")
    .is("resolved_at", null)
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    $("#watchtower-list").innerHTML = `<div class="empty">Watchtower unavailable — ${esc(error.message)}</div>`;
    return;
  }
  const all = (data || []).slice().sort((a, b) => (WATCH_SEV[a.severity] ?? 3) - (WATCH_SEV[b.severity] ?? 3));
  // B5 / M3 — a snooze hides the row from the working list until its date passes. run_watchtower's
  // upserts never touch these columns (see mock-supabase.js note by dedupeKeyFor), so a snooze
  // survives navigation, "Run checks" and cron by construction — only the date decides it's over.
  const nowIso = new Date().toISOString();
  const isSnoozed = (a) => !!a.snoozed_until && a.snoozed_until > nowIso;
  const alerts = all.filter((a) => !isSnoozed(a));
  const snoozed = all.filter(isSnoozed);
  $("#watchtower-list").innerHTML = alerts.length ? alerts.map((a) => {
    const openClick = a.case_id ? `onclick="openCase('${a.case_id}')"` : a.client_id ? `onclick="openClient('${a.client_id}')"` : "";
    const openBtn = a.case_id ? `<button class="btn btn-sm" onclick="openCase('${a.case_id}')">Open</button>`
      : a.client_id ? `<button class="btn btn-sm" onclick="openClient('${a.client_id}')">Open</button>` : "";
    return `<div class="row-item">
      <div class="row-main">
        <div class="t" ${openClick}>${esc(a.title)}</div>
        <div class="s">${esc(a.detail || "")} · ${fmtD(a.created_at)}</div>
      </div>
      ${WATCH_BADGE[a.severity] || WATCH_BADGE.info}
      ${openBtn}
      <button class="btn btn-sm" onclick="snoozeAlert('${a.id}','${a.severity}','${a.case_id || ""}')">Snooze…</button>
      <button class="btn btn-sm" onclick="resolveAlert('${a.id}','${a.severity}','${a.case_id || ""}')">Dismiss</button>
    </div>`;
  }).join("") : '<div class="empty">No problems detected 🎉</div>';
  panelCount("#watchtower-list", alerts.length, alerts.some((a) => a.severity === "crit"));
  autoDrawer("watchtower", alerts.some((a) => a.severity === "crit")); // auto-open on anything critical, else stay collapsed
  renderSnoozedWatchAlerts(snoozed);
}
window.resolveAlert = async function (id, severity, caseId) {
  let reason = null;
  if (severity === "crit") {
    reason = prompt(
      "Dismiss this CRITICAL alert?\n\n" +
      "This only clears the alert — it does NOT fix the underlying case, and the alert will " +
      "reappear if the problem persists.\n\n" +
      "Give a one-line reason (required — logged to the case for compliance):"
    );
    if (reason == null) return; // cancelled
    reason = reason.trim();
    if (!reason) { toast("A reason is required to dismiss a critical alert."); return; }
  }
  const { error } = await db.from("watch_alerts").update({ resolved_at: new Date().toISOString() }).eq("id", id);
  if (error) return toast("Error: " + error.message);
  // Audit trail: record who dismissed a critical alert and why, in the case timeline. Written as a
  // case_note (no schema change needed) so it works whether or not watch_alerts has resolver columns.
  if (reason && caseId) {
    const who = (ME && (ME.full_name || ME.email)) || "staff";
    try { await db.from("case_notes").insert({ case_id: caseId, body: `🚨 Watchtower alert dismissed by ${who}: ${reason}` }); } catch (e) {}
  }
  toast(reason ? "Dismissed and logged — it'll come back if the problem persists" : "Dismissed — it'll come back if the problem persists");
  loadWatchtower();
};
/* B5 / R5-22 — the "N snoozed" header toggle + list. Kept separate from the main row-item list so
   a snoozed alert never counts toward the drawer's auto-open / hot-count logic above. */
function renderSnoozedWatchAlerts(snoozed) {
  const toggle = $("#watchtower-snoozed-toggle"), panel = $("#watchtower-snoozed");
  if (!toggle || !panel) return;
  if (!snoozed.length) {
    toggle.classList.add("hidden");
    panel.classList.add("hidden");
    panel.innerHTML = "";
    return;
  }
  toggle.classList.remove("hidden");
  toggle.textContent = `${snoozed.length} snoozed`;
  panel.innerHTML = snoozed.map((a) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(a.title)}</div>
        <div class="s">Snoozed until ${fmtD(a.snoozed_until)}${a.snoozed_by ? " by " + esc(staffName(a.snoozed_by)) : ""}${a.snooze_note ? " — " + esc(a.snooze_note) : ""}</div>
      </div>
      <button class="btn btn-sm" onclick="unsnoozeAlert('${a.id}')">Unsnooze</button>
    </div>`).join("");
  toggle.onclick = () => panel.classList.toggle("hidden");
}
/* B5 / R5-22 — date chips (1 week / 1 month / custom, min tomorrow) + a required reason, on the
   shared second-layer overlay (openOverlay, R5 batch 2). Resolves {date, reason} or null on cancel. */
function promptSnooze() {
  const tomorrow = localDateStr(new Date(Date.now() + 86400000));
  const html = `
    <h3>Snooze this alert</h3>
    <p class="panel-sub">Hides it from Watchtower until the date you pick. It does not fix the underlying case — the alert comes back automatically once the date passes (or sooner, if the problem gets worse).</p>
    <div class="due-chips">
      <span class="due-chips-lbl">Until:</span>
      <button type="button" class="btn btn-sm snooze-chip" data-days="7">1 week</button>
      <button type="button" class="btn btn-sm snooze-chip" data-months="1">1 month</button>
    </div>
    <label style="margin-top:10px;">Custom date<input type="date" id="snooze-date" min="${tomorrow}"></label>
    <label style="margin-top:10px;">Reason (required)<textarea id="snooze-reason" rows="2" placeholder="Why is this being snoozed?"></textarea></label>
    <div class="ovl-err" id="snooze-err"></div>
    <div class="modal-actions">
      <div></div>
      <div class="right">
        <button type="button" class="btn" id="snooze-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="snooze-ok">Snooze</button>
      </div>
    </div>`;
  return openOverlay(html, (finish, box) => {
    const dateInput = box.querySelector("#snooze-date");
    box.querySelectorAll(".snooze-chip").forEach((b) => b.onclick = () => {
      const d = new Date();
      if (b.dataset.months) d.setMonth(d.getMonth() + Number(b.dataset.months));
      else d.setDate(d.getDate() + Number(b.dataset.days || 0));
      dateInput.value = localDateStr(d);
    });
    box.querySelector("#snooze-cancel").onclick = () => finish(null);
    box.querySelector("#snooze-ok").onclick = () => {
      const err = box.querySelector("#snooze-err");
      const date = dateInput.value;
      const reason = (box.querySelector("#snooze-reason").value || "").trim();
      if (!date) { err.textContent = "Choose a date."; return; }
      if (date < tomorrow) { err.textContent = "Snooze until at least tomorrow."; return; }
      if (!reason) { err.textContent = "A reason is required."; return; }
      finish({ date, reason });
    };
  });
}
window.snoozeAlert = async function (id, severity, caseId) {
  const picked = await promptSnooze();
  if (!picked) return;
  const snoozedUntil = new Date(picked.date + "T23:59:59").toISOString();
  const { error } = await db.from("watch_alerts")
    .update({ snoozed_until: snoozedUntil, snooze_note: picked.reason, snoozed_by: (ME && ME.id) || null })
    .eq("id", id);
  if (error) {
    if (isMissingColumnError(error)) return toast("Snooze needs migration M3");
    return toast("Error: " + error.message);
  }
  // Mirror the dismiss pattern above: a CRITICAL alert's reason also lands on the case timeline.
  if (severity === "crit" && caseId) {
    const who = (ME && (ME.full_name || ME.email)) || "staff";
    try { await db.from("case_notes").insert({ case_id: caseId, body: `⏰ Watchtower alert snoozed by ${who} until ${fmtD(snoozedUntil)}: ${picked.reason}` }); } catch (e) {}
  }
  toast(`Snoozed until ${fmtD(snoozedUntil)}`);
  loadWatchtower();
};
window.unsnoozeAlert = async function (id) {
  const { error } = await db.from("watch_alerts").update({ snoozed_until: null, snooze_note: null, snoozed_by: null }).eq("id", id);
  if (error) return toast("Error: " + error.message);
  toast("Unsnoozed — back on the working list");
  loadWatchtower();
};
$("#watchtower-run").addEventListener("click", async () => {
  const btn = $("#watchtower-run");
  btn.disabled = true; btn.textContent = "Running…";
  const { data, error } = await db.rpc("run_watchtower");
  btn.disabled = false; btn.textContent = "Run checks";
  if (error) return toast("Error: " + error.message);
  const r = data || {};
  toast(`Checks run — ${r.open ?? 0} open (${r.new ?? 0} new, ${r.resolved ?? 0} auto-resolved)`);
  loadWatchtower();
});

/* ---------- Pipeline ---------- */
async function loadPipeline() {
  const { data: cases, error } = await db.from("cases").select("*, clients(first_name,last_name)").order("updated_at", { ascending: false });
  if (error) {
    $("#board").classList.remove("hidden");
    $("#board-hint").classList.add("hidden");
    $("#stage-tabs").classList.add("hidden");
    $("#table-wrap").classList.add("hidden");
    renderLoadError("#board", error, loadPipeline);
    return;
  }
  const q = ($("#board-search").value || "").trim().toLowerCase();
  const who = $("#board-adviser").value || "all";
  const filtered = (cases || []).filter((c) => {
    if (who === "unassigned" && c.assigned_to) return false;
    if (who !== "all" && who !== "unassigned" && c.assigned_to !== who) return false;
    if (q) {
      // T1-19 — lead source and introducer name are searchable too, so the Reports tables can hand
      // the board a filter the user can see in the box and clear.
      const hay = ((c.clients?.first_name || "") + " " + (c.clients?.last_name || "") + " " + (c.lender || "") + " " + (c.product_name || "") + " " + (c.lead_source || "") + " " + (introducerNames[c.introducer_id] || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  renderSegmentControl(filtered);
  const stageEntry = await loadStageEntries(filtered);
  // Completed segment: the board makes little sense — force the completion-focused table.
  if (pipelineSegment === "completed") pipelineView = "table";
  if (pipelineView === "table") { renderPipelineTable(filtered, stageEntry); return; }
  $("#board").classList.remove("hidden");
  $("#board-hint").classList.remove("hidden");
  $("#stage-tabs").classList.add("hidden");
  $("#table-wrap").classList.add("hidden");
  // In a focused segment only that segment's stage columns render (wider, less scrolling).
  const stages = segmentStageList(pipelineSegment);
  const board = $("#board");
  board.classList.toggle("is-focused", pipelineSegment !== "all");
  board.style.setProperty("--ncols", stages.length);
  const segCases = filtered.filter((c) => inSegment(c.stage, pipelineSegment));
  if (!segCases.length) {
    board.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:48px 16px;text-align:center;">No cases in ${esc(SEGMENTS.find(([k]) => k === pipelineSegment)?.[1] || "this view")}${$("#board-adviser").value && $("#board-adviser").value !== "all" ? " for this adviser" : ""}${q ? " matching your search" : ""}.</div>`;
    updateBoardScrollHint();
    return;
  }
  const byStage = {};
  stages.forEach(([k]) => (byStage[k] = []));
  segCases.forEach((c) => byStage[c.stage]?.push(c));
  // Stalled deals surface first: red, then amber (worst days-in-stage on top),
  // then the rest in the existing updated_at order.
  const AGE_RANK = { red: 0, amber: 1 };
  stages.forEach(([k]) => byStage[k].sort((a, b) => {
    const A = cardAge(a, stageEntry[a.id]), B = cardAge(b, stageEntry[b.id]);
    const ra = A.level in AGE_RANK ? AGE_RANK[A.level] : 2;
    const rb = B.level in AGE_RANK ? AGE_RANK[B.level] : 2;
    if (ra !== rb) return ra - rb;
    if (ra < 2) return (B.inStage ?? -1) - (A.inStage ?? -1);
    return 0;
  }));
  $("#board").innerHTML = stages.map(([k, label]) => `
    <div class="col" data-stage="${k}">
      <h4${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${label} <span>${byStage[k].length}</span></h4>
      ${byStage[k].length === 0 ? '<div class="col-empty">No cases here</div>' : ""}
      ${byStage[k].map((c) => {
        const erc = c.erc_end_date && c.rate_end_date && c.erc_end_date > c.rate_end_date;
        const age = cardAge(c, stageEntry[c.id]);
        const nextStage = nextStageFor(c.stage);
        const advanceBtn = nextStage
          ? `<button type="button" class="card-advance" onclick="event.stopPropagation(); moveCaseToStage('${c.id}', '${nextStage}')" title="Advance to ${esc(STAGE_LABEL[nextStage] || nextStage)}" aria-label="Advance to ${esc(STAGE_LABEL[nextStage] || nextStage)}">→</button>`
          : "";
        return `<div class="card${age.level ? " age-" + age.level : ""}" draggable="true" data-id="${c.id}" onclick="openCase('${c.id}')">
          <div class="cn" style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><span>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "—")}</span><span style="display:flex;align-items:center;gap:6px;flex:0 0 auto;">${c.assigned_to ? `<span class="chip" title="${esc(staffName(c.assigned_to))}">${initials(c.assigned_to)}</span>` : ""}${advanceBtn}</span></div>
          <div class="cd">${lenderIcon(c.lender)}${esc(c.lender || KINDS.find(x=>x[0]===c.case_kind)?.[1] || "")}${c.loan_amount ? " · " + fmtM(c.loan_amount) : ""}</div>
          <div class="flags">
            ${c.rate_end_date ? `<span class="badge ${c.rate_end_estimated ? "purple" : "blue"}">Rate ends ${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""}</span>` : ""}
            ${erc ? `<span class="badge red" title="${TIP_ERC}">ERC conflict</span>` : ""}
            ${c.retention_source_case_id ? '<span class="badge grey">🔁 retention</span>' : ""}
            ${["application","offer"].includes(c.stage) && (c.protection_status || "not_discussed") === "not_discussed" ? '<span class="badge amber">🛡 protection?</span>' : ""}
            ${["offer","exchange"].includes(c.stage) && !c.expected_completion_date ? `<span class="badge amber" title="No expected completion date set — chase the adviser">📅 no date</span>` : ""}
            ${c.submitted_at && !["completed","not_proceeding"].includes(c.stage) ? `<span class="badge grey" title="${TIP_SUB}">📤 sub ${fmtD(c.submitted_at)}</span>` : ""}
            ${c.fee_status === "paid" ? '<span class="badge green">Fee paid</span>' : c.fee_status === "requested" ? '<span class="badge amber">Fee requested</span>' : ""}
          </div>
          ${age.text ? `<div class="age-line" title="${esc(age.basis)}">${age.text}</div>` : ""}
          <select class="card-stage-move" aria-label="Move to stage" title="Move to stage" onclick="event.stopPropagation()" onchange="moveCaseToStage('${c.id}', this.value)">
            ${STAGES.map(([k, l]) => `<option value="${k}" ${k === c.stage ? "selected" : ""}${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${l}</option>`).join("")}
          </select>
        </div>`;
      }).join("")}
    </div>`).join("");
  wireBoardDnD();
  updateBoardScrollHint();
}
/* Horizontal-scroll affordance for the 8-stage board (QW16): edge fade + arrow appear
   only while there are later stages hidden off the right edge. */
function updateBoardScrollHint() {
  const board = $("#board");
  const wrap = board && board.closest(".board-scroll-wrap");
  if (!wrap) return;
  const max = board.scrollWidth - board.clientWidth;
  wrap.classList.toggle("can-scroll-right", board.scrollLeft < max - 4);
  wrap.classList.toggle("can-scroll-left", board.scrollLeft > 4);
}
/* T1-13 — the same edge-fade + arrow affordance as the pipeline board above, generalised for any
   other wide table (protection, pipeline table view, import review). The scroll element is
   rebuilt wholesale on every render, so this re-wires (rather than wires once) each time; using
   property assignment for the handlers makes that idempotent — no listener pile-up. Registers
   itself with the one shared resize listener below so the arrow/fade stay correct on resize too. */
const hscrollTables = new Set();
function wireTableHScroll(scrollElId) {
  const el = document.getElementById(scrollElId);
  const wrap = el && el.closest(".board-scroll-wrap");
  if (!el || !wrap) return;
  const update = () => {
    const max = el.scrollWidth - el.clientWidth;
    wrap.classList.toggle("can-scroll-right", el.scrollLeft < max - 4);
    wrap.classList.toggle("can-scroll-left", el.scrollLeft > 4);
  };
  el.onscroll = update;
  const arrow = wrap.querySelector(".board-scroll-arrow");
  if (arrow) arrow.onclick = () => el.scrollBy({ left: 320, behavior: "smooth" });
  update();
  hscrollTables.add(scrollElId);
}
window.addEventListener("resize", () => {
  hscrollTables.forEach((id) => {
    const el = document.getElementById(id);
    const wrap = el && el.closest(".board-scroll-wrap");
    if (!el || !wrap) return;
    const max = el.scrollWidth - el.clientWidth;
    wrap.classList.toggle("can-scroll-right", el.scrollLeft < max - 4);
    wrap.classList.toggle("can-scroll-left", el.scrollLeft > 4);
  });
});
/* Protection gate — block forward moves into Application+ while protection is unrecorded */
const stageIdx = (s) => STAGES.findIndex(([k]) => k === s);
function protectionGateBlocks(caseRow, newStage) {
  if ((settings.protection_gate ?? "on") !== "on") return false;
  if (newStage === "not_proceeding") return false;
  const from = stageIdx(caseRow.stage), to = stageIdx(newStage);
  if (to < stageIdx("application") || to <= from) return false;
  return (caseRow.protection_status || "not_discussed") === "not_discussed";
}
/* T1-8 — a move OUT of a terminal stage back into a live one is a REOPENING, not an ordinary move:
   it resurrects a case whose fee, completion date and retention setup were already settled. The
   protection gate can't see it (it only guards forward moves), so it needs its own classification
   on both the single-case path and the bulk path. */
const TERMINAL_STAGES = ["completed", "not_proceeding"];
function isReopening(fromStage, toStage) {
  return TERMINAL_STAGES.indexOf(fromStage) >= 0 && TERMINAL_STAGES.indexOf(toStage) < 0;
}
/* BUILD 7b — "Advance" stage stepper (defect 17). The next entry in STAGES, skipping nothing
   (exchange -> completed included). No next stage from the two terminal stages — deliberately
   no "back a stage" helper exists; regressions stay a considered act via the form <select>. */
function nextStageFor(stage) {
  if (stage === "completed" || stage === "not_proceeding") return null;
  const idx = stageIdx(stage);
  if (idx < 0 || idx >= STAGES.length - 1) return null;
  return STAGES[idx + 1][0];
}
function wireBoardDnD() {
  document.querySelectorAll("#board .card").forEach((el) => {
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", el.dataset.id); el.classList.add("dragging"); });
    el.addEventListener("dragend", () => el.classList.remove("dragging"));
  });
  document.querySelectorAll("#board .col").forEach((col) => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const caseId = e.dataTransfer.getData("text/plain");
      if (caseId) moveCaseToStage(caseId, col.dataset.stage);
    });
  });
}
/* A write refused because the column isn't there yet (Postgres 42703). Every round-5 column is
   additive and optional, so the app degrades to the pre-migration behaviour instead of failing. */
function isMissingColumnError(e) {
  return !!e && (e.code === "42703" || /column .*does not exist/i.test(e.message || ""));
}
/* B6 / M4 — duplicate_dismissals is a brand-new table (not just new columns), so an older database
   answers 42P01 (undefined_table) instead. Same feature-detect discipline as isMissingColumnError. */
function isMissingTableError(e) {
  return !!e && (e.code === "42P01" || /relation .* does not exist/i.test(e.message || ""));
}
/* R5-20 / B3 — a case does not simply "stop". Moving one to Not Proceeding now REQUIRES a reason
   from a fixed list (matching M2's cases_lost_reason_chk), with an optional note, so the losses
   panel in Reports can group them and the case history says what happened in words. Returns
   {reason, label, note} or null when the operator backs out — null aborts the move. */
const LOST_REASON_OPTIONS = [
  ["went_direct", "Went direct to the lender"],
  ["product_transfer_online", "Did a product transfer online"],
  ["another_broker", "Used another broker"],
  ["staying_put", "Staying put / not moving"],
  ["affordability", "Affordability / declined"],
  ["rate_price", "Rate or price"],
  ["valuation", "Valuation problem"],
  ["client_changed_mind", "Client changed their mind"],
  ["our_service", "Our service"],
  ["other", "Other"],
];
const LOST_REASON_LABEL = Object.fromEntries(LOST_REASON_OPTIONS);
function promptLostReason(whatMoves) {
  const html = `
    <h3>Why is it not proceeding?</h3>
    <p class="panel-sub">${esc(whatMoves)} — the reason is stored on the case and shown in the losses report. It is required.</p>
    <label>Reason
      <select id="lost-reason"><option value="">— choose a reason —</option>${LOST_REASON_OPTIONS.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("")}</select>
    </label>
    <label style="margin-top:10px;">Note (optional)
      <textarea id="lost-note" rows="3" placeholder="Anything worth knowing if they come back…"></textarea>
    </label>
    <div class="ovl-err" id="lost-err"></div>
    <div class="modal-actions">
      <div></div>
      <div class="right">
        <button type="button" class="btn" id="lost-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="lost-ok">Mark not proceeding</button>
      </div>
    </div>`;
  return openOverlay(html, (finish, box) => {
    box.querySelector("#lost-cancel").onclick = () => finish(null);
    box.querySelector("#lost-ok").onclick = () => {
      const sel = box.querySelector("#lost-reason");
      const reason = sel.value;
      if (!reason) { box.querySelector("#lost-err").textContent = "Choose a reason before continuing."; sel.focus(); return; }
      finish({ reason, label: LOST_REASON_LABEL[reason] || reason, note: (box.querySelector("#lost-note").value || "").trim() });
    };
  });
}
/* The case-history line every lost case gets, whether or not the columns exist yet. */
function lostReasonNoteBody(lost) {
  return `Not proceeding — ${lost.label}${lost.note ? ": " + lost.note : ""}`;
}
/* Move a case to a new stage. Shared by desktop drag-and-drop (the drop handler above)
   and the per-card "Move to stage" dropdown, which gives touch/mobile users — for whom
   HTML5 drag-and-drop does not fire — a working way to progress a case from the board. */
/* BUILD 7c — moveCaseToStage stays THE single stage-move path, but now takes an options bag so the
   bulk-move flow can route each case through it while suppressing per-row toasts/reloads and doing
   its own single confirm. Returns a status string ("moved" | "reopened" | "blocked" | "noop" |
   "cancelled" | "error") so the caller can tally results; single-call behaviour (toast + reload) is unchanged when
   no opts are passed. opts.cRow lets bulk pass a pre-fetched row to avoid a per-case round-trip. */
window.moveCaseToStage = async function (caseId, targetStage, opts = {}) {
  const { silent = false, skipReload = false, skipConfirm = false, cRow: preRow = null } = opts;
  if (!caseId || !targetStage) return "noop";
  let cRow = preRow;
  if (!cRow) {
    cRow = (await db.from("cases").select("stage,protection_status,completed_at,clients(first_name,last_name)").eq("id", caseId).single()).data;
  }
  if (cRow && cRow.stage === targetStage) return "noop"; // no-op (e.g. dropped back on the same column)
  if (cRow && protectionGateBlocks(cRow, targetStage)) {
    if (!silent) {
      toast("🛡️ Record the protection conversation before submitting — set a protection status");
      if (!skipReload) loadPipeline(); // put the card back
      /* R5-34 — the refusal used to be the end of it: a toast, the card snapped back, and the field
         that would unblock the move was three clicks away inside a collapsed drawer. Open the case
         ON the protection select so the block routes straight to its own fix. */
      await openCase(caseId, { revealProtection: true });
    }
    return "blocked";
  }
  const reopening = !!cRow && isReopening(cRow.stage, targetStage);
  const caseName = (cRow && cRow.clients ? [cRow.clients.first_name, cRow.clients.last_name].filter(Boolean).join(" ") : "") || "this case";
  /* R5-20 / B3 — Not Proceeding now costs a reason, not an OK. The bulk path asks once for the
     whole batch and passes it in (opts.lost); an interactive move asks here. Cancelling the
     capture aborts the move exactly as cancelling the old confirm did. */
  let lost = opts.lost || null;
  if (targetStage === "not_proceeding" && !skipConfirm) {
    lost = await promptLostReason(`Moving ${caseName} to Not Proceeding`);
    if (!lost) { if (!skipReload) loadPipeline(); return "cancelled"; }
  }
  if (!skipConfirm && (targetStage === "completed" || reopening)) {
    const nm = caseName;
    const msg = reopening
      // T1-8 — reopening a settled case had no confirm at all: dragging a Completed card back to a
      // live column silently undid its completion. Name what is being undone.
      ? `REOPEN ${nm}? It is currently ${STAGE_LABEL[cRow.stage] || cRow.stage} — moving it to ${STAGE_LABEL[targetStage] || targetStage} clears its completion date and puts it back in the live pipeline.`
      : targetStage === "completed"
      // T1-honestfix (defect 8) — nothing queues automatically on this move: no email_queue row,
      // no case_events note, no retention case. Checked against app.js and mock-supabase.js — the
      // only completion-related emails are the ones an adviser sends by hand from the case (fee
      // request, review request, rate-end reminder), and there is no code path anywhere that
      // creates a retention case. Say what actually happens, not what would be nice.
      ? `Move ${nm} to Completed? Nothing is sent or set up automatically — email the fee request, review request and rate-end reminder from the case yourself, and set a reminder for retention when the rate ends.`
      : "";
    if (msg && !confirm(msg)) { if (!skipReload) loadPipeline(); return "cancelled"; } // abort — snap the card back
  }
  // T1-7 — completed_at is the basis every completion report counts on, and nothing but the
  // importer ever wrote it. Stamp it on the way in, clear it on the way out.
  const patch = { stage: targetStage };
  if (targetStage === "completed") { if (!cRow || !cRow.completed_at) patch.completed_at = new Date().toISOString(); }
  else if (cRow && cRow.stage === "completed") patch.completed_at = null;
  if (lost && targetStage === "not_proceeding") { patch.lost_reason = lost.reason; patch.lost_detail = lost.note || null; }
  let { error } = await db.from("cases").update(patch).eq("id", caseId);
  // Feature-detect M2: an older database has no lost-reason columns — the move still happens and
  // the reason still reaches the case history as a note, it just isn't queryable yet.
  let lostColsMissing = false;
  if (error && lost && isMissingColumnError(error)) {
    lostColsMissing = true;
    delete patch.lost_reason; delete patch.lost_detail;
    ({ error } = await db.from("cases").update(patch).eq("id", caseId));
  }
  if (error) { if (!silent) toast("Error: " + error.message); return "error"; }
  if (lost) {
    const { error: nErr } = await db.from("case_notes")
      .insert({ case_id: caseId, body: lostReasonNoteBody(lost), created_by: (ME && ME.id) || null });
    if (nErr && !silent) toast("Case moved, but the reason note could not be saved: " + nErr.message);
  }
  if (!silent) {
    // If the case just left the focused segment its card vanishes from this view —
    // name the segment it landed in so nobody thinks the deal disappeared.
    let where = "";
    if (pipelineSegment !== "all" && !inSegment(targetStage, pipelineSegment)) {
      const segNames = { new: "New business", current: "Current", completed: "Completed & closed" };
      const destSeg = Object.keys(SEGMENT_STAGES).find((k) => SEGMENT_STAGES[k].includes(targetStage));
      if (destSeg) where = " — now in " + (segNames[destSeg] || destSeg);
    }
    toast("Moved to " + (STAGE_LABEL[targetStage] || targetStage) + where
      + (lostColsMissing ? " · reason kept as a note only (run migration M2)" : ""));
    if (!skipReload) loadPipeline();
  }
  return reopening ? "reopened" : "moved";
};
/* BUILD 7c — bulk stage move (pipeline table). One confirm summarising the whole batch, then each
   case routed through moveCaseToStage (silent, no reload).
   T1-8 — the rows are now fetched and pre-classified BEFORE the confirm, so the dialog states the
   real outcome of the batch rather than a bare count; every selected case lands in exactly one of
   four buckets so the result toast adds up to the selection size; and a batch that would resurrect
   settled cases needs the typed keyword (the confirmHardDelete pattern) rather than a plain OK. */
async function bulkMoveStage(targetStage) {
  const ids = [...pipeSel];
  if (!ids.length || !targetStage) return;
  const label = STAGE_LABEL[targetStage] || targetStage;
  const { data: rows } = await db.from("cases").select("id,stage,protection_status,completed_at,clients(first_name,last_name)").in("id", ids);
  const byId = {}; (rows || []).forEach((r) => (byId[r.id] = r));
  // Classify exactly the way moveCaseToStage will, so the confirm can't promise one thing and the
  // result report another.
  const plan = { move: 0, blocked: 0, already: 0, reopen: 0 };
  ids.forEach((id) => {
    const r = byId[id];
    if (r && r.stage === targetStage) plan.already++;
    else if (r && protectionGateBlocks(r, targetStage)) plan.blocked++;
    else if (r && isReopening(r.stage, targetStage)) plan.reopen++;
    else plan.move++;
  });
  /* R5-20 / B3 — one reason for the batch, captured BEFORE the confirm so the confirm can name it
     and nobody stamps ten cases with a reason they never saw. Backing out aborts the whole move. */
  let lost = null;
  if (targetStage === "not_proceeding" && plan.move) {
    lost = await promptLostReason(`Moving ${plan.move} case${plan.move === 1 ? "" : "s"} to Not Proceeding`);
    if (!lost) return;
  }
  const head = `Move ${ids.length} case${ids.length === 1 ? "" : "s"} to ${label}?\n\n` +
    `${plan.move} will move\n` +
    `${plan.blocked} are blocked (no protection status)\n` +
    `${plan.already} are already in ${label}\n` +
    `${plan.reopen} are Completed/Not Proceeding and will be REOPENED` +
    (lost ? `\n\nReason recorded on every case moved: ${lost.label}${lost.note ? " — " + lost.note : ""}\nTheir open tasks will be closed.` : "");
  if (plan.reopen) {
    const typed = prompt(
      `${head}\n\n` +
      "Reopening puts settled cases — completion dates, fees and retention — back into the live " +
      "pipeline, and there is no undo.\n\nType REOPEN to confirm:"
    );
    if (typed == null || typed.trim().toUpperCase() !== "REOPEN") return;
  } else if (!confirm(head)) return;
  let moved = 0, reopened = 0, blocked = 0, noop = 0, err = 0;
  const movedIds = [];
  for (const id of ids) {
    const res = await moveCaseToStage(id, targetStage, { silent: true, skipReload: true, skipConfirm: true, cRow: byId[id], lost });
    if (res === "moved") { moved++; movedIds.push(id); }
    else if (res === "reopened") reopened++;
    else if (res === "blocked") blocked++;
    else if (res === "error") err++;
    else noop++;
  }
  /* B3 — a closed case must not keep nagging. Production's cancel_retention_touches trigger closes
     the open tasks of a case that stops, so the bulk path does the same thing here and the two
     agree: the cases disappear from the board AND from everybody's task list. */
  let tasksClosed = 0;
  if (lost && movedIds.length) {
    const { data: closed, error: tErr } = await db.from("case_tasks")
      .update({ done_at: new Date().toISOString() }).in("case_id", movedIds).is("done_at", null).select("id");
    if (!tErr) tasksClosed = (closed || []).length;
  }
  // All four buckets, always: the old summary dropped the no-ops entirely, so the numbers never
  // added up to what was selected.
  let msg = `${moved} moved · ${reopened} reopened · ${blocked} blocked (protection) · ${noop} already in ${label}`;
  if (tasksClosed) msg += ` · ${tasksClosed} open task${tasksClosed === 1 ? "" : "s"} closed`;
  if (err) msg += ` · ${err} error${err === 1 ? "" : "s"}`;
  toast(msg);
  pipeSel.clear();
  loadPipeline();
}
/* BUILD 7c — bulk assign adviser (pipeline table). Sequential awaited updates with an error tally. */
async function bulkAssignCases(adviserId, reloadFn) {
  const ids = [...pipeSel];
  if (!ids.length || !adviserId) return;
  const name = adviserId === authUid ? "you" : staffName(adviserId);
  if (!confirm(`Assign ${ids.length} case${ids.length === 1 ? "" : "s"} to ${adviserId === authUid ? "yourself" : name}?`)) return;
  let ok = 0, err = 0;
  for (const id of ids) {
    const { error } = await db.from("cases").update({ assigned_to: adviserId }).eq("id", id);
    if (error) err++; else ok++;
  }
  let msg = `${ok} case${ok === 1 ? "" : "s"} assigned to ${name}`;
  if (err) msg += `, ${err} error${err === 1 ? "" : "s"}`;
  toast(msg);
  pipeSel.clear();
  (reloadFn || loadPipeline)();
}
/* ---------- R5 Batch 5 · S3a — bulk "Queue rate-end reminders" (pipeline table) ----------
   The rate-end sweep is the one job that is genuinely a batch: twenty clients whose fixed rate
   expires this quarter, one reminder each. Doing it case by case means twenty modal round-trips.
   Two rules make the bulk version safe:
     • QUEUED ONLY. This never calls runAutomation — R5-1's discipline says a send is a deliberate,
       scoped act, and "select 20 rows" is not a mandate to email 20 clients this instant. The rows
       sit in email_queue and go out on the next automation run (or a deliberate Send-all).
     • Every queued reminder leaves a follow-up task behind (R5-13, same title/date/assignee rule as
       the per-case queueEmail path), so a client who doesn't reply is still chased.
   Cases with no client email or no rate end date are named in the confirm and skipped, never
   half-written. */
/* G1I-D7 — every other round-5 action button guards itself against a second invocation while the
   first is still running (startRetentionCase, protQueueEmail, queueEmail, #run-now-btn,
   #deact-reassign); the two bulk-bar actions did not. A key-repeat on the focused button — two
   Enter presses — started two overlapping runs: both read the case list before either stamped, so
   the second confirmation was textually identical (no "⚠ already been reminded once" warning) and
   every selected client got TWO reminder emails and TWO chase tasks, while the single-slot toast
   showed only one summary. A real mouse double-click happened to be serialised by the blocking
   confirm(); the keyboard path was not. */
let bulkBusy = false;
function setBulkBusy(on) {
  bulkBusy = on;
  ["#pipe-bulk-rate", "#pipe-bulk-task", "#pipe-bulk-stage", "#pipe-bulk-adviser", "#pipe-bulk-clear"]
    .forEach((sel) => { const el = $(sel); if (el) el.disabled = on; });
}
async function bulkQueueRateReminders() {
  const ids = [...pipeSel];
  if (!ids.length) return;
  if (bulkBusy) return;
  setBulkBusy(true);
  try {
    await bulkQueueRateRemindersRun(ids);
  } finally { setBulkBusy(false); }
}
async function bulkQueueRateRemindersRun(ids) {
  const { data: rows, error } = await db.from("cases")
    .select("id,client_id,rate_end_date,assigned_to,rate_reminder_queued_at,clients(first_name,last_name,email)")
    .in("id", ids);
  if (error) return toast("Error: " + error.message);
  const nameOf = (c) => [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "this client";
  const eligible = [], skipped = [];
  (rows || []).forEach((c) => {
    if (!(c.clients && c.clients.email)) skipped.push(`${nameOf(c)} (no email)`);
    else if (!c.rate_end_date) skipped.push(`${nameOf(c)} (no rate-end date)`);
    else eligible.push(c);
  });
  if (!eligible.length) {
    return toast(skipped.length
      ? `Nothing to queue — ${skipped.length} selected case${skipped.length === 1 ? " has" : "s have"} no email or no rate-end date`
      : "Nothing to queue");
  }
  // Not a skip reason (the operator may deliberately be re-chasing), but they deserve to know
  // before they send a second reminder to the same client.
  const already = eligible.filter((c) => c.rate_reminder_queued_at);
  const chaseDue = localDateStr(Date.now() + 7 * 86400000);
  const confirmMsg = `Queue ${eligible.length} rate-end reminder${eligible.length === 1 ? "" : "s"}?`
    + (skipped.length ? ` (${skipped.length} skipped: no email/no rate-end date)` : "")
    + `\n\nThey send with the next automation run — nothing is sent now.`
    + `\nEach one also gets a follow-up task due ${fmtD(chaseDue)}.`
    + (skipped.length ? `\n\nSkipped: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""}` : "")
    + (already.length ? `\n\n⚠ ${already.length} of these ${already.length === 1 ? "has" : "have"} already been reminded once — they will be reminded again.` : "");
  if (!confirm(confirmMsg)) return;
  let queued = 0, tasks = 0, raced = 0;
  // G1I-B1/B3/B5 — every part of the promise this button made is now accounted for by name. The
  // old summary counted only the queue insert and the task insert, so a stamp that never landed
  // (case still reads "Reminder pending", still eligible for the same sweep, never warned about on
  // the next run) and a chase task that never existed both read as a clean success.
  const failedQueue = [], failedTask = [], failedStamp = [];
  for (const c of eligible) {
    /* G1I-D7 — read the stamp again immediately before writing. Two overlapping runs (or a second
       operator on the same list) both read `eligible` before either stamped anything; without this
       re-read the second run cheerfully queues a duplicate reminder to the same client. */
    const { data: fresh } = await db.from("cases").select("rate_reminder_queued_at").eq("id", c.id).single();
    if (fresh && fresh.rate_reminder_queued_at && !c.rate_reminder_queued_at) { raced++; continue; }
    const { error: qErr } = await db.from("email_queue").insert({
      case_id: c.id, client_id: c.client_id, email_type: "rate_end_reminder", to_email: c.clients.email,
    });
    if (qErr) { failedQueue.push(nameOf(c)); continue; }
    queued++;
    const { error: sErr } = await db.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", c.id);
    if (sErr) failedStamp.push(nameOf(c));
    const { error: tErr } = await db.from("case_tasks").insert({
      case_id: c.id,
      title: `Follow up rate-end reminder — ${(c.clients.first_name || "client").trim()}`,
      due_date: chaseDue,
      assigned_to: c.assigned_to || (ME && ME.id) || null,
      created_by: (ME && ME.id) || null,
    });
    if (tErr) failedTask.push(nameOf(c)); else tasks++;
  }
  const err = failedQueue.length + failedTask.length + failedStamp.length;
  const names = (list) => list.slice(0, 4).join(", ") + (list.length > 4 ? ` and ${list.length - 4} more` : "");
  const detail = [];
  if (failedQueue.length) detail.push(`no reminder was queued for ${names(failedQueue)}`);
  if (failedTask.length) detail.push(`the follow-up task failed for ${names(failedTask)} — nothing holds the next step`);
  if (failedStamp.length) detail.push(`${names(failedStamp)} could not be marked as reminded, so ${failedStamp.length === 1 ? "it still reads" : "they still read"} “Reminder pending” and will be offered again`);
  let msg = `${queued} reminder${queued === 1 ? "" : "s"} queued · ${tasks} follow-up task${tasks === 1 ? "" : "s"} · 0 sent`;
  if (skipped.length) msg += ` · ${skipped.length} skipped`;
  if (raced) msg += ` · ${raced} already reminded by another run`;
  if (err) msg += ` · ${err} error${err === 1 ? "" : "s"}: ${detail.join("; ")}`;
  toast(msg);
  // Leave anything that failed selected, so the retry is targeted instead of a re-run over the
  // whole selection (which would duplicate everything that did work).
  const stillSelected = [...new Set([...failedQueue, ...failedTask, ...failedStamp])];
  pipeSel.clear();
  if (stillSelected.length) eligible.forEach((c) => { if (stillSelected.includes(nameOf(c))) pipeSel.add(c.id); });
  loadPipeline();
}
/* ---------- R5 Batch 5 · S3b — bulk "Add task…" (pipeline table) ----------
   One title, one due date, one task per selected case — each landing on THAT case's adviser (not
   on whoever ran the batch), so a sweep of "chase the solicitor" tasks arrives in the right lists. */
function promptBulkTask(n) {
  const today = localDateStr(new Date());
  const html = `
    <h3>Add a task to ${n} case${n === 1 ? "" : "s"}</h3>
    <p class="panel-sub">One task per selected case. Each one is assigned to that case's adviser — or to you where the case has nobody on it.</p>
    <label>Task<input id="btask-title" type="text" placeholder="e.g. Chase the solicitor" maxlength="120"></label>
    <div class="due-chips" style="margin-top:10px;">
      <span class="due-chips-lbl">Due:</span>
      <button type="button" class="btn btn-sm btask-chip" data-days="0">Today</button>
      <button type="button" class="btn btn-sm btask-chip" data-days="3">+3 days</button>
      <button type="button" class="btn btn-sm btask-chip" data-days="7">+1 week</button>
    </div>
    <label style="margin-top:10px;">Date<input type="date" id="btask-due" value="${today}"></label>
    <div class="ovl-err" id="btask-err"></div>
    <div class="modal-actions">
      <div></div>
      <div class="right">
        <button type="button" class="btn" id="btask-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="btask-ok">Add ${n} task${n === 1 ? "" : "s"}</button>
      </div>
    </div>`;
  return openOverlay(html, (finish, box) => {
    const dateInput = box.querySelector("#btask-due");
    box.querySelectorAll(".btask-chip").forEach((b) => b.onclick = () => {
      const d = new Date();
      d.setDate(d.getDate() + Number(b.dataset.days || 0));
      dateInput.value = localDateStr(d);
    });
    box.querySelector("#btask-cancel").onclick = () => finish(null);
    box.querySelector("#btask-ok").onclick = () => {
      const title = (box.querySelector("#btask-title").value || "").trim();
      if (!title) { box.querySelector("#btask-err").textContent = "Give the task a title."; box.querySelector("#btask-title").focus(); return; }
      finish({ title, due: dateInput.value || null });
    };
  });
}
async function bulkAddTask() {
  const ids = [...pipeSel];
  if (!ids.length) return;
  if (bulkBusy) return;                       // G1I-D7 — same in-flight guard as the reminder sweep
  setBulkBusy(true);
  try { await bulkAddTaskRun(ids); } finally { setBulkBusy(false); }
}
async function bulkAddTaskRun(ids) {
  // G1I-B5 — the client's name is fetched so a failure can be NAMED. Reporting "1 error" over a
  // selection that is then cleared left the operator with no way to tell which of five clients
  // missed its task; the only recovery was to re-run over all five and create four duplicates.
  const { data: rows, error } = await db.from("cases").select("id,assigned_to,clients(first_name,last_name)").in("id", ids);
  if (error) return toast("Error: " + error.message);
  const nameOf = (c) => [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "an unnamed client";
  const picked = await promptBulkTask((rows || []).length || ids.length);
  if (!picked) return;
  let ok = 0;
  const failed = [];
  for (const c of rows || []) {
    const { error: tErr } = await db.from("case_tasks").insert({
      case_id: c.id, title: picked.title, due_date: picked.due,
      assigned_to: c.assigned_to || (ME && ME.id) || null,
      created_by: (ME && ME.id) || null,
    });
    if (tErr) failed.push({ id: c.id, name: nameOf(c) }); else ok++;
  }
  let msg = `${ok} task${ok === 1 ? "" : "s"} added (“${picked.title}”)${picked.due ? " · due " + fmtD(picked.due) : ""}`;
  if (failed.length) {
    const names = failed.slice(0, 4).map((f) => f.name).join(", ") + (failed.length > 4 ? ` and ${failed.length - 4} more` : "");
    msg += ` · ${failed.length} error${failed.length === 1 ? "" : "s"} — no task for ${names}; ${failed.length === 1 ? "that case is" : "those cases are"} still selected, so pressing Add task again retries only ${failed.length === 1 ? "it" : "them"}`;
  }
  toast(msg);
  pipeSel.clear();
  failed.forEach((f) => pipeSel.add(f.id));   // targeted retry, never a re-run over the whole set
  loadPipeline();
}
/* BUILD 5a — segmented focus control above the pipeline. Counts are live against the current
   adviser/search-filtered set, so each label reflects exactly what that segment would show. */
function renderSegmentControl(filtered) {
  const wrap = $("#pipe-segment");
  if (!wrap) return;
  const count = (seg) => filtered.filter((c) => inSegment(c.stage, seg)).length;
  wrap.innerHTML = SEGMENTS.map(([k, l]) =>
    `<button class="seg-btn${pipelineSegment === k ? " active" : ""}" role="tab" aria-selected="${pipelineSegment === k}" data-seg="${k}">${l} <span class="seg-count">${count(k)}</span></button>`
  ).join("");
  wrap.querySelectorAll(".seg-btn").forEach((b) => (b.onclick = () => setSegment(b.dataset.seg)));
  syncViewToggle();
}
// Switch focus segment. Entering Completed forces the table (its board is meaningless) and
// remembers the prior board/table choice; leaving Completed restores it. Segment change resets
// the stage tab (a tab from another segment would filter to nothing).
function setSegment(seg) {
  if (seg === pipelineSegment) return;
  const leavingCompleted = pipelineSegment === "completed" && seg !== "completed";
  const enteringCompleted = seg === "completed" && pipelineSegment !== "completed";
  if (enteringCompleted) { viewBeforeCompleted = pipelineView; pipelineView = "table"; }
  else if (leavingCompleted && viewBeforeCompleted) { pipelineView = viewBeforeCompleted; viewBeforeCompleted = null; }
  pipelineSegment = seg;
  stageTab = "all";
  if (authUid) lsSet(segStoreKey(authUid), seg);
  loadPipeline();
}
// BUILD 6c — jump straight to a pipeline segment from another page (e.g. the My Day completion-date
// chaser). Mirrors setSegment's leaving-Completed board/table restore, then switches page via nav().
window.gotoPipelineSegment = function (seg) {
  const leavingCompleted = pipelineSegment === "completed" && seg !== "completed";
  if (leavingCompleted && viewBeforeCompleted) { pipelineView = viewBeforeCompleted; viewBeforeCompleted = null; }
  pipelineSegment = seg;
  stageTab = "all";
  if (authUid) lsSet(segStoreKey(authUid), seg);
  nav("pipeline");
};
// Today KPI cards (defect 19) — jump each card to a sensible destination for that number, opening
// and scrolling to the relevant Today drawer where the number already lives on this same page.
function focusDashPanel(panelId, tab) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.classList.remove("collapsed");
  dashDrawerTouched[panelId.replace(/-panel$/, "")] = true;
  if (tab) { const tabBtn = panel.querySelector(`.dash-tab[data-tab="${tab}"]`); if (tabBtn) tabBtn.click(); }
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
window.kpiGoto = function (which) {
  if (which === "active") return gotoPipelineSegment("all");
  // T1-19 — "completions" is the Today tile (its number lives on Reports); "completed" is the
  // Reports tile, whose rows live in the pipeline's Completed segment.
  if (which === "completed") return gotoPipelineSegment("completed");
  if (which === "completions") return nav("reports");
  nav("dashboard");
  if (which === "rates" || which === "erc") return focusDashPanel("rate-erc-panel");
  if (which === "fees") return focusDashPanel("revenue-panel", "fees");
};
/* T1-19 — Reports rows become doors into the pipeline. Each helper sets exactly one of the two
   board filters and clears the other, so the pipeline that opens contains precisely the set the
   number described — and the filter is visible in the toolbar, so it can be seen and cleared. */
window.reportGotoAdviser = function (who) {
  const sel = $("#board-adviser"), q = $("#board-search");
  if (q) q.value = "";
  if (sel) sel.value = who;
  gotoPipelineSegment("all");
};
window.reportGotoSearch = function (term) {
  const sel = $("#board-adviser"), q = $("#board-search");
  if (sel) sel.value = "all";
  if (q) q.value = term == null ? "" : String(term);
  gotoPipelineSegment("all");
};
window.reportGotoStage = function (stage) {
  const sel = $("#board-adviser"), q = $("#board-search");
  if (sel) sel.value = "all";
  if (q) q.value = "";
  // A single stage is a table view (the board has no single-column mode); stage tabs live there.
  pipelineSegment = "all";
  pipelineView = "table";
  viewBeforeCompleted = null;
  stageTab = stage;
  // Segment persists (as it does from every other segment switch); the forced table view is
  // session-only — the saved board/table preference belongs to the view toggle, not to this click.
  if (authUid) lsSet(segStoreKey(authUid), "all");
  nav("pipeline");
};
// Keep the board/table toggle honest: hidden in Completed (locked to table), otherwise labelled
// for the view it would switch to.
function syncViewToggle() {
  const btn = $("#view-toggle");
  if (!btn) return;
  btn.style.display = pipelineSegment === "completed" ? "none" : "";
  btn.textContent = pipelineView === "board" ? "☰ Table view" : "⊞ Board view";
}
function renderPipelineTable(filtered, stageEntry = {}) {
  $("#board").classList.add("hidden");
  $("#board-hint").classList.add("hidden");
  $("#stage-tabs").classList.remove("hidden");
  $("#table-wrap").classList.remove("hidden");
  // Stage tabs are scoped to the active segment (segment narrows which stage tabs show).
  const segStages = segmentStageList(pipelineSegment);
  const segFiltered = filtered.filter((c) => inSegment(c.stage, pipelineSegment));
  const counts = {};
  segStages.forEach(([k]) => (counts[k] = segFiltered.filter((c) => c.stage === k).length));
  $("#stage-tabs").innerHTML = [`<button class="stage-tab ${stageTab === "all" ? "active" : ""}" data-stage="all">All (${segFiltered.length})</button>`]
    .concat(segStages.map(([k, l]) => `<button class="stage-tab ${stageTab === k ? "active" : ""}" data-stage="${k}"${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${l} (${counts[k]})</button>`)).join("");
  document.querySelectorAll(".stage-tab").forEach((b) => (b.onclick = () => { stageTab = b.dataset.stage; loadPipeline(); }));

  const completedMode = pipelineSegment === "completed";
  let rows = stageTab === "all" ? segFiltered : segFiltered.filter((c) => c.stage === stageTab);
  const val = (c, k) => {
    switch (k) {
      case "client": return [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ").toLowerCase();
      case "lender": return (c.lender || "").toLowerCase();
      case "rate_percent": return c.rate_percent ?? -1;
      case "broker_fee": return c.broker_fee ?? -1;
      case "loan_amount": return c.loan_amount ?? -1;
      case "assigned": return staffName(c.assigned_to).toLowerCase();
      case "days_in_stage": return daysSince(stageEntry[c.id]) ?? -1;
      default: return c[k] ?? "";
    }
  };
  // Completion-focused table: its own columns, defaulting to newest-completed first (falls back
  // to completed_at desc whenever the active sort key isn't one of its columns).
  const cols = completedMode
    ? [["client", "Client"], ["stage", "Status"], ["completed_at", "Completed"], ["lender", "Lender"], ["loan_amount", "Loan"], ["broker_fee", "Broker fee"], ["fee_status", "Fee status"], ["assigned", "Adviser"]]
    : [["client", "Client"], ["stage", "Stage"], ["days_in_stage", "In stage"], ["case_kind", "Type"], ["lender", "Lender"], ["rate_percent", "Rate"], ["rate_end_date", "Rate ends"], ["erc_end_date", "ERC ends"], ["broker_fee", "Fee"], ["fee_status", "Fee status"], ["protection_status", "Protection"], ["assigned", "Adviser"], ["updated_at", "Updated"]];
  let sk = sortKey, sd = sortDir;
  if (completedMode && !cols.some(([k]) => k === sortKey)) { sk = "completed_at"; sd = -1; }
  rows = rows.slice().sort((a, b) => { const x = val(a, sk), y = val(b, sk); return (x < y ? -1 : x > y ? 1 : 0) * sd; });

  // BUILD 7c — prune any bulk selection down to what's still visible in this filter/segment/tab, so
  // "select-all" and the action bar only ever act on the rows on screen.
  const rowIds = new Set(rows.map((c) => c.id));
  [...pipeSel].forEach((id) => { if (!rowIds.has(id)) pipeSel.delete(id); });
  const cbCell = (c) => `<td class="bulk-col" onclick="event.stopPropagation()"><input type="checkbox" class="bulk-cb" data-id="${c.id}" aria-label="Select this case"${pipeSel.has(c.id) ? " checked" : ""}></td>`;

  const bodyRows = completedMode
    ? rows.map((c) => `<tr onclick="openCase('${c.id}')" style="cursor:pointer;">
        ${cbCell(c)}
        <td class="stick-col"><strong>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</strong></td>
        <td><span class="badge ${c.stage === "completed" ? "green" : "grey"}">${STAGE_LABEL[c.stage] || c.stage}</span></td>
        <td>${c.completed_at ? fmtD(c.completed_at) : "—"}</td>
        <td>${lenderIcon(c.lender)}${esc(c.lender || "")}</td>
        <td>${c.loan_amount ? fmtM(c.loan_amount) : ""}</td>
        <td>${c.broker_fee ? fmtM(c.broker_fee) : ""}</td>
        <td>${esc((c.fee_status || "").replace(/_/g, " "))}</td>
        <td>${c.assigned_to ? esc(staffName(c.assigned_to)) : ""}</td>
      </tr>`).join("")
    : rows.map((c) => `<tr onclick="openCase('${c.id}')" style="cursor:pointer;">
        ${cbCell(c)}
        <td class="stick-col"><strong>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</strong></td>
        <td><span class="badge blue">${STAGE_LABEL[c.stage] || c.stage}</span></td>
        <td>${(() => { const a = cardAge(c, stageEntry[c.id]); return a.inStage == null ? "" : `<span class="age-cell${a.level ? " age-" + a.level : ""}" title="${esc(a.basis)}">${a.inStage}d</span>`; })()}</td>
        <td>${esc((KINDS.find((x) => x[0] === c.case_kind) || [])[1] || "")}</td>
        <td>${lenderIcon(c.lender)}${esc(c.lender || "")}</td>
        <td>${c.rate_percent != null ? c.rate_percent + "%" : ""}</td>
        <td>${c.rate_end_date ? fmtD(c.rate_end_date) + (c.rate_end_estimated ? " " + APPROX : "") : ""}</td>
        <td>${c.erc_end_date ? fmtD(c.erc_end_date) : ""}</td>
        <td>${c.broker_fee ? fmtM(c.broker_fee) : ""}</td>
        <td>${esc((c.fee_status || "").replace(/_/g, " "))}</td>
        <td>${esc((c.protection_status || "").replace(/_/g, " "))}</td>
        <td>${c.assigned_to ? esc(staffName(c.assigned_to)) : ""}</td>
        <td class="pipe-col-updated">${fmtD(c.updated_at)}</td>
      </tr>`).join("");
  $("#table-wrap").innerHTML = `
    <div class="bulk-bar" id="pipe-bulk-bar"${pipeSel.size ? "" : " hidden"}>
      <span class="bulk-bar-count"><strong id="pipe-bulk-n">${pipeSel.size}</strong> selected</span>
      <select id="pipe-bulk-stage" class="bulk-bar-select" aria-label="Move selected cases to stage">
        <option value="" selected>Move to stage…</option>
        ${STAGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <select id="pipe-bulk-adviser" class="bulk-bar-select" aria-label="Assign selected cases to adviser">${adviserOptionsHtml("Assign to…")}</select>
      <button type="button" class="btn btn-sm" id="pipe-bulk-rate" title="Queue a rate-end reminder for every selected case that has a client email and a rate end date. Nothing is sent now.">⏰ Queue rate-end reminders</button>
      <button type="button" class="btn btn-sm" id="pipe-bulk-task">＋ Add task…</button>
      <button type="button" class="btn btn-sm" id="pipe-bulk-clear">Clear</button>
    </div>
    <div class="board-scroll-wrap">
    <div class="panel" id="pipe-scroll" style="overflow-x:auto;">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-sm" id="csv-btn">⬇ Download CSV</button></div>
    ${rows.length ? `<table class="imp-table has-bulk" id="pipe-table">
      <tr><th class="bulk-col"><input type="checkbox" id="pipe-bulk-all" aria-label="Select all cases in this view"></th>${cols.map(([k, l]) => `<th data-k="${k}" class="${k === "client" ? "stick-col" : k === "updated_at" ? "pipe-col-updated" : ""}" style="cursor:pointer;"${k === "erc_end_date" ? ` title="${TIP_ERC}"` : ""}>${l}${sk === k ? (sd > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>
      ${bodyRows}
    </table>` : `<div class="empty" style="padding:40px 16px;text-align:center;">No cases in this view.</div>`}</div>
    <button type="button" class="board-scroll-arrow" aria-label="Scroll right" title="Scroll right">›</button>
    </div>`;
  wireTableHScroll("pipe-scroll");
  document.querySelectorAll("#pipe-table th[data-k]").forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    loadPipeline();
  }));
  // BUILD 7c — bulk-select wiring (checkboxes, select-all, action bar). No full reload on toggle —
  // the bar updates imperatively so scroll position and sort survive.
  document.querySelectorAll("#pipe-table .bulk-cb").forEach((cb) => (cb.onchange = () => {
    if (cb.checked) pipeSel.add(cb.dataset.id); else pipeSel.delete(cb.dataset.id);
    updatePipeBulkBar();
  }));
  const allCb = $("#pipe-bulk-all");
  if (allCb) allCb.onchange = () => {
    document.querySelectorAll("#pipe-table .bulk-cb").forEach((cb) => {
      cb.checked = allCb.checked;
      if (allCb.checked) pipeSel.add(cb.dataset.id); else pipeSel.delete(cb.dataset.id);
    });
    updatePipeBulkBar();
  };
  const clearBtn = $("#pipe-bulk-clear");
  if (clearBtn) clearBtn.onclick = () => {
    pipeSel.clear();
    document.querySelectorAll("#pipe-table .bulk-cb").forEach((cb) => (cb.checked = false));
    updatePipeBulkBar();
  };
  const stageSel = $("#pipe-bulk-stage");
  if (stageSel) stageSel.onchange = () => { const v = stageSel.value; stageSel.value = ""; if (v) bulkMoveStage(v); };
  const advSel = $("#pipe-bulk-adviser");
  if (advSel) advSel.onchange = () => { const v = advSel.value; advSel.value = ""; if (v) bulkAssignCases(v); };
  // S3a / S3b — the two bulk verbs a rate-end sweep actually needs.
  const rateBtn = $("#pipe-bulk-rate");
  if (rateBtn) rateBtn.onclick = () => bulkQueueRateReminders();
  const taskBtn = $("#pipe-bulk-task");
  if (taskBtn) taskBtn.onclick = () => bulkAddTask();
  updatePipeBulkBar();
  $("#csv-btn").onclick = () => exportCsv(rows, completedMode);
}
// BUILD 7c — reflect the current pipeline selection into the action bar (visibility + count) and the
// select-all checkbox's checked/indeterminate state, without re-rendering the table.
function updatePipeBulkBar() {
  const bar = $("#pipe-bulk-bar");
  if (!bar) return;
  const n = pipeSel.size;
  bar.hidden = n === 0;
  const nEl = $("#pipe-bulk-n"); if (nEl) nEl.textContent = n;
  const all = $("#pipe-bulk-all");
  if (all) {
    const boxes = [...document.querySelectorAll("#pipe-table .bulk-cb")];
    const checked = boxes.filter((b) => b.checked).length;
    all.checked = checked > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}
function exportCsv(rows, completedMode = false) {
  const q2 = (v) => {
    let s = String(v ?? "");
    // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at start)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  /* A firm-wide spreadsheet of every colleague's broker fee is the same figure the Today tile and
     the Reports page withhold from a non-Owner, so the column is dropped here rather than exported
     one click later. Presentation only — nothing stops a signed-in adviser reading broker_fee from
     the API; the fee on an individual case is still on the case.
     R5-F1 (Daniel-approved) — but an adviser exporting THEIR OWN book was being denied their own
     money, which is the same reversal as the My numbers card. csvShowsFee() keeps the column when
     every row in this export is the signed-in adviser's own case and drops it the moment a
     colleague's row is in view, so the scope decides, not the click. Owner and admin unchanged. */
  const money = csvShowsFee(rows);
  const head = (completedMode
    ? ["Client", "Status", "Completed", "Lender", "Loan", "Broker fee", "Fee status", "Adviser"]
    : ["Client", "Stage", "Type", "Lender", "Rate %", "Rate end", "Rate end estimated", "ERC end", "Broker fee", "Fee status", "Protection", "Adviser", "Updated"]
  ).filter((h) => money || h !== "Broker fee");
  const row = (c) => (completedMode ? [
    [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "),
    STAGE_LABEL[c.stage] || c.stage, (c.completed_at || "").slice(0, 10), c.lender || "",
    c.loan_amount ?? "", money ? c.broker_fee ?? "" : null, c.fee_status || "", c.assigned_to ? staffName(c.assigned_to) : "",
  ] : [
    [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "),
    STAGE_LABEL[c.stage] || c.stage, (KINDS.find((x) => x[0] === c.case_kind) || [])[1] || c.case_kind, c.lender || "", c.rate_percent ?? "", c.rate_end_date || "",
    c.rate_end_estimated ? "yes" : "", c.erc_end_date || "", money ? c.broker_fee ?? "" : null,
    c.fee_status || "", c.protection_status || "", c.assigned_to ? staffName(c.assigned_to) : "",
    (c.updated_at || "").slice(0, 10),
  ]).filter((v) => v !== null);
  const lines = [head.map(q2).join(",")].concat(rows.map((c) => row(c).map(q2).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pipeline-${pipelineSegment}-${stageTab}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
$("#report-month").addEventListener("change", () => loadReports());
$("#view-toggle").addEventListener("click", () => {
  if (pipelineSegment === "completed") return; // locked to table in Completed
  pipelineView = pipelineView === "board" ? "table" : "board";
  if (authUid) lsSet(viewStoreKey(authUid), pipelineView);
  syncViewToggle();
  loadPipeline();
});
$("#board-search").addEventListener("input", () => loadPipeline());
$("#board-adviser").addEventListener("change", () => loadPipeline());
$("#new-case-btn").addEventListener("click", () => openCase(null));
// Board horizontal-scroll affordance wiring (QW16).
(() => {
  const board = $("#board");
  if (board) board.addEventListener("scroll", updateBoardScrollHint, { passive: true });
  const arrow = document.querySelector(".board-scroll-arrow");
  if (arrow) arrow.addEventListener("click", () => $("#board").scrollBy({ left: 320, behavior: "smooth" }));
  window.addEventListener("resize", updateBoardScrollHint);
})();

/* ---------- Protection & GI page ---------- */
let protScope = "mine", protFilter = "all";
const PROT_BADGE = {
  not_discussed: ["grey", "NOT DISCUSSED"], discussed: ["blue", "DISCUSSED"], quoted: ["amber", "QUOTED"],
  policy_taken: ["green", "POLICY TAKEN"], declined: ["red", "DECLINED"],
};
const GI_BADGE = {
  not_discussed: ["grey", "GI not discussed"], quoted: ["amber", "GI quoted"], policy_taken: ["green", "GI taken"],
  declined: ["red", "GI declined"], not_applicable: ["grey", "GI n/a"],
};
// The settable protection statuses, shared by the per-row select and S3c's bulk bar so the two can
// never drift apart. (not_discussed is deliberately absent — nothing moves a case backwards here.)
const PROT_BULK_STATUS = [["discussed", "Discussed"], ["quoted", "Quoted"], ["policy_taken", "Policy taken"], ["declined", "Declined"]];
async function loadProtectionPage() {
  // T1-5: the RPC's "mine" scope also hands back every ownerless case, so "Mine" meant "mine plus
  // nobody's" for all three advisers at once. Fetch the whole book and apply the scope here, where
  // Mine / Unassigned / All are three distinct, honest sets.
  const { data, error } = await db.rpc("get_protection_pipeline", { p_scope: "all" });
  if (error) {
    $("#prot-table").innerHTML = `<div class="empty">Protection pipeline unavailable — ${esc(error.message)}</div>`;
    return;
  }
  const rows = (Array.isArray(data) ? data : []).filter((r) => {
    if (protScope === "mine" && r.owner !== (ME && ME.id)) return false;
    if (protScope === "unassigned" && r.owner != null) return false;
    return true;
  }).filter((r) => {
    if (protFilter === "live") return r.live;
    if (protFilter === "completed") return !r.live;
    if (protFilter === "quoted") return r.protection_status === "quoted";
    return true;
  });
  const estTotal = rows.reduce((s, r) => s + Number(r.est_commission || 0), 0);
  /* BACKEND-R4 §1 (owner's decision) — commission is money reporting, and money reporting is
     Owner-only IN THE UI. This page was the one that never asked: the RPC is called with scope
     "all", so "Est. commission" is the WHOLE firm's estimated protection commission and reads the
     same for an adviser as for the Owner, and the Est. £ column is that same money case by case.
     Same gate as Today and Reports, and the same caveat: THIS IS PRESENTATION, NOT A SECURITY
     CONTROL. get_protection_pipeline() still returns est_commission to any staff session and the
     cases table still carries protection_commission — anyone with the browser console can read
     what this hides. Opportunity counts, statuses and who each case sits with are unaffected. */
  const money = showMoney();
  const commTile = $("#prot-kpi-comm") ? $("#prot-kpi-comm").closest(".kpi") : null;
  if (commTile) commTile.classList.toggle("hidden", !money);
  const protNote = $("#prot-money-note");
  if (protNote) {
    protNote.classList.toggle("hidden", money);
    protNote.textContent = money ? "" : "Estimated commission is shown to the Owner only — the figure on this page is the whole firm's, not yours. Opportunity counts, protection and GI status and the adviser each case sits with are all below, and the commission on an individual case is on the case itself.";
  }
  $("#prot-kpi-count").textContent = rows.length;
  $("#prot-kpi-comm").textContent = money ? fmtM(estTotal) : "—";
  $("#prot-kpi-quoted").textContent = rows.filter((r) => r.protection_status === "quoted").length;
  /* S3c — bulk-select on this table. Same pattern as the pipeline's (BUILD 7c): the selection is
     pruned to what is actually on screen after every filter/scope change, so "6 selected" can only
     ever mean six rows the operator can see. */
  const protRowIds = new Set(rows.map((r) => r.case_id));
  [...protBulkSel].forEach((id) => { if (!protRowIds.has(id)) protBulkSel.delete(id); });
  const protCb = (r) => `<td class="bulk-col"><input type="checkbox" class="prot-cb bulk-cb" data-id="${r.case_id}" aria-label="Select this case"${protBulkSel.has(r.case_id) ? " checked" : ""}></td>`;
  $("#prot-table").innerHTML = rows.length ? `
    <div class="bulk-bar" id="prot-bulk-bar"${protBulkSel.size ? "" : " hidden"}>
      <span class="bulk-bar-count"><strong id="prot-bulk-n">${protBulkSel.size}</strong> selected</span>
      <select id="prot-bulk-status" class="bulk-bar-select" aria-label="Set protection status on selected cases">
        <option value="" selected>Set status →</option>
        ${PROT_BULK_STATUS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-sm" id="prot-bulk-clear">Clear</button>
    </div>
    <div class="board-scroll-wrap">
    <div class="panel prot-table-wrap" id="prot-scroll">
    <table class="imp-table has-bulk" id="prot-list-table">
      <tr><th class="bulk-col"><input type="checkbox" id="prot-bulk-all" aria-label="Select all cases in this view"></th><th>#</th><th class="stick-col">Client</th><th>Case</th><th class="prot-col-loan">Loan</th><th>Status</th>${money ? '<th class="prot-col-est">Est. £</th>' : ""}<th>Adviser</th><th class="stick-col-right">Actions</th></tr>
      ${rows.map((r, i) => {
        const kind = (KINDS.find((x) => x[0] === r.case_kind) || [])[1] || "";
        const p = PROT_BADGE[r.protection_status] || PROT_BADGE.not_discussed;
        const gi = ["purchase", "first_time_buyer"].includes(r.case_kind) ? (GI_BADGE[r.gi_status] || GI_BADGE.not_discussed) : null;
        return `<tr>
        ${protCb(r)}
        <td style="color:var(--muted);">${i + 1}</td>
        <td class="stick-col"><span class="prot-client" onclick="openClient('${r.client_id}')">${esc(r.client_name)}</span><span class="prot-fold-info">Loan ${fmtM(r.loan_amount)}${money ? " · Est. " + fmtM(r.est_commission) : ""}</span></td>
        <td><span class="badge blue">${STAGE_LABEL[r.stage] || esc(r.stage)}</span> ${esc(kind)}${r.lender ? " · " : " "}${lenderIcon(r.lender)}${esc(r.lender || "")}</td>
        <td class="prot-col-loan">${fmtM(r.loan_amount)}</td>
        <td><span class="badge ${p[0]}">${p[1]}</span>${gi ? ` <span class="badge ${gi[0]}" title="${TIP_GI}">${gi[1]}</span>` : ""}</td>
        ${money ? `<td class="prot-est prot-col-est">${fmtM(r.est_commission)}</td>` : ""}
        <td>${r.owner ? `<span class="chip" title="${esc(staffName(r.owner))}">${esc(initials(r.owner))}</span>` : '<span class="cs-muted">— unassigned —</span>'}</td>
        <td class="stick-col-right" style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="openCase('${r.case_id}')">Open</button>
          <select class="prot-status-set" onchange="setProtStatus('${r.case_id}', this.value)" title="Set protection status">
            <option value="">Set status…</option>
            ${PROT_BULK_STATUS.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>
          ${gi ? `<select class="prot-status-set" onchange="setGiStatus('${r.case_id}', this.value)" title="Set GI status">
            <option value="">Set GI…</option>
            ${[["quoted", "GI quoted"], ["policy_taken", "GI taken"], ["declined", "GI declined"], ["not_applicable", "GI n/a"]].map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>` : ""}
          <button class="btn btn-sm" onclick="protCallTask('${r.case_id}')">Task</button>
          ${r.has_email ? `<button class="btn btn-sm" onclick="protQueueEmail('${r.case_id}', event)">Email</button>` : '<span class="badge grey">no email</span>'}
        </td>
      </tr>`;
      }).join("")}
    </table>
    </div>
    <button type="button" class="board-scroll-arrow" aria-label="Scroll right" title="Scroll right">›</button>
  </div>` : '<div class="empty">No protection or GI opportunities in this view — nice clean book. 🛡️</div>';
  wireTableHScroll("prot-scroll");
  // S3c — bulk wiring. The bar updates imperatively (no re-render) so a long selection survives.
  document.querySelectorAll("#prot-list-table .prot-cb").forEach((cb) => (cb.onchange = () => {
    if (cb.checked) protBulkSel.add(cb.dataset.id); else protBulkSel.delete(cb.dataset.id);
    updateProtBulkBar();
  }));
  const protAll = $("#prot-bulk-all");
  if (protAll) protAll.onchange = () => {
    document.querySelectorAll("#prot-list-table .prot-cb").forEach((cb) => {
      cb.checked = protAll.checked;
      if (protAll.checked) protBulkSel.add(cb.dataset.id); else protBulkSel.delete(cb.dataset.id);
    });
    updateProtBulkBar();
  };
  const protClear = $("#prot-bulk-clear");
  if (protClear) protClear.onclick = () => {
    protBulkSel.clear();
    document.querySelectorAll("#prot-list-table .prot-cb").forEach((cb) => (cb.checked = false));
    updateProtBulkBar();
  };
  const protStatusSel = $("#prot-bulk-status");
  if (protStatusSel) protStatusSel.onchange = () => { const v = protStatusSel.value; protStatusSel.value = ""; if (v) bulkSetProtStatus(v); };
  updateProtBulkBar();
}
// S3c — mirror the current protection selection into its action bar (count + select-all state).
function updateProtBulkBar() {
  const bar = $("#prot-bulk-bar");
  if (!bar) return;
  const n = protBulkSel.size;
  bar.hidden = n === 0;
  const nEl = $("#prot-bulk-n"); if (nEl) nEl.textContent = n;
  const all = $("#prot-bulk-all");
  if (all) {
    const boxes = [...document.querySelectorAll("#prot-list-table .prot-cb")];
    const checked = boxes.filter((b) => b.checked).length;
    all.checked = checked > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }
}
/* S3c — set one protection status across the selection. Deliberately NOT setProtStatus in a loop:
   that one prompts for the actual commission on "Policy taken", and six sequential prompts (plus
   six full page reloads) is not a bulk action. The write itself is identical — the commission is
   left for the case, and the confirm says so. */
async function bulkSetProtStatus(status) {
  const ids = [...protBulkSel];
  if (!ids.length || !status) return;
  const label = (PROT_BULK_STATUS.find(([k]) => k === status) || [null, status])[1];
  const msg = `Set protection status to "${label}" on ${ids.length} case${ids.length === 1 ? "" : "s"}?`
    + (status === "policy_taken" ? "\n\nThe commission figure is not recorded in bulk — open each case to add it." : "");
  if (!confirm(msg)) return;
  let ok = 0, err = 0;
  for (const id of ids) {
    const { error } = await db.from("cases").update({ protection_status: status }).eq("id", id);
    if (error) err++; else ok++;
  }
  let out = `${ok} case${ok === 1 ? "" : "s"} set to ${label.toLowerCase()}`;
  if (err) out += ` · ${err} error${err === 1 ? "" : "s"}`;
  toast(out);
  protBulkSel.clear();
  loadProtectionPage();
}
window.setProtStatus = async function (caseId, status) {
  if (!status) return;
  const patch = { protection_status: status };
  if (status === "policy_taken") {
    const amt = prompt("Policy taken 🎉 — actual commission £ (leave blank to skip):");
    if (amt != null && amt.trim() !== "" && !isNaN(Number(amt))) patch.protection_commission = Number(amt);
  }
  const { error } = await db.from("cases").update(patch).eq("id", caseId);
  if (error) return toast("Error: " + error.message);
  toast("Protection status: " + status.replace(/_/g, " "));
  if (!$("#page-protection").classList.contains("hidden")) loadProtectionPage();
};
window.setGiStatus = async function (caseId, status) {
  if (!status) return;
  const { error } = await db.from("cases").update({ gi_status: status }).eq("id", caseId);
  if (error) return toast("Error: " + error.message);
  toast("GI status: " + status.replace(/_/g, " "));
  if (!$("#page-protection").classList.contains("hidden")) loadProtectionPage();
};
window.protCallTask = async function (caseId) {
  const { data: c } = await db.from("cases").select("assigned_to").eq("id", caseId).single();
  const due = localDateStr(Date.now() + 86400000);
  const { error } = await db.from("case_tasks").insert({
    case_id: caseId, title: "Protection call", due_date: due,
    created_by: (ME && ME.id) || null, assigned_to: (c && c.assigned_to) || (ME && ME.id) || null,
  });
  if (error) return toast("Error: " + error.message);
  toast("Protection call task added for tomorrow");
};
// T1-15 — takes `ev` explicitly (matching queueEmail/briefQueueEmail). The old version read the
// deprecated global `event`, so the double-click guard silently did nothing outside sloppy mode.
window.protQueueEmail = async function (caseId, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; } // guard against double-click double-insert
  try {
    const { data: c } = await db.from("cases").select("*").eq("id", caseId).single();
    if (!c) return toast("Could not load case");
    const { data: cl } = await db.from("clients").select("email").eq("id", c.client_id).single();
    if (!cl?.email) return toast("This client has no email address — add one first.");
    if (!confirm("Queue the protection intro email? Ensure the template has principal approval.")) return;
    const { data: qRow, error } = await db.from("email_queue")
      .insert({ case_id: caseId, client_id: c.client_id, email_type: "protection_offer", to_email: cl.email })
      .select("id").single();
    if (error) return toast("Error: " + error.message);
    // R5-1 — scoped to the row just inserted; this button can no longer flush the firm's queue.
    const res = qRow && qRow.id ? await runAutomation(true, { queueIds: [qRow.id] }) : null;
    sendResultToast(res, "Email queued — check Emails tab");
  } finally {
    if (btn) btn.disabled = false;
  }
};
// Client link token for a fact-find. Generated here so a brand-new fact-find always carries a
// usable token (defect #3: without this the copyable link renders "token=undefined" wherever the
// DB doesn't back-fill the column). An explicit value is harmless where a DB default also exists.
function ffToken() {
  return (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "ff-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
window.factFind = async function (caseId, clientId) {
  let { data: ff } = await db.from("fact_finds").select("*").eq("case_id", caseId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!ff) {
    const ins = await db.from("fact_finds").insert({ case_id: caseId, client_id: clientId, created_by: (ME && ME.id) || null, token: ffToken() }).select("*").single();
    if (ins.error) return toast("Error: " + ins.error.message);
    ff = ins.data;
  } else if (!ff.token) {
    // Legacy row created before tokens were set client-side — back-fill so the link works.
    const tok = ffToken();
    await db.from("fact_finds").update({ token: tok }).eq("id", ff.id);
    ff.token = tok;
  }
  const base = (settings.site_url || "https://nexmoney.co.uk").replace(/\/$/, "");
  const link = `${base}/factfind?token=${ff.token}`;
  const badge = { sent: "badge grey", started: "badge amber", submitted: "badge green" }[ff.status] || "badge grey";
  const hasData = ff.status === "submitted" && ff.data && Object.keys(ff.data).length;
  $("#modal").innerHTML = `
    <h3>Digital fact-find</h3>
    <p class="panel-sub">Send this secure link to the client. They fill it in on any device, can save as they go, and you get a task the moment they submit.</p>
    <div style="margin:10px 0;"><span class="${badge}">${esc(ff.status)}</span>${ff.submitted_at ? " · submitted " + fmtD(ff.submitted_at) : ""}</div>
    <label>Client link
      <div style="display:flex;gap:8px;">
        <input id="ff-link" readonly value="${esc(link)}" style="flex:1;">
        <button class="btn btn-sm" id="ff-copy">Copy</button>
      </div>
    </label>
    <div class="action-bar" style="margin-top:10px;">
      <button class="btn btn-sm" id="ff-mail">✉️ Open email to client</button>
      <button class="btn btn-sm" id="ff-refresh">↻ Refresh status</button>
      <button class="btn btn-sm" id="ff-new">New blank fact-find</button>
    </div>
    ${hasData ? `<div style="margin-top:16px;"><div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;"><h3 style="font-size:14px;margin:0;">Submitted responses</h3><button class="btn btn-sm btn-primary" id="ff-apply">➡️ Apply to case</button></div>${ffProtInterest(ff.data).interested ? '<p class="panel-sub" style="margin:6px 0 0;color:var(--green);font-weight:600;">💷 Protection interest flagged — capture the cross-sell when you apply.</p>' : ""}${renderFactFindData(ff.data)}</div>`
              : '<p class="panel-sub" style="margin-top:16px;">Responses will appear here once the client submits.</p>'}
    <div class="modal-actions"><div></div><div class="right"><button class="btn" id="ff-back">Back to case</button></div></div>`;
  openModal();
  $("#ff-copy").onclick = () => { const el = $("#ff-link"); el.select(); try { document.execCommand("copy"); } catch (e) {} if (navigator.clipboard) navigator.clipboard.writeText(el.value); toast("Link copied"); };
  $("#ff-back").onclick = () => openCase(caseId);
  if ($("#ff-apply")) $("#ff-apply").onclick = () => ffApplyDiff(caseId, clientId, ff.data);
  $("#ff-refresh").onclick = () => factFind(caseId, clientId);
  $("#ff-new").onclick = async () => { if (!confirm("Start a fresh blank fact-find? The current link stops being the active one.")) return; await db.from("fact_finds").insert({ case_id: caseId, client_id: clientId, created_by: (ME && ME.id) || null, token: ffToken() }); factFind(caseId, clientId); };
  $("#ff-mail").onclick = async () => {
    const { data: cl } = await db.from("clients").select("email,first_name").eq("id", clientId).single();
    if (!cl || !cl.email) return toast("This client has no email address on file — add one first.");
    const subj = encodeURIComponent(`${settings.company_name || "NexMoney"} — your quick mortgage fact-find`);
    const body = encodeURIComponent(`Hi ${(cl.first_name || "there").trim()},\n\nBefore we speak, please could you complete this short, secure fact-find? It takes about 5–10 minutes and you can save and come back to it:\n\n${link}\n\nThanks,\n${settings.adviser_name || settings.company_name || "NexMoney"}`);
    window.open(`mailto:${cl.email}?subject=${subj}&body=${body}`);
  };
};
function renderFactFindData(data) {
  return `<div class="ff-data">` + Object.keys(data).filter((k) => String(data[k] ?? "").trim() !== "")
    .map((k) => `<div class="ff-row"><span class="ff-k">${esc(prettyFF(k))}</span><span class="ff-v">${esc(data[k])}</span></div>`).join("") + `</div>`;
}
/* ---------- BUILD 4a: fact-find → case "Apply" ----------
   Maps digital fact-find answer keys (from factfind.html) onto the clients/cases columns
   app.js already writes. Only columns already touched elsewhere are used (no schema changes). */
const FF_MAP = [
  { t: "client", col: "first_name",    label: "First name",     ff: ["a1_first"] },
  { t: "client", col: "last_name",     label: "Last name",      ff: ["a1_last"] },
  { t: "client", col: "email",         label: "Email",          ff: ["email"] },
  { t: "client", col: "phone",         label: "Phone",          ff: ["phone"] },
  { t: "client", col: "date_of_birth", label: "Date of birth",  ff: ["a1_dob"] },
  { t: "client", col: "address",       label: "Address",        ff: ["a1_address", "a1_postcode"] },
  { t: "case",   col: "loan_amount",    label: "Loan amount",    ff: ["m_loan"],  num: true, money: true },
  { t: "case",   col: "property_value", label: "Property value", ff: ["m_value"], num: true, money: true },
  { t: "case",   col: "term_years",     label: "Term (years)",   ff: ["m_term"],  num: true },
];
// Protection cross-sell signal from the fact-find protection section (section 7 of factfind.html).
function ffProtInterest(d) {
  d = d || {};
  const reasons = [];
  if (String(d.p_review || "").toLowerCase() === "yes") reasons.push("Asked for a protection review");
  if (String(d.p_life || "").toLowerCase() === "no") reasons.push("No life cover in place");
  if (String(d.p_ip || "").toLowerCase() === "no") reasons.push("No income protection / critical illness cover");
  return { interested: reasons.length > 0, reasons };
}
window.ffApplyDiff = async function (caseId, clientId, data) {
  data = data || {};
  let cRow, clRow;
  try {
    const [rc, rcl] = await Promise.all([
      db.from("cases").select("*").eq("id", caseId).single(),
      db.from("clients").select("*").eq("id", clientId).single(),
    ]);
    cRow = rc.data; clRow = rcl.data;
  } catch (e) { return toast("Could not load case/client to apply"); }
  if (!cRow || !clRow) return toast("Could not load case/client to apply");

  const rows = [];
  FF_MAP.forEach((m, i) => {
    const ffRaw = m.ff.map((k) => String(data[k] == null ? "" : data[k]).trim()).filter(Boolean).join(", ");
    if (!ffRaw) return; // no fact-find answer to apply for this field
    const ffVal = m.num ? Number(String(ffRaw).replace(/[^0-9.]/g, "")) : ffRaw;
    if (m.num && !isFinite(ffVal)) return;
    const src = m.t === "client" ? clRow : cRow;
    const curRaw = src[m.col];
    const curEmpty = curRaw == null || String(curRaw).trim() === "";
    const equal = !curEmpty && (m.num ? Number(curRaw) === ffVal : String(curRaw).trim() === String(ffVal).trim());
    if (equal) return; // already matches — nothing to do
    const disp = (v) => (v === "" || v == null ? '<span class="cs-muted">— empty —</span>' : (m.money ? esc(fmtM(v)) : esc(v)));
    rows.push({
      idx: i, m, ffVal, conflict: !curEmpty, checked: curEmpty,
      curHtml: disp(curEmpty ? "" : curRaw), ffHtml: disp(m.num ? ffVal : ffRaw),
    });
  });

  const prot = ffProtInterest(data);
  const curProt = cRow.protection_status || "not_discussed";
  const protUpgradeable = prot.interested && curProt === "not_discussed";

  const tableRows = rows.map((r) => `
    <tr>
      <td style="padding:6px 8px;font-weight:600;">${esc(r.m.label)}<div class="cs-muted" style="font-weight:400;font-size:11px;">${r.m.t}</div></td>
      <td style="padding:6px 8px;">${r.curHtml}</td>
      <td style="padding:6px 8px;">${r.ffHtml}${r.conflict ? ' <span class="badge amber" style="margin-left:4px;">conflict</span>' : ""}</td>
      <td style="padding:6px 8px;text-align:center;"><input type="checkbox" id="ffchk-${r.idx}" ${r.checked ? "checked" : ""} style="width:auto;"></td>
    </tr>`).join("");

  const protBox = prot.interested ? `
    <div style="margin-top:14px;border:1px solid var(--green);background:rgba(23,114,69,.07);border-radius:10px;padding:12px;">
      <div style="font-weight:700;color:var(--green);">💷 Protection cross-sell opportunity</div>
      <ul style="margin:6px 0 8px;padding-left:18px;font-size:13px;">${prot.reasons.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
      <label class="row-check" style="display:flex;gap:8px;align-items:flex-start;font-size:13px;font-weight:600;">
        <input type="checkbox" id="ff-prot-chk" ${protUpgradeable ? "checked" : ""} style="width:auto;margin-top:2px;">
        Flag protection ${protUpgradeable ? "" : "(current: " + esc(curProt.replace(/_/g, " ")) + ") "}and create a follow-up task for the adviser
      </label>
    </div>` : "";

  $("#modal").innerHTML = `
    <h3>Apply fact-find to case</h3>
    <p class="panel-sub">Tick what to copy from the client's answers onto the case & client record. Empty fields are pre-ticked; values that would overwrite existing data start unticked.</p>
    ${rows.length ? `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;">
      <thead><tr style="text-align:left;border-bottom:1px solid var(--line);">
        <th style="padding:6px 8px;">Field</th><th style="padding:6px 8px;">Current</th><th style="padding:6px 8px;">Fact-find</th><th style="padding:6px 8px;text-align:center;">Apply</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>` : '<p class="panel-sub" style="margin-top:8px;">Every mapped field already matches the case — nothing to copy.</p>'}
    ${protBox}
    <div class="modal-actions">
      <div></div>
      <div class="right">
        <button class="btn" id="ff-apply-back">Back</button>
        <button class="btn btn-primary" id="ff-apply-confirm">Apply ticked fields</button>
      </div>
    </div>`;
  openModal();
  $("#ff-apply-back").onclick = () => factFind(caseId, clientId);
  $("#ff-apply-confirm").onclick = async () => {
    const btn = $("#ff-apply-confirm");
    if (btn) { if (btn.disabled) return; btn.disabled = true; }
    try {
      const clientUpd = {}, caseUpd = {};
      let n = 0;
      rows.forEach((r) => {
        const chk = $("#ffchk-" + r.idx);
        if (!chk || !chk.checked) return;
        (r.m.t === "client" ? clientUpd : caseUpd)[r.m.col] = r.ffVal;
        n++;
      });
      const protChk = $("#ff-prot-chk");
      const doProt = !!(protChk && protChk.checked);
      // Only upgrade protection_status from the default; never clobber a more advanced status.
      if (doProt && (cRow.protection_status || "not_discussed") === "not_discussed") caseUpd.protection_status = "discussed";
      if (!n && !doProt) { toast("Nothing ticked to apply"); return; }
      if (Object.keys(clientUpd).length) {
        const { error } = await db.from("clients").update(clientUpd).eq("id", clientId);
        if (error) { toast("Error: " + error.message); return; }
      }
      if (Object.keys(caseUpd).length) {
        const { error } = await db.from("cases").update(caseUpd).eq("id", caseId);
        if (error) { toast("Error: " + error.message); return; }
      }
      let uid = (ME && ME.id) || null;
      try { const { data: { user } } = await db.auth.getUser(); if (user && user.id) uid = user.id; } catch (e) {}
      let body = `Fact-find applied: ${n} field${n === 1 ? "" : "s"} updated`;
      if (doProt) body += " · protection interest flagged";
      let protTaskNote = "";
      if (doProt) {
        // Defect 11: don't stack a second protection follow-up on top of one that's already open —
        // check for an existing open task with the same "Protection:" title prefix on this case first.
        const { data: openTasks } = await db.from("case_tasks").select("id,title").eq("case_id", caseId).is("done_at", null);
        const existingProtTask = (openTasks || []).find((t) => (t.title || "").startsWith("Protection:"));
        if (existingProtTask) {
          protTaskNote = " · existing protection task kept";
        } else {
          // Due TODAY: a fresh cross-sell interest deserves a same-day call, and a
          // today-dated task surfaces immediately on the My Day hero list.
          const due = localDateStr(Date.now());
          await db.from("case_tasks").insert({
            case_id: caseId, title: "Protection: client expressed interest in fact-find", due_date: due,
            created_by: uid, assigned_to: cRow.assigned_to || uid,
          });
          protTaskNote = " · protection task created";
        }
      }
      await db.from("case_notes").insert({ case_id: caseId, body, created_by: uid });
      toast(`Applied ${n} field${n === 1 ? "" : "s"}${protTaskNote}`);
      openCase(caseId); // re-renders the case modal summary with the updated values, note & task
    } catch (e) {
      toast("Error applying fact-find: " + (e && e.message ? e.message : e));
    } finally {
      if (btn) btn.disabled = false;
    }
  };
};
// Fact-find key -> human label (defect 25, label half). Only strips a namespace prefix when it's
// one we actually recognise — an unrecognised first token (e.g. "has_a2") used to be silently
// treated as the namespace and dropped, leaking bare "A2 → yes" / "You: Dob" rows. Now anything
// outside the known namespaces falls through to a best-effort title-case of the whole key instead.
const FF_PREFIX = { a1: "Applicant 1", a2: "Applicant 2", m: "Mortgage", p: "Protection", c: "Commitments" };
function titleCaseWords(s) {
  return s.split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function prettyFF(k) {
  const parts = k.split("_");
  const pre = FF_PREFIX[parts[0]];
  if (pre) {
    const rest = parts.slice(1).join(" ");
    return rest ? `${pre}: ${titleCaseWords(rest)}` : pre;
  }
  // No recognised namespace — best-effort title-case of the whole key rather than guessing a prefix.
  return titleCaseWords(k);
}
function setProtScope(s) {
  protScope = s;
  $("#prot-scope-mine").classList.toggle("scope-active", s === "mine");
  $("#prot-scope-unassigned").classList.toggle("scope-active", s === "unassigned");
  $("#prot-scope-all").classList.toggle("scope-active", s === "all");
  loadProtectionPage();
}
$("#prot-scope-mine").addEventListener("click", () => setProtScope("mine"));
$("#prot-scope-unassigned").addEventListener("click", () => setProtScope("unassigned"));
$("#prot-scope-all").addEventListener("click", () => setProtScope("all"));
$("#prot-filter").addEventListener("change", () => { protFilter = $("#prot-filter").value; loadProtectionPage(); });
// Clicking the "Quoted, awaiting decision" tile filters the table to those rows (QW15).
$("#prot-tile-quoted").addEventListener("click", () => {
  protFilter = "quoted";
  $("#prot-filter").value = "quoted";
  loadProtectionPage();
});

/* ---------- Case modal ---------- */
/* R5-3 — the stale-write guard's baseline. It used to be a local of openCase, so every write the
   modal itself made (a queued email stamping the case, an offer parse) left the form holding a
   version string the database had already moved past — and the next Save was refused as somebody
   else's edit and, worse, silently reloaded over the operator's typing. Module scope so the writes
   that don't re-render can re-stamp it (refreshOpenedStamp) instead of poisoning the save. */
let openedUpdatedAt = null;
async function refreshOpenedStamp(caseId) {
  if (!caseId) return null;
  const { data } = await db.from("cases").select("updated_at").eq("id", caseId).single();
  if (data && data.updated_at) openedUpdatedAt = data.updated_at;
  return openedUpdatedAt;
}
/* opts: { revealProtection } opens the details drawer on a red-highlighted protection select
   (the protection gate's fix path, R5-34); { openDetails } just opens the drawer (offer apply). */
window.openCase = async function (id, opts = {}) {
  let c = { stage: "enquiry", case_kind: "remortgage", rate_type: "fixed" };
  let notes = [], tasks = [];
  let events = [], auditRows = [];
  let hasRetentionSuccessor = false;
  openedUpdatedAt = null;
  pendingOffer = null; // a re-render replaces the diff panel — don't leave a stale proposal armed
  if (id) {
    // BACKEND-R4 §2/§3 — the curated event log (log_case_event, with its actor) and the forensic
    // audit_log underneath it. Both soft-fail: a blocked table must not stop the case opening.
    const [{ data: cs }, { data: ns }, { data: ts }, evs, aud, succ] = await Promise.all([
      db.from("cases").select("*").eq("id", id).single(),
      db.from("case_notes").select("*").eq("case_id", id).order("created_at", { ascending: false }),
      db.from("case_tasks").select("*").eq("case_id", id).order("due_date"),
      softRows(db.from("case_events").select("event,detail,created_at,actor").eq("case_id", id).order("created_at", { ascending: false })),
      loadAuditRows("case_id", id),
      // R5-6 — does this case already have a retention successor? Decides the header button.
      softRows(db.from("cases").select("id").eq("retention_source_case_id", id).limit(1)),
    ]);
    if (!cs) return toast("Case not found — it may have been deleted or you don't have access");
    c = cs; notes = ns || []; tasks = ts || []; events = evs; auditRows = aud;
    hasRetentionSuccessor = (succ || []).length > 0;
    openedUpdatedAt = cs.updated_at; // exact string from the loaded row, for the stale-write guard
  }
  const [{ data: clients }, { data: intros }] = await Promise.all([
    db.from("clients").select("id,first_name,last_name,email,phone").order("last_name"),
    db.from("introducers").select("id,name").order("name"),
  ]);
  const caseClient = id ? (clients || []).find((cl) => cl.id === c.client_id) : null;
  const introOpts = (intros || []).map((i) =>
    `<option value="${i.id}" ${i.id === c.introducer_id ? "selected" : ""}>${esc(i.name)}</option>`).join("");
  const clientOpts = (clients || []).map((cl) =>
    `<option value="${cl.id}" ${cl.id === c.client_id ? "selected" : ""}>${esc([cl.last_name, cl.first_name].filter(Boolean).join(", "))}${cl.email ? "" : " (no email!)"}</option>`).join("");

  // ---- Summary-header data (existing cases only) — BUILD 2a ----
  const clientName = caseClient ? [caseClient.first_name, caseClient.last_name].filter(Boolean).join(" ") : "";
  const todayStr = localDateStr();
  const nextTask = tasks.find((t) => !t.done_at);           // tasks are due-date ordered → first open one
  const hadOpenTask = !!nextTask;
  const taskOverdue = nextTask && nextTask.due_date && nextTask.due_date < todayStr;
  const lastNote = notes[0];                                 // notes load newest-first
  const noteSnip = (b) => (b && b.length > 120 ? b.slice(0, 120) + "…" : (b || ""));
  const rateOverdue = c.rate_end_date && c.rate_end_date < todayStr;
  const rateSoon = c.rate_end_date && !rateOverdue && (new Date(c.rate_end_date) - new Date(todayStr)) < 183 * 86400000;
  const nextStage = id ? nextStageFor(c.stage) : null; // BUILD 7b — drives the modal's "Advance to…" button (hidden on terminal stages)
  const summaryHeader = id ? `
    <div class="case-summary">
      <div class="cs-top">
        <div class="cs-id">
          <div class="cs-name">${esc(clientName) || "Client"}</div>
          ${caseClient && (caseClient.phone || caseClient.email) ? `<div class="cs-contact">${caseClient.phone ? "📞 " + telLink(caseClient.phone) : ""}${caseClient.email ? "✉️ " + mailLink(caseClient.email) : ""}</div>` : ""}
        </div>
        <div class="cs-top-actions">
          ${/* R5-6 — only on a completed case with a tracked rate and no successor yet. The nightly
               RPC covers rates still ahead of us; this covers the ones that already ended. */ ""}
          ${c.stage === "completed" && c.rate_end_date && !hasRetentionSuccessor
            ? `<button type="button" class="btn btn-retention" id="cs-retention-btn" title="Create the follow-on case, the call task and a queued rate-end reminder">🔁 Start retention case</button>` : ""}
          <button type="button" class="btn btn-primary cs-logcall-btn" id="cs-logcall-btn">📞 Log call</button>
        </div>
      </div>
      <div class="cs-stats">
        <span class="badge blue">${esc(STAGE_LABEL[c.stage] || c.stage)}</span>
        ${nextStage ? `<button type="button" class="btn btn-sm cs-advance-btn" id="cs-advance-btn" title="Advance to ${esc(STAGE_LABEL[nextStage] || nextStage)}">Advance to ${esc(STAGE_LABEL[nextStage] || nextStage)} →</button>` : ""}
        <div class="cs-stat"><span class="cs-lbl">Adviser</span><span class="cs-val" id="cs-adviser-val">${c.assigned_to ? esc(staffName(c.assigned_to)) : '<span class="cs-muted">— unassigned —</span>'}</span></div>
        <div class="cs-stat"><span class="cs-lbl">Loan</span><span class="cs-val">${fmtM(c.loan_amount)}</span></div>
        <div class="cs-stat"><span class="cs-lbl">Property</span><span class="cs-val">${fmtM(c.property_value)}</span></div>
        ${c.lender ? `<div class="cs-stat"><span class="cs-lbl">Lender</span><span class="cs-val">${esc(c.lender)}</span></div>` : ""}
        ${c.broker_fee > 0 ? `<div class="cs-stat"><span class="cs-lbl">Fee</span><span class="cs-val">${fmtM(c.broker_fee)}${c.fee_status ? ` <span class="cs-muted">(${esc(String(c.fee_status).replace(/_/g, " "))})</span>` : ""}</span></div>` : ""}
        ${(c.protection_status || "not_discussed") === "not_discussed" ? '<div class="cs-stat cs-warn" id="cs-prot-warn"><span class="cs-lbl">Protection</span><span class="cs-val">not discussed</span></div>' : ""}
        ${c.rate_percent != null || c.rate_end_date ? `<div class="cs-stat ${rateOverdue ? "cs-danger" : rateSoon ? "cs-warn" : ""}"><span class="cs-lbl">Rate${rateOverdue ? " — ended" : rateSoon ? " — <6mo" : ""}</span><span class="cs-val">${c.rate_percent != null ? c.rate_percent + "%" : "—"}${c.rate_end_date ? ` · ends ${fmtD(c.rate_end_date)}` : ""}</span></div>` : ""}
        ${["offer", "exchange"].includes(c.stage) ? (c.expected_completion_date
          ? `<div class="cs-stat"><span class="cs-lbl">Expected completion</span><span class="cs-val">${fmtD(c.expected_completion_date)}</span></div>`
          : `<div class="cs-stat cs-warn" id="cs-expected-nudge" style="cursor:pointer;" title="Click to set the expected completion date"><span class="cs-lbl">Expected completion</span><span class="cs-val">Set expected completion →</span></div>`) : ""}
      </div>
      <div class="cs-lines">
        <div class="cs-line"><span class="cs-lbl">Next task</span><span id="cs-task-val">${nextTask ? `<span class="${taskOverdue ? "cs-danger-txt" : ""}">${esc(nextTask.title)}${nextTask.due_date ? " · " + (taskOverdue ? "overdue " : "due ") + fmtD(nextTask.due_date) : ""}</span>` : '<span class="cs-muted">none open</span>'}</span></div>
        <div class="cs-line"><span class="cs-lbl">Last note</span><span id="cs-note-val">${lastNote ? `${esc(noteSnip(lastNote.body))} <span class="cs-muted">· ${fmtAgo(lastNote.created_at)}</span>` : '<span class="cs-muted">no notes yet</span>'}</span></div>
      </div>
      <div class="cs-logcall-panel hidden" id="cs-logcall-panel">
        ${/* R5-49 — the four outcomes every call actually has, as chips that prefix the note (same
             pattern as the note-type chips below), so "no answer" costs one click instead of a
             sentence and the timeline reads consistently across advisers. */ ""}
        <div class="type-chips" id="cs-call-outcome-chips">
          <button type="button" class="tl-chip" data-outcome="No answer">No answer</button>
          <button type="button" class="tl-chip" data-outcome="Left voicemail">Left voicemail</button>
          <button type="button" class="tl-chip" data-outcome="Spoke — will call back">Spoke — will call back</button>
          <button type="button" class="tl-chip" data-outcome="Spoke — actioned">Spoke — actioned</button>
        </div>
        <label>Call outcome<textarea id="cs-call-note" rows="3" placeholder="What was discussed / agreed…"></textarea></label>
        ${/* R5-49 — protection gets discussed on the phone and then never recorded, which is what
             blocks the case at Application later. One tick here writes protection_status. */ ""}
        <label class="row-check" style="display:flex;gap:8px;align-items:center;font-size:13px;font-weight:600;color:var(--dark);margin-top:8px;">
          <input type="checkbox" id="cs-call-prot" style="width:auto;margin:0;" ${(c.protection_status || "not_discussed") === "not_discussed" ? "" : "checked disabled"}>
          Protection discussed${(c.protection_status || "not_discussed") === "not_discussed" ? "" : ` <span class="cs-muted" style="font-weight:400;">(already ${esc(String(c.protection_status).replace(/_/g, " "))})</span>`}
        </label>
        <label style="margin-top:8px;">Next follow-up (optional)</label>
        <div style="display:flex;gap:8px;margin-top:4px;">
          <input id="cs-call-fu-title" placeholder="Follow-up task…" style="flex:1;">
          <select id="cs-call-fu-assignee" aria-label="Assign follow-up to" title="Assign follow-up to" style="width:auto;">${TEAM.map((p) => `<option value="${p.id}" ${p.id === defaultAssignee(c.assigned_to) ? "selected" : ""}>${esc(staffName(p.id))}</option>`).join("")}</select>
          <input id="cs-call-fu-due" type="date" style="width:auto;">
        </div>
        <div class="due-chips" style="margin-top:8px;">
          <span class="due-chips-lbl">Follow-up:</span>
          <button type="button" class="btn btn-sm fu-chip" data-days="1">Tomorrow</button>
          <button type="button" class="btn btn-sm fu-chip" data-days="3">+3d</button>
          <button type="button" class="btn btn-sm fu-chip" data-days="7">+1wk</button>
          <button type="button" class="btn btn-sm fu-chip" data-months="1">+1mo</button>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">
          <button type="button" class="btn btn-sm" id="cs-call-cancel">Cancel</button>
          <button type="button" class="btn btn-sm btn-primary" id="cs-call-save">Save call</button>
        </div>
      </div>
    </div>` : "";

  $("#modal").innerHTML = `
    <h3>${id ? "Case" : "New case"}</h3>
    ${summaryHeader}
    ${c.retention_source_case_id ? `<p class="panel-sub" style="margin-top:-8px;">🔁 Retention opportunity — linked to a completed case. <span class="t" style="cursor:pointer;text-decoration:underline;" onclick="openCase('${c.retention_source_case_id}')">View original case</span></p>` : ""}
    ${c.nps_score != null ? `<p class="panel-sub" style="margin-top:-8px;">Client review score: <strong style="color:${c.nps_score >= 9 ? "var(--green)" : c.nps_score >= 7 ? "var(--amber)" : "var(--red)"};">${c.nps_score}/10</strong></p>` : ""}
    ${id ? `
    <div style="margin-top:14px;">
      <h3 style="font-size:14px;">Tasks</h3>
      <div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap;">
        <input id="new-task" placeholder="Add a task…" style="flex:1;min-width:140px;">
        <select id="new-task-assignee" aria-label="Assign task to" style="width:auto;" title="Assign task to">${TEAM.map((p) => `<option value="${p.id}" ${p.id === defaultAssignee(c.assigned_to) ? "selected" : ""}>${esc(staffName(p.id))}</option>`).join("")}</select>
        <input id="new-task-due" type="date" style="width:auto;">
        <button class="btn btn-sm" id="add-task-btn">Add</button>
      </div>
      <div class="due-chips">
        <span class="due-chips-lbl">Due:</span>
        <button type="button" class="btn btn-sm due-chip" data-days="1">Tomorrow</button>
        <button type="button" class="btn btn-sm due-chip" data-days="3">+3d</button>
        <button type="button" class="btn btn-sm due-chip" data-days="7">+1wk</button>
        <button type="button" class="btn btn-sm due-chip" data-months="1">+1mo</button>
      </div>
      <div id="tasks-inline">${tasks.map((t) => `
        <div class="row-item" style="padding:7px 4px;">
          <div class="row-main">
            <div style="${t.done_at ? "text-decoration:line-through;color:var(--muted);" : ""}">${esc(t.title)}</div>
            <div class="s">${t.due_date ? "due " + fmtD(t.due_date) : ""}${t.done_at ? " · done" : ""}</div>
          </div>
          ${t.done_at ? assigneeChipHtml(t.assigned_to) : taskAssigneeHtml(t.id, t.assigned_to, "")}${t.done_at ? "" : `<button class="btn btn-sm" aria-label="Mark task done" title="Mark task done" onclick="doneTaskInCase('${t.id}','${id}')">✓</button>`}
        </div>`).join("") || '<div class="empty">No tasks.</div>'}</div>
    </div>
    <div style="margin-top:14px;">
      <h3 style="font-size:14px;">Notes</h3>
      <div style="display:flex;gap:8px;margin:8px 0 0;">
        <input id="new-note" placeholder="Add a note…" style="flex:1;">
        <button class="btn btn-sm" id="add-note-btn">Add</button>
      </div>
      <div class="type-chips" id="note-type-chips">
        <button type="button" class="tl-chip active" data-type="note">📝 Note</button>
        <button type="button" class="tl-chip" data-type="call">📞 Call</button>
        <button type="button" class="tl-chip" data-type="email">✉️ Email</button>
        <button type="button" class="tl-chip" data-type="meeting">🤝 Meeting</button>
      </div>
      <div id="notes-list">${notes.map((n) => noteRowHtml(n.body, new Date(n.created_at).toLocaleString("en-GB"), n.created_by)).join("") || '<div class="empty">No notes yet.</div>'}</div>
    </div>
    ${/* BACKEND-R4 §2/§3 — what the database recorded, as opposed to what anyone typed. */ ""}
    <div style="margin-top:14px;" id="case-history">
      <h3 style="font-size:14px;">History</h3>
      <p class="panel-sub" style="margin:2px 0 6px;">Written by the database as the case progresses — stage changes, fee status, offer uploads, rate-end dates, protection status and reassignment, each with the person who made the change. Other field edits are in Change history below.</p>
      <div class="tl-list" id="case-events-list">${eventTimelineHtml(events)}</div>
      ${auditPanelHtml("case-audit", auditRows)}
    </div>
    <div class="action-bar">
      <button class="btn btn-sm" id="act-fee">💷 Email fee request</button>
      <button class="btn btn-sm" id="act-review">⭐ Email review request</button>
      <button class="btn btn-sm" id="act-reminder">📅 Email rate-end reminder</button>
      <button class="btn btn-sm" id="act-paid">✓ Mark fee paid</button>
      <button class="btn btn-sm" id="act-offer">📄 Read mortgage offer (AI)</button>
      <input type="file" id="offer-file" accept="application/pdf" class="hidden">
      ${c.offer_doc_path ? '<button class="btn btn-sm" id="act-view-offer">View offer doc</button>' : ""}
      <button class="btn btn-sm" id="act-evidence">🗂 Evidence pack</button>
      <button class="btn btn-sm" id="act-appt">📅 Book appointment</button>
      <button class="btn btn-sm" id="act-factfind">📋 Digital fact-find</button>
    </div>
    ${/* R5-4 — where a parsed mortgage offer PROPOSES its readings (Current vs Incoming, ticked
         field by field) instead of writing them behind the operator's back. Empty until a parse. */ ""}
    <div id="offer-diff" class="offer-diff hidden"></div>` : ""}
    <details class="case-details" ${id ? "" : "open"}>
      <summary>Case details</summary>
      <form id="case-form" class="form-grid" data-case-id="${id || ""}">
      <label class="full">Client
        <select name="client_id" id="case-client-select" required><option value="">— select client —</option>${clientOpts}<option value="__new__">+ New client…</option></select>
      </label>
      <div class="full hidden" id="nc-new-client-fields" style="display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;padding:10px 12px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;margin:-4px 0 4px;">
        <label>First name<input name="nc_first_name" placeholder="First name"></label>
        <label>Last name<input name="nc_last_name" placeholder="Last name"></label>
        <label>Email<input name="nc_email" type="email" placeholder="Email"></label>
        <label>Phone<input name="nc_phone" placeholder="Phone"></label>
      </div>
      <label>Type<select name="case_kind">${KINDS.map(([k, l]) => `<option value="${k}" ${k === c.case_kind ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Stage<select name="stage">${STAGES.map(([k, l]) => `<option value="${k}" ${k === c.stage ? "selected" : ""}${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${l}</option>`).join("")}</select></label>
      <label>Lender<input name="lender" value="${esc(c.lender)}"></label>
      <label>Product<input name="product_name" value="${esc(c.product_name)}"></label>
      <label>Loan amount (£)<input name="loan_amount" type="number" step="any" value="${c.loan_amount ?? ""}"></label>
      <label>Property value (£)<input name="property_value" type="number" step="any" value="${c.property_value ?? ""}"></label>
      <label>Rate %<input name="rate_percent" type="number" step="any" value="${c.rate_percent ?? ""}"></label>
      <label>Rate type<select name="rate_type">${["fixed", "tracker", "variable", "discount"].map((t) => `<option ${t === c.rate_type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>Rate end date<input name="rate_end_date" type="date" value="${c.rate_end_date ?? ""}">
        <span style="display:flex;align-items:center;gap:5px;margin-top:4px;${c.rate_end_estimated ? "color:#6b21a8;font-weight:600;" : ""}"><input type="checkbox" name="rate_end_estimated" style="width:auto;margin:0;" ${c.rate_end_estimated ? "checked" : ""}> estimated — needs checking</span>
      </label>
      <label>ERC end date<input name="erc_end_date" type="date" value="${c.erc_end_date ?? ""}"></label>
      <label>Offer expiry date<input name="offer_expiry_date" type="date" value="${c.offer_expiry_date ?? ""}"></label>
      <label>Expected completion date<input name="expected_completion_date" type="date" id="case-expected-completion" value="${c.expected_completion_date ?? ""}"></label>
      <label>Term (years)<input name="term_years" type="number" value="${c.term_years ?? ""}"></label>
      <label>Submitted date<input name="submitted_at" type="date" value="${c.submitted_at ?? ""}"></label>
      <label>Proc fee (£)<input name="proc_fee" type="number" step="any" value="${c.proc_fee ?? ""}"></label>
      <label>Sols fee (£)<input name="sols_fee" type="number" step="any" value="${c.sols_fee ?? ""}"></label>
      <label>Broker fee (£)<input name="broker_fee" type="number" step="any" value="${c.broker_fee ?? ""}"></label>
      <label>Fee status<select name="fee_status">${["not_requested", "requested", "paid", "waived"].map((f) => `<option value="${f}" ${f === c.fee_status ? "selected" : ""}>${f.replace("_", " ")}</option>`).join("")}</select></label>
      ${/* R5-12 / B7 — what was banked, and WHEN, per fee type. Read-only: the dates are captured by
           "Mark fee paid" (which validates them) rather than typed into a form that never checked.
           Absent entirely on a pre-M2 database, where the columns don't exist. */ ""}
      ${feePaidDatesHtml(c)}
      <label>Protection<select name="protection_status">${[["not_discussed","Not discussed"],["discussed","Discussed"],["quoted","Quoted"],["policy_taken","Policy taken"],["declined","Client declined"]].map(([k,l]) => `<option value="${k}" ${k === (c.protection_status || "not_discussed") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Protection commission (£)<input name="protection_commission" type="number" step="any" value="${c.protection_commission ?? ""}"></label>
      <label id="gi-status-label" ${["purchase","first_time_buyer"].includes(c.case_kind) ? "" : 'class="hidden"'}>GI / buildings insurance<select name="gi_status">${[["not_discussed","Not discussed"],["quoted","Quoted"],["policy_taken","Policy taken"],["declined","Declined"],["not_applicable","Not applicable"]].map(([k,l]) => `<option value="${k}" ${k === (c.gi_status || "not_discussed") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Lead source<input name="lead_source" value="${esc(c.lead_source)}" placeholder="e.g. Google, referral, repeat"></label>
      <label>Introducer<select name="introducer_id"><option value="">— none —</option>${introOpts}</select></label>
      ${/* R5-36 — a new case starts on ME, not on nobody: unassigned cases were being created by the
           dozen and only surfaced later in Data Health. An existing case keeps whatever it has. */ ""}
      <label>Assigned to<select name="assigned_to"><option value="">— unassigned —</option>${assigneeOptionsHtml(id ? c.assigned_to : defaultAssignee((ME && ME.id) || null))}</select></label>
    </form>
    </details>
    <div class="modal-actions">
      ${/* BACKEND-R4 §1 — deleting a case is Owner/Administrator only and RLS enforces it; an
            adviser is simply never offered the button rather than shown a refusal. */ ""}
      <div>${id && isAdminOrOwner() ? '<button class="btn btn-ghost btn-danger" id="del-case-btn">Delete case</button>' : ""}</div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  pushModalHistory("case", id); // BUILD 7a — Back closes this modal; reloads replace (no dup entry)
  if (id) wireAuditPanel("case-audit", auditRows);

  const kindSel = $("#case-form").elements.case_kind;
  kindSel.onchange = () => $("#gi-status-label").classList.toggle("hidden", !["purchase", "first_time_buyer"].includes(kindSel.value));
  const clientSel = $("#case-client-select");
  clientSel.onchange = () => $("#nc-new-client-fields").classList.toggle("hidden", clientSel.value !== "__new__");
  $("#modal-cancel").onclick = closeModalGuarded; // defect 2 — Cancel is a "leave" path: it must warn about unsaved edits too
  $("#modal-save").onclick = async () => {
    // T1-15 — in-flight guard: a 0ms double-click on Save wrote the case twice.
    const saveBtn = $("#modal-save");
    if (saveBtn.disabled) return;
    saveBtn.disabled = true;
    try {
      const f = new FormData($("#case-form"));
      const row = {};
      for (const [k, v] of f.entries()) row[k] = v === "" ? null : v;
      row.rate_end_estimated = f.get("rate_end_estimated") === "on";
      // Inline "+ New client…" (Priya's fact-find pack): create the client here, in the same
      // form flow — no nested modal — then point the case at its new id and carry on as normal.
      const ncFirst = row.nc_first_name, ncLast = row.nc_last_name, ncEmail = row.nc_email, ncPhone = row.nc_phone;
      delete row.nc_first_name; delete row.nc_last_name; delete row.nc_email; delete row.nc_phone;
      if (row.client_id === "__new__") {
        if (!ncFirst && !ncLast) return toast("Enter the new client's name");
        const { data: newClient, error: ncErr } = await db.from("clients")
          .insert({ first_name: ncFirst || "", last_name: ncLast || "", email: ncEmail || null, phone: ncPhone || null })
          .select().single();
        if (ncErr) return toast("Error creating client: " + ncErr.message);
        row.client_id = newClient.id;
      }
      if (!row.client_id) return toast("Please choose a client");
      if (id && row.stage !== c.stage && protectionGateBlocks({ stage: c.stage, protection_status: row.protection_status }, row.stage)) {
        toast("🛡️ Record the protection conversation before submitting — set a protection status");
        const det = $(".case-details"); if (det) det.open = true; // the field is inside the collapsible section — reveal it
        const protSel = $("#case-form").elements.protection_status;
        if (protSel) { protSel.style.borderColor = "var(--red)"; protSel.style.boxShadow = "0 0 0 3px rgba(192,57,43,.18)"; protSel.focus(); }
        return;
      }
      /* R5-15 — dates nobody sanity-checked. An expected completion in the past on a live case is
         almost always a typo or a date that quietly slipped, and an expected completion long after
         the offer expires is a deal that cannot complete as planned. Warn, don't refuse: both are
         legitimate occasionally, so the operator decides — and Cancel keeps them in the form. */
      const liveStage = row.stage !== "completed" && row.stage !== "not_proceeding";
      const ecd = row.expected_completion_date;
      if (ecd && liveStage) {
        const today = localDateStr();
        if (ecd < today && !confirm(`Expected completion ${fmtD(ecd)} is in the past — save anyway?`)) return;
        const oed = row.offer_expiry_date;
        if (oed && (new Date(ecd) - new Date(oed)) > 30 * 86400000
          && !confirm(`Expected completion ${fmtD(ecd)} is more than 30 days after the offer expires (${fmtD(oed)}) — the offer would need extending or re-issuing. Save anyway?`)) return;
      }
      /* R5-20 / B3 — the stage select is the other route to Not Proceeding, and it used to take it
         with no questions asked. Same required reason as the board move. */
      let lost = null;
      if (id && row.stage === "not_proceeding" && c.stage !== "not_proceeding") {
        lost = await promptLostReason("Saving this case as Not Proceeding");
        if (!lost) return; // capture cancelled — the form stays exactly as it is
        row.lost_reason = lost.reason;
        row.lost_detail = lost.note || null;
      }
      // T1-7 — the stage <select> is the other way a case reaches Completed, and it wrote the stage
      // without the completion date every report counts on. Stamp on the way in, clear on the way out.
      if (row.stage === "completed") { if (!id || !c.completed_at) row.completed_at = new Date().toISOString(); }
      else if (id && c.stage === "completed") row.completed_at = null;
      ["loan_amount", "property_value", "rate_percent", "term_years", "broker_fee", "proc_fee", "sols_fee", "protection_commission"].forEach((k) => { if (row[k] != null) row[k] = Number(row[k]); });
      if (id) {
        // Optimistic concurrency: only update if the row hasn't changed since we opened it.
        let { data: updated, error } = await db.from("cases").update(row).eq("id", id).eq("updated_at", openedUpdatedAt).select();
        // Feature-detect M2 — an older database has no lost-reason columns; the save still lands and
        // the reason still reaches the case history as a note.
        let lostColsMissing = false;
        if (error && lost && isMissingColumnError(error)) {
          lostColsMissing = true;
          delete row.lost_reason; delete row.lost_detail;
          ({ data: updated, error } = await db.from("cases").update(row).eq("id", id).eq("updated_at", openedUpdatedAt).select());
        }
        if (error) return toast("Error: " + error.message);
        if (!updated || updated.length === 0) {
          /* R5-3 — this used to reload the case over the operator's typing: minutes of work gone,
             and usually to a "conflict" the modal itself had caused. Nothing is discarded without
             being asked, and the choice says plainly what each answer costs. */
          const reload = confirm(
            "This case was changed elsewhere since you opened it.\n\n" +
            "OK = reload the case (DISCARDS the edits you have on screen)\n" +
            "Cancel = keep editing (your values stay; Save again to overwrite the other change)"
          );
          loadPipeline(); loadDashboard();
          if (reload) { openCase(id); return; }
          // Kept editing: re-baseline on the current row so the next Save is a deliberate overwrite
          // rather than an unwinnable loop against the same conflict.
          await refreshOpenedStamp(id);
          toast("Your edits are still here — press Save again to overwrite the other change");
          return;
        }
        if (lost) {
          const { error: nErr } = await db.from("case_notes")
            .insert({ case_id: id, body: lostReasonNoteBody(lost), created_by: (ME && ME.id) || null });
          if (nErr) toast("Case saved, but the reason note could not be written: " + nErr.message);
        }
        closeModal();
        toast("Case saved" + (lostColsMissing ? " · reason kept as a note only (run migration M2)" : ""));
        loadPipeline(); loadDashboard();
        // Same guard as the client-save path (2379): a case-level fix (assign adviser, add fee) is
        // exactly what Data Health flags, so refresh it if that page is the one behind the modal.
        if ($("#page-data") && !$("#page-data").classList.contains("hidden")) loadDataHealth();
      } else {
        const { error } = await db.from("cases").insert(row);
        if (error) return toast("Error: " + error.message);
        closeModal(); toast("Case saved");
        loadPipeline(); loadDashboard();
        if ($("#page-data") && !$("#page-data").classList.contains("hidden")) loadDataHealth();
      }
    } finally { saveBtn.disabled = false; }
  };
  if (id) {
    const delCaseBtn = $("#del-case-btn"); // absent for an adviser — see the modal-actions block above
    if (delCaseBtn) delCaseBtn.onclick = async () => {
      const extra = c.stage === "completed" ? "⚠ This case is COMPLETED — deleting removes its fee/commission history from your records." : null;
      if (!confirmHardDelete("Delete this case?", extra)) return;
      const { error } = await db.from("cases").delete().eq("id", id);
      if (error) return toast("Error: " + error.message);
      closeModal(); toast("Case deleted"); loadPipeline(); loadDashboard();
    };
    const submitNote = async () => {
      const input = $("#new-note");
      const raw = input.value.trim();
      if (!raw) return;
      // T1-15 — in-flight guard: double-clicking Add duplicated the note in the compliance timeline.
      const noteBtn = $("#add-note-btn");
      if (noteBtn.disabled) return;
      noteBtn.disabled = true;
      try {
        // Typed-note prefix (SP3a): the active chip prefixes the saved body, exactly matching Log call.
        const typeBtn = $("#note-type-chips .tl-chip.active");
        const body = (NOTE_PREFIX[(typeBtn && typeBtn.dataset.type) || "note"] || "") + raw;
        const { data: { user } } = await db.auth.getUser();
        const { error } = await db.from("case_notes").insert({ case_id: id, body, created_by: user.id });
        if (error) return toast("Error: " + error.message);
        // In-place append (no full modal re-render / scroll reset): prepend to match the newest-first load order.
        const list = $("#notes-list");
        const empty = list.querySelector(".empty");
        if (empty) empty.remove();
        const wrap = document.createElement("div");
        wrap.innerHTML = noteRowHtml(body, new Date().toLocaleString("en-GB"), user.id);
        list.insertBefore(wrap.firstChild, list.firstChild);
        input.value = "";
        input.focus();
      } finally { noteBtn.disabled = false; }
    };
    $("#add-note-btn").onclick = submitNote;
    $("#new-note").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitNote(); } });
    // Note type chips: single-select, default Note (SP3a).
    $("#note-type-chips").querySelectorAll(".tl-chip").forEach((b) => b.onclick = () => {
      const cur = $("#note-type-chips .tl-chip.active"); if (cur) cur.classList.remove("active");
      b.classList.add("active");
      const inp = $("#new-note"); if (inp) inp.focus();
    });
    // Re-open on success so the fee badge and Fee status select show the "requested" the send just
    // wrote — the same refresh "Mark fee paid" below already does. queueEmail returns true only
    // when an email was actually queued (every guard and the confirm cancel return undefined).
    $("#act-fee").onclick = async (e) => { if (await queueEmail(id, c.client_id, "fee_request", c, e)) openCase(id); };
    /* R5-3 — these two stamp the case row (review_requested_at / rate_reminder_queued_at) but leave
       the modal standing, so the version string the form opened on is now a version behind. Re-read
       it, or the operator's very next Save is refused as "somebody else changed this". */
    $("#act-review").onclick = async (e) => { if (await queueEmail(id, c.client_id, "review_request", c, e)) await refreshOpenedStamp(id); };
    $("#act-reminder").onclick = async (e) => { if (await queueEmail(id, c.client_id, "rate_end_reminder", c, e)) await refreshOpenedStamp(id); };
    $("#act-paid").onclick = () => markFeePaid(id, c);
    const submitTask = async () => {
      const input = $("#new-task");
      const title = input.value.trim();
      if (!title) return;
      // T1-15 — in-flight guard: double-clicking Add wrote the task twice.
      const taskBtn = $("#add-task-btn");
      if (taskBtn.disabled) return;
      taskBtn.disabled = true;
      try {
        const due = $("#new-task-due").value || null;
        const { data: { user } } = await db.auth.getUser();
        // Assignee from the quick-add select (defaults to the case adviser); falls back to me.
        const asgSel = $("#new-task-assignee");
        const assignee = (asgSel && asgSel.value) || user.id;
        const { data: inserted, error } = await db.from("case_tasks")
          .insert({ case_id: id, title, due_date: due, created_by: user.id, assigned_to: assignee })
          .select().single();
        if (error) return toast("Error: " + error.message);
        // In-place append (no full modal re-render / scroll reset). Task list is due-date ordered; new row goes at the end.
        const list = $("#tasks-inline");
        const empty = list.querySelector(".empty");
        if (empty) empty.remove();
        const tid = inserted ? inserted.id : "";
        const row = document.createElement("div");
        row.className = "row-item";
        row.style.padding = "7px 4px";
        row.innerHTML = `<div class="row-main"><div>${esc(title)}</div><div class="s">${due ? "due " + fmtD(due) : ""}</div></div>`
          + taskAssigneeHtml(tid, assignee, "")
          + `<button class="btn btn-sm" aria-label="Mark task done" title="Mark task done" onclick="doneTaskInCase('${tid}','${id}')">✓</button>`;
        list.appendChild(row);
        input.value = "";
        $("#new-task-due").value = "";
        input.focus();
      } finally { taskBtn.disabled = false; }
    };
    $("#add-task-btn").onclick = submitTask;
    $("#new-task").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTask(); } });
    // Due-date preset chips fill the date input (QW10) — no manual calendar clicking for common horizons.
    $("#modal").querySelectorAll(".due-chip").forEach((b) => b.onclick = () => {
      const d = new Date();
      if (b.dataset.months) d.setMonth(d.getMonth() + Number(b.dataset.months));
      else d.setDate(d.getDate() + Number(b.dataset.days || 0));
      $("#new-task-due").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      $("#new-task").focus();
    });
    // ---- Log call (BUILD 2a): one action writes a "Call: " note + optional follow-up task ----
    const submitCall = async () => {
      const noteEl = $("#cs-call-note");
      const body = noteEl.value.trim();
      if (!body) { noteEl.focus(); return toast("Add a call outcome note"); }
      const saveBtn = $("#cs-call-save");
      if (saveBtn) saveBtn.disabled = true;
      try {
        const { data: { user } } = await db.auth.getUser();
        // R5-49 — the outcome chip (if one is picked) prefixes the note, exactly as the note-type
        // chips do, so "Call: No answer — tried mobile" reads the same from every adviser.
        const outcomeChip = $("#cs-call-outcome-chips .tl-chip.active");
        const outcome = outcomeChip ? outcomeChip.dataset.outcome : "";
        const noteBody = "Call: " + (outcome ? outcome + " — " : "") + body;
        const { error: nErr } = await db.from("case_notes").insert({ case_id: id, body: noteBody, created_by: user.id });
        if (nErr) return toast("Error: " + nErr.message);
        /* R5-49 — protection is discussed on the call and recorded nowhere, and the case then jams
           at the Application gate weeks later. One tick writes it (never downgrading a status that
           is already further on), and the form select is moved with it so the next Save can't put
           "not discussed" straight back. */
        const protChk = $("#cs-call-prot");
        let protRecorded = false;
        if (protChk && protChk.checked && !protChk.disabled && (c.protection_status || "not_discussed") === "not_discussed") {
          const { error: pErr } = await db.from("cases").update({ protection_status: "discussed" }).eq("id", id);
          if (pErr) toast("Call logged, but the protection status could not be saved: " + pErr.message);
          else {
            protRecorded = true;
            c.protection_status = "discussed";
            await refreshOpenedStamp(id); // R5-3 — this modal just wrote the case row
            const protSel = $("#case-form") && $("#case-form").elements.protection_status;
            if (protSel) protSel.value = "discussed";
            const warn = $("#cs-prot-warn"); if (warn) warn.remove();
            protChk.checked = true; protChk.disabled = true;
            snapshotModalState(); // the app made this change, not the operator — not an unsaved edit
          }
        }
        // Prepend the note to the list in place (matches newest-first load order).
        const nlist = $("#notes-list");
        if (nlist) {
          const emptyN = nlist.querySelector(".empty");
          if (emptyN) emptyN.remove();
          const wrap = document.createElement("div");
          wrap.innerHTML = noteRowHtml(noteBody, new Date().toLocaleString("en-GB"), user.id);
          nlist.insertBefore(wrap.firstChild, nlist.firstChild);
        }
        // Keep the summary "Last note" line current.
        const noteVal = $("#cs-note-val");
        if (noteVal) noteVal.innerHTML = `${esc(noteBody.length > 120 ? noteBody.slice(0, 120) + "…" : noteBody)} <span class="cs-muted">· just now</span>`;
        // Optional follow-up task (created if a title and/or due date was given).
        const fuTitle = ($("#cs-call-fu-title").value || "").trim();
        const fuDue = $("#cs-call-fu-due").value || null;
        let madeTask = false;
        if (fuTitle || fuDue) {
          const title = fuTitle || "Follow-up call";
          // T1-6 — the follow-up lands on the case owner (or whoever the select names), not
          // automatically on whoever happened to take the call.
          const fuSel = $("#cs-call-fu-assignee");
          const fuAssignee = (fuSel && fuSel.value) || c.assigned_to || user.id;
          const { data: inserted, error: tErr } = await db.from("case_tasks")
            .insert({ case_id: id, title, due_date: fuDue, created_by: user.id, assigned_to: fuAssignee })
            .select().single();
          if (tErr) return toast("Error: " + tErr.message);
          madeTask = true;
          const tlist = $("#tasks-inline");
          if (tlist) {
            const emptyT = tlist.querySelector(".empty");
            if (emptyT) emptyT.remove();
            const tid = inserted ? inserted.id : "";
            const trow = document.createElement("div");
            trow.className = "row-item";
            trow.style.padding = "7px 4px";
            trow.innerHTML = `<div class="row-main"><div>${esc(title)}</div><div class="s">${fuDue ? "due " + fmtD(fuDue) : ""}</div></div>`
              + taskAssigneeHtml(tid, fuAssignee, "")
              + `<button class="btn btn-sm" aria-label="Mark task done" title="Mark task done" onclick="doneTaskInCase('${tid}','${id}')">✓</button>`;
            tlist.appendChild(trow);
          }
          // If there was no open task before, surface this one in the summary line.
          const taskVal = $("#cs-task-val");
          if (taskVal && !hadOpenTask) {
            const tOverdue = fuDue && fuDue < todayStr;
            taskVal.innerHTML = `<span class="${tOverdue ? "cs-danger-txt" : ""}">${esc(title)}${fuDue ? " · " + (tOverdue ? "overdue " : "due ") + fmtD(fuDue) : ""}</span>`;
          }
        }
        // Reset + close the panel.
        noteEl.value = "";
        $("#cs-call-fu-title").value = "";
        $("#cs-call-fu-due").value = "";
        const panel = $("#cs-logcall-panel");
        if (panel) panel.classList.add("hidden");
        // Reset the outcome chip so the next call starts blank.
        const activeChip = $("#cs-call-outcome-chips .tl-chip.active"); if (activeChip) activeChip.classList.remove("active");
        toast((madeTask ? "Call logged + follow-up added ✓" : "Call logged ✓") + (protRecorded ? " · protection recorded as discussed" : ""));
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    };
    // "Advance to <next stage>" (BUILD 7b, defect 17) — same single path (moveCaseToStage) as the
    // board's drag/select/hover affordances, so the protection gate, completed/not_proceeding
    // confirms and the segment-destination toast all still fire. Re-opens the case afterwards to
    // refresh this modal's summary; moveCaseToStage's own loadPipeline() refreshes the board underneath.
    const advanceBtn = $("#cs-advance-btn");
    if (advanceBtn) advanceBtn.onclick = async () => {
      advanceBtn.disabled = true;
      let res;
      // R5-34 — a blocked move has already re-opened this case ON the protection select; re-opening
      // it again here would throw that away and leave the operator back where they started.
      try { res = await moveCaseToStage(id, nextStage); }
      finally { if (res === "blocked") advanceBtn.disabled = false; else openCase(id); }
    };
    // "Set expected completion" nudge (BUILD 5c) — reveals Case details and focuses the field.
    const expNudge = $("#cs-expected-nudge");
    if (expNudge) expNudge.onclick = () => {
      const det = $(".case-details"); if (det) det.open = true;
      const inp = $("#case-expected-completion");
      if (inp) { inp.scrollIntoView({ behavior: "smooth", block: "center" }); inp.focus(); }
    };
    const retentionBtn = $("#cs-retention-btn"); // R5-6 — the manual retention path
    if (retentionBtn) retentionBtn.onclick = (e) => window.startRetentionCase(id, e);
    const logcallBtn = $("#cs-logcall-btn"), logcallPanel = $("#cs-logcall-panel");
    if (logcallBtn && logcallPanel) {
      logcallBtn.onclick = () => {
        const nowHidden = logcallPanel.classList.toggle("hidden");
        if (!nowHidden) $("#cs-call-note").focus();
      };
      $("#cs-call-cancel").onclick = () => logcallPanel.classList.add("hidden");
      $("#cs-call-save").onclick = submitCall;
      // Outcome chips: single-select, and clicking the active one clears it (no outcome prefix).
      const outcomeChips = $("#cs-call-outcome-chips");
      if (outcomeChips) outcomeChips.querySelectorAll(".tl-chip").forEach((b) => b.onclick = () => {
        const wasActive = b.classList.contains("active");
        outcomeChips.querySelectorAll(".tl-chip").forEach((x) => x.classList.remove("active"));
        if (!wasActive) b.classList.add("active");
        const note = $("#cs-call-note"); if (note) note.focus();
      });
      // Follow-up preset chips fill the log-call date input (kept separate from the task due-chips).
      $("#modal").querySelectorAll(".fu-chip").forEach((b) => b.onclick = () => {
        const d = new Date();
        if (b.dataset.months) d.setMonth(d.getMonth() + Number(b.dataset.months));
        else d.setDate(d.getDate() + Number(b.dataset.days || 0));
        $("#cs-call-fu-due").value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
    }
    $("#act-offer").onclick = () => $("#offer-file").click();
    $("#offer-file").onchange = () => handleOfferUpload(id);
    $("#act-evidence").onclick = () => buildEvidencePack(id);
    $("#act-appt").onclick = () => openAppt(null, { client_id: c.client_id, case_id: id });
    $("#act-factfind").onclick = () => factFind(id, c.client_id);
    if (c.offer_doc_path) $("#act-view-offer").onclick = async () => {
      const { data, error } = await db.storage.from("offers").createSignedUrl(c.offer_doc_path, 300);
      if (error) return toast("Error: " + error.message);
      window.open(data.signedUrl, "_blank");
    };
  }
  /* Callers that opened this case to point at something specific.
     revealProtection (R5-34): the protection gate just refused a move — land on the field that
     unblocks it, highlighted, rather than leaving the operator to hunt for it.
     openDetails: an offer was just applied — show the values that changed. */
  if (id && (opts.revealProtection || opts.openDetails)) {
    const det = $(".case-details"); if (det) det.open = true;
    if (opts.revealProtection) {
      const protSel = $("#case-form") && $("#case-form").elements.protection_status;
      if (protSel) {
        protSel.style.borderColor = "var(--red)";
        protSel.style.boxShadow = "0 0 0 3px rgba(192,57,43,.18)";
        protSel.scrollIntoView({ behavior: "smooth", block: "center" });
        protSel.focus();
      }
    }
  }
};

/* ---------- R5-12 / B7 — mark fee paid, with the date the money actually arrived ----------
   One `fee_status` and one `fee_paid_at` used to stand for three different fees, and the button
   stamped "paid, today" on all of them in one click. That made a proc fee that lands six weeks
   after the broker fee land in the wrong month's cash figures, and made a part-paid case
   indistinguishable from a fully paid one. Now each fee type with an amount is ticked and dated
   separately; the case only reads "paid" once every fee that has an amount has a date. */
const FEE_TYPES = [
  { key: "proc", label: "Proc fee", amountCol: "proc_fee", dateCol: "proc_fee_paid_at" },
  { key: "sols", label: "Sols fee", amountCol: "sols_fee", dateCol: "sols_fee_paid_at" },
  { key: "broker", label: "Broker fee", amountCol: "broker_fee", dateCol: "broker_fee_paid_at" },
];
// Pre-M2 databases don't have the per-type columns at all: select("*") simply doesn't return them.
const hasFeeDateCols = (c) => !!c && FEE_TYPES.some((t) => c[t.dateCol] !== undefined);
function feePaidDatesHtml(c) {
  if (!hasFeeDateCols(c)) return "";
  const shown = FEE_TYPES.filter((t) => Number(c[t.amountCol] || 0) > 0 || c[t.dateCol]);
  if (!shown.length) return "";
  return `<div class="full s" style="color:var(--muted);margin-top:-4px;">Paid: ` +
    shown.map((t) => `${esc(t.label)} ${c[t.dateCol] ? `<strong style="color:var(--dark);">${fmtD(c[t.dateCol])}</strong>` : "—"}`).join(" · ") +
    `</div>`;
}
// A date-only capture stored as a timestamp at local midday, so no timezone shift can move the
// money into the day before (which would move it into the previous month's figures).
const feeDateToTs = (d) => new Date(String(d) + "T12:00:00").toISOString();
async function markFeePaid(caseId, c) {
  const today = localDateStr();
  const types = FEE_TYPES.filter((t) => Number(c[t.amountCol] || 0) > 0);
  /* Nothing to itemise (no fee amounts on the case at all): keep the old single-click behaviour
     rather than refusing — some cases are marked paid for a fee recorded elsewhere. */
  if (!types.length || !hasFeeDateCols(c)) {
    if (!confirm(types.length
      ? "Your database doesn't have the per-fee-type dates yet (migration M2). Mark the whole fee paid today?"
      : "No fee amounts are set on this case. Mark the fee status paid today anyway?")) return;
    const { error } = await db.from("cases").update({ fee_status: "paid", fee_paid_at: new Date().toISOString() }).eq("id", caseId);
    if (error) return toast("Error: " + error.message);
    toast("Fee marked as paid");
    return openCase(caseId);
  }
  const rowHtml = types.map((t) => {
    const already = !!c[t.dateCol];
    return `
      <label class="ovl-fee-row${already ? " is-paid" : ""}">
        <input type="checkbox" class="fee-chk" data-key="${t.key}" ${already ? "checked disabled" : "checked"}>
        <span>${esc(t.label)} <strong>${fmtM(c[t.amountCol])}</strong>${already ? ' <span class="badge green">already paid</span>' : ""}</span>
        <input type="date" class="fee-date" data-key="${t.key}" max="${today}" value="${already ? String(c[t.dateCol]).slice(0, 10) : today}" ${already ? "disabled" : ""} aria-label="${esc(t.label)} paid date">
      </label>`;
  }).join("");
  const pending = types.filter((t) => !c[t.dateCol]);
  const html = `
    <h3>Mark fee paid</h3>
    <p class="panel-sub">Tick each fee you have actually banked and give the date the money arrived — that date is what the cash figures in Reports count on. Future dates are not accepted.</p>
    <div class="ovl-rows">${rowHtml}</div>
    <div class="ovl-err" id="fee-err"></div>
    <div class="modal-actions">
      <div></div>
      <div class="right">
        <button type="button" class="btn" id="fee-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="fee-ok">Mark paid</button>
      </div>
    </div>`;
  const picked = await openOverlay(html, (finish, box) => {
    const err = box.querySelector("#fee-err");
    const okBtn = box.querySelector("#fee-ok");
    const chosen = () => pending.filter((t) => {
      const chk = box.querySelector(`.fee-chk[data-key="${t.key}"]`);
      return chk && chk.checked;
    });
    const relabel = () => {
      const total = chosen().reduce((a, t) => a + Number(c[t.amountCol] || 0), 0);
      okBtn.textContent = total > 0 ? `Mark ${fmtM(total)} paid` : "Mark paid";
    };
    box.querySelectorAll(".fee-chk").forEach((el) => el.addEventListener("change", relabel));
    relabel();
    box.querySelector("#fee-cancel").onclick = () => finish(null);
    okBtn.onclick = () => {
      const sel = chosen();
      if (!sel.length) { err.textContent = "Tick at least one fee, or cancel."; return; }
      const out = [];
      for (const t of sel) {
        const d = (box.querySelector(`.fee-date[data-key="${t.key}"]`) || {}).value || "";
        if (!d) { err.textContent = `Give the date the ${t.label.toLowerCase()} was paid.`; return; }
        if (d > today) { err.textContent = `${t.label}: ${fmtD(d)} is in the future — money can only be marked paid once it has arrived.`; return; }
        out.push({ t, date: d });
      }
      finish(out);
    };
  });
  if (!picked) return;
  const patch = {};
  picked.forEach((x) => { patch[x.t.dateCol] = feeDateToTs(x.date); });
  // "Paid" only when every fee type that HAS an amount now has a date — otherwise the case stays
  // as it is (requested / not_requested) and the per-type dates tell the part-paid story.
  const allDates = types.map((t) => patch[t.dateCol] || c[t.dateCol] || null);
  const complete = allDates.every(Boolean);
  if (complete) {
    patch.fee_status = "paid";
    patch.fee_paid_at = allDates.slice().sort()[allDates.length - 1]; // legacy column keeps the LAST payment
  }
  let { error } = await db.from("cases").update(patch).eq("id", caseId);
  if (error && isMissingColumnError(error)) {
    // Pre-M2 fallback: one date for the lot, and say so rather than pretending it was itemised.
    const legacy = { fee_status: "paid", fee_paid_at: feeDateToTs(picked[picked.length - 1].date) };
    ({ error } = await db.from("cases").update(legacy).eq("id", caseId));
    if (!error) toast("Fee marked paid — run migration M2 for per-fee-type dates");
  } else if (!error) {
    toast(complete
      ? `Fee paid ✓ — ${picked.map((x) => x.t.label.toLowerCase()).join(", ")} dated, case now reads paid`
      : `${picked.map((x) => x.t.label).join(" + ")} dated ✓ — fee status unchanged until every fee is paid`);
  }
  if (error) return toast("Error: " + error.message);
  openCase(caseId);
}

/* ---------- R5-4 — the AI-read mortgage offer PROPOSES, it does not write ----------
   The old flow wrote offer_doc_path and a note at parse time, then typed the readings straight
   into the open form. Anything already on the case (a lender the adviser had corrected by hand)
   was overwritten with no diff and no record, and if the modal was closed before Save the parse
   was silently lost while the note claimed it had happened. It now renders the same Current vs
   Incoming table the fact-find Apply uses — empty fields pre-ticked, conflicts unticked and
   flagged — and NOTHING is written until Apply. */
const OFFER_FIELDS = [
  { col: "lender", label: "Lender" },
  { col: "product_name", label: "Product" },
  { col: "rate_percent", label: "Rate %", num: true },
  { col: "rate_type", label: "Rate type" },
  { col: "rate_end_date", label: "Rate end date", date: true },
  { col: "erc_end_date", label: "ERC end date", date: true },
  { col: "offer_expiry_date", label: "Offer expiry date", date: true },
  { col: "loan_amount", label: "Loan amount", num: true, money: true },
  { col: "property_value", label: "Property value", num: true, money: true },
  { col: "term_years", label: "Term (years)", num: true },
];
let pendingOffer = null; // { caseId, path, offer, rows } while a parsed offer awaits Apply/Discard

async function handleOfferUpload(caseId) {
  const file = $("#offer-file").files[0];
  if (!file) return;
  if (file.type !== "application/pdf") return toast("Please choose a PDF");
  if (file.size > 15 * 1024 * 1024) return toast("PDF too large (max 15MB)");
  const btn = $("#act-offer"), fileInput = $("#offer-file");
  if (btn && btn.disabled) return; // re-entry guard: a parse is already running
  const btnLabel = btn ? btn.textContent : "";
  // Persistent busy state for the ~20s parse: disable the trigger + file input and
  // keep a visible "reading…" label until the request settles (the toast auto-hides after 3.2s).
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Reading offer… (~20s)"; }
  if (fileInput) fileInput.disabled = true;
  toast("Reading offer with AI — this takes ~20 seconds…");
  try {
  const buf = await file.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const b64 = btoa(bin);
  const { data: { session } } = await db.auth.getSession();
  let offer;
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/parse-offer`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pdf_base64: b64 }),
    });
    const j = await r.json();
    if (!r.ok || j.error) return toast("Error: " + (j.error || r.status));
    offer = j.offer;
  } catch (e) { return toast("Error reading offer: " + e.message); }

  // Store the document — but do NOT link it to the case yet. offer_doc_path is written by Apply,
  // with the fields, in one update; Discard removes the object again so nothing is orphaned.
  const path = `${caseId}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const { error: upErr } = await db.storage.from("offers").upload(path, file, { contentType: "application/pdf", upsert: true });
  if (upErr) toast("Offer read, but storing the PDF failed — the readings below still apply, the document just won't be attached.");

  // Only propose into the modal that still shows the case we parsed for: after the ~20s await the
  // adviser may have opened a different case.
  const form = $("#case-form");
  if (!form || form.dataset.caseId !== String(caseId)) {
    return toast("Offer read ✓ — reopen this case and upload again (the case view changed while reading).");
  }
  // Read the CURRENT values from the database, not the form: the form may hold unsaved typing, and
  // the diff has to be honest about what is actually stored.
  const { data: cRow } = await db.from("cases").select("*").eq("id", caseId).single();
  if (!cRow) return toast("Couldn't re-read the case to compare against — reopen it and try again.");

  const rows = [];
  OFFER_FIELDS.forEach((f, i) => {
    let inc = offer[f.col];
    if (inc == null || String(inc).trim() === "") return;      // the parser had nothing for this field
    if (f.num) { inc = Number(String(inc).replace(/[^0-9.\-]/g, "")); if (!isFinite(inc)) return; }
    const cur = cRow[f.col];
    const curEmpty = cur == null || String(cur).trim() === "";
    const same = !curEmpty && (f.num ? Number(cur) === Number(inc) : String(cur).trim() === String(inc).trim());
    if (same) return;                                          // already matches — nothing to propose
    const disp = (v, empty) => (empty ? '<span class="cs-muted">— empty —</span>'
      : f.money ? esc(fmtM(v)) : f.date ? esc(fmtD(v)) : esc(String(v)));
    rows.push({
      idx: i, col: f.col, label: f.label, incoming: inc,
      conflict: !curEmpty, checked: curEmpty,
      curHtml: disp(cur, curEmpty), incHtml: disp(inc, false),
    });
  });

  const extras = [];
  if (offer.erc_summary) extras.push("ERC: " + offer.erc_summary);
  if (offer.offer_expiry_date) extras.push("Offer expires: " + fmtD(offer.offer_expiry_date));
  if (offer.confidence_notes) extras.push("⚠ " + offer.confidence_notes);
  pendingOffer = { caseId, path: upErr ? null : path, offer, rows, extras };
  renderOfferDiff();
  toast(rows.length
    ? `Offer read ✓ — ${rows.length} reading${rows.length === 1 ? "" : "s"} proposed below. Nothing is saved until you press Apply.`
    : "Offer read ✓ — every field already matches this case.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    // Re-enable and clear the picker so the same file can be chosen again if needed.
    if (fileInput) { fileInput.disabled = false; fileInput.value = ""; }
  }
}

function renderOfferDiff() {
  const panel = $("#offer-diff");
  if (!panel || !pendingOffer) return;
  const { rows, extras, path } = pendingOffer;
  const conflicts = rows.filter((r) => r.conflict).length;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;">
      <strong>📄 Read from the mortgage offer</strong>
      <span class="s" style="color:var(--muted);">Nothing is written until you press Apply${conflicts ? ` · ${conflicts} conflict${conflicts === 1 ? "" : "s"} left unticked` : ""}</span>
    </div>
    ${rows.length ? `
    <table>
      <thead><tr><th>Field</th><th>Current</th><th>From the offer</th><th style="text-align:center;">Apply</th></tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td style="font-weight:600;">${esc(r.label)}</td>
          <td>${r.curHtml}</td>
          <td>${r.incHtml}${r.conflict ? ' <span class="badge amber" style="margin-left:4px;">conflict</span>' : ""}</td>
          <td style="text-align:center;"><input type="checkbox" id="offchk-${r.idx}" ${r.checked ? "checked" : ""} aria-label="Apply ${esc(r.label)}"></td>
        </tr>`).join("")}</tbody>
    </table>` : '<p class="panel-sub" style="margin-top:6px;">Every field the offer gave already matches this case.</p>'}
    ${extras.length ? `<p class="panel-sub" style="margin-top:8px;">Also read: ${esc(extras.join(" | "))} — saved as a case note when you apply.</p>` : ""}
    ${path ? '<p class="panel-sub" style="margin-top:4px;">The PDF is uploaded; applying attaches it to the case.</p>' : ""}
    <div class="od-actions">
      <button type="button" class="btn btn-sm" id="offer-discard">Discard</button>
      <button type="button" class="btn btn-sm btn-primary" id="offer-apply">Apply selected</button>
    </div>`;
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  $("#offer-apply").onclick = applyOfferDiff;
  $("#offer-discard").onclick = discardOfferDiff;
}

async function applyOfferDiff() {
  if (!pendingOffer) return;
  const btn = $("#offer-apply");
  if (btn) { if (btn.disabled) return; btn.disabled = true; }
  try {
    const { caseId, path, rows, extras } = pendingOffer;
    const patch = {};
    let n = 0;
    rows.forEach((r) => {
      const chk = $("#offchk-" + r.idx);
      if (!chk || !chk.checked) return;
      patch[r.col] = r.incoming;
      n++;
    });
    // A read rate-end date is a real one — clear the "estimated, needs checking" flag with it.
    if (patch.rate_end_date) patch.rate_end_estimated = false;
    if (path) patch.offer_doc_path = path;
    if (!n && !path) { toast("Nothing ticked to apply"); return; }
    // ONE write, guarded by the version this modal opened on: if the case moved under us the
    // readings stay on screen to re-apply rather than silently overwriting somebody else's edit.
    const { data: updated, error } = await db.from("cases").update(patch).eq("id", caseId).eq("updated_at", openedUpdatedAt).select();
    if (error) { toast("Error: " + error.message); return; }
    if (!updated || !updated.length) {
      toast("This case changed while the offer was being read — reopen it and apply again (nothing was written).");
      return;
    }
    if (extras.length) {
      let uid = (ME && ME.id) || null;
      try { const { data: { user } } = await db.auth.getUser(); if (user && user.id) uid = user.id; } catch (e) {}
      await db.from("case_notes").insert({ case_id: caseId, body: "From mortgage offer (AI-read): " + extras.join(" | "), created_by: uid });
    }
    pendingOffer = null;
    toast(`Applied ${n} field${n === 1 ? "" : "s"} from the offer ✓`);
    loadPipeline();
    await openCase(caseId, { openDetails: true }); // land back on the case with the details visible
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function discardOfferDiff() {
  if (!pendingOffer) return;
  const { path } = pendingOffer;
  // The object was uploaded before the operator decided; remove it so a discarded parse leaves
  // nothing behind. (If the remove is refused it is simply an unlinked object — no case points
  // at it, so nothing in the app can surface it.)
  if (path) { try { await db.storage.from("offers").remove([path]); } catch (e) {} }
  pendingOffer = null;
  const panel = $("#offer-diff");
  if (panel) { panel.innerHTML = ""; panel.classList.add("hidden"); }
  toast("Offer readings discarded — nothing was saved");
}

async function queueEmail(caseId, clientId, type, c, ev) {
  // Disable the clicked button while in flight so a double-click can't double-insert.
  // The event is passed explicitly by callers (no reliance on the deprecated global window.event).
  // When called programmatically by briefQueueEmail no ev is passed — that caller manages its own button.
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) btn.disabled = true;
  try {
    const { data: cl } = await db.from("clients").select("email,first_name").eq("id", clientId).single();
    if (!cl?.email) return toast("This client has no email address — add one first.");
    if (type === "fee_request" && !(c.broker_fee > 0)) return toast("Set a broker fee amount on the case first.");
    /* BACKEND-R4 §6 — bank details are Owner-only AT THE DATABASE now, so `settings.bank_*` is
       simply absent for an Administrator or an Adviser and this gate used to refuse them the
       action outright. has_bank_details() is SECURITY DEFINER and returns the single boolean the
       decision needs; the fee-request email body is composed server-side with the service role, so
       no client ever needs the values. A failed RPC blocks rather than assumes — sending a fee
       request with no account to pay into is the worse outcome. */
    if (type === "fee_request") {
      const { data: hasBank, error: bankErr } = await db.rpc("has_bank_details");
      if (bankErr) return toast("Couldn't check the bank details just now — try again in a moment.");
      if (!hasBank) return toast(isOwner() ? "Add your bank details in Settings first." : "The firm's bank details aren't set up yet — ask the Owner to add them in Settings.");
    }
    if (type === "review_request" && !(settings.google_review_link || settings.review_platform_link)) return toast("Add your review link in Settings first.");
    if (type === "rate_end_reminder" && !c.rate_end_date) return toast("Set the rate end date on the case first.");
    /* R5-8 (app slice) — "what will my client actually see?" The email is composed server-side and
       signed off by the case's adviser (process-emails v8), falling back to the firm-wide name in
       Settings. Naming the signatory here is the cheap half of that fix: nobody sends an email in a
       colleague's name by accident, and an unassigned case shows the firm default before it goes. */
    const signedBy = (c && c.assigned_to && staffName(c.assigned_to) !== "—")
      ? staffName(c.assigned_to)
      : (settings.adviser_name || "your firm");
    // R5-13 — the rate-end reminder now leaves a real next action behind, so the case can't go quiet
    // after the email. Say so BEFORE the send, so the task isn't a surprise in someone's list.
    const chaseDue = localDateStr(Date.now() + 7 * 86400000);
    const chaseTitle = `Follow up rate-end reminder — ${(cl.first_name || "client").trim()}`;
    const extraLine = type === "rate_end_reminder"
      ? `\n\nA follow-up task ("${chaseTitle}") will be added for ${fmtD(chaseDue)}.`
      : "";
    if (!confirm(`Send ${EMAIL_LABEL[type].toLowerCase()} email to ${cl.email}?\n\nSigned off by: ${signedBy}${extraLine}`)) return;
    const { data: qRow, error } = await db.from("email_queue")
      .insert({ case_id: caseId, client_id: clientId, email_type: type, to_email: cl.email })
      .select("id").single();
    if (error) return toast("Error: " + error.message);
    if (type === "rate_end_reminder") {
      await db.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", caseId);
      /* R5-13 — sending the reminder used to be the whole "loop": the My Day row cleared itself and
         nothing anywhere held the next step, so a client who didn't reply was never chased. Best
         effort — a failed task insert must not make the (already queued) email look like a failure. */
      const { error: taskErr } = await db.from("case_tasks").insert({
        case_id: caseId, title: chaseTitle, due_date: chaseDue,
        assigned_to: (c && c.assigned_to) || (ME && ME.id) || null,
        created_by: (ME && ME.id) || null,
      });
      if (taskErr) toast("Email queued, but the follow-up task could not be created: " + taskErr.message);
    }
    if (type === "review_request") await db.from("cases").update({ review_requested_at: new Date().toISOString() }).eq("id", caseId);
    /* The fee request was the one type that sent and left no trace on the case: no fee_status, no
       fee_requested_at. The case went on reading "Not requested", it stayed in the not-requested
       half of the fee reporting, and nothing recorded that the client had been asked — so a second
       adviser had no way to know an invoice was already out. Stamping fee_status also fires the
       database's log_case_event trigger (fee_status_changed), so the request lands on the case
       timeline and in the audit trail exactly like a manual change.
       A fee already marked paid or waived is never walked backwards — only the timestamp is set. */
    if (type === "fee_request") {
      const patch = { fee_requested_at: new Date().toISOString() };
      if (!c || !c.fee_status || c.fee_status === "not_requested") patch.fee_status = "requested";
      const { error: feeErr } = await db.from("cases").update(patch).eq("id", caseId);
      if (feeErr) toast("Email queued, but the fee status could not be updated: " + feeErr.message);
    }
    // R5-1 — send THIS row and nothing else. Without the id there is nothing safe to send, so the
    // email simply waits for the next automation run rather than triggering a firm-wide flush.
    const res = qRow && qRow.id ? await runAutomation(true, { queueIds: [qRow.id] }) : null;
    sendResultToast(res, "Email queued — check Emails tab (is your Resend key set up?)");
    return true;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- Clients ---------- */
async function loadClients(filter = "") {
  const { data: clients, error } = await db.from("clients").select("*, cases(id,stage)").order("last_name");
  if (error) { renderLoadError("#client-list", error, () => loadClients(filter)); return; }
  const f = filter.trim().toLowerCase();
  const fPhone = normPhone(filter);
  const phoneSearch = /\d/.test(fPhone);
  const list = (clients || []).filter((c) => {
    if (!f) return true;
    if ((c.first_name + " " + c.last_name + " " + (c.email || "")).toLowerCase().includes(f)) return true;
    return phoneSearch && c.phone && normPhone(c.phone).includes(fPhone);
  });
  const emptyMsg = f ? `No matches for “${esc(filter.trim())}”.` : "No clients yet — add your first one.";
  $("#client-list").innerHTML = `<div class="panel">` + (list.length ? list.map((c) => {
    const active = c.cases.filter((x) => !["completed", "not_proceeding"].includes(x.stage)).length;
    return `<div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openClient('${c.id}')">${esc([c.last_name, c.first_name].filter(Boolean).join(", "))}</div>
        <div class="s">${c.email ? mailLink(c.email) : "no email"}${c.phone ? " · " + telLink(c.phone) : ""}</div>
      </div>
      <span class="badge ${active ? "blue" : "grey"}">${c.cases.length} case${c.cases.length === 1 ? "" : "s"}${active ? ` (${active} active)` : ""}</span>
    </div>`;
  }).join("") : `<div class="empty">${emptyMsg}</div>`) + `</div>`;
}
$("#client-search").addEventListener("input", (e) => loadClients(e.target.value));
$("#new-client-btn").addEventListener("click", () => openClient(null));

/* ---------- Unified client timeline (SP3b) ----------
   A chronological, newest-first merge across ALL a client's cases plus client-level items.
   Sources are all tables app.js already reads. Batched: the client's case ids are gathered
   ONCE, then ONE query per table (.in("case_id", ids), or .eq("client_id") where the row
   carries client linkage) — no per-case loops. Every source is wrapped so a blocked/absent
   table in prod degrades to an empty source rather than breaking the modal. */
const TL_CATS = [["all", "All"], ["call", "Calls"], ["email", "Emails"], ["meeting", "Meetings"], ["note", "Notes"], ["appointment", "Appointments"], ["system", "System"]];
/* R5-16 — a client with four buy-to-lets got four timeline tags all reading "Buy to Let", so the
   one column that exists to say WHICH case a row belongs to said nothing. Same label the note
   composer's case selector uses: kind · lender, falling back to the kind alone when there is no
   lender yet. */
function timelineCaseLabel(c) {
  const kind = (KINDS.find((k) => k[0] === c.case_kind) || [])[1] || c.case_kind || "Case";
  return c.lender ? `${kind} · ${c.lender}` : kind;
}
async function buildClientTimeline(clientId, cases) {
  const ids = (cases || []).map((c) => c.id);
  const caseLabel = {};
  (cases || []).forEach((c) => { caseLabel[c.id] = timelineCaseLabel(c); });
  const q = (p) => p.then((r) => (r && r.data) || []).catch(() => []);
  let notes = [], events = [], appts = [], emails = [], sms = [], ffs = [], inbound = [];
  try {
    [notes, events, appts, emails, sms, ffs, inbound] = await Promise.all([
      ids.length ? q(db.from("case_notes").select("body,created_at,case_id,created_by").in("case_id", ids)) : [],
      ids.length ? q(db.from("case_events").select("event,detail,created_at,case_id,actor").in("case_id", ids)) : [],
      q(db.from("appointments").select("title,starts_at,location,case_id,client_id").eq("client_id", clientId)),
      ids.length ? q(db.from("email_queue").select("email_type,status,subject,sent_at,created_at,case_id").in("case_id", ids)) : [],
      ids.length ? q(db.from("sms_queue").select("sms_type,status,sent_at,created_at,case_id").in("case_id", ids)) : [],
      ids.length ? q(db.from("fact_finds").select("status,submitted_at,created_at,case_id").in("case_id", ids)) : [],
      ids.length ? q(db.from("case_emails").select("subject,snippet,received_at,created_at,case_id").in("case_id", ids)) : [],
    ]);
  } catch (_) { /* keep whatever resolved */ }
  const items = [];
  const push = (ts, cat, icon, title, caseId) => { if (!ts) return; items.push({ ts, cat, icon, title, caseLabel: caseLabel[caseId] }); };
  notes.forEach((n) => { const nt = noteType(n.body); push(n.created_at, nt.type, nt.icon, (esc(nt.cleanBody) || "(note)") + authorChipHtml(n.created_by), n.case_id); });
  emails.filter((e) => e.status === "sent" || e.status === "failed").forEach((e) => {
    const lbl = EMAIL_LABEL[e.email_type] || e.email_type || "Email";
    push(e.sent_at || e.created_at, "email", "✉️", esc(lbl) + (e.status === "failed" ? ' <span class="tl-fail">failed</span>' : ""), e.case_id);
  });
  sms.filter((s) => s.status === "sent" || s.status === "failed").forEach((s) => {
    push(s.sent_at || s.created_at, "email", "💬", esc(smsTypeLabel(s.sms_type)) + " SMS" + (s.status === "failed" ? ' <span class="tl-fail">failed</span>' : ""), s.case_id);
  });
  appts.forEach((a) => { push(a.starts_at, "appointment", "📅", esc(a.title || "Appointment") + (a.location ? ` <span class="tl-muted">· ${esc(a.location)}</span>` : ""), a.case_id); });
  // Inbound client emails (Outlook sync) — Priya's handover gap: correspondence must show both directions.
  inbound.forEach((m) => { push(m.received_at || m.created_at, "email", "📥", esc(m.subject || m.snippet || "Email from client") + ' <span class="tl-muted">· from client</span>', m.case_id); });
  ffs.filter((f) => f.status === "sent" || f.status === "submitted").forEach((f) => { push(f.submitted_at || f.created_at, "system", "📋", "Fact-find " + esc(f.status), f.case_id); });
  // BACKEND-R4 §2 — the trigger has always stamped who acted; the timeline just never selected it.
  events.forEach((ev) => { push(ev.created_at, "system", "⚙️", esc(ev.detail || ev.event || "Event") + eventActorHtml(ev.actor), ev.case_id); });
  items.sort((a, b) => new Date(b.ts) - new Date(a.ts)); // newest first, robust across date-only + full ISO
  return items;
}
function timelineRowHtml(it, multiCase) {
  const caseTag = multiCase && it.caseLabel ? `<span class="tl-case">${esc(it.caseLabel)}</span>` : "";
  return `<div class="tl-row" data-cat="${it.cat}" data-ts="${esc(it.ts)}">
      <span class="tl-ic">${it.icon}</span>
      <div class="tl-main">
        <div class="tl-title">${it.title}</div>
        <div class="tl-meta">${caseTag}<span class="tl-ago">${esc(tlWhen(it.ts))}</span></div>
      </div>
    </div>`;
}
function renderTimelineList(items, filter, cap, multiCase) {
  const filtered = filter === "all" ? items : items.filter((it) => it.cat === filter);
  if (!filtered.length) return '<div class="empty">No activity in this view yet.</div>';
  // Sarah's "when did we last speak" fix: split future-dated items (booked appointments)
  // into a compact Upcoming block so history starts right at the top of the main list.
  const nowTs = Date.now();
  const upcoming = filtered.filter((it) => new Date(it.ts) - nowTs > 0).sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const past = filtered.filter((it) => new Date(it.ts) - nowTs <= 0);
  let html = "";
  if (upcoming.length) {
    html += `<div class="tl-upcoming"><div class="tl-upcoming-hd">Upcoming</div>${upcoming.map((it) => timelineRowHtml(it, multiCase)).join("")}</div>`;
  }
  const shown = past.slice(0, cap);
  let lastDay = null;
  shown.forEach((it) => {
    const day = localDateStr(it.ts);
    if (day !== lastDay) { html += `<div class="tl-day">${esc(tlDayLabel(it.ts))}</div>`; lastDay = day; }
    html += timelineRowHtml(it, multiCase);
  });
  if (past.length > cap) html += `<button type="button" class="btn btn-sm tl-more" id="tl-more">Show more (${past.length - cap})</button>`;
  return html;
}

/* ---------- Change history (audit_log) — BACKEND-R4 §3 ----------
   `audit_row()` writes an append-only audit_log row for every insert / update / delete on clients,
   cases, case_tasks, case_notes, appointments, settings, profiles and introducers, carrying the
   actor, a human summary and a field-level diff. It has no INSERT/UPDATE/DELETE policy and those
   grants are revoked, so nothing here can be forged or erased through the app — the panel is a
   read-only window onto it.
   The table was created with the round-4 migration, so it genuinely holds nothing from before that
   date; the empty state says so instead of implying nothing ever happened to the record. */
const AUDIT_LOG_START = "2026-07-26";
const AUDIT_COLS = "id,happened_at,actor,actor_label,action,table_name,row_id,case_id,client_id,summary,changes";
const AUDIT_FETCH_MAX = 200;   // one indexed query per modal; the panel pages within what it fetched
const AUDIT_PAGE = 20;         // rows shown before "Show more"
const AUDIT_HIDDEN = "(hidden)";
const auditStartLabel = () => fmtD(AUDIT_LOG_START);
/* Any promise whose failure must not stop a modal rendering (a table blocked by RLS, a column that
   isn't there yet) degrades to an empty list — the record still opens. */
const softRows = (p) => Promise.resolve(p).then((r) => (r && r.data) || []).catch(() => []);
// One indexed read of a record's history, newest first. `col` is "case_id" or "client_id".
const loadAuditRows = (col, id) => softRows(db.from("audit_log").select(AUDIT_COLS).eq(col, id).order("happened_at", { ascending: false }).limit(AUDIT_FETCH_MAX));

/* BACKEND-R4 §3 — audit_log rows for `settings` and `profiles` are Owner-only, and RLS already
   removes them from everyone else's SELECT (that is the real control; a case/client history cannot
   contain them anyway, since those rows carry no case_id or client_id). This filter is PRESENTATION
   ONLY: it guarantees the panel can never render one even if a future query widens, and it means a
   non-Owner sees a correctly-empty list rather than a broken one when the database filters them. */
const AUDIT_OWNER_ONLY_TABLES = ["settings", "profiles"];
function auditVisibleRows(rows) {
  const all = Array.isArray(rows) ? rows : [];
  return isOwner() ? all : all.filter((r) => AUDIT_OWNER_ONLY_TABLES.indexOf(r && r.table_name) === -1);
}

const auditFieldLabel = (f) => String(f).replace(/_/g, " ");
// "(hidden)" is what the database itself stores for bank details/keys/tokens/passwords — the log
// records THAT a sensitive value changed and deliberately never records the value.
const AUDIT_HIDDEN_TITLE = "The database masks bank details, keys, tokens and passwords: it records that the value changed and never the value itself.";

/* ---------- ONE standard for reading an audit value: on screen and in the evidence pack ----------
   The pack resolved ids to names, humanised enums and wrote dates the way the rest of the app
   writes them; the drawers printed the same rows raw ("assigned to  p2 → p3", "stage
   application → offer", "rate end date  2031-06-30"), and in production those ids are uuids, so on
   screen it read worse than the fixture suggests. Both renderers now go through the maps and the
   resolver below, so there is one answer to "what does this value say". */

// Coded value → the words the app already uses. STAGE_LABEL / KINDS / EMAIL_LABEL / ROLE_LABEL are
// the app's own maps; the rest are the same words the case form and the badges show, spelled for a
// document rather than for a badge.
const PACK_ENUM = {
  stage: STAGE_LABEL,
  case_kind: Object.fromEntries(KINDS),
  fee_status: { not_requested: "Not requested", requested: "Requested", paid: "Paid", waived: "Waived" },
  protection_status: { not_discussed: "Not discussed", discussed: "Discussed", quoted: "Quoted", policy_taken: "Policy taken", declined: "Declined" },
  gi_status: { not_discussed: "Not discussed", quoted: "Quoted", policy_taken: "Policy taken", declined: "Declined", not_applicable: "Not applicable" },
  email_type: EMAIL_LABEL,
  role: ROLE_LABEL,
  status: { queued: "Queued", sent: "Sent", failed: "Failed", cancelled: "Cancelled", draft: "Draft", submitted: "Submitted" },
};
/* Fields whose value is an id, and what kind of thing the id points at. This list is a SHORTCUT,
   not the guard. An insert or a delete records the WHOLE row rather than a diff, so a column
   nobody enumerated here still arrives — `retention_source_case_id`, `nps_token` — and an earlier
   pass removed the first of those from this list on the (true, but only-for-updates) reasoning
   that nothing in the app writes it. auditFieldKind() below therefore falls back to the SHAPE of
   the field name, and auditValueText() to the SHAPE of the value, so an id or a credential is
   resolved or withheld wherever it turns up instead of only where it was listed. */
const PACK_ID_FIELDS = {
  assigned_to: "person", created_by: "person", actor: "person", staff_id: "person", claimed_by: "person",
  client_id: "client", case_id: "case", introducer_id: "introducer",
};
/* A field name that says it holds a credential. `key` on its own is deliberately NOT one: on a
   settings row that column holds the setting's NAME, which is the most useful thing on the row. */
const AUDIT_SECRET_FIELD_RE = /token|secret|password|passphrase|credential|api_key|_key$/i;
/* A value that can only be an internal reference: a uuid, or a long unbroken hex digest. Nothing a
   person writes — a name, a lender, a product, a note, an address, an email, a path — takes either
   shape, so there are no false positives to lose real detail to. In production every id in this
   database IS a uuid, so this catches an id-bearing column whatever it happens to be called. */
const AUDIT_OPAQUE_VALUE_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,})$/i;
const AUDIT_REF_HIDDEN = "(reference not shown)";
const AUDIT_SECRET_HIDDEN = "(credential — not shown)";
const AUDIT_REF_TITLE = "An internal database reference. It names nothing a reader can look up, so it is withheld rather than printed.";
function auditFieldKind(field) {
  const f = String(field || "");
  if (PACK_ID_FIELDS[f]) return PACK_ID_FIELDS[f];
  if (AUDIT_SECRET_FIELD_RE.test(f)) return "secret";
  if (/(^|_)case_id$/.test(f)) return "case";
  if (/(^|_)client_id$/.test(f)) return "client";
  if (/(^|_)introducer_id$/.test(f)) return "introducer";
  if (/(^|_)(by|to|actor|staff|adviser|user|owner)_id$/.test(f)) return "person";
  if (/(^|_)id$/.test(f)) return "ref";
  return null;
}
/* `ctx` is what the surrounding screen or document can name. The pack passes its case, its client
   and the introducers it fetched; the drawers pass nothing, and an id they cannot name is
   withheld rather than printed — an id a reader cannot look up is not evidence of anything. */
function auditIdText(kind, id, ctx) {
  ctx = ctx || {};
  const where = ctx.where || "here";
  if (id == null || id === "") return "—";
  // profileName() covers everyone with a profile row, including a colleague moved to "No access".
  if (kind === "person") return profileName(id) || "A colleague no longer in the system";
  if (kind === "client") return id === ctx.clientId ? (ctx.clientName || "This client") : `A different client (not named ${where})`;
  if (kind === "case") return id === ctx.caseId ? (ctx.caseLabel || "This case") : `A different case (not named ${where})`;
  if (kind === "introducer") return (ctx.introById || {})[id] || "An introducer no longer on file";
  if (kind === "secret") return AUDIT_SECRET_HIDDEN;
  return AUDIT_REF_HIDDEN;
}
// One value, as a person would read it: names for ids, words for enums, dates the way the rest of
// the app writes them, and nothing raw left over.
function auditValueText(field, v, ctx) {
  if (v === AUDIT_HIDDEN) return AUDIT_HIDDEN;
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return JSON.stringify(v);
  const kind = auditFieldKind(field);
  if (kind) return auditIdText(kind, v, ctx);
  const map = PACK_ENUM[field];
  if (map && map[v]) return map[v];
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(s).toLocaleString("en-GB");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fmtD(s);
  if (AUDIT_OPAQUE_VALUE_RE.test(s)) return AUDIT_REF_HIDDEN;
  return s;
}
/* True when the database masked this entry rather than recording it. BACKEND-R4 §3 masks a
   sensitive settings key on insert, update and delete ALIKE — an update stores {old,new} both
   "(hidden)", an insert/delete stores the whole row with "(hidden)" in place of the value. */
function auditIsMasked(v, isDiff) {
  return isDiff && v && typeof v === "object" ? (v.old === AUDIT_HIDDEN && v.new === AUDIT_HIDDEN) : v === AUDIT_HIDDEN;
}
function auditValueHtml(field, v) {
  const t = auditValueText(field, v);
  if (t === AUDIT_HIDDEN) return `<span class="audit-hidden" title="${esc(AUDIT_HIDDEN_TITLE)}">${esc(AUDIT_HIDDEN)}</span>`;
  if (t === "—") return '<span class="audit-nil">—</span>';
  if (t === AUDIT_REF_HIDDEN || t === AUDIT_SECRET_HIDDEN) return `<span class="audit-hidden" title="${esc(AUDIT_REF_TITLE)}">${esc(t)}</span>`;
  return esc(t);
}
// changes is {field:{old,new}} for an update and the whole row for an insert/delete.
function auditChangesHtml(entry) {
  const ch = entry && entry.changes;
  if (!ch || typeof ch !== "object" || !Object.keys(ch).length) return '<div class="empty">No field detail recorded.</div>';
  const isDiff = (entry.action === "update");
  const rows = Object.keys(ch).map((f) => {
    const v = ch[f];
    const lbl = `<th>${esc(auditFieldLabel(f))}</th>`;
    /* The masking is the same on all three actions, so it reads the same on all three. Before
       this, only an update took this sentence; an insert or a delete of a masked settings key
       printed the database's bare "(hidden)" marker instead, for the identical fact. */
    if (auditIsMasked(v, isDiff)) {
      return `<tr>${lbl}<td colspan="3"><span class="audit-hidden" title="${esc(AUDIT_HIDDEN_TITLE)}">changed — value not recorded (sensitive)</span></td></tr>`;
    }
    if (isDiff && v && typeof v === "object") {
      return `<tr>${lbl}<td>${auditValueHtml(f, v.old)}</td><td class="audit-arrow">→</td><td>${auditValueHtml(f, v.new)}</td></tr>`;
    }
    return `<tr>${lbl}<td colspan="3">${auditValueHtml(f, v)}</td></tr>`;
  }).join("");
  return `<table class="audit-changes">${rows}</table>`;
}
function auditEntryHtml(r) {
  const when = r.happened_at ? new Date(r.happened_at).toLocaleString("en-GB") : "";
  return `<details class="audit-entry" data-table="${esc(r.table_name)}" data-action="${esc(r.action)}">
      <summary><span class="audit-act audit-${esc(r.action)}">${esc(r.action)}</span><span class="audit-sum">${esc(r.summary || "")}</span>${authorChipHtml(r.actor)}<span class="audit-when">${esc(when)}</span></summary>
      ${auditChangesHtml(r)}
    </details>`;
}
function renderAuditList(rows, cap) {
  const vis = auditVisibleRows(rows);
  if (!vis.length) {
    return `<div class="empty">No changes recorded for this record. The audit trail began on ${esc(auditStartLabel())} — anything done before that date is not in it.</div>`;
  }
  let html = vis.slice(0, cap).map(auditEntryHtml).join("");
  if (vis.length > cap) html += `<button type="button" class="btn btn-sm audit-more">Show more (${vis.length - cap})</button>`;
  else if ((rows || []).length >= AUDIT_FETCH_MAX) html += `<div class="audit-note">Showing the most recent ${vis.length} changes.</div>`;
  return html;
}
/* A collapsed drawer, so an ordinary edit isn't buried under a forensic log. `domId` is unique per
   modal so the case and client panels can never collide. */
function auditPanelHtml(domId, rows) {
  const vis = auditVisibleRows(rows);
  return `<details class="audit-panel" id="${domId}">
      <summary>Change history${vis.length ? ` <span class="audit-count">${vis.length}</span>` : ""}</summary>
      <p class="panel-sub audit-intro">Every insert, update and delete the database recorded against this record, newest first. Written by the audit trigger — it cannot be edited or erased through the app. The log began on ${esc(auditStartLabel())}.</p>
      <div class="audit-list" id="${domId}-list">${renderAuditList(rows, AUDIT_PAGE)}</div>
    </details>`;
}
function wireAuditPanel(domId, rows) {
  let cap = AUDIT_PAGE;
  const wire = () => {
    const list = $("#" + domId + "-list");
    if (!list) return;
    const more = list.querySelector(".audit-more");
    if (more) more.onclick = () => { cap += AUDIT_PAGE; list.innerHTML = renderAuditList(rows, cap); wire(); };
  };
  wire();
}

/* ---------- Change history — the WHOLE log (BACKEND-R4 §3), on Settings ----------
   Every other audit reader in this file is keyed on case_id or client_id. audit_log rows for
   `settings` and `profiles` carry neither — a bank-detail edit or a role change belongs to no
   client's file — so before this panel existed those entries could not be rendered anywhere in the
   app, by anybody, including the Owner. This is the reader for the whole table: filter by what
   changed, by who and by date, newest first, a page at a time, each row expandable to the
   field-level before/after.

   WHO MAY SEE THE settings/profiles ROWS IS DECIDED BY THE DATABASE. The audit_log SELECT policy
   is "staff, except rows where table_name in ('settings','profiles'), which are Owner-only" — that
   is the real control and it holds whatever this file does. Hiding the panel from a non-Owner is
   PRESENTATION: it keeps them out of a view whose headline content the database would silently
   withhold, which would look broken rather than restricted. */
const CH_PAGE = 25;            // rows per page
const CH_ACTOR_SCAN = 500;     // most recent rows scanned to build the "Who" list
const CH_ALL = "all";
const CH_SYSTEM = "__system__"; // actor IS NULL — the 8am cron, an edge function, the service role
/* "What changed", grouped the way an Owner thinks about it rather than by table name.
   Third element = the table_name values the group selects, null = no filter. */
const CH_GROUPS = [
  [CH_ALL, "Everything", null],
  ["settings", "Settings", ["settings"]],
  ["profiles", "Logins & roles", ["profiles"]],
  ["clients", "Clients", ["clients"]],
  ["cases", "Cases", ["cases"]],
  ["work", "Tasks, notes & appointments", ["case_tasks", "case_notes", "appointments"]],
  ["introducers", "Introducers", ["introducers"]],
];
// What each audit_log.table_name is called in front of a person.
const AUDIT_TABLE_LABEL = {
  settings: "Setting", profiles: "Login", clients: "Client", cases: "Case",
  case_tasks: "Task", case_notes: "Note", appointments: "Appointment", introducers: "Introducer",
  // G1N-5 — snoozing a compliance alert is a supervised act and now writes an audit row (M3).
  watch_alerts: "Watchtower alert", duplicate_dismissals: "Not-a-duplicate mark",
};
const auditTableLabel = (t) => AUDIT_TABLE_LABEL[t] || String(t || "record").replace(/_/g, " ");
let chState = { group: CH_ALL, actor: CH_ALL, from: "", to: "", page: 0 };
// The "To" box is inclusive of the day the user picked, so the query runs to the start of the next.
function chNextDay(ymd) {
  const d = new Date(ymd + "T12:00:00");
  if (isNaN(d)) return ymd;
  d.setDate(d.getDate() + 1);
  return localDateStr(d);
}
/* One row of the whole-log view. Same expandable field-level detail as the case and client
   drawers (auditChangesHtml, which already renders the database's "(hidden)" masking of bank
   details, keys and tokens as "changed — value not recorded"), plus the record type and the actor,
   which the per-record drawers never needed. */
/* The trigger's summary opens with the actor's name, and this view shows the actor in its own
   filterable column, so the prefix is dropped rather than printed twice. Anything that does not
   start with the name beside it is left exactly as the database wrote it. */
function chSummaryText(r) {
  const s = String((r && r.summary) || "");
  const who = (r && r.actor_label) || "";
  return who && s.indexOf(who + " ") === 0 ? s.slice(who.length + 1) : s;
}
function chEntryHtml(r) {
  const when = r.happened_at ? new Date(r.happened_at).toLocaleString("en-GB") : "";
  return `<details class="audit-entry" data-table="${esc(r.table_name)}" data-action="${esc(r.action)}">
      <summary><span class="audit-act audit-${esc(r.action)}">${esc(r.action)}</span><span class="audit-tbl">${esc(auditTableLabel(r.table_name))}</span><span class="audit-sum">${esc(chSummaryText(r))}</span><span class="audit-who">${esc(r.actor_label || actorName(r.actor))}</span><span class="audit-when">${esc(when)}</span></summary>
      ${auditChangesHtml(r)}
    </details>`;
}
const chFiltered = () => chState.group !== CH_ALL || chState.actor !== CH_ALL || !!chState.from || !!chState.to;
async function renderChangeHistory() {
  const list = $("#ch-list"), pager = $("#ch-pager");
  if (!list) return;
  if (pager) pager.innerHTML = "";
  const start = chState.page * CH_PAGE;
  let data, count, error;
  /* Settings is a working page for the Owner; a log that cannot be read must cost them the panel,
     never the page. Anything the query throws is shown as a retryable error in this box. */
  try {
    let q = db.from("audit_log").select(AUDIT_COLS, { count: "exact" });
    const grp = CH_GROUPS.find((g) => g[0] === chState.group);
    if (grp && grp[2]) q = q.in("table_name", grp[2]);
    if (chState.actor === CH_SYSTEM) q = q.is("actor", null);
    else if (chState.actor !== CH_ALL) q = q.eq("actor", chState.actor);
    if (chState.from) q = q.gte("happened_at", chState.from);
    if (chState.to) q = q.lt("happened_at", chNextDay(chState.to));
    ({ data, count, error } = await q
      .order("happened_at", { ascending: false }).order("id", { ascending: false })
      .range(start, start + CH_PAGE - 1));
  } catch (e) { error = e; }
  if (error) { renderLoadError("#ch-list", error, renderChangeHistory); return; }
  /* Belt and braces: the SELECT policy has already removed any settings/profiles row a non-Owner
     could not see, so for them this filter removes nothing that arrived. PRESENTATION, not a
     control — it exists so the panel can never render one even if a future query widens. */
  const rows = auditVisibleRows(data || []);
  const total = count == null ? rows.length : count;
  // Never strand the reader past the end of a log that shrank under them — go back to page 1.
  if (!rows.length && start > 0) { chState.page = 0; return renderChangeHistory(); }
  if (!rows.length) {
    list.innerHTML = `<div class="empty">${chFiltered()
      ? `No changes match these filters. The change history began on ${esc(auditStartLabel())} — anything done before that date is not in it.`
      : `Nothing recorded yet. The change history began on ${esc(auditStartLabel())} — anything done before that date is not in it.`}</div>`;
    return;
  }
  list.innerHTML = rows.map(chEntryHtml).join("");
  if (!pager) return;
  const pages = Math.max(1, Math.ceil(total / CH_PAGE));
  pager.innerHTML = `<button type="button" class="btn btn-sm" id="ch-prev"${chState.page === 0 ? " disabled" : ""}>← Newer</button>
    <span class="ch-count">${start + 1}–${start + rows.length} of ${total} change${total === 1 ? "" : "s"} · page ${chState.page + 1} of ${pages}</span>
    <button type="button" class="btn btn-sm" id="ch-next"${chState.page + 1 >= pages ? " disabled" : ""}>Older →</button>`;
  const prev = $("#ch-prev"), next = $("#ch-next");
  if (prev) prev.onclick = () => { if (chState.page > 0) { chState.page--; renderChangeHistory(); } };
  if (next) next.onclick = () => { if (chState.page + 1 < pages) { chState.page++; renderChangeHistory(); } };
}
async function loadChangeHistory() {
  const panel = $("#change-history-panel");
  if (!panel) return;
  panel.classList.toggle("hidden", !isOwner());
  if (!isOwner()) return;
  const tSel = $("#ch-table");
  if (tSel && !tSel.options.length) {
    tSel.innerHTML = CH_GROUPS.map((g) => `<option value="${esc(g[0])}">${esc(g[1])}</option>`).join("");
    tSel.onchange = () => { chState.group = tSel.value; chState.page = 0; renderChangeHistory(); };
  }
  const aSel = $("#ch-actor");
  if (aSel && !aSel.options.length) {
    /* Built from the log itself, not from PROFILES: actor_label is a name snapshot that
       deliberately survives the profile being deleted (§3), so someone who has since left the
       firm is still selectable here. Scanned over the most recent CH_ACTOR_SCAN rows. */
    let scan = [];
    try {
      scan = await softRows(db.from("audit_log").select("actor,actor_label").order("happened_at", { ascending: false }).limit(CH_ACTOR_SCAN));
    } catch (e) { scan = []; } // a log that can't be scanned costs the Who list, not the page
    const seen = {}, opts = [];
    scan.forEach((r) => {
      const key = r.actor || CH_SYSTEM;
      if (seen[key]) return;
      seen[key] = 1;
      opts.push([key, r.actor ? (r.actor_label || actorName(r.actor)) : "System (automation)"]);
    });
    opts.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    aSel.innerHTML = `<option value="${CH_ALL}">Anyone</option>` + opts.map((o) => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join("");
    aSel.onchange = () => { chState.actor = aSel.value; chState.page = 0; renderChangeHistory(); };
  }
  const from = $("#ch-from"), to = $("#ch-to"), clear = $("#ch-clear");
  if (from) from.onchange = () => { chState.from = from.value; chState.page = 0; renderChangeHistory(); };
  if (to) to.onchange = () => { chState.to = to.value; chState.page = 0; renderChangeHistory(); };
  if (clear) clear.onclick = () => {
    chState = { group: CH_ALL, actor: CH_ALL, from: "", to: "", page: 0 };
    if (tSel) tSel.value = CH_ALL;
    if (aSel) aSel.value = CH_ALL;
    if (from) from.value = "";
    if (to) to.value = "";
    renderChangeHistory();
  };
  await renderChangeHistory();
}
/* Every Owner-only action that writes an audit row — saving a setting, changing a role, creating a
   login, adding an introducer — happens ON the Settings page, directly above this panel, and none
   of them refreshed it: the log only re-read itself when the page loaded, so the Owner could do
   all four and watch the identical top row throughout. Navigating away and back showed the lot.

   This re-runs the query the Owner is ALREADY looking at. chState is left untouched, so the group,
   the who, the date range and the page they chose all survive the refresh — a write must not
   quietly throw their filters away and hand them back an unfiltered log. No-op when the panel
   isn't on screen (a non-Owner never has it) so callers don't have to check. */
async function refreshChangeHistory() {
  const panel = $("#change-history-panel");
  if (!panel || panel.classList.contains("hidden") || !isOwner() || !$("#ch-list")) return;
  await renderChangeHistory();
}

/* The case modal's own event log: the curated human timeline log_case_event writes, with the actor
   the trigger stamped on each row. The client modal shows the same rows merged into its Timeline. */
function eventTimelineHtml(events) {
  if (!events || !events.length) return '<div class="empty">No events recorded on this case yet.</div>';
  return events.map((ev) => `<div class="tl-row" data-cat="system" data-ts="${esc(ev.created_at)}">
      <span class="tl-ic">⚙️</span>
      <div class="tl-main">
        <div class="tl-title">${esc(ev.detail || ev.event || "Event")}${eventActorHtml(ev.actor)}</div>
        <div class="tl-meta"><span class="tl-case">${esc(String(ev.event || "").replace(/_/g, " "))}</span><span class="tl-ago">${esc(tlWhen(ev.created_at))}</span></div>
      </div>
    </div>`).join("");
}

/* T1-2 — `focus` ("email" | "phone") and `attempted` come from a failed message's "Fix contact"
   link: the contact section is opened and the offending field focused, and the address the send
   ACTUALLY used is printed next to it. Without that, the modal header shows the corrected address
   and there is nothing visibly wrong to fix. Both are optional; every other caller is unchanged. */
window.openClient = async function (id, focus, attempted) {
  let c = {};
  let cases = [];
  let tlItems = [];
  let dupOf = null; // { id, name } — set when this client is half of a flagged duplicate pair
  let auditRows = []; // audit_log for this client AND everything hanging off their cases
  if (id) {
    const [{ data: cl, error: clErr }, { data: cs }] = await Promise.all([
      db.from("clients").select("*").eq("id", id).single(),
      db.from("cases").select("*").eq("client_id", id).order("created_at", { ascending: false }),
    ]);
    if (clErr || !cl) return toast("Client not found — it may have been deleted or you don't have access.");
    c = cl; cases = cs || [];
    // audit_row() denormalises client_id onto the case/task/note/appointment rows too, so ONE
    // query returns the whole record's forensic history. Soft-failing: no history ≠ no modal.
    [tlItems, auditRows] = await Promise.all([buildClientTimeline(id, cases), loadAuditRows("client_id", id)]);
    // BUILD 7d (defect 31) — reuse Data Health's existing find_duplicate_clients RPC (no new
    // detection engine) so a duplicate spotted here, on the client record itself, can go straight
    // into the same merge modal Data Health uses — merge shouldn't require a detour via Data Health
    // first. Best-effort: any failure here just means no banner; the client still opens fine.
    try {
      // B6 / M4 — same "not a duplicate" filter Data Health applies: a dismissed pair must not
      // reappear as a banner here either, or "sticks" would only be true on one of the two pages.
      const [{ data: dups }, dismissRes] = await Promise.all([
        db.rpc("find_duplicate_clients"),
        db.from("duplicate_dismissals").select("a_id,b_id"),
      ]);
      const dismissedSet = new Set((Array.isArray(dismissRes?.data) ? dismissRes.data : []).map((r) => [r.a_id, r.b_id].sort().join("|")));
      const pair = (Array.isArray(dups) ? dups : []).find((d) => (d.a_id === id || d.b_id === id) && !dismissedSet.has([d.a_id, d.b_id].sort().join("|")));
      if (pair) dupOf = pair.a_id === id
        ? { id: pair.b_id, name: pair.b_name, reason: pair.reason, score: pair.score }
        : { id: pair.a_id, name: pair.a_name, reason: pair.reason, score: pair.score };
    } catch (e) { /* no banner */ }
  }
  const multiCase = cases.length > 1;
  const caseLabelById = {};
  cases.forEach((x) => { caseLabelById[x.id] = timelineCaseLabel(x); }); // R5-16 — kind · lender
  // Quick-add target: OPEN cases (not completed/not_proceeding); default the most recently updated one.
  const openCases = cases.filter((x) => x.stage !== "completed" && x.stage !== "not_proceeding");
  const defaultCase = openCases.length
    ? openCases.slice().sort((a, b) => (String(b.updated_at || "") < String(a.updated_at || "") ? -1 : 1))[0]
    : (cases[0] || null);
  const showCaseSel = openCases.length > 1; // selector only when the client has >1 OPEN case
  /* T1-25 — the Log call chip used to render only for a client with exactly ONE open case, i.e. it
     disappeared for precisely the clients where deciding where to log is hardest. It now renders
     for any client with a case and routes to whatever the #tl-case selector is showing (the same
     target the typed-note quick-add already uses), falling back to the default case. */
  const logCallTarget = defaultCase;
  const caseSelHtml = showCaseSel
    ? `<select id="tl-case" class="tl-case-sel" aria-label="Case for this note">${openCases.map((oc) => `<option value="${esc(oc.id)}" ${defaultCase && oc.id === defaultCase.id ? "selected" : ""}>${esc(caseLabelById[oc.id])}</option>`).join("")}</select>`
    : "";
  const timelineHtml = id ? `
    <div class="tl-section">
      <h3 style="font-size:14px;margin:0 0 2px;">Timeline</h3>
      <div class="tl-add">
        <input id="tl-note" placeholder="Add a note…" autocomplete="off">
        ${caseSelHtml}
        <button type="button" class="btn btn-sm btn-primary" id="tl-add-btn">Add</button>
      </div>
      <div class="type-chips" id="tl-type-chips">
        <button type="button" class="tl-chip active" data-type="note">📝 Note</button>
        <button type="button" class="tl-chip" data-type="call">📞 Call</button>
        <button type="button" class="tl-chip" data-type="email">✉️ Email</button>
        <button type="button" class="tl-chip" data-type="meeting">🤝 Meeting</button>
        ${logCallTarget ? `<button type="button" class="tl-chip tl-chip-logcall" id="tl-logcall-chip" title="${showCaseSel ? "Open the selected case's Log call panel" : `Open ${esc(caseLabelById[logCallTarget.id] || "the case")}'s Log call panel`}">📞 Log call</button>` : ""}
      </div>
      <div class="tl-filters" id="tl-filters">${TL_CATS.map(([k, l]) => `<button type="button" class="tl-chip tl-filter ${k === "all" ? "active" : ""}" data-cat="${k}">${esc(l)}</button>`).join("")}</div>
      <div class="tl-list" id="tl-list">${renderTimelineList(tlItems, "all", 100, multiCase)}</div>
      ${auditPanelHtml("client-audit", auditRows)}
    </div>` : "";
  $("#modal").innerHTML = `
    <h3>${id ? "Client details" : "New client"}</h3>
    ${id && (c.phone || c.email) ? `<p class="panel-sub client-contact-line" style="margin-top:-8px;display:flex;gap:16px;flex-wrap:wrap;">${c.phone ? "📞 " + telLink(c.phone) : ""}${c.email ? "✉️ " + mailLink(c.email) : ""}</p>` : ""}
    ${/* A merge DELETES the absorbed client, so the merge tool is Owner/Administrator only for the
          same reason Delete client is — RLS refuses the delete for an adviser. An adviser still
          gets the duplicate WARNING (useful), just not the action. */ ""}
    ${dupOf ? (isAdminOrOwner()
      ? `<p class="dup-hint">Possible duplicate of <strong>${esc(dupOf.name)}</strong> — <a href="javascript:void(0)" onclick="openMergeClients('${esc(id)}','${esc(dupOf.id)}','${jsArg(dupOf.reason)}',${Number(dupOf.score) || 0})">Review &amp; merge</a></p>`
      : `<p class="dup-hint">Possible duplicate of <strong>${esc(dupOf.name)}</strong> — ask an Administrator or the Owner to merge them.</p>`) : ""}
    ${timelineHtml}
    <details class="case-details client-details" ${id && !focus ? "" : "open"}>
      <summary>Client details</summary>
      ${attempted ? `<p class="dq-notice bad" id="client-attempted">Last send attempted: <strong>${esc(attempted)}</strong> — that ${focus === "phone" ? "number" : "address"} failed. Correct the ${focus === "phone" ? "phone" : "email"} below, then retry the message.</p>` : ""}
      <form id="client-form" class="form-grid">
      <label>First name<input name="first_name" required value="${esc(c.first_name)}"></label>
      <label>Last name<input name="last_name" required value="${esc(c.last_name)}"></label>
      <label>Email<input name="email" type="email" value="${esc(c.email)}"></label>
      <label>Phone<input name="phone" value="${esc(c.phone)}"></label>
      <label>Date of birth<input name="date_of_birth" type="date" value="${c.date_of_birth ?? ""}"></label>
      <label>SMS opt-out
        <select name="sms_opt_out">
          <option value="0" ${c.sms_opt_out ? "" : "selected"}>No</option>
          <option value="1" ${c.sms_opt_out ? "selected" : ""}>Yes</option>
        </select>
      </label>
      <label>Marketing opt-out
        <select name="marketing_opt_out">
          <option value="0" ${c.marketing_opt_out ? "" : "selected"}>No</option>
          <option value="1" ${c.marketing_opt_out ? "selected" : ""}>Yes</option>
        </select>
      </label>
      <label class="full">Address<input name="address" value="${esc(c.address)}"></label>
      <label class="full">Notes<textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
      </form>
    </details>
    ${id ? `<div style="margin-top:14px;"><h3 style="font-size:14px;">Cases</h3>
      ${cases.map((x) => `<div class="row-item"><div class="row-main">
        <div class="t" onclick="closeModal();openCase('${x.id}')">${esc(x.lender || KINDS.find(k=>k[0]===x.case_kind)?.[1] || "Case")} ${x.loan_amount ? "· " + fmtM(x.loan_amount) : ""}</div>
        <div class="s">Started ${fmtD(x.created_at)}${x.rate_end_date ? " · rate ends " + fmtD(x.rate_end_date) : ""}</div></div>
        ${x.assigned_to ? assigneeChipHtml(x.assigned_to) : '<span class="chip" title="No adviser assigned">—</span>'}
        <span class="badge blue">${STAGE_LABEL[x.stage] || x.stage}</span></div>`).join("") || '<div class="empty">No cases yet.</div>'}
    </div>` : ""}
    <div class="modal-actions">
      ${/* BACKEND-R4 §1 — deleting a client is Owner/Administrator only, enforced by RLS. */ ""}
      <div>${id && isAdminOrOwner() ? '<button class="btn btn-ghost btn-danger" id="del-client-btn">Delete client</button>' : ""}</div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  // T1-2 — deep-linked from a failed send: open the (normally collapsed) contact section and put
  // the cursor in the field that has to change. openModal() focuses the first control, so this has
  // to run after it.
  if (focus) {
    const det = $("#modal .client-details"); if (det) det.open = true;
    const fld = $(`#client-form [name="${focus === "phone" ? "phone" : "email"}"]`);
    if (fld) {
      try { fld.scrollIntoView({ block: "center" }); } catch (e) { /* older browsers */ }
      fld.focus();
      if (fld.select) fld.select();
    }
  }
  pushModalHistory("client", id); // BUILD 7a — Back closes this modal
  if (id) wireAuditPanel("client-audit", auditRows);
  $("#modal-cancel").onclick = closeModalGuarded; // defect 2 — Cancel is a "leave" path: it must warn about unsaved edits too
  $("#modal-save").onclick = async () => {
    const f = new FormData($("#client-form"));
    const row = {};
    for (const [k, v] of f.entries()) row[k] = v.trim() || null;
    // Real booleans / typed date for the comms fields (the loop above stringifies everything)
    row.sms_opt_out = f.get("sms_opt_out") === "1";
    row.marketing_opt_out = f.get("marketing_opt_out") === "1";
    row.date_of_birth = (f.get("date_of_birth") || "").trim() || null;
    if (!row.first_name || !row.last_name) return toast("First and last name are required");
    /* T1-9 — Save is a plain button outside any submit flow, so the email input's type="email" is
       never checked by the browser: "totally not an email" saved cheerfully, and the same typo then
       counted as "has an email" in every health check. Block on the helpers the rest of the app
       already sends with, so a typo can't score as a fix. Empty stays allowed — a missing detail is
       a different (and already-reported) problem from a wrong one. */
    if (row.email && !isValidEmailLike(row.email)) return toast(`"${row.email}" isn't a valid email address — not saved`);
    if (row.phone && !isValidPhoneLike(row.phone)) return toast(`"${row.phone}" isn't a valid phone number — UK numbers need 11 digits (e.g. 07700 900123). Not saved.`);
    const q = id ? db.from("clients").update(row).eq("id", id) : db.from("clients").insert(row);
    const { error } = await q;
    if (error) return toast("Error: " + error.message);
    // T1-11 — a client save can resolve (or create) a watchtower alert, so re-run the checker here
    // as well; the case save path gets it via loadDashboard. Guarded: a failing RPC must not stop
    // the save being reported as done.
    try { await db.rpc("run_watchtower"); } catch (e) { /* alerts just stay as they were */ }
    closeModal(); toast("Client saved"); loadClients();
    // If the client was opened from Data health (that page sits behind the modal), refresh its
    // lists/KPIs so a just-fixed row (e.g. missing email) doesn't linger stale until manual Refresh.
    if ($("#page-data") && !$("#page-data").classList.contains("hidden")) loadDataHealth();
    // BUILD 7d (defect 29) — same pattern: a "Fix contact" link on a failed email/SMS opens this
    // modal with the Emails page still open behind it. Refresh it so the just-fixed phone/email
    // stops looking broken in the list without a manual Refresh.
    if ($("#page-emails") && !$("#page-emails").classList.contains("hidden")) loadEmails();
  };
  if (id) {
    // ---- Timeline interactions (SP3b) — filters, typed quick-add, show-more; all in place ----
    let tlFilter = "all", tlCap = 100;
    const rerenderTl = () => {
      const list = $("#tl-list");
      if (!list) return;
      list.innerHTML = renderTimelineList(tlItems, tlFilter, tlCap, multiCase);
      const more = $("#tl-more");
      if (more) more.onclick = () => { tlCap += 100; rerenderTl(); };
    };
    const more0 = $("#tl-more"); if (more0) more0.onclick = () => { tlCap += 100; rerenderTl(); };
    // Type chips (single-select, default Note) — shared class with the case modal. The Log call
    // chip (below) is excluded here: it's a one-shot action, not a typed-note type to select.
    const typeChips = $("#tl-type-chips");
    if (typeChips) typeChips.querySelectorAll(".tl-chip:not(.tl-chip-logcall)").forEach((b) => b.onclick = () => {
      const cur = $("#tl-type-chips .tl-chip.active"); if (cur) cur.classList.remove("active");
      b.classList.add("active");
      const inp = $("#tl-note"); if (inp) inp.focus();
    });
    // BUILD 7d (composer lite) — "Log call" chip: skip the typed-note flow entirely and jump
    // straight to a case's real Log call panel (outcome + follow-up chips), the tool Sarah calls
    // "exactly right". T1-25: the case it routes to is whatever the #tl-case selector is showing —
    // the same target the typed-note quick-add uses — so a multi-case client gets it too.
    const logcallChip = $("#tl-logcall-chip");
    if (logcallChip) logcallChip.onclick = async () => {
      const chipCaseSel = $("#tl-case");
      const targetCaseId = (chipCaseSel && chipCaseSel.value) || (logCallTarget && logCallTarget.id);
      if (!targetCaseId) return;
      closeModal();
      await openCase(targetCaseId);
      const btn = $("#cs-logcall-btn");
      if (btn) btn.click();
    };
    // Filter chips — re-render just the list node (no full modal re-render).
    const filterWrap = $("#tl-filters");
    if (filterWrap) filterWrap.querySelectorAll(".tl-filter").forEach((b) => b.onclick = () => {
      const cur = $("#tl-filters .tl-filter.active"); if (cur) cur.classList.remove("active");
      b.classList.add("active");
      tlFilter = b.dataset.cat; tlCap = 100;
      rerenderTl();
    });
    // Quick-add: prefix by the active type chip, save to case_notes, prepend into the timeline in place.
    const submitTlNote = async () => {
      const inp = $("#tl-note");
      const raw = (inp.value || "").trim();
      if (!raw) return;
      const typeBtn = $("#tl-type-chips .tl-chip.active");
      const ntype = (typeBtn && typeBtn.dataset.type) || "note";
      const body = (NOTE_PREFIX[ntype] || "") + raw;
      const caseSel = $("#tl-case");
      const targetCase = caseSel ? caseSel.value : (defaultCase ? defaultCase.id : null);
      if (!targetCase) return toast("This client has no case to attach the note to — add a case first.");
      const addBtn = $("#tl-add-btn"); if (addBtn) addBtn.disabled = true;
      try {
        const { data: { user } } = await db.auth.getUser();
        const { error } = await db.from("case_notes").insert({ case_id: targetCase, body, created_by: (user && user.id) || null });
        if (error) return toast("Error: " + error.message);
        const nt = noteType(body);
        // Insert in place, then re-sort so the newest-first invariant holds even when future-dated
        // appointments sit above "now" (no DB refetch, no full modal re-render).
        /* R5-53 — the case-notes path stamps the author chip on a new note immediately; this one
           built its row by hand and left it off, so the same note looked authorless here and
           attributed there until the next reload. */
        tlItems.push({ ts: new Date().toISOString(), cat: nt.type, icon: nt.icon, title: (esc(nt.cleanBody) || "(note)") + authorChipHtml((user && user.id) || null), caseLabel: caseLabelById[targetCase] });
        tlItems.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        inp.value = "";
        // Reset to All so the just-added note is always visible at the top.
        tlFilter = "all"; tlCap = 100;
        const fcur = $("#tl-filters .tl-filter.active"); if (fcur) fcur.classList.remove("active");
        const fall = $('#tl-filters .tl-filter[data-cat="all"]'); if (fall) fall.classList.add("active");
        rerenderTl();
        inp.focus();
        toast("Note added ✓");
      } finally { if (addBtn) addBtn.disabled = false; }
    };
    const addBtnEl = $("#tl-add-btn"); if (addBtnEl) addBtnEl.onclick = submitTlNote;
    const tlNoteEl = $("#tl-note"); if (tlNoteEl) tlNoteEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitTlNote(); } });

    const delClientBtn = $("#del-client-btn"); // absent for an adviser — see the modal-actions block above
    if (delClientBtn) delClientBtn.onclick = async () => {
      const completed = cases.filter((x) => x.stage === "completed").length;
      const extra = completed
        ? `⚠ This client has ${completed} COMPLETED case${completed === 1 ? "" : "s"} with regulated records that will be permanently destroyed.`
        : null;
      if (!confirmHardDelete("Delete this client and all their cases?", extra)) return;
      const { error } = await db.from("clients").delete().eq("id", id);
      if (error) return toast("Error: " + error.message);
      closeModal(); toast("Client deleted"); loadClients();
    };
  }
};

/* ---------- Emails ---------- */
// BUILD 7d (defect 29) — a failure reason that plainly points at a bad contact detail (bounce,
// invalid number, disconnected, …) rather than a transient sender problem. Deliberately narrow: a
// generic timeout/rate-limit error shouldn't offer a contact-fix link that has nothing to do with it.
function isBadContactError(err) {
  return !!err && /bounc|invalid|undeliverable|no longer|disconnected|doesn.t exist|not a valid/i.test(err);
}
/* R5-43 — the OTHER kind of contact failure: not a bad address, but no address at all. These rows
   said "failed · No recipient address …" and offered nothing but Retry, which re-failed for exactly
   the same reason, forever. They're a client-record problem, so they get the same Fix contact route
   as a bounce — and their title opens the CLIENT (where the missing email lives), not the case. */
function isMissingContactError(e) {
  if (!e || e.status !== "failed") return false;
  if (!e.to_email) return true;
  return /no email|no recipient|missing client|no address/i.test(e.error || "");
}
async function loadEmails() {
  // R5-1 — an adviser has no business flushing the firm's queue; the button is Owner/Admin only
  // (the click handler refuses too — this just stops it looking available).
  const runBtn = $("#run-now-btn");
  if (runBtn) runBtn.classList.toggle("hidden", !isAdminOrOwner());
  const failedOnly = $("#email-failed-only") && $("#email-failed-only").checked;
  // R5-51 — the client's CURRENT email comes back with each row so a queued row addressed to an
  // address the client has since changed can be spotted before it sends to the old one.
  const { data: emails, error } = await db.from("email_queue")
    .select("*, clients(first_name,last_name,email)")
    .order("created_at", { ascending: false }).limit(100);
  if (error) { renderLoadError("#email-list", error, loadEmails); return; }
  const badge = { queued: "amber", sent: "green", failed: "red", cancelled: "grey" };
  const emailRows = failedOnly ? (emails || []).filter((e) => e.status === "failed") : (emails || []);
  // Retry-all-failed (defect 28) — only surfaces once the Failed-only filter narrows the list down
  // to what it would act on, so it never fires against emails that are queued/sent/cancelled.
  const retryAllEmailBtn = failedOnly && emailRows.length
    ? `<div class="row-item" style="justify-content:flex-end;"><button class="btn btn-sm btn-primary" onclick="retryAllFailedEmails()">Retry all failed (${emailRows.length})</button></div>` : "";
  // BUILD 7c — bulk-select on failed email rows. Prune the selection to what's currently shown, then
  // render checkboxes on failed rows and a slim action bar (mirrors the pipeline bulk bar).
  const failedIds = new Set(emailRows.filter((e) => e.status === "failed").map((e) => e.id));
  [...emailSel].forEach((id) => { if (!failedIds.has(id)) emailSel.delete(id); });
  const emailBulkBar = `<div class="bulk-bar" id="email-bulk-bar"${emailSel.size ? "" : " hidden"}>
      <span class="bulk-bar-count"><strong id="email-bulk-n">${emailSel.size}</strong> selected</span>
      <button type="button" class="btn btn-sm btn-primary" id="email-bulk-retry">Retry selected (${emailSel.size})</button>
      <button type="button" class="btn btn-sm" id="email-bulk-clear">Clear</button>
    </div>`;
  $("#email-list").innerHTML = `<div class="panel">` + emailBulkBar + retryAllEmailBtn + (emailRows.length ? emailRows.map((e) => {
    const failed = e.status === "failed";
    // T1-2 — the diagnostic now survives a retry, so a just-re-queued row still explains itself
    // (and still offers Fix contact). Only a row that has actually sent/been cancelled drops it.
    const settled = e.status === "sent" || e.status === "cancelled";
    const errLine = e.error && !settled ? (failed ? " · " + esc(e.error) : " · re-queued — last error: " + esc(e.error)) : "";
    const noContact = isMissingContactError(e) && !!e.client_id;   // R5-43
    const clickable = failed && e.case_id;
    /* R5-51 — a queue row stores the address as it was WHEN it was queued. Fix the client's email
       after a send is queued and the row still goes to the old one, silently. Flag the divergence
       and offer the one-click correction while the row is still unsent. */
    const curEmail = (e.clients && e.clients.email) || "";
    const staleAddr = e.status === "queued" && !!e.client_id && !!curEmail && !!e.to_email
      && curEmail.trim().toLowerCase() !== String(e.to_email).trim().toLowerCase();
    const fixContact = noContact || (!settled && e.client_id && isBadContactError(e.error));
    const titleClick = noContact
      ? ` onclick="openClient('${e.client_id}','email','${jsArg(e.to_email)}')" style="cursor:pointer;"`
      : (clickable ? ` onclick="openCase('${e.case_id}')" style="cursor:pointer;"` : "");
    return `
    <div class="row-item">
      ${failed ? `<input type="checkbox" class="email-cb" data-id="${e.id}" aria-label="Select this failed email"${emailSel.has(e.id) ? " checked" : ""} onclick="event.stopPropagation()">` : ""}
      <div class="row-main">
        <div class="t"${titleClick}>${EMAIL_LABEL[e.email_type]} — ${esc(e.clients ? e.clients.first_name + " " + e.clients.last_name : e.to_email || "")}</div>
        <div class="s">${esc(e.to_email || (noContact ? "no address on file" : ""))} · ${e.sent_at ? "sent " + new Date(e.sent_at).toLocaleString("en-GB") : "created " + new Date(e.created_at).toLocaleString("en-GB")}${errLine}${staleAddr ? ` · now <strong>${esc(curEmail)}</strong>` : ""}</div>
      </div>
      ${staleAddr ? `<span class="badge amber" title="Queued to ${esc(e.to_email)}, but this client's email is now ${esc(curEmail)}">address changed since queued</span>` : ""}
      <span class="badge ${badge[e.status]}">${e.status}</span>
      ${staleAddr ? `<button class="btn btn-sm btn-primary" onclick="useCurrentEmailAddress('${e.id}','${e.client_id}')" title="Re-address this queued email to ${esc(curEmail)}">Use current address</button>` : ""}
      ${fixContact ? `<button class="btn btn-sm btn-ghost" onclick="openClient('${e.client_id}','email','${jsArg(e.to_email)}')" title="${noContact ? "This client has no email address on file — add one, then retry" : "This looks like a bad contact detail, not a one-off send failure"}">Fix contact</button>` : ""}
      ${failed ? `<button class="btn btn-sm" onclick="retryEmail('${e.id}')">Retry</button>` : ""}
    </div>`;
  }).join("") : `<div class="empty">${failedOnly ? "No failed emails." : "No emails yet. They'll appear here once automation runs or you trigger one from a case."}</div>`) + `</div>`;
  // Wire the failed-email bulk-select controls (imperative, no reload on toggle).
  document.querySelectorAll("#email-list .email-cb").forEach((cb) => (cb.onchange = () => {
    if (cb.checked) emailSel.add(cb.dataset.id); else emailSel.delete(cb.dataset.id);
    updateEmailBulkBar();
  }));
  const emClear = $("#email-bulk-clear");
  if (emClear) emClear.onclick = () => {
    emailSel.clear();
    document.querySelectorAll("#email-list .email-cb").forEach((cb) => (cb.checked = false));
    updateEmailBulkBar();
  };
  const emRetry = $("#email-bulk-retry");
  if (emRetry) emRetry.onclick = () => bulkRetryEmails();

  const { data: sms, error: smsErr } = await db.from("sms_queue")
    .select("*, cases(*), clients(*)")
    .order("created_at", { ascending: false }).limit(100);
  if (smsErr) { renderLoadError("#sms-list", smsErr, loadEmails); return; }
  const smsBadge = { queued: "amber", sending: "blue", sent: "green", failed: "red", cancelled: "grey" };
  const smsRows = failedOnly ? (sms || []).filter((s) => s.status === "failed") : (sms || []);
  const retryAllSmsBtn = failedOnly && smsRows.length
    ? `<div class="row-item" style="justify-content:flex-end;"><button class="btn btn-sm btn-primary" onclick="retryAllFailedSms()">Retry all failed (${smsRows.length})</button></div>` : "";
  $("#sms-list").innerHTML = retryAllSmsBtn + (smsRows.length ? smsRows.map((s) => {
    const failed = s.status === "failed";
    const clickable = failed && s.case_id;
    const settled = s.status === "sent" || s.status === "cancelled";
    const errLine = s.error && !settled ? (failed ? " · " + esc(s.error) : " · re-queued — last error: " + esc(s.error)) : "";
    return `
    <div class="row-item">
      <div class="row-main">
        <div class="t"${clickable ? ` onclick="openCase('${s.case_id}')" style="cursor:pointer;"` : ""}>${esc(smsTypeLabel(s.sms_type))} — ${esc(s.clients ? [s.clients.first_name, s.clients.last_name].filter(Boolean).join(" ") : s.to_phone || "")}</div>
        <div class="s">${esc(s.to_phone || "")} · ${s.sent_at ? "sent " + new Date(s.sent_at).toLocaleString("en-GB") : "created " + new Date(s.created_at).toLocaleString("en-GB")}${errLine}</div>
      </div>
      <span class="badge ${smsBadge[s.status] || "grey"}">${esc(s.status)}</span>
      ${!settled && s.client_id && isBadContactError(s.error) ? `<button class="btn btn-sm btn-ghost" onclick="openClient('${s.client_id}','phone','${jsArg(s.to_phone)}')" title="This looks like a bad contact detail, not a one-off send failure">Fix contact</button>` : ""}
      ${failed ? `<button class="btn btn-sm" onclick="retrySms('${s.id}')">Retry</button>` : ""}
    </div>`;
  }).join("") : `<div class="empty">${failedOnly ? "No failed SMS." : "No SMS yet. They'll appear here once SMS automation runs or you send one."}</div>`);
}
/* T1-2 — a retry is only honest if it goes somewhere new. The queue row holds a SNAPSHOT of the
   address taken when the message was created, so re-queueing it unchanged re-sends to exactly the
   address that bounced, however carefully the client record was fixed afterwards. Re-read the
   client's current email/phone and either hand back a refreshed address to send to, or a reason why
   this row can't be re-queued at all. Returns {ok:true, value, name} or {ok:false, reason}. */
async function freshContactFor(clientId, kind, current) {
  const label = kind === "phone" ? "phone number" : "email address";
  const isValid = (v) => (kind === "phone" ? isValidPhoneLike(v) : isValidEmailLike(v));
  // No client to re-read (e.g. a message queued against a lead): the row's own address is the only
  // source there is, so retry on it if it's usable rather than refusing a legitimate retry.
  if (!clientId) {
    const own = String(current || "").trim();
    if (own && isValid(own)) return { ok: true, value: own, name: own };
    return { ok: false, reason: `this message isn't linked to a client and its ${label} (${own || "empty"}) isn't valid` };
  }
  const { data: cl, error } = await db.from("clients").select("first_name,last_name,email,phone").eq("id", clientId).single();
  if (error || !cl) return { ok: false, reason: "the client record couldn't be read" };
  const name = [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "This client";
  const raw = String((kind === "phone" ? cl.phone : cl.email) || "").trim();
  if (!raw) return { ok: false, reason: `${name} has no ${label} on file`, name };
  if (!isValid(raw)) return { ok: false, reason: `${name}'s ${label} (${raw}) still isn't valid`, name };
  return { ok: true, value: raw, name };
}
/* T1-2 — one honest summary line for the bulk paths: what actually went back on the queue vs what
   was deliberately left alone, naming the first blocked row so the fix has somewhere to start. */
function retryReport(ok, blocked) {
  let msg = `${ok} re-queued`;
  if (blocked.length) {
    msg += ` · ${blocked.length} blocked — fix the contact first (${blocked[0]}${blocked.length > 1 ? `, +${blocked.length - 1} more` : ""})`;
  }
  return msg;
}
/* T1-2 — `error` is deliberately NOT cleared here: it's the bounce diagnostic, and it's what makes
   the row's "Fix contact" link appear at all (isBadContactError). Clearing it on retry threw away
   the only evidence of what was wrong the moment someone tried to act on it. */
async function retryEmail(id, silent) {
  try {
    const { data: row, error: readErr } = await db.from("email_queue").select("id,client_id,to_email").eq("id", id).single();
    if (readErr || !row) { const reason = "this email couldn't be read"; if (!silent) toast("Not re-queued — " + reason); return { ok: false, reason }; }
    const fresh = await freshContactFor(row.client_id, "email", row.to_email);
    if (!fresh.ok) { if (!silent) toast("Not re-queued — " + fresh.reason); return fresh; }
    const { error } = await db.from("email_queue").update({ status: "queued", sent_at: null, to_email: fresh.value }).eq("id", id);
    if (error) { if (!silent) toast("Error: " + error.message); return { ok: false, reason: error.message }; }
    if (!silent) {
      toast(fresh.value === row.to_email ? "Email re-queued for sending" : `Email re-queued to ${fresh.value}`);
      loadEmails();
    }
    return { ok: true, value: fresh.value };
  } catch (e) { if (!silent) toast("Error: " + e.message); return { ok: false, reason: e.message }; }
}
/* R5-51 — re-address a STILL-QUEUED row to the client's current email. Deliberately narrow: the
   `.eq("status","queued")` guard means a row that sent between render and click is left alone (no
   rewriting history on a sent email), and nothing is sent here — the row waits its turn as before. */
window.useCurrentEmailAddress = async function (id, clientId) {
  const { data: cl, error: clErr } = await db.from("clients").select("email,first_name,last_name").eq("id", clientId).single();
  if (clErr || !cl) return toast("Couldn't read that client just now — try again in a moment.");
  const fresh = String(cl.email || "").trim();
  if (!fresh) return toast("That client has no email address on file — add one first.");
  const { data: upd, error } = await db.from("email_queue")
    .update({ to_email: fresh }).eq("id", id).eq("status", "queued").select("id");
  if (error) return toast("Error: " + error.message);
  if (!upd || !upd.length) { toast("That email is no longer queued — nothing changed."); return loadEmails(); }
  toast("This email will now go to " + fresh);
  loadEmails();
};
async function retrySms(id, silent) {
  try {
    const { data: row, error: readErr } = await db.from("sms_queue").select("id,client_id,to_phone").eq("id", id).single();
    if (readErr || !row) { const reason = "this SMS couldn't be read"; if (!silent) toast("Not re-queued — " + reason); return { ok: false, reason }; }
    const fresh = await freshContactFor(row.client_id, "phone", row.to_phone);
    if (!fresh.ok) { if (!silent) toast("Not re-queued — " + fresh.reason); return fresh; }
    const { error } = await db.from("sms_queue").update({ status: "queued", sent_at: null, to_phone: fresh.value }).eq("id", id);
    if (error) { if (!silent) toast("Error: " + error.message); return { ok: false, reason: error.message }; }
    if (!silent) {
      toast(fresh.value === row.to_phone ? "SMS re-queued for sending" : `SMS re-queued to ${fresh.value}`);
      loadEmails();
    }
    return { ok: true, value: fresh.value };
  } catch (e) { if (!silent) toast("Error: " + e.message); return { ok: false, reason: e.message }; }
}
// BUILD 7c — reflect the failed-email selection into its action bar (visibility + count + button
// label), without re-rendering the list.
function updateEmailBulkBar() {
  const bar = $("#email-bulk-bar");
  if (!bar) return;
  const n = emailSel.size;
  bar.hidden = n === 0;
  const nEl = $("#email-bulk-n"); if (nEl) nEl.textContent = n;
  const btn = $("#email-bulk-retry"); if (btn) btn.textContent = `Retry selected (${n})`;
}
// BUILD 7c — retry just the selected failed emails via the existing silent retry path, one summary
// toast (with an error tally), then refresh once.
async function bulkRetryEmails() {
  const ids = [...emailSel];
  if (!ids.length) return;
  let ok = 0; const blocked = [];
  for (const id of ids) {
    const r = await retryEmail(id, true);
    if (r && r.ok) ok++; else blocked.push((r && r.reason) || "it couldn't be re-queued");
  }
  toast(retryReport(ok, blocked));
  emailSel.clear();
  loadEmails();
}
// Retry-all-failed (defect 28) — loops the existing per-row retry (silently, to avoid a toast per
// row) then shows one summary toast and refreshes the list once.
window.retryAllFailedEmails = async function () {
  const { data: emails } = await db.from("email_queue").select("id").eq("status", "failed");
  const ids = (emails || []).map((e) => e.id);
  if (!ids.length) return toast("No failed emails to retry");
  let ok = 0; const blocked = [];
  for (const id of ids) {
    const r = await retryEmail(id, true);
    if (r && r.ok) ok++; else blocked.push((r && r.reason) || "it couldn't be re-queued");
  }
  toast(retryReport(ok, blocked));
  loadEmails();
};
window.retryAllFailedSms = async function () {
  const { data: sms } = await db.from("sms_queue").select("id").eq("status", "failed");
  const ids = (sms || []).map((s) => s.id);
  if (!ids.length) return toast("No failed SMS to retry");
  let ok = 0; const blocked = [];
  for (const id of ids) {
    const r = await retrySms(id, true);
    if (r && r.ok) ok++; else blocked.push((r && r.reason) || "it couldn't be re-queued");
  }
  toast(retryReport(ok, blocked));
  loadEmails();
};
$("#email-failed-only").addEventListener("change", loadEmails);
async function runSms(silent) {
  const { data: { session } } = await db.auth.getSession();
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const j = await r.json();
    if (!silent) toast(j.warning ? j.warning : `Done — ${j.sent || 0} sent, ${j.failed || 0} failed${j.appointment_queued ? `, ${j.appointment_queued} appointment reminders queued` : ""}`);
    loadEmails();
    return j;
  } catch (e) {
    if (!silent) toast("SMS error: " + e.message);
    return null;
  }
}
$("#run-sms-btn").addEventListener("click", () => runSms(false));
/* R5-1 (critical) — sending is no longer a side effect.
   process-emails v8 accepts `{queue_ids:[…]}`: given ids it sends ONLY those rows and skips the
   queueing RPCs entirely. Every per-case action (Send reminder, Chase fee, protection intro,
   lead welcome) passes the id of the single row it just inserted, so pressing one button can now
   only ever send one email. An empty body still means "run the whole firm's queue" — which is
   exactly what the cron does, and what the Run-automation-now button asks permission for. */
async function runAutomation(silent, opts) {
  const queueIds = opts && Array.isArray(opts.queueIds) ? opts.queueIds.filter(Boolean) : null;
  // A caller that MEANT to scope but has no ids must not fall through to a firm-wide flush.
  if (queueIds && !queueIds.length) return { sent: 0, failed: 0, scoped: true, skipped: true };
  const { data: { session } } = await db.auth.getSession();
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/process-emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(queueIds ? { queue_ids: queueIds } : {}),
    });
    const j = await r.json();
    /* G1I-S1 — silent callers (every per-case send) used to get the raw JSON back and test only
       `res.sent > 0`, so a 500, a 403 from the function's own authorize(), or an honest
       {sent:0,failed:1} all came out as the same reassuring "Email queued — check Emails tab".
       Under the auth condition PLAN-R5 flags for production, EVERY interactive send would have
       reported success-ish and nobody would ever have learned that sending was broken. Give the
       callers something they can tell apart. */
    const failure = (!r.ok && (j.error || `the send service returned HTTP ${r.status}`)) || j.error || null;
    if (!silent) toast(failure ? `Send failed: ${failure}` : j.warning ? j.warning : `Done — ${j.sent} sent, ${j.failed} failed, ${j.queued ? (j.queued.rate_reminders_queued + j.queued.review_requests_queued) : 0} newly queued`);
    loadEmails();
    return failure ? { ...j, sent: j.sent || 0, failed: j.failed || 0, error: failure } : j;
  } catch (e) {
    if (!silent) toast("Automation error: " + e.message);
    // Not null: "we could not reach the send service" is a different fact from "there was nothing
    // to send", and the per-case callers need to be able to say which happened.
    return { sent: 0, failed: 0, error: e.message, unreachable: true };
  }
}
/* G1I-S1/S2 — the one place that turns a runAutomation result into words for a per-case send, so
   "sent", "queued but the send failed" and "could not reach the send service" can never again be
   collapsed into the same sentence. The email row itself is already safely in the queue in every
   branch; what differs is whether the client has actually received anything. */
function sendResultToast(res, queuedMsg) {
  if (res && res.sent > 0) return toast("Email sent ✓");
  if (res && res.unreachable) return toast(`Email queued, but the send service could not be reached (${res.error}) — it stays in the queue; check the Emails tab.`);
  if (res && res.error) return toast(`Email queued, but sending it FAILED: ${res.error} — nothing has reached the client; see the Emails tab.`);
  if (res && res.failed > 0) return toast("Email queued, but the send service reported it as failed — nothing has reached the client; see the Emails tab.");
  return toast(queuedMsg);
}
/* R5-1 — the firm-wide flush is now deliberate: Owner/Administrator only, and it says out loud how
   many emails it is about to put in front of clients and who the first few are. Nothing is sent
   when the queue is empty (the old button cheerfully reported "0 sent" after a round trip). */
$("#run-now-btn").addEventListener("click", async () => {
  if (!isAdminOrOwner()) return toast("Sending the whole queue is Owner / Administrator only — use the action on the case instead.");
  const btn = $("#run-now-btn");
  if (btn) btn.disabled = true;
  try {
    /* G1I-Q1 — the confirmation used to count only the rows ALREADY in the queue, then call
       process-emails with an empty body. An unscoped run does the queueing RPCs FIRST
       (queue_automated_emails + queue_comms_extras), which write new rows scheduled for now, and
       then flushes everything due — including the rows it has just created. The Owner was asked
       permission to send 5 emails, shown 5 names, and 22 went out. Run the queueing step here,
       BEFORE asking, so the number in the confirm is the number that will land in clients' inboxes.
       Queueing is not sending: if the Owner cancels, those rows simply wait for tonight's cron,
       which would have created them anyway. */
    const qa = await db.rpc("queue_automated_emails");
    const qc = await db.rpc("queue_comms_extras");
    // Where the client isn't allowed to call the queueing RPCs directly, the send is scoped to the
    // exact rows named below instead — consent still matches what goes out, at the cost of leaving
    // the queueing to the cron.
    const queueingRan = !qa.error && !qc.error;
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await db.from("email_queue")
      .select("id,to_email,scheduled_for,clients(first_name,last_name)")
      .eq("status", "queued").order("scheduled_for");
    if (error) return toast("Couldn't read the queue: " + error.message);
    // `scheduled_for` in the future is a deliberately deferred send (e.g. a rate-end chase) — the
    // cron won't touch it yet and neither does this count, so the number matches what will go out.
    const due = (rows || []).filter((e) => !e.scheduled_for || e.scheduled_for <= nowIso);
    if (!due.length) return toast("Nothing is waiting to be sent — the queue is empty.");
    const who = due.slice(0, 5).map((e) => (e.clients ? [e.clients.first_name, e.clients.last_name].filter(Boolean).join(" ") : "") || e.to_email || "unknown recipient");
    const more = due.length > who.length ? ` …and ${due.length - who.length} more` : "";
    const newly = queueingRan
      ? Number((qa.data && (qa.data.rate_reminders_queued || 0)) || 0) + Number((qc.data && (qc.data.review_requests_queued || 0)) || 0)
      : 0;
    if (!confirm(`Send ALL ${due.length} queued email${due.length === 1 ? "" : "s"} now?`
      + `\n\nRecipients: ${who.join(", ")}${more}`
      + (newly ? `\n\n${newly} of these were queued just now by the automation (rate-end reminders and review requests that fell due).` : "")
      + `\n\nThis sends for the whole firm, not just your cases.`
      + `\nCancel sends nothing — anything queued stays in the queue for the overnight run.`)) return;
    // Unscoped = the cron's own behaviour (the queueing RPCs re-run harmlessly: everything they
    // would create has just been created and stamped). Scoped only where they could not be run.
    await runAutomation(false, queueingRan ? undefined : { queueIds: due.map((e) => e.id) });
  } finally {
    if (btn) btn.disabled = false;
  }
});

/* ---------- Bulk import (AI) ---------- */
let importRows = [];
let importAssignToMe = true; // defect 10: default new cases to the current user instead of unassigned

$("#import-file").addEventListener("change", async () => {
  const file = $("#import-file").files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      let text = "";
      wb.SheetNames.forEach((sn) => {
        text += `=== Sheet: ${sn} ===\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + "\n\n";
      });
      $("#import-text").value = text;
    } else {
      $("#import-text").value = await file.text();
    }
    $("#import-status").textContent = `Loaded ${file.name} — now press Analyse.`;
  } catch (e) {
    toast("Could not read file: " + e.message);
  }
});

$("#analyse-btn").addEventListener("click", async () => {
  const content = $("#import-text").value.trim();
  if (!content) return toast("Paste some data or choose a file first");
  $("#analyse-btn").disabled = true;
  $("#import-status").textContent = "AI is sorting the data — up to a minute for big files…";
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const j = await r.json();
    if (!r.ok || j.error) { $("#import-status").textContent = ""; return toast("Error: " + (j.error || r.status)); }
    importRows = j.rows || [];
    // R5-23a — one clients fetch feeds every row's match; runImport re-reads it before writing so a
    // record created since Analyse can't be duplicated.
    importClients = await fetchMatchClients();
    $("#import-status").textContent = `${importRows.length} records found.`;
    renderImportPreview();
  } catch (e) {
    $("#import-status").textContent = "";
    toast("Error: " + e.message);
  } finally {
    $("#analyse-btn").disabled = false;
  }
});

/* T1-21 — every date field on an import row, resolved once so the preview and the insert can never
   disagree about what "01/02/2026" meant. */
const IMPORT_DATE_FIELDS = [["rate_end_date", "Rate ends"], ["erc_end_date", "ERC ends"], ["completed_date", "Completed"]];
/* ---- "completed but no completion date" (T1-honestfix defect 3, reworked by T1-finalfix finding 1)

   A row that lands at stage "completed" with no readable completion date imports with
   completed_at: null — the exact gap Data Health's "Completed, no completion date" tile exists to
   catch. The first cut of this rule simply unticked EVERY such row with no per-row way back (only
   the all-or-nothing header select-all), and the result message never mentioned what had happened,
   so the silent-bad-data problem just moved one step later. Worse, it fired on rows whose
   "completed" stage was never asserted by the source at all, which made a plain CSV import a no-op.

   Two pieces now:
   1. WHEN TO FLAG. `stage` reaches importRows straight from the ai-import function's reading of the
      pasted text, and the app itself defaults a missing stage ("stage: r.stage || 'enquiry'" in
      runImport). A "completed" that is a default/fill-in rather than something the source said is
      not evidence of completion, and must not untick a row. We treat the analyser as having read
      completion for a row only when it reported the completion-date field for that row at all —
      present but blank/unreadable means "the source has a completion column and this row's cell is
      empty", which IS the source saying "completed, date missing". A row where the field was never
      reported gets the visible amber flag (so nothing is hidden) but stays ticked, and the import
      result counts it either way, so it can never land silently.
   2. HOW TO RESOLVE IT. Exactly like the ambiguous-date flag it was modelled on: a per-row button
      ("Import with no date") that consciously accepts a null completion date, plus the row's own
      Stage select — dropping it off "Completed & closed" clears the flag too. No date is ever
      invented. */
const impSourceStatedCompleted = (r) => !!r && r.stage === "completed" && Object.prototype.hasOwnProperty.call(r, "completed_date");
const impCompletedNoDate = (r) => !!r && r.stage === "completed" && parseUkDate(r.completed_date).empty;
// Needs a human before it can be ticked: the source says completed, no date, nobody has accepted it.
const impNoDateUnresolved = (r) => impCompletedNoDate(r) && impSourceStatedCompleted(r) && !r._no_date_ok;
function impDateFlags(r) {
  const out = {};
  let flagged = false;
  IMPORT_DATE_FIELDS.forEach(([f]) => {
    const p = parseUkDate(r[f]);
    out[f] = p;
    if (!p.empty && (!p.ok || p.ambiguous)) flagged = true;
  });
  if (impNoDateUnresolved(r)) flagged = true;
  out.noDate = impCompletedNoDate(r);
  out.noDateUnresolved = impNoDateUnresolved(r);
  out.flagged = flagged;
  return out;
}
// One preview cell for a date: amber with the interpretation + a Confirm button when it needs a human.
function impDateCell(r, i, field, extraHtml) {
  const p = parseUkDate(r[field]);
  if (p.empty) {
    // Completed with nothing to fall back on — flag it rather than let a guessed date reach the
    // cases table and feed Reports' money figures as though it were real (defect 3).
    if (field === "completed_date" && impCompletedNoDate(r)) {
      if (impNoDateUnresolved(r)) {
        return `<td class="imp-date-warn" data-cell="${esc(field)}" title="The source marks this case completed but gives no completion date. It would import with none set and be listed on Data health as &quot;Completed, no completion date&quot;. Accept that, or change the row's Stage.">— <span class="badge amber">no date</span>
          <button type="button" class="btn btn-sm imp-nodate-ok" data-i="${i}" title="Import this case as completed with no completion date — nothing is invented, and Data health will list it until someone fills it in">Import with no date</button></td>`;
      }
      if (r._no_date_ok) {
        return `<td class="imp-date-warn" data-cell="${esc(field)}" title="Accepted: this case will import as completed with completed_at left empty, and will be listed on Data health as &quot;Completed, no completion date&quot; until someone fills it in.">— <span class="badge amber">no date — accepted</span></td>`;
      }
      // Stage is "completed" but the source never reported a completion field for this row, so the
      // stage is a default rather than a statement. Show the flag; don't untick over it.
      return `<td class="imp-date-warn" data-cell="${esc(field)}" title="No completion date came through for this row, and the source never said whether the case was completed — the stage shown is a fallback. It will import with no completion date and be listed on Data health as &quot;Completed, no completion date&quot;. Change the Stage if that is wrong.">— <span class="badge amber">no date</span></td>`;
    }
    return `<td data-cell="${esc(field)}"></td>`;
  }
  if (!p.ok) {
    return `<td class="imp-date-bad" data-cell="${esc(field)}" title="${esc(p.note || "unreadable date")}">${esc(p.raw)} <span class="badge red">can't read</span></td>`;
  }
  if (p.ambiguous) {
    return `<td class="imp-date-warn" title="${esc(p.note || "")}">${esc(p.raw)} → ${esc(fmtD(p.iso))}?
      <button type="button" class="btn btn-sm imp-date-ok" data-i="${i}" data-field="${esc(field)}" data-iso="${esc(p.iso)}" title="Confirm this reading and re-tick the row">Confirm</button></td>`;
  }
  return `<td data-cell="${esc(field)}">${esc(fmtD(p.iso))}${extraHtml || ""}</td>`;
}

/* ---------- R5-23a / R5-23b — the import preview says who each row will land on ----------
   The old preview showed the data and hid the decision: at save time a row silently attached to any
   client with the same email or the same sorted name key, and any incoming email/phone that
   disagreed with what we already held was dropped on the floor (only a BLANK stored field was ever
   filled). Two rows of the same file could therefore mean "new client" and "amend Ruby's record"
   with nothing on screen to tell them apart.

   Now every row resolves to a visible decision before anything is written:
     green  "→ attaches to X"   — an exact match (email / phone / name with nothing contradicting it)
     amber  "possible: X"       — a candidate that needs a human: Attach or New client
     blank                      — no candidate, this creates a client
   The choice lives on the row (`_match_client_id` / `_force_new`) and re-derives whenever the row's
   name, email or phone is edited, so the preview and the insert can never disagree. Where an
   attaching row's email/phone differ from the stored value, the row expands into a merge-modal-style
   per-field picker (existing pre-selected — the import never overwrites a known contact detail
   without being told to) and whatever is NOT kept is named in the result panel. */
let importClients = [];   // one-shot clients fetch, refreshed on Analyse and again at save time

// The row's resolved decision: an explicit operator choice first, then the matcher's exact hit.
function impResolveMatch(r) {
  const m = findClientMatches({ name: r.client_name, email: r.email, phone: r.phone }, importClients);
  if (r._force_new) return { mode: "new", forced: true, near: m.near, exact: m.exact };
  if (r._match_client_id) {
    const chosen = importClients.find((c) => c.id === r._match_client_id);
    if (chosen) return { mode: "attach", client: chosen, chosen: true, reason: "you chose this client", near: m.near };
    // The chosen client is gone (merged/deleted since the preview was drawn) — fall through.
  }
  if (m.exact) return { mode: "attach", client: m.exact, reason: m.reason, near: m.near };
  if (m.near.length) return { mode: "undecided", near: m.near };
  return { mode: "new", near: [] };
}
// Which incoming contact details disagree with what the client record already holds.
function impConflicts(r, client) {
  const out = [];
  [["email", "Email"], ["phone", "Phone"]].forEach(([f, label]) => {
    const incoming = String(r[f] == null ? "" : r[f]).trim();
    const current = String(client[f] == null ? "" : client[f]).trim();
    if (!incoming || !current) return;                       // nothing to choose between
    const same = f === "phone" ? normPhone(current) === normPhone(incoming) : current.toLowerCase() === incoming.toLowerCase();
    if (!same) out.push({ field: f, label, current, incoming });
  });
  return out;
}
function impMatchCellHtml(r, i) {
  const d = impResolveMatch(r);
  if (d.mode === "attach") {
    const who = clientFullName(d.client) || d.client.email || d.client.phone || "this client";
    const badge = d.chosen ? "blue" : "green";
    return `<span class="badge ${badge}" title="${esc("Matched on " + (d.reason || "an existing record") + " — this row updates that client instead of creating a second one.")}">→ attaches to ${esc(who)}</span>
      <button type="button" class="btn btn-sm imp-match-new" data-i="${i}" title="Not the same person — create a new client record for this row">New client</button>`;
  }
  if (d.mode === "undecided") {
    const opts = d.near.map((n) => `<option value="${esc(n.client.id)}">${esc(clientFullName(n.client) || n.client.email || "(no name)")}${n.client.email ? " — " + esc(n.client.email) : ""} · ${esc(n.reason)}</option>`).join("");
    return `<span class="badge amber" title="${esc("Possible existing client (" + d.near[0].reason + "). Nothing is attached until you choose.")}">possible: ${esc(clientFullName(d.near[0].client) || d.near[0].client.email || "")}</span>
      ${d.near.length > 1 ? `<select class="imp-match-pick" data-i="${i}" title="Which existing client">${opts}</select>` : ""}
      <button type="button" class="btn btn-sm imp-match-attach" data-i="${i}" title="Attach this row's case to that existing client">Attach</button>
      <button type="button" class="btn btn-sm imp-match-new" data-i="${i}" title="Different person — create a new client record">New client</button>`;
  }
  if (d.forced || (d.near && d.near.length)) {
    return `<span class="s">new client</span>
      <button type="button" class="btn btn-sm imp-match-undo" data-i="${i}" title="Undo — look at the possible matches again">undo</button>`;
  }
  return "";
}
// The inline expander: one radio pair per disagreeing field, existing pre-selected.
function impConflictRowHtml(r, i) {
  const d = impResolveMatch(r);
  if (d.mode !== "attach") return "";
  const conflicts = impConflicts(r, d.client);
  if (!conflicts.length) return "";
  const picks = r._conflict_choice || {};
  const who = clientFullName(d.client) || "this client";
  const rows = conflicts.map((c) => {
    const keepIncoming = picks[c.field] === "incoming";
    return `<tr>
      <td>${esc(c.label)}</td>
      <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" class="imp-conf-radio" name="imp-conf-${i}-${c.field}" data-i="${i}" data-field="${esc(c.field)}" value="existing" ${keepIncoming ? "" : "checked"} style="width:auto;margin-top:3px;"> ${mergeFieldDisplay(c.field, c.current)} <span class="s">on record</span></label></td>
      <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" class="imp-conf-radio" name="imp-conf-${i}-${c.field}" data-i="${i}" data-field="${esc(c.field)}" value="incoming" ${keepIncoming ? "checked" : ""} style="width:auto;margin-top:3px;"> ${mergeFieldDisplay(c.field, c.incoming)} <span class="s">in this file</span></label></td>
    </tr>`;
  }).join("");
  return `<details class="imp-conflict" open>
      <summary>⚠ ${conflicts.length} detail${conflicts.length === 1 ? "" : "s"} disagree${conflicts.length === 1 ? "s" : ""} with ${esc(who)}'s record — choose which to keep</summary>
      <table class="imp-table merge-table">
        <tr><th>Field</th><th>Keep what's on record</th><th>Use what's in this file</th></tr>
        ${rows}
      </table>
      <p class="s">Whatever you don't keep is discarded — it's named in the summary after the import so nothing disappears quietly.</p>
    </details>`;
}
// Repaint just this row's match cell and its expander (a full re-render would throw away the
// operator's ticks), then leave the delegated handlers to pick the new controls up.
function impRepaintMatch(i) {
  const r = importRows[i];
  if (!r) return;
  const cell = document.querySelector(`.imp-match[data-i="${i}"]`);
  if (cell) cell.innerHTML = impMatchCellHtml(r, i);
  const conf = document.querySelector(`.imp-conf-cell[data-i="${i}"]`);
  if (conf) {
    const html = impConflictRowHtml(r, i);
    conf.innerHTML = html;
    const tr = conf.closest("tr");
    if (tr) tr.classList.toggle("hidden", !html);
  }
}

function renderImportPreview() {
  if (!importRows.length) { $("#import-preview").innerHTML = ""; return; }
  $("#import-preview").innerHTML = `
    <div class="panel">
      <h3>Review before saving</h3>
      <p class="panel-sub">Untick anything that shouldn't be imported. Click Client, Email, Stage, Lender or Rate to fix a misread field before importing. Estimated rate-end dates are marked ≈ and stay flagged until you confirm them. Dates are read UK-first (dd/mm/yyyy) — anything that could also be read the American way is shown amber with the reading we'll use, and its row starts unticked until you press Confirm. A case marked Completed with no completion date is shown amber with a “no date” flag: no date is ever invented for it, so where the source itself said the case was completed the row starts unticked until you either press “Import with no date” or change its Stage. Any case that does import without a completion date is counted in the message at the end and listed on Data health. The <strong>Match</strong> column says who each row will land on before anything is written: green attaches to a client we already hold, amber is a possible match that needs your Attach / New client decision, and a blank cell creates a new client. Where an attaching row's email or phone disagrees with the record, the row expands so you choose which to keep — what you don't keep is named in the summary afterwards.</p>
      <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin:4px 0 10px;">
        <input type="checkbox" id="imp-assign-me" style="width:auto;" ${importAssignToMe ? "checked" : ""}>
        Assign new cases to me — unticking leaves them unassigned (they'll appear in Data Health's unassigned list)
      </label>
      <div class="board-scroll-wrap">
      <div id="imp-scroll" style="overflow-x:auto;">
      <table class="imp-table">
        <tr><th><input type="checkbox" id="imp-all" checked></th><th class="stick-col">Client</th><th>Email</th><th>Phone</th><th>Match</th><th>Stage</th><th>Lender</th><th>Rate</th><th>Rate ends</th><th>ERC ends</th><th>Completed</th><th>Fee</th></tr>
        ${importRows.map((r, i) => `
        <tr>
          <td><input type="checkbox" class="imp-row" data-i="${i}" ${impDateFlags(r).flagged ? "" : "checked"}></td>
          <td class="imp-edit stick-col" contenteditable="true" spellcheck="false" data-i="${i}" data-field="client_name" title="Click to edit">${esc(r.client_name || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="email" title="Click to edit">${esc(r.email || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="phone" title="Click to edit">${esc(r.phone || "")}</td>
          <td class="imp-match" data-i="${i}">${impMatchCellHtml(r, i)}</td>
          <td><select class="imp-edit-stage" data-i="${i}" title="Click to edit">
            <option value="" ${!r.stage ? "selected" : ""}>contact only</option>
            ${STAGES.map(([k, l]) => `<option value="${k}" ${k === r.stage ? "selected" : ""}>${l}</option>`).join("")}
          </select></td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="lender" title="Click to edit">${esc(r.lender || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="rate_percent" title="Click to edit">${r.rate_percent != null ? r.rate_percent : ""}</td>
          ${impDateCell(r, i, "rate_end_date", r.rate_end_estimated ? ` <span class="badge purple" title="${TIP_APPROX}">≈</span>` : "")}
          ${impDateCell(r, i, "erc_end_date")}
          ${impDateCell(r, i, "completed_date")}
          <td>${r.broker_fee ? fmtM(r.broker_fee) : ""}</td>
        </tr>
        <tr class="imp-conf-tr${impConflictRowHtml(r, i) ? "" : " hidden"}"><td class="imp-conf-cell" colspan="12" data-i="${i}">${impConflictRowHtml(r, i)}</td></tr>`).join("")}
      </table>
      </div>
      <button type="button" class="board-scroll-arrow" aria-label="Scroll right" title="Scroll right">›</button>
      </div>
      <div style="margin-top:14px;">
        <button class="btn btn-primary" id="import-save-btn">Import selected</button>
      </div>
    </div>`;
  wireTableHScroll("imp-scroll");
  $("#imp-all").onchange = (e) => document.querySelectorAll(".imp-row").forEach((c) => (c.checked = e.target.checked));
  $("#imp-assign-me").onchange = (e) => { importAssignToMe = e.target.checked; };
  $("#import-save-btn").onclick = runImport;

  /* R5-23a/b — match + conflict controls are wired by delegation on the preview container, because
     a row's match cell and its expander are repainted in place whenever the row's identity fields
     change and a direct listener would be thrown away with the old markup. */
  const prev = $("#import-preview");
  prev.addEventListener("click", (e) => {
    const btn = e.target.closest(".imp-match-attach, .imp-match-new, .imp-match-undo");
    if (!btn) return;
    const i = Number(btn.dataset.i), r = importRows[i];
    if (!r) return;
    if (btn.classList.contains("imp-match-attach")) {
      const sel = document.querySelector(`.imp-match-pick[data-i="${i}"]`);
      const d = impResolveMatch(r);
      const id = (sel && sel.value) || (d.near[0] && d.near[0].client.id);
      if (!id) return;
      r._match_client_id = id; r._force_new = false;
    } else if (btn.classList.contains("imp-match-new")) {
      r._force_new = true; r._match_client_id = null; r._conflict_choice = null;
    } else {
      r._force_new = false; r._match_client_id = null;
    }
    impRepaintMatch(i);
  });
  prev.addEventListener("change", (e) => {
    const radio = e.target.closest(".imp-conf-radio");
    if (!radio) return;
    const i = Number(radio.dataset.i), r = importRows[i];
    if (!r) return;
    r._conflict_choice = r._conflict_choice || {};
    r._conflict_choice[radio.dataset.field] = radio.value;
  });

  // Editable preview cells write straight back into importRows[i], so a corrected value
  // (one misread field) feeds the existing import/insert path unchanged — no need to
  // reject and re-run the whole row through AI import again.
  document.querySelectorAll(".imp-edit").forEach((td) => {
    const commit = () => {
      const i = Number(td.dataset.i), field = td.dataset.field;
      if (!importRows[i]) return; // late blur after the preview was cleared post-import
      let val = td.textContent.trim();
      if (field === "rate_percent") {
        val = val.replace("%", "").trim();
        importRows[i][field] = val === "" ? null : Number(val);
      } else {
        importRows[i][field] = val || (field === "client_name" ? "" : null);
      }
      /* R5-23a — the identity fields decide who this row lands on, so correcting one re-runs the
         match. Any earlier Attach/New-client choice was made about a DIFFERENT set of details and
         is dropped rather than carried silently onto the new ones. */
      if (field === "client_name" || field === "email" || field === "phone") {
        importRows[i]._match_client_id = null;
        importRows[i]._force_new = false;
        importRows[i]._conflict_choice = null;
        impRepaintMatch(i);
      }
    };
    td.addEventListener("blur", commit);
    td.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); td.blur(); } });
  });
  /* T1-finalfix (finding 1) — the Stage select is the row's OTHER way out of the "completed with no
     completion date" flag: moving a row off "Completed & closed" means there is nothing left to be
     missing. Repaint just this row's Completed cell and re-tick/untick it only when the row's
     flagged state actually changed, so a row the operator unticked by hand stays unticked. */
  document.querySelectorAll(".imp-edit-stage").forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.dataset.i), r = importRows[i];
      if (!r) return;
      const was = impDateFlags(r).flagged;
      r.stage = sel.value || null;
      const now = impDateFlags(r).flagged;
      const cell = sel.closest("tr")?.querySelector('td[data-cell="completed_date"]');
      if (cell) { cell.outerHTML = impDateCell(r, i, "completed_date"); wireImportRowButtons(); }
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && was !== now) cb.checked = !now;
    };
  });
  wireImportRowButtons();
}

/* Per-row "this needs a human" buttons. Re-run after any cell is repainted in place, because
   replacing a <td> throws away its listeners. Both buttons resolve ONE flag on ONE row and then
   re-tick that row only if nothing else on it is still flagged — a row with both an ambiguous date
   and a missing completion date needs both confirmations. */
function wireImportRowButtons() {
  /* T1-21 — confirming an ambiguous date writes the ISO reading back into the row (so the cell and
     the insert can't drift apart) and re-ticks the row once nothing on it is still flagged. Only
     this row's cells are rewritten, so other rows keep whatever the user ticked/untickd. */
  document.querySelectorAll(".imp-date-ok").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i), field = btn.dataset.field;
      if (!importRows[i]) return;
      importRows[i][field] = btn.dataset.iso;
      const td = btn.closest("td");
      if (td) {
        td.className = ""; td.removeAttribute("title");
        td.innerHTML = esc(fmtD(btn.dataset.iso)) + (field === "rate_end_date" && importRows[i].rate_end_estimated ? ` <span class="badge purple" title="${TIP_APPROX}">≈</span>` : "");
      }
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && !impDateFlags(importRows[i]).flagged) cb.checked = true;
    };
  });
  /* T1-finalfix (finding 1) — accept a completed case that genuinely has no completion date. This
     records the operator's decision on the row only; NOTHING is written into completed_date, so the
     case still imports with completed_at empty and still shows up on Data health. */
  document.querySelectorAll(".imp-nodate-ok").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i), r = importRows[i];
      if (!r) return;
      r._no_date_ok = true;
      const td = btn.closest("td");
      if (td) td.outerHTML = impDateCell(r, i, "completed_date");
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && !impDateFlags(r).flagged) cb.checked = true;
      wireImportRowButtons();
    };
  });
}

async function runImport() {
  const selectedEls = [...document.querySelectorAll(".imp-row:checked")];
  const selected = selectedEls.map((c) => importRows[Number(c.dataset.i)]);
  if (!selected.length) return toast("Nothing selected");
  $("#import-save-btn").disabled = true;
  $("#import-status").textContent = "Saving…";
  /* R5-23a — re-read the clients table so the decision that gets written is made against the
     database as it is NOW, not as it was when Analyse ran; the preview is repainted from the same
     data so what the operator confirms is what happens. */
  importClients = await fetchMatchClients();
  const nameKey = clientNameKey;
  /* The save-time index is no longer the matcher — it now only dedupes rows against clients
     CREATED EARLIER IN THIS SAME RUN, so one file listing the same brand-new client twice still
     produces one record. Matching against existing clients is the row's visible decision. */
  const byName = {}, byEmail = {};
  let nClients = 0, nCases = 0, nUpdated = 0;
  // R5-23a/b reporting: what landed on an existing record, and what the operator chose not to keep.
  const attachedTo = new Map();     // client id -> name, for "N attached to existing"
  let nConflicts = 0;
  const conflictLog = [];           // {client, label, kept, discarded}
  const undecided = [];             // possible matches nobody resolved — they became new clients
  // T1-finalfix (finding 1) — counted from what was actually WRITTEN, not from what the preview
  // predicted, so the closing message can state the true end position.
  let nNoDate = 0;
  // G1I-I6 — cases that landed with no "AI bulk import" provenance note (that insert failing is not
  // worth failing the row over, but it must not be invisible either).
  let nNoProvenance = 0;
  const rowErrors = [];
  const touchedClients = new Map(); // id -> name, for the post-import "view what landed" summary (defect 30)

  for (let i = 0; i < selected.length; i++) {
    const r = selected[i];
    // G1I-I4 — staged until the row's writes have all succeeded (see where they are committed).
    const pendingConflicts = [];
    let pendingAttach = null;
    try {
      const nk = nameKey(r.client_name);
      const email = (r.email || "").trim().toLowerCase();
      if (!nk && !email) continue;
      /* T1-21 — normalise every date on the row to YYYY-MM-DD BEFORE anything is written, so a
         "01/02/2026" can never reach the cases table as a raw string. An unreadable date fails the
         row loudly (it lands in the errors table) rather than being silently dropped or mis-read. */
      const dates = {};
      for (let d = 0; d < IMPORT_DATE_FIELDS.length; d++) {
        const f = IMPORT_DATE_FIELDS[d][0];
        const p = parseUkDate(r[f]);
        if (!p.ok) throw new Error(`Couldn't read ${IMPORT_DATE_FIELDS[d][1].toLowerCase()} date “${p.raw}” (${p.note}) — fix it in the preview, then import again`);
        dates[f] = p.iso;
      }
      /* R5-23a — the row's own decision, exactly as the preview showed it (an explicit Attach /
         New client, else the exact match). An undecided possible-match creates a new client and is
         named in the result panel — nothing attaches to an existing person on a guess. */
      const decision = impResolveMatch(r);
      if (decision.mode === "undecided") {
        undecided.push({ row: r.client_name || email || "(no name)", candidate: clientFullName(decision.near[0].client) || decision.near[0].client.email || "an existing client" });
      }
      let client = decision.mode === "attach" ? decision.client : null;
      let attached = !!client;
      if (!client && !r._force_new) client = (email && byEmail[email]) || byName[nk] || null;  // same-run duplicate row
      if (!client) {
        // T1-22 — the shared splitter, so an imported client files exactly like an accepted lead.
        const nm = splitName(r.client_name);
        const { data, error } = await db.from("clients")
          .insert({ first_name: nm.first_name, last_name: nm.last_name, email: r.email || null, phone: r.phone || null })
          .select().single();
        if (error) throw error;
        client = data; nClients++;
        if (nk) byName[nk] = client;
        if (email) byEmail[email] = client;
        // Deliberately NOT added to importClients: a client created by this run belongs to the
        // same-run index above, so a second row for the same person still dedupes to one record
        // without being reported as "attached to an existing client" it never existed before.
      } else {
        /* R5-23b — an attaching row used to write ONLY into blank stored fields; anything that
           disagreed was dropped without a word. Blank fields still fill silently (nothing is lost),
           but a real disagreement was surfaced in the preview's expander and is applied here to the
           operator's pick — with the discarded value reported afterwards either way. */
        const picks = r._conflict_choice || {};
        const patch = {};
        if (r.email && !client.email) patch.email = r.email;
        if (r.phone && !client.phone) patch.phone = r.phone;
        if (attached) {
          /* G1I-I4 — these counters used to be incremented HERE, before the update that actually
             writes the operator's choice. When that update threw, the row landed in rowErrors but
             the headline had already counted the conflict as "resolved" and the client as
             "attached", so the summary read "1 field conflict resolved" over a phone number that
             was never written. Stage them; they are only counted once the write has succeeded. */
          impConflicts(r, client).forEach((c) => {
            const keepIncoming = picks[c.field] === "incoming";
            if (keepIncoming) patch[c.field] = c.incoming;
            pendingConflicts.push({
              client: clientFullName(client) || client.email || "(no name)",
              label: c.label,
              kept: keepIncoming ? c.incoming : c.current,
              discarded: keepIncoming ? c.current : c.incoming,
            });
          });
          pendingAttach = clientFullName(client) || client.email || client.phone || "(no name)";
        }
        if (Object.keys(patch).length) {
          const { error: upErr } = await db.from("clients").update(patch).eq("id", client.id);
          if (upErr) throw upErr;
          Object.assign(client, patch);
          if (client.email) byEmail[client.email.trim().toLowerCase()] = client;
          nUpdated++;
        }
      }

      const hasCase = r.stage || r.lender || r.rate_end_date || r.completed_date || r.rate_percent != null;
      if (hasCase) {
        const { data: nc, error } = await db.from("cases").insert({
          client_id: client.id,
          case_kind: r.case_kind || "other",
          stage: r.stage || "enquiry",
          lender: r.lender || null,
          product_name: r.product_name || null,
          rate_percent: r.rate_percent ?? null,
          rate_type: r.rate_type || null,
          rate_end_date: dates.rate_end_date,
          rate_end_estimated: !!r.rate_end_estimated,
          erc_end_date: dates.erc_end_date,
          loan_amount: r.loan_amount ?? null,
          property_value: r.property_value ?? null,
          broker_fee: r.broker_fee ?? null,
          completed_at: dates.completed_date ? new Date(dates.completed_date).toISOString() : null,
          assigned_to: importAssignToMe ? ((ME && ME.id) || null) : null,
        }).select("id").single();
        if (error) throw error;
        /* G1I-I6 — this note is the only record that a case arrived by bulk import rather than
           being keyed by a person, and it also carries the row's free-text `note` column, which is
           otherwise discarded. Unchecked, every one of them could fail and the summary said
           nothing. It does not fail the row (the case is real and worth keeping) — it is counted
           and named in the result. */
        const { error: noteErr } = await db.from("case_notes").insert({ case_id: nc.id, body: "AI bulk import" + (r.note ? " | " + r.note : "") });
        if (noteErr) nNoProvenance++;
        nCases++;
        if ((r.stage || "enquiry") === "completed" && !dates.completed_date) nNoDate++;
      }
      // G1I-I4 — the row is through: only now is the conflict counted as resolved and the client
      // counted as attached. A throw above leaves both untouched, so the headline can no longer
      // claim a write that never happened.
      nConflicts += pendingConflicts.length;
      pendingConflicts.forEach((c) => conflictLog.push(c));
      if (pendingAttach) attachedTo.set(client.id, pendingAttach);
      touchedClients.set(client.id, [client.first_name, client.last_name].filter(Boolean).join(" ") || client.email || client.phone || "(no name)");
      // Row succeeded — uncheck it so a retry after a partial failure doesn't
      // re-import this row and create duplicate cases.
      if (selectedEls[i]) selectedEls[i].checked = false;
    } catch (e) {
      rowErrors.push({ row: i + 1, name: r.client_name || "(no name)", error: e.message || String(e) });
      console.error(e);
    }
  }
  $("#import-status").textContent = "";
  $("#import-save-btn").disabled = false;
  const errs = rowErrors.length;
  /* T1-finalfix (finding 1) — the old message stopped at the three counts, so N completed cases
     could land with completed_at empty (invisible to every completion report) under a toast that
     read like a clean success. Name it. */
  const noDateMsg = nNoDate
    ? ` — ${nNoDate} completed case${nNoDate === 1 ? "" : "s"} imported with NO completion date (listed on Data health as “Completed, no completion date” until ${nNoDate === 1 ? "it is" : "they are"} filled in)`
    : "";
  /* R5-23a/b — the headline now states the thing the old one hid: how many rows landed on people we
     already had, and how many contact details had to be chosen between. */
  const nAttached = attachedTo.size;
  const matchMsg = `${nAttached} attached to existing · ${nClients} new${nConflicts ? ` · ${nConflicts} field conflict${nConflicts === 1 ? "" : "s"} resolved` : ""}`;
  // G1I-I6 — the provenance note is the only record that a case arrived by bulk import, and it
  // carries the row's free-text note. Losing it silently made an imported case indistinguishable
  // from a hand-keyed one.
  const noProvMsg = nNoProvenance
    ? ` — ${nNoProvenance} case${nNoProvenance === 1 ? "" : "s"} imported with NO “AI bulk import” note (${nNoProvenance === 1 ? "its" : "their"} import note and any free-text note on the row were not saved)`
    : "";
  toast(`Imported: ${matchMsg}, ${nCases} cases, ${nUpdated} contact updates${errs ? `, ${errs} failed` : ""}${noDateMsg}${noProvMsg}`);
  if (errs) {
    // Surface exactly which rows failed and why, so nothing is silently dropped.
    const errHtml = `<div class="panel"><h3>${errs} row${errs === 1 ? "" : "s"} could not be imported</h3>
      <table class="imp-table"><tr><th>Row</th><th>Name</th><th>Error</th></tr>
      ${rowErrors.map((e) => `<tr><td>${e.row}</td><td>${esc(e.name)}</td><td>${esc(e.error)}</td></tr>`).join("")}
      </table></div>`;
    $("#import-preview").insertAdjacentHTML("beforeend", errHtml);
  } else {
    importRows = []; $("#import-text").value = "";
    // Defect 30: don't just clear the preview to blank — leave a compact, clickable summary so
    // verification doesn't require a search (which may itself be broken for multi-word names).
    const names = [...touchedClients.entries()];
    $("#import-preview").innerHTML = names.length ? `
      <div class="panel">
        <h3>Imported: ${matchMsg} / ${nCases} case${nCases === 1 ? "" : "s"}</h3>
        ${nNoDate ? `<p class="panel-sub" style="color:var(--red);">⚠ ${nNoDate} of ${nCases === 1 ? "them" : `those ${nCases} cases`} imported as <strong>completed with no completion date</strong> — no date was invented. They are missing from completions reporting and are listed on Data health as “Completed, no completion date” until someone fills ${nNoDate === 1 ? "it" : "them"} in.</p>` : ""}
        ${conflictLog.length ? `<div class="dq-notice" id="import-conflicts"><strong>${conflictLog.length} contact detail${conflictLog.length === 1 ? "" : "s"} had to be chosen between:</strong>
          <ul style="margin:6px 0 0 18px;">${conflictLog.map((c) => `<li>${esc(c.client)} — ${esc(c.label.toLowerCase())} kept as <strong>${esc(c.kept)}</strong>; <span title="This value was in the file and was NOT saved.">discarded ${esc(c.discarded)}</span></li>`).join("")}</ul></div>` : ""}
        ${undecided.length ? `<div class="dq-notice bad" id="import-undecided"><strong>${undecided.length} row${undecided.length === 1 ? "" : "s"} created a NEW client despite a possible match</strong> — nobody chose Attach or New client, so nothing was attached on a guess:
          <ul style="margin:6px 0 0 18px;">${undecided.map((u) => `<li>${esc(u.row)} — looked like ${esc(u.candidate)}</li>`).join("")}</ul>
          Check Data health's duplicate list if that was wrong.</div>` : ""}
        <div class="row-list">${names.map(([id, name]) => `<div class="row-item"><div class="row-main"><a href="#" class="t" onclick="event.preventDefault();openClient('${id}')">${esc(name)}</a></div></div>`).join("")}</div>
      </div>` : "";
  }
}

/* ---------- Website leads ---------- */
async function loadLeads() {
  const { data: leads, error } = await db.from("leads").select("*").eq("status", "new").order("created_at");
  // T1-24 (bug 4) — the error used to be discarded, so an outage on the firm's revenue intake
  // rendered the reassuring "No new leads" empty state. Say so, and offer the retry.
  if (error) {
    $("#leads-count").classList.add("hidden");
    renderLoadError("#leads-list", error, loadLeads);
    autoDrawer("leads", true); // a failed intake queue must not stay collapsed
    return;
  }
  const n = (leads || []).length;
  const badge = $("#leads-count");
  badge.textContent = n;
  badge.classList.toggle("hidden", !n);
  $("#leads-list").innerHTML = n ? leads.map((l) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(l.name)}</div>
        <div class="s">${l.email ? mailLink(l.email) : ""}${l.phone ? " · " + telLink(l.phone) : ""}${l.enquiry_type ? " · " + esc(l.enquiry_type) : ""} · ${new Date(l.created_at).toLocaleString("en-GB")}</div>
        ${l.message ? `<div class="s">“${esc(l.message.slice(0, 140))}${l.message.length > 140 ? "…" : ""}”</div>` : ""}
      </div>
      <select class="lead-adviser" data-lead="${esc(l.id)}" aria-label="Assign this lead to" title="Which adviser this lead's case is created for" style="width:auto;">${leadAdviserOptionsHtml()}</select>
      <button class="btn btn-sm btn-primary" onclick="acceptLead('${l.id}', event)">Accept</button>
      <button class="btn btn-sm btn-danger" aria-label="Discard lead" title="Discard lead" onclick="discardLead('${l.id}')">✕</button>
    </div>`).join("") : '<div class="empty">No new leads. Website enquiries appear here the moment they\'re sent.</div>';
  panelCount("#leads-list", n, true);
  autoDrawer("leads", n > 0); // auto-open whenever there's a lead waiting, else stay collapsed
}
window.acceptLead = async function (id, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; } // guard against double-click
  // T1-3 — route at accept time. The adviser select sits on the same row as the button that fired
  // this; read it before anything is written so the case is created for the right person first
  // time. Falls back to me when the row has no select (nothing else calls acceptLead today).
  const advSel = leadAdviserFor(btn);
  const assignTo = (advSel && advSel.value) || (ME && ME.id) || null;
  /* R5-5 — this row's choice is NOT remembered for the next lead (that was the cross-contamination
     bug). What IS remembered is every OTHER visible row's current choice, so the repaint at the end
     of this function doesn't quietly reset a colleague's routing back to me. */
  const otherLeadSel = captureLeadAdvSel();
  delete otherLeadSel[id];
  // Atomically claim the lead: only converts if it's still 'new', so a fast double-click
  // or a second adviser accepting the same lead can't create duplicate clients/cases/emails.
  const { data: claimed, error: claimErr } = await db.from("leads")
    .update({ status: "converted" }).eq("id", id).eq("status", "new").select();
  if (claimErr) { if (btn) btn.disabled = false; return toast("Error: " + claimErr.message); }
  if (!claimed || !claimed.length) { if (btn) btn.disabled = false; return toast("This lead has already been accepted."); }
  const l = claimed[0];
  const kindMap = { "first-time-buyer": "first_time_buyer", "remortgage": "remortgage", "home-mover": "purchase", "buy-to-let": "buy_to_let" };

  /* T1-22 — split the lead's name through the shared splitName() helper, the same one bulk import
     uses. A joint enquiry ("Deborah & Michael Ashworth") used to be filed as
     first "Deborah" / last "Deborah & Michael Ashworth" — the doubled string then appeared on the
     card, the client list and every template. It now offers a best guess (first applicant's
     forename + the shared surname) in a two-field prompt, and the second applicant goes to the
     case note rather than into last_name. */
  const rawName = (l.name || "").trim().replace(/\s+/g, " ");
  let firstName = "", lastName = rawName, jointNote = "";
  if (rawName) {
    if (isJointName(rawName)) {
      const guess = splitJointName(rawName);
      const askedFirst = prompt(`This looks like a joint enquiry: “${rawName}”.\n\nFile the client record under one name — the second applicant is recorded on the case note.\n\nFirst name:`, guess.first_name);
      const askedLast = askedFirst === null ? null : prompt(`Joint enquiry: “${rawName}”.\n\nSurname:`, guess.last_name);
      // Cancelling either prompt keeps the best guess — the lead is already claimed, and a record
      // named "Deborah Ashworth" is editable; a doubled name is what we're here to stop.
      firstName = ((askedFirst === null ? guess.first_name : askedFirst) || "").trim();
      lastName = ((askedLast === null ? guess.last_name : askedLast) || "").trim();
      if (!firstName && !lastName) lastName = rawName;
      if (guess.second) jointNote = ` · Joint applicant: ${guess.second}`;
      else jointNote = ` · Joint enquiry as submitted: ${rawName}`;
    } else {
      const nm = splitName(rawName);
      firstName = nm.first_name; lastName = nm.last_name;
    }
  }

  /* R5-10 — before inserting, look for the client we may already have. The old lookup was email-only
     (and fell back to phone ONLY when the lead gave no email at all), so a returning client who
     typed a different address into the website form — the Ashworths' "d.m.ashworth@…" against the
     "deborah.ashworth@…" we hold — became a third record with the same surname, same house and the
     same phone, and Data Health picked it up days later. It now runs the shared matcher: name and
     phone count even when there IS an email, and a near match ASKS rather than either attaching
     silently or ignoring the person we already have. */
  let client = null, createdClient = false;
  const matchRows = await fetchMatchClients();
  const match = findClientMatches({ first: firstName, last: lastName, email: l.email, phone: l.phone }, matchRows);
  const whoOf = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || c.phone || "this client";
  if (match.exact) {
    const e = match.exact;
    if (confirm(`A client already exists: ${whoOf(e)}${e.email ? " (" + e.email + ")" : ""} — matched on ${match.reason}.\n\nAttach this new case to the existing client instead of creating a duplicate?`)) {
      client = e;
    }
  } else if (match.near.length) {
    const n = match.near[0];
    const others = match.near.length > 1 ? `\n\n(${match.near.length} possible matches — this is the closest: ${match.near.slice(1).map((x) => whoOf(x.client)).join(", ")} also look similar.)` : "";
    if (confirm(`Did you mean ${whoOf(n.client)}${n.client.email ? " (" + n.client.email + ")" : ""}?\n\nThis lead has ${n.reason} — but the details aren't identical, so it may be a different person.${others}\n\nOK = attach the case to them · Cancel = create a new client.`)) {
      client = n.client;
    }
  }
  if (!client) {
    const { data: newClient, error: cErr } = await db.from("clients")
      .insert({ first_name: firstName, last_name: lastName, email: l.email, phone: l.phone })
      .select().single();
    if (cErr) {
      // Roll the claim back so the lead reappears in the inbox and can be retried.
      await db.from("leads").update({ status: "new" }).eq("id", id);
      if (btn) btn.disabled = false;
      return toast("Error: " + cErr.message);
    }
    client = newClient; createdClient = true;
  }
  const { data: nc, error } = await db.from("cases").insert({
    client_id: client.id,
    case_kind: kindMap[l.enquiry_type] || "other",
    stage: "enquiry",
    lead_source: "Website",
    assigned_to: assignTo,
  }).select("id").single();
  if (error) {
    // Undo the partial accept: remove the just-created client (never an existing one we attached to), then release the lead.
    if (createdClient) await db.from("clients").delete().eq("id", client.id);
    await db.from("leads").update({ status: "new" }).eq("id", id);
    if (btn) btn.disabled = false;
    return toast("Error: " + error.message);
  }
  /* G1I-L2/L3/L4 — the three writes below are all "best effort" and every one of them used to
     discard its error, under a toast that read like a clean success. Collect the failures and put
     them in the SAME final message (a second toast() would simply overwrite the first — see
     G1I-R7), so the operator learns that the client was never welcomed, or that the enquiry text
     did not survive, at the moment they can still do something about it. */
  const leadWarn = [];
  // This note carries the joint-applicant name and the client's own words — the only place that
  // text survives the lead being marked converted.
  const { error: noteErr } = await db.from("case_notes").insert({
    case_id: nc.id,
    body: `Website enquiry (${l.enquiry_type || "general"})${jointNote}${l.property_value ? " · property value " + l.property_value : ""}${l.message ? " · “" + l.message + "”" : ""}`,
  });
  if (noteErr) leadWarn.push(`the enquiry note did NOT save (${noteErr.message}) — the joint applicant and the client's own message are only on the lead now`);
  /* R5-1 — accepting a lead used to call runAutomation() unscoped, which flushed the FIRM's entire
     due queue (every colleague's reminders, review requests and fee chases) as a side effect of one
     click, and did so even when the lead had no email address and nothing at all was queued. The
     welcome email now reports its own row id and only that row is sent. */
  let welcomeId = null;
  if (l.email) {
    const { data: wq, error: wErr } = await db.from("email_queue")
      .insert({ case_id: nc.id, client_id: client.id, email_type: "welcome", to_email: l.email })
      .select("id").single();
    welcomeId = (wq && wq.id) || null;
    if (wErr || !welcomeId) leadWarn.push(`the welcome email to ${l.email} was NOT queued (${(wErr && wErr.message) || "no row was written"}) — nothing will reach them until you queue it from the case`);
  }
  // Without this the lead ends up status='converted' with converted_case_id null, so nothing joins
  // the lead to the case it became. Retry once before reporting: it is a single-column update.
  let link = await db.from("leads").update({ converted_case_id: nc.id }).eq("id", id);
  if (link.error) link = await db.from("leads").update({ converted_case_id: nc.id }).eq("id", id);
  if (link.error) leadWarn.push(`the lead could not be linked to the new case (${link.error.message}) — the enquiry will not show which case it became`);
  if (welcomeId) runAutomation(true, { queueIds: [welcomeId] });
  // Accept-lead stays on Today (defect 22) — a toast confirms the case, but doesn't force-open the
  // case modal, so running through a queue of leads is toast-and-move-on rather than a modal
  // open/close per lead. The case is right where the toast says: New business.
  const acceptedName = [client.first_name, client.last_name].filter(Boolean).join(" ") || "this lead";
  toast(`Case created for ${acceptedName}${assignTo ? " → " + staffName(assignTo) : ""} — find it in New business`
    + (leadWarn.length ? `, but ${leadWarn.join("; and ")}` : ""));
  /* R5-21 — the same lead is listed TWICE on Today: in the Leads panel and as a My Day "lead_new"
     row. Repainting only the panel left the My Day row advertising a lead that no longer exists,
     and clicking its Accept produced "already been accepted". Repaint both. */
  await loadLeads();
  await loadBriefing();
  restoreLeadAdvSel(otherLeadSel);   // R5-5 — put the other rows' routing choices back
};
window.discardLead = async function (id) {
  if (!confirm("Discard this lead?")) return;
  await db.from("leads").update({ status: "discarded" }).eq("id", id);
  loadLeads();
};

/* ---------- Today's appointments ---------- */
async function loadTodayAppts() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  const { data: appts } = await db.from("appointments")
    .select("*, clients(first_name,last_name)")
    .gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString())
    .order("starts_at");
  $("#today-appts").innerHTML = (appts || []).length ? appts.map((a) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openAppt('${a.id}')">${new Date(a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — ${esc(a.title)}</div>
        <div class="s">${a.clients ? esc([a.clients.first_name, a.clients.last_name].filter(Boolean).join(" ")) + " · " : ""}${esc(a.location || "")}${a.staff_id ? " · " + esc(staffName(a.staff_id)) : ""}</div>
      </div>
    </div>`).join("") : '<div class="empty">Nothing booked today. The Diary tab has the full week.</div>';
  panelCount("#today-appts", (appts || []).length);
}

/* ---------- Diary ---------- */
let diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
// BUILD 7d (defect 26) — stable per-adviser colour palette for the "Everyone" diary view, so
// overlapping/adjacent appointments across advisers are distinguishable at a glance. Keyed by an
// adviser's fixed index in TEAM (populated once at login, ordered by full_name, not reshuffled
// per render), so the same adviser gets the same colour all session. Single-adviser view is
// unaffected — it keeps the plain uniform CSS look.
const DIARY_PALETTE = [
  { bg: "#e8f0fa", border: "#2f6fed" }, // blue
  { bg: "#e7f6ee", border: "#16794c" }, // green
  { bg: "#faf1dc", border: "#b8860b" }, // amber
  { bg: "#f5e9fb", border: "#8e44ad" }, // purple
  { bg: "#fdecea", border: "#c0392b" }, // red
  { bg: "#e6f6f7", border: "#0e8a8f" }, // teal
];
function adviserColor(staffId) {
  const idx = staffId ? TEAM.findIndex((p) => p.id === staffId) : -1;
  return DIARY_PALETTE[(idx < 0 ? 0 : idx) % DIARY_PALETTE.length];
}

async function loadDiary() {
  const monthStart = diaryMonth;
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7)); // back to Monday
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + ((8 - gridEnd.getDay()) % 7)); // forward to Monday
  const who = $("#diary-staff").value || "all";
  let q = db.from("appointments")
    .select("*, clients(first_name,last_name)")
    .gte("starts_at", gridStart.toISOString()).lt("starts_at", gridEnd.toISOString())
    .order("starts_at");
  if (who !== "all") q = q.eq("staff_id", who);
  const { data: appts } = await q;
  $("#diary-title").textContent = "Diary — " + monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  // T1-14 — compute per-staff clashes in one pass over the appointments already in memory. Keyed by
  // appt id → the (first) other same-staff appointment its time range overlaps, so both cards in a
  // clashing pair can name each other without a second query.
  const clashPartner = {};
  (appts || []).forEach((a) => {
    if (!a.staff_id) return;
    const aStart = new Date(a.starts_at), aEnd = new Date(a.ends_at || a.starts_at);
    (appts || []).forEach((b) => {
      if (b === a || b.staff_id !== a.staff_id || clashPartner[a.id]) return;
      const bStart = new Date(b.starts_at), bEnd = new Date(b.ends_at || b.starts_at);
      if (aStart < bEnd && bStart < aEnd) clashPartner[a.id] = b;
    });
  });
  const todayStr = new Date().toDateString();
  const days = [];
  for (let d = new Date(gridStart); d < gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  $("#diary-grid").innerHTML = days.map((day) => {
    const dayAppts = (appts || []).filter((a) => new Date(a.starts_at).toDateString() === day.toDateString());
    const dim = day.getMonth() !== monthStart.getMonth();
    const dstr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const dayHasClash = dayAppts.some((a) => clashPartner[a.id]);
    return `<div class="diary-day ${day.toDateString() === todayStr ? "today" : ""}${dayAppts.length ? " has-appts" : ""}${dayHasClash ? " has-clash" : ""}" data-date="${dstr}" title="Add an appointment on this day" style="${dim ? "opacity:.45;" : ""}min-height:110px;">
      <h5>${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</h5>
      ${dayAppts.map((a) => {
        // Defect 26 — colour by adviser only in the "Everyone" view; single-adviser view keeps the
        // plain default .appt styling (colour would add nothing when every card is the same person).
        const colorStyle = who === "all" ? (() => { const c = adviserColor(a.staff_id); return ` style="background:${c.bg};border-left-color:${c.border};"`; })() : "";
        const partner = clashPartner[a.id];
        const partnerTime = partner ? new Date(partner.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
        const clashTitle = partner ? ` title="Clashes with &quot;${esc(partner.title)}&quot; at ${partnerTime}"` : "";
        return `<div class="appt${partner ? " clash" : ""}" onclick="openAppt('${a.id}')"${colorStyle}${clashTitle}>
        ${partner ? '<span class="clash-tag">⚠</span> ' : ""}<span class="at">${new Date(a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}–${new Date(a.ends_at || a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span> ${esc(a.title)}
        ${a.clients ? `<div>${esc([a.clients.first_name, a.clients.last_name].filter(Boolean).join(" "))}</div>` : ""}
        ${a.staff_id && who === "all" ? `<div style="color:var(--muted);">${esc(staffName(a.staff_id))}</div>` : ""}
      </div>`;
      }).join("")}
    </div>`;
  }).join("");
  // Legend row (defect 26) — only meaningful once cards are colour-coded, i.e. the "Everyone" view.
  const legendEl = $("#diary-legend");
  if (legendEl) {
    legendEl.innerHTML = who === "all"
      ? TEAM.map((p) => { const c = adviserColor(p.id); return `<span class="diary-legend-item"><span class="diary-legend-dot" style="background:${c.border};"></span>${esc(staffName(p.id))}</span>`; }).join("")
      : "";
  }
}

/* ---------- Diary: Day view (Batch 9, STRETCH — R5-31 + Wayne's wish) ----------
   Additive: a second render path that shares the appointments table, the staff filter and
   openAppt/adviserColor with the month grid above, but never calls loadDiary's own renderer and
   never writes to #diary-grid/#diary-legend's month markup. Toggling between the two is just
   showing/hiding two sibling containers — see setDiaryViewMode. */
let diaryViewMode = "month"; // "month" | "day" — overwritten from localStorage by restoreUserPrefs
let diaryDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
// The staff-filter <select> is shared by both views; these remember each view's own last choice
// so flipping Month → Day → Month restores the exact selection Month had (R5-31 AT: "month grid
// pixel-identical when toggled back") while Day gets its own default of "me" (R5-31 AT: "day view
// defaults to signed-in adviser") without that default ever touching Month's.
let diaryStaffMonthVal = "all";
let diaryStaffDayVal = null;
const DIARY_DAY_START_HOUR = 8, DIARY_DAY_END_HOUR = 19; // 08:00–19:00
const DIARY_DAY_PX_PER_HOUR = 60;

// Interval layout: connected (time-overlapping) appointments are grouped into a cluster and each
// member gets its own column within it, so overlaps render side-by-side instead of stacking;
// `cols` on every member of a cluster is the cluster's own column count, used to size its width.
// Standard greedy sweep (sort by start, place each item in the first column whose last occupant
// has already ended, else open a new column) — the same shape used by most calendar UIs.
function computeDayLayout(dayAppts) {
  const items = dayAppts.map((a) => ({ appt: a, start: new Date(a.starts_at), end: new Date(a.ends_at || a.starts_at) }));
  items.sort((x, y) => x.start - y.start);
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (items[i].start < items[j].end && items[j].start < items[i].end) union(i, j);
    }
  }
  const clusters = {};
  for (let i = 0; i < n; i++) { const r = find(i); (clusters[r] = clusters[r] || []).push(i); }
  const col = new Array(n).fill(0);
  const cols = new Array(n).fill(1);
  Object.values(clusters).forEach((idxs) => {
    idxs.sort((a, b) => items[a].start - items[b].start);
    const colEnds = []; // end time currently occupying each column
    idxs.forEach((idx) => {
      const it = items[idx];
      let c = colEnds.findIndex((endT) => endT <= it.start);
      if (c === -1) { c = colEnds.length; colEnds.push(it.end); } else colEnds[c] = it.end;
      col[idx] = c;
    });
    idxs.forEach((idx) => { cols[idx] = colEnds.length; });
  });
  return items.map((it, i) => ({ ...it, col: col[i], cols: cols[i], clash: cols[i] > 1 }));
}

async function loadDiaryDay() {
  const day = diaryDay;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const who = $("#diary-staff").value || "all";
  let q = db.from("appointments")
    .select("*, clients(first_name,last_name)")
    .gte("starts_at", dayStart.toISOString()).lt("starts_at", dayEnd.toISOString())
    .order("starts_at");
  if (who !== "all") q = q.eq("staff_id", who);
  const { data: appts } = await q;
  $("#diary-title").textContent = "Diary — " + dayStart.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  renderDiaryDay(appts || [], who);
}

function renderDiaryDay(appts, who) {
  const startHour = DIARY_DAY_START_HOUR, endHour = DIARY_DAY_END_HOUR;
  const pxPerHour = DIARY_DAY_PX_PER_HOUR;
  const totalHeight = (endHour - startHour) * pxPerHour;
  const pad2 = (n) => String(n).padStart(2, "0");
  const timeLabel = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const hours = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  $("#diary-hour-labels").style.height = totalHeight + "px";
  $("#diary-hour-labels").innerHTML = hours.map((h) => `<div class="diary-hour-label" style="top:${(h - startHour) * pxPerHour}px;">${pad2(h)}:00</div>`).join("");
  const layout = computeDayLayout(appts);
  const lines = hours.map((h) => `<div class="diary-hour-line" style="top:${(h - startHour) * pxPerHour}px;"></div>`).join("");
  const blocks = layout.map(({ appt: a, start, end, col, cols, clash }) => {
    // Clamp to the visible axis rather than hide — an appointment starting before 08:00 or running
    // past 19:00 still needs to be findable, it just sits pinned to the edge of the lane.
    const minsFromStart = Math.min(Math.max(0, (start.getHours() * 60 + start.getMinutes()) - startHour * 60), (endHour - startHour) * 60);
    const durMins = Math.max(15, (end - start) / 60000);
    const top = (minsFromStart / 60) * pxPerHour;
    const height = Math.max(18, (durMins / 60) * pxPerHour - 2);
    const widthPct = 100 / cols;
    const leftPct = col * widthPct;
    // Defect 26's per-adviser palette, reused so the "Everyone" filter reads the same way here as
    // it does on the month grid.
    const colorStyle = who === "all" ? (() => { const c = adviserColor(a.staff_id); return `background:${c.bg};border-left-color:${c.border};`; })() : "";
    const others = layout.filter((o) => o.appt !== a && o.start < end && o.end > start).map((o) => o.appt.title);
    const clashTitle = clash ? ` title="Clashes with ${esc(others.join(", "))}"` : "";
    return `<div class="appt-block${clash ? " clash" : ""}" style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);${colorStyle}" onclick="openAppt('${a.id}')"${clashTitle}>${clash ? '<span class="clash-tag">⚠</span> ' : ""}<span class="at">${timeLabel(start)}–${timeLabel(end)}</span> ${esc(a.title)}
      ${a.clients ? `<div>${esc([a.clients.first_name, a.clients.last_name].filter(Boolean).join(" "))}</div>` : ""}
      ${a.staff_id && who === "all" ? `<div style="color:var(--muted);">${esc(staffName(a.staff_id))}</div>` : ""}</div>`;
  }).join("");
  const lane = $("#diary-day-lane");
  lane.style.height = totalHeight + "px";
  lane.innerHTML = lines + blocks;
}

// Click an empty part of the lane → new appointment prefilled with the clicked time (rounded to
// the nearest half hour); clicks on an appointment block are handled by the block's own onclick.
$("#diary-day-lane").addEventListener("click", (e) => {
  if (e.target.closest(".appt-block")) return;
  const lane = $("#diary-day-lane");
  const rect = lane.getBoundingClientRect();
  const totalMinutes = (DIARY_DAY_END_HOUR - DIARY_DAY_START_HOUR) * 60;
  let minutesFromStart = ((e.clientY - rect.top) / DIARY_DAY_PX_PER_HOUR) * 60;
  minutesFromStart = Math.min(Math.max(0, minutesFromStart), totalMinutes);
  minutesFromStart = Math.round(minutesFromStart / 30) * 30;
  const hour = DIARY_DAY_START_HOUR + Math.floor(minutesFromStart / 60);
  const minute = minutesFromStart % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  const dstr = `${diaryDay.getFullYear()}-${pad2(diaryDay.getMonth() + 1)}-${pad2(diaryDay.getDate())}`;
  openAppt(null, { starts_at: `${dstr}T${pad2(hour)}:${pad2(minute)}` });
});

// Flips the two sibling containers and re-points the shared #diary-staff select at whichever
// view's own remembered value, without ever mutating diaryMonth or re-rendering the month grid
// (see the "pixel-identical when toggled back" AT). `opts.skipLoad`/`skipPersist` are used only by
// initDiaryViewFromPrefs (a page-not-open startup sync — no query, no localStorage re-write).
function setDiaryViewMode(mode, opts = {}) {
  const prevMode = diaryViewMode;
  diaryViewMode = mode;
  $("#diary-view-month").classList.toggle("scope-active", mode === "month");
  $("#diary-view-day").classList.toggle("scope-active", mode === "day");
  $("#diary-grid").classList.toggle("hidden", mode !== "month");
  $("#diary-legend").classList.toggle("hidden", mode !== "month");
  $("#diary-day-view").classList.toggle("hidden", mode !== "day");
  const sel = $("#diary-staff");
  if (sel) {
    // Only capture the OUTGOING view's current selection on a genuine mode change. The startup
    // sync (initDiaryViewFromPrefs) calls this with the mode unchanged right after #diary-staff
    // was rebuilt from scratch — its "all" is the fresh select's default, not a real choice made
    // in that view, so it must never poison diaryStaffDayVal/diaryStaffMonthVal before the user
    // has switched views even once (that was bug: it made the Day default look for ME.id, found
    // the slot already filled with "all", and never touched it again).
    if (prevMode !== mode) {
      if (prevMode === "day") diaryStaffDayVal = sel.value || diaryStaffDayVal;
      else diaryStaffMonthVal = sel.value || "all";
    }
    if (mode === "day") {
      if (diaryStaffDayVal == null) diaryStaffDayVal = (ME && ME.id) || "all";
      sel.value = diaryStaffDayVal;
    } else {
      sel.value = diaryStaffMonthVal || "all";
    }
  }
  if (!opts.skipPersist && authUid) lsSet(diaryViewStoreKey(authUid), mode);
  if (!opts.skipLoad) { if (mode === "day") loadDiaryDay(); else loadDiary(); }
}
// Called once from loadTeam(), right after #diary-staff is rebuilt from the fresh team list (so
// any prior selection is gone anyway) — syncs the toggle's classes/hidden state and the day
// filter's default to whatever restoreUserPrefs read from localStorage, with no query fired
// (the diary page may not even be open yet) and no localStorage re-write.
function initDiaryViewFromPrefs() {
  setDiaryViewMode(diaryViewMode, { skipPersist: true, skipLoad: true });
}
$("#diary-view-month").addEventListener("click", () => setDiaryViewMode("month"));
$("#diary-view-day").addEventListener("click", () => setDiaryViewMode("day"));

$("#diary-prev").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay.setDate(diaryDay.getDate() - 1); loadDiaryDay(); }
  else { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() - 1, 1); loadDiary(); }
});
$("#diary-next").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay.setDate(diaryDay.getDate() + 1); loadDiaryDay(); }
  else { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() + 1, 1); loadDiary(); }
});
$("#diary-today").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()); loadDiaryDay(); }
  else { diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); loadDiary(); }
});
$("#diary-staff").addEventListener("change", () => { if (diaryViewMode === "day") loadDiaryDay(); else loadDiary(); });
$("#new-appt-btn").addEventListener("click", () => openAppt(null));
// Click an empty part of a day cell → New appointment pre-filled with that date (QW9).
// Clicks on an appointment inside a cell are handled by the appointment's own onclick.
$("#diary-grid").addEventListener("click", (e) => {
  if (e.target.closest(".appt")) return;
  const cell = e.target.closest(".diary-day");
  if (!cell || !cell.dataset.date) return;
  openAppt(null, { starts_at: cell.dataset.date + "T10:00" });
});
// T1-5 — Mine | Unassigned | All (the old two-state toggle hid ownerless tasks inside "Mine").
function setTasksScope(s) {
  tasksScope = s;
  $("#tasks-scope-mine").classList.toggle("scope-active", s === "mine");
  $("#tasks-scope-unassigned").classList.toggle("scope-active", s === "unassigned");
  $("#tasks-scope-all").classList.toggle("scope-active", s === "all");
  loadTasks();
}
$("#tasks-scope-mine").addEventListener("click", () => setTasksScope("mine"));
$("#tasks-scope-unassigned").addEventListener("click", () => setTasksScope("unassigned"));
$("#tasks-scope-all").addEventListener("click", () => setTasksScope("all"));

/* G1R-2 — the diary page renders in EITHER of two modes and `#page-diary` is visible in both, so
   "if the diary page is open, reload it" is not enough: after B9 added the Day view, a save or a
   delete made from the Day lane repainted the HIDDEN month grid and left the lane showing stale
   blocks (a renamed appointment kept its old title, a new booking never appeared, a deleted one
   stayed clickable). Route to whichever loader matches the mode, exactly as nav() does. */
function refreshDiaryView() {
  if ($("#page-diary").classList.contains("hidden")) return;
  if (diaryViewMode === "day") loadDiaryDay(); else loadDiary();
}
window.openAppt = async function (id, presets = {}) {
  // T1-14 — default to the adviser the diary is filtered to (rather than always "me"), so
  // "+ Appointment" while looking at Tom's diary books it for Tom, not for whoever is signed in.
  const filterStaff = $("#diary-staff") && $("#diary-staff").value;
  const defaultStaffId = (filterStaff && filterStaff !== "all") ? filterStaff : ((ME && ME.id) || null);
  let a = { staff_id: defaultStaffId, ...presets };
  if (id) {
    const { data } = await db.from("appointments").select("*").eq("id", id).single();
    /* G1R-2 — a row that isn't there any more must say so. Falling through to `a` (the empty
       defaults) opened a blank form titled "Appointment", with a live Save that ran an update
       matching zero rows and still reported "Appointment saved" — the operator was told their
       work was written when nothing was. Repaint too: the only way to be looking at a deleted
       appointment is a stale list. */
    if (!data) {
      toast("This appointment no longer exists — it may have been deleted.");
      refreshDiaryView();
      if (!$("#page-dashboard").classList.contains("hidden")) loadTodayAppts();
      return;
    }
    a = data;
  }
  const { data: clients } = await db.from("clients").select("id,first_name,last_name").order("last_name");
  const start = a.starts_at ? new Date(a.starts_at) : null;
  const mins = a.ends_at && start ? Math.round((new Date(a.ends_at) - start) / 60000) : 60;
  // Derive both date and time from LOCAL components so a late-evening appointment
  // doesn't show a day-shifted date (matches the local parse used on save).
  // T1-24 (bug 3) — this helper used to be called localDateStr, shadowing the module-level
  // Europe/London one (see the top of the file) for the whole of openAppt: any code added in here
  // that reached for localDateStr silently got browser-local semantics instead. Renamed so the two
  // can't be confused. It stays browser-local deliberately — the form's time field, the save-side
  // `new Date(date + "T" + time)` parse and the diary grid's day bucketing are all browser-local,
  // so this is the one that round-trips.
  const pad2 = (n) => String(n).padStart(2, "0");
  const formDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dateVal = formDateStr(start || new Date());
  const timeVal = start ? `${pad2(start.getHours())}:${pad2(start.getMinutes())}` : "10:00";
  $("#modal").innerHTML = `
    <h3>${id ? "Appointment" : "New appointment"}</h3>
    <form id="appt-form" class="form-grid">
      <label class="full">Title<input name="title" required value="${esc(a.title || "")}" placeholder="e.g. Fact find call"></label>
      <label>Date<input name="date" type="date" required value="${dateVal}"></label>
      <label>Time<input name="time" type="time" required value="${timeVal}"></label>
      <label>Duration (mins)<input name="mins" type="number" value="${mins}"></label>
      <label>Who<select name="staff_id">${a.staff_id ? assigneeOptionsHtml(a.staff_id) : assigneeOptionsHtml(defaultAssignee(null))}</select></label>
      <label class="full">Client<select name="client_id"><option value="">— none —</option>${(clients || []).map((cl) => `<option value="${cl.id}" ${cl.id === a.client_id ? "selected" : ""}>${esc([cl.last_name, cl.first_name].filter(Boolean).join(", "))}</option>`).join("")}</select></label>
      <label class="full">Location<input name="location" value="${esc(a.location || "")}" placeholder="Office / phone / Teams"></label>
      <label class="full">Notes<textarea name="notes" rows="2">${esc(a.notes || "")}</textarea></label>
    </form>
    <div class="modal-actions">
      <div>
        ${id ? '<button class="btn btn-ghost btn-danger" id="del-appt-btn">Delete</button>' : ""}
        ${/* R5-48 — the appointment was a dead end: the one screen that knows who you are about to
             meet had no way through to their record or their case, so preparing for a 10am meant
             closing this, going to Clients and searching for the name you had just read. */ ""}
        ${id && a.client_id ? '<button type="button" class="btn btn-ghost" id="appt-open-client">Open client</button>' : ""}
        ${id && a.case_id ? '<button type="button" class="btn btn-ghost" id="appt-open-case">Open case</button>' : ""}
      </div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  pushModalHistory("appt", id); // BUILD 7a — Back closes this modal
  $("#modal-cancel").onclick = closeModalGuarded; // defect 2 — Cancel is a "leave" path: it must warn about unsaved edits too
  /* R5-48 — leaving via these is still a "leave" path: unsaved edits are guarded exactly as Cancel
     guards them, then the destination record replaces this one in the same modal (the pattern the
     case modal's "View original case" link already uses — the history entry is replaced, not
     stacked). */
  const apptGoto = (fn, arg) => () => { if (!hasUnsavedModalEdits() || confirm("Leave this appointment? Unsaved changes will be lost.")) fn(arg); };
  const openClientBtn = $("#appt-open-client");
  if (openClientBtn) openClientBtn.onclick = apptGoto(window.openClient, a.client_id);
  const openCaseBtn = $("#appt-open-case");
  if (openCaseBtn) openCaseBtn.onclick = apptGoto(window.openCase, a.case_id);
  $("#modal-save").onclick = async () => {
    const f = new FormData($("#appt-form"));
    const title = String(f.get("title") || "").trim();
    if (!title) return toast("Title required");
    const startAt = new Date(f.get("date") + "T" + f.get("time"));
    if (isNaN(startAt)) return toast("Date and time required");
    const dur = Number(f.get("mins") || 60);
    const row = {
      title,
      starts_at: startAt.toISOString(),
      ends_at: new Date(startAt.getTime() + dur * 60000).toISOString(),
      staff_id: f.get("staff_id") || null,
      client_id: f.get("client_id") || null,
      case_id: a.case_id || null,
      location: String(f.get("location") || "").trim() || null,
      notes: String(f.get("notes") || "").trim() || null,
    };
    // Diary double-booking warning (defect 5) — warn, never block: look for another appointment
    // for the SAME adviser that overlaps this one in time, excluding this record when editing.
    if (row.staff_id) {
      const newStart = startAt, newEnd = new Date(row.ends_at);
      let overlapQ = db.from("appointments").select("id,title,starts_at,ends_at").eq("staff_id", row.staff_id);
      if (id) overlapQ = overlapQ.neq("id", id);
      const { data: sameStaffAppts } = await overlapQ;
      const clash = (sameStaffAppts || []).find((o) => new Date(o.starts_at) < newEnd && new Date(o.ends_at || o.starts_at) > newStart);
      if (clash) {
        const clashTime = new Date(clash.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
        if (!confirm(`${staffName(row.staff_id)} already has "${clash.title}" at ${clashTime} — book anyway?`)) return;
      }
    }
    const q = id ? db.from("appointments").update(row).eq("id", id) : db.from("appointments").insert(row);
    const { error } = await q;
    if (error) return toast("Error: " + error.message);
    closeModal();
    toast("Appointment saved");
    refreshDiaryView();
    if (!$("#page-dashboard").classList.contains("hidden")) loadTodayAppts();
  };
  if (id) $("#del-appt-btn").onclick = async () => {
    if (!confirm("Delete this appointment?")) return;
    await db.from("appointments").delete().eq("id", id);
    closeModal();
    toast("Appointment deleted");
    refreshDiaryView();
    if (!$("#page-dashboard").classList.contains("hidden")) loadTodayAppts();
  };
};

/* ---------- Evidence pack ----------
   This is a document sent to a file reviewer or a regulator, so nothing in it may be an internal
   identifier or a database enum: every id resolves to the name the app shows on screen, every
   coded value is printed in the words the app shows on screen, and where something genuinely
   cannot be recovered the pack says so in a sentence instead of printing a row id. */
/* PACK_ENUM (coded value → the app's own words) and PACK_ID_FIELDS (which fields hold an id), plus
   the resolver that reads a value through them, live with the audit renderers further up this
   file: the on-screen change history and this document show the same rows and must say the same
   thing about them. See auditValueText / auditIdText / auditFieldKind. */
/* An insert or a delete records the whole row. The primary key and the parent linkage are internal
   plumbing — a reviewer already knows which case this pack is about — so they are dropped rather
   than printed as ids. Everything with meaning is kept and spelled out. */
const PACK_INTERNAL_FIELDS = ["id", "case_id", "client_id", "updated_at", "last_seen_at", "claimed_at"];
const PACK_VERB = { insert: "Created", update: "Changed", delete: "Deleted" };
// The trigger-written case_events detail for these events is "<old> → <new>" in raw enum text.
const PACK_EVENT_FIELD = {
  stage_changed: "stage", fee_status_changed: "fee_status",
  protection_status_changed: "protection_status", rate_end_date_changed: "rate_end_date",
};
async function buildEvidencePack(caseId) {
  toast("Building evidence pack…");
  const [{ data: c }, { data: notes }, { data: tasks }, { data: events }, { data: emails }, auditAll, intros] = await Promise.all([
    db.from("cases").select("*, clients(*), introducers(name)").eq("id", caseId).single(),
    db.from("case_notes").select("*").eq("case_id", caseId).order("created_at"),
    db.from("case_tasks").select("*").eq("case_id", caseId).order("created_at"),
    db.from("case_events").select("*").eq("case_id", caseId).order("created_at"),
    db.from("email_queue").select("email_type,status,to_email,subject,sent_at,created_at").eq("case_id", caseId).order("created_at"),
    loadAuditRows("case_id", caseId), // soft-fails: a blocked audit_log must not stop the pack
    softRows(db.from("introducers").select("id,name")), // so an introducer_id can be named
  ]);
  const audit = auditVisibleRows(auditAll);
  if (!c) return toast("Could not load case");
  const cl = c.clients || {};
  const name = [cl.first_name, cl.last_name].filter(Boolean).join(" ");
  const dt = (d) => (d ? new Date(d).toLocaleString("en-GB") : "—");
  const row = (k, v) => `<tr><td>${k}</td><td><strong>${esc(v ?? "—")}</strong></td></tr>`;

  /* ---- ids → names. An id a reviewer cannot look up is not evidence of anything. ---- */
  const introById = {};
  (intros || []).forEach((i) => { introById[i.id] = i.name; });
  const kindText = (KINDS.find((x) => x[0] === c.case_kind) || [])[1] || c.case_kind || "case";
  const thisCaseLabel = (name ? name + " — " : "") + kindText;
  // profileName() covers everyone with a profile row, including a colleague moved to "No access".
  const packPerson = (id, whenAbsent) => (!id ? (whenAbsent || "Not recorded") : (profileName(id) || "A colleague no longer in the system"));
  /* What this document can name, handed to the shared resolver. Everything it cannot name — an id
     pointing at another case or client, an unlisted id column, a token — is withheld by
     auditValueText rather than printed raw. */
  const packCtx = { where: "in this pack", caseId: c.id, caseLabel: thisCaseLabel, clientId: cl.id, clientName: name || "This client", introById };
  // One value, as a person would read it: names for ids, words for enums, dates for timestamps.
  const packValue = (field, v) => auditValueText(field, v, packCtx);
  // audit_log.changes, flattened for print. "(hidden)" is the database's own masking of bank
  // details/keys/tokens — the value was never recorded, only the fact that it changed.
  const changesText = (e) => {
    const ch = (e && e.changes) || {};
    const isDiff = e.action === "update";
    const ks = Object.keys(ch).filter((f) => isDiff || PACK_INTERNAL_FIELDS.indexOf(f) === -1);
    if (!ks.length) return isDiff ? "—" : "The record as it stood — no further detail recorded.";
    return ks.map((f) => {
      const v = ch[f], lbl = f.replace(/_/g, " ");
      // Masked on insert, update and delete alike (§3), so the sentence is the same on all three.
      if (auditIsMasked(v, isDiff)) return lbl + ": changed (value not recorded — sensitive)";
      if (isDiff && v && typeof v === "object") return lbl + ": " + packValue(f, v.old) + " → " + packValue(f, v.new);
      return lbl + ": " + packValue(f, v);
    }).join("; ");
  };
  /* The summary the trigger wrote is `<who> <verb> <table> "<label>"`, where <label> is a snapshot
     of the row's name AT THE TIME. On a cascade delete the parent was already gone when the label
     was built, so it fell back to the row id — "deleted cases \"ca48\"" tells a reviewer nothing.
     The "What" column is therefore recomposed from the row's own columns: the record type in
     words, and the subject's name resolved NOW wherever it still can be. Where it genuinely cannot
     be recovered the pack says so in words. The actor is dropped from the sentence because the
     Who column beside it already carries it. */
  const quotedLabel = (s) => { const m = /"([^"]*)"/.exec(String(s || "")); return m ? m[1] : null; };
  /* Last resort before giving up on a name: an insert/delete records the whole row, so the row's
     own name-bearing column is still there even when the trigger's label fell back to the id. */
  const PACK_NAME_COLS = ["title", "name", "full_name", "key", "subject", "body"];
  function subjectFromChanges(e) {
    if (e.action === "update") return null;              // an update's changes are diffs, not a row
    const ch = e.changes || {};
    for (let i = 0; i < PACK_NAME_COLS.length; i++) {
      const v = ch[PACK_NAME_COLS[i]];
      if (typeof v === "string" && v.trim()) return v.trim().length > 80 ? v.trim().slice(0, 79) + "…" : v.trim();
    }
    const person = [ch.first_name, ch.last_name].filter((x) => typeof x === "string" && x.trim()).join(" ").trim();
    return person || null;
  }
  function packSubject(e) {
    const q = quotedLabel(e.summary);
    if (q && q !== e.row_id) return q;                          // the trigger caught a real name
    if (e.table_name === "cases" && e.row_id === c.id) return thisCaseLabel;
    if (e.table_name === "clients" && e.row_id === cl.id) return name || null;
    if (e.table_name === "profiles") return profileName(e.row_id) || null;
    if (e.table_name === "introducers") return introById[e.row_id] || null;
    if (e.table_name === "settings") return e.row_id || null;   // a settings key IS its name
    return subjectFromChanges(e);
  }
  function packWhat(e) {
    const verb = PACK_VERB[e.action] || "Changed";
    const noun = auditTableLabel(e.table_name).toLowerCase();
    const subj = packSubject(e);
    if (subj) return `${verb} the ${noun} “${subj}”`;
    const why = e.table_name === "cases"
      ? "the client record had already been deleted, so this case could not be named"
      : "no name was recorded for it and the record can no longer be looked up";
    return `${verb} a ${noun} — ${why}`;
  }
  // "fact_find → decision_in_principle" is enum text; the timeline shows the same words as the app.
  function packEventDetail(ev) {
    const d = ev.detail == null ? "" : String(ev.detail);
    const f = PACK_EVENT_FIELD[ev.event];
    if (f && d.indexOf("→") !== -1) return d.split("→").map((s) => packValue(f, s.trim())).join(" → ");
    if (ev.event === "case_created" && /^Stage:\s*/.test(d)) return "Stage: " + packValue("stage", d.replace(/^Stage:\s*/, ""));
    return d;
  }
  // Who produced this document, and in what capacity — a pack with no provenance is not evidence.
  const generatedBy = (ME && (ME.full_name || ME.email)) || (($("#user-email") || {}).textContent) || "Unknown user";
  const generatedRole = ROLE_LABEL[MY_ROLE] || MY_ROLE;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Evidence pack — ${esc(name)}</title>
    <style>
      body{font-family:Arial,sans-serif;color:#222;max-width:800px;margin:30px auto;font-size:13px;line-height:1.5;}
      h1{font-size:20px;color:#00488c;} h2{font-size:15px;color:#00488c;margin-top:26px;border-bottom:1px solid #ddd;padding-bottom:4px;}
      table{border-collapse:collapse;width:100%;} td,th{padding:5px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;}
      .muted{color:#777;} @media print {.noprint{display:none}}
    </style></head><body>
    <button class="noprint" onclick="window.print()" style="padding:8px 16px;">Print / Save as PDF</button>
    <h1>Case evidence pack — ${esc(name)}</h1>
    <p class="muted">Generated ${new Date().toLocaleString("en-GB")} by ${esc(generatedBy)} (${esc(generatedRole)}) · NexMoney Back Office · Case ref ${String(c.id).slice(0, 8).toUpperCase()}</p>
    <h2>Client</h2><table>
      ${row("Name", name)}${row("Email", cl.email)}${row("Phone", cl.phone)}${row("Address", cl.address)}
    </table>
    <h2>Case details</h2><table>
      ${row("Type", (KINDS.find((x) => x[0] === c.case_kind) || [])[1] || c.case_kind)}${row("Stage", STAGE_LABEL[c.stage] || c.stage)}
      ${/* A file reviewer's first question is who advised this client — the pack didn't answer it. */ ""}
      ${row("Adviser", c.assigned_to ? staffName(c.assigned_to) : "Unassigned")}
      ${row("Lender", c.lender)}${row("Product", c.product_name)}
      ${row("Rate", c.rate_percent != null ? c.rate_percent + "% " + (c.rate_type || "") : null)}
      ${row("Rate end date", c.rate_end_date ? fmtD(c.rate_end_date) + (c.rate_end_estimated ? " (ESTIMATED — unverified)" : "") : null)}
      ${row("ERC end date", c.erc_end_date ? fmtD(c.erc_end_date) : null)}
      ${row("Loan amount", c.loan_amount != null ? fmtM(c.loan_amount) : null)}${row("Property value", c.property_value != null ? fmtM(c.property_value) : null)}
      ${row("Broker fee", c.broker_fee != null ? fmtM2(c.broker_fee) + " — " + packValue("fee_status", c.fee_status || "not_requested") : null)}
      ${row("Proc fee", c.proc_fee != null ? fmtM2(c.proc_fee) : null)}${row("Sols fee", c.sols_fee != null ? fmtM2(c.sols_fee) : null)}
      ${row("Protection", packValue("protection_status", c.protection_status || "not_discussed"))}
      ${row("Lead source", c.lead_source)}${row("Introducer", c.introducers?.name)}
      ${row("Created", dt(c.created_at))}${row("Completed", c.completed_at ? dt(c.completed_at) : null)}
      ${row("Offer document on file", c.offer_doc_path ? "Yes — " + c.offer_doc_path : "No")}
    </table>
    <h2>Event timeline</h2>
    <p class="muted">Written by the database as the case progresses — stage changes, fee status, offer uploads, rate-end dates, protection status and reassignment are each recorded automatically, with the person who made the change. It is not a record of every edit: changes to other fields (loan amount, rate, lender, dates, client contact details) do not appear here — those are in Change history at the end of this pack, which covers everything from ${esc(auditStartLabel())} onwards. Notes, tasks and communications are listed separately below.</p>
    <table><tr><th>When</th><th>Event</th><th>Detail</th><th>By</th></tr>
      ${(events || []).map((e) => `<tr><td>${dt(e.created_at)}</td><td>${esc(String(e.event || "").replace(/_/g, " "))}</td><td>${esc(packEventDetail(e))}</td><td>${esc(actorName(e.actor))}</td></tr>`).join("") || "<tr><td colspan=4>None recorded</td></tr>"}
    </table>
    <h2>Client communications</h2><table><tr><th>When</th><th>Type</th><th>To</th><th>Status</th><th>Subject</th></tr>
      ${(emails || []).map((e) => `<tr><td>${dt(e.sent_at || e.created_at)}</td><td>${esc(EMAIL_LABEL[e.email_type] || e.email_type)}</td><td>${esc(e.to_email || "")}</td><td>${esc(packValue("status", e.status))}</td><td>${esc(e.subject || "")}</td></tr>`).join("") || "<tr><td colspan=5>None</td></tr>"}
    </table>
    ${/* The app shows who wrote a note and who owns a task on screen; the pack printed neither. */ ""}
    <h2>Notes</h2><table><tr><th>When</th><th>Note</th><th>Written by</th></tr>
      ${(notes || []).map((n) => `<tr><td style="white-space:nowrap;">${dt(n.created_at)}</td><td>${esc(n.body)}</td><td>${esc(packPerson(n.created_by, "Author not recorded"))}</td></tr>`).join("") || "<tr><td colspan=3>None</td></tr>"}
    </table>
    <h2>Tasks</h2><table><tr><th>Due</th><th>Task</th><th>Assigned to</th><th>Status</th></tr>
      ${(tasks || []).map((t) => `<tr><td style="white-space:nowrap;">${t.due_date ? "due " + fmtD(t.due_date) : "no due date"}</td><td>${esc(t.title)}</td><td>${esc(packPerson(t.assigned_to, "Unassigned"))}</td><td>${t.done_at ? "done " + dt(t.done_at) : "open"}</td></tr>`).join("") || "<tr><td colspan=4>None</td></tr>"}
    </table>
    <h2>Change history</h2>
    <p class="muted">Every insert, update and delete the database recorded against this case and its tasks, notes and appointments, newest first, with the person who made it. Written by the audit trigger; it has no write path through the app, so it cannot be edited or erased from here. This log began on ${esc(auditStartLabel())} — changes made before that date were not captured, and it does not cover client-level edits made under the client record rather than this case.</p>
    <table><tr><th>When</th><th>Who</th><th>What</th><th>Changed</th></tr>
      ${audit.map((e) => `<tr><td style="white-space:nowrap;">${dt(e.happened_at)}</td><td>${esc(e.actor_label || actorName(e.actor))}</td><td>${esc(packWhat(e))}</td><td>${esc(changesText(e))}</td></tr>`).join("")
        || `<tr><td colspan=4>No changes recorded for this case since ${esc(auditStartLabel())}.</td></tr>`}
    </table>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return toast("Pop-up blocked — allow pop-ups for this page.");
  w.document.write(html);
  w.document.close();
}

/* ---------- Reports ---------- */
// "YYYY-MM" -> "July 2026", shared by the month-business panel and the threaded-panels note.
function monthLabel(mv) {
  return new Date(mv + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

// BUILD 6a — the 6 calendar months ending on the current one ("YYYY-MM", oldest first). Deliberately
// independent of the Reports month picker: this is a rolling trend, not a scoped-to-selected-month figure.
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function last6Months() {
  const now = new Date();
  const out = [];
  for (let i = 5; i >= 0; i--) out.push(localMonthStr(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  return out;
}
// Tiny inline SVG sparkline — no chart libs. `values` is oldest-first; flat/zero series render as a
// straight baseline rather than throwing on a 0/0 divide.
// T1-18 — `sharedMax` lets a column of sparklines share one vertical scale. Without it every row is
// scaled to its own peak, so a row peaking at 1 draws the same height as a row peaking at 5 and the
// column inverts the ranking it exists to show. Omitted → per-row scale (the old behaviour).
function sparklineSvg(values, sharedMax) {
  const w = 84, h = 22, pad = 3;
  const max = sharedMax != null ? Math.max(sharedMax, 1) : Math.max(...values, 1);
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${(pad + i * stepX).toFixed(1)},${(h - pad - (v / max) * (h - pad * 2)).toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" class="sparkline" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--navy)" stroke-width="1.6"/></svg>`;
}
/* T1-20 — one conversion cell, used by both the Introducers table and the Lead sources table.
   Conversion is completed / (completed + not proceeding): a case that is still live is neither a
   win nor a loss, and counting it as a loss reads as "this introducer sends me cases that go
   nowhere" about a referrer whose cases are sitting at Offer. Below 5 resolved cases the figure is
   marked (n<5) and greyed — at n=2 the table produces a 0% and a 100% with equal confidence. */
function convCell(done, lost) {
  const resolved = done + lost;
  const marker = ' <span class="stat-n">(n&lt;5)</span>';
  if (!resolved) return `<span class="stat-weak" title="No case has completed or been marked not proceeding yet — there is nothing to compute a conversion from. Live cases are not failures.">—${marker}</span>`;
  const pct = Math.round((done / resolved) * 100) + "%";
  const basis = `${done} completed of ${resolved} resolved (${lost} not proceeding). Live cases are excluded.`;
  return resolved < 5
    ? `<span class="stat-weak" title="${esc(basis)} Fewer than 5 resolved cases — indicative only, not a track record.">${pct}${marker}</span>`
    : `<span title="${esc(basis)}">${pct}</span>`;
}
const CONV_TH_TITLE = "Completed ÷ (completed + not proceeding). Cases still live are excluded — they have not failed yet. Shown as (n<5) where fewer than 5 cases have resolved.";

/* ==========================================================================
   BATCH 6 — money basis, per-fee-type cash dates, period deltas
   ========================================================================== */

/* R5-17 (label half) — the three bases every money figure on Reports is counted on. NOTHING here
   changes a calculation: the point is that two figures which legitimately disagree (fee value
   EARNED on cases that completed in July vs cash BANKED in July) stop looking like a bug. The
   suffix strings are used verbatim on the tiles, so a test can assert them. */
const BASIS_EARNED_ALL = "(earned · all fee types)";
const BASIS_CASH_MONTH = "(broker only · cash · this month)";
const BASIS_CASH_YTD = "(broker only · cash · YTD)";
const BASIS_TARGET = "cash · proc+broker+sols · by paid date";
const BASIS_FORECAST = "(weighted · proc+broker, excl. sols)";
const BASIS_INTRO_REV = "(all-time · earned · completed cases)";
/* R5-F2 (Daniel-approved) — the HEADLINE basis. Fee value is now led with as EARNED ON COMPLETION:
   proc + broker + sols on cases whose completed_at falls in the period, paid or not. The cash
   figures (BASIS_TARGET / BASIS_CASH_*) are not deleted and not changed — they are demoted to
   clearly-labelled secondary numbers beside the headline. Two figures answering two questions; the
   page now leads with the one Daniel manages the business on. */
const BASIS_EARNED_MONTH = "(earned · proc+broker+sols · completed this month)";
const BASIS_EARNED_YTD = "(earned · proc+broker+sols · completed YTD)";
const BASIS_TARGET_EARNED = "earned · proc+broker+sols · by completion date";
/* R5-F1 (Daniel-approved) — the adviser's own three figures. Every one of these is scoped to
   assigned_to = the signed-in person; the wording says so on the tile itself so the card can never
   be mistaken for a firm-wide number. Same clamps as the owner figures: no future-dated cash. */
const BASIS_MY_CASH_YTD = "(cash · proc+broker+sols · by paid date · my cases · YTD · excl. future-dated)";
const BASIS_MY_OUTSTANDING = "(earned · not yet received · my completed cases)";
const BASIS_MY_PIPELINE = "(unweighted estimate · proc+broker · offer & exchange · my cases)";
const basisLine = (t) => `<div class="s">${esc(t)}</div>`;

/* B7 — the per-fee-type amount/date pairing is FEE_TYPES, declared with the mark-paid flow above
   (Batch 2). Before M2 a single fee_paid_at stood for all three, so a case whose broker fee landed
   in June and whose proc fee landed in July could only ever be counted once, in one month.
   coalesce(<type>_fee_paid_at, fee_paid_at) — exactly what M5 does inside get_reports. Feature
   detection is by absence: loadFeeCashDates() leaves the new keys undefined on an un-migrated
   database, so this silently becomes the old single-date behaviour rather than throwing. */
const feeCashDate = (c, dateCol) => (c && (c[dateCol] || c.fee_paid_at)) || null;
/* Cash actually collected in month `mv`, keyed on each fee type's own paid date.
   B7 clamp: a payment DATED IN THE FUTURE is not collected money — it is excluded from the total
   and counted separately so the caller can footnote it ("excludes future-dated payments (N)").
   `types` is a list of FEE_TYPES keys; rows is the cases array. */
function cashInMonth(rows, mv, types) {
  const today = localDateStr();
  const wanted = FEE_TYPES.filter((f) => types.indexOf(f.key) >= 0);
  let total = 0, futureN = 0, futureTotal = 0;
  (rows || []).forEach((c) => {
    wanted.forEach((f) => {
      const amt = Number(c[f.amountCol] || 0);
      if (!amt) return;
      const d = feeCashDate(c, f.dateCol);
      if (!d || localMonthStr(d) !== mv) return;
      if (localDateStr(d) > today) { futureN++; futureTotal += amt; return; }
      total += amt;
    });
  });
  return { total, futureN, futureTotal };
}
/* R5-F1 — the same walk, scoped to a calendar YEAR instead of a month. Deliberately a separate
   function rather than a "period" flag on cashInMonth: the month version is load-bearing for the
   target bar and the scoreboard, and both keep the identical future-date clamp below. */
function cashInYear(rows, yr, types) {
  const today = localDateStr();
  const wanted = FEE_TYPES.filter((f) => types.indexOf(f.key) >= 0);
  let total = 0, futureN = 0, futureTotal = 0;
  (rows || []).forEach((c) => {
    wanted.forEach((f) => {
      const amt = Number(c[f.amountCol] || 0);
      if (!amt) return;
      const d = feeCashDate(c, f.dateCol);
      if (!d || localDateStr(d).slice(0, 4) !== String(yr)) return;
      if (localDateStr(d) > today) { futureN++; futureTotal += amt; return; }
      total += amt;
    });
  });
  return { total, futureN, futureTotal };
}
/* R5-F2 — the HEADLINE basis, in one place so the month card, the target bar and the YTD tile
   cannot drift apart: proc + broker + sols fee value on cases whose completed_at falls in the
   period, whether or not any of it has been paid. `period` is "YYYY-MM" or "YYYY" — matched by
   prefix against the Europe/London completion date, the same basis every other figure here uses. */
function earnedOnCompletion(rows, period) {
  const p = String(period || "");
  let total = 0, n = 0;
  (rows || []).forEach((c) => {
    if (!c.completed_at) return;
    if (localDateStr(c.completed_at).slice(0, p.length) !== p) return;
    n++;
    total += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
  });
  return { total, n };
}
/* "YYYY-MM" ± n calendar months, on the same UK-local basis as localMonthStr. */
function monthAdd(mv, n) {
  const y = Number(String(mv).slice(0, 4)), m = Number(String(mv).slice(5, 7)) - 1;
  const d = new Date(y, m + n, 1, 12, 0, 0);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}
const monthShortLabel = (mv, withYear) => {
  const m = MONTH_SHORT[Number(String(mv).slice(5, 7)) - 1] || mv;
  return withYear ? m + " " + String(mv).slice(2, 4) : m;
};
/* S8 / R5-19 — one delta chip. THE POINT OF THIS FUNCTION is the difference between "we did no
   business that month" (a real zero, which can be compared) and "we have no rows for that month
   at all" (nothing to compare, and emphatically not a 100% fall). `priorHasData` is decided by
   whether ANY case row is dated in the prior period, not by whether this metric was non-zero. */
function deltaChip(cur, prior, priorHasData, label, fmt) {
  const f = fmt || ((n) => String(n));
  if (!priorHasData) {
    return `<span class="delta none" title="No case activity of any kind is recorded in ${esc(label)}, so there is nothing to compare against. This is missing data, not a fall to zero.">no data vs ${esc(label)}</span>`;
  }
  const title = `${label}: ${f(prior)} → ${f(cur)}`;
  if (!prior) {
    if (!cur) return `<span class="delta flat" title="${esc(title)}">= 0 vs ${esc(label)}</span>`;
    return `<span class="delta up" title="${esc(title)}">▲ +${esc(f(cur))} vs ${esc(label)} (from nil)</span>`;
  }
  const pct = Math.round(((cur - prior) / prior) * 100);
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "=";
  const num = (pct > 0 ? "+" : "") + String(pct).replace("-", "−");
  return `<span class="delta ${cls}" title="${esc(title)}">${arrow} ${num}% vs ${esc(label)}</span>`;
}
// Both chips for one KPI, in the plan's order: month-on-month, then year-on-year.
function deltaChips(cur, prev, prevYear, fmt) {
  return `<div class="kpi-delta">${deltaChip(cur, prev.value, prev.hasData, prev.label, fmt)}<span class="delta-sep">·</span>${deltaChip(cur, prevYear.value, prevYear.hasData, prevYear.label, fmt)}</div>`;
}
/* R5-2 — the one sentence that says whose figures these are. Attribution follows the adviser
   CURRENTLY on the case; the leaver flow (Batch 5) deliberately leaves completed cases attributed
   to whoever closed them, so a historic month does not rewrite itself when somebody leaves. */
const ATTRIB_NOTE = "Figures follow the adviser currently on each case; completed cases keep their adviser when someone leaves.";

/* BACKEND-R4 §1 (owner's decision) — money reporting is Owner-only IN THE UI: fee figures, the
   commission forecast, the adviser scoreboard, introducer revenue and client lifetime value.
   Operational reporting — case counts, the funnel, completions, lead-source volumes, data health —
   stays visible to everyone.
   THIS IS A PRESENTATION CHOICE, NOT A SECURITY CONTROL. get_reports() is still readable by any
   staff account and the cases table still carries broker_fee/proc_fee/sols_fee to every signed-in
   adviser; anyone with the browser console can read what this hides. Do not describe it as a
   control, and do not rely on it for anything that matters. */
const showMoney = () => isOwner();
/* R5-F1 (Daniel-approved, this round) — the one exception to the paragraph above. An adviser could
   see every firm-wide money figure withheld and none of their OWN, which meant the person doing the
   work had no way to answer "what have I banked this year". Daniel reversed that for the adviser's
   own book only: ONE card, every figure on it scoped to assigned_to = me, nothing firm-wide and
   nothing belonging to a colleague.
   Audience is advisers; a working admin who holds cases gets it too (they are staff doing the same
   job), which is why this keys off MY_ROLE + ME rather than a single role string. The Owner is
   excluded — showMoney() already gives them the fuller, firm-wide set below, and a second "my
   numbers" card would just be a subset of what they can already see.
   Still a PRESENTATION choice, not a control: the same caveat as showMoney() applies verbatim. */
const MY_NUMBERS_ROLES = ["adviser", "admin", "staff"];
const showMyNumbers = () => !!ME && !isOwner() && MY_NUMBERS_ROLES.includes(MY_ROLE);
/* R5-F1 (CSV half) — whether a pipeline export may carry the Broker fee column. The Owner is
   unchanged (always). For an ADVISER the column is dropped only when the export would spill a
   colleague's fee: an export whose every row is their own case is their own money and now keeps the
   column. Admin exports are deliberately unchanged (still stripped) — Daniel scoped this reversal
   to the advisers whose own numbers they are. */
const csvFeeRoles = () => MY_ROLE === "adviser" || MY_ROLE === "staff";
function csvShowsFee(rows) {
  if (showMoney()) return true;
  if (!csvFeeRoles() || !ME) return false;
  const list = rows || [];
  return list.length > 0 && list.every((c) => c && c.assigned_to === ME.id);
}
/* S8 / R5-19 — the month card's KPI set for ANY month, so the same numbers can be computed for the
   selected month, the month before it and the same month a year earlier without duplicating the
   arithmetic. `hasData` answers "do we hold any case rows for that month at all" — the test that
   separates a real zero from a period we simply have no history for. */
function monthKpiSet(all, mv) {
  const inMonth = (d) => d && localMonthStr(d) === mv;
  const sum = (rows, k) => rows.reduce((s, c) => s + Number(c[k] || 0), 0);
  const sub = all.filter((c) => inMonth(c.submitted_at));
  const done = all.filter((c) => inMonth(c.completed_at));
  return {
    mv, sub, done,
    nSub: sub.length, nDone: done.length,
    subTotal: sum(sub, "proc_fee") + sum(sub, "broker_fee") + sum(sub, "sols_fee"),
    doneTotal: sum(done, "proc_fee") + sum(done, "broker_fee") + sum(done, "sols_fee"),
    // Any case row touching that month in any way — created, submitted or completed.
    hasData: all.some((c) => inMonth(c.created_at) || inMonth(c.submitted_at) || inMonth(c.completed_at)),
  };
}

/* ==========================================================================
   R5-F1 — "MY NUMBERS" (Daniel-approved policy change, this round)
   ONE card, on Reports, for the person doing the work. Reports is its home because the page is
   already reachable by every staff role (only the figures on it were Owner-gated), so an adviser
   lands on it without any page-level gating being loosened, and the card sits beside the
   operational figures — completions, funnel, lead sources — that describe the very same cases. My
   Day was the alternative and was rejected: that page is a to-do list scoped to today, and a
   year-to-date money figure parked on it reads as a task.

   THE ONE RULE THIS CARD MUST NEVER BREAK: every figure is scoped to cases assigned_to = the
   signed-in person. No firm total, no colleague's number, no "your share of X". The scope line
   above the tiles says so in words, and each tile states its basis in exactly the form the Owner's
   figures use, so the two can be reconciled rather than argued about.

   Bases, all three already defined and used elsewhere on this page:
     · banked YTD  — cash, per fee type on ITS OWN paid date (coalesce(<type>_fee_paid_at,
                     fee_paid_at)), calendar year, future-dated payments EXCLUDED (the same clamp
                     the target bar applies) and footnoted rather than silently dropped.
     · outstanding — earned but not received: fee amounts on MY COMPLETED cases that carry no paid
                     date at all. Deliberately not fee_status, which is a broker-fee-only workflow
                     field; "no cash date" is the question this tile asks.
     · pipeline    — proc + broker estimate on my offer/exchange cases, UNWEIGHTED. Said on the
                     tile, because the Owner's forecast beside it is probability-weighted and the
                     two would otherwise look like the same number disagreeing.
   ========================================================================== */
function renderMyNumbers(all, yr) {
  const panel = $("#report-mine-panel");
  if (!panel) return;
  const on = showMyNumbers();
  panel.classList.toggle("hidden", !on);
  if (!on) { $("#report-mine").innerHTML = ""; const s0 = $("#report-mine-scope"); if (s0) s0.textContent = ""; return; }

  const mine = (all || []).filter((c) => c.assigned_to === ME.id);
  const banked = cashInYear(mine, yr, ["broker", "proc", "sols"]);

  // Earned but not received, on MY completed cases: every fee amount with no paid date against it.
  let outstanding = 0, outstandingN = 0;
  const outstandingCases = new Set();
  mine.filter((c) => c.stage === "completed").forEach((c) => {
    FEE_TYPES.forEach((f) => {
      const amt = Number(c[f.amountCol] || 0);
      if (!amt) return;
      if (feeCashDate(c, f.dateCol)) return;   // already banked — counted in the tile above
      outstanding += amt; outstandingN++;
      outstandingCases.add(c.id);
    });
  });

  // Pipeline at Offer+ — offer and exchange only, proc + broker, unweighted.
  const OFFER_PLUS = ["offer", "exchange"];
  const offerPlus = mine.filter((c) => OFFER_PLUS.includes(c.stage));
  const pipeline = offerPlus.reduce((s, c) => s + Number(c.proc_fee || 0) + Number(c.broker_fee || 0), 0);

  const scope = $("#report-mine-scope");
  if (scope) {
    scope.textContent = `Your own figures only — every number on this card counts cases assigned to you (${mine.length} case${mine.length === 1 ? "" : "s"}). `
      + `Nothing here is a firm total and no colleague's cases are in it. ${ATTRIB_NOTE}`;
  }
  $("#report-mine").innerHTML = `
    <div class="kpi"><div class="num" title="${esc(fmtM(banked.total))}">${fmtM(banked.total)}</div><div class="lbl">My fees banked ${yr}</div>${basisLine(BASIS_MY_CASH_YTD + (banked.futureN ? ` — ${fmtM(banked.futureTotal)} dated after today (${banked.futureN}) is excluded` : ""))}</div>
    <div class="kpi ${outstanding ? "warn" : ""}"><div class="num" title="${esc(fmtM(outstanding))}">${fmtM(outstanding)}</div><div class="lbl">My fees outstanding</div>${basisLine(BASIS_MY_OUTSTANDING + ` — ${outstandingN} fee${outstandingN === 1 ? "" : "s"} across ${outstandingCases.size} completed case${outstandingCases.size === 1 ? "" : "s"} with no paid date`)}</div>
    <div class="kpi"><div class="num" title="${esc(fmtM(pipeline))}">${fmtM(pipeline)}</div><div class="lbl">My pipeline at Offer+</div>${basisLine(BASIS_MY_PIPELINE + ` — ${offerPlus.length} case${offerPlus.length === 1 ? "" : "s"} at Offer or Exchange, not weighted for fall-through`)}</div>`;
}

function renderMonthReport(all, mv) {
  const money = showMoney();
  // Bucketed on the UK-local month (see monthKpiSet) so this card agrees with the annual chart/YTD.
  const cur = monthKpiSet(all, mv);
  // S8 — the two comparison periods. Both are computed from the SAME `all` dataset the card
  // already has, so no widened fetch and no second RPC.
  const prevMv = monthAdd(mv, -1), yoyMv = monthAdd(mv, -12);
  const prevSet = monthKpiSet(all, prevMv), yoySet = monthKpiSet(all, yoyMv);
  const prevLbl = monthShortLabel(prevMv, false), yoyLbl = monthShortLabel(yoyMv, true);
  /* G1N-7 — a month that has not started yet is empty because it has not started, not because the
     firm collapsed. deltaChip exists precisely to tell those apart, and this was the one case it
     got backwards: cur.hasData false while the prior month has rows sent it down the real-
     percentage branch, so every tile read "0 ▼ −100% vs <last month>". The picker now carries a max
     (see loadReports); a month selected past it says what it is instead of inventing a fall. */
  const notStarted = mv > localMonthStr();
  const futureChip = `<div class="kpi-delta"><span class="delta none" title="${esc(monthLabel(mv))} has not started yet, so there is nothing to compare. This is an empty period, not a fall to zero.">not started yet</span></div>`;
  const cmpCount = (k) => notStarted ? futureChip : deltaChips(cur[k],
    { value: prevSet[k], hasData: prevSet.hasData, label: prevLbl },
    { value: yoySet[k], hasData: yoySet.hasData, label: yoyLbl });
  const cmpMoney = (k) => notStarted ? futureChip : deltaChips(cur[k],
    { value: prevSet[k], hasData: prevSet.hasData, label: prevLbl },
    { value: yoySet[k], hasData: yoySet.hasData, label: yoyLbl }, fmtM);
  const sub = cur.sub, done = cur.done;
  const sum = (rows, k) => rows.reduce((s, c) => s + Number(c[k] || 0), 0);
  $("#month-report-title").textContent = "Monthly business — " + monthLabel(mv);
  // The footnote explains the Proc £ / Broker £ / Sols £ columns and points at "Fees banked (paid)"
  // on the Adviser scoreboard. For a non-Owner those columns are stripped and that panel is hidden,
  // so it described things that aren't on the page — it now shows with the money it describes.
  const legend = $("#month-legend");
  if (legend) legend.classList.toggle("hidden", !money);
  const basisLegend = $("#report-basis-legend");
  /* R5-F1 — the legend names the three bases every money label on this page is counted on, and
     since the My numbers card uses all three it now describes figures an adviser CAN see. Hiding it
     from them was correct while they had no money figures at all; it isn't any more. */
  if (basisLegend) basisLegend.classList.toggle("hidden", !money && !showMyNumbers());
  /* R5-F2 — "Completed £" is the headline: fee value EARNED on the cases that completed this
     month. It is not moved (the tile order is load-bearing for the delta chips beside it) and its
     label is unchanged; the emphasis is carried by kpi-headline, and by the target bar below, which
     now measures the same basis. */
  $("#month-kpis").innerHTML = `
    <div class="kpi"><div class="num">${cur.nSub}</div><div class="lbl">Applications submitted</div>${cmpCount("nSub")}</div>
    ${money ? `<div class="kpi kpi-secondary"><div class="num">${fmtM(cur.subTotal)}</div><div class="lbl">Submitted £ (proc+broker+sols)</div>${basisLine(BASIS_EARNED_ALL)}${cmpMoney("subTotal")}</div>` : ""}
    <div class="kpi"><div class="num">${cur.nDone}</div><div class="lbl">Completions</div>${cmpCount("nDone")}</div>
    ${money ? `<div class="kpi kpi-headline"><div class="num">${fmtM(cur.doneTotal)}</div><div class="lbl">Completed £ (proc+broker+sols)</div>${basisLine(BASIS_EARNED_ALL)}${cmpMoney("doneTotal")}</div>` : ""}`;

  // BUILD 6a — firm monthly fee target (settings.monthly_fee_target, blank = off).
  // B7 / Batch 6.4 — "collected" now means each fee type counted on ITS OWN paid date
  // (coalesce(<type>_fee_paid_at, fee_paid_at)), so a split-paid case lands each £ in the month
  // that money actually arrived, and a payment dated in the future is excluded outright with a
  // footnote rather than silently inflating this month's bar.
  /* R5-F2 (Daniel-approved) — the BAR now measures fees EARNED ON COMPLETION in the month
     (proc+broker+sols on cases whose completed_at falls in it, paid or not), because that is the
     month's work and the thing a target is set against; cash arrives weeks later and used to make
     a fully-worked month read as a miss. The cash figure is NOT deleted and NOT changed — it keeps
     its own line, its own basis label and its own future-date footnote directly underneath, so
     both numbers are on screen and neither can be mistaken for the other. The caption on each line
     states which basis it is. */
  const targetEl = $("#month-fee-target");
  if (targetEl) {
    const target = money ? Number(settings.monthly_fee_target || 0) : 0;
    if (target > 0) {
      const earned = earnedOnCompletion(all, mv);
      const cash = cashInMonth(all, mv, ["broker", "proc", "sols"]);
      const banked = cash.total;
      const pct = Math.round((earned.total / target) * 100);
      const cashPct = Math.round((banked / target) * 100);
      const color = pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--red)";
      targetEl.innerHTML = `
        <div class="panel-sub target-headline" style="margin:12px 0 4px;">Fees earned vs target — ${fmtM(earned.total)} of ${fmtM(target)} (${pct}%) <span class="money-basis">${esc(BASIS_TARGET_EARNED)} — ${earned.n} completion${earned.n === 1 ? "" : "s"} this month, paid or not</span></div>
        <div style="background:var(--light);border-radius:4px;height:16px;overflow:hidden;">
          <div style="width:${Math.min(pct, 100)}%;background:${color};height:16px;"></div>
        </div>
        <div class="panel-sub target-secondary" style="margin:6px 0 0;">Also — total fees collected ${fmtM(banked)} of ${fmtM(target)} (${cashPct}%) <span class="money-basis">${esc(BASIS_TARGET)}${cash.futureN ? ` — excludes future-dated payments (${cash.futureN})` : ""}</span></div>`;
    } else {
      targetEl.innerHTML = "";
    }
  }
  /* R5-2 — PROFILES, not TEAM. A month report is a historical document: the cases somebody
     submitted and completed in June 2026 were theirs in June 2026, and the handover flow now
     deliberately leaves completed cases attributed to them. Iterating TEAM (the STAFF_ROLES subset)
     erased a leaver's entire row the moment their access was removed, so last month's report
     changed retrospectively. PROFILES keeps everybody; the .filter() below still drops anyone with
     no activity in the selected month, so no empty rows appear. */
  const rows = (PROFILES.length ? PROFILES : TEAM).map((p) => {
    const s2 = sub.filter((c) => c.assigned_to === p.id);
    const d2 = done.filter((c) => c.assigned_to === p.id);
    // S8 — the same person's previous month, so a row can be read as a direction and not just a
    // number.
    const pd = prevSet.done.filter((c) => c.assigned_to === p.id);
    return { name: profileName(p.id) || staffName(p.id), nSub: s2.length, sProc: sum(s2, "proc_fee"), sBrk: sum(s2, "broker_fee"), sSol: sum(s2, "sols_fee"),
             nDone: d2.length, dTot: sum(d2, "proc_fee") + sum(d2, "broker_fee") + sum(d2, "sols_fee"),
             pDone: pd.length, pTot: sum(pd, "proc_fee") + sum(pd, "broker_fee") + sum(pd, "sols_fee") };
  /* G1N-1 — the row set is submitted ∪ completed ∪ PREVIOUS-month completions. It used to be the
     selected month only, so anyone who did nothing this month lost their row entirely and their
     prior-month completions vanished out of the comparison column: with July selected the
     "Completed (Jun)" columns totalled 3 cases / £7,080 while June's own card — one click away on
     the same picker — said 4 / £10,825. The whole point of the column is month-on-month
     comparison, so an owner reading "we did 3 last month" against a June report saying 4 had no way
     to tell which figure was wrong. A prior-month-only adviser now appears with zeroes for the
     selected month (greyed, like the comparison columns themselves) and the column reconciles. */
  }).filter((r) => r.nSub || r.nDone || r.pDone);
  // Non-Owner: the per-adviser activity counts stay, the fee columns go.
  const prevHead = `<th title="Completions recorded by this adviser in ${esc(monthLabel(prevMv))} — the month before the one selected.">Completed (${esc(prevLbl)})</th>${money ? `<th title="Fee value earned on those ${esc(monthLabel(prevMv))} completions.">Completed £ (${esc(prevLbl)})</th>` : ""}`;
  $("#month-advisers").innerHTML = rows.length ? `<div style="overflow-x:auto;"><table class="imp-table">
    <tr><th>Adviser</th><th>Submitted</th>${money ? "<th>Proc £</th><th>Broker £</th><th>Sols £</th>" : ""}<th>Completed</th>${money ? '<th title="Value of fees earned on cases completed this month — whether or not those fees have been paid yet">Completed £ (earned)</th>' : ""}${prevHead}</tr>
    ${rows.map((r) => `<tr${r.nSub || r.nDone ? "" : ' class="stat-weak" title="No activity in this month — listed so the previous-month comparison column still totals that month\'s own report."'}><td><strong>${esc(r.name)}</strong></td><td>${r.nSub}</td>${money ? `<td>${fmtM(r.sProc)}</td><td>${fmtM(r.sBrk)}</td><td>${fmtM(r.sSol)}</td>` : ""}<td>${r.nDone}</td>${money ? `<td>${fmtM(r.dTot)}</td>` : ""}<td class="stat-weak">${r.pDone}</td>${money ? `<td class="stat-weak">${fmtM(r.pTot)}</td>` : ""}</tr>`).join("")}
  </table></div>
  <p class="panel-sub month-attrib" id="month-advisers-attrib" style="margin:8px 0 0;">${esc(ATTRIB_NOTE)} The previous-month columns list every adviser who completed anything in ${esc(monthLabel(prevMv))}, including advisers with no activity in ${esc(monthLabel(mv))}, so they total that month's own report.</p>` : '<div class="empty">No submissions or completions recorded for this month.</div>';
}

/* BUILD 5c — the Reports month picker (defaults to the current month) now threads into every
   panel where a month scope is meaningful: adviser scoreboard, pipeline funnel, lead sources.
   Open-case counts and overdue-task counts describe "right now" rather than a historical window,
   so those stay live even inside the threaded scoreboard panel. Computed entirely client-side from
   `all` (the same cases already fetched for the rest of Reports) — no RPC change needed. */
function renderThreadedPanels(all, mv, repAdvisers) {
  const inMonth = (d) => d && localMonthStr(d) === mv;
  const label = monthLabel(mv);
  const money = showMoney();
  const activeStages = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
  // The whole Adviser scoreboard is a money panel (fees banked per person) — Owner-only in the UI.
  const board = $("#report-scoreboard-panel");
  if (board) board.classList.toggle("hidden", !money);

  // ---- Adviser scoreboard: completions/fees/avg-days scoped to the selected month, plus a 6-month
  // rolling completions trend (BUILD 6a) — same completed-cases data, just bucketed by calendar month
  // instead of the single selected month, so no widened fetch was needed (the cases query already
  // pulls every row with no date filter).
  // T1-18 — overdue counts are keyed by staff id, not full_name: two people called the same thing
  // collided into one number. `name` is kept only as a fallback for an RPC shape without an id.
  const overdueById = {}, overdueByName = {};
  /* G1N-8 — get_reports.fees_banked_ytd is the figure M5 was shipped for, and until now nothing on
     any screen read it: no UI consumer means no test could ever catch it regressing, and it could
     drift away from the firm-wide "Fees banked" tile unnoticed. It is rendered here, per adviser,
     beside that adviser's month figure. It is deliberately NOT recomputed client-side — the point
     is to show what the RPC says, so the two can be seen to agree (or not). */
  const ytdById = {};
  (Array.isArray(repAdvisers) ? repAdvisers : []).forEach((a) => {
    const sid = a.staff_id || a.id;
    if (sid) overdueById[sid] = a.overdue_tasks;
    else overdueByName[a.name] = a.overdue_tasks;
    if (sid && a.fees_banked_ytd != null) ytdById[sid] = Number(a.fees_banked_ytd) || 0;
  });
  const months6 = last6Months();
  // `id === null` builds the Unassigned bucket. Everything else is per-owner.
  const mkAdvRow = (id, name, offTeam) => {
    const mine = all.filter((c) => (id ? c.assigned_to === id : !c.assigned_to));
    const open = mine.filter((c) => activeStages.includes(c.stage)).length;
    const done = mine.filter((c) => inMonth(c.completed_at));
    // B7 / Batch 6.4 — broker cash counted on the BROKER fee's own paid date (M2), falling back to
    // the legacy single date, and never counting a payment dated in the future.
    const feesBanked = cashInMonth(mine, mv, ["broker"]).total;
    const days = done.map((c) => Math.round((new Date(c.completed_at) - new Date(c.created_at)) / 86400000)).filter((n) => n > 0);
    const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
    const trend = months6.map((m) => mine.filter((c) => c.completed_at && localMonthStr(c.completed_at) === m).length);
    const trendTitle = months6.map((m, i) => `${MONTH_SHORT[Number(m.slice(5, 7)) - 1]}: ${trend[i]}`).join(" · ");
    const overdue = id ? (overdueById[id] != null ? overdueById[id] : overdueByName[name]) : undefined;
    return { id, name, offTeam: !!offTeam, open, completions: done.length, feesBanked, overdue, avg, n: days.length, trend, trendTitle };
  };
  // T1-18 — TEAM.map() alone cannot represent work nobody owns, so the Open column silently came up
  // short against the Live cases KPI. Append the unassigned bucket, plus a row for anyone holding
  // cases who isn't on the team at all, so every live case is accounted for on this table.
  const teamIds = TEAM.map((p) => p.id);
  const strays = [];
  all.forEach((c) => { if (c.assigned_to && teamIds.indexOf(c.assigned_to) === -1 && strays.indexOf(c.assigned_to) === -1) strays.push(c.assigned_to); });
  const advRows = TEAM.map((p) => mkAdvRow(p.id, staffName(p.id), false))
    // A stray holder now has a name to show — PROFILES keeps everyone, so "Not on the team (p3)"
    // only appears when the profile itself is gone.
    .concat(strays.map((id) => mkAdvRow(id, profileName(id) ? profileName(id) + " — no access" : "Not on the team (" + id + ")", true)))
    .concat([mkAdvRow(null, "Unassigned", true)])
    .filter((r) => r.open || r.completions || r.feesBanked || r.trend.some((n) => n));
  // One vertical scale for the whole trend column (see sparklineSvg).
  const sparkMax = Math.max(1, ...advRows.map((r) => Math.max.apply(null, r.trend)));
  const liveTotal = all.filter((c) => activeStages.includes(c.stage)).length;
  const openSum = advRows.reduce((s, r) => s + r.open, 0);
  const unassignedLive = all.filter((c) => !c.assigned_to && activeStages.includes(c.stage)).length;
  const advName = (a) => {
    const target = a.id === null ? "unassigned" : (a.offTeam ? null : a.id);
    return target
      ? `<button type="button" class="linkish" onclick="reportGotoAdviser('${esc(target)}')" title="Open the pipeline filtered to ${esc(a.name)}">${esc(a.name)}</button>`
      : esc(a.name);
  };
  // T1-18 — the sample size travels with the average. In a month where every adviser has exactly
  // one completion, "110 vs 75" is one case against one case; below n=3 it is greyed so it can't be
  // read as a ranking.
  const advAvg = (a) => {
    if (a.avg == null) return "—";
    const basis = `Mean days from case created to completed, over the ${a.n} completion${a.n === 1 ? "" : "s"} ${a.name} recorded in ${label}.`;
    return a.n < 3
      ? `<span class="stat-weak" title="${esc(basis)} Fewer than 3 completions — not a ranking.">${a.avg} <span class="stat-n">(${a.n})</span></span>`
      : `<span title="${esc(basis)}">${a.avg} <span class="stat-n">(${a.n})</span></span>`;
  };
  if (!money) { $("#report-advisers").innerHTML = ""; $("#report-scoreboard-scope").textContent = ""; }
  else {
  const bankedFuture = cashInMonth(all, mv, ["broker"]).futureN;
  /* G1N-8 — the RPC's per-adviser YTD covers profiles with a staff role only, while the firm-wide
     tile below counts every case. The difference is real (completed cases deliberately stay with a
     leaver who no longer has a login), so it is stated rather than left to be discovered as a
     mismatch between two numbers on the same screen. */
  const ytdYear = Number(localDateStr().slice(0, 4));
  const ytdRpcSum = Object.keys(ytdById).reduce((s, k) => s + ytdById[k], 0);
  const ytdFirm = all.reduce((s, c) => {
    const d = feeCashDate(c, "broker_fee_paid_at");
    return d && Number(localDateStr(d).slice(0, 4)) === ytdYear ? s + Number(c.broker_fee || 0) : s;
  }, 0);
  const ytdGap = ytdFirm - ytdRpcSum;
  $("#report-scoreboard-scope").textContent = `Completions, fees banked and avg days are for ${label}. Open cases and overdue tasks are as of now. Trend is completions over the last 6 calendar months, all rows drawn on one shared scale. "Fees banked" here is broker fees actually received this month, each counted on the date that fee was paid — a different scope from "Completed £ (earned)" on the Monthly business panel above, which is fee value earned on cases completed this month regardless of payment status.${bankedFuture ? ` Excludes future-dated payments (${bankedFuture}).` : ""} "Banked ${ytdYear}" is that adviser's broker cash for the calendar year, straight from get_reports.${ytdGap ? ` It covers people who still have a login, so it totals ${fmtM(ytdRpcSum)} against the ${fmtM(ytdFirm)} on the "Fees banked ${ytdYear}" tile below — the ${fmtM(ytdGap)} difference sits on completed cases still attributed to someone whose access has been removed.` : ""} ${ATTRIB_NOTE}`;
  $("#report-advisers").innerHTML = advRows.length ? `<table class="imp-table">
    <tr><th>Adviser</th><th>Open</th><th>Completions</th><th title="Broker fees actually received this month, counted on the broker fee's own paid date. Payments dated in the future are excluded.">Fees banked (paid)<span class="money-basis">${esc(BASIS_CASH_MONTH)}</span></th><th title="Broker fees this adviser has banked so far in ${ytdYear}, as reported by get_reports (M5) — the same coalesce(broker_fee_paid_at, fee_paid_at) basis as the column beside it, widened to the whole year.">Banked ${ytdYear}<span class="money-basis">(broker only · cash · YTD)</span></th><th>Overdue</th><th title="Mean days from case created to completed, over completions in the selected month only. The sample size is in brackets; fewer than 3 completions is greyed and should not be read as a ranking.">Avg days</th><th title="Completions per month over the last 6 calendar months. Every row shares one vertical scale (peak ${sparkMax}); the number is this month's value.">6-mo trend</th></tr>
    ${advRows.map((a) => `<tr${a.offTeam ? ' class="row-warn"' : ""}>
      <td>${advName(a)}</td>
      <td>${a.open}</td>
      <td>${a.completions}</td>
      <td>${fmtM(a.feesBanked)}</td>
      <td${a.id && ytdById[a.id] == null ? ' class="stat-weak" title="Not covered by get_reports — this row has no active login."' : ""}>${a.id && ytdById[a.id] != null ? fmtM(ytdById[a.id]) : "—"}</td>
      <td>${a.overdue ? `<span class="badge red">${a.overdue}</span>` : (a.overdue == null ? "—" : "0")}</td>
      <td>${advAvg(a)}</td>
      <td title="${esc(a.trendTitle)}">${sparklineSvg(a.trend, sparkMax)} <span class="spark-now">${a.trend[a.trend.length - 1]}</span></td>
    </tr>`).join("")}
    <tr id="report-scoreboard-foot" class="scoreboard-foot">
      <td><strong>Total</strong></td>
      <td><strong>${openSum}</strong></td>
      <td colspan="6">${openSum === liveTotal ? "reconciles with" : `<strong>does not reconcile with</strong>`} the ${liveTotal} live cases on the KPI row below${unassignedLive ? ` · ${unassignedLive} of them unassigned` : ""}.</td>
    </tr>
  </table>` : `<div class="empty">No adviser activity in ${label}.</div>`;
  }

  // ---- Pipeline funnel: cases created in the selected month, by current stage (all 8 stages,
  // so a month's cohort that has already completed or dropped out still shows up). ----
  const monthCases = all.filter((c) => inMonth(c.created_at));
  $("#report-funnel-scope").textContent = `${monthCases.length} case${monthCases.length === 1 ? "" : "s"} created in ${label}, by current stage.`;
  const maxF = Math.max(...STAGES.map(([s]) => monthCases.filter((c) => c.stage === s).length), 1);
  $("#report-funnel").innerHTML = monthCases.length ? STAGES.map(([s, l]) => {
    const n = monthCases.filter((c) => c.stage === s).length;
    return n ? `
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0;cursor:pointer;" class="funnel-row" onclick="reportGotoStage('${s}')" title="Open the pipeline at the ${esc(l)} stage">
      <span style="width:90px;font-size:12px;color:var(--muted);">${l}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(n / maxF) * 100}%;background:var(--orange);border-radius:4px;height:16px;"></div></div>
      <span style="width:24px;font-size:12px;font-weight:600;">${n}</span>
    </div>` : "";
  }).join("") : `<div class="empty">No cases created in ${label}.</div>`;

  // ---- Lead sources: leads (cases) created in the selected month. ----
  const srcMap = {};
  monthCases.forEach((c) => {
    const k = (c.lead_source || "").trim() || "(not set)";
    srcMap[k] = srcMap[k] || { cases: 0, completed: 0, lost: 0, live: 0, revenue: 0, last: null };
    const v = srcMap[k];
    v.cases++;
    if (c.created_at && (!v.last || c.created_at > v.last)) v.last = c.created_at;
    if (c.stage === "completed") { v.completed++; v.revenue += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0); }
    else if (c.stage === "not_proceeding") v.lost++;
    else v.live++;
  });
  $("#report-sources-scope").textContent = `Set the lead source on cases to build this up. Scoped to leads created in ${label}.`;
  // Lead-source VOLUMES are operational and stay for everyone; the Revenue column is money.
  $("#report-sources").innerHTML = monthCases.length ? `<table class="imp-table">
    <tr><th>Source</th><th>Cases</th><th title="Still in the live pipeline — neither won nor lost, and excluded from Conversion">Live</th><th>Completed</th><th title="${esc(CONV_TH_TITLE)}">Conversion</th><th>Last lead</th>${money ? "<th>Revenue</th>" : ""}</tr>
    ${Object.entries(srcMap).sort((a, b) => b[1].cases - a[1].cases).map(([k, v]) => `<tr>
      <td>${k === "(not set)" ? esc(k) : `<button type="button" class="linkish" onclick="reportGotoSearch('${jsArg(k)}')" title="Open the pipeline filtered to ${esc(k)}">${esc(k)}</button>`}</td>
      <td>${v.cases}</td>
      <td>${v.live}</td>
      <td>${v.completed}</td>
      <td>${convCell(v.completed, v.lost)}</td>
      <td>${fmtD(v.last)}</td>
      ${money ? `<td>${fmtM(v.revenue)}</td>` : ""}
    </tr>`).join("")}
  </table>` : `<div class="empty">No leads created in ${label}.</div>`;

  renderLossesPanel(all, mv);
}

/* ==========================================================================
   B3 / R5-20 — LOSSES BY REASON
   Batch 2 made a reason mandatory on the way to Not Proceeding; this is the panel that reason was
   collected for. Grouped by lost_reason with an explicit "(not recorded)" bucket for every case
   that was closed before the field existed — the legacy rows are shown, not hidden, because the
   size of that bucket is itself the honest answer to "why are we losing work".
   Scope: by default the selected month, dated by the STAGE-CHANGE event where the event log has
   one (when the case actually stopped) and by updated_at where it doesn't; an all-time toggle
   sits on the panel head because a single month of losses is usually too few to read.
   ========================================================================== */
let lossesAllTime = false;
let lossState = { all: [], mv: null, lostAt: {} };
window.lossState = lossState; // test hook — mutated in place (see renderLossesPanel/loadLostDates), never reassigned, so this stays live.
/* When a case stopped: the most recent stage_changed event INTO not_proceeding, else last touched.
   `lostAt` is loaded best-effort (loadLostDates) so a blocked/absent case_events degrades to
   updated_at rather than emptying the panel. */
function lostWhen(c) { return lossState.lostAt[c.id] || c.updated_at || c.created_at || null; }
function renderLossesPanel(all, mv) {
  lossState.all = all || lossState.all;
  lossState.mv = mv || lossState.mv;
  const panel = $("#report-losses-panel");
  const money = showMoney();
  // Σ fees lost is money, so this is an owner panel (presentation, not a control — same caveat as
  // the scoreboard above).
  if (panel) panel.classList.toggle("hidden", !money);
  if (!money) { $("#report-losses").innerHTML = ""; return; }
  const rowsAll = (lossState.all || []).filter((c) => c.stage === "not_proceeding");
  const scoped = lossesAllTime ? rowsAll : rowsAll.filter((c) => {
    const d = lostWhen(c);
    return d && localMonthStr(d) === lossState.mv;
  });
  const btn = $("#report-losses-scope-btn");
  if (btn) btn.textContent = lossesAllTime ? "This month" : "All time";
  const scopeEl = $("#report-losses-scope");
  if (scopeEl) {
    scopeEl.textContent = lossesAllTime
      ? `Every case marked not proceeding, all time (${rowsAll.length}). "Σ fees lost" is the fee value that was on the case when it stopped — earned nothing, so it is a measure of what walked away, not of money owed.`
      : `Cases marked not proceeding in ${monthLabel(lossState.mv)} (${scoped.length} of ${rowsAll.length} all time), dated by the stage change where the event log records one and by last touched where it doesn't. "Σ fees lost" is the fee value that was on the case when it stopped.`;
  }
  if (!scoped.length) {
    $("#report-losses").innerHTML = `<div class="empty">${lossesAllTime ? "No cases have been marked not proceeding." : `No cases were marked not proceeding in ${esc(monthLabel(lossState.mv))}.`}</div>`;
    return;
  }
  const buckets = {};
  scoped.forEach((c) => {
    const key = c.lost_reason || "";
    const b = buckets[key] || (buckets[key] = { key, label: LOST_REASON_LABEL[key] || "(not recorded)", n: 0, loan: 0, fees: 0, byAdv: {} });
    b.n++;
    b.loan += Number(c.loan_amount || 0);
    b.fees += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
    const an = c.assigned_to ? (profileName(c.assigned_to) || staffName(c.assigned_to)) : "Unassigned";
    b.byAdv[an] = (b.byAdv[an] || 0) + 1;
  });
  const list = Object.values(buckets).sort((a, b) => b.n - a.n || b.fees - a.fees);
  const tot = list.reduce((s, b) => ({ n: s.n + b.n, loan: s.loan + b.loan, fees: s.fees + b.fees }), { n: 0, loan: 0, fees: 0 });
  const advBits = (b) => Object.entries(b.byAdv).sort((x, y) => y[1] - x[1])
    .map(([n, k]) => `${esc(n)} ${k}`).join(" · ");
  $("#report-losses").innerHTML = `<table class="imp-table">
    <tr><th>Reason</th><th>Cases</th><th title="Total loan value on the cases that stopped">Σ loan</th><th title="Fee value that was on those cases — proc + broker + sols. Never invoiced, never banked.">Σ fees lost<span class="money-basis">(earned · never billed)</span></th><th>By adviser</th></tr>
    ${list.map((b) => `<tr${b.key ? "" : ' class="loss-unrecorded"'}>
      <td>${esc(b.label)}</td>
      <td>${b.n}</td>
      <td>${fmtM(b.loan)}</td>
      <td>${fmtM(b.fees)}</td>
      <td class="loss-advisers">${advBits(b)}</td>
    </tr>`).join("")}
    <tr class="scoreboard-foot"><td><strong>Total</strong></td><td><strong>${tot.n}</strong></td><td><strong>${fmtM(tot.loan)}</strong></td><td><strong>${fmtM(tot.fees)}</strong></td><td></td></tr>
  </table>`;
}
window.toggleLossesScope = function () {
  lossesAllTime = !lossesAllTime;
  renderLossesPanel(null, null);
};

/* BUILD 5c — Commission forecast, reworked into buckets. Scoped to open cases at offer/exchange
   only (the two stages close enough to completion that a date is meaningful), weighted by the
   same per-stage conversion the old by-stage forecast used (read from get_reports()'s mock:
   offer 80%, exchange 95%). Bucketed by expected_completion_date — "This month" also swallows
   any overdue date so nothing silently vanishes. Purely client-side from `all`, independent of
   the Reports month picker (this is a live forward-look, not a historical one) and of the RPC,
   so it renders — all under "No date" — even on day one in prod when the column is all-null. */
function renderForecastBuckets(all) {
  // Commission forecast = money. Owner-only in the UI (presentation, not a control).
  const fcPanel = $("#report-forecast-panel");
  if (fcPanel) fcPanel.classList.toggle("hidden", !showMoney());
  if (!showMoney()) { $("#report-forecast-headline").innerHTML = ""; $("#report-forecast-buckets").innerHTML = ""; return; }
  // T1-17 — the forecast now covers the live book, not just its last two stages. Application and
  // DIP cases carry real commission and were invisible here; they keep the same per-stage
  // conversion basis the offer/exchange weights already used, just further down the pipeline.
  const STAGE_WEIGHT = { decision_in_principle: 0.25, application: 0.5, offer: 0.8, exchange: 0.95 };
  const commission = (c) => Number(c.broker_fee || 0) + Number(c.proc_fee || 0);
  const open = all.filter((c) => STAGE_WEIGHT[c.stage] != null);
  // T1-17 — rolling horizon from today (Europe/London), not calendar months. The question this
  // panel answers is "what completes in the next 60 days and what is it worth"; under calendar
  // months a case due in 40 days sat in "Later" next to one due in a year.
  const d30 = localDateStr(Date.now() + 30 * 86400000);
  const d60 = localDateStr(Date.now() + 60 * 86400000);
  const d90 = localDateStr(Date.now() + 90 * 86400000);
  const buckets = {
    h30: { label: "≤30 days", cases: 0, weighted: 0 },
    h60: { label: "31-60 days", cases: 0, weighted: 0 },
    h90: { label: "61-90 days", cases: 0, weighted: 0 },
    later: { label: "Later", cases: 0, weighted: 0 },
    none: { label: "No date", cases: 0, weighted: 0, list: [] },
  };
  let gross_total = 0;
  open.forEach((c) => {
    const gross = commission(c);
    gross_total += gross;
    const weighted = gross * STAGE_WEIGHT[c.stage];
    let key = "none";
    if (c.expected_completion_date) {
      // An already-overdue date lands in the nearest bucket rather than vanishing.
      const d = String(c.expected_completion_date).slice(0, 10);
      key = d <= d30 ? "h30" : d <= d60 ? "h60" : d <= d90 ? "h90" : "later";
    }
    buckets[key].cases++;
    buckets[key].weighted += weighted;
    if (key === "none") buckets.none.list.push(c);
  });
  const weighted_total = Object.values(buckets).reduce((s, b) => s + b.weighted, 0);
  // R5-17 — say what this money IS: a probability-weighted forward look at proc + broker fee on
  // live cases. Solicitor referral fees are not in it, and none of it has been earned yet.
  $("#report-forecast-headline").innerHTML = `
    <div class="kpi"><div class="num">${fmtM(weighted_total)}</div><div class="lbl">Weighted commission</div>${basisLine(BASIS_FORECAST)}</div>
    <div class="kpi"><div class="num">${fmtM(gross_total)}</div><div class="lbl">Gross (unweighted)</div>${basisLine("(not yet earned · proc+broker, excl. sols)")}</div>`;
  const maxW = Math.max(...Object.values(buckets).map((b) => b.weighted), 1);
  $("#report-forecast-buckets").innerHTML = open.length ? ["h30", "h60", "h90", "later", "none"].map((k) => {
    const b = buckets[k];
    // BUILD 6c — the "No date" bucket is the feed for the completion-date chaser: let the adviser
    // drill into exactly which cases are missing a date, one click each straight to the case.
    const canExpand = k === "none" && b.cases > 0;
    const row = `
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
      <span style="width:90px;font-size:12px;color:var(--muted);">${b.label}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(b.weighted / maxW) * 100}%;background:var(--orange);border-radius:4px;height:16px;"></div></div>
      <span style="width:150px;font-size:12px;font-weight:600;text-align:right;">${b.cases} case${b.cases === 1 ? "" : "s"} · ${fmtM(b.weighted)}</span>
      ${canExpand ? `<button type="button" class="btn btn-sm" id="report-forecast-none-toggle" onclick="toggleForecastNoneList()">▸ Show</button>` : ""}
    </div>`;
    const expandList = canExpand ? `
    <div id="report-forecast-none-list" class="hidden" style="margin:0 0 8px 98px;">
      ${b.list.map((c) => `
        <div class="row-item" style="padding:6px 8px;">
          <div class="row-main">
            <div class="t" style="cursor:pointer;" onclick="openCase('${c.id}')">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "—")}</div>
            <div class="s">${esc(STAGE_LABEL[c.stage] || c.stage)}${c.assigned_to ? " · " + esc(initials(c.assigned_to)) : ""}</div>
          </div>
        </div>`).join("")}
    </div>` : "";
    return row + expandList;
  }).join("") : '<div class="empty">No live cases between DIP and exchange.</div>';
  const hintEl = $("#report-forecast-hint");
  if (hintEl) {
    hintEl.textContent = (open.length && buckets.none.cases === open.length)
      ? "None of these cases have an expected completion date yet — set one on each case (in Case details) to sharpen this forecast."
      : "Live cases from DIP to exchange, weighted by stage conversion (DIP 25% · application 50% · offer 80% · exchange 95%) and bucketed by how far off the expected completion date is, counted forward from today. An overdue date counts in the ≤30 days bucket.";
  }
}
// BUILD 6c — expand/collapse the "No date" bucket's offending-case list. State lives only on the
// DOM (like toggleDrawer above) so it survives the panel's own re-renders within a session.
window.toggleForecastNoneList = function () {
  const list = $("#report-forecast-none-list");
  const btn = $("#report-forecast-none-toggle");
  if (!list) return;
  const willShow = list.classList.contains("hidden");
  list.classList.toggle("hidden", !willShow);
  if (btn) btn.textContent = willShow ? "▾ Hide" : "▸ Show";
};

/* Batch 6 feature-detection (M2). PostgREST answers a select naming a column that doesn't exist
   with 42703 for the WHOLE statement, so these columns are read in a separate, small query: on an
   older database it fails alone and Reports still renders with the legacy single fee_paid_at and
   an all-"(not recorded)" losses panel. Returns id → {…columns} or null when unavailable. */
/* G1N-4 — one ordered, explicitly-bounded walk shared by every Reports select. The M2 columns are
   merged onto the main cases select BY ID, so if the two queries ever return different subsets the
   missing rows silently revert to the legacy single fee_paid_at and to the "(not recorded)" loss
   bucket — no error, nothing on screen, exactly the failure mode M2/M5 were built to end. Past
   PostgREST's max-rows cap (1000 by default) an unordered, unbounded select is free to do that.
   Ordering both by id and asking for the same explicit ceiling keeps them walking the same set. */
let REPORTS_ROW_CAP = 5000;
/* R5-F4 — the cap above is honest about being a cap only if the page says when it BITES. A select
   that comes back holding exactly REPORTS_ROW_CAP rows is, as far as the client can tell, truncated:
   every figure below then describes the first N cases by id and nothing on screen says so. These
   two collect that fact per select and renderCapNotice() turns it into one line.
   `=== cap` rather than `>=`: PostgREST cannot return more than the ceiling, and a book that is
   exactly 5000 cases long is a false positive worth having over a silent truncation. */
let reportsCapHits = [];
function noteRowCap(label, rows) {
  if (Array.isArray(rows) && rows.length === REPORTS_ROW_CAP) reportsCapHits.push(label);
}
function renderCapNotice() {
  const el = $("#report-cap-notice");
  if (!el) return;
  const hit = reportsCapHits.length > 0;
  el.classList.toggle("hidden", !hit);
  el.textContent = hit
    ? `⚠ Showing the first ${REPORTS_ROW_CAP.toLocaleString("en-GB")} cases — figures describe this subset, not the whole book. (Reached on: ${[...new Set(reportsCapHits)].join(", ")}.)`
    : "";
}
/* SANDBOX ONLY — the mock harness needs to make the cap bite on a 50-case fixture. Defined only
   when the mock supabase bundle is what loaded, so it cannot exist in the shipped app. */
if (typeof window !== "undefined" && window.supabase && window.supabase.__isMock) {
  window.__setReportsRowCap = function (n) { REPORTS_ROW_CAP = Number(n) || 5000; return REPORTS_ROW_CAP; };
}
/* G1N-9 — "…→ not_proceeding" (the move INTO the lost stage), never "not_proceeding → …" (a
   reopen). The bare-name alternative covers a writer that records only the new stage. */
const LOST_EVENT_RE = /(?:→|->)\s*not_proceeding\s*$|^\s*not_proceeding\s*$/;
async function loadCaseExtraColumns() {
  try {
    const { data, error } = await db.from("cases").select("id,lost_reason,broker_fee_paid_at,proc_fee_paid_at,sols_fee_paid_at")
      .order("id").limit(REPORTS_ROW_CAP);
    if (error) return null;
    noteRowCap("case fee dates", data);
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) { const { id, ...rest } = r; map[id] = rest; } });
    return map;
  } catch (_) { return null; }
}
/* When each case actually stopped, from the event log: the most recent stage_changed event whose
   detail names not_proceeding. Best-effort in the same spirit as loadStageEntries() — a blocked or
   absent case_events leaves the map empty and the losses panel dates by updated_at instead. */
async function loadLostDates() {
  try {
    // G1N-4 — case_events is the fastest-growing table in the schema (278 rows on a 54-case
    // fixture); truncated silently, the losses panel starts dating cases by updated_at while its
    // own scope line still claims it dated them by the stage change. Ordered and capped.
    const { data, error } = await db.from("case_events").select("case_id,event,detail,created_at")
      .eq("event", "stage_changed").order("created_at").limit(REPORTS_ROW_CAP);
    if (error) return {};
    noteRowCap("stage-change history", data);
    const map = {};
    (data || []).forEach((e) => {
      if (!e || !e.case_id || !e.created_at) return;
      /* G1N-9 — anchor on the DESTINATION. The trigger writes detail as "<old> → <new>", so a bare
         /not_proceeding/ also matches a REOPEN ("not_proceeding → offer"), which is newer and would
         win the max() below. Today the panel is saved only by the stage filter running first; any
         future writer that sets stage without emitting a stage_changed event would turn that into a
         wrong "lost in <month>" date, which moves money between months. */
      if (!LOST_EVENT_RE.test(String(e.detail || ""))) return;
      if (!map[e.case_id] || e.created_at > map[e.case_id]) map[e.case_id] = e.created_at;
    });
    return map;
  } catch (_) { return {}; }
}

async function loadReports() {
  const yr = Number(localDateStr().slice(0, 4)); // G1N-6 — Europe/London, like every other figure here
  const thisMonth = localMonthStr();
  const picker = $("#report-month");
  /* G1N-7 — a month that has not started yet is not a 100% collapse. With no max the picker happily
     offered next month, cur.hasData came back false while the PREVIOUS month (this one) had rows,
     so deltaChip took its real-percentage branch and every tile read "0 ▼ −100% vs <this month>" —
     the one case the "no data" wording exists to separate out, reported backwards. */
  if (picker && !picker.max) picker.max = thisMonth;
  const mv = (picker && picker.value) || thisMonth;
  if (picker && !picker.value) picker.value = mv;
  reportsCapHits = []; // R5-F4 — one verdict per render, never carried over from the last one
  const [{ data: cases }, { data: intros }, repRes, extraCols, lostAt] = await Promise.all([
    // G1N-4 — same order and same explicit ceiling as loadCaseExtraColumns, so the two selects
    // that are merged by id below can never walk different subsets of the table.
    db.from("cases").select("id,stage,case_kind,loan_amount,broker_fee,proc_fee,sols_fee,submitted_at,fee_status,fee_paid_at,completed_at,created_at,updated_at,lead_source,introducer_id,protection_status,retention_source_case_id,assigned_to,nps_score,expected_completion_date,clients(first_name,last_name)")
      .order("id").limit(REPORTS_ROW_CAP),
    db.from("introducers").select("id,name"),
    db.rpc("get_reports"),
    // M2 columns in their OWN query, so an un-migrated database (42703 on the whole select) costs
    // the losses panel and the per-type cash dates, not the entire Reports page.
    loadCaseExtraColumns(),
    loadLostDates(),
  ]);
  const all = cases || [];
  noteRowCap("cases", cases);
  renderCapNotice();
  // Merge the feature-detected columns onto the rows. Where the migration hasn't run these stay
  // undefined and every consumer falls back: feeCashDate → fee_paid_at, lost_reason → "(not
  // recorded)".
  if (extraCols) all.forEach((c) => { const x = extraCols[c.id]; if (x) Object.assign(c, x); });
  lossState.lostAt = lostAt || {};
  renderMyNumbers(all, yr);
  renderMonthReport(all, mv);
  const activeStages = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
  const active = all.filter((c) => activeStages.includes(c.stage));
  /* G1N-6 — bucket on the SAME Europe/London basis as every other Batch-6 figure. `new
     Date(x).getFullYear()` reads the BROWSER's timezone, so on a machine set to another zone a
     completion (or a fee) stamped near a year boundary was counted in one year by these tiles and
     another by the month card and the chart beside them. localDateStr is the page's one basis. */
  const yearOf = (d) => localDateStr(d).slice(0, 4);
  const completedYr = all.filter((c) => c.completed_at && yearOf(c.completed_at) === String(yr));
  const pipelineValue = active.reduce((s, c) => s + Number(c.loan_amount || 0), 0);
  // B7 / M5 — broker cash for the year on the BROKER fee's own paid date, coalescing to the legacy
  // single date. Deliberately the same expression M5 puts in get_reports.fees_banked_ytd, so the
  // tile and the RPC cannot disagree. (No future-date clamp here: a year-to-date figure matches the
  // RPC exactly; the month-scoped figures above do the clamping.)
  // G1N-3 — but it is not left silent: a payment dated after today has NOT been received, and the
  // target bar and the scoreboard on this same screen both exclude exactly those. The tile keeps
  // the RPC's basis and states, underneath, how much of it is still in the future and what has
  // actually landed, so "cash" can no longer quietly mean "cash plus money we expect".
  let feesPaidYrFuture = 0, feesPaidYrFutureN = 0;
  const todayStrYtd = localDateStr();
  const feesPaidYr = all.reduce((s, c) => {
    const d = feeCashDate(c, "broker_fee_paid_at");
    if (!d || yearOf(d) !== String(yr)) return s;
    const amt = Number(c.broker_fee || 0);
    if (localDateStr(d) > todayStrYtd) { feesPaidYrFuture += amt; feesPaidYrFutureN++; }
    return s + amt;
  }, 0);
  /* G1N-2 — the tile is not "invoiced money": it counts fee_status in ('not_requested','requested'),
     and on the current book most of it has never been asked for. Splitting the two states here lets
     the basis line say so, so nobody goes looking for invoices behind the bigger half. */
  const feesOutstandingRows = all.filter((c) => ["not_requested", "requested"].includes(c.fee_status) && c.broker_fee > 0 && c.stage !== "not_proceeding");
  const feesOutstanding = feesOutstandingRows.reduce((s, c) => s + Number(c.broker_fee || 0), 0);
  const feesInvoiced = feesOutstandingRows.filter((c) => c.fee_status === "requested").reduce((s, c) => s + Number(c.broker_fee || 0), 0);
  const feesNotInvoiced = feesOutstanding - feesInvoiced;
  const rets = all.filter((c) => c.retention_source_case_id);
  const rWon = rets.filter((c) => c.stage === "completed").length;
  const rLost = rets.filter((c) => c.stage === "not_proceeding").length;
  const protDone = completedYr.filter((c) => c.protection_status === "policy_taken").length;
  const scored = all.filter((c) => c.nps_score != null);
  const avgNps = scored.length ? scored.reduce((s, c) => s + Number(c.nps_score), 0) / scored.length : null;
  const promoterPct = scored.length ? Math.round((scored.filter((c) => c.nps_score >= 9).length / scored.length) * 100) : null;

  // Live snapshot — not affected by the month picker (see .report-live-note above these in the DOM):
  // this KPI row mixes year-to-date and always-current figures, pipeline loan value and NPS are
  // all-time/live-state, and client LTV (below, RPC-backed) is a lifetime figure by nature.
  // T1-19 — these tiles are visually identical to the Today tiles, which have been clickable since
  // defect 19; here they were inert markup, so the same number is a link on one page and a dead end
  // on the other. The three with an unambiguous destination now take the same kpiGoto route. The
  // `title` on .num carries the full value so a narrow column can never quietly truncate it.
  const money = showMoney();
  const moneyNote = $("#report-money-note");
  if (moneyNote) {
    moneyNote.classList.toggle("hidden", money);
    moneyNote.textContent = money ? "" : "Firm-wide money figures — fees banked and outstanding, pipeline loan value, the adviser scoreboard, the forecast, introducer revenue and client lifetime value — are shown to the Owner only. Case counts, the funnel, completions and lead sources are below, your own numbers are in the My numbers card at the top, and the fees on your own cases are on each case.";
  }
  /* R5-F2 (Daniel-approved) — the HEADLINE fee figure for the year is now what the firm EARNED on
     the cases it completed (proc+broker+sols on completed_at), not what happened to arrive in the
     bank. "Fees banked" is not deleted and its arithmetic is untouched — it keeps its tile, its
     basis label and its future-dated footnote, one place further along and marked secondary. */
  const earnedYr = earnedOnCompletion(all, String(yr));
  $("#report-kpis").innerHTML = `
    <div class="kpi kpi-click" onclick="kpiGoto('completed')" title="View completed cases in the pipeline"><div class="num">${completedYr.length}</div><div class="lbl">Completions ${yr}</div></div>
    <div class="kpi kpi-click" onclick="kpiGoto('active')" title="View the pipeline"><div class="num">${active.length}</div><div class="lbl">Live cases</div></div>
    ${money ? `<div class="kpi kpi-click" onclick="kpiGoto('active')" title="View the pipeline — loan value of the ${active.length} live cases"><div class="num" title="${esc(fmtM(pipelineValue))}">${fmtM(pipelineValue)}</div><div class="lbl">Pipeline loan value</div></div>` : ""}
    ${money ? `<div class="kpi kpi-headline"><div class="num" title="${esc(fmtM(earnedYr.total))}">${fmtM(earnedYr.total)}</div><div class="lbl">Fees earned ${yr}</div>${basisLine(BASIS_EARNED_YTD + ` — ${earnedYr.n} completion${earnedYr.n === 1 ? "" : "s"}, paid or not`)}</div>
    <div class="kpi kpi-secondary"><div class="num" title="${esc(fmtM(feesPaidYr))}">${fmtM(feesPaidYr)}</div><div class="lbl">Fees banked ${yr}</div>${basisLine(BASIS_CASH_YTD + (feesPaidYrFutureN ? ` — includes ${fmtM(feesPaidYrFuture)} dated after today (${feesPaidYrFutureN}); ${fmtM(feesPaidYr - feesPaidYrFuture)} actually received` : ""))}</div>
    <div class="kpi kpi-click ${feesOutstanding ? "warn" : ""}" onclick="kpiGoto('fees')" title="View the Protection &amp; Fees drawer — Fees due tab"><div class="num" title="${esc(fmtM(feesOutstanding))}">${fmtM(feesOutstanding)}</div><div class="lbl">Fees outstanding</div>${basisLine(`(broker only · not yet received · ${fmtM(feesInvoiced)} invoiced + ${fmtM(feesNotInvoiced)} not yet invoiced)`)}</div>` : ""}
    <div class="kpi"><div class="num">${rWon + rLost ? Math.round((rWon / (rWon + rLost)) * 100) + "%" : "—"}</div><div class="lbl">Retention conversion</div></div>
    <div class="kpi"><div class="num">${completedYr.length ? Math.round((protDone / completedYr.length) * 100) + "%" : "—"}</div><div class="lbl">Protection uptake ${yr}</div></div>
    <div class="kpi ${scored.length ? "kpi-click" : ""}" ${scored.length ? `id="report-nps-tile" onclick="toggleNpsList()" title="List every case that returned a review score"` : ""}><div class="num">${scored.length ? avgNps.toFixed(1) : "—"}</div><div class="lbl">Avg review score (${scored.length})${promoterPct != null ? ` · ${promoterPct}% promoters` : ""}${scored.length ? " ▾" : ""}</div></div>`;
  renderNpsList(scored);

  // S8 / R5-19 — the completions chart carries the previous calendar year as a second, muted bar
  // per month. The hard getFullYear() scoping is removed HERE ONLY (the chart's own data build);
  // `completedYr` above still drives the year-to-date KPI tiles and the protection-uptake rate.
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  // G1N-6 — localMonthStr (Europe/London), not the browser's own month: the card above and the bars
  // below must not disagree about which month a late-evening completion belongs to.
  const monthIdx = (d) => Number(localMonthStr(d).slice(5, 7)) - 1;
  const completedPrevYr = all.filter((c) => c.completed_at && yearOf(c.completed_at) === String(yr - 1));
  const byMonth = months.map((_, i) => completedYr.filter((c) => monthIdx(c.completed_at) === i).length);
  const byMonthPrev = months.map((_, i) => completedPrevYr.filter((c) => monthIdx(c.completed_at) === i).length);
  // ONE shared scale across both years — two series scaled independently would draw a worse year
  // as the taller bar.
  const maxM = Math.max(...byMonth, ...byMonthPrev, 1);
  const monthsTitle = $("#report-months-title");
  if (monthsTitle) monthsTitle.textContent = `Completions by month — ${yr} vs ${yr - 1}`;
  const monthsLegend = $("#report-months-legend");
  if (monthsLegend) {
    monthsLegend.innerHTML = completedPrevYr.length
      ? `<span class="mchart-key"><span class="mchart-swatch"></span> ${yr}</span> <span class="mchart-key"><span class="mchart-swatch prev"></span> ${yr - 1}</span> — both years share one scale.`
      : `No completions recorded in ${yr - 1}, so only ${yr} is drawn.`;
  }
  $("#report-months").innerHTML = months.map((m, i) => `
    <div class="mchart-row" title="${m}: ${byMonth[i]} in ${yr}, ${byMonthPrev[i]} in ${yr - 1}">
      <span class="mchart-lbl">${m}</span>
      <div class="mchart-bars">
        <div class="mchart-track"><div class="mchart-fill" style="width:${(byMonth[i] / maxM) * 100}%;"></div></div>
        <div class="mchart-track"><div class="mchart-fill prev" style="width:${(byMonthPrev[i] / maxM) * 100}%;"></div></div>
      </div>
      <span class="mchart-n">${byMonth[i] || ""}${byMonthPrev[i] ? ` <span class="prev-n">/ ${byMonthPrev[i]}</span>` : ""}</span>
    </div>`).join("");

  // BUILD 6a — Conversion % and Revenue added, computed the same way the Lead sources table above
  // computes them (renderThreadedPanels): revenue is proc+broker+sols fee on completed cases only,
  // conversion is completed / total cases. All-time (not scoped to the month picker), like the rest
  // of this panel already was.
  const introMap = Object.fromEntries((intros || []).map((i) => [i.id, i.name]));
  // T1-19 — so the pipeline search can match an introducer by name when this table links into it.
  introducerNames = introMap;
  const iMap = {};
  all.filter((c) => c.introducer_id).forEach((c) => {
    const k = introMap[c.introducer_id] || "Unknown";
    iMap[k] = iMap[k] || { total: 0, done: 0, lost: 0, live: 0, revenue: 0, last: null };
    const v = iMap[k];
    v.total++;
    if (c.created_at && (!v.last || c.created_at > v.last)) v.last = c.created_at;
    if (c.stage === "completed") { v.done++; v.revenue += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0); }
    else if (c.stage === "not_proceeding") v.lost++;
    else v.live++;
  });
  // Introducer referral VOLUMES stay for everyone; the Revenue column is Owner-only in the UI.
  $("#report-introducers").innerHTML = Object.keys(iMap).length
    ? `<table class="imp-table"><tr><th>Introducer</th><th>Cases</th><th title="Still in the live pipeline — neither won nor lost, and excluded from Conversion">Live</th><th>Completed</th><th title="${esc(CONV_TH_TITLE)}">Conversion</th><th>Last referral</th>${money ? `<th title="Fee value earned on this introducer's completed cases, all time. Not scoped to the month picker, and not cash — some of it may still be unpaid.">Revenue</th>` : ""}</tr>` +
      Object.entries(iMap).sort((a, b) => b[1].total - a[1].total)
        .map(([k, v]) => `<tr><td><button type="button" class="linkish" onclick="reportGotoSearch('${jsArg(k)}')" title="Open the pipeline filtered to ${esc(k)}">${esc(k)}</button></td><td>${v.total}</td><td>${v.live}</td><td>${v.done}</td><td>${convCell(v.done, v.lost)}</td><td>${fmtD(v.last)}</td>${money ? `<td>${fmtM(v.revenue)}</td>` : ""}</tr>`).join("") + `</table>`
      // R5-17 — the Revenue basis sits UNDER the table rather than in the column head: this panel
      // shares a two-column grid with the completions chart, and a long unwrapping heading sets
      // the table's min-content width, which squeezes the chart beside it to a sliver.
      + (money ? `<p class="panel-sub" style="margin:8px 0 0;">Revenue ${esc(BASIS_INTRO_REV)} — fee value on this introducer's completed cases, whether or not it has been paid.</p>` : "")
    : '<div class="empty">No cases assigned to introducers yet.</div>';

  const rep = repRes && !repRes.error ? repRes.data : null;
  renderThreadedPanels(all, mv, rep ? rep.advisers : null);
  renderForecastBuckets(all);
  // Client LTV is the one remaining RPC-only panel (needs client_id/name joins this page doesn't
  // otherwise fetch) — hide it gracefully if the RPC failed; everything else above still renders.
  renderReportExtras(rep);
}

/* ==========================================================================
   S7 (cheap slice) / R5-47 — REVIEW SCORE DRILL-DOWN
   The Avg review score tile answered "how are we doing" and nothing else: a 7.2 with no way to
   reach the people behind it. This lists every case that returned a score, worst first, so the
   detractors have names and one click reaches the case. Deliberately NO workflow — no auto-tasks,
   no per-adviser NPS league table; that needs designing against real volumes (plan § Deferred).
   ========================================================================== */
let npsListOpen = false;
function renderNpsList(scored) {
  const panel = $("#report-nps-panel");
  if (!panel) return;
  const rows = (scored || []).slice().sort((a, b) => Number(a.nps_score) - Number(b.nps_score));
  panel.classList.toggle("hidden", !npsListOpen || !rows.length);
  if (!rows.length) { $("#report-nps-list").innerHTML = ""; return; }
  const det = rows.filter((c) => Number(c.nps_score) <= 6).length;
  const scope = $("#report-nps-scope");
  if (scope) scope.textContent = `${rows.length} client${rows.length === 1 ? "" : "s"} have returned a score, worst first${det ? ` · ${det} detractor${det === 1 ? "" : "s"} (6 or below) tinted red` : ""}. All time, not scoped to the month picker.`;
  $("#report-nps-list").innerHTML = rows.map((c) => {
    const n = Number(c.nps_score);
    const cls = n <= 6 ? "detractor" : n >= 9 ? "promoter" : "";
    const name = [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "(no name)";
    const when = c.completed_at || c.updated_at || c.created_at;
    return `<div class="nps-row ${cls}">
      <span class="nps-score">${n}/10</span>
      <button type="button" class="linkish" onclick="openCase('${c.id}')" title="Open this case">${esc(name)}</button>
      <span class="nps-meta">${c.assigned_to ? esc(profileName(c.assigned_to) || staffName(c.assigned_to)) : "unassigned"}${when ? " · " + fmtD(when) : ""}</span>
    </div>`;
  }).join("");
}
window.toggleNpsList = function () {
  npsListOpen = !npsListOpen;
  const panel = $("#report-nps-panel");
  if (panel) panel.classList.toggle("hidden", !npsListOpen || !$("#report-nps-list").innerHTML);
  if (npsListOpen && panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
};

/* RPC-backed: client lifetime value (top 20). */
function renderReportExtras(rep) {
  const panel = $("#report-ltv-panel");
  // Lifetime VALUE is a money figure — Owner-only in the UI (presentation, not a control).
  if (!showMoney()) { if (panel) panel.classList.add("hidden"); $("#report-ltv").innerHTML = ""; return; }
  if (!rep) { if (panel) panel.classList.add("hidden"); return; }
  if (panel) panel.classList.remove("hidden");
  const ltv = Array.isArray(rep.client_ltv) ? rep.client_ltv : [];
  $("#report-ltv").innerHTML = ltv.length ? `<table class="imp-table">
    <tr><th>Name</th><th>Cases</th><th>LTV</th></tr>
    ${ltv.map((c) => `<tr>
      <td><button class="btn btn-sm" onclick="openClient('${c.client_id}')">${esc(c.name)}</button></td>
      <td>${c.cases ?? 0}</td>
      <td>${fmtM(c.ltv)}</td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No completed revenue yet.</div>';
}

/* ---------- Data health ---------- */
/* T1-26 — Data Health numbers whose rows live on the Emails page. Set the filter first, then nav:
   nav() calls loadEmails(), which reads the checkbox, so the list arrives already narrowed. */
function dhGotoEmails(failedOnly) {
  const cb = $("#email-failed-only");
  if (cb) cb.checked = !!failedOnly;
  nav("emails");
}
async function loadDataHealth() {
  const el = $("#data-content");
  el.innerHTML = '<div class="empty">Loading…</div>';
  const [dqRes, dupRes, caseRows, clientRows, dismissRes] = await Promise.all([
    db.rpc("get_data_quality"),
    db.rpc("find_duplicate_clients"),
    // Defect 13: the RPC only ever returns bare counts for these two tiles. Rather than change the
    // RPC (frontend-only, existing columns), pull the offending rows client-side from cases+clients
    // so the tiles can expand into the same list-panel pattern as the other Data Health items.
    db.from("cases").select("id,stage,rate_end_date,completed_at,client_id,clients(id,first_name,last_name,phone)"),
    // T1-9/T1-26: same trick for the client-shaped checks. The RPC returns counts for "missing
    // email & phone" and nothing at all for malformed values, so read the rows and judge them here.
    db.from("clients").select("id,first_name,last_name,email,phone"),
    // B6 / M4 — every dismissal is one select; find_duplicate_clients (the RPC) is never touched,
    // it just gets filtered client-side against this table (§Batch4 note: the RPC's own upsert
    // logic can't know about "not a duplicate" without a schema change it doesn't need).
    db.from("duplicate_dismissals").select("*"),
  ]);
  if (dqRes.error || dupRes.error) {
    renderLoadError("#data-content", dqRes.error || dupRes.error, loadDataHealth);
    return;
  }
  const dq = dqRes.data || {};
  // Feature-detect M4: an older database has no duplicate_dismissals table yet — the panel simply
  // shows every RPC-flagged pair (as before) and hides the "Not a duplicate" action.
  const dupTableMissing = !!(dismissRes.error && isMissingTableError(dismissRes.error));
  const dismissedRows = Array.isArray(dismissRes.data) ? dismissRes.data : [];
  const dupPairKey = (a, b) => [a, b].sort().join("|");
  const dismissedSet = new Set(dismissedRows.map((r) => dupPairKey(r.a_id, r.b_id)));
  const dups = (Array.isArray(dupRes.data) ? dupRes.data : []).filter((d) => !dismissedSet.has(dupPairKey(d.a_id, d.b_id)));
  const missingEmail = Array.isArray(dq.missing_email) ? dq.missing_email : [];
  const unassigned = Array.isArray(dq.live_unassigned) ? dq.live_unassigned : [];
  const noFee = Array.isArray(dq.completed_missing_fee) ? dq.completed_missing_fee : [];

  const allCases = Array.isArray(caseRows.data) ? caseRows.data : [];
  const isLiveStage = (s) => s !== "completed" && s !== "not_proceeding";
  const missingPhoneMap = new Map(); // dedupe by client — a client can have several live cases
  allCases.forEach((cs) => {
    const cl = cs.clients;
    if (cl && isLiveStage(cs.stage) && !cl.phone && !missingPhoneMap.has(cl.id)) {
      missingPhoneMap.set(cl.id, { id: cl.id, name: [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "(no name)" });
    }
  });
  const missingPhoneLive = [...missingPhoneMap.values()];
  const caseName = (cs) => (cs.clients ? [cs.clients.first_name, cs.clients.last_name].filter(Boolean).join(" ") || "(no name)" : "(no name)");
  const noRateEnd = allCases
    .filter((cs) => cs.stage === "completed" && !cs.rate_end_date)
    .map((cs) => ({ case_id: cs.id, name: caseName(cs) }));
  // T1-7 — completions stamped by nothing (every pre-fix UI completion, plus imports). They're
  // invisible to Reports, which counts by completed_at, so the pipeline and the report disagree
  // silently. Same tile+panel pattern as noRateEnd so they can be found and repaired by re-saving.
  const noCompletedAt = allCases
    .filter((cs) => cs.stage === "completed" && !cs.completed_at)
    .map((cs) => ({ case_id: cs.id, name: caseName(cs) }));

  // T1-9/T1-26 — client-shaped lists, all computed from the one clients read above.
  const allClients = Array.isArray(clientRows.data) ? clientRows.data : [];
  const clName = (cl) => [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "(no name)";
  const missingBoth = allClients.filter((cl) => !cl.email && !cl.phone).map((cl) => ({ id: cl.id, name: clName(cl) }));
  // Present-but-wrong. A presence check scores these as fixed, which is how a typo can *remove* an
  // alert while leaving the client just as unreachable as before.
  const invalidEmail = allClients.filter((cl) => cl.email && !isValidEmailLike(cl.email)).map((cl) => ({ id: cl.id, name: clName(cl), value: cl.email }));
  const invalidPhone = allClients.filter((cl) => cl.phone && !isValidPhoneLike(cl.phone)).map((cl) => ({ id: cl.id, name: clName(cl), value: cl.phone }));

  /* T1-26 — every number on this page is a door. `▾` = expands a list panel further down the page,
     `→` = leaves for the page that number lives on. Only "Clients total" (which isn't a fault
     count and has nothing to drill into) stays plain, so "clickable" reads consistently. */
  const kpis = `
    <div class="kpi"><div class="num">${dq.clients_total ?? 0}</div><div class="lbl">Clients total</div></div>
    <div class="kpi ${missingEmail.length ? "warn" : ""} dq-clickable" id="dh-tile-email" title="${missingEmail.length} of ${dq.missing_email_count ?? 0} clients missing an email have a live case — click to jump to the list"><div class="num">${missingEmail.length} of ${dq.missing_email_count ?? 0}</div><div class="lbl">Missing email — with a live case ▾</div></div>
    <div class="kpi ${dq.missing_phone_count ? "warn" : ""} dq-clickable" id="dh-tile-phone" title="${missingPhoneLive.length} of ${dq.missing_phone_count ?? 0} clients missing a phone have a live case — click to list them"><div class="num">${missingPhoneLive.length} of ${dq.missing_phone_count ?? 0}</div><div class="lbl">Missing phone — with a live case ▾</div></div>
    <div class="kpi ${missingBoth.length ? "warn" : ""} dq-clickable" id="dh-tile-both" title="Clients with neither an email nor a phone number — click to list them"><div class="num">${missingBoth.length}</div><div class="lbl">Missing email &amp; phone ▾</div></div>
    <div class="kpi ${invalidEmail.length ? "warn" : ""} dq-clickable" id="dh-tile-invalid-email" title="Clients whose email address can't be sent to — click to list them"><div class="num">${invalidEmail.length}</div><div class="lbl">Invalid email ▾</div></div>
    <div class="kpi ${invalidPhone.length ? "warn" : ""} dq-clickable" id="dh-tile-invalid-phone" title="Clients whose phone number can't be texted — click to list them"><div class="num">${invalidPhone.length}</div><div class="lbl">Invalid phone ▾</div></div>
    <div class="kpi ${unassigned.length ? "warn" : ""} dq-clickable" id="dh-tile-unassigned" title="Click to jump to the list"><div class="num">${unassigned.length}</div><div class="lbl">Live cases unassigned ▾</div></div>
    <div class="kpi dq-clickable" id="dh-tile-nofee" title="Click to jump to the list"><div class="num">${noFee.length}</div><div class="lbl">Completed, no fee ▾</div></div>
    <div class="kpi dq-clickable" id="dh-tile-rateend" title="Click to list these cases"><div class="num">${dq.completed_missing_rate_end ?? 0}</div><div class="lbl">Completed, no rate-end ▾</div></div>
    <div class="kpi ${noCompletedAt.length ? "warn" : ""} dq-clickable" id="dh-tile-nocompleted" title="Completed cases with no completion date — invisible to Reports until it's set. Click to list them"><div class="num">${noCompletedAt.length}</div><div class="lbl">Completed, no completion date ▾</div></div>
    <div class="kpi ${dq.emails_failed ? "warn" : ""} dq-clickable" id="dh-tile-failed" title="Click to open the Emails page filtered to failed sends"><div class="num">${dq.emails_failed ?? 0}</div><div class="lbl">Failed emails →</div></div>`;

  let stuckNotice = "";
  if (dq.emails_stuck > 0 && dq.emails_sending_live) {
    stuckNotice = `<div class="dq-notice bad dq-clickable" id="dh-stuck-notice" title="Click to open the Emails page">${dq.emails_stuck} email${dq.emails_stuck === 1 ? " is" : "s are"} stuck in the queue — the sender may be failing. →</div>`;
  } else if (dq.emails_stuck > 0 && !dq.emails_sending_live) {
    stuckNotice = `<div class="dq-notice dq-clickable" id="dh-stuck-notice" title="Click to open the Emails page">${dq.emails_stuck} email${dq.emails_stuck === 1 ? "" : "s"} queued and waiting — the Resend key isn't set yet, so nothing has sent. →</div>`;
  }

  const mutedSub = "color:var(--muted);font-size:12px;margin-top:2px;";
  // B6 / M4 — every staff member (not just Owner/Admin) can say "not a duplicate"; the destructive
  // Merge action stays gated above. Hidden outright when the table hasn't been migrated yet.
  const notDupBtn = (d) => dupTableMissing ? "" :
    `<button class="btn btn-sm" onclick="dismissDuplicate('${d.a_id}','${d.b_id}','${jsArg(d.a_name)}','${jsArg(d.b_name)}')">Not a duplicate</button>`;
  const clientNameById = new Map(allClients.map((cl) => [cl.id, clName(cl)]));
  const dismissedFooter = dismissedRows.length ? `
    <div class="panel-sub" style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
      <span>${dismissedRows.length} pair${dismissedRows.length === 1 ? "" : "s"} marked not-duplicates</span>
      <a href="javascript:void(0)" onclick="toggleDismissedDupsPanel()">show/hide</a>
    </div>
    <div id="dh-dismissed-list" class="hidden" style="margin-top:6px;">
      ${dismissedRows.map((r) => `
        <div class="row-item">
          <div class="row-main">
            <div class="t">${esc(clientNameById.get(r.a_id) || r.a_id)} / ${esc(clientNameById.get(r.b_id) || r.b_id)}</div>
            <div class="s">${r.reason ? esc(r.reason) + " · " : ""}by ${esc(staffName(r.dismissed_by))} · ${fmtD(r.created_at)}</div>
          </div>
          ${isAdminOrOwner() ? `<button class="btn btn-sm" onclick="undoDismissDuplicate('${r.id}')">Undo</button>` : '<span class="badge grey">undo: Owner / Admin</span>'}
        </div>`).join("")}
    </div>` : "";
  const dupPanel = `<div class="panel">
    <h3>Possible duplicate clients</h3>
    <p class="panel-sub">Flagged for human review — never merged automatically. Open each side to compare before merging by hand.</p>
    ${dups.length ? `<table class="imp-table">
      <tr><th>Client A</th><th>Client B</th><th>Reason</th><th>Score</th><th></th></tr>
      ${dups.map((d) => `<tr>
        <td>${esc(d.a_name)}<div style="${mutedSub}">${esc(d.a_email || "no email")}</div></td>
        <td>${esc(d.b_name)}<div style="${mutedSub}">${esc(d.b_email || "no email")}</div></td>
        <td>${esc(d.reason)}</td>
        <td>${Math.round((Number(d.score) || 0) * 100)}%</td>
        <td style="white-space:nowrap;"><button class="btn btn-sm" onclick="openClient('${d.a_id}')">Open A</button> <button class="btn btn-sm" onclick="openClient('${d.b_id}')">Open B</button> ${isAdminOrOwner() ? `<button class="btn btn-sm ${(Number(d.score) || 0) < 0.9 ? "" : "btn-primary"}" onclick="openMergeClients('${d.a_id}','${d.b_id}','${jsArg(d.reason)}',${Number(d.score) || 0})">Merge…</button>` : '<span class="badge grey">merge: Owner / Admin</span>'} ${notDupBtn(d)}</td>
      </tr>`).join("")}
    </table>` : '<div class="empty">No likely duplicates found. 👍</div>'}
    ${dismissedFooter}
  </div>`;

  const missingPanel = `<div class="panel" id="dh-missing-panel">
    <h3>Clients missing email (with a live case)</h3>
    ${missingEmail.length === 300 ? '<p class="panel-sub">Showing the first 300 — there may be more.</p>' : ""}
    ${missingEmail.length ? `<table class="imp-table">
      ${missingEmail.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td style="text-align:right;white-space:nowrap;"><button class="btn btn-sm" onclick="openClient('${c.id}')">Open</button></td>
      </tr>`).join("")}
    </table>` : '<div class="empty">Every client with a live case has an email. 👍</div>'}
  </div>`;

  // BUILD 7c — bulk-select on the unassigned-cases panel. Prune the selection to the cases still
  // listed, then add row checkboxes and a slim "Assign selected to…" action bar.
  const unassignedIds = new Set(unassigned.map((c) => c.case_id));
  [...dhSel].forEach((id) => { if (!unassignedIds.has(id)) dhSel.delete(id); });
  const dhBulkBar = `<div class="bulk-bar" id="dh-bulk-bar"${dhSel.size ? "" : " hidden"}>
      <span class="bulk-bar-count"><strong id="dh-bulk-n">${dhSel.size}</strong> selected</span>
      <select id="dh-bulk-adviser" class="bulk-bar-select" aria-label="Assign selected cases to adviser">${adviserOptionsHtml("Assign selected to…")}</select>
      <button type="button" class="btn btn-sm" id="dh-bulk-clear">Clear</button>
    </div>`;
  const unassignedPanel = `<div class="panel" id="dh-unassigned-panel">
    <h3>Live cases with no adviser</h3>
    ${unassigned.length ? dhBulkBar : ""}
    ${unassigned.length ? unassigned.map((c) => `
      <div class="row-item">
        <input type="checkbox" class="dh-cb" data-id="${c.case_id}" aria-label="Select this case"${dhSel.has(c.case_id) ? " checked" : ""} onclick="event.stopPropagation()">
        <div class="row-main">
          <div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div>
          <div class="s">${esc(STAGE_LABEL[c.stage] || c.stage)}</div>
        </div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every live case has an adviser. 👍</div>'}
  </div>`;

  const noFeePanel = `<div class="panel" id="dh-nofee-panel">
    <h3>Completed cases with no fee recorded</h3>
    ${noFee.length ? noFee.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">All completed cases have a fee recorded. 👍</div>'}
  </div>`;

  // Defect 13: the two previously dead-end tiles, now expandable list panels — same row-item
  // pattern as missingPanel/unassignedPanel/noFeePanel above. Hidden until the tile is clicked.
  const phonePanel = `<div class="panel hidden" id="dh-phone-panel">
    <h3>Clients missing phone (with a live case)</h3>
    ${missingPhoneLive.length ? missingPhoneLive.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openClient('${c.id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openClient('${c.id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every client with a live case has a phone number. 👍</div>'}
  </div>`;

  const rateEndPanel = `<div class="panel hidden" id="dh-rateend-panel">
    <h3>Completed cases with no rate-end date</h3>
    ${noRateEnd.length ? noRateEnd.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every completed case has a rate-end date. 👍</div>'}
  </div>`;

  // T1-7 — same shape as rateEndPanel. Opening the case and saving it re-stamps completed_at.
  const noCompletedPanel = `<div class="panel hidden" id="dh-nocompleted-panel">
    <h3>Completed cases with no completion date</h3>
    <p class="panel-sub">Reports count completions by date — these are complete in the pipeline but missing from every month's figures. Open each one and save it to stamp the date.</p>
    ${noCompletedAt.length ? noCompletedAt.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every completed case has a completion date. 👍</div>'}
  </div>`;

  // T1-26 — the least-reachable records in the database, which previously had no list anywhere.
  const bothPanel = `<div class="panel hidden" id="dh-both-panel">
    <h3>Clients with no email and no phone</h3>
    ${missingBoth.length ? missingBoth.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openClient('${c.id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openClient('${c.id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every client has at least one way to reach them. 👍</div>'}
  </div>`;

  // T1-9 — present but unusable. The value is shown so the typo is visible without opening anything.
  const invalidEmailPanel = `<div class="panel hidden" id="dh-invalid-email-panel">
    <h3>Clients with an invalid email address</h3>
    ${invalidEmail.length ? invalidEmail.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openClient('${c.id}','email')">${esc(c.name)}</div><div class="s">${esc(c.value)}</div></div>
        <button class="btn btn-sm" onclick="openClient('${c.id}','email')">Fix</button>
      </div>`).join("") : '<div class="empty">Every email address on file looks sendable. 👍</div>'}
  </div>`;

  const invalidPhonePanel = `<div class="panel hidden" id="dh-invalid-phone-panel">
    <h3>Clients with an invalid phone number</h3>
    ${invalidPhone.length ? invalidPhone.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openClient('${c.id}','phone')">${esc(c.name)}</div><div class="s">${esc(c.value)}</div></div>
        <button class="btn btn-sm" onclick="openClient('${c.id}','phone')">Fix</button>
      </div>`).join("") : '<div class="empty">Every phone number on file looks textable. 👍</div>'}
  </div>`;

  el.innerHTML = `
    <div class="kpi-row">${kpis}</div>
    ${stuckNotice}
    ${dupPanel}
    <div class="grid-2">${missingPanel}${unassignedPanel}</div>
    ${noFeePanel}
    <div class="grid-2">${phonePanel}${rateEndPanel}</div>
    <div class="grid-2">${bothPanel}${noCompletedPanel}</div>
    <div class="grid-2">${invalidEmailPanel}${invalidPhonePanel}</div>`;

  // Tiles whose panel is hidden until asked for: toggle, and scroll to it when revealing so the
  // list isn't opened off-screen below the fold.
  const wireTile = (tileId, panelId) => {
    const tile = $(tileId), panel = $(panelId);
    if (!tile || !panel) return;
    tile.style.cursor = "pointer";
    tile.onclick = () => {
      panel.classList.toggle("hidden");
      if (!panel.classList.contains("hidden")) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  };
  // T1-26 — tiles whose panel is always rendered: just take me to it.
  const wireTileScroll = (tileId, panelId) => {
    const tile = $(tileId), panel = $(panelId);
    if (!tile || !panel) return;
    tile.style.cursor = "pointer";
    tile.onclick = () => panel.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  wireTile("#dh-tile-phone", "#dh-phone-panel");
  wireTile("#dh-tile-rateend", "#dh-rateend-panel");
  wireTile("#dh-tile-nocompleted", "#dh-nocompleted-panel");
  wireTile("#dh-tile-both", "#dh-both-panel");
  wireTile("#dh-tile-invalid-email", "#dh-invalid-email-panel");
  wireTile("#dh-tile-invalid-phone", "#dh-invalid-phone-panel");
  wireTileScroll("#dh-tile-email", "#dh-missing-panel");
  wireTileScroll("#dh-tile-unassigned", "#dh-unassigned-panel");
  wireTileScroll("#dh-tile-nofee", "#dh-nofee-panel");
  /* T1-26 — the two numbers whose rows live on another page. The failed tile pre-ticks the
     failed-only filter so the list on arrival is exactly the number that was clicked; the stuck
     notice deliberately does NOT, because stuck emails are queued, not failed — ticking it there
     would land on an empty list. */
  const failedTile = $("#dh-tile-failed");
  if (failedTile) { failedTile.style.cursor = "pointer"; failedTile.onclick = () => dhGotoEmails(true); }
  const stuckEl = $("#dh-stuck-notice");
  if (stuckEl) { stuckEl.style.cursor = "pointer"; stuckEl.onclick = () => dhGotoEmails(false); }

  // BUILD 7c — unassigned-cases bulk-assign wiring. Selection toggles update the action bar
  // imperatively; picking an adviser assigns the batch then refreshes Data Health.
  const updateDhBulkBar = () => {
    const bar = $("#dh-bulk-bar");
    if (!bar) return;
    bar.hidden = dhSel.size === 0;
    const nEl = $("#dh-bulk-n"); if (nEl) nEl.textContent = dhSel.size;
  };
  document.querySelectorAll("#data-content .dh-cb").forEach((cb) => (cb.onchange = () => {
    if (cb.checked) dhSel.add(cb.dataset.id); else dhSel.delete(cb.dataset.id);
    updateDhBulkBar();
  }));
  const dhClear = $("#dh-bulk-clear");
  if (dhClear) dhClear.onclick = () => {
    dhSel.clear();
    document.querySelectorAll("#data-content .dh-cb").forEach((cb) => (cb.checked = false));
    updateDhBulkBar();
  };
  const dhAdv = $("#dh-bulk-adviser");
  if (dhAdv) dhAdv.onchange = () => { const v = dhAdv.value; dhAdv.value = ""; if (v) bulkAssignDataHealth(v); };
}
// BUILD 7c — bulk assign the selected unassigned cases to an adviser, then refresh Data Health.
async function bulkAssignDataHealth(adviserId) {
  const ids = [...dhSel];
  if (!ids.length || !adviserId) return;
  const mine = adviserId === authUid;
  const name = mine ? "you" : staffName(adviserId);
  if (!confirm(`Assign ${ids.length} case${ids.length === 1 ? "" : "s"} to ${mine ? "yourself" : name}?`)) return;
  let ok = 0, err = 0;
  for (const id of ids) {
    const { error } = await db.from("cases").update({ assigned_to: adviserId }).eq("id", id);
    if (error) err++; else ok++;
  }
  let msg = `${ok} case${ok === 1 ? "" : "s"} assigned to ${name}`;
  if (err) msg += `, ${err} error${err === 1 ? "" : "s"}`;
  toast(msg);
  dhSel.clear();
  loadDataHealth();
}
$("#data-refresh").addEventListener("click", () => loadDataHealth());

/* B6 / R5-39 / M4 — "Not a duplicate" that sticks: any staff member can say two flagged clients
   are genuinely different people, and it stays said (across reloads, across users) until an
   Owner/Admin undoes it. Stored sorted (a_id < b_id) to match the M4 unique-pair constraint. */
window.toggleDismissedDupsPanel = function () {
  const el = $("#dh-dismissed-list");
  if (el) el.classList.toggle("hidden");
};
window.dismissDuplicate = async function (aId, bId, aName, bName) {
  const reason = prompt(`Mark "${aName}" and "${bName}" as NOT duplicates?\n\nThey will no longer show up as a possible match. Optional reason (kept in the audit log):`);
  if (reason == null) return; // cancelled
  const [a, b] = [aId, bId].sort();
  const { error } = await db.from("duplicate_dismissals").insert({ a_id: a, b_id: b, reason: reason.trim() || null });
  if (error) {
    if (isMissingTableError(error)) return toast("Not-a-duplicate needs migration M4");
    return toast("Error: " + error.message);
  }
  toast("Marked as not a duplicate");
  loadDataHealth();
};
window.undoDismissDuplicate = async function (id) {
  if (!isAdminOrOwner()) return toast("Undo is Owner / Administrator only.");
  const { error } = await db.from("duplicate_dismissals").delete().eq("id", id);
  if (error) return toast("Error: " + error.message);
  toast("Restored — this pair will show as a possible duplicate again");
  loadDataHealth();
};

/* ---------- Duplicate-client merge (BUILD 5b) ---------- */
const MERGE_FIELDS = [
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["date_of_birth", "Date of birth"],
  ["address", "Address"],
  ["sms_opt_out", "SMS opt-out"],
  ["marketing_opt_out", "Marketing opt-out"],
];
/* The tables whose rows re-point from the loser onto the survivor, in the order they move.
   ONE list drives the moves, the rollback, every failure message and the audit note — so the
   "name exactly what already moved" discipline cannot drift table-by-table again. */
const MERGE_MOVE_TABLES = [
  ["cases", "case", "cases"],
  ["appointments", "appointment", "appointments"],
  ["fact_finds", "fact-find", "fact-finds"],
  ["email_queue", "email", "emails"],
  ["sms_queue", "SMS message", "SMS messages"],
  ["case_emails", "inbound message", "inbound messages"],
  ["watch_alerts", "alert", "alerts"],
];
function mergeFieldEmpty(f, v) {
  if (f === "sms_opt_out" || f === "marketing_opt_out") return false; // booleans are never "empty"
  return v == null || v === "";
}
function mergeFieldDisplay(f, v) {
  if (f === "sms_opt_out" || f === "marketing_opt_out") return v ? "Yes" : "No";
  return mergeFieldEmpty(f, v) ? '<em style="color:var(--muted);">empty</em>' : esc(String(v));
}
function fullClientName(c) {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)";
}
/* Reworded confirmHardDelete pattern (typed keyword gate) — MERGE instead of DELETE, since the
   irreversible part here is the loser record's permanent deletion after its records are moved.
   T1-27: for a weak match the keyword is the SURVIVOR'S SURNAME, not the generic word — typing
   MERGE on autopilot can't push two different people together. */
function confirmMerge(what, extra, keyword) {
  const word = (keyword || "MERGE").trim().toUpperCase();
  const typed = prompt(
    `${what}\n\n` +
    "This moves the losing record's cases, appointments, fact-finds and correspondence (emails, SMS and inbound messages) onto the surviving record, " +
    "then PERMANENTLY DELETES the losing record. This cannot be undone." +
    (extra ? `\n\n${extra}` : "") +
    `\n\nType ${word} to confirm:`
  );
  return typed != null && typed.trim().toUpperCase() === word;
}

/* T1-27 — `reason` and `score` come from find_duplicate_clients (the Data Health table already
   renders them, then used to drop them on the way in here). A 72% "same phone number" pair and a
   95% "same email" pair must not open the same neutral modal with the same primary button. */
window.openMergeClients = async function (aId, bId, reason, score) {
  // Presentation guard only — the affordances above are already hidden for an adviser, and the
  // clients DELETE at the end of the merge is refused by RLS regardless of what the UI does.
  if (!isAdminOrOwner()) return toast("Merging clients is Owner / Administrator only.");
  const [{ data: aC, error: aErr }, { data: bC, error: bErr }, dupTableProbe] = await Promise.all([
    db.from("clients").select("*").eq("id", aId).single(),
    db.from("clients").select("*").eq("id", bId).single(),
    // B6 / M4 — cheap presence check so "Not a duplicate" can hide itself on an un-migrated database
    // instead of offering an action that will fail on click.
    db.from("duplicate_dismissals").select("id").limit(1),
  ]);
  if (aErr || bErr || !aC || !bC) return toast("Couldn't load one of these clients — it may have been deleted already.");
  const dupTableMissing = !!(dupTableProbe && dupTableProbe.error && isMissingTableError(dupTableProbe.error));
  const countFor = async (table, id) => {
    const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("client_id", id);
    return error ? 0 : (count || 0);
  };
  // T1-4 — the correspondence tables are counted here too, because they now MOVE with the merge
  // (they used to be silently cascade-deleted with the loser).
  const [aCases, bCases, aAppts, bAppts, aFF, bFF, aEm, bEm, aSms, bSms, aCe, bCe, aWa, bWa] = await Promise.all([
    countFor("cases", aId), countFor("cases", bId),
    countFor("appointments", aId), countFor("appointments", bId),
    countFor("fact_finds", aId), countFor("fact_finds", bId),
    countFor("email_queue", aId), countFor("email_queue", bId),
    countFor("sms_queue", aId), countFor("sms_queue", bId),
    countFor("case_emails", aId), countFor("case_emails", bId),
    countFor("watch_alerts", aId), countFor("watch_alerts", bId),
  ]);
  const counts = {
    [aId]: { cases: aCases, appointments: aAppts, fact_finds: aFF, email_queue: aEm, sms_queue: aSms, case_emails: aCe, watch_alerts: aWa },
    [bId]: { cases: bCases, appointments: bAppts, fact_finds: bFF, email_queue: bEm, sms_queue: bSms, case_emails: bCe, watch_alerts: bWa },
  };
  /* T1-27 — how confident is this pair, really? Count the fields that actually differ (the same
     comparison the field table uses), and treat a differing surname or date of birth as
     disqualifying however high the score is: two people sharing a landline is the commonest false
     positive in this list, and the merge is unrecoverable. */
  const sameVal = (f) => (f === "sms_opt_out" || f === "marketing_opt_out")
    ? (!!aC[f] === !!bC[f]) : ((aC[f] ?? "") === (bC[f] ?? ""));
  const diffFields = MERGE_FIELDS.filter(([f]) => !sameVal(f)).map(([, label]) => label);
  const pct = Math.round((Number(score) || 0) * 100);
  const surnameDiffers = !sameVal("last_name");
  const dobDiffers = !sameVal("date_of_birth") && !!(aC.date_of_birth || bC.date_of_birth);
  const weak = (score != null && Number(score) < 0.9) || surnameDiffers || dobDiffers;
  // Default survivor: more cases wins; tie-break to the older (earlier created_at) record.
  const defaultKeep = (counts[aId].cases !== counts[bId].cases)
    ? (counts[aId].cases > counts[bId].cases ? aId : bId)
    : (String(aC.created_at || "") <= String(bC.created_at || "") ? aId : bId);

  const render = (keepId) => {
    const keepSideA = keepId === aId;
    const fieldRows = MERGE_FIELDS.map(([f, label]) => {
      const av = aC[f], bv = bC[f];
      const boolField = f === "sms_opt_out" || f === "marketing_opt_out";
      const same = boolField ? (!!av === !!bv) : ((av ?? "") === (bv ?? ""));
      const survVal = keepSideA ? av : bv;
      const survEmpty = mergeFieldEmpty(f, survVal);
      const otherEmpty = mergeFieldEmpty(f, keepSideA ? bv : av);
      // Opt-out booleans (defect 9): never default to "quietly re-consent" a client. If either side
      // has opted out, default the merged value to opted-out (true) regardless of which record
      // survives — the operator can still override, but the safe choice is pre-selected.
      const optOutForced = boolField && (!!av !== !!bv);
      const defaultA = optOutForced ? !!av
        : (same ? true : (survEmpty && !otherEmpty ? !keepSideA : keepSideA));
      return `<tr${optOutForced ? ' style="background:#fdecea;"' : (same ? "" : ' style="background:#fff8ee;"')}>
        <td>${esc(label)}${optOutForced ? ' <span style="color:var(--red);font-weight:600;" title="One record has opted out — the opt-out is kept by default so it is never silently discarded.">⚠ opt-out kept</span>' : ""}</td>
        <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" name="merge-field-${f}" value="a" ${defaultA ? "checked" : ""} style="width:auto;margin-top:3px;"> ${mergeFieldDisplay(f, av)}</label></td>
        <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" name="merge-field-${f}" value="b" ${defaultA ? "" : "checked"} style="width:auto;margin-top:3px;"> ${mergeFieldDisplay(f, bv)}</label></td>
      </tr>`;
    }).join("");

    const loserId = keepId === aId ? bId : aId;
    const lc = counts[loserId];
    const plural = (n, s) => `${n} ${s}${n === 1 ? "" : "s"}`;

    const survName = keepId === aId ? fullClientName(aC) : fullClientName(bC);
    const survSurname = ((keepId === aId ? aC.last_name : bC.last_name) || "").trim();
    const keyword = weak && survSurname ? survSurname.toUpperCase() : "MERGE";
    // T1-27 — what matched, how strongly, and what disagrees. Weak pairs get a red banner instead
    // of the neutral sub-heading, and the confirm button loses its primary styling.
    const matchHtml = reason || score != null || weak
      ? (weak
        ? `<div class="dq-notice bad merge-match weak" id="merge-match">⚠ Weak match — ${esc(reason || "flagged as a possible duplicate")}${score != null ? ` (${pct}% confidence)` : ""} · ${diffFields.length} of ${MERGE_FIELDS.length} fields differ${diffFields.length ? ` (${esc(diffFields.join(", "))})` : ""}.
             Two records can share a phone number without being the same person — check before merging. You'll be asked to type <strong>${esc(keyword)}</strong> to confirm.</div>`
        : `<div class="dq-notice merge-match" id="merge-match">Matched on: <strong>${esc(reason || "possible duplicate")}</strong>${score != null ? ` · ${pct}% confidence` : ""} · ${diffFields.length} of ${MERGE_FIELDS.length} fields differ${diffFields.length ? ` (${esc(diffFields.join(", "))})` : ""}.</div>`)
      : "";
    $("#modal").innerHTML = `
      <h3>Merge duplicate clients</h3>
      <p class="panel-sub">Pick which record survives, then choose which value wins for each field. Everything belonging to the other record moves across, then it's deleted.</p>
      ${matchHtml}
      <div class="merge-keep">
        <label><input type="radio" name="merge-keep" value="${aId}" ${keepId === aId ? "checked" : ""}> Keep <strong>${esc(fullClientName(aC))}</strong> as the survivor <span class="merge-keep-meta">(${plural(counts[aId].cases, "case")}, created ${fmtD(aC.created_at)})</span></label>
        <label><input type="radio" name="merge-keep" value="${bId}" ${keepId === bId ? "checked" : ""}> Keep <strong>${esc(fullClientName(bC))}</strong> as the survivor <span class="merge-keep-meta">(${plural(counts[bId].cases, "case")}, created ${fmtD(bC.created_at)})</span></label>
      </div>
      <table class="imp-table merge-table">
        <tr><th>Field</th><th>Client A — ${esc(fullClientName(aC))}</th><th>Client B — ${esc(fullClientName(bC))}</th></tr>
        ${fieldRows}
      </table>
      <p class="panel-sub" style="margin-top:12px;">${plural(lc.cases, "case")}, ${plural(lc.appointments, "appointment")}, ${plural(lc.fact_finds, "fact-find")}, ${plural(lc.email_queue, "email")}, ${lc.sms_queue} SMS, ${plural(lc.case_emails, "inbound message")} and ${plural(lc.watch_alerts, "alert")} will move onto the surviving record.</p>
      <div class="modal-actions">
        <div>${dupTableMissing ? "" : '<button type="button" class="btn btn-sm" id="merge-not-dup">Not a duplicate</button>'}</div>
        <div class="right">
          <button class="btn" id="modal-cancel">Cancel</button>
          <button class="btn ${weak ? "" : "btn-primary"}" id="merge-confirm">Merge…</button>
        </div>
      </div>`;
    openModal();
    $("#modal-cancel").onclick = closeModalGuarded; // defect 2 — Cancel is a "leave" path: it must warn about unsaved edits too
    $("#modal").querySelectorAll('input[name="merge-keep"]').forEach((r) => {
      r.onchange = () => render(r.value);
    });
    // B6 / R5-39 — the same "Not a duplicate" action Data Health offers, reachable from inside the
    // merge modal itself so a false-positive match spotted here doesn't need a detour back there.
    const notDupBtn = $("#modal").querySelector("#merge-not-dup");
    if (notDupBtn) notDupBtn.onclick = async () => {
      const reasonText = prompt(`Mark "${fullClientName(aC)}" and "${fullClientName(bC)}" as NOT duplicates?\n\nThey will no longer show up as a possible match. Optional reason (kept in the audit log):`);
      if (reasonText == null) return; // cancelled
      const [ka, kb] = [aId, bId].sort();
      const { error: ddErr } = await db.from("duplicate_dismissals").insert({ a_id: ka, b_id: kb, reason: reasonText.trim() || null });
      if (ddErr) return toast(isMissingTableError(ddErr) ? "Not-a-duplicate needs migration M4" : "Error: " + ddErr.message);
      closeModal();
      toast("Marked as not a duplicate");
      loadDataHealth();
    };
    $("#merge-confirm").onclick = async () => {
      const btn = $("#merge-confirm");
      if (btn) { if (btn.disabled) return; btn.disabled = true; }
      try {
        const survivorId = keepId;
        const loserId = keepId === aId ? bId : aId;
        const survivorName = keepId === aId ? fullClientName(aC) : fullClientName(bC);
        const loserName = keepId === aId ? fullClientName(bC) : fullClientName(aC);
        const fieldUpd = {};
        MERGE_FIELDS.forEach(([f]) => {
          const sel = $("#modal").querySelector(`input[name="merge-field-${f}"]:checked`);
          const side = sel ? sel.value : "a";
          fieldUpd[f] = side === "a" ? aC[f] : bC[f];
        });
        // T1-4 — the correspondence counts belong in the confirm too: they're what actually got
        // destroyed before, and they're FCA file-review evidence.
        const extra = `Surviving record: ${survivorName}. Being merged away: ${loserName} (${plural(lc.cases, "case")}, ${plural(lc.appointments, "appointment")}, ${plural(lc.fact_finds, "fact-find")}, ${plural(lc.email_queue, "email")}, ${lc.sms_queue} SMS, ${plural(lc.case_emails, "inbound message")}, ${plural(lc.watch_alerts, "alert")}).`
          + (weak ? `\n\nWEAK MATCH: ${reason || "flagged as a possible duplicate"}${score != null ? ` (${pct}%)` : ""} — ${diffFields.length} of ${MERGE_FIELDS.length} fields differ.` : "");
        if (!confirmMerge("Merge these two client records?", extra, keyword)) return;

        /* Sequential, awaited and checked at every step. Two ordering rules make a partial failure
           survivable: the loser is never deleted unless every step succeeded, and the SURVIVOR'S
           OWN FIELDS are written LAST — a failed merge must never leave the survivor silently
           renamed. Anything that did move is moved back by id (not by client_id, which would drag
           the survivor's own rows across too), and the message is generated from the tracked list
           so it always names the complete set of what moved and what did not. */
        const moved = [];  // [{ table, one, many, ids }] — every table attempted, in move order
        const nCount = (m) => `${m.ids.length} ${m.ids.length === 1 ? m.one : m.many}`;
        const movedReal = () => moved.filter((m) => m.ids.length);
        /* T1-finalfix (finding 3) — "attempted and there was nothing there" and "never attempted"
           are different end positions and must not read the same. `moved` holds every table that
           was successfully processed, INCLUDING the ones that turned out to have no rows; a table
           only stays out of it if the failure stopped us before reaching it. Deriving the
           not-moved list from movedReal() (which drops the zero-row entries) put tables the loser
           never had any rows in into "Not moved:", sending someone hunting for records that never
           existed. Split them. */
        const emptyNames = () => moved.filter((m) => !m.ids.length).map((m) => m.many);
        const notMovedNames = () => {
          const attempted = new Set(moved.map((m) => m.table));
          return MERGE_MOVE_TABLES.filter(([t]) => !attempted.has(t)).map(([, , many]) => many);
        };
        // Compensating re-point of everything already moved, most recent first. Reports honestly.
        const rollBack = async () => {
          const stuck = [];
          for (let i = moved.length - 1; i >= 0; i--) {
            const m = moved[i];
            if (!m.ids.length) continue;
            const { error } = await db.from(m.table).update({ client_id: loserId }).in("id", m.ids);
            if (error) stuck.unshift(m);
          }
          return stuck;
        };
        const abortMerge = async (what, message) => {
          const stuck = await rollBack();
          const did = movedReal(), notDid = notMovedNames(), none = emptyNames();
          let msg = `Merge stopped before deleting anything — ${what}: ${message}. `;
          msg += did.length ? `Already moved: ${did.map(nCount).join(", ")}. ` : "Nothing had moved yet. ";
          if (none.length) msg += `Nothing to move: ${none.join(", ")} (the duplicate had none). `;
          msg += notDid.length ? `Not moved: ${notDid.join(", ")}. ` : "Nothing else was left to move. ";
          msg += stuck.length
            ? `⚠ COULD NOT put back: ${stuck.map(nCount).join(", ")} — ${stuck.length === 1 ? "it is" : "they are"} now on ${survivorName} and must be repaired by hand. Both client records still exist.`
            : (did.length ? "All of it was put back — both records are exactly as they were." : "Both records are exactly as they were.");
          toast(msg);
        };

        // T1-4: email_queue, sms_queue, case_emails and watch_alerts move too. They used to be
        // cascade-deleted with the loser, behind a sentence promising the opposite — including
        // reminders attached to a case that SURVIVED the merge.
        for (const [table, one, many] of MERGE_MOVE_TABLES) {
          const { data: rows, error: readErr } = await db.from(table).select("id").eq("client_id", loserId);
          if (readErr) return await abortMerge(`couldn't read the ${many} to move`, readErr.message);
          const ids = (rows || []).map((r) => r.id);
          if (ids.length) {
            const { error } = await db.from(table).update({ client_id: survivorId }).eq("client_id", loserId);
            if (error) return await abortMerge(`couldn't move ${many}`, error.message);
          }
          moved.push({ table, one, many, ids });
        }

        // Survivor's chosen field values go on LAST, once nothing else can fail on the way here.
        const { error: updErr } = await db.from("clients").update(fieldUpd).eq("id", survivorId);
        if (updErr) return await abortMerge("couldn't update the surviving record's details", updErr.message);

        const { error: delErr } = await db.from("clients").delete().eq("id", loserId);
        if (delErr) return toast("Records were moved, but the duplicate couldn't be deleted: " + delErr.message + " — please delete it manually.");

        closeModal();
        // Defect 12 (lite): merge moves the loser's cases onto the survivor but doesn't check whether
        // that now leaves two live cases of the same kind sitting side by side — a likely duplicate
        // that still needs a human to review/merge. No auto-merge of cases; just flag it.
        const { data: survCases } = await db.from("cases").select("id,case_kind,stage").eq("client_id", survivorId);
        /* A merge is the one destructive action that used to leave no trace at all — the absorbed
           person simply stopped existing. Same mechanism the critical-alert dismissal already uses:
           one case_note, on every case the survivor now owns, naming who, when, the absorbed
           record's identifying details and exactly what moved. (The database-trigger half of the
           audit trail needs a migration and is out of scope here.) */
        const loserRec = keepId === aId ? bC : aC;
        const who = (ME && (ME.full_name || ME.email)) || "staff";
        const idBits = [loserRec.email, loserRec.phone, loserRec.date_of_birth ? "DOB " + fmtD(loserRec.date_of_birth) : null].filter(Boolean).join(" · ");
        const noteBody = `🔗 Duplicate client record merged by ${who} on ${new Date().toLocaleString("en-GB")}: "${loserName}"${idBits ? ` (${idBits})` : ""} was absorbed into "${survivorName}" and permanently deleted. Moved across: ${movedReal().length ? movedReal().map(nCount).join(", ") : "no linked records"}.`;
        for (const sc of (survCases || [])) {
          try { await db.from("case_notes").insert({ case_id: sc.id, body: noteBody }); } catch (e) { /* the merge itself is done — never fail it on the note */ }
        }
        const openByKind = {};
        (survCases || []).forEach((x) => {
          if (x.stage === "completed" || x.stage === "not_proceeding") return;
          openByKind[x.case_kind] = (openByKind[x.case_kind] || 0) + 1;
        });
        const dupeKind = Object.entries(openByKind).find(([, n]) => n >= 2);
        if (dupeKind) {
          const label = KINDS.find((k) => k[0] === dupeKind[0])?.[1] || dupeKind[0];
          toast(`⚠ Survivor has ${dupeKind[1]} similar open cases (${label}) — review for duplicates`);
        } else {
          toast("Clients merged ✓");
        }
        loadDataHealth();
      } finally {
        if (btn) btn.disabled = false;
      }
    };
  };
  render(defaultKeep);
};

/* ---------- Introducers & team (Settings) ---------- */
// Introducers currently on file, so the Team logins role picker can attach an introducer login to
// one without a second fetch. Populated by loadIntroducers (Settings is the only page that shows it).
let INTRODUCERS = [];
async function loadIntroducers() {
  const { data: intros } = await db.from("introducers").select("*").order("name");
  const { data: logins } = await db.from("profiles").select("introducer_id,email").eq("role", "introducer");
  const hasLogin = new Set((logins || []).map((l) => l.introducer_id));
  INTRODUCERS = (intros || []).map((i) => ({ id: i.id, name: i.name, email: i.email, hasLogin: hasLogin.has(i.id) }));
  // invite-user is Owner-only (BACKEND-R4 §4) — a non-Owner is never offered the button, because
  // the edge function would answer 403. The introducer list itself stays visible and editable.
  const canInvite = isOwner();
  $("#intro-list").innerHTML = (intros || []).length ? intros.map((i) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(i.name)}</div>
        <div class="s">${esc(i.email || "no email")}</div>
      </div>
      ${hasLogin.has(i.id) ? '<span class="badge green">portal login active</span>'
        : !canInvite ? '<span class="badge grey">no portal login — Owner only</span>'
        : (i.email ? `<button class="btn btn-sm" onclick="inviteIntroducer('${i.id}')">Create portal login</button>` : '<span class="badge grey">add email to invite</span>')}
    </div>`).join("") : '<div class="empty">No introducers yet.</div>';
  renderInviteRoleHint();
}
$("#add-intro-btn").addEventListener("click", async () => {
  const name = $("#intro-name").value.trim();
  if (!name) return toast("Name required");
  const btn = $("#add-intro-btn"); // T1-15 — in-flight guard
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const { error } = await db.from("introducers").insert({ name, email: $("#intro-email").value.trim() || null });
    if (error) return toast("Error: " + error.message);
    $("#intro-name").value = ""; $("#intro-email").value = "";
    toast("Introducer added");
    loadIntroducers();
    refreshChangeHistory(); // introducers are audited — show the row this just wrote
  } finally { btn.disabled = false; }
});
window.inviteIntroducer = async function (introducerId) {
  const { data: i } = await db.from("introducers").select("*").eq("id", introducerId).single();
  if (!i?.email) return toast("Add an email address first");
  if (!confirm(`Create a portal login for ${i.name} (${i.email})? They will only see their own referrals.`)) return;
  const res = await inviteUser({ email: i.email, full_name: i.name, role: "introducer", introducer_id: introducerId });
  if (res) {
    $("#invite-result").innerHTML = `Portal login created for <strong>${esc(i.email)}</strong> — temporary password: <strong>${esc(res.temp_password)}</strong><br>Send them this with the back office address (they use the introducer page). They can change it via "Forgot password".`;
    loadIntroducers();
    refreshChangeHistory(); // invite-user writes an audit row recording who granted access to whom
  }
};
/* BACKEND-R4 §4 — invite-user v3 accepts admin · adviser · introducer, and nothing else. `staff`
   (what this form used to send) is now a 400, and `owner` is deliberately not invitable: a second
   Owner is created by an existing Owner promoting someone in the roster below, so no single
   unattended call can mint a top-level account. One line explains each tier as it is chosen. */
const INVITE_ROLE_HINTS = {
  admin: "Administrator — full back office, and can delete clients and cases. Cannot change settings or manage logins.",
  adviser: "Adviser — full back office for cases, clients, diary and comms. Cannot delete records, change settings or manage logins.",
  introducer: "Introducer — portal login only: they watch the progress of their own referrals and see nothing else.",
};
function renderInviteRoleHint() {
  const sel = $("#staff-role"), hint = $("#staff-role-hint"), introSel = $("#staff-introducer");
  if (!sel || !hint) return;
  const role = sel.value || "adviser";
  hint.textContent = (INVITE_ROLE_HINTS[role] || "") + " Owner level isn't invitable — promote a colleague in the list below instead.";
  if (!introSel) return;
  const wantIntro = role === "introducer";
  introSel.classList.toggle("hidden", !wantIntro);
  if (!wantIntro) return;
  // The edge function requires introducer_id for an introducer login, so the picker asks for it
  // rather than letting the call come back 400.
  const keep = introSel.value;
  introSel.innerHTML = ['<option value="">— which introducer? —</option>']
    .concat(INTRODUCERS.filter((i) => !i.hasLogin).map((i) => `<option value="${esc(i.id)}">${esc(i.name)}</option>`)).join("");
  if (keep) introSel.value = keep;
}
if ($("#staff-role")) $("#staff-role").addEventListener("change", renderInviteRoleHint);
$("#invite-staff-btn").addEventListener("click", async () => {
  const email = $("#staff-email").value.trim();
  const name = $("#staff-name").value.trim();
  const roleSel = $("#staff-role");
  const role = (roleSel && roleSel.value) || "adviser";
  const introducerId = role === "introducer" ? (($("#staff-introducer") || {}).value || "") : "";
  if (!isOwner()) return toast("Only the Owner can create logins.");
  if (!email) return toast("Email required");
  if (role === "introducer" && !introducerId) return toast("Choose which introducer this login belongs to");
  const roleName = ROLE_LABEL[role] || role;
  if (!confirm(`Create a ${roleName} login for ${email}?`)) return;
  const btn = $("#invite-staff-btn"); // T1-15 — in-flight guard
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const payload = { email, full_name: name, role };
    if (introducerId) payload.introducer_id = introducerId;
    const res = await inviteUser(payload);
    if (res) {
      $("#invite-result").innerHTML = `${esc(ROLE_LABEL[res.role] || roleName)} login created for <strong>${esc(email)}</strong> — temporary password: <strong>${esc(res.temp_password)}</strong><br>They should change it after first sign-in ("Forgot password" works too).`;
      $("#staff-email").value = ""; $("#staff-name").value = "";
      await loadTeam((await db.auth.getSession()).data.session);
      renderTeamRoster();
      loadIntroducers();
      refreshChangeHistory(); // invite-user writes an audit row recording who granted access to whom
    }
  } finally { btn.disabled = false; }
});
/* ---------- Team roster + role management (Owner only) ----------
   BACKEND-R4 §1. Writing `profiles` is Owner-only under RLS, and the profiles_guard_role trigger
   raises "Only an Owner can change a role" / "Cannot remove the last Owner — promote someone else
   first". The control below is only rendered for an Owner (presentation), and every failure path
   shows the DATABASE's own message verbatim rather than a generic "couldn't save" — those two
   sentences are the whole explanation of what went wrong. */
function roleMsg(text, bad) {
  const el = $("#team-role-msg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("hidden", !text);
  el.classList.toggle("error", !!bad);
}
/* The roster is drawn from PROFILES, not TEAM, so somebody set to "No access" STAYS ON THE LIST
   (marked, and with `none` pre-selected) instead of disappearing the moment their access is
   removed. Before this, TEAM excluded them and nothing in the app could render them again — the
   only way back was the Supabase dashboard. Introducer logins are excluded: they are managed in
   the Introducers panel and `introducer` is deliberately not an assignable role here. */
const rosterRoles = () => STAFF_ROLES.concat(["none"]);
/* R5-24 — an Admin (isAdminOrOwner() but not Owner) gets to SEE the roster — who's on the team,
   their role, what they hold — but none of the controls: no role select, no invite, no deactivate.
   Those stay Owner-only in the database (role changes: guard_role_change / "Only an Owner can
   change a role"; handover: the reassign RPC path here is a plain UI action gated the same way),
   so this is a straight read-only render, not a disabled form. */
async function renderTeamRoster() {
  const el = $("#team-roster");
  if (!el) return;
  if (!isAdminOrOwner()) { el.innerHTML = ""; return; }
  const roster = PROFILES.filter((p) => rosterRoles().includes(p.role));
  if (!isOwner()) {
    el.innerHTML = '<div class="dq-notice">Loading holdings…</div>';
    const holdings = await Promise.all(roster.map((p) => staffHoldings(p.id)));
    el.innerHTML = roster.length ? roster.map((p, i) => {
      const off = p.role === "none";
      const h = holdings[i];
      return `<div class="team-row">
        <div class="row-item">
        <div class="row-main">
          <div class="t">${esc(p.full_name || p.email || p.id)} <span class="badge ${off ? "grey" : "blue"}">${esc(ROLE_LABEL[p.role] || p.role)}</span>${p.id === (ME && ME.id) ? ' <span class="badge grey">you</span>' : ""}</div>
          <div class="s">${esc(p.email || "")}${p.email ? " · " : ""}${esc(holdingsSentence(h))}</div>
        </div>
        </div>
      </div>`;
    }).join("") : '<div class="empty">No team logins yet.</div>';
    return;
  }
  el.innerHTML = roster.length ? roster.map((p) => {
    // A legacy 'staff' row keeps its own value as an option so simply opening the page can never
    // silently re-tier someone.
    const opts = ASSIGNABLE_ROLES.concat(ASSIGNABLE_ROLES.some(([k]) => k === p.role) ? [] : [[p.role, ROLE_LABEL[p.role] || p.role]]);
    const off = p.role === "none";
    return `<div class="team-row" data-team-row="${esc(p.id)}">
      <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(p.full_name || p.email || p.id)}${off ? ' <span class="badge grey">No access</span>' : ""}</div>
        <div class="s">${esc(p.email || "")}${p.id === (ME && ME.id) ? " · you" : ""}${off ? " · signed out of the back office — pick a role to restore them" : ""}</div>
      </div>
      <select class="team-role" data-id="${esc(p.id)}" data-prev="${esc(p.role)}" aria-label="Role for ${esc(p.full_name || p.email || p.id)}">
        ${opts.map(([k, l]) => `<option value="${esc(k)}" ${k === p.role ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
      </div>
      ${PROFILE_CONTACT_SUPPORTED ? `<div class="team-contact" style="display:flex;gap:8px;flex-wrap:wrap;margin:2px 0 6px;">
        <input class="team-phone" type="tel" data-id="${esc(p.id)}" value="${esc(p.phone || "")}" placeholder="Phone" aria-label="Phone for ${esc(p.full_name || p.email || p.id)}" style="flex:1;min-width:130px;">
        <textarea class="team-signoff" rows="1" data-id="${esc(p.id)}" placeholder="Email sign-off" aria-label="Email sign-off for ${esc(p.full_name || p.email || p.id)}" style="flex:2;min-width:220px;resize:vertical;">${esc(p.email_signoff || "")}</textarea>
      </div>` : ""}
      <div class="team-deact hidden" data-deact="${esc(p.id)}"></div>
    </div>`;
  }).join("") : '<div class="empty">No team logins yet.</div>';
  el.querySelectorAll("select.team-role").forEach((sel) => { sel.onchange = () => changeRole(sel); });
  el.querySelectorAll("input.team-phone").forEach((inp) => { inp.onblur = () => saveTeamContact(inp.dataset.id, "phone", inp.value.trim()); });
  el.querySelectorAll("textarea.team-signoff").forEach((ta) => { ta.onblur = () => saveTeamContact(ta.dataset.id, "email_signoff", ta.value.trim()); });
}
/* B4 UI (R5-8) — Owner edits a colleague's phone/sign-off straight from the roster row (owner RLS
   covers writing any profile). One field at a time, on blur, so a role change and a contact edit
   in the same row are independent saves. */
async function saveTeamContact(id, field, value) {
  try {
    const { error } = await db.from("profiles").update({ [field]: value || null }).eq("id", id);
    if (error) {
      if (isMissingColumnError(error)) { toast("Phone / sign-off need migration M1 — not saved."); PROFILE_CONTACT_SUPPORTED = false; renderTeamRoster(); }
      else toast("Error: " + error.message);
      return;
    }
    const p = PROFILES.find((x) => x.id === id);
    if (p) p[field] = value || null;
  } catch (e) { toast("Error: " + e.message); }
}
/* What a colleague still holds. Counted before their access is removed so the Owner is told what
   is about to be left behind, rather than finding out when a colleague's ordinary save clears it. */
async function staffHoldings(id) {
  const nowIso = new Date().toISOString();
  const [cs, tk, ap] = await Promise.all([
    db.from("cases").select("id,stage").eq("assigned_to", id),
    db.from("case_tasks").select("id").eq("assigned_to", id).is("done_at", null),
    db.from("appointments").select("id").eq("staff_id", id).gte("starts_at", nowIso),
  ]);
  const cases = cs.data || [];
  return {
    cases: cases.length,
    live: cases.filter((c) => !["completed", "not_proceeding"].includes(c.stage)).length,
    tasks: (tk.data || []).length,
    appts: (ap.data || []).length,
  };
}
const holdingsSentence = (h) => [
  `${h.cases} case${h.cases === 1 ? "" : "s"} (${h.live} still live)`,
  `${h.tasks} open task${h.tasks === 1 ? "" : "s"}`,
  `${h.appts} future appointment${h.appts === 1 ? "" : "s"}`,
].join(" · ");
/* R5-2 — what a handover ACTUALLY moves, which is not the same as what the leaver holds. Only live
   cases, still-open tasks and future appointments change hands; completed and not-proceeding cases
   keep the adviser who did the work, because every report that reads `assigned_to` is a historical
   record and rewriting it retrospectively re-attributes months of somebody's completions to a
   colleague who never touched them. */
const moveSentence = (h) => [
  `${h.live} live case${h.live === 1 ? "" : "s"}`,
  `${h.tasks} open task${h.tasks === 1 ? "" : "s"}`,
  `${h.appts} future appointment${h.appts === 1 ? "" : "s"}`,
].join(" · ");
/* R5-M6 — the atomic handover, and the one rule about it: this function NEVER throws and never
   half-reports. It returns the RPC's {cases,tasks,appointments} tally when the whole transaction
   committed, and null for every other outcome — the function not existing yet on an older database
   (Postgres 42883), a refusal, a transport failure — so the caller falls back to the compensating
   client-side path unchanged. Returning null on failure is safe precisely because the RPC is one
   transaction: a failure inside it has already rolled every part of it back. */
const isMissingFunctionError = (e) => !!e && (e.code === "42883" || /does not exist/i.test(String(e.message || "")));
async function reassignHoldingsRpc(fromId, toId) {
  try {
    const { data, error } = await db.rpc("reassign_holdings", { p_from: fromId, p_to: toId });
    if (error) {
      if (!isMissingFunctionError(error)) {
        // Worth saying out loud in the sandbox/console: the transaction was refused and we are
        // about to do it the non-atomic way. The user-facing outcome is reported by the fallback.
        console.warn("reassign_holdings unavailable, falling back to the client-side path:", error.message);
      }
      return null;
    }
    if (!data || typeof data !== "object") return null;
    return {
      cases: Number(data.cases || 0),
      tasks: Number(data.tasks || 0),
      appointments: Number(data.appointments || 0),
    };
  } catch (e) { return null; }
}
/* The RPC's own tally in the same words moveSentence() uses for the pre-flight estimate, so the
   confirmation reports what actually moved rather than what was predicted a moment earlier. */
const rpcMoveSentence = (t) => [
  `${t.cases} live case${t.cases === 1 ? "" : "s"}`,
  `${t.tasks} open task${t.tasks === 1 ? "" : "s"}`,
  `${t.appointments} future appointment${t.appointments === 1 ? "" : "s"}`,
].join(" · ");

/* Removing access is the one role change that strands work, so it does not go straight through the
   plain confirm() the other tiers use. The Owner is shown the exact holdings and must choose:
   hand them to a named colleague, or knowingly leave them where they are. */
async function openDeactivate(id, sel) {
  const box = $(`#team-roster [data-deact="${id}"]`);
  const who = profileName(id) || "this login";
  if (!box) return;
  // Only one of these open at a time — the panel uses fixed ids for its controls.
  document.querySelectorAll("#team-roster .team-deact").forEach((b) => { if (b !== box) { b.classList.add("hidden"); b.innerHTML = ""; } });
  box.classList.remove("hidden");
  box.innerHTML = '<div class="dq-notice">Checking what this person still holds…</div>';
  const h = await staffHoldings(id);
  const others = TEAM.filter((p) => p.id !== id);
  const nothing = !(h.cases || h.tasks || h.appts);
  /* R5-2 — "is there anything to hand over?" is a different question from "do they hold anything?".
     Somebody whose only holdings are last year's completed cases has nothing that MOVES, and
     offering a reassign that would silently do nothing is worse than not offering it. */
  const nothingToMove = !(h.live || h.tasks || h.appts);
  box.innerHTML = `<div class="dq-notice">
    <strong>Remove ${esc(who)}'s access?</strong> They will be signed out of the back office and will no longer
    appear in any adviser dropdown.
    <div style="margin:6px 0;">${nothing
      ? `${esc(who)} currently holds nothing — no cases, open tasks or future appointments.`
      : `${esc(who)} still holds <strong>${esc(holdingsSentence(h))}</strong>. Records left with them stay assigned to them and keep showing their name, marked “no access”.`}</div>
    ${nothingToMove ? (nothing ? "" : `<div class="s" id="deact-scope" style="margin:2px 0 4px;">There is nothing live to hand over — ${esc(who)}'s remaining cases are completed or closed and stay attributed to them for reporting.</div>`) : `<label style="display:block;margin:6px 0;">Hand this work to
      <select id="deact-to" aria-label="Reassign this work to" style="width:auto;">
        <option value="">— choose a colleague —</option>
        ${others.map((p) => `<option value="${esc(p.id)}">${esc(staffName(p.id))}</option>`).join("")}
      </select></label>
    <div class="s" id="deact-scope" style="margin:2px 0 4px;">Handing over moves <strong>${esc(moveSentence(h))}</strong>.
      Completed and closed cases stay attributed to ${esc(who)} for reporting.</div>`}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
      ${nothingToMove ? "" : '<button class="btn btn-sm btn-primary" id="deact-reassign">Reassign, then remove access</button>'}
      <button class="btn btn-sm" id="deact-leave">${nothing ? "Remove access" : nothingToMove ? "Remove access" : "Remove access and leave the work with them"}</button>
      <button class="btn btn-sm btn-ghost" id="deact-cancel">Cancel</button>
    </div>
  </div>`;
  const close = () => { box.classList.add("hidden"); box.innerHTML = ""; if (sel) sel.value = sel.dataset.prev; };
  $("#deact-cancel").onclick = close;
  $("#deact-leave").onclick = async () => {
    if (!confirm(`Remove ${who}'s access${nothing ? "" : ` and leave ${holdingsSentence(h)} assigned to them`}?`)) return;
    box.classList.add("hidden"); box.innerHTML = "";
    await applyRole(id, "none", sel);
  };
  const reBtn = $("#deact-reassign");
  if (reBtn) reBtn.onclick = async () => {
    const to = ($("#deact-to") || {}).value || "";
    if (!to) return toast("Choose who this work goes to first.");
    if (!confirm(`Move ${moveSentence(h)} from ${who} to ${staffName(to)}, then remove ${who}'s access?`
      + `\n\nCompleted and closed cases stay attributed to ${who} for reporting.`)) return;
    reBtn.disabled = true;
    try {
      /* R5-M6 — the server-side transaction the compensating path below was written to stand in
         for. reassign_holdings(p_from, p_to) is SECURITY DEFINER, Owner-only via is_owner(), and
         moves the same three scopes (live cases, open tasks, future appointments) in ONE
         transaction, returning a {cases,tasks,appointments} tally. Try it FIRST; anything that
         comes back — the function missing on an older database (42883), a permissions refusal, a
         network failure — falls through to the unchanged client-side path, which is still correct,
         just not atomic. Nothing about the fallback is altered by this call succeeding or failing:
         on failure the RPC's own transaction has already rolled back, so the fallback starts from
         exactly the state it would have started from before. */
      const rpcTally = await reassignHoldingsRpc(id, to);
      if (rpcTally) {
        box.classList.add("hidden"); box.innerHTML = "";
        toast(`Work moved to ${staffName(to)}`);
        await applyRole(id, "none", sel,
          `${rpcMoveSentence(rpcTally)} moved to ${staffName(to)} in one transaction. Completed and closed cases stay with ${who}.`);
        return;
      }
      /* G1I-H1 (critical) — there is no transaction behind these three scoped moves, and they used
         to be fired unconditionally and judged only afterwards: one failure left the other two
         ALREADY COMMITTED while the panel reported "Nothing was reassigned and the role is
         unchanged". That sentence was flatly untrue — the leaver kept their access AND part of
         their book had silently moved, with no undo, and the next time the panel opened their
         holdings were simply smaller, so an Owner who believed nothing had happened would read the
         reduced number as "they held less than I thought".
         Without a server-side transaction the honest substitute is: move each scope by an
         explicitly-read id list, stop at the first failure, and PUT BACK whatever already moved.
         "Nothing was reassigned" is then a true statement. If a put-back itself fails there really
         is a split, and the message says which part sits where instead of claiming a clean slate. */
      const nowIso = new Date().toISOString();
      const [csRes, tkRes, apRes] = await Promise.all([
        db.from("cases").select("id,stage").eq("assigned_to", id),
        db.from("case_tasks").select("id").eq("assigned_to", id).is("done_at", null),
        db.from("appointments").select("id").eq("staff_id", id).gte("starts_at", nowIso),
      ]);
      const readErr = csRes.error || tkRes.error || apRes.error;
      if (readErr) {
        roleMsg(`Nothing was reassigned and the role is unchanged — couldn't read what ${who} currently holds: ${readErr.message}`, true);
        toast(readErr.message);
        return;
      }
      /* R5-2 — the handover used to sweep EVERY case the leaver had ever touched onto the new
         adviser, including years of completed ones. The next month's report then showed the
         colleague's completions and fees as the successor's, and the leaver's history simply
         vanished. Only live cases move. */
      const liveIds = (csRes.data || []).filter((c) => !["completed", "not_proceeding"].includes(c.stage)).map((c) => c.id);
      const taskIds = (tkRes.data || []).map((t) => t.id);
      const apptIds = (apRes.data || []).map((a) => a.id);
      const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
      const steps = [
        { what: plural(liveIds.length, "live case"), table: "cases", field: "assigned_to", ids: liveIds },
        { what: plural(taskIds.length, "open task"), table: "case_tasks", field: "assigned_to", ids: taskIds },
        { what: plural(apptIds.length, "future appointment"), table: "appointments", field: "staff_id", ids: apptIds },
      ];
      const moveStep = (s, target) => s.ids.length
        ? db.from(s.table).update({ [s.field]: target }).in("id", s.ids)
        : Promise.resolve({ error: null });
      const movedSoFar = [];
      let failed = null;
      for (const step of steps) {
        const { error } = await moveStep(step, to);
        if (error) { failed = { step, error }; break; }
        movedSoFar.push(step);
      }
      if (failed) {
        const stranded = [];
        for (const doneStep of movedSoFar.reverse()) {
          const { error } = await moveStep(doneStep, id);   // put it back on the leaver
          if (error) stranded.push(doneStep.what);
        }
        roleMsg(stranded.length
          ? `${stranded.join(" and ")} moved to ${staffName(to)} and could NOT be put back, but ${failed.step.what} did not move — ${who}'s work is split between two people. Sort this out before removing their access. — ${failed.error.message}`
          : `Nothing was reassigned and the role is unchanged — ${failed.error.message}`, true);
        toast(failed.error.message);
        return;
      }
      box.classList.add("hidden"); box.innerHTML = "";
      toast(`Work moved to ${staffName(to)}`);
      await applyRole(id, "none", sel, `${moveSentence(h)} moved to ${staffName(to)}. Completed and closed cases stay with ${who}.`);
    } finally { reBtn.disabled = false; }
  };
}
async function changeRole(sel) {
  const id = sel.dataset.id, prev = sel.dataset.prev, next = sel.value;
  if (next === prev) return;
  // "No access" strands whatever they hold — take the deliberate-choice route instead.
  if (next === "none") { sel.value = prev; return openDeactivate(id, sel); }
  const who = (PROFILES.find((p) => p.id === id) || {});
  if (!confirm(`Change ${who.full_name || who.email || "this login"}'s role from ${ROLE_LABEL[prev] || prev} to ${ROLE_LABEL[next] || next}?`)) {
    sel.value = prev;
    return;
  }
  return applyRole(id, next, sel);
}
// The write itself, shared by the plain role change and the deactivation flow. `note` is appended
// to the confirmation line so "…and their work moved to X" is reported in the same sentence.
async function applyRole(id, next, sel, note) {
  const prev = sel ? sel.dataset.prev : null;
  const who = (PROFILES.find((p) => p.id === id) || {});
  if (sel) sel.disabled = true;
  roleMsg("");
  try {
    const { error } = await db.from("profiles").update({ role: next }).eq("id", id);
    if (error) {
      // The trigger's own wording — "Cannot remove the last Owner — promote someone else first"
      // or "Only an Owner can change a role" — is the message the user needs to read.
      if (sel && prev != null) sel.value = prev;
      roleMsg(error.message, true);
      toast(error.message);
      return;
    }
    roleMsg(`${who.full_name || who.email || "Login"} is now ${ROLE_LABEL[next] || next}.${note ? " " + note : ""}`, false);
    toast("Role updated");
    const { data: { session } } = await db.auth.getSession();
    if (session) await loadTeam(session);
    // Changing your OWN role changes what this session may do — re-resolve it from the database.
    if (session && id === session.user.id) { await resolveMyRole(session); renderSettings(); return; }
    renderTeamRoster();
    refreshChangeHistory(); // the role change is an audit row on the panel below this roster
  } finally { if (sel) sel.disabled = false; }
}
async function inviteUser(payload) {
  const { data: { session } } = await db.auth.getSession();
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/invite-user`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok || j.error) { toast("Error: " + (j.error || r.status)); return null; }
    return j;
  } catch (e) { toast("Error: " + e.message); return null; }
}

/* ---------- Password show/hide ---------- */
document.addEventListener("click", (e) => {
  const b = e.target.closest(".pw-toggle");
  if (!b) return;
  const input = document.getElementById(b.dataset.target);
  if (!input) return;
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  b.classList.toggle("showing", show);
  b.title = b.ariaLabel = show ? "Hide password" : "Show password";
});

/* ---------- AI assistant chat ---------- */
let chatHistory = [];
let chatSeeded = false;

function addChatBubble(kind, text, actions) {
  const log = $("#chat-log");
  const div = document.createElement("div");
  div.className = "chat-msg " + (kind === "me" ? "chat-me" : kind === "err" ? "chat-ai chat-err" : "chat-ai");
  let html = esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
  if (actions && actions.length) html += "<div>" + actions.map((a) => `<span class="chat-action-chip">✓ ${esc(a.kind)}</span>`).join("") + "</div>";
  div.innerHTML = html;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}
window.askAI = function (prefill) {
  $("#assistant-drawer").classList.remove("hidden");
  if (!chatSeeded) {
    chatSeeded = true;
    const first = (((ME && ME.full_name) || (ME && ME.email)) || "there").split(/[\s@]/)[0];
    addChatBubble("ai", `Hi ${first}! I can look up clients, create tasks, add notes, queue template emails and draft replies. What do you need?`);
  }
  $("#chat-input").value = prefill || "";
  $("#chat-input").focus();
};
async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatHistory.push({ role: "user", content: text });
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
  addChatBubble("me", text);
  const typing = document.createElement("div");
  typing.className = "chat-msg chat-ai chat-typing";
  typing.textContent = "Thinking…";
  $("#chat-log").appendChild(typing);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  $("#chat-send").disabled = true;
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/assistant`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory }),
    });
    const j = await r.json();
    typing.remove();
    if (j.error === "not_configured") { addChatBubble("err", j.reply || "Assistant not configured — add ANTHROPIC_API_KEY in Supabase."); return; }
    if (!r.ok || (j.error && !j.reply)) { addChatBubble("err", "Error: " + (j.error || r.status)); return; }
    chatHistory.push({ role: "assistant", content: j.reply });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    addChatBubble("ai", j.reply, j.actions);
    if (j.actions && j.actions.length && !$("#page-dashboard").classList.contains("hidden")) loadBriefing();
  } catch (e) {
    typing.remove();
    addChatBubble("err", "Error: " + e.message);
  } finally {
    $("#chat-send").disabled = false;
  }
}
$("#assistant-fab").addEventListener("click", () => askAI());
$("#assistant-close").addEventListener("click", () => $("#assistant-drawer").classList.add("hidden"));
$("#chat-form").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });

/* ---------- Second-layer overlay (R5 batch 2) ----------
   Some captures have to happen ON TOP of an open record modal without destroying it: the
   required lost reason when a case moves to Not Proceeding, and the per-fee-type paid dates.
   Rendering them into #modal would throw away the case form (and its unsaved edits), so they
   get their own backdrop above it. Resolves the value the caller needs, or null on cancel —
   Escape and a backdrop click are swallowed here so they cancel the CAPTURE, never the modal
   underneath. `wire(finish, box)` gets the resolve function and the overlay element. */
function openOverlay(html, wire) {
  return new Promise((resolve) => {
    const backdrop = $("#overlay-backdrop"), box = $("#overlay-modal");
    if (!backdrop || !box) return resolve(null); // no overlay host (old markup) — caller falls back
    const prevFocus = document.activeElement;
    let done = false;
    // G1R-1 — the history entry this capture is being raised on. Back pops it; the popstate handler
    // pushes it straight back and cancels the capture, so the overlay can never end up over a page
    // (or a closed modal) it was not opened from. Captured BEFORE the backdrop is shown.
    const anchor = { state: history.state, hash: location.hash || pageHash(currentPage), finish: null };
    const finish = (val) => {
      if (done) return;
      done = true;
      const at = overlayStack.indexOf(anchor);
      if (at >= 0) overlayStack.splice(at, 1);
      document.removeEventListener("keydown", onKey, true);
      backdrop.removeEventListener("mousedown", onBackdrop);
      backdrop.classList.add("hidden");
      box.innerHTML = "";
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
      resolve(val);
    };
    // Capture phase: the case modal's own Escape/Tab handlers are on document (bubble), and they
    // would close the modal underneath or steal focus back into it while this overlay is up.
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(null); }
      else if (e.key === "Tab") e.stopPropagation();
    };
    const onBackdrop = (e) => { if (e.target === backdrop) finish(null); };
    anchor.finish = finish;
    overlayStack.push(anchor);
    box.innerHTML = html;
    backdrop.classList.remove("hidden");
    document.addEventListener("keydown", onKey, true);
    backdrop.addEventListener("mousedown", onBackdrop);
    try { wire(finish, box); } catch (err) { finish(null); }
    const first = box.querySelector("select, input, textarea, button");
    if (first) first.focus();
  });
}

/* ---------- Modal helpers ---------- */
let modalPrevFocus = null;
function modalFocusable() {
  return [...$("#modal").querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null);
}
function openModal() {
  modalPrevFocus = document.activeElement;
  // Inject a persistent close (×) affordance (M3). Modal content is set via innerHTML on each
  // open, so this is re-added every time; it sticks to the modal's top-right (see .modal-close).
  const modal = $("#modal");
  if (!modal.querySelector(".modal-close")) {
    const x = document.createElement("button");
    x.type = "button";
    x.className = "modal-close";
    x.setAttribute("aria-label", "Close");
    x.title = "Close";
    x.textContent = "✕";
    x.addEventListener("click", closeModalGuarded);
    modal.insertBefore(x, modal.firstChild);
  }
  $("#modal-backdrop").classList.remove("hidden");
  snapshotModalState(); // defect 4 — baseline for the dirty guard, taken as rendered
  // Focus the first real control, not the close button, so keyboard flow is unchanged.
  const f = modalFocusable().filter((el) => !el.classList.contains("modal-close"));
  if (f.length) f[0].focus();
}
window.closeModal = function () {
  // Defect 5 — pop the history entry this modal pushed, unless the browser already did (Back/Escape
  // route through popstate, which pops it for us). Nulling currentModal alone left a dead entry, so
  // the first Back after a Save/Cancel appeared to do nothing.
  const ownedEntry = !!currentModal && !closingFromPopstate;
  $("#modal-backdrop").classList.add("hidden");
  if (modalPrevFocus && typeof modalPrevFocus.focus === "function") modalPrevFocus.focus();
  modalPrevFocus = null;
  currentModal = null; // BUILD 7a — this modal no longer owns a history entry
  modalSnapshot = "";
  if (ownedEntry) {
    modalHistoryPopPending = true; // the popstate this raises is ours (see the handler)
    try { history.back(); } catch (e) { modalHistoryPopPending = false; }
  }
};
// Log-call dirty guard (defect 14) — true when the case summary's inline Log-call panel is open
// and has unsaved text (outcome note or follow-up title). Saving the call (submitCall) always
// clears these fields before hiding the panel, so this naturally goes false again once saved.
function hasUnsavedLogCall() {
  const panel = $("#cs-logcall-panel");
  if (!panel || panel.classList.contains("hidden")) return false;
  const note = $("#cs-call-note");
  const fuTitle = $("#cs-call-fu-title");
  return !!((note && note.value.trim()) || (fuTitle && fuTitle.value.trim()));
}
/* ---------- Unsaved-changes guard (defect 4) ----------
   The old guard watched two hard-coded Log-call fields, so a fully re-keyed case (lender, fee,
   stage…) or client or appointment could be thrown away by Escape without a word. Instead, snapshot
   every field the operator can edit at the moment the modal renders and diff it on the way out.
   The snapshot is taken inside openModal() — after the innerHTML is set, and again on every
   re-render (merge modal radio flip, reopened case) — so anything the app itself writes while
   building the form is part of the baseline and can never read as an edit; opening a modal and
   closing it straight away therefore never prompts. Only the record forms and the free-text
   quick-add boxes count: filter chips and the timeline's case picker are navigation, not data. */
const DIRTY_FORMS = ["#case-form", "#client-form", "#appt-form"];
const DIRTY_INPUTS = ["#new-task", "#new-task-due", "#new-note", "#cs-call-note", "#cs-call-fu-title", "#cs-call-fu-due", "#tl-note"];
const DISCARD_PROMPT = "Discard your unsaved changes?";
let modalSnapshot = "";
function modalFormState() {
  const parts = [];
  DIRTY_FORMS.forEach((sel) => {
    const form = $(sel);
    if (!form) return;
    parts.push(sel);
    [...form.elements].forEach((el) => {
      if (!el.name) return;
      parts.push(el.name + "=" + (el.type === "checkbox" || el.type === "radio" ? (el.checked ? "1" : "0") : String(el.value)));
    });
  });
  DIRTY_INPUTS.forEach((sel) => { const el = $(sel); if (el) parts.push(sel + "=" + String(el.value)); });
  return parts.join("\u001f"); // unit separator: cannot occur in typed text, so fields cannot run together
}
function snapshotModalState() { modalSnapshot = modalFormState(); }
function hasUnsavedModalEdits() { return hasUnsavedLogCall() || modalFormState() !== modalSnapshot; }
// User-initiated "abandon the modal" paths (Cancel, Escape, backdrop click, × button) — as opposed to
// closeModal() itself, which is also called after successful saves/deletes elsewhere and shouldn't
// be gated behind a confirm() there.
function closeModalGuarded() {
  // BUILD 7a — for a history-tracked modal, close via Back so the pushed entry is popped and history
  // stays in sync; the popstate handler runs the dirty guard (and re-pushes if the user cancels).
  if (currentModal) { history.back(); return; }
  if (hasUnsavedModalEdits() && !confirm(DISCARD_PROMPT)) return;
  closeModal();
}
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === $("#modal-backdrop")) closeModalGuarded(); });
document.addEventListener("keydown", (e) => {
  if ($("#modal-backdrop").classList.contains("hidden")) return;
  if (e.key === "Escape") { e.preventDefault(); closeModalGuarded(); return; }
  if (e.key === "Tab") {
    const f = modalFocusable();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ---------- Global search / command palette (BUILD 2c) ----------
   Persistent sidebar affordance + "/" hotkey. Opens a centered overlay that searches
   CLIENTS (name/email/phone) and CASES (client name / lender / stage+kind label) via at
   most two server-side ilike queries per keystroke (debounced) — never loads whole tables.
   Every read is wrapped so a missing column or network error degrades to the zero-result
   state instead of throwing. */
(function () {
  const backdrop = $("#palette-backdrop");
  const input = $("#palette-input");
  const resultsEl = $("#palette-results");
  const btn = $("#global-search-btn");
  if (!backdrop || !input || !resultsEl) return;
  const KIND_LABEL = Object.fromEntries(KINDS);

  let flat = [];        // flattened selectable rows: { type:"client"|"case", id }
  let sel = -1;         // index into flat of the highlighted row
  let seq = 0;          // request-sequence guard: only the latest keystroke may render
  let debounceH = null;

  const appVisible = () => { const a = $("#app-view"); return a && !a.classList.contains("hidden"); };
  // Strip characters that would break a PostgREST .or() filter string (commas / parens).
  const sanitize = (s) => String(s || "").replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();

  function openPalette() {
    if (!appVisible() || !backdrop.classList.contains("hidden")) return;
    backdrop.classList.remove("hidden");
    input.value = "";
    renderIdle();
    setTimeout(() => input.focus(), 0);
  }
  function closePalette(returnFocus) {
    if (backdrop.classList.contains("hidden")) return;
    backdrop.classList.add("hidden");
    clearTimeout(debounceH);
    seq++;               // invalidate any in-flight query so it can't render after close
    flat = []; sel = -1;
    if (returnFocus && btn) btn.focus();
  }
  function renderIdle() {
    flat = []; sel = -1;
    resultsEl.innerHTML = '<div class="palette-empty">Search clients by name, email or phone — and cases by client, lender or stage.</div>';
  }
  function renderEmpty(q) {
    flat = []; sel = -1;
    resultsEl.innerHTML = `<div class="palette-empty">No matches for &ldquo;${esc(q)}&rdquo;</div>`;
  }
  function rowHtml(idx, icon, title, sub) {
    return `<div class="palette-row" role="option" data-idx="${idx}">` +
      `<span class="pr-ic" aria-hidden="true">${icon}</span>` +
      `<span class="pr-main"><span class="pr-title">${esc(title)}</span><span class="pr-sub">${esc(sub)}</span></span></div>`;
  }
  function render(clients, cases, leads, q) {
    flat = [];
    let html = "";
    const caseIdxById = {};
    if (clients.length) {
      html += '<div class="palette-group-label">Clients</div>';
      clients.forEach((cl) => {
        const name = [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "(no name)";
        const sub = [cl.phone, cl.email].filter(Boolean).join("  ·  ") || "No contact details";
        const idx = flat.length; flat.push({ type: "client", id: cl.id });
        html += rowHtml(idx, "👤", name, sub);
      });
    }
    if (cases.length) {
      html += '<div class="palette-group-label">Cases</div>';
      cases.forEach((cs) => {
        const cl = cs.clients || {};
        const name = [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "Case";
        const bits = [STAGE_LABEL[cs.stage] || cs.stage];
        if (cs.lender) bits.push(cs.lender);
        else if (KIND_LABEL[cs.case_kind]) bits.push(KIND_LABEL[cs.case_kind]);
        const idx = flat.length; flat.push({ type: "case", id: cs.id });
        caseIdxById[cs.id] = idx;
        html += rowHtml(idx, "🗂️", name, bits.filter(Boolean).join("  ·  "));
      });
    }
    if (leads && leads.length) {
      html += '<div class="palette-group-label">Leads</div>';
      leads.forEach((l) => {
        const sub = ["Web enquiry", l.phone, l.email].filter(Boolean).join("  ·  ");
        const idx = flat.length; flat.push({ type: "lead", id: l.id });
        html += rowHtml(idx, "📥", l.name || "(no name)", sub);
      });
    }
    if (!flat.length) { renderEmpty(q); return; }
    resultsEl.innerHTML = html;
    // Default highlight (defect #20 / A3): if the top client hit has exactly ONE open case,
    // point Enter at that CASE modal (its one-tap Log-call / follow-up tools live there). The
    // client row is still one arrow-key away.
    sel = 0;
    if (clients.length) {
      const top = clients[0];
      const open = cases.filter((cs) => cs.client_id === top.id && cs.stage !== "completed" && cs.stage !== "not_proceeding");
      if (open.length === 1 && caseIdxById[open[0].id] != null) sel = caseIdxById[open[0].id];
    }
    updateSel(false);
  }
  function updateSel(scroll) {
    const rows = resultsEl.querySelectorAll(".palette-row");
    rows.forEach((r) => r.classList.toggle("sel", Number(r.dataset.idx) === sel));
    if (scroll && rows[sel]) rows[sel].scrollIntoView({ block: "nearest" });
  }
  function move(delta) {
    if (!flat.length) return;
    sel = (sel + delta + flat.length) % flat.length;
    updateSel(true);
  }
  function openSel() {
    const item = flat[sel];
    if (!item) return;
    closePalette(false);   // don't grab focus back — the modal will manage its own
    if (item.type === "client") window.openClient(item.id);
    else if (item.type === "lead") openLeadOnToday();
    else window.openCase(item.id);
  }
  // A lead has no record modal — jump to Today with the leads drawer open so the enquiry can be
  // Accepted/Discarded straight away (defect #2).
  function openLeadOnToday() {
    if (typeof nav === "function") nav("dashboard");
    dashDrawerTouched.leads = true;              // stop autoDrawer from re-collapsing it
    const panel = document.getElementById("leads-panel");
    if (panel) { panel.classList.remove("collapsed"); setTimeout(() => { try { panel.scrollIntoView({ block: "nearest" }); } catch (e) {} }, 60); }
  }

  async function runSearch(raw) {
    const q = sanitize(raw);
    const mySeq = ++seq;
    if (q.length < 2) { renderIdle(); return; }
    // Tokenisation (defect #1): split on whitespace so a multi-word / full-name query works.
    const tokens = q.split(" ").filter(Boolean);
    const phoneDigits = String(raw).replace(/[^\d+]/g, "");
    const isPhone = phoneDigits.replace(/\D/g, "").length >= 3;
    // Interleave digits with % so "07700 900123" matches however the number is spaced/punctuated.
    const phoneOr = () => { const pd = normPhone(phoneDigits).replace(/\D/g, ""); return `phone.ilike.%${pd.split("").join("%")}%`; };
    let clients = [], cases = [], leads = [];
    try {
      // ---- Query 1: clients by name / email / phone ----
      // Phone lookups keep the single interleaved-digit OR (Sarah's headline use case). Text
      // lookups tokenise: EACH token must match somewhere across first/last/email — chained
      // .or() clauses AND together — so "James Whitfield" AND "whitfield james" both find him.
      let clientQ = db.from("clients").select("id,first_name,last_name,email,phone");
      if (isPhone) {
        clientQ = clientQ.or([`first_name.ilike.%${q}%`, `last_name.ilike.%${q}%`, `email.ilike.%${q}%`, phoneOr()].join(","));
      } else {
        tokens.forEach((tok) => { clientQ = clientQ.or([`first_name.ilike.%${tok}%`, `last_name.ilike.%${tok}%`, `email.ilike.%${tok}%`].join(",")); });
      }
      const { data: cl } = await clientQ.limit(8);
      if (mySeq !== seq) return;
      clients = cl || [];

      // ---- Query 2: cases by client name (matched ids) / lender / stage+kind label ----
      const ql = q.toLowerCase();
      const stageMatches = STAGES.filter(([v, l]) => l.toLowerCase().includes(ql) || v.includes(ql)).map((s) => s[0]);
      const kindMatches = KINDS.filter(([v, l]) => l.toLowerCase().includes(ql) || v.includes(ql)).map((k) => k[0]);
      const orCase = [`lender.ilike.%${q}%`];
      if (stageMatches.length) orCase.push(`stage.in.(${stageMatches.join(",")})`);
      if (kindMatches.length) orCase.push(`case_kind.in.(${kindMatches.join(",")})`);
      const cids = clients.map((c) => c.id).filter(Boolean);
      if (cids.length) orCase.push(`client_id.in.(${cids.join(",")})`);
      const { data: cs } = await db.from("cases")
        .select("id,stage,case_kind,lender,client_id,clients(first_name,last_name)")
        .or(orCase.join(",")).order("updated_at", { ascending: false }).limit(8);
      if (mySeq !== seq) return;
      cases = cs || [];
    } catch (e) {
      if (mySeq !== seq) return;
      renderEmpty(q);      // errors degrade silently to the zero-result state
      return;
    }

    // ---- Query 3: new website leads (defect #2). Wrapped on its own so a blocked/absent leads
    // table degrades to "no leads" without wiping the client/case results. Same tokenisation. ----
    try {
      let leadQ = db.from("leads").select("id,name,email,phone,enquiry_type,status").eq("status", "new");
      if (isPhone) {
        leadQ = leadQ.or([`name.ilike.%${q}%`, `email.ilike.%${q}%`, phoneOr()].join(","));
      } else {
        tokens.forEach((tok) => { leadQ = leadQ.or([`name.ilike.%${tok}%`, `email.ilike.%${tok}%`].join(",")); });
      }
      const { data: ld } = await leadQ.limit(6);
      if (mySeq === seq) leads = ld || [];
    } catch (e) { /* leads table unavailable — leave empty */ }

    if (mySeq !== seq) return;
    render(clients, cases, leads, q);
  }

  // Global "/" hotkey — opens the palette unless the user is typing in a field.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target, tag = t && t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    if (!appVisible() || !backdrop.classList.contains("hidden")) return;
    e.preventDefault();
    openPalette();
  });
  if (btn) btn.addEventListener("click", openPalette);
  // T1-29 — the "Esc" chip is a real close button now (was an inert <kbd>); on a phone there is
  // no Escape key, so this is the ONLY way the close instruction in the UI can be honest.
  const closeBtn = $("#palette-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", () => closePalette(true));
  input.addEventListener("input", () => {
    const v = input.value;
    clearTimeout(debounceH);
    debounceH = setTimeout(() => runSearch(v), 250);
  });
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closePalette(true); }
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); openSel(); }
    else if (e.key === "Tab") { e.preventDefault(); input.focus(); }  // keep focus inside the palette
  });
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closePalette(true); });
  resultsEl.addEventListener("click", (e) => {
    const row = e.target.closest(".palette-row");
    if (!row) return;
    sel = Number(row.dataset.idx);
    openSel();
  });
})();

init();
