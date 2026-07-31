#!/usr/bin/env node
/* =============================================================================
   tests/r5_batch4.js — acceptance tests for PLAN-R5 Batch 4
   ("Watchtower snooze & duplicate dismissals")

   One block per plan item:
     1. B5 / R5-22  snooze an alert with a date + required reason: it disappears from the
                    working list, survives "Run checks" (run_watchtower's ON CONFLICT upsert
                    never touches the M3 columns), reappears once the date passes, shows in the
                    "N snoozed" header toggle with its until-date/reason/Unsnooze, and a CRITICAL
                    alert's reason is also written to the case as a note. Feature-detects M3.
     2. B6 / R5-39  "Not a duplicate" sticks: any staff member can mark a flagged pair as not a
                    duplicate (from Data Health or from inside the merge modal); it disappears from
                    both the Data Health table and the client-detail duplicate hint, is logged to
                    the audit trail, a genuinely new duplicate still appears, an Owner/Admin can
                    Undo it, and the destructive Merge action stays Owner/Admin-only throughout.
                    Feature-detects M4.

   Run:  node /root/nx/tests/r5_batch4.js  (expects a static server on 8099;
                                            starts one itself if absent)
   ========================================================================== */
"use strict";

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
  page.__dialogPlan = [];
  page.on("dialog", async (d) => {
    page.__dialogs.push({ type: d.type(), message: d.message() });
    const next = page.__dialogPlan.length ? page.__dialogPlan.shift() : page.__dialogAnswer;
    if (next && typeof next === "object") { if (next.type === "dismiss") await d.dismiss(); else await d.accept(next.text); }
    else if (next === "dismiss") await d.dismiss();
    else await d.accept(typeof next === "string" ? next : undefined);
  });
  page.on("console", (m) => { if (m.type() === "error" && !/40[0-9]|net::ERR/.test(m.text())) page.__err = (page.__err || []).concat(m.text()); });
  page.on("pageerror", (e) => { page.__err = (page.__err || []).concat("pageerror: " + e.message); });
  await page.goto(`${BASE}?as=${persona}`);
  await page.waitForTimeout(SETTLE);
  return page;
}
const lastDialog = (page, re) => (page.__dialogs.filter((d) => re.test(d.message)).slice(-1)[0] || {}).message || "";
const openDrawer = async (page, panelId) => {
  const collapsed = await page.evaluate((p) => document.querySelector(p).classList.contains("collapsed"), panelId);
  if (collapsed) { await page.click(`${panelId} h3`, { position: { x: 12, y: 10 } }); await page.waitForTimeout(300); }
};

(async () => {
  let server = null;
  if (!(await serverUp())) {
    server = spawn("python3", ["-m", "http.server", String(PORT), "--directory", REPO], { stdio: "ignore", detached: true });
    for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  }
  const browser = await chromium.launch();
  try {
    /* ===================================================================
       1 · B5 / R5-22 — Watchtower: snooze with date + reason
       =================================================================== */
    console.log("\n— B5 / R5-22 · Watchtower snooze (p1 Kim)");
    {
      const page = await newPage(browser, "p1");
      await openDrawer(page, "#watchtower-panel");

      // Fixture check — a seeded CRITICAL erc_conflict alert on ca001, and the seeded
      // pre-snoozed protection_gap row (so "N snoozed" already has one entry on first load).
      const fixture = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
        const crit = data.find((a) => a.rule === "erc_conflict" && a.case_id === "ca001");
        const preSnoozed = data.find((a) => a.rule === "protection_gap" && a.snoozed_until);
        return {
          critId: crit && crit.id, critCase: crit && crit.case_id,
          preSnoozedId: preSnoozed && preSnoozed.id, preSnoozedCase: preSnoozed && preSnoozed.case_id, preSnoozedClient: preSnoozed && preSnoozed.client_id,
        };
      });
      ok("fixture · ca001 has a seeded CRITICAL erc_conflict alert", !!fixture.critId, JSON.stringify(fixture));
      ok("fixture · one alert already arrives pre-snoozed", !!fixture.preSnoozedId, JSON.stringify(fixture));

      ok("R5-22 · the pre-snoozed alert is hidden from the working list", await page.evaluate((id) => !document.querySelector("#watchtower-list").innerHTML.includes(`snoozeAlert('${id}'`), fixture.preSnoozedId));
      eq("R5-22 · the 'N snoozed' toggle starts at 1", await page.evaluate(() => document.querySelector("#watchtower-snoozed-toggle").textContent.trim()), "1 snoozed");

      // Snooze the ERC-conflict CRITICAL until +7d with a reason.
      const snoozeBtnSel = `#watchtower-list button[onclick*="snoozeAlert('${fixture.critId}'"]`;
      ok("R5-22 · the row offers a Snooze… action beside Dismiss", await page.evaluate((s) => !!document.querySelector(s), snoozeBtnSel));
      await page.click(snoozeBtnSel);
      await page.waitForTimeout(300);
      ok("R5-22 · the mini-overlay opens over the dashboard (not a full navigation)", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden")));

      // Reject: no reason.
      await page.click("#overlay-modal .snooze-chip[data-days='7']");
      await page.click("#snooze-ok");
      ok("R5-22 · a reason is required — the overlay stays open with an error", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden") && /reason is required/i.test(document.querySelector("#snooze-err").textContent)));

      // Reject: a date before tomorrow (custom date = today).
      const todayStr = await page.evaluate(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date()));
      await page.fill("#snooze-reason", "ERC conflict — client is aware, lender confirming a fix");
      await page.evaluate((t) => { document.querySelector("#snooze-date").value = t; }, todayStr);
      await page.click("#snooze-ok");
      ok("R5-22 · a date before tomorrow is refused", await page.evaluate(() => !document.querySelector("#overlay-backdrop").classList.contains("hidden") && /at least tomorrow/i.test(document.querySelector("#snooze-err").textContent)));

      // Now the real thing: +7d chip + reason.
      await page.click("#overlay-modal .snooze-chip[data-days='7']");
      await page.click("#snooze-ok");
      await page.waitForTimeout(400);
      ok("R5-22 · snoozing closes the overlay", await page.evaluate(() => document.querySelector("#overlay-backdrop").classList.contains("hidden")));
      ok("R5-22 · the alert is gone from the working list", await page.evaluate((cid) => !document.querySelector("#watchtower-list").innerHTML.includes(`openCase('${cid}')`), fixture.critCase));
      eq("R5-22 · the 'N snoozed' toggle now reads 2", await page.evaluate(() => document.querySelector("#watchtower-snoozed-toggle").textContent.trim()), "2 snoozed");

      const row = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").eq("id", id).single();
        return data;
      }, fixture.critId);
      ok("R5-22 · snoozed_until / snooze_note / snoozed_by are written", !!row.snoozed_until && row.snooze_note === "ERC conflict — client is aware, lender confirming a fix" && !!row.snoozed_by, JSON.stringify(row));

      // CRITICAL alerts also mirror the reason to the case as a note (dismiss pattern).
      const note = await page.evaluate(async (cid) => {
        const { data } = await window.__mockDb.from("case_notes").select("*").eq("case_id", cid).order("created_at", { ascending: false });
        return data[0];
      }, fixture.critCase);
      ok("R5-22 · the CRITICAL alert's reason is written to the case as a note", /snoozed/i.test(note.body) && note.body.includes("ERC conflict — client is aware"), JSON.stringify(note));

      // Snooze survives "Run checks" — run_watchtower's ON CONFLICT upsert never touches M3 columns.
      await page.click("#watchtower-run");
      await page.waitForTimeout(500);
      ok("R5-22 · still gone after Run checks (survives run_watchtower's upsert)", await page.evaluate((cid) => !document.querySelector("#watchtower-list").innerHTML.includes(`openCase('${cid}')`), fixture.critCase));
      const rowAfterRun = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("watch_alerts").select("snoozed_until,snooze_note").eq("id", id).single();
        return data;
      }, fixture.critId);
      ok("R5-22 · the snooze columns are untouched by Run checks", !!rowAfterRun.snoozed_until && rowAfterRun.snooze_note === "ERC conflict — client is aware, lender confirming a fix", JSON.stringify(rowAfterRun));

      // Fast-forward the snooze (test hook) → reappears automatically once the date passes.
      await page.evaluate((id) => window.__mock.expireSnooze(id), fixture.critId);
      await page.evaluate(() => window.loadWatchtower());
      await page.waitForTimeout(300);
      ok("R5-22 · reappears once snoozed_until is in the past", await page.evaluate((cid) => document.querySelector("#watchtower-list").innerHTML.includes(`openCase('${cid}')`), fixture.critCase));
      eq("R5-22 · the 'N snoozed' toggle drops back to 1", await page.evaluate(() => document.querySelector("#watchtower-snoozed-toggle").textContent.trim()), "1 snoozed");

      // Unsnooze from the header list.
      const warnAlert = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("watch_alerts").select("*").is("resolved_at", null);
        return (data.find((a) => a.severity !== "crit" && !a.snoozed_until) || {}).id;
      });
      ok("fixture · a non-CRITICAL alert exists to snooze for the Unsnooze check", !!warnAlert);
      await page.click(`#watchtower-list button[onclick*="snoozeAlert('${warnAlert}'"]`);
      await page.waitForTimeout(300);
      await page.click("#overlay-modal .snooze-chip[data-months='1']");
      await page.fill("#snooze-reason", "waiting on the client to come back from holiday");
      await page.click("#snooze-ok");
      await page.waitForTimeout(400);
      eq("R5-22 · the toggle reads 2 again after the second snooze", await page.evaluate(() => document.querySelector("#watchtower-snoozed-toggle").textContent.trim()), "2 snoozed");
      const noteCountBefore = await page.evaluate(async () => (await window.__mockDb.from("case_notes").select("id")).data.length);
      // no case-note requirement for a non-CRITICAL snooze
      const critNoteBody = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("watch_alerts").select("case_id").eq("id", id).single();
        if (!data.case_id) return "no case";
        const { data: notes } = await window.__mockDb.from("case_notes").select("body").eq("case_id", data.case_id);
        return notes.some((n) => /waiting on the client to come back from holiday/.test(n.body)) ? "wrote a note" : "no note";
      }, warnAlert);
      ok("R5-22 · a non-CRITICAL snooze does not write a case note", critNoteBody !== "wrote a note", critNoteBody);

      await page.click("#watchtower-snoozed-toggle");
      await page.waitForTimeout(200);
      ok("R5-22 · the snoozed list shows the until-date, reason and an Unsnooze button", await page.evaluate(() => {
        const html = document.querySelector("#watchtower-snoozed").innerHTML;
        return /waiting on the client to come back from holiday/.test(html) && />Unsnooze<\/button>/.test(html);
      }));
      await page.click("#watchtower-snoozed button[onclick*=\"unsnoozeAlert\"]");
      await page.waitForTimeout(400);
      eq("R5-22 · Unsnooze puts it straight back on the working list (toggle back to 1)", await page.evaluate(() => document.querySelector("#watchtower-snoozed-toggle").textContent.trim()), "1 snoozed");

      // Feature-detect: M3 off → toast, not a crash.
      await page.evaluate(() => window.__mock.setMigrations({ m3: false }));
      await page.evaluate(() => window.loadWatchtower());
      await page.waitForTimeout(300);
      const anySnoozeBtn = await page.evaluate(() => document.querySelector("#watchtower-list button[onclick^='snoozeAlert']")?.getAttribute("onclick"));
      const anyId = anySnoozeBtn ? anySnoozeBtn.match(/'([^']+)'/)[1] : null;
      if (anyId) {
        await page.click(`#watchtower-list button[onclick*="snoozeAlert('${anyId}'"]`);
        await page.waitForTimeout(300);
        await page.click("#overlay-modal .snooze-chip[data-days='7']");
        await page.fill("#snooze-reason", "m3-off check");
        await page.click("#snooze-ok");
        await page.waitForTimeout(300);
        const m3Toast = await page.evaluate(() => document.querySelector("#toast")?.textContent || "");
        ok("R5-22 · feature-detect — M3 off surfaces 'Snooze needs migration M3', not a crash", m3Toast === "Snooze needs migration M3", m3Toast);
      } else ok("fixture · an alert existed to try snoozing with M3 off", false, "none found");
      await page.evaluate(() => window.__mock.setMigrations({ m3: true }));

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       2 · B6 / R5-39 — "Not a duplicate" that sticks
       =================================================================== */
    console.log("\n— B6 / R5-39 · Not-a-duplicate (Data Health)");
    {
      const page = await newPage(browser, "p1");
      await page.evaluate(() => window.nav("data"));
      await page.waitForTimeout(800);

      ok("fixture · Gordon Pike / G Pike are flagged as a possible duplicate", await page.evaluate(() => [...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Pike"))));
      ok("fixture · Deborah/Debbie Ashworth are ALSO flagged (the genuinely-new-duplicate control)", await page.evaluate(() => [...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Ashworth"))));

      // The client-detail duplicate hint shows the same pair before dismissal.
      await page.evaluate(() => window.openClient("cl005"));
      await page.waitForTimeout(500);
      ok("R5-39 · the client record shows the duplicate hint before dismissal", await page.evaluate(() => /Possible duplicate of/.test(document.querySelector(".dup-hint")?.textContent || "")));
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);

      // Dismiss from the Data Health row.
      page.__dialogAnswer = "not the same person — different builder, different Gordon";
      await page.evaluate(() => {
        const row = [...document.querySelectorAll("#data-content .imp-table tr")].find((r) => r.textContent.includes("Pike"));
        const btn = [...row.querySelectorAll("button")].find((b) => b.textContent.trim() === "Not a duplicate");
        btn.click();
      });
      await page.waitForTimeout(500);
      ok("R5-39 · the dismiss prompt names both clients", /Gordon Pike/.test(lastDialog(page, /Mark/)) && /G Pike/.test(lastDialog(page, /Mark/)));
      ok("R5-39 · gone from the Data Health table", await page.evaluate(() => ![...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Pike"))));
      ok("R5-39 · a genuinely new duplicate (Ashworth) still appears", await page.evaluate(() => [...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Ashworth"))));
      ok("R5-39 · footer reads '1 pair marked not-duplicates'", await page.evaluate(() => /1 pair marked not-duplicates/.test(document.body.innerHTML)));

      // Audit trail.
      const audit = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("audit_log").select("*").eq("table_name", "duplicate_dismissals");
        return data[data.length - 1];
      });
      ok("R5-39 · the insert is in the audit log", audit && audit.action === "insert" && /Pike/.test(audit.summary), JSON.stringify(audit));

      // Stored sorted (a_id < b_id) per the M4 constraint.
      const row = await page.evaluate(async () => (await window.__mockDb.from("duplicate_dismissals").select("*")).data[0]);
      ok("R5-39 · stored normalised (a_id < b_id)", row.a_id < row.b_id, JSON.stringify(row));

      // The client-detail hint honours the same dismissal.
      await page.evaluate(() => window.openClient("cl005"));
      await page.waitForTimeout(500);
      ok("R5-39 · the client-detail duplicate hint is gone too", !(await page.evaluate(() => !!document.querySelector(".dup-hint"))));
      await page.evaluate(() => window.closeModal());
      await page.waitForTimeout(300);

      // "Across users" — the harness has no real cross-browser persistence (every table is
      // page-local memory; see R5-5's "no sticky store" test in r5_batch1.js for the same
      // constraint), so this proves the part that matters: the row is gated by the M4 RLS policy
      // ("dup dismiss read staff" — any staff role), not by who inserted it.
      const visibleToAdviser = await page.evaluate(() => window.__mock.readTableAs("p2", "duplicate_dismissals"));
      const visibleToIntroducer = await page.evaluate(() => window.__mock.readTableAs("p5", "duplicate_dismissals"));
      ok("R5-39 · the dismissal is readable by ANY staff role, not just the dismisser", visibleToAdviser.length === 1 && visibleToAdviser[0].a_id === row.a_id);
      eq("R5-39 · but withheld from a non-staff role (introducer)", visibleToIntroducer.length, 0);

      // Undo — Owner/Admin only. p1 (admin) can.
      await page.click('a[onclick="toggleDismissedDupsPanel()"]');
      await page.waitForTimeout(200);
      ok("R5-39 · the dismissed-pairs list shows who dismissed it and why", await page.evaluate(() => /not the same person/.test(document.querySelector("#dh-dismissed-list").textContent) && /Kim Martin/.test(document.querySelector("#dh-dismissed-list").textContent)));
      await page.click("#dh-dismissed-list button");
      await page.waitForTimeout(400);
      ok("R5-39 · Undo restores it — Pike reappears in the duplicates table", await page.evaluate(() => [...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Pike"))));
      eq("R5-39 · the dismissals table is empty again", await page.evaluate(async () => (await window.__mockDb.from("duplicate_dismissals").select("id")).data.length), 0);

      // Merge modal also offers "Not a duplicate" (openMergeClients).
      await page.evaluate(() => {
        const row = [...document.querySelectorAll("#data-content .imp-table tr")].find((r) => r.textContent.includes("Pike"));
        const btn = [...row.querySelectorAll("button")].find((b) => b.textContent.includes("Merge"));
        btn.click();
      });
      await page.waitForTimeout(400);
      ok("R5-39 · the merge modal itself offers Not a duplicate", await page.evaluate(() => !!document.querySelector("#merge-not-dup")));
      page.__dialogAnswer = "spotted while merging";
      await page.click("#merge-not-dup");
      await page.waitForTimeout(500);
      ok("R5-39 · using it from the merge modal closes the modal", await page.evaluate(() => document.querySelector("#modal-backdrop").classList.contains("hidden")));
      ok("R5-39 · …and dismisses the pair the same way", await page.evaluate(() => ![...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Pike"))));
      // Clean up for the M4 feature-detect check below.
      await page.evaluate(async () => { const { data } = await window.__mockDb.from("duplicate_dismissals").select("id"); for (const r of data) await window.__mockDb.from("duplicate_dismissals").delete().eq("id", r.id); });

      // Feature-detect: M4 off → the button is hidden (Data Health AND the merge modal), not offered-then-failing.
      await page.evaluate(() => window.__mock.setMigrations({ m4: false }));
      await page.evaluate(() => window.loadDataHealth());
      await page.waitForTimeout(500);
      ok("R5-39 · feature-detect — M4 off hides 'Not a duplicate' in Data Health", await page.evaluate(() => ![...document.querySelectorAll("#data-content button")].some((b) => b.textContent.trim() === "Not a duplicate")));
      await page.evaluate(() => {
        const row = [...document.querySelectorAll("#data-content .imp-table tr")].find((r) => r.textContent.includes("Pike"));
        const btn = [...row.querySelectorAll("button")].find((b) => b.textContent.includes("Merge"));
        btn.click();
      });
      await page.waitForTimeout(400);
      ok("R5-39 · feature-detect — M4 off hides it in the merge modal too", await page.evaluate(() => !document.querySelector("#merge-not-dup")));
      await page.evaluate(() => window.closeModal());
      await page.evaluate(() => window.__mock.setMigrations({ m4: true }));

      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }

    /* ===================================================================
       3 · B6 — any staff can dismiss; Merge and Undo stay Owner/Admin-only
       =================================================================== */
    console.log("\n— B6 / R5-39 · role gating (p3 Luke, adviser)");
    {
      const page = await newPage(browser, "p3");
      await page.evaluate(() => window.nav("data"));
      await page.waitForTimeout(800);
      const row = await page.evaluate(() => {
        const r = [...document.querySelectorAll("#data-content .imp-table tr")].find((x) => x.textContent.includes("Pike"));
        return r ? r.innerHTML : null;
      });
      ok("R5-39 · adviser sees the merge-gate badge, not a Merge button", row && row.includes("merge: Owner / Admin") && !row.includes("openMergeClients"));
      ok("R5-39 · adviser still gets the Not-a-duplicate action", row && row.includes("Not a duplicate"));
      page.__dialogAnswer = "adviser call — different family";
      await page.evaluate(() => {
        const r = [...document.querySelectorAll("#data-content .imp-table tr")].find((x) => x.textContent.includes("Pike"));
        const btn = [...r.querySelectorAll("button")].find((b) => b.textContent.trim() === "Not a duplicate");
        btn.click();
      });
      await page.waitForTimeout(500);
      ok("R5-39 · the adviser's dismissal took", await page.evaluate(() => ![...document.querySelectorAll("#data-content .imp-table tr")].some((r) => r.textContent.includes("Pike"))));
      const auditActor = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("audit_log").select("*").eq("table_name", "duplicate_dismissals");
        return data[data.length - 1].actor_label;
      });
      eq("R5-39 · audit records the adviser as the actor", auditActor, "Luke Richards");
      ok("R5-39 · Undo is NOT offered to an adviser", await page.evaluate(() => !document.querySelector("#dh-dismissed-list button") && document.body.innerHTML.includes("undo: Owner / Admin")));
      ok("no console errors", !page.__err, JSON.stringify(page.__err));
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) { try { process.kill(-server.pid, "SIGTERM"); } catch (_) { } }
  }

  console.log(`\nBATCH4: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
