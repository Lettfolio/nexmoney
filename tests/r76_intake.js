#!/usr/bin/env node
/* =============================================================================
   tests/r76_intake.js — acceptance tests for R76 build B, "close the loop"
   (items B1–B5).

   What R76 · B changed, and what each section pins:

     §A  RUN-NOW HONESTY + MOCK HOLD PARITY (B1). Production's process-emails
         v18 enforces the global hold SERVER-SIDE (email_hold ≠ 'off' → nothing
         sends; {warning, held, pending} comes back), but runQueueNow staged the
         named-recipient consent dialog anyway — asking the Owner to consent to
         sends the server was always going to refuse. While held, the client now
         raises an honest house overlay instead (#ovl-confirm-body: queues +
         stamps the heartbeat, sends nothing, Owner releases the hold — NO
         recipient list); OK still runs the automation, because the queueing and
         the heartbeat are the point. When the hold is OFF the classic native
         confirm is a pinned contract and is untouched. The MOCK's full-run path
         now matches v18: queueing RPCs + last_cron_run_at stamp, then — hold on
         OR no MOCK_RESEND_KEY — nothing sends and {warning, held, pending}
         comes back. The SCOPED path still sends (r69_polish §D9 pins that).

     §B  THE DUP GATE ON THE HAND-TYPED DOORS (B2). dupClientGate() — the
         shared findClientMatches wrapped in #dup-client-overlay — now guards
         BOTH the New-client modal's create and the New-case modal's inline
         "+ New client…": exact email/phone/name → "This looks like an existing
         client…", name-similar → the acceptLead did-you-mean shape; actions
         #dup-client-existing / #dup-client-create / #dup-client-cancel. Never
         on an edit, at most once per Save click, and a clean unique create
         paints no overlay at all.

     §C  THE JOINT-LEAD ACCEPT OVERLAY (B3). The prompt("First name") →
         prompt("Surname") → top-match-only confirm chain is ONE
         #lead-joint-overlay: prefilled First/Surname (K-3's empty-falls-back-
         to-the-guess rule kept), the joint-name note, a radio per candidate
         match ("Attach to <name> — <evidence>") plus "Create a new client" —
         so candidate #2 is finally pickable — and Cancel ABORTS (releaseLead;
         the enquiry goes back in the inbox). Non-joint accepts keep their
         native confirms, untouched.

     §D  THE SIGNED-OUT STRIP (B4). #modal-backdrop lives outside #app-view,
         so session loss left an open case modal interactive over the login
         screen. The !session event now reveals the non-dismissable
         #signedout-strip over the modal and disables its save/submit buttons —
         and NEVER closes the modal (the typed text is the thing preserved).
         Signing back in through the real form clears both.

     §E  FIX CONTACT → OFFER THE RETRY (B5). fixContactOpen(kind, rowId, …) is
         the one entry point for every Fix-contact link; when the fix-focused
         save actually changed the failed field, the toast carries a "Retry
         now" action that calls the existing retryEmail/retrySms (safe by
         construction: both re-read the current address).

   Run:  node /root/nx/tests/r76_intake.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — see HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  ok(name, same, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1400));
  return srv;
}

const NX_KEYS = ["nx_ret_scope", "nx_ret_month", "nx_ret_sortdir", "nx_ret_untouched", "nx_wt_scope",
  "nx_board_adviser", "nx_diary_staff", "nx_views_v1", "nx_nav_firm", "nx_drawer_rateerc",
  "nx_drawer_retention", "nx_import_blurb", "nx_pipe_cols", "nx_pipe_view", "nx_clients_adviser"];

async function boot(browser, persona) {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.evaluate((keys) => { keys.forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }); }, NX_KEYS);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const goto = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms || 1500);
};
const wait = (page, ms) => page.waitForTimeout(ms);
const heartbeat = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("settings").select("value").eq("key", "last_cron_run_at").single();
  return data ? data.value : null;
});
const queuedIds = (page) => page.evaluate(async () => {
  const { data } = await window.__mockDb.from("email_queue").select("id").eq("status", "queued");
  return (data || []).map((r) => r.id).sort();
});
/* Flip the hold / the mock's server key, then refresh the app's settings cache
   the way R68's sandbox hook intends (an adviser cannot write settings; these
   suites mutate the fixture DB directly, as r68_mi documents). */
async function setHold(page, value) {
  await page.evaluate(async (v) => {
    const rows = window.__mock.db ? window.__mock.db.settings : null;
    const all = rows || (await window.__mockDb.from("settings").select("*")).data;
    const row = all.filter((r) => r.key === "email_hold")[0];
    if (row) row.value = v; else all.push({ key: "email_hold", value: v });
    await window.__reloadSettings();
  }, value);
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  try {

    /* =======================================================================
       §A · B1 — run-now honesty while held + mock v18 hold parity
       ===================================================================== */
    {
      console.log("\n— §A · run-now under the hold (p4 Daniel, owner; fixture hold = 'on')");
      const page = await boot(browser, "p4");
      await goto(page, "emails", 1600);

      const holdSeed = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "email_hold").single();
        return data && data.value;
      });
      eq("A0 · fixture — the mock seeds email_hold 'on' (production's real state)", holdSeed, "on");

      const hb0 = await heartbeat(page);
      const q0 = await queuedIds(page);
      page.__dialogs.length = 0;
      await page.click("#run-now-btn");
      await wait(page, 1500);

      const ovl = await page.evaluate(() => ({
        visible: !document.querySelector("#overlay-backdrop").classList.contains("hidden"),
        body: (document.querySelector("#ovl-confirm-body") || {}).textContent || "",
        title: (document.querySelector("#ovl-confirm-title") || {}).textContent || "",
        okLabel: ((document.querySelector("#ovl-confirm-ok") || {}).textContent || "").trim(),
        okDanger: ((document.querySelector("#ovl-confirm-ok") || {}).className || "").includes("btn-danger"),
      }));
      ok("A1 · while held, run-now raises the house overlay, not the consent confirm", ovl.visible === true, JSON.stringify(ovl));
      eq("A1 · …and stages NO native dialog at all", page.__dialogs.length, 0);
      ok("A1 · the overlay says what the run does: queues + stamps the heartbeat, sends nothing",
        /on hold/i.test(ovl.body) && /queues new automation emails/i.test(ovl.body) && /stamps the heartbeat/i.test(ovl.body) && /stay held/i.test(ovl.body),
        ovl.body);
      ok("A1 · …and who can release it (an Owner, in Settings › Email sending)",
        /Only an Owner can release the hold/i.test(ovl.body) && /Settings › Email sending/.test(ovl.body), ovl.body);
      ok("A1 · …with NO recipient list — nobody named who will not be written to",
        !/Recipients:/i.test(ovl.body), ovl.body);
      ok("A1 · the OK button is primary, not danger — running a held system is safe", ovl.okDanger === false, ovl.okLabel);

      // Cancel: the run never fires — heartbeat untouched, no run recorded.
      await page.click("#ovl-confirm-cancel");
      await wait(page, 800);
      const afterCancel = await page.evaluate(() => window.__mock.lastEmailRun());
      eq("A2 · Cancel runs nothing (no email run recorded)", afterCancel, null);
      eq("A2 · …and the heartbeat has not moved", await heartbeat(page), hb0);

      // OK: queue + stamp, send NOTHING; the server's held warning reaches the toast.
      await page.click("#run-now-btn");
      await wait(page, 1300);
      await page.click("#ovl-confirm-ok");
      await wait(page, 2200);
      const afterOk = await page.evaluate(() => ({
        lastRun: window.__mock.lastEmailRun(),
        toast: (document.querySelector("#toast") || {}).textContent || "",
      }));
      ok("A3 · OK runs the automation, unscoped (the cron's own shape)",
        afterOk.lastRun && afterOk.lastRun.scoped === false, JSON.stringify(afterOk.lastRun));
      ok("A3 · …which sends NOTHING while held", afterOk.lastRun && afterOk.lastRun.sent === 0 && afterOk.lastRun.failed === 0 && afterOk.lastRun.held === true, JSON.stringify(afterOk.lastRun));
      const hb1 = await heartbeat(page);
      ok("A3 · …but stamps the heartbeat to now", hb1 !== hb0 && Math.abs(Date.now() - new Date(hb1).getTime()) < 120000, JSON.stringify({ hb0, hb1 }));
      const q1 = await queuedIds(page);
      ok("A3 · every email that was queued before the run is STILL queued (held, not lost)",
        q0.every((id) => q1.includes(id)), `before ${q0.length}, after ${q1.length}`);
      ok("A3 · the server's own held warning is surfaced (v18's words, via runAutomation's toast)",
        /email_hold is on — nothing was sent/i.test(afterOk.toast), afterOk.toast);
      eq("A3 · still no native dialog anywhere in the held flow", page.__dialogs.length, 0);

      /* The mock's v18 shape, asserted directly: a full (unscoped) invoke while held
         answers {held, pending, warning} — no sent count, because nothing was tried. */
      const shape = await page.evaluate(async () => {
        const { data: qrows } = await window.__mockDb.from("email_queue").select("id,status,scheduled_for");
        const now = new Date().toISOString();
        const due = (qrows || []).filter((e) => e.status === "queued" && (!e.scheduled_for || e.scheduled_for <= now)).length;
        const { data } = await window.__mockDb.functions.invoke("process-emails", { body: {} });
        return { data, due };
      });
      ok("A4 · a held full run answers v18's shape: {held:true, pending, warning}",
        shape.data.held === true && typeof shape.data.pending === "number" && /email_hold is on/.test(shape.data.warning || "") && shape.data.sent === undefined,
        JSON.stringify(shape.data));
      ok("A4 · …whose pending is the due-now count", shape.data.pending >= shape.due - 1 && shape.data.pending <= shape.due + 6, JSON.stringify(shape));

      /* Hold OFF but no server key: v18 still refuses, naming RESEND_API_KEY. */
      await setHold(page, "off");
      const noKey = await page.evaluate(async () => {
        const before = (await window.__mockDb.from("email_queue").select("id").eq("status", "queued")).data.length;
        const { data } = await window.__mockDb.functions.invoke("process-emails", { body: {} });
        const after = (await window.__mockDb.from("email_queue").select("id").eq("status", "queued")).data.length;
        return { data, before, after };
      });
      ok("A5 · hold OFF + no RESEND key: the full run still sends nothing and says why",
        noKey.data.held === false && /RESEND_API_KEY not set/.test(noKey.data.warning || "") && noKey.after >= noKey.before,
        JSON.stringify(noKey.data));

      /* Hold OFF + key set: the CLASSIC consent confirm, byte-for-byte, and the send lands. */
      /* PATCHED R82 · B4 — and financial promotions approved, which is a THIRD precondition of the
         same kind as the two above. The mock's process-emails now mirrors v20's send-time
         financial-promotions refusal, so the fixture's two queued financial-promotion rows are
         CANCELLED at send time while the switch is off — and "the number consented to is the number
         sent" would then be measuring the compliance gate rather than the consent flow this block
         is about. The gate itself is pinned by tests/r82_mock.js §D. */
      await page.evaluate(async () => {
        const rows = window.__mock.db.settings;
        const fp = rows.filter((r) => r.key === "financial_promotions_approved")[0];
        if (fp) fp.value = "on"; else rows.push({ key: "financial_promotions_approved", value: "on" });
        await window.__reloadSettings();
      });
      await page.evaluate(() => window.__mock.setResendKey(true));
      page.__dialogs.length = 0;
      await page.click("#run-now-btn");
      await wait(page, 2400);
      const classic = (page.__dialogs.find((d) => d.type === "confirm") || {}).message || "";
      ok("A6 · with the hold OFF the classic consent confirm is untouched",
        /Send ALL \d+ queued email/.test(classic) && /Recipients:\s*\S/.test(classic) && /whole firm/.test(classic) && /Cancel sends nothing/.test(classic),
        classic.slice(0, 300));
      const promised = Number((/Send ALL (\d+) queued email/.exec(classic) || [])[1] || 0);
      const sentRun = await page.evaluate(() => window.__mock.lastEmailRun());
      ok("A6 · …and the number consented to is the number sent", promised > 0 && sentRun && sentRun.sent === promised,
        `promised ${promised}, sent ${sentRun && sentRun.sent}`);
      const ovlDuringClassic = await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden"));
      eq("A6 · no house overlay in the unheld flow", ovlDuringClassic, false);

      eq("§A · no console/page errors", realErrs(page), []);
      await page.close();
    }

    /* =======================================================================
       §B · B2 — the duplicate gate on both hand-typed doors
       ===================================================================== */
    {
      console.log("\n— §B · the dup gate on the New-client modal + the inline door (p1 Kim)");
      const page = await boot(browser, "p1");
      await goto(page, "clients", 1500);
      const target = await page.evaluate(async () =>
        (await window.__mockDb.from("clients").select("id,first_name,last_name,email,phone").eq("id", "cl001").single()).data);
      ok("B0 · fixture — cl001 has an email to collide with", !!(target && target.email), JSON.stringify(target));

      const clientCount = () => page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);
      const n0 = await clientCount();

      // B1 — exact email collision → overlay, naming the client and why.
      await page.click("#new-client-btn");
      await wait(page, 500);
      await page.fill('#client-form [name="first_name"]', "Completely");
      await page.fill('#client-form [name="last_name"]', "Unrelated");
      await page.fill('#client-form [name="email"]', target.email);
      await page.click("#modal-save");
      await wait(page, 900);
      const dup = await page.evaluate(() => ({
        ovl: !!document.querySelector("#dup-client-overlay"),
        match: (document.querySelector("#dup-client-overlay") || { dataset: {} }).dataset.match,
        body: (document.querySelector("#dup-client-body") || {}).textContent || "",
        buttons: ["#dup-client-existing", "#dup-client-create", "#dup-client-cancel"].map((s) => !!document.querySelector(s)),
      }));
      ok("B1 · an exact-email create raises #dup-client-overlay", dup.ovl === true, JSON.stringify(dup));
      eq("B1 · …marked as an exact match", dup.match, "exact");
      ok("B1 · …that names the existing client and what matched",
        /This looks like an existing client/.test(dup.body) && dup.body.includes("Ruby Sinclair") && /same email address/.test(dup.body), dup.body);
      eq("B1 · …with all three actions", dup.buttons, [true, true, true]);

      // Cancel: nothing written, the typed form survives.
      await page.click("#dup-client-cancel");
      await wait(page, 500);
      eq("B1 · Cancel inserts nothing", await clientCount(), n0);
      const kept = await page.evaluate(() => ({
        modal: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        first: (document.querySelector('#client-form [name="first_name"]') || {}).value,
      }));
      ok("B1 · …and the typed form is still there to correct", kept.modal === true && kept.first === "Completely", JSON.stringify(kept));

      // B2 — Create anyway: a deliberate duplicate is still allowed.
      await page.click("#modal-save");
      await wait(page, 900);
      await page.click("#dup-client-create");
      await wait(page, 1100);
      eq("B2 · Create anyway inserts exactly one client", await clientCount(), n0 + 1);
      const madeAnyway = await page.evaluate(async (em) =>
        (await window.__mockDb.from("clients").select("first_name")).data.filter((c) => c.first_name === "Completely").length, target.email);
      eq("B2 · …the typed one", madeAnyway, 1);

      // B3 — Open the existing client: the create is abandoned for the record we hold.
      await page.click("#new-client-btn");
      await wait(page, 500);
      await page.fill('#client-form [name="first_name"]', "Another");
      await page.fill('#client-form [name="last_name"]', "Try");
      await page.fill('#client-form [name="email"]', target.email);
      await page.click("#modal-save");
      await wait(page, 900);
      await page.click("#dup-client-existing");
      await wait(page, 1300);
      const openedExisting = await page.evaluate(() => ({
        first: (document.querySelector('#client-form [name="first_name"]') || {}).value,
        last: (document.querySelector('#client-form [name="last_name"]') || {}).value,
      }));
      eq("B3 · Open the existing client lands on the existing record",
        [openedExisting.first, openedExisting.last], [target.first_name, target.last_name]);
      eq("B3 · …and inserted nothing", await clientCount(), n0 + 1);
      await page.evaluate(() => window.closeModal());

      // B4 — a clean, unique create fires NO overlay.
      await page.click("#new-client-btn");
      await wait(page, 500);
      await page.fill('#client-form [name="first_name"]', "Zinnia");
      await page.fill('#client-form [name="last_name"]', "Farthingale");
      await page.fill('#client-form [name="email"]', "zinnia.farthingale@example.com");
      await page.click("#modal-save");
      await wait(page, 1100);
      const cleanState = await page.evaluate(() => ({
        ovl: !!document.querySelector("#dup-client-overlay"),
        toast: (document.querySelector("#toast") || {}).textContent || "",
      }));
      ok("B4 · a unique create never paints the overlay", cleanState.ovl === false, JSON.stringify(cleanState));
      eq("B4 · …and inserts", await clientCount(), n0 + 2);
      ok("B4 · …with the plain saved toast", /Client saved/.test(cleanState.toast), cleanState.toast);

      // B5 — EDITING an existing client must never trip the gate.
      await page.evaluate((id) => window.openClient(id), target.id);
      await wait(page, 1300);
      // The client-details section is collapsed on an existing record — open it to type.
      await page.evaluate(() => { const d = document.querySelector("#modal .client-details"); if (d) d.open = true; });
      await page.fill('#client-form [name="notes"]', "R76 gate must not fire on an edit");
      await page.click("#modal-save");
      await wait(page, 1100);
      const editState = await page.evaluate(() => ({
        ovl: !!document.querySelector("#dup-client-overlay"),
        toast: (document.querySelector("#toast") || {}).textContent || "",
      }));
      ok("B5 · saving an EDIT of the very client whose email would match fires no overlay",
        editState.ovl === false && /Client saved/.test(editState.toast), JSON.stringify(editState));

      // B6 — name-similar (same surname + initial, different contact) → the did-you-mean shape.
      await goto(page, "clients", 900);
      await page.click("#new-client-btn");
      await wait(page, 500);
      await page.fill('#client-form [name="first_name"]', target.first_name.charAt(0) + "osalind");
      await page.fill('#client-form [name="last_name"]', target.last_name);
      await page.fill('#client-form [name="email"]', "rosalind.unique@example.com");
      await page.click("#modal-save");
      await wait(page, 900);
      const near = await page.evaluate(() => ({
        ovl: !!document.querySelector("#dup-client-overlay"),
        match: (document.querySelector("#dup-client-overlay") || { dataset: {} }).dataset.match,
        body: (document.querySelector("#dup-client-body") || {}).textContent || "",
      }));
      ok("B6 · a name-similar create asks the did-you-mean question", near.ovl === true && near.match === "near", JSON.stringify(near));
      ok("B6 · …in acceptLead's own shape (may be a different person)",
        /Did you mean/.test(near.body) && /may be a different person/.test(near.body), near.body);
      await page.click("#dup-client-cancel");
      await wait(page, 400);
      await page.evaluate(() => window.closeModal());

      // B7 — the inline "+ New client…" door, exact dup → "Use the existing client" attaches.
      await goto(page, "pipeline", 1400);
      const n1 = await clientCount();
      await page.click("#new-case-btn");
      await wait(page, 800);
      await page.evaluate(() => {
        const sel = document.querySelector("#case-client-select");
        sel.value = "__new__";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.fill('#case-form [name="nc_first_name"]', "Rubee");
      await page.fill('#case-form [name="nc_last_name"]', "Sinclare");
      await page.fill('#case-form [name="nc_email"]', target.email);
      await page.click("#modal-save");
      await wait(page, 1000);
      const inline = await page.evaluate(() => ({
        ovl: !!document.querySelector("#dup-client-overlay"),
        match: (document.querySelector("#dup-client-overlay") || { dataset: {} }).dataset.match,
        label: ((document.querySelector("#dup-client-existing") || {}).textContent || "").trim(),
      }));
      ok("B7 · the inline door runs the SAME gate", inline.ovl === true && inline.match === "exact", JSON.stringify(inline));
      eq("B7 · …whose primary verb attaches rather than abandons the case form", inline.label, "Use the existing client");
      await page.click("#dup-client-existing");
      await wait(page, 1600);
      const inlineAfter = await page.evaluate(async (t) => {
        const { data: cs } = await window.__mockDb.from("cases").select("id,client_id").order("created_at", { ascending: false }).limit(1);
        return { attachedTo: cs[0].client_id, wanted: t.id };
      }, target);
      eq("B7 · the case landed on the EXISTING client", inlineAfter.attachedTo, target.id);
      eq("B7 · …and no client was inserted", await clientCount(), n1);

      // B8 — inline Create anyway still creates.
      await page.click("#new-case-btn");
      await wait(page, 800);
      await page.evaluate(() => {
        const sel = document.querySelector("#case-client-select");
        sel.value = "__new__";
        sel.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.fill('#case-form [name="nc_first_name"]', "Rubee");
      await page.fill('#case-form [name="nc_last_name"]', "Sinclare");
      await page.fill('#case-form [name="nc_email"]', target.email);
      await page.click("#modal-save");
      await wait(page, 1000);
      await page.click("#dup-client-create");
      await wait(page, 1600);
      const anyway = await page.evaluate(async () => {
        const { data: cl } = await window.__mockDb.from("clients").select("id,first_name").eq("first_name", "Rubee");
        const { data: cs } = cl.length ? await window.__mockDb.from("cases").select("id").eq("client_id", cl[0].id) : { data: [] };
        return { made: cl.length, attached: cs.length === 1 };
      });
      ok("B8 · inline Create anyway makes the client and points the case at it", anyway.made === 1 && anyway.attached === true, JSON.stringify(anyway));
      eq("§B · no console/page errors", realErrs(page), []);
      await page.close();
    }

    /* =======================================================================
       §C · B3 — the joint-lead accept overlay
       ===================================================================== */
    {
      console.log("\n— §C · the joint-lead overlay (p1 Kim)");
      const page = await boot(browser, "p1");
      await goto(page, "dashboard", 1500);

      // Two candidates the matcher will find, and a joint lead that finds them.
      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const a = (await db.from("clients").insert({ first_name: "Marta", last_name: "Quennell", email: "marta.q@example.com", phone: "07700 900771" }).select().single()).data;
        const b = (await db.from("clients").insert({ first_name: "Miles", last_name: "Quennell", email: "miles.q@example.com", phone: "07700 900772" }).select().single()).data;
        const mkLead = async (name, email) =>
          (await db.from("leads").insert({ name, email, phone: null, enquiry_type: "remortgage", message: "joint", status: "new" }).select().single()).data.id;
        return {
          a: a.id, b: b.id,
          lead1: await mkLead("Marta & Miles Quennell", "quennell.family@example.com"),
          lead2: await mkLead("Petra & Oskar Quennell", "quennell.two@example.com"),
          lead3: await mkLead("Marta & Miles Quennell", "quennell.three@example.com"),
          lead4: await mkLead("Sacha & Timo Vantongeren", "vantongeren@example.com"),
          lead5: await mkLead("Marta & Miles Quennell", "marta.q@example.com"),
        };
      });

      // C1 — one overlay, zero prompts, every candidate on the list.
      page.__dialogs.length = 0;
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead1);
      await wait(page, 1300);
      const joint = await page.evaluate(() => ({
        ovl: !!document.querySelector("#lead-joint-overlay"),
        note: (document.querySelector("#ljo-note") || {}).textContent || "",
        first: (document.querySelector("#ljo-first") || {}).value,
        last: (document.querySelector("#ljo-last") || {}).value,
        radios: [...document.querySelectorAll('#lead-joint-overlay input[name="ljo-pick"]')].map((r) => r.value),
        candText: (document.querySelector("#ljo-candidates") || {}).textContent || "",
      }));
      ok("C1 · accepting a joint lead opens ONE #lead-joint-overlay", joint.ovl === true, JSON.stringify(joint));
      eq("C1 · …and fires NO native prompt (the K-3 machine is gone)",
        page.__dialogs.filter((d) => d.type === "prompt").length, 0);
      ok("C1 · the joint-name note quotes the enquiry and says one name files it",
        joint.note.includes("Marta & Miles Quennell") && /one/.test(joint.note) && /case note/.test(joint.note), joint.note);
      eq("C1 · First/Surname arrive prefilled with the parsed guess", [joint.first, joint.last], ["Marta", "Quennell"]);
      ok("C1 · ALL candidate matches are listed as radios, plus Create-new — candidate #2 is finally pickable",
        joint.radios.includes(seeded.a) && joint.radios.includes(seeded.b) && joint.radios.includes("__new__"),
        JSON.stringify(joint.radios));
      ok("C1 · …each with its evidence", /Attach to Marta Quennell — same name, different contact details/.test(joint.candText)
        && /Attach to Miles Quennell — same surname and first initial/.test(joint.candText), joint.candText);

      // C2 — attach to candidate #2.
      await page.evaluate((bid) => {
        const r = document.querySelector(`#lead-joint-overlay input[value="${bid}"]`);
        r.checked = true;
      }, seeded.b);
      await page.click("#ljo-ok");
      await wait(page, 2200);
      const c2 = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("status,converted_case_id").eq("id", s.lead1).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", lead.converted_case_id);
        const quennells = (await window.__mockDb.from("clients").select("id,last_name")).data.filter((c) => c.last_name === "Quennell").length;
        return { status: lead.status, attachedTo: cs.client_id, notes: notes.map((n) => n.body), quennells };
      }, seeded);
      eq("C2 · candidate #2 got the case", c2.attachedTo, seeded.b);
      eq("C2 · …the lead converted", c2.status, "converted");
      eq("C2 · …and no new client was minted", c2.quennells, 2);
      ok("C2 · the second applicant landed on the case note", c2.notes.some((b) => /Joint applicant: Miles Quennell/.test(b)), JSON.stringify(c2.notes));

      // C3 — Create a new client (this pair's initials match nobody, so no candidate list).
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead2);
      await wait(page, 1300);
      const c3state = await page.evaluate(() => ({
        ovl: !!document.querySelector("#lead-joint-overlay"),
        cands: !!document.querySelector("#ljo-candidates"),
      }));
      ok("C3 · a joint lead whose names match nobody gets the overlay with no candidate furniture",
        c3state.ovl === true && c3state.cands === false, JSON.stringify(c3state));
      await page.click("#ljo-ok");
      await wait(page, 2200);
      const c3 = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", s.lead2).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        const { data: cl } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", cs.client_id).single();
        return cl;
      }, seeded);
      eq("C3 · a NEW client was filed under the parsed guess", c3, { first_name: "Petra", last_name: "Quennell" });

      // C4 — K-3's rule survives: emptied fields fall back to the guess, per field.
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead3);
      await wait(page, 1300);
      const c4pick = await page.evaluate(() => {
        const checked = document.querySelector('#lead-joint-overlay input[name="ljo-pick"]:checked');
        return checked ? checked.value : null;
      });
      eq("C4 · with candidates but no EXACT match, Create-new is the default answer", c4pick, "__new__");
      await page.fill("#ljo-first", "");
      await page.fill("#ljo-last", "");
      await page.evaluate(() => { document.querySelector('#lead-joint-overlay input[value="__new__"]').checked = true; });
      await page.click("#ljo-ok");
      await wait(page, 2200);
      const c4 = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", s.lead3).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        const { data: cl } = await window.__mockDb.from("clients").select("first_name,last_name").eq("id", cs.client_id).single();
        return cl;
      }, seeded);
      eq("C4 · K-3 — emptied fields file the parsed guess, never the doubled raw name",
        c4, { first_name: "Marta", last_name: "Quennell" });

      // C5 — Cancel ABORTS: the claim is undone and the enquiry stays acceptable.
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead4);
      await wait(page, 1300);
      const c5ovl = await page.evaluate(() => ({
        ovl: !!document.querySelector("#lead-joint-overlay"),
        cands: !!document.querySelector("#ljo-candidates"),
      }));
      ok("C5 · a joint lead with NO matches gets the overlay without a candidate list", c5ovl.ovl === true && c5ovl.cands === false, JSON.stringify(c5ovl));
      const clientsBeforeCancel = await page.evaluate(async () => (await window.__mockDb.from("clients").select("id")).data.length);
      await page.click("#ljo-cancel");
      await wait(page, 1500);
      const c5 = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("status,converted_case_id").eq("id", s.lead4).single();
        const n = (await window.__mockDb.from("clients").select("id")).data.length;
        return { lead, n, toast: (document.querySelector("#toast") || {}).textContent || "" };
      }, seeded);
      eq("C5 · Cancel puts the enquiry back in the inbox (status 'new', no case)",
        [c5.lead.status, c5.lead.converted_case_id], ["new", null]);
      eq("C5 · …and created nothing", c5.n, clientsBeforeCancel);
      ok("C5 · …and says so", /stays in the inbox/i.test(c5.toast), c5.toast);

      // C5b — the aborted lead can be accepted again (the claim really was released).
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead4);
      await wait(page, 1300);
      const again = await page.evaluate(() => !!document.querySelector("#lead-joint-overlay"));
      ok("C5b · the same lead re-opens the overlay on a second accept", again === true);
      await page.click("#ljo-ok");
      await wait(page, 2200);
      const c5b = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("status").eq("id", s.lead4).single();
        return lead.status;
      }, seeded);
      eq("C5b · …and converts this time", c5b, "converted");

      // C7 — an EXACT match (same email) defaults the answer to attaching to that client,
      // exactly as the old confirm's OK did.
      await page.evaluate((id) => { window.acceptLead(id, null); }, seeded.lead5);
      await wait(page, 1300);
      const c7 = await page.evaluate(() => {
        const checked = document.querySelector('#lead-joint-overlay input[name="ljo-pick"]:checked');
        return checked ? checked.value : null;
      });
      eq("C7 · an exact email match is the pre-picked answer", c7, seeded.a);
      await page.click("#ljo-ok");
      await wait(page, 2200);
      const c7after = await page.evaluate(async (s) => {
        const { data: lead } = await window.__mockDb.from("leads").select("converted_case_id").eq("id", s.lead5).single();
        const { data: cs } = await window.__mockDb.from("cases").select("client_id").eq("id", lead.converted_case_id).single();
        return cs.client_id;
      }, seeded);
      eq("C7 · …and OK attaches to it", c7after, seeded.a);

      // C6 — a NON-joint accept still uses the native did-you-mean confirms, untouched.
      const soloLead = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("leads")
          .insert({ name: "Duncan Armitage", email: "duncan.armitage@example.com", phone: null, enquiry_type: "remortgage", status: "new" })
          .select().single();
        return data.id;
      });
      page.__dialogs.length = 0;
      await page.evaluate((id) => { window.acceptLead(id, null); }, soloLead);
      await wait(page, 2200);
      const soloMsgs = page.__dialogs.filter((d) => d.type === "confirm").map((d) => d.message);
      ok("C6 · a non-joint lead keeps its native exact-match confirm, word for word",
        soloMsgs.some((m) => /A client already exists: Duncan Armitage/.test(m) && /matched on same email address/.test(m)),
        JSON.stringify(soloMsgs));
      const soloOvl = await page.evaluate(() => !!document.querySelector("#lead-joint-overlay"));
      eq("C6 · …and never sees the joint overlay", soloOvl, false);

      eq("§C · no console/page errors", realErrs(page), []);
      await page.close();
    }

    /* =======================================================================
       §D · B4 — the signed-out strip over open work
       ===================================================================== */
    {
      console.log("\n— §D · session loss under an open case modal (p1 Kim)");
      const page = await boot(browser, "p1");
      await goto(page, "pipeline", 1400);
      const caseId = await page.evaluate(async () =>
        (await window.__mockDb.from("cases").select("id").eq("stage", "application").limit(1)).data[0].id);
      await page.evaluate((id) => window.openCase(id), caseId);
      await wait(page, 1600);
      await page.evaluate(() => { document.querySelector("#new-note").value = "half-typed note the strip must preserve"; });

      // D0 — at rest the strip is hidden.
      const rest = await page.evaluate(() => document.querySelector("#signedout-strip").classList.contains("hidden"));
      eq("D0 · the strip is hidden while signed in", rest, true);

      // The session dies under the open modal (token expiry / sign-out elsewhere).
      await page.evaluate(() => { window.__mockDb.auth.signOut(); });
      await wait(page, 900);
      const out = await page.evaluate(() => ({
        strip: !document.querySelector("#signedout-strip").classList.contains("hidden"),
        text: document.querySelector("#signedout-strip").textContent.replace(/\s+/g, " ").trim(),
        modalOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        loginShown: !document.querySelector("#login-view").classList.contains("hidden"),
        saveDisabled: (document.querySelector("#modal-save") || {}).disabled === true,
        note: (document.querySelector("#new-note") || {}).value,
        closeBtnInStrip: !!document.querySelector("#signedout-strip button"),
      }));
      ok("D1 · the strip appears over the open modal", out.strip === true, JSON.stringify(out));
      ok("D1 · …saying to copy anything unsaved, then sign in again",
        /signed out/i.test(out.text) && /copy anything unsaved/i.test(out.text) && /sign in again/i.test(out.text), out.text);
      ok("D1 · the modal is NOT closed — the typing is preserved",
        out.modalOpen === true && out.note === "half-typed note the strip must preserve", JSON.stringify(out));
      eq("D1 · the modal's Save is disabled (it would only fail)", out.saveDisabled, true);
      eq("D1 · the strip is non-dismissable — no close control at all", out.closeBtnInStrip, false);
      eq("D1 · …and the login screen is showing underneath", out.loginShown, true);

      // Clicking the strip changes nothing (nothing to dismiss).
      await page.click("#signedout-strip");
      await wait(page, 300);
      const clicked = await page.evaluate(() => !document.querySelector("#signedout-strip").classList.contains("hidden"));
      eq("D2 · clicking it does not dismiss it", clicked, true);

      // Signing back in through the REAL login form clears the strip and re-enables Save.
      /* The login form sits UNDER the still-open modal (deliberately — the modal is preserved),
         so pointer clicks can't reach it; the strip's instruction is copy → close → sign in.
         Submit the real form programmatically instead: same handler, same signInWithPassword →
         showApp path a person's sign-in takes. */
      await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("profiles").select("email").eq("id", "p1").single();
        document.querySelector("#login-email").value = data.email;
        document.querySelector("#login-password").value = "anything-the-mock-accepts";
        document.querySelector("#login-form").requestSubmit();
      });
      await wait(page, 2400);
      const back = await page.evaluate(() => ({
        strip: document.querySelector("#signedout-strip").classList.contains("hidden"),
        modalOpen: !document.querySelector("#modal-backdrop").classList.contains("hidden"),
        saveEnabled: (document.querySelector("#modal-save") || {}).disabled === false,
        note: (document.querySelector("#new-note") || {}).value,
        residue: document.querySelectorAll("[data-signedout-disabled]").length,
      }));
      ok("D3 · signing back in hides the strip and re-enables Save",
        back.strip === true && back.saveEnabled === true && back.residue === 0, JSON.stringify(back));
      ok("D3 · …with the modal and its typing still exactly where they were",
        back.modalOpen === true && back.note === "half-typed note the strip must preserve", JSON.stringify(back));

      eq("§D · no console/page errors", realErrs(page), []);
      await page.close();

      // D4 — a sign-out with NO open modal shows no strip (the login screen is enough).
      const p2 = await boot(browser, "p1");
      await p2.evaluate(() => { window.__mockDb.auth.signOut(); });
      await wait(p2, 800);
      const plain = await p2.evaluate(() => ({
        strip: document.querySelector("#signedout-strip").classList.contains("hidden"),
        login: !document.querySelector("#login-view").classList.contains("hidden"),
      }));
      ok("D4 · with nothing open, sign-out shows the login screen and NO strip", plain.strip === true && plain.login === true, JSON.stringify(plain));
      await p2.close();
    }

    /* =======================================================================
       §E · B5 — fix the contact, be offered the retry
       ===================================================================== */
    {
      console.log("\n— §E · Fix contact carries the retry (p1 Kim)");
      const page = await boot(browser, "p1");
      await goto(page, "emails", 1600);

      const bounce = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("id,client_id,to_email,error").eq("status", "failed");
        return data.find((r) => /bounced/.test(r.error || ""));
      });
      ok("E0 · fixture — the hard-bounce row is there", !!bounce, JSON.stringify(bounce));

      // E1 — Fix contact opens the client fix-focused (the T1-2 contract, unchanged).
      await page.evaluate((em) => {
        const r = [...document.querySelectorAll("#email-list .row-item")].find((x) => x.textContent.includes(em));
        [...r.querySelectorAll("button")].find((b) => /Fix contact/.test(b.textContent)).click();
      }, bounce.to_email);
      await wait(page, 1300);
      const landed = await page.evaluate(() => ({
        form: !!document.querySelector("#client-form"),
        focused: (document.activeElement && document.activeElement.getAttribute("name")) || "",
        attempted: (document.querySelector("#client-attempted") || {}).textContent || "",
      }));
      ok("E1 · Fix contact still lands fix-focused on the client's email field",
        landed.form === true && landed.focused === "email" && landed.attempted.includes(bounce.to_email), JSON.stringify(landed));

      // E2 — correct the address, save: the toast now carries the retry.
      await page.fill('#client-form [name="email"]', "ross.corrected@example.com");
      await page.click("#modal-save");
      await wait(page, 1300);
      const t1 = await page.evaluate(() => ({
        toast: (document.querySelector("#toast") || {}).textContent || "",
        action: !!document.querySelector("#toast-action"),
        label: ((document.querySelector("#toast-action") || {}).textContent || "").trim(),
      }));
      ok("E2 · the saved toast offers the retry, naming the NEW address",
        t1.action === true && /retry the failed email to ross\.corrected@example\.com now\?/i.test(t1.toast), JSON.stringify(t1));
      eq("E2 · …with an explicit action verb", t1.label, "Retry now");

      // E3 — the action re-queues THAT row to the corrected address.
      await page.click("#toast-action");
      await wait(page, 1400);
      const requeued = await page.evaluate(async (id) =>
        (await window.__mockDb.from("email_queue").select("status,to_email,error").eq("id", id).single()).data, bounce.id);
      eq("E3 · the failed row is re-queued to the corrected address",
        [requeued.status, requeued.to_email], ["queued", "ross.corrected@example.com"]);
      ok("E3 · the bounce diagnostic is kept (T1-2's rule, unchanged)", /bounced/.test(requeued.error || ""), JSON.stringify(requeued));

      // E4 — a fix-focused save that did NOT change the field stays a plain save.
      const noEmailRow = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("email_queue").select("id,client_id,to_email,error").eq("status", "failed");
        return data.find((r) => /no email on file/i.test(r.error || ""));
      });
      ok("E4 · fixture — the no-address failure is there", !!noEmailRow, JSON.stringify(noEmailRow));
      await goto(page, "emails", 1300);
      await page.evaluate((cid) => {
        const r = [...document.querySelectorAll("#email-list .row-item")].find((x) => /no email on file/i.test(x.textContent));
        [...r.querySelectorAll("button")].find((b) => /Fix contact/.test(b.textContent)).click();
      }, noEmailRow.client_id);
      await wait(page, 1300);
      await page.click("#modal-save");
      await wait(page, 1200);
      const t2 = await page.evaluate(() => ({
        toast: (document.querySelector("#toast") || {}).textContent || "",
        action: !!document.querySelector("#toast-action"),
      }));
      ok("E4 · nothing changed → plain 'Client saved', no retry offered",
        t2.action === false && /Client saved/.test(t2.toast) && !/retry/i.test(t2.toast), JSON.stringify(t2));

      // E5 — the SMS path, same shape, via retrySms.
      const smsRow = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("sms_queue").select("id,client_id,to_phone,error").eq("status", "failed");
        return data.find((r) => /invalid/i.test(r.error || "") && r.client_id);
      });
      ok("E5 · fixture — a bad-number SMS failure is there", !!smsRow, JSON.stringify(smsRow));
      await goto(page, "emails", 1300);
      await page.evaluate((id) => {
        const rows = [...document.querySelectorAll("#page-emails .row-item")];
        const hit = rows.find((x) => [...x.querySelectorAll("button")].some((b) => (b.getAttribute("onclick") || "").includes(`fixContactOpen('sms','${id}'`)));
        [...hit.querySelectorAll("button")].find((b) => /Fix contact/.test(b.textContent)).click();
      }, smsRow.id);
      await wait(page, 1300);
      const smsLanded = await page.evaluate(() => (document.activeElement && document.activeElement.getAttribute("name")) || "");
      eq("E5 · the SMS fix lands on the phone field", smsLanded, "phone");
      await page.fill('#client-form [name="phone"]', "07700 900888");
      await page.click("#modal-save");
      await wait(page, 1300);
      const t3 = await page.evaluate(() => ({
        toast: (document.querySelector("#toast") || {}).textContent || "",
        action: !!document.querySelector("#toast-action"),
      }));
      ok("E5 · the toast offers the SMS retry, naming the new number",
        t3.action === true && /retry the failed SMS to 07700 900888 now\?/i.test(t3.toast), JSON.stringify(t3));
      await page.click("#toast-action");
      await wait(page, 1400);
      const smsAfter = await page.evaluate(async (id) =>
        (await window.__mockDb.from("sms_queue").select("status,to_phone").eq("id", id).single()).data, smsRow.id);
      eq("E5 · the SMS row is re-queued to the corrected number", [smsAfter.status, smsAfter.to_phone], ["queued", "07700 900888"]);

      // E6 — the context is consumed at open: a later PLAIN open of the same client
      // saves without any retry offer.
      const plainClient = bounce.client_id;
      await goto(page, "emails", 1200);
      await page.evaluate((cid) => window.openClient(cid), plainClient);
      await wait(page, 1300);
      await page.evaluate(() => { const d = document.querySelector("#modal .client-details"); if (d) d.open = true; });
      await page.fill('#client-form [name="notes"]', "plain save after a fix earlier");
      await page.click("#modal-save");
      await wait(page, 1200);
      const t4 = await page.evaluate(() => ({
        toast: (document.querySelector("#toast") || {}).textContent || "",
        action: !!document.querySelector("#toast-action"),
      }));
      ok("E6 · a plain open of the same client later never inherits the retry",
        t4.action === false && /Client saved/.test(t4.toast), JSON.stringify(t4));

      eq("§E · no console/page errors", realErrs(page), []);
      await page.close();
    }

  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { /* already gone */ } }
  }

  console.log(`\nR76 INTAKE: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
  process.exit(0);
})();
