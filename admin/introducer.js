/* R95 · E: moved verbatim from introducer.html's inline <script> — the strict CSP has no 'unsafe-inline'. */
const SUPABASE_URL = "https://sclghkmvzpwtmnzbkaoe.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNjbGdoa212enB3dG1uemJrYW9lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNzI1MDEsImV4cCI6MjA5ODc0ODUwMX0.LNm4vE071b359t8ACq459nVmQCUkk7BSVeGjddqNztg";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s) => document.querySelector(s);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
const fmtD = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const STAGE_LABEL = { enquiry: "Enquiry received", fact_find: "Fact find", decision_in_principle: "Decision in principle", application: "Application submitted", offer: "Offer received", exchange: "Exchanged", completed: "Completed", not_proceeding: "Not proceeding" };

function toast(m){ const t=$("#toast"); t.textContent=m; t.classList.remove("hidden"); setTimeout(()=>t.classList.add("hidden"),3000); }

/* R78 · B6 — password recovery, the admin app's exact pattern (see init/showRecovery in app.js):
   a recovery link lands with type=recovery in the hash; wait for the PASSWORD_RECOVERY auth event
   rather than treating the recovery session as a sign-in, swap the login card for a new-password
   form, and reload clean once the password is saved. */
const INTRODUCER_URL = new URL(window.location.pathname, window.location.origin).href;
async function init() {
  const isRecovery = location.hash.includes("type=recovery");
  db.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") return showRecovery();
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
}
async function showApp(session) {
  const { data: profile } = await db.from("profiles").select("role,introducer_id").eq("id", session.user.id).single();
  if (!profile || profile.role !== "introducer") {
    await db.auth.signOut();
    $("#login-error").textContent = "This login is not an introducer account.";
    $("#login-error").classList.remove("hidden");
    showLogin();
    return;
  }
  $("#login-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
  $("#user-email").textContent = session.user.email;
  const { data: me } = await db.from("introducers").select("name").eq("id", profile.introducer_id).single();
  if (me) $("#intro-title").textContent = "Your referrals — " + me.name;

  // R84 — the base tables are staff-only again. Introducers read two whitelist RPCs
  // (get_introducer_cases / get_introducer_clients: stage, kind, dates and client NAMES — nothing
  // else), both scoped server-side to this login's introducer. Two reads joined here.
  // R95 · E3: RPCs replace the two owner-rights views (Security Advisor ERROR); same columns, same rows.
  const { data: cases } = await db.rpc("get_introducer_cases")
    .eq("introducer_id", profile.introducer_id) // R18-S1 — defence-in-depth: the RPC already scopes this, make the intent explicit
    .order("created_at", { ascending: false });
  const all = cases || [];
  const clientIds = [...new Set(all.map((c) => c.client_id).filter(Boolean))];   // R84
  const { data: clientRows } = clientIds.length                                    // R84
    ? await db.rpc("get_introducer_clients", { p_ids: clientIds })
    : { data: [] };
  const clientById = Object.fromEntries((clientRows || []).map((cl) => [cl.id, cl]));   // R84
  all.forEach((c) => { c.clients = clientById[c.client_id] || null; });                 // R84 — same shape the row template always read
  const row = (c) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" "))}</div>
        <div class="s">Referred ${fmtD(c.created_at)}${c.completed_at ? " · completed " + fmtD(c.completed_at) : ""}</div>
      </div>
      <span class="badge ${c.stage === "completed" ? "green" : c.stage === "not_proceeding" ? "grey" : "blue"}">${STAGE_LABEL[c.stage] || c.stage}</span>
    </div>`;
  const live = all.filter((c) => !["completed", "not_proceeding"].includes(c.stage));
  const done = all.filter((c) => ["completed", "not_proceeding"].includes(c.stage));
  $("#live-list").innerHTML = live.map(row).join("") || '<div class="empty">No cases in progress right now.</div>';
  $("#done-list").innerHTML = done.map(row).join("") || '<div class="empty">Nothing completed yet.</div>';
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!$("#login-email")) return; // R78 · B6 — recovery form has taken over (same guard as app.js)
  $("#login-error").classList.add("hidden");
  const { data, error } = await db.auth.signInWithPassword({
    email: $("#login-email").value.trim(),
    password: $("#login-password").value,
  });
  if (error) { $("#login-error").textContent = error.message; $("#login-error").classList.remove("hidden"); return; }
  showApp(data.session);
});
$("#logout-btn").addEventListener("click", async () => { await db.auth.signOut(); showLogin(); });
// R78 · B6 — send the recovery email. Uses the address already typed in the box where there is
// one; the redirect comes BACK to this page, whose recovery handler (above) can finish the job.
$("#forgot-btn").addEventListener("click", async () => {
  const email = ($("#login-email") && $("#login-email").value.trim()) || prompt("Your account email:");
  if (!email) return;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: INTRODUCER_URL });
  toast(error ? "Error: " + error.message : "Password reset link sent — check your inbox.");
});
$("#pw-btn").addEventListener("click", () => {
  const i = $("#login-password");
  i.type = i.type === "password" ? "text" : "password";
});
init();
