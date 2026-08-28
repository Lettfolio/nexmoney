#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch8.js — acceptance tests for PLAN-R5 Batch 8
   ("Settings: per-adviser identity & admin visibility")

   One block per plan item:
     1. B4 UI (R5-8)  per-adviser phone & sign-off:
        (a) the Owner's team roster rows gain Phone / Email sign-off inputs that write
            profiles.phone / profiles.email_signoff straight away (on blur);
        (b) every signed-in staff member gets a "My details" card on Settings — works
            despite the read-only banner, self-service via M1's self-update policy, no
            role field on it;
        (c) a role change attempted from the console is still refused server-side even
            from a non-Owner session, whatever this batch does to the rest of the page;
        (d) the composed email (mock process-emails) picks up the new phone/sign-off for
            the case's adviser;
        (e) feature-detect — an un-migrated database (M1 off) hides the card and the
            roster's contact inputs instead of failing on save.
     2. R5-24  admin read-only roster: an Administrator (isAdminOrOwner() but not Owner)
        sees the team panel with the invite/create-login block hidden and the roster
        itself rendered read-only — name, role badge, holdings summary (including a
        role='none' member) — with zero interactive controls, while role changes stay
        refused server-side.

   Run:  node /root/nx/tests/r5_batch8.js  (expects a static server on 8099;
                                            starts one itself if absent)
   ========================================================================== */
"use strict";

/* R73 · A3 — THE CASE ACTION BAR IS CAPPED NOW, so a stage action may be one press away.
   The bar was 135px of a 900px desktop viewport and 445px of an 844px phone because every action
   CASE_ACTION_RULES calls primary at a stage sat on it — twelve buttons on a completed case.
   R73 keeps the two or three the stage is actually about on the bar and moves the rest into the
   Actions ▾ menu, under a heading naming the stage; every act-* id is built exactly once, with
   the same label and the same handler, and every one is reachable in at most one extra press.
   Same shape r13 and r5_batch1 have used since R15: find out where the action currently is, open
   the overflow only if that is where it is, then click it exactly as before. */
async function r73OpenAction(page, id) {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return true;                       // absent: let the click fail as it always would
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }, `#${id}`);
  if (!visible) await page.click("#case-more-actions-toggle");
}


const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;
const SETTLE = 1500;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
    r.setTimeout(1500, () => { r.destroy(); res(false); });
  });
}

async function newPage(browser, persona) {
  const page = await browser.newPage();
  page.__dialogs = [];
  page.__dialogAnswer = "accept";
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    if (page.__dialogAnswer === "dismiss") await d.dismiss();
    else await d.accept();
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const gotoSettings = async (page) => {
  // R33 — Settings now sits inside the collapsible "Firm" group, folded by default for an
  // adviser (p2/p3): a raw click on the nav button would target a display:none element and
  // time out for those personas. window.nav() is the same route the button's own click
  // handler ends up calling and works for every persona (nav() itself auto-expands the group
  // when it lands on a page inside it), so this one change fixes every gotoSettings() call in
  // this file without needing to special-case which persona is calling it.
  await page.evaluate(() => window.nav("settings"));
  await page.waitForTimeout(1200);
};
const readProfile = (page, id) => page.evaluate((pid) =>
  window.__mockDb.from("profiles").select("id,full_name,role,phone,email_signoff").eq("id", pid).single().then((r) => r.data), id);

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1a · Owner's roster rows gain Phone / Email sign-off inputs
       =================================================================== */
    console.log("\n— B4 UI · Owner's roster gains Phone / Email sign-off inputs (p4 Daniel, owner)");
    {
      const page = await newPage(browser, "p4");
      await gotoSettings(page);

      ok("fixture · roster is interactive for the Owner (role selects present)",
        await page.evaluate(() => document.querySelectorAll("#team-roster select.team-role").length > 0));

      const before = await readProfile(page, "p2");
      eq("fixture · Wayne's seeded phone/sign-off show up in the roster row",
        await page.evaluate(() => ({
          phone: document.querySelector('#team-roster input.team-phone[data-id="p2"]').value,
          signoff: document.querySelector('#team-roster textarea.team-signoff[data-id="p2"]').value,
        })),
        { phone: before.phone, signoff: before.email_signoff });

      await page.fill('#team-roster input.team-phone[data-id="p2"]', "07700 555111");
      await page.evaluate(() => document.querySelector('#team-roster input.team-phone[data-id="p2"]').dispatchEvent(new Event("blur")));
      await page.waitForTimeout(500);
      await page.fill('#team-roster textarea.team-signoff[data-id="p2"]', "Wayne K\nSenior Adviser\n07700 555111");
      await page.evaluate(() => document.querySelector('#team-roster textarea.team-signoff[data-id="p2"]').dispatchEvent(new Event("blur")));
      await page.waitForTimeout(500);

      const after = await readProfile(page, "p2");
      eq("B4 UI · the phone field wrote profiles.phone straight away (on blur)", after.phone, "07700 555111");
      eq("B4 UI · the sign-off field wrote profiles.email_signoff straight away (on blur)", after.email_signoff, "Wayne K\nSenior Adviser\n07700 555111");

      // Re-render the roster (as a fresh nav would) and confirm the saved values still show.
      await page.evaluate(() => window.renderTeamRoster());
      await page.waitForTimeout(400);
      eq("B4 UI · the roster still shows the saved values after a re-render",
        await page.evaluate(() => ({
          phone: document.querySelector('#team-roster input.team-phone[data-id="p2"]').value,
          signoff: document.querySelector('#team-roster textarea.team-signoff[data-id="p2"]').value,
        })),
        { phone: "07700 555111", signoff: "Wayne K\nSenior Adviser\n07700 555111" });

      /* -----------------------------------------------------------------
         1d · The mock process-emails compose() picks up Wayne's new phone
         and sign-off on the very next send for one of his cases.
         ----------------------------------------------------------------- */
      await page.evaluate(() => window.openCase("ca017")); // Louise Garnham — assigned to Wayne (p2)
      await page.waitForTimeout(600);
      const hasReminderBtn = await page.evaluate(() => !!document.querySelector("#act-reminder") && !document.querySelector("#act-reminder").classList.contains("hidden"));
      if (hasReminderBtn) {
        await r73OpenAction(page, "act-reminder"); await page.click("#act-reminder");
        await page.waitForTimeout(1200);
        const composed = await page.evaluate(() => (window.__mock.lastEmailRun().composed || [])[0] || null);
        ok("B4 UI (prod parity) · the composed email signs off with the new name/phone",
          composed && composed.adviser_name === "Wayne Kellow" && composed.adviser_phone === "07700 555111",
          JSON.stringify(composed));
        ok("B4 UI (prod parity) · …and the multi-line sign-off, not the settings fallback",
          composed && composed.signoff_source === "profile" && composed.signoff.join("|") === "Wayne K|Senior Adviser|07700 555111",
          JSON.stringify(composed));
      } else {
        ok("fixture · ca017 offered a reminder to send (compose parity check skipped otherwise)", false, "no #act-reminder button");
      }
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       1b/1c · "My details" card — every staff role, self-service, no role
       field, still refused a role change from the console
       =================================================================== */
    console.log("\n— B4 UI · \"My details\" card (p2 Wayne, adviser)");
    {
      const page = await newPage(browser, "p2");
      await gotoSettings(page);

      ok("B4 UI · the read-only banner is shown (adviser, not Owner)", await page.evaluate(() => !!document.querySelector("#settings-readonly-note")));
      ok("B4 UI · …but it now says the My details card still saves",
        await page.evaluate(() => /My details.*edit and save|edit\s+and\s+save those/i.test(document.querySelector("#settings-readonly-note").textContent)));

      ok("B4 UI · the \"My details\" card is visible for an adviser despite the read-only banner",
        await page.evaluate(() => !document.querySelector("#my-details-panel").classList.contains("hidden")));
      ok("B4 UI · its inputs are NOT disabled (unlike the settings form above)",
        await page.evaluate(() => !document.querySelector("#my-phone").disabled && !document.querySelector("#my-signoff").disabled));
      ok("B4 UI · the helper text explains what it's for",
        await page.evaluate(() => /sign off automated emails to your clients/i.test(document.querySelector("#my-details-panel").textContent)));
      ok("B4 UI · there is no role field on the card (role stays Owner-only)",
        await page.evaluate(() => !document.querySelector("#my-details-panel select") && !/role/i.test(document.querySelector("#my-details-panel h3").nextElementSibling.textContent)));

      const before = await readProfile(page, "p2");
      eq("fixture · the card is pre-filled with Wayne's current phone/sign-off",
        await page.evaluate(() => ({ phone: document.querySelector("#my-phone").value, signoff: document.querySelector("#my-signoff").value })),
        { phone: before.phone, signoff: before.email_signoff });

      await page.fill("#my-phone", "01202 900777");
      await page.fill("#my-signoff", "Wayne Kellow\nAdviser\n01202 900777");
      await page.click("#save-my-details-btn");
      await page.waitForTimeout(700);
      ok("B4 UI · a \"Saved\" confirmation appears", await page.evaluate(() => !document.querySelector("#my-details-saved").classList.contains("hidden")));
      const after = await readProfile(page, "p2");
      eq("B4 UI · Wayne's own phone was saved", after.phone, "01202 900777");
      eq("B4 UI · Wayne's own sign-off was saved", after.email_signoff, "Wayne Kellow\nAdviser\n01202 900777");

      // A role change attempted straight from the console — the M1 self-update policy still
      // blocks it (guard_role_change), whatever this batch does to the rest of Settings.
      const roleAttempt = await page.evaluate(async () => {
        const r = await window.__mockDb.from("profiles").update({ role: "owner" }).eq("id", "p2");
        return { error: r.error ? r.error.message : null };
      });
      ok("B4 UI · a role change via console is still refused (guard_role_change)",
        !!roleAttempt.error && /Only an Owner can change a role/i.test(roleAttempt.error), JSON.stringify(roleAttempt));
      const stillAdviser = await readProfile(page, "p2");
      eq("B4 UI · …and the role is unchanged", stillAdviser.role, "adviser");
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       1e · Feature-detect — M1 off hides the card / roster inputs instead
       of failing, and a save mid-session degrades gracefully
       =================================================================== */
    console.log("\n— B4 UI · feature-detect (M1 off)");
    {
      // (i) A save attempted after M1 is disabled mid-session degrades: a clear toast, the
      // card hides itself rather than silently pretending the write worked.
      const p2 = await newPage(browser, "p2");
      await gotoSettings(p2);
      ok("fixture · the card is visible before M1 is disabled", await p2.evaluate(() => !document.querySelector("#my-details-panel").classList.contains("hidden")));
      await p2.evaluate(() => window.__mock.setMigrations({ m1: false }));
      await p2.fill("#my-phone", "01202 900000");
      await p2.click("#save-my-details-btn");
      await p2.waitForTimeout(600);
      const toast = await p2.evaluate(() => (document.querySelector("#toast") || {}).textContent || "");
      ok("B4 UI · the save explains the missing migration instead of erroring", /migration M1/i.test(toast), JSON.stringify(toast));
      ok("B4 UI · …and hides the card so a further edit isn't offered", await p2.evaluate(() => document.querySelector("#my-details-panel").classList.contains("hidden")));
      await p2.evaluate(() => window.__mock.setMigrations({ m1: true }));
      await p2.close();

      // (ii) A fresh load of Settings against an already-un-migrated database shows neither
      // the card nor the roster's contact inputs, without failing the page.
      const p4 = await newPage(browser, "p4");
      await p4.evaluate(() => window.__mock.setMigrations({ m1: false }));
      await p4.evaluate(async () => {
        const { data: { session } } = await window.__mockDb.auth.getSession();
        await window.loadTeam(session);
        await window.renderSettings();
      });
      await p4.waitForTimeout(600);
      const state = await p4.evaluate(() => ({
        cardHidden: document.querySelector("#my-details-panel").classList.contains("hidden"),
        rosterContactInputs: document.querySelectorAll("#team-roster input.team-phone, #team-roster textarea.team-signoff").length,
        roleSelects: document.querySelectorAll("#team-roster select.team-role").length,
      }));
      eq("B4 UI · the \"My details\" card is hidden on an un-migrated database", state.cardHidden, true);
      eq("B4 UI · the roster shows no phone/sign-off inputs either", state.rosterContactInputs, 0);
      ok("B4 UI · the roster itself still renders (role selects unaffected by M1)", state.roleSelects > 0);
      await p4.evaluate(() => window.__mock.setMigrations({ m1: true }));
      ok("no console errors", !p4.__err, JSON.stringify(p4.__err));
      await p4.close();
    }

    /* ===================================================================
       2 · R5-24 — admin read-only roster
       =================================================================== */
    console.log("\n— R5-24 · admin read-only roster (p1 Kim, admin)");
    {
      const page = await newPage(browser, "p1");
      await gotoSettings(page);

      ok("R5-24 · the Team panel is visible for an Admin (not hidden outright)",
        await page.evaluate(() => !document.querySelector("#team-logins-panel").classList.contains("hidden")));
      ok("R5-24 · …but the invite/create-login block stays Owner-only and is hidden",
        await page.evaluate(() => document.querySelector("#team-invite-block").classList.contains("hidden")));
      ok("R5-24 · the caption says role changes/handovers are Owner-only",
        await page.evaluate(() => /Owner-only/i.test(document.querySelector("#team-roster-caption").textContent)));

      await page.waitForTimeout(600); // roster holdings are fetched async
      const rows = await page.evaluate(() => [...document.querySelectorAll("#team-roster .team-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim()));
      eq("R5-24 · the roster lists all 5 staff/former-staff profiles", rows.length, 5);
      const priya = rows.find((t) => /Priya Raman/.test(t));
      ok("R5-24 · Priya Raman (role='none') is on the list", !!priya, JSON.stringify(rows));
      ok("R5-24 · …marked No access", priya && /No access/.test(priya), priya);
      ok("R5-24 · …and shown holding 1 case", priya && /1 case/.test(priya), priya);
      ok("R5-24 · Wayne's row shows his Adviser role badge", rows.some((t) => /Wayne Kellow/.test(t) && /Adviser/.test(t)), JSON.stringify(rows));

      const controls = await page.evaluate(() => ({
        selects: document.querySelectorAll("#team-roster select").length,
        inputs: document.querySelectorAll("#team-roster input").length,
        textareas: document.querySelectorAll("#team-roster textarea").length,
        buttons: document.querySelectorAll("#team-roster button").length,
      }));
      eq("R5-24 · zero interactive controls anywhere in the roster", controls, { selects: 0, inputs: 0, textareas: 0, buttons: 0 });

      // Role changes are refused server-side regardless of what the UI shows an Admin.
      const roleAttempt = await page.evaluate(async () => {
        const r = await window.__mockDb.from("profiles").update({ role: "owner" }).eq("id", "p3");
        return { error: r.error ? r.error.message : null };
      });
      ok("R5-24 · a role-change attempt from an Admin session is still refused",
        !!roleAttempt.error && /Only an Owner can change a role/i.test(roleAttempt.error), JSON.stringify(roleAttempt));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* An adviser (neither Owner nor Admin) still sees nothing at all — unchanged from before
       this batch: the roster is an Owner/Admin surface, not a general staff one. */
    console.log("\n— R5-24 · a plain adviser still sees no Team panel (p3 Luke, adviser)");
    {
      const page = await newPage(browser, "p3");
      await gotoSettings(page);
      ok("R5-24 · the Team panel stays hidden for an ordinary adviser",
        await page.evaluate(() => document.querySelector("#team-logins-panel").classList.contains("hidden")));
      ok("R5-24 · …the \"My details\" card is still there for them, though",
        await page.evaluate(() => !document.querySelector("#my-details-panel").classList.contains("hidden")));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid); } catch (e) {} }
  }

  console.log(`\nBATCH 8: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  ✗ " + f)); process.exit(1); }
})();
