#!/usr/bin/env node
/* =============================================================================
   tests/r62.js — acceptance tests for R62 (the R61 leftovers)

   §A  EMAILS CURRENT-FIRST — the All view orders queued → failed → sent →
       cancelled (newest-first inside each group), cancelled rows carry the
       dimming class, and a picked status chip is untouched (already one group).
   §B  FEE-STATUS WEIGHTING — the pipeline tables render paid (green) and
       requested (amber) as the only loud states; waived / not requested are
       wallpaper-weight; the cell's textContent is unchanged (r24 contract).
   §C  SETTINGS BANDS — the section summaries carry the banded class styling
       hooks (.settings-details > summary), and both sections still render.

   Run:  node /root/nx/tests/r62.js
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

async function ensureServer() {
  const up = await new Promise((res) => {
    const req = http.get(`http://localhost:${PORT}/admin/mock.html`, (r) => { r.resume(); res(r.statusCode === 200); });
    req.on("error", () => res(false));
  });
  if (up) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore", detached: true });
  await new Promise((r) => setTimeout(r, 1200));
  return srv;
}

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${BASE}?as=p1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  /* ================= §A · emails current-first ================= */
  console.log("— §A · Emails: the All view leads with what still matters");
  // fixtures: guarantee at least one of each status, cancelled CREATED NEWEST (the old order
  // would have put it top of the list)
  await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").select("id,email").not("email", "is", null).limit(1);
    const cid = cl[0].id, em = cl[0].email;
    const mk = (status) => db.from("email_queue").insert({ client_id: cid, to_email: em, email_type: "rate_end_reminder", status });
    await mk("sent"); await mk("failed"); await mk("queued"); await mk("cancelled");
  });
  await page.evaluate(() => { location.hash = "#emails"; });
  await page.waitForTimeout(1500);
  /* R74 (panel A#8): the Emails page now OPENS on "Needs you" (queued + failed), so the sent and
     cancelled history this section is about is one chip away rather than on screen. §A is a
     statement about the ALL view's ordering, so it asks for the All view first — the assertion
     itself is unchanged. */
  await page.click("#em-chip-all");
  await page.waitForTimeout(900);
  const a = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#email-list .row-item")].filter((r) => r.querySelector(".badge"));
    const statuses = rows.map((r) => {
      const m = r.className.match(/qrow-(\w+)/);
      return m ? m[1] : null;
    }).filter(Boolean);
    const rank = { queued: 0, sending: 0, failed: 1, sent: 2, cancelled: 3 };
    const seq = statuses.map((s) => rank[s] ?? 2);
    return {
      n: statuses.length,
      sorted: seq.every((v, i) => i === 0 || v >= seq[i - 1]),
      first: statuses[0], last: statuses[statuses.length - 1],
      dimmed: [...document.querySelectorAll("#email-list .row-item.qrow-cancelled")].length,
      hasCancelled: statuses.includes("cancelled"), hasQueued: statuses.includes("queued"),
    };
  });
  ok("A1 · rows carry their status class and appear grouped, never interleaved", a.n > 0 && a.sorted, JSON.stringify(a));
  ok("A2 · queued leads and cancelled trails — despite being created newest", a.hasQueued && a.hasCancelled && a.first === "queued" && a.last === "cancelled", JSON.stringify(a));
  ok("A3 · cancelled rows carry the dimming class", a.dimmed >= 1, `dimmed=${a.dimmed}`);
  // picking a chip still filters to exactly that status
  await page.click("#em-chip-cancelled");
  await page.waitForTimeout(900);
  const a4 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#email-list .row-item")].filter((r) => r.className.match(/qrow-/));
    return rows.length > 0 && rows.every((r) => r.className.includes("qrow-cancelled"));
  });
  ok("A4 · the Cancelled chip still shows exactly the cancelled rows", a4);
  await page.click("#em-chip-all");
  await page.waitForTimeout(600);

  /* ================= §B · fee-status weighting ================= */
  console.log("\n— §B · Pipeline: the fee-status column, weighted");
  await page.evaluate(async () => {
    // ensure a spread: one paid, one requested, one waived among completed cases
    const db = window.__mockDb;
    const { data: cs } = await db.from("cases").select("id").eq("stage", "completed").limit(3);
    await db.from("cases").update({ fee_status: "paid", broker_fee: 500 }).eq("id", cs[0].id);
    await db.from("cases").update({ fee_status: "requested", broker_fee: 400 }).eq("id", cs[1].id);
    await db.from("cases").update({ fee_status: "waived" }).eq("id", cs[2].id);
    window.gotoPipelineSegment ? window.gotoPipelineSegment("completed") : (location.hash = "#pipeline");
  });
  await page.waitForTimeout(1800);
  const b = await page.evaluate(() => {
    const spans = [...document.querySelectorAll("#table-wrap .fee-st")];
    const byCls = (c) => spans.filter((s) => s.classList.contains(c)).map((s) => s.textContent.trim());
    return {
      total: spans.length,
      paid: byCls("fee-st-paid"), requested: byCls("fee-st-requested"), quiet: byCls("fee-st-quiet"),
    };
  });
  ok("B1 · fee-status cells render with weight classes", b.total > 0, JSON.stringify(b));
  ok("B2 · paid is loud-green with its text intact (r24 contract)", b.paid.length >= 1 && b.paid.every((t) => t === "paid"), JSON.stringify(b.paid));
  ok("B3 · requested is loud-amber (money still owed)", b.requested.length >= 1 && b.requested.every((t) => t === "requested"), JSON.stringify(b.requested));
  ok("B4 · waived / not requested are wallpaper-weight, text preserved", b.quiet.length >= 1 && b.quiet.every((t) => /waived|not requested/.test(t)), JSON.stringify(b.quiet.slice(0, 4)));

  /* ================= §C · settings bands ================= */
  console.log("\n— §C · Settings: banded section summaries");
  await page.evaluate(() => { location.hash = "#settings"; });
  await page.waitForTimeout(1200);
  const c = await page.evaluate(() => {
    const secs = [...document.querySelectorAll("#settings-form details.settings-details")];
    return {
      n: secs.length,
      summaries: secs.map((d) => d.querySelector("summary")?.textContent.trim().slice(0, 30)),
      styled: secs.every((d) => {
        const s = getComputedStyle(d.querySelector("summary"));
        return s.textTransform === "uppercase" && s.borderLeftWidth !== "0px";
      }),
    };
  });
  ok("C1 · both settings sections render", c.n >= 2, JSON.stringify(c.summaries));
  ok("C2 · the summaries wear the contrast band (uppercase + left border)", c.styled, JSON.stringify(c));

  const realErrors = errors.filter((e) => !/ERR_TUNNEL|Failed to fetch|sheetjs/i.test(e));
  ok("no page errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

  console.log(`\nR62: ${pass} passed, ${failures.length} failed`);
  if (srv) try { process.kill(-srv.pid); } catch (e) { /* already gone */ }
  await browser.close();
  process.exit(failures.length ? 1 : 0);
})();
