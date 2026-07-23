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
const SETTING_FIELDS = [
  ["company_name", "Company name"],
  ["adviser_name", "Adviser name (email sign-off)"],
  ["adviser_phone", "Adviser phone"],
  ["from_email", "From email (verified in Resend)"],
  ["reply_to_email", "Reply-to email"],
  ["google_review_link", "Google review link"],
  ["bank_account_name", "Bank account name"],
  ["bank_sort_code", "Sort code"],
  ["bank_account_number", "Account number"],
  ["rate_reminder_months", "Rate reminder lead time (months)"],
  ["review_delay_days", "Review request delay after completion (days)"],
  ["referral_delay_days", "Referral nudge delay after review request (days)"],
  ["solicitor_chase_days", "Solicitor chase task after exchange (days)"],
  ["auto_docs_request", "Auto document-request email at Fact Find (on/off)"],
  ["auto_submitted_update", "Auto submitted email at Application (on/off)"],
  ["auto_offer_update", "Auto offer email at Offer (on/off)"],
  ["auto_completion_email", "Auto completion email (on/off)"],
  ["auto_referral", "Auto referral nudge after review (on/off)"],
  ["docs_list", "Document checklist (separate items with |)"],
];

const $ = (s) => document.querySelector(s);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const fmtD = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
// UK-local (Europe/London) date-only string YYYY-MM-DD. en-CA gives ISO-style ordering.
// Used for "today"/overdue/horizon comparisons so they don't drift to the UTC calendar date after midnight BST.
const localDateStr = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d ? new Date(d) : new Date());
// UK-local YYYY-MM month bucket for report grouping.
const localMonthStr = (d) => localDateStr(d).slice(0, 7);
// Normalise a UK phone number for comparison/search: strip spaces/punctuation and map +44/0044 → 0.
const normPhone = (p) => (p == null ? "" : String(p).replace(/[\s()\-.]/g, "").replace(/^\+44/, "0").replace(/^0044/, "0"));
// Tap-to-call / tap-to-email links (M2). Displays the number/address verbatim; the tel: href is
// space-stripped so the dialler gets a clean value. Returns "" for empty input so callers can guard.
const telLink = (p) => { if (!p) return ""; const raw = String(p).trim(); const href = raw.replace(/[^\d+]/g, ""); return `<a class="contact-link" href="tel:${esc(href)}">${esc(raw)}</a>`; };
const mailLink = (e) => { if (!e) return ""; const raw = String(e).trim(); return `<a class="contact-link" href="mailto:${encodeURIComponent(raw).replace(/%40/g, "@")}">${esc(raw)}</a>`; };
const fmtM = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }));
// Exact-pence money — for fee figures on the case detail / evidence pack only. Dashboards keep fmtM (whole pounds).
const fmtM2 = (n) => (n == null || n === "" ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }));
let settings = {};
let ME = null, TEAM = [], tasksScope = "mine";
let pipelineView = "board", stageTab = "all", sortKey = "updated_at", sortDir = -1;
function staffName(id) { const p = TEAM.find((x) => x.id === id); return p ? (p.full_name || p.email) : "—"; }
function initials(id) { const n = staffName(id); return n === "—" ? "" : n.split(/[\s@.]+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase(); }

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
async function showApp(session) {
  // Gate FIRST: only back-office staff may use the admin SPA (mirrors introducer.html).
  // Done before revealing the shell or reading settings/team so a non-staff account
  // never sees the admin UI or triggers those reads.
  const { data: myProfile } = await db.from("profiles").select("role").eq("id", session.user.id).single();
  if (!myProfile || myProfile.role !== "staff") {
    await db.auth.signOut();
    showLogin();
    toast("This login doesn't have back-office access.");
    return;
  }
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#assistant-fab").classList.remove("hidden");
  $("#user-email").textContent = session.user.email;
  await loadSettings();
  await loadTeam(session);
  nav("dashboard");
}
async function loadTeam(session) {
  const { data: team } = await db.from("profiles").select("id,full_name,email,role").eq("role", "staff").order("full_name");
  TEAM = team || [];
  ME = TEAM.find((p) => p.id === session.user.id) || null;
  const first = ((ME && ME.full_name) || session.user.email).split(/[\s@]/)[0];
  $("#today-heading").textContent = `Today — ${first}`;
  $("#board-adviser").innerHTML = ['<option value="all">All advisers</option>', '<option value="unassigned">Unassigned</option>']
    .concat(TEAM.map((p) => `<option value="${p.id}">${esc(staffName(p.id))}</option>`)).join("");
  $("#diary-staff").innerHTML = ['<option value="all">Everyone</option>']
    .concat(TEAM.map((p) => `<option value="${p.id}">${esc(staffName(p.id))}</option>`)).join("");
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

/* ---------- Navigation ---------- */
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
function nav(page) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  $("#page-" + page).classList.remove("hidden");
  document.querySelectorAll("#topnav button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  ({ dashboard: loadDashboard, pipeline: loadPipeline, protection: loadProtectionPage, diary: loadDiary, clients: loadClients, import: () => {}, reports: loadReports, data: loadDataHealth, emails: loadEmails, settings: renderSettings }[page])();
}

/* ---------- Settings ---------- */
async function loadSettings() {
  const { data } = await db.from("settings").select("*");
  settings = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
}
function renderSettings() {
  $("#settings-form").innerHTML = SETTING_FIELDS.map(([k, label]) =>
    `<label>${esc(label)}<input name="${k}" value="${esc(settings[k] ?? "")}"></label>`).join("") + `
    <h3 style="grid-column:1/-1;margin:10px 0 0;">Outlook &amp; AI</h3>
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
    <h3 style="grid-column:1/-1;margin:10px 0 0;">Client comms &amp; SMS</h3>
    <label>Financial promotions approved (master switch)
      <select name="financial_promotions_approved">
        <option value="off" ${(settings.financial_promotions_approved ?? "off") === "on" ? "" : "selected"}>Off</option>
        <option value="on" ${settings.financial_promotions_approved === "on" ? "selected" : ""}>On</option>
      </select>
    </label>
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">Master switch — no marketing email (referral, protection, GI) sends until this is on. Confirm your network has approved the templates.</p>
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
    <p class="panel-sub" style="grid-column:1/-1;margin:4px 0 0;">SMS also needs provider credentials set as Supabase secrets (Twilio: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN; ClickSend: CLICKSEND_USERNAME / CLICKSEND_API_KEY). Nothing sends until sms_enabled is on and credentials are set.</p>
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
      <input name="review_platform_link" value="${esc(settings.review_platform_link ?? "")}" placeholder="https://g.page/r/…">
    </label>
    <label>Site URL
      <input name="site_url" value="${esc(settings.site_url ?? "")}" placeholder="https://www.nexmoney.co.uk">
    </label>`;
  $("#send-digest-btn").onclick = sendDigestNow;
  loadIntroducers();
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
  const rows = [...$("#settings-form").querySelectorAll("input, select")].map((i) => ({ key: i.name, value: i.value.trim() }));
  const { error } = await db.from("settings").upsert(rows);
  if (error) return toast("Error: " + error.message);
  await loadSettings();
  $("#settings-saved").classList.remove("hidden");
  setTimeout(() => $("#settings-saved").classList.add("hidden"), 2500);
});

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  const reminderMonths = Number(settings.rate_reminder_months || 6);
  const [{ data: cases, error: casesErr }, { data: alerts, error: alertsErr }] = await Promise.all([
    db.from("cases").select("id,stage,fee_status,broker_fee,completed_at"),
    db.from("v_alerts").select("*").order("rate_end_date"),
  ]);
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

  $("#kpi-row").innerHTML = `
    <div class="kpi"><div class="num">${active.length}</div><div class="lbl">Active cases</div></div>
    <div class="kpi"><div class="num">${completedThisYear.length}</div><div class="lbl">Completions in ${yr}</div></div>
    <div class="kpi ${ratesSoon.length ? "warn" : ""}"><div class="num">${ratesSoon.length}</div><div class="lbl">Rates ending ≤ ${reminderMonths}mo (or overdue)</div></div>
    <div class="kpi ${ercFlags.length ? "bad" : ""}"><div class="num">${ercFlags.length}</div><div class="lbl">ERC outlasts rate</div></div>
    <div class="kpi ${feesDue.length ? "warn" : ""}"><div class="num">${fmtM(feesDueTotal)}</div><div class="lbl">Fees outstanding (${feesDue.length})</div></div>`;

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
    </div>`).join("") + (rateErcMerged.length > 15 ? `<div class="empty">…and ${rateErcMerged.length - 15} more — see Pipeline table view.</div>` : "") : '<div class="empty">Nothing ending in the reminder window, and no ERC conflicts. 👍</div>';

  loadRetention();
  loadTasks();
  loadProtection();
  loadLeads();
  loadTodayAppts();
  loadBriefing();
  loadWatchtower();
  if (settings.outlook_enabled === "1") {
    const last = Number(localStorage.getItem("nm_last_outlook_sync") || 0);
    if (Date.now() - last > 10 * 60000) {
      localStorage.setItem("nm_last_outlook_sync", String(Date.now()));
      syncOutlook(true);
    }
  }

  const feeAlerts = (alerts || []).filter((a) => a.stage === "completed" && ["not_requested", "requested"].includes(a.fee_status) && a.broker_fee > 0);
  $("#alerts-fees").innerHTML = feeAlerts.length ? feeAlerts.map((a) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${a.case_id}')">${esc(a.client_name)}</div>
        <div class="s">${fmtM(a.broker_fee)} — ${lenderIcon(a.lender)}${esc(a.lender || "")}</div>
      </div>
      <span class="badge ${a.fee_status === "requested" ? "amber" : "grey"}">${a.fee_status === "requested" ? "Requested" : "Not requested"}</span>
    </div>`).join("") : '<div class="empty">No outstanding fees on completed cases.</div>';
  $("#tab-fees-count").textContent = feeAlerts.length;
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
  $("#retention-stats").textContent =
    `${open.length} open · ${won} won · ${lost} lost${rate != null ? ` · ${rate}% conversion` : ""}. Opportunities are created automatically when a completed client's rate enters the reminder window.`;
  $("#retention-list").innerHTML = open.length ? open.slice(0, 12).map((c) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${c.id}')">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</div>
        <div class="s">${lenderIcon(c.lender)}${esc(c.lender || "")} — rate ends ${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""}</div>
      </div>
      <span class="badge blue">${STAGE_LABEL[c.stage] || c.stage}</span>
    </div>`).join("") + (open.length > 12 ? `<div class="empty">…and ${open.length - 12} more in the pipeline.</div>` : "")
    : '<div class="empty">No open retention opportunities yet — they\'ll appear here automatically.</div>';
  panelCount("#retention-list", open.length);
}

async function loadTasks() {
  const horizon = localDateStr(Date.now() + 14 * 86400000);
  const { data: raw, error } = await db.from("case_tasks")
    .select("id,title,due_date,case_id,assigned_to,cases(clients(first_name,last_name))")
    .is("done_at", null)
    .lte("due_date", horizon)
    .order("due_date")
    .limit(200); // sane fetch cap; the "mine" scope filter is applied client-side below, so limit AFTER filtering (was .limit(40) which truncated busy advisers' lists/badges before scoping)
  if (error) { renderLoadError("#tasks-list", error, loadTasks); return; }
  const filtered = (raw || []).filter((t) => tasksScope === "all" || !t.assigned_to || t.assigned_to === (ME && ME.id));
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
}

/* ---------- My Day briefing ---------- */
let briefingScope = "mine";

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
      return `<button class="btn btn-sm btn-primary" onclick="acceptLead('${it.lead_id}', event)">Accept</button>`;
    case "email_new":
      return `${it.case_id ? `<button class="btn btn-sm" onclick="openCase('${it.case_id}')">Open case</button>` : ""}<button class="btn btn-sm" onclick="markEmailHandled('${it.email_id}')">Handled</button>${it.case_id ? `<button class="btn btn-sm" onclick="askAI('Draft a reply to the latest email from this client. Case id: ${it.case_id}')">Draft reply</button>` : ""}`;
    case "appt_today":
      return it.appt_id ? `<button class="btn btn-sm" onclick="openAppt('${it.appt_id}')">Open</button>` : "";
    case "rate_urgent":
      return `${(it.sub || "").includes("not contacted") ? `<button class="btn btn-sm" onclick="briefQueueEmail('${it.case_id}','rate_end_reminder', event)">Send reminder</button>` : ""}${open}`;
    case "fee_chase":
      return `<button class="btn btn-sm" onclick="briefQueueEmail('${it.case_id}','fee_request', event)">Chase fee</button>${open}`;
    case "protection_hot":
      return `<button class="btn btn-sm" onclick="setProtStatus('${it.case_id}','quoted').then(()=>loadBriefing())">Mark quoted</button>${open}`;
    default:
      return open;
  }
}
async function loadBriefing() {
  $("#briefing-date").textContent = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const { data, error } = await db.rpc("get_briefing", { p_scope: briefingScope });
  if (error) {
    $("#briefing-list").innerHTML = `<div class="empty">Briefing unavailable — ${esc(error.message)}</div>`;
    return;
  }
  const items = Array.isArray(data) ? data : [];
  $("#briefing-list").innerHTML = items.length ? items.map((it) => `
    <div class="row-item brief-row ${it.pri < 15 ? "hot" : it.pri < 35 ? "warm" : ""}">
      <div class="row-main">
        <div class="t" ${it.case_id ? `onclick="openCase('${it.case_id}')"` : it.client_id ? `onclick="openClient('${it.client_id}')"` : ""}>${esc(it.title)}</div>
        <div class="s">${esc(it.sub || "")}${briefingScope === "all" && it.owner ? " · " + esc(staffName(it.owner)) : ""}</div>
      </div>
      ${briefBadge(it)}
      ${briefActions(it)}
    </div>`).join("") : '<div class="empty">All clear — nothing needs you right now 🎉</div>';
  panelCount("#briefing-list", items.length, items.some((it) => it.pri < 15));
}
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
  const alerts = (data || []).slice().sort((a, b) => (WATCH_SEV[a.severity] ?? 3) - (WATCH_SEV[b.severity] ?? 3));
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
      <button class="btn btn-sm" onclick="resolveAlert('${a.id}','${a.severity}','${a.case_id || ""}')">Dismiss</button>
    </div>`;
  }).join("") : '<div class="empty">No problems detected 🎉</div>';
  panelCount("#watchtower-list", alerts.length, alerts.some((a) => a.severity === "crit"));
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
      const hay = ((c.clients?.first_name || "") + " " + (c.clients?.last_name || "") + " " + (c.lender || "") + " " + (c.product_name || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (pipelineView === "table") { renderPipelineTable(filtered); return; }
  $("#board").classList.remove("hidden");
  $("#board-hint").classList.remove("hidden");
  $("#stage-tabs").classList.add("hidden");
  $("#table-wrap").classList.add("hidden");
  const byStage = {};
  STAGES.forEach(([k]) => (byStage[k] = []));
  filtered.forEach((c) => byStage[c.stage]?.push(c));
  $("#board").innerHTML = STAGES.map(([k, label]) => `
    <div class="col" data-stage="${k}">
      <h4${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${label} <span>${byStage[k].length}</span></h4>
      ${byStage[k].map((c) => {
        const erc = c.erc_end_date && c.rate_end_date && c.erc_end_date > c.rate_end_date;
        return `<div class="card" draggable="true" data-id="${c.id}" onclick="openCase('${c.id}')">
          <div class="cn" style="display:flex;justify-content:space-between;align-items:center;gap:6px;"><span>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ") || "—")}</span>${c.assigned_to ? `<span class="chip" title="${esc(staffName(c.assigned_to))}">${initials(c.assigned_to)}</span>` : ""}</div>
          <div class="cd">${lenderIcon(c.lender)}${esc(c.lender || KINDS.find(x=>x[0]===c.case_kind)?.[1] || "")}${c.loan_amount ? " · " + fmtM(c.loan_amount) : ""}</div>
          <div class="flags">
            ${c.rate_end_date ? `<span class="badge ${c.rate_end_estimated ? "purple" : "blue"}">Rate ends ${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""}</span>` : ""}
            ${erc ? `<span class="badge red" title="${TIP_ERC}">ERC conflict</span>` : ""}
            ${c.retention_source_case_id ? '<span class="badge grey">🔁 retention</span>' : ""}
            ${["application","offer"].includes(c.stage) && (c.protection_status || "not_discussed") === "not_discussed" ? '<span class="badge amber">🛡 protection?</span>' : ""}
            ${c.submitted_at && !["completed","not_proceeding"].includes(c.stage) ? `<span class="badge grey" title="${TIP_SUB}">📤 sub ${fmtD(c.submitted_at)}</span>` : ""}
            ${c.fee_status === "paid" ? '<span class="badge green">Fee paid</span>' : c.fee_status === "requested" ? '<span class="badge amber">Fee requested</span>' : ""}
          </div>
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
/* Protection gate — block forward moves into Application+ while protection is unrecorded */
const stageIdx = (s) => STAGES.findIndex(([k]) => k === s);
function protectionGateBlocks(caseRow, newStage) {
  if ((settings.protection_gate ?? "on") !== "on") return false;
  if (newStage === "not_proceeding") return false;
  const from = stageIdx(caseRow.stage), to = stageIdx(newStage);
  if (to < stageIdx("application") || to <= from) return false;
  return (caseRow.protection_status || "not_discussed") === "not_discussed";
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
/* Move a case to a new stage. Shared by desktop drag-and-drop (the drop handler above)
   and the per-card "Move to stage" dropdown, which gives touch/mobile users — for whom
   HTML5 drag-and-drop does not fire — a working way to progress a case from the board. */
window.moveCaseToStage = async function (caseId, targetStage) {
  if (!caseId || !targetStage) return;
  const { data: cRow } = await db.from("cases").select("stage,protection_status,clients(first_name,last_name)").eq("id", caseId).single();
  if (cRow && cRow.stage === targetStage) return; // no-op (e.g. dropped back on the same column)
  if (cRow && protectionGateBlocks(cRow, targetStage)) {
    toast("🛡️ Record the protection conversation before submitting — set a protection status");
    loadPipeline(); // put the card back
    return;
  }
  if (targetStage === "completed" || targetStage === "not_proceeding") {
    const nm = (cRow && cRow.clients ? [cRow.clients.first_name, cRow.clients.last_name].filter(Boolean).join(" ") : "") || "this case";
    const msg = targetStage === "completed"
      ? `Move ${nm} to Completed? This will trigger completion emails and retention setup.`
      : `Move ${nm} to Not Proceeding? This hides the case from active views.`;
    if (!confirm(msg)) { loadPipeline(); return; } // abort — snap the card back
  }
  const { error } = await db.from("cases").update({ stage: targetStage }).eq("id", caseId);
  if (error) return toast("Error: " + error.message);
  toast("Moved to " + (STAGE_LABEL[targetStage] || targetStage));
  loadPipeline();
};
function renderPipelineTable(filtered) {
  $("#board").classList.add("hidden");
  $("#board-hint").classList.add("hidden");
  $("#stage-tabs").classList.remove("hidden");
  $("#table-wrap").classList.remove("hidden");
  const counts = {};
  STAGES.forEach(([k]) => (counts[k] = filtered.filter((c) => c.stage === k).length));
  $("#stage-tabs").innerHTML = [`<button class="stage-tab ${stageTab === "all" ? "active" : ""}" data-stage="all">All (${filtered.length})</button>`]
    .concat(STAGES.map(([k, l]) => `<button class="stage-tab ${stageTab === k ? "active" : ""}" data-stage="${k}"${k === "decision_in_principle" ? ` title="${TIP_DIP}"` : ""}>${l} (${counts[k]})</button>`)).join("");
  document.querySelectorAll(".stage-tab").forEach((b) => (b.onclick = () => { stageTab = b.dataset.stage; loadPipeline(); }));

  let rows = stageTab === "all" ? filtered : filtered.filter((c) => c.stage === stageTab);
  const val = (c, k) => {
    switch (k) {
      case "client": return [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ").toLowerCase();
      case "lender": return (c.lender || "").toLowerCase();
      case "rate_percent": return c.rate_percent ?? -1;
      case "broker_fee": return c.broker_fee ?? -1;
      case "assigned": return staffName(c.assigned_to).toLowerCase();
      default: return c[k] ?? "";
    }
  };
  rows = rows.slice().sort((a, b) => { const x = val(a, sortKey), y = val(b, sortKey); return (x < y ? -1 : x > y ? 1 : 0) * sortDir; });

  const cols = [["client", "Client"], ["stage", "Stage"], ["case_kind", "Type"], ["lender", "Lender"], ["rate_percent", "Rate"], ["rate_end_date", "Rate ends"], ["erc_end_date", "ERC ends"], ["broker_fee", "Fee"], ["fee_status", "Fee status"], ["protection_status", "Protection"], ["assigned", "Adviser"], ["updated_at", "Updated"]];
  $("#table-wrap").innerHTML = `<div class="panel" style="overflow-x:auto;">
    <div style="display:flex;justify-content:flex-end;margin-bottom:8px;"><button class="btn btn-sm" id="csv-btn">⬇ Download CSV</button></div>
    <table class="imp-table" id="pipe-table">
      <tr>${cols.map(([k, l]) => `<th data-k="${k}" style="cursor:pointer;"${k === "erc_end_date" ? ` title="${TIP_ERC}"` : ""}>${l}${sortKey === k ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr>
      ${rows.map((c) => `<tr onclick="openCase('${c.id}')" style="cursor:pointer;">
        <td><strong>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</strong></td>
        <td><span class="badge blue">${STAGE_LABEL[c.stage] || c.stage}</span></td>
        <td>${esc((KINDS.find((x) => x[0] === c.case_kind) || [])[1] || "")}</td>
        <td>${lenderIcon(c.lender)}${esc(c.lender || "")}</td>
        <td>${c.rate_percent != null ? c.rate_percent + "%" : ""}</td>
        <td>${c.rate_end_date ? fmtD(c.rate_end_date) + (c.rate_end_estimated ? " " + APPROX : "") : ""}</td>
        <td>${c.erc_end_date ? fmtD(c.erc_end_date) : ""}</td>
        <td>${c.broker_fee ? fmtM(c.broker_fee) : ""}</td>
        <td>${esc((c.fee_status || "").replace(/_/g, " "))}</td>
        <td>${esc((c.protection_status || "").replace(/_/g, " "))}</td>
        <td>${c.assigned_to ? esc(staffName(c.assigned_to)) : ""}</td>
        <td>${fmtD(c.updated_at)}</td>
      </tr>`).join("")}
    </table></div>`;
  document.querySelectorAll("#pipe-table th").forEach((th) => (th.onclick = () => {
    const k = th.dataset.k;
    if (sortKey === k) sortDir *= -1; else { sortKey = k; sortDir = 1; }
    loadPipeline();
  }));
  $("#csv-btn").onclick = () => exportCsv(rows);
}
function exportCsv(rows) {
  const q2 = (v) => {
    let s = String(v ?? "");
    // Neutralise spreadsheet formula injection (=, +, -, @, tab, CR at start)
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Client", "Stage", "Type", "Lender", "Rate %", "Rate end", "Rate end estimated", "ERC end", "Broker fee", "Fee status", "Protection", "Adviser", "Updated"];
  const lines = [head.map(q2).join(",")].concat(rows.map((c) => [
    [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "),
    STAGE_LABEL[c.stage] || c.stage, (KINDS.find((x) => x[0] === c.case_kind) || [])[1] || c.case_kind, c.lender || "", c.rate_percent ?? "", c.rate_end_date || "",
    c.rate_end_estimated ? "yes" : "", c.erc_end_date || "", c.broker_fee ?? "",
    c.fee_status || "", c.protection_status || "", c.assigned_to ? staffName(c.assigned_to) : "",
    (c.updated_at || "").slice(0, 10),
  ].map(q2).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `pipeline-${stageTab}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
$("#report-month").addEventListener("change", () => loadReports());
$("#view-toggle").addEventListener("click", () => {
  pipelineView = pipelineView === "board" ? "table" : "board";
  $("#view-toggle").textContent = pipelineView === "board" ? "☰ Table view" : "⊞ Board view";
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
async function loadProtectionPage() {
  const { data, error } = await db.rpc("get_protection_pipeline", { p_scope: protScope });
  if (error) {
    $("#prot-table").innerHTML = `<div class="empty">Protection pipeline unavailable — ${esc(error.message)}</div>`;
    return;
  }
  const rows = (Array.isArray(data) ? data : []).filter((r) => {
    if (protFilter === "live") return r.live;
    if (protFilter === "completed") return !r.live;
    if (protFilter === "quoted") return r.protection_status === "quoted";
    return true;
  });
  const estTotal = rows.reduce((s, r) => s + Number(r.est_commission || 0), 0);
  $("#prot-kpi-count").textContent = rows.length;
  $("#prot-kpi-comm").textContent = fmtM(estTotal);
  $("#prot-kpi-quoted").textContent = rows.filter((r) => r.protection_status === "quoted").length;
  $("#prot-table").innerHTML = rows.length ? `<div class="panel prot-table-wrap">
    <table class="imp-table" id="prot-list-table">
      <tr><th>#</th><th>Client</th><th>Case</th><th>Loan</th><th>Status</th><th>Est. £</th><th>Adviser</th><th>Actions</th></tr>
      ${rows.map((r, i) => {
        const kind = (KINDS.find((x) => x[0] === r.case_kind) || [])[1] || "";
        const p = PROT_BADGE[r.protection_status] || PROT_BADGE.not_discussed;
        const gi = ["purchase", "first_time_buyer"].includes(r.case_kind) ? (GI_BADGE[r.gi_status] || GI_BADGE.not_discussed) : null;
        return `<tr>
        <td style="color:var(--muted);">${i + 1}</td>
        <td><span class="prot-client" onclick="openClient('${r.client_id}')">${esc(r.client_name)}</span></td>
        <td><span class="badge blue">${STAGE_LABEL[r.stage] || esc(r.stage)}</span> ${esc(kind)}${r.lender ? " · " : " "}${lenderIcon(r.lender)}${esc(r.lender || "")}</td>
        <td>${fmtM(r.loan_amount)}</td>
        <td><span class="badge ${p[0]}">${p[1]}</span>${gi ? ` <span class="badge ${gi[0]}" title="${TIP_GI}">${gi[1]}</span>` : ""}</td>
        <td class="prot-est">${fmtM(r.est_commission)}</td>
        <td>${r.owner ? `<span class="chip" title="${esc(staffName(r.owner))}">${initials(r.owner)}</span>` : ""}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="openCase('${r.case_id}')">Open</button>
          <select class="prot-status-set" onchange="setProtStatus('${r.case_id}', this.value)" title="Set protection status">
            <option value="">Set status…</option>
            ${[["discussed", "Discussed"], ["quoted", "Quoted"], ["policy_taken", "Policy taken"], ["declined", "Declined"]].map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>
          ${gi ? `<select class="prot-status-set" onchange="setGiStatus('${r.case_id}', this.value)" title="Set GI status">
            <option value="">Set GI…</option>
            ${[["quoted", "GI quoted"], ["policy_taken", "GI taken"], ["declined", "GI declined"], ["not_applicable", "GI n/a"]].map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}
          </select>` : ""}
          <button class="btn btn-sm" onclick="protCallTask('${r.case_id}')">Task</button>
          ${r.has_email ? `<button class="btn btn-sm" onclick="protQueueEmail('${r.case_id}')">Email</button>` : '<span class="badge grey">no email</span>'}
        </td>
      </tr>`;
      }).join("")}
    </table></div>` : '<div class="empty">No protection or GI opportunities in this view — nice clean book. 🛡️</div>';
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
window.protQueueEmail = async function (caseId) {
  const btn = (typeof event !== "undefined" && event && (event.currentTarget || event.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; } // guard against double-click double-insert
  try {
    const { data: c } = await db.from("cases").select("*").eq("id", caseId).single();
    if (!c) return toast("Could not load case");
    const { data: cl } = await db.from("clients").select("email").eq("id", c.client_id).single();
    if (!cl?.email) return toast("This client has no email address — add one first.");
    if (!confirm("Queue the protection intro email? Ensure the template has principal approval.")) return;
    const { error } = await db.from("email_queue").insert({ case_id: caseId, client_id: c.client_id, email_type: "protection_offer", to_email: cl.email });
    if (error) return toast("Error: " + error.message);
    const res = await runAutomation(true);
    toast(res && res.sent > 0 ? "Email sent ✓" : "Email queued — check Emails tab");
  } finally {
    if (btn) btn.disabled = false;
  }
};
window.factFind = async function (caseId, clientId) {
  let { data: ff } = await db.from("fact_finds").select("*").eq("case_id", caseId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!ff) {
    const ins = await db.from("fact_finds").insert({ case_id: caseId, client_id: clientId, created_by: (ME && ME.id) || null }).select("*").single();
    if (ins.error) return toast("Error: " + ins.error.message);
    ff = ins.data;
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
    ${hasData ? `<div style="margin-top:16px;"><h3 style="font-size:14px;">Submitted responses</h3>${renderFactFindData(ff.data)}</div>`
              : '<p class="panel-sub" style="margin-top:16px;">Responses will appear here once the client submits.</p>'}
    <div class="modal-actions"><div></div><div class="right"><button class="btn" id="ff-back">Back to case</button></div></div>`;
  openModal();
  $("#ff-copy").onclick = () => { const el = $("#ff-link"); el.select(); try { document.execCommand("copy"); } catch (e) {} if (navigator.clipboard) navigator.clipboard.writeText(el.value); toast("Link copied"); };
  $("#ff-back").onclick = () => openCase(caseId);
  $("#ff-refresh").onclick = () => factFind(caseId, clientId);
  $("#ff-new").onclick = async () => { if (!confirm("Start a fresh blank fact-find? The current link stops being the active one.")) return; await db.from("fact_finds").insert({ case_id: caseId, client_id: clientId, created_by: (ME && ME.id) || null }); factFind(caseId, clientId); };
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
function prettyFF(k) {
  const pre = { a1: "You", a2: "2nd applicant", m: "Mortgage", c: "Commitments", p: "Protection" }[k.split("_")[0]];
  let label = k.replace(/^[a-z0-9]+_/, "").replace(/_/g, " ");
  label = label.charAt(0).toUpperCase() + label.slice(1);
  return pre ? `${pre}: ${label}` : label;
}
function setProtScope(s) {
  protScope = s;
  $("#prot-scope-mine").classList.toggle("scope-active", s === "mine");
  $("#prot-scope-all").classList.toggle("scope-active", s === "all");
  loadProtectionPage();
}
$("#prot-scope-mine").addEventListener("click", () => setProtScope("mine"));
$("#prot-scope-all").addEventListener("click", () => setProtScope("all"));
$("#prot-filter").addEventListener("change", () => { protFilter = $("#prot-filter").value; loadProtectionPage(); });
// Clicking the "Quoted, awaiting decision" tile filters the table to those rows (QW15).
$("#prot-tile-quoted").addEventListener("click", () => {
  protFilter = "quoted";
  $("#prot-filter").value = "quoted";
  loadProtectionPage();
});

/* ---------- Case modal ---------- */
window.openCase = async function (id) {
  let c = { stage: "enquiry", case_kind: "remortgage", rate_type: "fixed" };
  let notes = [], tasks = [];
  let openedUpdatedAt = null;
  if (id) {
    const [{ data: cs }, { data: ns }, { data: ts }] = await Promise.all([
      db.from("cases").select("*").eq("id", id).single(),
      db.from("case_notes").select("*").eq("case_id", id).order("created_at", { ascending: false }),
      db.from("case_tasks").select("*").eq("case_id", id).order("due_date"),
    ]);
    if (!cs) return toast("Case not found — it may have been deleted or you don't have access");
    c = cs; notes = ns || []; tasks = ts || [];
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

  $("#modal").innerHTML = `
    <h3>${id ? "Case details" : "New case"}</h3>
    ${caseClient && (caseClient.phone || caseClient.email) ? `<p class="panel-sub" style="margin-top:-8px;display:flex;gap:16px;flex-wrap:wrap;">${caseClient.phone ? "📞 " + telLink(caseClient.phone) : ""}${caseClient.email ? "✉️ " + mailLink(caseClient.email) : ""}</p>` : ""}
    ${c.retention_source_case_id ? `<p class="panel-sub" style="margin-top:-8px;">🔁 Retention opportunity — auto-created from a completed case. <span class="t" style="cursor:pointer;text-decoration:underline;" onclick="openCase('${c.retention_source_case_id}')">View original case</span></p>` : ""}
    ${c.nps_score != null ? `<p class="panel-sub" style="margin-top:-8px;">Client review score: <strong style="color:${c.nps_score >= 9 ? "var(--green)" : c.nps_score >= 7 ? "var(--amber)" : "var(--red)"};">${c.nps_score}/10</strong></p>` : ""}
    <form id="case-form" class="form-grid" data-case-id="${id || ""}">
      <label class="full">Client
        <select name="client_id" required><option value="">— select client —</option>${clientOpts}</select>
      </label>
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
      <label>Term (years)<input name="term_years" type="number" value="${c.term_years ?? ""}"></label>
      <label>Submitted date<input name="submitted_at" type="date" value="${c.submitted_at ?? ""}"></label>
      <label>Proc fee (£)<input name="proc_fee" type="number" step="any" value="${c.proc_fee ?? ""}"></label>
      <label>Sols fee (£)<input name="sols_fee" type="number" step="any" value="${c.sols_fee ?? ""}"></label>
      <label>Broker fee (£)<input name="broker_fee" type="number" step="any" value="${c.broker_fee ?? ""}"></label>
      <label>Fee status<select name="fee_status">${["not_requested", "requested", "paid", "waived"].map((f) => `<option value="${f}" ${f === c.fee_status ? "selected" : ""}>${f.replace("_", " ")}</option>`).join("")}</select></label>
      <label>Protection<select name="protection_status">${[["not_discussed","Not discussed"],["discussed","Discussed"],["quoted","Quoted"],["policy_taken","Policy taken"],["declined","Client declined"]].map(([k,l]) => `<option value="${k}" ${k === (c.protection_status || "not_discussed") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Protection commission (£)<input name="protection_commission" type="number" step="any" value="${c.protection_commission ?? ""}"></label>
      <label id="gi-status-label" ${["purchase","first_time_buyer"].includes(c.case_kind) ? "" : 'class="hidden"'}>GI / buildings insurance<select name="gi_status">${[["not_discussed","Not discussed"],["quoted","Quoted"],["policy_taken","Policy taken"],["declined","Declined"],["not_applicable","Not applicable"]].map(([k,l]) => `<option value="${k}" ${k === (c.gi_status || "not_discussed") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Lead source<input name="lead_source" value="${esc(c.lead_source)}" placeholder="e.g. Google, referral, repeat"></label>
      <label>Introducer<select name="introducer_id"><option value="">— none —</option>${introOpts}</select></label>
      <label>Assigned to<select name="assigned_to"><option value="">— unassigned —</option>${TEAM.map((p) => `<option value="${p.id}" ${p.id === c.assigned_to ? "selected" : ""}>${esc(staffName(p.id))}</option>`).join("")}</select></label>
    </form>
    ${id ? `
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
    <div style="margin-top:14px;">
      <h3 style="font-size:14px;">Tasks</h3>
      <div style="display:flex;gap:8px;margin:8px 0;">
        <input id="new-task" placeholder="Add a task…" style="flex:1;">
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
          ${t.done_at ? "" : `<button class="btn btn-sm" aria-label="Mark task done" title="Mark task done" onclick="doneTaskInCase('${t.id}','${id}')">✓</button>`}
        </div>`).join("") || '<div class="empty">No tasks.</div>'}</div>
    </div>
    <div style="margin-top:14px;">
      <h3 style="font-size:14px;">Notes</h3>
      <div style="display:flex;gap:8px;margin:8px 0;">
        <input id="new-note" placeholder="Add a note…" style="flex:1;">
        <button class="btn btn-sm" id="add-note-btn">Add</button>
      </div>
      <div id="notes-list">${notes.map((n) => `<div class="note">${esc(n.body)}<div class="nd">${new Date(n.created_at).toLocaleString("en-GB")}</div></div>`).join("") || '<div class="empty">No notes yet.</div>'}</div>
    </div>` : ""}
    <div class="modal-actions">
      <div>${id ? '<button class="btn btn-ghost btn-danger" id="del-case-btn">Delete case</button>' : ""}</div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();

  const kindSel = $("#case-form").elements.case_kind;
  kindSel.onchange = () => $("#gi-status-label").classList.toggle("hidden", !["purchase", "first_time_buyer"].includes(kindSel.value));
  $("#modal-cancel").onclick = closeModal;
  $("#modal-save").onclick = async () => {
    const f = new FormData($("#case-form"));
    const row = {};
    for (const [k, v] of f.entries()) row[k] = v === "" ? null : v;
    row.rate_end_estimated = f.get("rate_end_estimated") === "on";
    if (!row.client_id) return toast("Please choose a client");
    if (id && row.stage !== c.stage && protectionGateBlocks({ stage: c.stage, protection_status: row.protection_status }, row.stage)) {
      toast("🛡️ Record the protection conversation before submitting — set a protection status");
      const protSel = $("#case-form").elements.protection_status;
      if (protSel) { protSel.style.borderColor = "var(--red)"; protSel.style.boxShadow = "0 0 0 3px rgba(192,57,43,.18)"; protSel.focus(); }
      return;
    }
    ["loan_amount", "property_value", "rate_percent", "term_years", "broker_fee", "proc_fee", "sols_fee", "protection_commission"].forEach((k) => { if (row[k] != null) row[k] = Number(row[k]); });
    if (id) {
      // Optimistic concurrency: only update if the row hasn't changed since we opened it.
      const { data: updated, error } = await db.from("cases").update(row).eq("id", id).eq("updated_at", openedUpdatedAt).select();
      if (error) return toast("Error: " + error.message);
      if (!updated || updated.length === 0) {
        toast("This case was changed by someone else since you opened it — reload before saving");
        loadPipeline(); loadDashboard();
        openCase(id); // reload the case with fresh data
        return;
      }
      closeModal(); toast("Case saved");
      loadPipeline(); loadDashboard();
    } else {
      const { error } = await db.from("cases").insert(row);
      if (error) return toast("Error: " + error.message);
      closeModal(); toast("Case saved");
      loadPipeline(); loadDashboard();
    }
  };
  if (id) {
    $("#del-case-btn").onclick = async () => {
      const extra = c.stage === "completed" ? "⚠ This case is COMPLETED — deleting removes its fee/commission history from your records." : null;
      if (!confirmHardDelete("Delete this case?", extra)) return;
      await db.from("cases").delete().eq("id", id);
      closeModal(); toast("Case deleted"); loadPipeline(); loadDashboard();
    };
    const submitNote = async () => {
      const input = $("#new-note");
      const body = input.value.trim();
      if (!body) return;
      const { data: { user } } = await db.auth.getUser();
      const { error } = await db.from("case_notes").insert({ case_id: id, body, created_by: user.id });
      if (error) return toast("Error: " + error.message);
      // In-place append (no full modal re-render / scroll reset): prepend to match the newest-first load order.
      const list = $("#notes-list");
      const empty = list.querySelector(".empty");
      if (empty) empty.remove();
      const row = document.createElement("div");
      row.className = "note";
      row.innerHTML = `${esc(body)}<div class="nd">${new Date().toLocaleString("en-GB")}</div>`;
      list.insertBefore(row, list.firstChild);
      input.value = "";
      input.focus();
    };
    $("#add-note-btn").onclick = submitNote;
    $("#new-note").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitNote(); } });
    $("#act-fee").onclick = (e) => queueEmail(id, c.client_id, "fee_request", c, e);
    $("#act-review").onclick = (e) => queueEmail(id, c.client_id, "review_request", c, e);
    $("#act-reminder").onclick = (e) => queueEmail(id, c.client_id, "rate_end_reminder", c, e);
    $("#act-paid").onclick = async () => {
      await db.from("cases").update({ fee_status: "paid", fee_paid_at: new Date().toISOString() }).eq("id", id);
      toast("Fee marked as paid"); openCase(id);
    };
    const submitTask = async () => {
      const input = $("#new-task");
      const title = input.value.trim();
      if (!title) return;
      const due = $("#new-task-due").value || null;
      const { data: { user } } = await db.auth.getUser();
      const { data: inserted, error } = await db.from("case_tasks")
        .insert({ case_id: id, title, due_date: due, created_by: user.id, assigned_to: user.id })
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
        + `<button class="btn btn-sm" aria-label="Mark task done" title="Mark task done" onclick="doneTaskInCase('${tid}','${id}')">✓</button>`;
      list.appendChild(row);
      input.value = "";
      $("#new-task-due").value = "";
      input.focus();
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
};

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

  // Store the document against the case
  const path = `${caseId}/${Date.now()}-${file.name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const { error: upErr } = await db.storage.from("offers").upload(path, file, { contentType: "application/pdf", upsert: true });
  if (!upErr) await db.from("cases").update({ offer_doc_path: path }).eq("id", caseId);
  else toast("Offer read, but saving the PDF failed — the details below are filled in, but please re-upload to store the document.");

  // Apply extracted fields to the open form for review — but only if the modal still
  // shows the case we parsed for. After the ~20s await the adviser may have opened a
  // different case; writing offer fields into the wrong form could persist bad data.
  const form = $("#case-form");
  if (!form || form.dataset.caseId !== String(caseId)) {
    return toast("Offer read ✓ — reopen this case to fill in the details (the case view changed while reading).");
  }
  const setVal = (name, v) => { if (v != null && v !== "" && form.elements[name]) form.elements[name].value = v; };
  setVal("lender", offer.lender);
  setVal("product_name", offer.product_name);
  setVal("rate_percent", offer.rate_percent);
  setVal("rate_type", offer.rate_type);
  setVal("rate_end_date", offer.rate_end_date);
  setVal("erc_end_date", offer.erc_end_date);
  setVal("offer_expiry_date", offer.offer_expiry_date);
  setVal("loan_amount", offer.loan_amount);
  setVal("property_value", offer.property_value);
  setVal("term_years", offer.term_years);
  if (offer.rate_end_date && form.elements.rate_end_estimated) form.elements.rate_end_estimated.checked = false;
  const extras = [];
  if (offer.erc_summary) extras.push("ERC: " + offer.erc_summary);
  if (offer.offer_expiry_date) extras.push("Offer expires: " + fmtD(offer.offer_expiry_date));
  if (offer.confidence_notes) extras.push("⚠ " + offer.confidence_notes);
  if (extras.length) {
    const { data: { user } } = await db.auth.getUser();
    await db.from("case_notes").insert({ case_id: caseId, body: "From mortgage offer (AI-read): " + extras.join(" | "), created_by: user.id });
  }
  toast("Offer read ✓ — details filled in below. Check them, then press Save.");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btnLabel; }
    // Re-enable and clear the picker so the same file can be chosen again if needed.
    if (fileInput) { fileInput.disabled = false; fileInput.value = ""; }
  }
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
    if (type === "fee_request" && (!settings.bank_sort_code || !settings.bank_account_number)) return toast("Add your bank details in Settings first.");
    if (type === "review_request" && !(settings.google_review_link || settings.review_platform_link)) return toast("Add your review link in Settings first.");
    if (type === "rate_end_reminder" && !c.rate_end_date) return toast("Set the rate end date on the case first.");
    if (!confirm(`Send ${EMAIL_LABEL[type].toLowerCase()} email to ${cl.email}?`)) return;
    const { error } = await db.from("email_queue").insert({ case_id: caseId, client_id: clientId, email_type: type, to_email: cl.email });
    if (error) return toast("Error: " + error.message);
    if (type === "rate_end_reminder") await db.from("cases").update({ rate_reminder_queued_at: new Date().toISOString() }).eq("id", caseId);
    if (type === "review_request") await db.from("cases").update({ review_requested_at: new Date().toISOString() }).eq("id", caseId);
    const res = await runAutomation(true);
    toast(res && res.sent > 0 ? "Email sent ✓" : "Email queued — check Emails tab (is your Resend key set up?)");
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

window.openClient = async function (id) {
  let c = {};
  let cases = [];
  if (id) {
    const [{ data: cl, error: clErr }, { data: cs }] = await Promise.all([
      db.from("clients").select("*").eq("id", id).single(),
      db.from("cases").select("*").eq("client_id", id).order("created_at", { ascending: false }),
    ]);
    if (clErr || !cl) return toast("Client not found — it may have been deleted or you don't have access.");
    c = cl; cases = cs || [];
  }
  $("#modal").innerHTML = `
    <h3>${id ? "Client details" : "New client"}</h3>
    ${id && (c.phone || c.email) ? `<p class="panel-sub" style="margin-top:-8px;display:flex;gap:16px;flex-wrap:wrap;">${c.phone ? "📞 " + telLink(c.phone) : ""}${c.email ? "✉️ " + mailLink(c.email) : ""}</p>` : ""}
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
    ${id ? `<div style="margin-top:14px;"><h3 style="font-size:14px;">Cases</h3>
      ${cases.map((x) => `<div class="row-item"><div class="row-main">
        <div class="t" onclick="closeModal();openCase('${x.id}')">${esc(x.lender || KINDS.find(k=>k[0]===x.case_kind)?.[1] || "Case")} ${x.loan_amount ? "· " + fmtM(x.loan_amount) : ""}</div>
        <div class="s">Started ${fmtD(x.created_at)}${x.rate_end_date ? " · rate ends " + fmtD(x.rate_end_date) : ""}</div></div>
        <span class="badge blue">${STAGE_LABEL[x.stage] || x.stage}</span></div>`).join("") || '<div class="empty">No cases yet.</div>'}
    </div>` : ""}
    <div class="modal-actions">
      <div>${id ? '<button class="btn btn-ghost btn-danger" id="del-client-btn">Delete client</button>' : ""}</div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  $("#modal-cancel").onclick = closeModal;
  $("#modal-save").onclick = async () => {
    const f = new FormData($("#client-form"));
    const row = {};
    for (const [k, v] of f.entries()) row[k] = v.trim() || null;
    // Real booleans / typed date for the comms fields (the loop above stringifies everything)
    row.sms_opt_out = f.get("sms_opt_out") === "1";
    row.marketing_opt_out = f.get("marketing_opt_out") === "1";
    row.date_of_birth = (f.get("date_of_birth") || "").trim() || null;
    if (!row.first_name || !row.last_name) return toast("First and last name are required");
    const q = id ? db.from("clients").update(row).eq("id", id) : db.from("clients").insert(row);
    const { error } = await q;
    if (error) return toast("Error: " + error.message);
    closeModal(); toast("Client saved"); loadClients();
    // If the client was opened from Data health (that page sits behind the modal), refresh its
    // lists/KPIs so a just-fixed row (e.g. missing email) doesn't linger stale until manual Refresh.
    if ($("#page-data") && !$("#page-data").classList.contains("hidden")) loadDataHealth();
  };
  if (id) $("#del-client-btn").onclick = async () => {
    const completed = cases.filter((x) => x.stage === "completed").length;
    const extra = completed
      ? `⚠ This client has ${completed} COMPLETED case${completed === 1 ? "" : "s"} with regulated records that will be permanently destroyed.`
      : null;
    if (!confirmHardDelete("Delete this client and all their cases?", extra)) return;
    await db.from("clients").delete().eq("id", id);
    closeModal(); toast("Client deleted"); loadClients();
  };
};

/* ---------- Emails ---------- */
async function loadEmails() {
  const { data: emails, error } = await db.from("email_queue")
    .select("*, clients(first_name,last_name)")
    .order("created_at", { ascending: false }).limit(100);
  if (error) { renderLoadError("#email-list", error, loadEmails); return; }
  const badge = { queued: "amber", sent: "green", failed: "red", cancelled: "grey" };
  $("#email-list").innerHTML = `<div class="panel">` + ((emails || []).length ? emails.map((e) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${EMAIL_LABEL[e.email_type]} — ${esc(e.clients ? e.clients.first_name + " " + e.clients.last_name : e.to_email || "")}</div>
        <div class="s">${esc(e.to_email || "")} · ${e.sent_at ? "sent " + new Date(e.sent_at).toLocaleString("en-GB") : "created " + new Date(e.created_at).toLocaleString("en-GB")}${e.error ? " · " + esc(e.error) : ""}</div>
      </div>
      <span class="badge ${badge[e.status]}">${e.status}</span>
    </div>`).join("") : '<div class="empty">No emails yet. They\'ll appear here once automation runs or you trigger one from a case.</div>') + `</div>`;

  const { data: sms, error: smsErr } = await db.from("sms_queue")
    .select("*, cases(*), clients(*)")
    .order("created_at", { ascending: false }).limit(100);
  if (smsErr) { renderLoadError("#sms-list", smsErr, loadEmails); return; }
  const smsBadge = { queued: "amber", sending: "blue", sent: "green", failed: "red", cancelled: "grey" };
  $("#sms-list").innerHTML = (sms || []).length ? sms.map((s) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(smsTypeLabel(s.sms_type))} — ${esc(s.clients ? [s.clients.first_name, s.clients.last_name].filter(Boolean).join(" ") : s.to_phone || "")}</div>
        <div class="s">${esc(s.to_phone || "")} · ${s.sent_at ? "sent " + new Date(s.sent_at).toLocaleString("en-GB") : "created " + new Date(s.created_at).toLocaleString("en-GB")}${s.error ? " · " + esc(s.error) : ""}</div>
      </div>
      <span class="badge ${smsBadge[s.status] || "grey"}">${esc(s.status)}</span>
    </div>`).join("") : '<div class="empty">No SMS yet. They\'ll appear here once SMS automation runs or you send one.</div>';
}
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
async function runAutomation(silent) {
  const { data: { session } } = await db.auth.getSession();
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/process-emails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const j = await r.json();
    if (!silent) toast(j.warning ? j.warning : `Done — ${j.sent} sent, ${j.failed} failed, ${j.queued ? (j.queued.rate_reminders_queued + j.queued.review_requests_queued) : 0} newly queued`);
    loadEmails();
    return j;
  } catch (e) {
    if (!silent) toast("Automation error: " + e.message);
    return null;
  }
}
$("#run-now-btn").addEventListener("click", () => runAutomation(false));

/* ---------- Bulk import (AI) ---------- */
let importRows = [];

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
    $("#import-status").textContent = `${importRows.length} records found.`;
    renderImportPreview();
  } catch (e) {
    $("#import-status").textContent = "";
    toast("Error: " + e.message);
  } finally {
    $("#analyse-btn").disabled = false;
  }
});

function renderImportPreview() {
  if (!importRows.length) { $("#import-preview").innerHTML = ""; return; }
  $("#import-preview").innerHTML = `
    <div class="panel">
      <h3>Review before saving</h3>
      <p class="panel-sub">Untick anything that shouldn't be imported. Estimated rate-end dates are marked ≈ and stay flagged until you confirm them.</p>
      <div style="overflow-x:auto;">
      <table class="imp-table">
        <tr><th><input type="checkbox" id="imp-all" checked></th><th>Client</th><th>Email</th><th>Stage</th><th>Lender</th><th>Rate</th><th>Rate ends</th><th>Completed</th><th>Fee</th></tr>
        ${importRows.map((r, i) => `
        <tr>
          <td><input type="checkbox" class="imp-row" data-i="${i}" checked></td>
          <td>${esc(r.client_name)}</td>
          <td>${esc(r.email || "")}</td>
          <td>${r.stage ? `<span class="badge blue">${esc(r.stage)}</span>` : '<span class="badge grey">contact only</span>'}</td>
          <td>${esc(r.lender || "")}</td>
          <td>${r.rate_percent != null ? r.rate_percent + "%" : ""}</td>
          <td>${r.rate_end_date ? fmtD(r.rate_end_date) + (r.rate_end_estimated ? ` <span class="badge purple" title="${TIP_APPROX}">≈</span>` : "") : ""}</td>
          <td>${r.completed_date ? fmtD(r.completed_date) : ""}</td>
          <td>${r.broker_fee ? fmtM(r.broker_fee) : ""}</td>
        </tr>`).join("")}
      </table>
      </div>
      <div style="margin-top:14px;">
        <button class="btn btn-primary" id="import-save-btn">Import selected</button>
      </div>
    </div>`;
  $("#imp-all").onchange = (e) => document.querySelectorAll(".imp-row").forEach((c) => (c.checked = e.target.checked));
  $("#import-save-btn").onclick = runImport;
}

async function runImport() {
  const selectedEls = [...document.querySelectorAll(".imp-row:checked")];
  const selected = selectedEls.map((c) => importRows[Number(c.dataset.i)]);
  if (!selected.length) return toast("Nothing selected");
  $("#import-save-btn").disabled = true;
  $("#import-status").textContent = "Saving…";
  const { data: existing } = await db.from("clients").select("id,first_name,last_name,email,phone");
  // Canonical name key: lowercase, strip punctuation, collapse whitespace, sort tokens
  // so "Smith John" and "John Smith" collide regardless of first/last order.
  const nameKey = (s) => (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  const byName = {}, byEmail = {};
  (existing || []).forEach((c) => {
    const nk = nameKey((c.last_name || "") + " " + (c.first_name || ""));
    if (nk) byName[nk] = c;
    if (c.email) byEmail[c.email.trim().toLowerCase()] = c;
  });
  let nClients = 0, nCases = 0, nUpdated = 0;
  const rowErrors = [];

  for (let i = 0; i < selected.length; i++) {
    const r = selected[i];
    try {
      const nk = nameKey(r.client_name);
      const email = (r.email || "").trim().toLowerCase();
      if (!nk && !email) continue;
      let client = (email && byEmail[email]) || byName[nk];
      if (!client) {
        const { data, error } = await db.from("clients")
          .insert({ first_name: "", last_name: (r.client_name || "").trim(), email: r.email || null, phone: r.phone || null })
          .select().single();
        if (error) throw error;
        client = data; nClients++;
        if (nk) byName[nk] = client;
        if (email) byEmail[email] = client;
      } else if ((r.email && !client.email) || (r.phone && !client.phone)) {
        await db.from("clients").update({
          email: client.email || r.email || null,
          phone: client.phone || r.phone || null,
        }).eq("id", client.id);
        // keep the local index fresh so later rows dedupe against the newly-set email
        if (r.email && !client.email) { client.email = r.email; byEmail[email] = client; }
        if (r.phone && !client.phone) client.phone = r.phone;
        nUpdated++;
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
          rate_end_date: r.rate_end_date || null,
          rate_end_estimated: !!r.rate_end_estimated,
          erc_end_date: r.erc_end_date || null,
          loan_amount: r.loan_amount ?? null,
          property_value: r.property_value ?? null,
          broker_fee: r.broker_fee ?? null,
          completed_at: r.completed_date ? new Date(r.completed_date).toISOString() : null,
        }).select("id").single();
        if (error) throw error;
        await db.from("case_notes").insert({ case_id: nc.id, body: "AI bulk import" + (r.note ? " | " + r.note : "") });
        nCases++;
      }
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
  toast(`Imported: ${nClients} new clients, ${nCases} cases, ${nUpdated} contact updates${errs ? `, ${errs} failed` : ""}`);
  if (errs) {
    // Surface exactly which rows failed and why, so nothing is silently dropped.
    const errHtml = `<div class="panel"><h3>${errs} row${errs === 1 ? "" : "s"} could not be imported</h3>
      <table class="imp-table"><tr><th>Row</th><th>Name</th><th>Error</th></tr>
      ${rowErrors.map((e) => `<tr><td>${e.row}</td><td>${esc(e.name)}</td><td>${esc(e.error)}</td></tr>`).join("")}
      </table></div>`;
    $("#import-preview").insertAdjacentHTML("beforeend", errHtml);
  } else {
    importRows = []; $("#import-preview").innerHTML = ""; $("#import-text").value = "";
  }
}

/* ---------- Website leads ---------- */
async function loadLeads() {
  const { data: leads } = await db.from("leads").select("*").eq("status", "new").order("created_at");
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
      <button class="btn btn-sm btn-primary" onclick="acceptLead('${l.id}', event)">Accept</button>
      <button class="btn btn-sm btn-danger" aria-label="Discard lead" title="Discard lead" onclick="discardLead('${l.id}')">✕</button>
    </div>`).join("") : '<div class="empty">No new leads. Website enquiries appear here the moment they\'re sent.</div>';
  panelCount("#leads-list", n, true);
}
window.acceptLead = async function (id, ev) {
  const btn = (ev && (ev.currentTarget || ev.target)) || null;
  if (btn) { if (btn.disabled) return; btn.disabled = true; } // guard against double-click
  // Atomically claim the lead: only converts if it's still 'new', so a fast double-click
  // or a second adviser accepting the same lead can't create duplicate clients/cases/emails.
  const { data: claimed, error: claimErr } = await db.from("leads")
    .update({ status: "converted" }).eq("id", id).eq("status", "new").select();
  if (claimErr) { if (btn) btn.disabled = false; return toast("Error: " + claimErr.message); }
  if (!claimed || !claimed.length) { if (btn) btn.disabled = false; return toast("This lead has already been accepted."); }
  const l = claimed[0];
  const kindMap = { "first-time-buyer": "first_time_buyer", "remortgage": "remortgage", "home-mover": "purchase", "buy-to-let": "buy_to_let" };

  // Split the lead's name into first/last (previously the whole name went into last_name with a blank
  // first_name, breaking client sort and every "Hi {first_name}" template).
  const rawName = (l.name || "").trim().replace(/\s+/g, " ");
  let firstName = "", lastName = rawName;
  if (rawName) {
    if (/\s(&|and)\s/i.test(rawName) || rawName.includes("&")) {
      // Joint / couple enquiry — don't guess; ask how to file it.
      const firstTok = rawName.split(" ")[0];
      if (confirm(`This looks like a joint enquiry: “${rawName}”.\n\nOK = file first name “${firstTok}” and keep the full name on the surname line.\nCancel = keep the whole name together on the surname line (blank first name).`)) {
        firstName = firstTok; lastName = rawName;
      } else {
        firstName = ""; lastName = rawName;
      }
    } else {
      const parts = rawName.split(" ");
      if (parts.length > 1) { firstName = parts.shift(); lastName = parts.join(" "); }
      // single token → keep it as the surname so last_name is never blank
    }
  }

  // Before inserting, look for an existing client (same email, or same normalised phone when there's no
  // email) and offer to attach the case to them rather than creating a duplicate.
  let client = null, createdClient = false, existing = null;
  if (l.email) {
    const { data: byEmail } = await db.from("clients").select("id,first_name,last_name,email,phone").ilike("email", l.email).limit(1);
    existing = byEmail && byEmail[0];
  } else if (normPhone(l.phone)) {
    const target = normPhone(l.phone);
    const { data: all } = await db.from("clients").select("id,first_name,last_name,email,phone");
    existing = (all || []).find((cl) => cl.phone && normPhone(cl.phone) === target) || null;
  }
  if (existing) {
    const who = [existing.first_name, existing.last_name].filter(Boolean).join(" ") || existing.email || existing.phone || "this client";
    if (confirm(`A client already exists: ${who}${existing.email ? " (" + existing.email + ")" : ""}.\n\nAttach this new case to the existing client instead of creating a duplicate?`)) {
      client = existing;
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
    assigned_to: (ME && ME.id) || null,
  }).select("id").single();
  if (error) {
    // Undo the partial accept: remove the just-created client (never an existing one we attached to), then release the lead.
    if (createdClient) await db.from("clients").delete().eq("id", client.id);
    await db.from("leads").update({ status: "new" }).eq("id", id);
    if (btn) btn.disabled = false;
    return toast("Error: " + error.message);
  }
  await db.from("case_notes").insert({
    case_id: nc.id,
    body: `Website enquiry (${l.enquiry_type || "general"})${l.property_value ? " · property value " + l.property_value : ""}${l.message ? " · “" + l.message + "”" : ""}`,
  });
  if (l.email) await db.from("email_queue").insert({ case_id: nc.id, client_id: client.id, email_type: "welcome", to_email: l.email });
  await db.from("leads").update({ converted_case_id: nc.id }).eq("id", id);
  runAutomation(true);
  toast("Lead accepted — case created, welcome email queued");
  loadLeads();
  openCase(nc.id);
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
  const todayStr = new Date().toDateString();
  const days = [];
  for (let d = new Date(gridStart); d < gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  $("#diary-grid").innerHTML = days.map((day) => {
    const dayAppts = (appts || []).filter((a) => new Date(a.starts_at).toDateString() === day.toDateString());
    const dim = day.getMonth() !== monthStart.getMonth();
    const dstr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    return `<div class="diary-day ${day.toDateString() === todayStr ? "today" : ""}${dayAppts.length ? " has-appts" : ""}" data-date="${dstr}" title="Add an appointment on this day" style="${dim ? "opacity:.45;" : ""}min-height:110px;">
      <h5>${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</h5>
      ${dayAppts.map((a) => `<div class="appt" onclick="openAppt('${a.id}')">
        <span class="at">${new Date(a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span> ${esc(a.title)}
        ${a.clients ? `<div>${esc([a.clients.first_name, a.clients.last_name].filter(Boolean).join(" "))}</div>` : ""}
        ${a.staff_id && who === "all" ? `<div style="color:var(--muted);">${esc(staffName(a.staff_id))}</div>` : ""}
      </div>`).join("")}
    </div>`;
  }).join("");
}
$("#diary-prev").addEventListener("click", () => { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() - 1, 1); loadDiary(); });
$("#diary-next").addEventListener("click", () => { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() + 1, 1); loadDiary(); });
$("#diary-today").addEventListener("click", () => { diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); loadDiary(); });
$("#diary-staff").addEventListener("change", () => loadDiary());
$("#new-appt-btn").addEventListener("click", () => openAppt(null));
// Click an empty part of a day cell → New appointment pre-filled with that date (QW9).
// Clicks on an appointment inside a cell are handled by the appointment's own onclick.
$("#diary-grid").addEventListener("click", (e) => {
  if (e.target.closest(".appt")) return;
  const cell = e.target.closest(".diary-day");
  if (!cell || !cell.dataset.date) return;
  openAppt(null, { starts_at: cell.dataset.date + "T10:00" });
});
$("#tasks-scope-btn").addEventListener("click", () => {
  tasksScope = tasksScope === "mine" ? "all" : "mine";
  $("#tasks-scope-btn").textContent = tasksScope === "mine" ? "Mine" : "All";
  loadTasks();
});

window.openAppt = async function (id, presets = {}) {
  let a = { staff_id: (ME && ME.id) || null, ...presets };
  if (id) {
    const { data } = await db.from("appointments").select("*").eq("id", id).single();
    a = data || a;
  }
  const { data: clients } = await db.from("clients").select("id,first_name,last_name").order("last_name");
  const start = a.starts_at ? new Date(a.starts_at) : null;
  const mins = a.ends_at && start ? Math.round((new Date(a.ends_at) - start) / 60000) : 60;
  // Derive both date and time from LOCAL components so a late-evening appointment
  // doesn't show a day-shifted date (matches the local parse used on save).
  const pad2 = (n) => String(n).padStart(2, "0");
  const localDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dateVal = localDateStr(start || new Date());
  const timeVal = start ? `${pad2(start.getHours())}:${pad2(start.getMinutes())}` : "10:00";
  $("#modal").innerHTML = `
    <h3>${id ? "Appointment" : "New appointment"}</h3>
    <form id="appt-form" class="form-grid">
      <label class="full">Title<input name="title" required value="${esc(a.title || "")}" placeholder="e.g. Fact find call"></label>
      <label>Date<input name="date" type="date" required value="${dateVal}"></label>
      <label>Time<input name="time" type="time" required value="${timeVal}"></label>
      <label>Duration (mins)<input name="mins" type="number" value="${mins}"></label>
      <label>Who<select name="staff_id">${TEAM.map((p) => `<option value="${p.id}" ${p.id === (a.staff_id || (ME && ME.id)) ? "selected" : ""}>${esc(staffName(p.id))}</option>`).join("")}</select></label>
      <label class="full">Client<select name="client_id"><option value="">— none —</option>${(clients || []).map((cl) => `<option value="${cl.id}" ${cl.id === a.client_id ? "selected" : ""}>${esc([cl.last_name, cl.first_name].filter(Boolean).join(", "))}</option>`).join("")}</select></label>
      <label class="full">Location<input name="location" value="${esc(a.location || "")}" placeholder="Office / phone / Teams"></label>
      <label class="full">Notes<textarea name="notes" rows="2">${esc(a.notes || "")}</textarea></label>
    </form>
    <div class="modal-actions">
      <div>${id ? '<button class="btn btn-ghost btn-danger" id="del-appt-btn">Delete</button>' : ""}</div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  $("#modal-cancel").onclick = closeModal;
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
    const q = id ? db.from("appointments").update(row).eq("id", id) : db.from("appointments").insert(row);
    const { error } = await q;
    if (error) return toast("Error: " + error.message);
    closeModal();
    toast("Appointment saved");
    if (!$("#page-diary").classList.contains("hidden")) loadDiary();
    if (!$("#page-dashboard").classList.contains("hidden")) loadTodayAppts();
  };
  if (id) $("#del-appt-btn").onclick = async () => {
    if (!confirm("Delete this appointment?")) return;
    await db.from("appointments").delete().eq("id", id);
    closeModal();
    toast("Appointment deleted");
    if (!$("#page-diary").classList.contains("hidden")) loadDiary();
    if (!$("#page-dashboard").classList.contains("hidden")) loadTodayAppts();
  };
};

/* ---------- Evidence pack ---------- */
async function buildEvidencePack(caseId) {
  toast("Building evidence pack…");
  const [{ data: c }, { data: notes }, { data: tasks }, { data: events }, { data: emails }] = await Promise.all([
    db.from("cases").select("*, clients(*), introducers(name)").eq("id", caseId).single(),
    db.from("case_notes").select("*").eq("case_id", caseId).order("created_at"),
    db.from("case_tasks").select("*").eq("case_id", caseId).order("created_at"),
    db.from("case_events").select("*").eq("case_id", caseId).order("created_at"),
    db.from("email_queue").select("email_type,status,to_email,subject,sent_at,created_at").eq("case_id", caseId).order("created_at"),
  ]);
  if (!c) return toast("Could not load case");
  const cl = c.clients || {};
  const name = [cl.first_name, cl.last_name].filter(Boolean).join(" ");
  const dt = (d) => (d ? new Date(d).toLocaleString("en-GB") : "—");
  const row = (k, v) => `<tr><td>${k}</td><td><strong>${esc(v ?? "—")}</strong></td></tr>`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Evidence pack — ${esc(name)}</title>
    <style>
      body{font-family:Arial,sans-serif;color:#222;max-width:800px;margin:30px auto;font-size:13px;line-height:1.5;}
      h1{font-size:20px;color:#00488c;} h2{font-size:15px;color:#00488c;margin-top:26px;border-bottom:1px solid #ddd;padding-bottom:4px;}
      table{border-collapse:collapse;width:100%;} td,th{padding:5px 10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;}
      .muted{color:#777;} @media print {.noprint{display:none}}
    </style></head><body>
    <button class="noprint" onclick="window.print()" style="padding:8px 16px;">Print / Save as PDF</button>
    <h1>Case evidence pack — ${esc(name)}</h1>
    <p class="muted">Generated ${new Date().toLocaleString("en-GB")} · NexMoney Back Office · Case ref ${String(c.id).slice(0, 8).toUpperCase()}</p>
    <h2>Client</h2><table>
      ${row("Name", name)}${row("Email", cl.email)}${row("Phone", cl.phone)}${row("Address", cl.address)}
    </table>
    <h2>Case details</h2><table>
      ${row("Type", (KINDS.find((x) => x[0] === c.case_kind) || [])[1] || c.case_kind)}${row("Stage", STAGE_LABEL[c.stage] || c.stage)}${row("Lender", c.lender)}${row("Product", c.product_name)}
      ${row("Rate", c.rate_percent != null ? c.rate_percent + "% " + (c.rate_type || "") : null)}
      ${row("Rate end date", c.rate_end_date ? fmtD(c.rate_end_date) + (c.rate_end_estimated ? " (ESTIMATED — unverified)" : "") : null)}
      ${row("ERC end date", c.erc_end_date ? fmtD(c.erc_end_date) : null)}
      ${row("Loan amount", c.loan_amount != null ? fmtM(c.loan_amount) : null)}${row("Property value", c.property_value != null ? fmtM(c.property_value) : null)}
      ${row("Broker fee", c.broker_fee != null ? fmtM2(c.broker_fee) + " (" + c.fee_status + ")" : null)}
      ${row("Proc fee", c.proc_fee != null ? fmtM2(c.proc_fee) : null)}${row("Sols fee", c.sols_fee != null ? fmtM2(c.sols_fee) : null)}
      ${row("Protection", (c.protection_status || "not_discussed").replace("_", " "))}
      ${row("Lead source", c.lead_source)}${row("Introducer", c.introducers?.name)}
      ${row("Created", dt(c.created_at))}${row("Completed", c.completed_at ? dt(c.completed_at) : null)}
      ${row("Offer document on file", c.offer_doc_path ? "Yes — " + c.offer_doc_path : "No")}
    </table>
    <h2>Event timeline</h2><table><tr><th>When</th><th>Event</th><th>Detail</th></tr>
      ${(events || []).map((e) => `<tr><td>${dt(e.created_at)}</td><td>${esc(e.event.replace(/_/g, " "))}</td><td>${esc(e.detail || "")}</td></tr>`).join("") || "<tr><td colspan=3>None recorded</td></tr>"}
    </table>
    <h2>Client communications</h2><table><tr><th>When</th><th>Type</th><th>To</th><th>Status</th><th>Subject</th></tr>
      ${(emails || []).map((e) => `<tr><td>${dt(e.sent_at || e.created_at)}</td><td>${esc(EMAIL_LABEL[e.email_type] || e.email_type)}</td><td>${esc(e.to_email || "")}</td><td>${esc(e.status)}</td><td>${esc(e.subject || "")}</td></tr>`).join("") || "<tr><td colspan=5>None</td></tr>"}
    </table>
    <h2>Notes</h2><table>
      ${(notes || []).map((n) => `<tr><td style="white-space:nowrap;">${dt(n.created_at)}</td><td>${esc(n.body)}</td></tr>`).join("") || "<tr><td>None</td></tr>"}
    </table>
    <h2>Tasks</h2><table>
      ${(tasks || []).map((t) => `<tr><td style="white-space:nowrap;">${t.due_date ? "due " + fmtD(t.due_date) : ""}</td><td>${esc(t.title)}</td><td>${t.done_at ? "done " + dt(t.done_at) : "open"}</td></tr>`).join("") || "<tr><td>None</td></tr>"}
    </table>
    </body></html>`;
  const w = window.open("", "_blank");
  if (!w) return toast("Pop-up blocked — allow pop-ups for this page.");
  w.document.write(html);
  w.document.close();
}

/* ---------- Reports ---------- */
function renderMonthReport(all) {
  const mv = $("#report-month").value || localMonthStr();
  if (!$("#report-month").value) $("#report-month").value = mv;
  // Bucket on the UK-local month so this card agrees with the annual chart/YTD (which use local getMonth/getFullYear).
  const inMonth = (d) => d && localMonthStr(d) === mv;
  const sub = all.filter((c) => inMonth(c.submitted_at));
  const done = all.filter((c) => inMonth(c.completed_at));
  const sum = (rows, k) => rows.reduce((s, c) => s + Number(c[k] || 0), 0);
  const subTotal = sum(sub, "proc_fee") + sum(sub, "broker_fee") + sum(sub, "sols_fee");
  const doneTotal = sum(done, "proc_fee") + sum(done, "broker_fee") + sum(done, "sols_fee");
  $("#month-report-title").textContent = "Monthly business — " + new Date(mv + "-01").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  $("#month-kpis").innerHTML = `
    <div class="kpi"><div class="num">${sub.length}</div><div class="lbl">Applications submitted</div></div>
    <div class="kpi"><div class="num">${fmtM(subTotal)}</div><div class="lbl">Submitted £ (proc+broker+sols)</div></div>
    <div class="kpi"><div class="num">${done.length}</div><div class="lbl">Completions</div></div>
    <div class="kpi"><div class="num">${fmtM(doneTotal)}</div><div class="lbl">Completed £ (proc+broker+sols)</div></div>`;
  const rows = TEAM.map((p) => {
    const s2 = sub.filter((c) => c.assigned_to === p.id);
    const d2 = done.filter((c) => c.assigned_to === p.id);
    return { name: staffName(p.id), nSub: s2.length, sProc: sum(s2, "proc_fee"), sBrk: sum(s2, "broker_fee"), sSol: sum(s2, "sols_fee"),
             nDone: d2.length, dTot: sum(d2, "proc_fee") + sum(d2, "broker_fee") + sum(d2, "sols_fee") };
  }).filter((r) => r.nSub || r.nDone);
  $("#month-advisers").innerHTML = rows.length ? `<div style="overflow-x:auto;"><table class="imp-table">
    <tr><th>Adviser</th><th>Submitted</th><th>Proc £</th><th>Broker £</th><th>Sols £</th><th>Completed</th><th>Completed £</th></tr>
    ${rows.map((r) => `<tr><td><strong>${esc(r.name)}</strong></td><td>${r.nSub}</td><td>${fmtM(r.sProc)}</td><td>${fmtM(r.sBrk)}</td><td>${fmtM(r.sSol)}</td><td>${r.nDone}</td><td>${fmtM(r.dTot)}</td></tr>`).join("")}
  </table></div>` : '<div class="empty">No submissions or completions recorded for this month.</div>';
}

async function loadReports() {
  const yr = new Date().getFullYear();
  const [{ data: cases }, { data: intros }, repRes] = await Promise.all([
    db.from("cases").select("id,stage,case_kind,loan_amount,broker_fee,proc_fee,sols_fee,submitted_at,fee_status,fee_paid_at,completed_at,created_at,lead_source,introducer_id,protection_status,retention_source_case_id,assigned_to,nps_score"),
    db.from("introducers").select("id,name"),
    db.rpc("get_reports"),
  ]);
  renderMonthReport(cases || []);
  const all = cases || [];
  const activeStages = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
  const active = all.filter((c) => activeStages.includes(c.stage));
  const completedYr = all.filter((c) => c.completed_at && new Date(c.completed_at).getFullYear() === yr);
  const pipelineValue = active.reduce((s, c) => s + Number(c.loan_amount || 0), 0);
  const feesPaidYr = all.filter((c) => c.fee_paid_at && new Date(c.fee_paid_at).getFullYear() === yr)
    .reduce((s, c) => s + Number(c.broker_fee || 0), 0);
  const feesOutstanding = all.filter((c) => ["not_requested", "requested"].includes(c.fee_status) && c.broker_fee > 0 && c.stage !== "not_proceeding")
    .reduce((s, c) => s + Number(c.broker_fee || 0), 0);
  const rets = all.filter((c) => c.retention_source_case_id);
  const rWon = rets.filter((c) => c.stage === "completed").length;
  const rLost = rets.filter((c) => c.stage === "not_proceeding").length;
  const protDone = completedYr.filter((c) => c.protection_status === "policy_taken").length;
  const scored = all.filter((c) => c.nps_score != null);
  const avgNps = scored.length ? scored.reduce((s, c) => s + Number(c.nps_score), 0) / scored.length : null;
  const promoterPct = scored.length ? Math.round((scored.filter((c) => c.nps_score >= 9).length / scored.length) * 100) : null;

  $("#report-kpis").innerHTML = `
    <div class="kpi"><div class="num">${completedYr.length}</div><div class="lbl">Completions ${yr}</div></div>
    <div class="kpi"><div class="num">${active.length}</div><div class="lbl">Live cases</div></div>
    <div class="kpi"><div class="num">${fmtM(pipelineValue)}</div><div class="lbl">Pipeline loan value</div></div>
    <div class="kpi"><div class="num">${fmtM(feesPaidYr)}</div><div class="lbl">Fees banked ${yr}</div></div>
    <div class="kpi ${feesOutstanding ? "warn" : ""}"><div class="num">${fmtM(feesOutstanding)}</div><div class="lbl">Fees outstanding</div></div>
    <div class="kpi"><div class="num">${rWon + rLost ? Math.round((rWon / (rWon + rLost)) * 100) + "%" : "—"}</div><div class="lbl">Retention conversion</div></div>
    <div class="kpi"><div class="num">${completedYr.length ? Math.round((protDone / completedYr.length) * 100) + "%" : "—"}</div><div class="lbl">Protection uptake ${yr}</div></div>
    <div class="kpi"><div class="num">${scored.length ? avgNps.toFixed(1) : "—"}</div><div class="lbl">Avg review score (${scored.length})${promoterPct != null ? ` · ${promoterPct}% promoters` : ""}</div></div>`;

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const byMonth = months.map((_, i) => completedYr.filter((c) => new Date(c.completed_at).getMonth() === i).length);
  const maxM = Math.max(...byMonth, 1);
  $("#report-months").innerHTML = months.map((m, i) => `
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
      <span style="width:32px;font-size:12px;color:var(--muted);">${m}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(byMonth[i] / maxM) * 100}%;background:var(--navy);border-radius:4px;height:16px;"></div></div>
      <span style="width:24px;font-size:12px;font-weight:600;">${byMonth[i] || ""}</span>
    </div>`).join("");

  const maxF = Math.max(...activeStages.map((s) => active.filter((c) => c.stage === s).length), 1);
  $("#report-funnel").innerHTML = activeStages.map((s) => {
    const n = active.filter((c) => c.stage === s).length;
    return `
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
      <span style="width:90px;font-size:12px;color:var(--muted);">${STAGE_LABEL[s]}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(n / maxF) * 100}%;background:var(--orange);border-radius:4px;height:16px;"></div></div>
      <span style="width:24px;font-size:12px;font-weight:600;">${n || ""}</span>
    </div>`;
  }).join("");

  const srcMap = {};
  all.forEach((c) => {
    const k = (c.lead_source || "").trim() || "(not set)";
    srcMap[k] = srcMap[k] || { total: 0, done: 0 };
    srcMap[k].total++;
    if (c.stage === "completed") srcMap[k].done++;
  });
  $("#report-sources").innerHTML = `<table class="imp-table"><tr><th>Source</th><th>Cases</th><th>Completed</th></tr>` +
    Object.entries(srcMap).sort((a, b) => b[1].total - a[1].total).slice(0, 12)
      .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.total}</td><td>${v.done}</td></tr>`).join("") + `</table>`;

  const introMap = Object.fromEntries((intros || []).map((i) => [i.id, i.name]));
  const iMap = {};
  all.filter((c) => c.introducer_id).forEach((c) => {
    const k = introMap[c.introducer_id] || "Unknown";
    iMap[k] = iMap[k] || { total: 0, done: 0 };
    iMap[k].total++;
    if (c.stage === "completed") iMap[k].done++;
  });
  $("#report-introducers").innerHTML = Object.keys(iMap).length
    ? `<table class="imp-table"><tr><th>Introducer</th><th>Cases</th><th>Completed</th></tr>` +
      Object.entries(iMap).sort((a, b) => b[1].total - a[1].total)
        .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.total}</td><td>${v.done}</td></tr>`).join("") + `</table>`
    : '<div class="empty">No cases assigned to introducers yet.</div>';

  // Extra panels backed by the get_reports() RPC. On error we skip them —
  // the client-side report above still renders in full.
  renderReportExtras(repRes && !repRes.error ? repRes.data : null);
}

/* New RPC-backed report panels (forecast, adviser scoreboard, client LTV, rich lead sources) */
function renderReportExtras(rep) {
  const extraPanels = ["#report-forecast-panel", "#report-scoreboard-panel", "#report-ltv-panel"];
  if (!rep || !rep.forecast) {
    extraPanels.forEach((s) => { const p = $(s); if (p) p.classList.add("hidden"); });
    return;
  }
  extraPanels.forEach((s) => { const p = $(s); if (p) p.classList.remove("hidden"); });

  // a) Commission forecast (weighted pipeline)
  const fc = rep.forecast || {};
  $("#report-forecast-headline").innerHTML = `
    <div class="kpi"><div class="num">${fmtM(fc.weighted_total)}</div><div class="lbl">Weighted commission</div></div>
    <div class="kpi"><div class="num">${fmtM(fc.gross_total)}</div><div class="lbl">Gross (unweighted)</div></div>`;
  const byStage = Array.isArray(fc.by_stage) ? fc.by_stage : [];
  const maxW = Math.max(...byStage.map((s) => Number(s.weighted) || 0), 1);
  $("#report-forecast-bars").innerHTML = byStage.length ? byStage.map((s) => `
    <div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
      <span style="width:90px;font-size:12px;color:var(--muted);">${esc(STAGE_LABEL[s.stage] || s.stage)}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(Number(s.weighted) / maxW) * 100}%;background:var(--orange);border-radius:4px;height:16px;"></div></div>
      <span style="width:130px;font-size:12px;font-weight:600;text-align:right;">${s.cases || 0} case${s.cases === 1 ? "" : "s"} · ${fmtM(s.weighted)}</span>
    </div>`).join("") : '<div class="empty">No live pipeline to forecast.</div>';

  // b) Adviser scoreboard (already sorted by fees banked)
  const advs = Array.isArray(rep.advisers) ? rep.advisers : [];
  $("#report-advisers").innerHTML = advs.length ? `<table class="imp-table">
    <tr><th>Adviser</th><th>Open</th><th>Completions YTD</th><th>Fees banked YTD</th><th>Overdue</th><th>Avg days</th></tr>
    ${advs.map((a) => `<tr>
      <td>${esc(a.name)}</td>
      <td>${a.open_cases ?? 0}</td>
      <td>${a.completions_ytd ?? 0}</td>
      <td>${fmtM(a.fees_banked_ytd)}</td>
      <td>${a.overdue_tasks ? `<span class="badge red">${a.overdue_tasks}</span>` : "0"}</td>
      <td>${a.avg_days_to_complete == null ? "—" : a.avg_days_to_complete}</td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No adviser activity yet.</div>';

  // c) Client lifetime value (top 20)
  const ltv = Array.isArray(rep.client_ltv) ? rep.client_ltv : [];
  $("#report-ltv").innerHTML = ltv.length ? `<table class="imp-table">
    <tr><th>Name</th><th>Cases</th><th>LTV</th></tr>
    ${ltv.map((c) => `<tr>
      <td><button class="btn btn-sm" onclick="openClient('${c.client_id}')">${esc(c.name)}</button></td>
      <td>${c.cases ?? 0}</td>
      <td>${fmtM(c.ltv)}</td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No completed revenue yet.</div>';

  // d) Lead sources — richer table from the RPC (replaces the client-side one above)
  const ls = Array.isArray(rep.lead_sources) ? rep.lead_sources : [];
  if (ls.length) {
    $("#report-sources").innerHTML = `<table class="imp-table">
      <tr><th>Source</th><th>Cases</th><th>Completed</th><th>Conversion</th><th>Revenue</th></tr>
      ${ls.slice().sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)).map((s) => `<tr>
        <td>${esc(s.source || "(not set)")}</td>
        <td>${s.cases ?? 0}</td>
        <td>${s.completed ?? 0}</td>
        <td>${s.conversion ?? 0}%</td>
        <td>${fmtM(s.revenue)}</td>
      </tr>`).join("")}
    </table>`;
  }
}

/* ---------- Data health ---------- */
async function loadDataHealth() {
  const el = $("#data-content");
  el.innerHTML = '<div class="empty">Loading…</div>';
  const [dqRes, dupRes] = await Promise.all([
    db.rpc("get_data_quality"),
    db.rpc("find_duplicate_clients"),
  ]);
  if (dqRes.error || dupRes.error) {
    renderLoadError("#data-content", dqRes.error || dupRes.error, loadDataHealth);
    return;
  }
  const dq = dqRes.data || {};
  const dups = Array.isArray(dupRes.data) ? dupRes.data : [];
  const missingEmail = Array.isArray(dq.missing_email) ? dq.missing_email : [];
  const unassigned = Array.isArray(dq.live_unassigned) ? dq.live_unassigned : [];
  const noFee = Array.isArray(dq.completed_missing_fee) ? dq.completed_missing_fee : [];

  const kpis = `
    <div class="kpi"><div class="num">${dq.clients_total ?? 0}</div><div class="lbl">Clients total</div></div>
    <div class="kpi ${missingEmail.length ? "warn" : ""}" title="${missingEmail.length} of ${dq.missing_email_count ?? 0} clients missing an email have a live case — only those are actionable below"><div class="num">${missingEmail.length} of ${dq.missing_email_count ?? 0}</div><div class="lbl">Missing email — with a live case</div></div>
    <div class="kpi ${dq.missing_phone_count ? "warn" : ""}"><div class="num">${dq.missing_phone_count ?? 0}</div><div class="lbl">Missing phone</div></div>
    <div class="kpi ${dq.missing_both_count ? "warn" : ""}"><div class="num">${dq.missing_both_count ?? 0}</div><div class="lbl">Missing email &amp; phone</div></div>
    <div class="kpi ${unassigned.length ? "warn" : ""}"><div class="num">${unassigned.length}</div><div class="lbl">Live cases unassigned</div></div>
    <div class="kpi"><div class="num">${noFee.length}</div><div class="lbl">Completed, no fee</div></div>
    <div class="kpi"><div class="num">${dq.completed_missing_rate_end ?? 0}</div><div class="lbl">Completed, no rate-end</div></div>
    <div class="kpi"><div class="num">${dq.emails_failed ?? 0}</div><div class="lbl">Failed emails</div></div>`;

  let stuckNotice = "";
  if (dq.emails_stuck > 0 && dq.emails_sending_live) {
    stuckNotice = `<div class="dq-notice bad">${dq.emails_stuck} email${dq.emails_stuck === 1 ? " is" : "s are"} stuck in the queue — the sender may be failing.</div>`;
  } else if (dq.emails_stuck > 0 && !dq.emails_sending_live) {
    stuckNotice = `<div class="dq-notice">${dq.emails_stuck} email${dq.emails_stuck === 1 ? "" : "s"} queued and waiting — the Resend key isn't set yet, so nothing has sent.</div>`;
  }

  const mutedSub = "color:var(--muted);font-size:12px;margin-top:2px;";
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
        <td style="white-space:nowrap;"><button class="btn btn-sm" onclick="openClient('${d.a_id}')">Open A</button> <button class="btn btn-sm" onclick="openClient('${d.b_id}')">Open B</button></td>
      </tr>`).join("")}
    </table>` : '<div class="empty">No likely duplicates found. 👍</div>'}
  </div>`;

  const missingPanel = `<div class="panel">
    <h3>Clients missing email (with a live case)</h3>
    ${missingEmail.length === 300 ? '<p class="panel-sub">Showing the first 300 — there may be more.</p>' : ""}
    ${missingEmail.length ? `<table class="imp-table">
      ${missingEmail.map((c) => `<tr>
        <td>${esc(c.name)}</td>
        <td style="text-align:right;white-space:nowrap;"><button class="btn btn-sm" onclick="openClient('${c.id}')">Open</button></td>
      </tr>`).join("")}
    </table>` : '<div class="empty">Every client with a live case has an email. 👍</div>'}
  </div>`;

  const unassignedPanel = `<div class="panel">
    <h3>Live cases with no adviser</h3>
    ${unassigned.length ? unassigned.map((c) => `
      <div class="row-item">
        <div class="row-main">
          <div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div>
          <div class="s">${esc(STAGE_LABEL[c.stage] || c.stage)}</div>
        </div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">Every live case has an adviser. 👍</div>'}
  </div>`;

  const noFeePanel = `<div class="panel">
    <h3>Completed cases with no fee recorded</h3>
    ${noFee.length ? noFee.map((c) => `
      <div class="row-item">
        <div class="row-main"><div class="t" onclick="openCase('${c.case_id}')">${esc(c.name)}</div></div>
        <button class="btn btn-sm" onclick="openCase('${c.case_id}')">Open</button>
      </div>`).join("") : '<div class="empty">All completed cases have a fee recorded. 👍</div>'}
  </div>`;

  el.innerHTML = `
    <div class="kpi-row">${kpis}</div>
    ${stuckNotice}
    ${dupPanel}
    <div class="grid-2">${missingPanel}${unassignedPanel}</div>
    ${noFeePanel}`;
}
$("#data-refresh").addEventListener("click", () => loadDataHealth());

/* ---------- Introducers & team (Settings) ---------- */
async function loadIntroducers() {
  const { data: intros } = await db.from("introducers").select("*").order("name");
  const { data: logins } = await db.from("profiles").select("introducer_id,email").eq("role", "introducer");
  const hasLogin = new Set((logins || []).map((l) => l.introducer_id));
  $("#intro-list").innerHTML = (intros || []).length ? intros.map((i) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc(i.name)}</div>
        <div class="s">${esc(i.email || "no email")}</div>
      </div>
      ${hasLogin.has(i.id) ? '<span class="badge green">portal login active</span>' : (i.email ? `<button class="btn btn-sm" onclick="inviteIntroducer('${i.id}')">Create portal login</button>` : '<span class="badge grey">add email to invite</span>')}
    </div>`).join("") : '<div class="empty">No introducers yet.</div>';
}
$("#add-intro-btn").addEventListener("click", async () => {
  const name = $("#intro-name").value.trim();
  if (!name) return toast("Name required");
  const { error } = await db.from("introducers").insert({ name, email: $("#intro-email").value.trim() || null });
  if (error) return toast("Error: " + error.message);
  $("#intro-name").value = ""; $("#intro-email").value = "";
  toast("Introducer added");
  loadIntroducers();
});
window.inviteIntroducer = async function (introducerId) {
  const { data: i } = await db.from("introducers").select("*").eq("id", introducerId).single();
  if (!i?.email) return toast("Add an email address first");
  if (!confirm(`Create a portal login for ${i.name} (${i.email})? They will only see their own referrals.`)) return;
  const res = await inviteUser({ email: i.email, full_name: i.name, role: "introducer", introducer_id: introducerId });
  if (res) {
    $("#invite-result").innerHTML = `Portal login created for <strong>${esc(i.email)}</strong> — temporary password: <strong>${esc(res.temp_password)}</strong><br>Send them this with the back office address (they use the introducer page). They can change it via "Forgot password".`;
    loadIntroducers();
  }
};
$("#invite-staff-btn").addEventListener("click", async () => {
  const email = $("#staff-email").value.trim();
  const name = $("#staff-name").value.trim();
  if (!email) return toast("Email required");
  if (!confirm(`Create a full-access team login for ${email}?`)) return;
  const res = await inviteUser({ email, full_name: name, role: "staff" });
  if (res) {
    $("#invite-result").innerHTML = `Team login created for <strong>${esc(email)}</strong> — temporary password: <strong>${esc(res.temp_password)}</strong><br>They should change it after first sign-in ("Forgot password" works too).`;
    $("#staff-email").value = ""; $("#staff-name").value = "";
  }
});
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
    x.addEventListener("click", closeModal);
    modal.insertBefore(x, modal.firstChild);
  }
  $("#modal-backdrop").classList.remove("hidden");
  // Focus the first real control, not the close button, so keyboard flow is unchanged.
  const f = modalFocusable().filter((el) => !el.classList.contains("modal-close"));
  if (f.length) f[0].focus();
}
window.closeModal = function () {
  $("#modal-backdrop").classList.add("hidden");
  if (modalPrevFocus && typeof modalPrevFocus.focus === "function") modalPrevFocus.focus();
  modalPrevFocus = null;
};
$("#modal-backdrop").addEventListener("click", (e) => { if (e.target === $("#modal-backdrop")) closeModal(); });
document.addEventListener("keydown", (e) => {
  if ($("#modal-backdrop").classList.contains("hidden")) return;
  if (e.key === "Escape") { e.preventDefault(); closeModal(); return; }
  if (e.key === "Tab") {
    const f = modalFocusable();
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

init();
