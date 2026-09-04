#!/usr/bin/env node
/* =============================================================================
   tests/r82_correct.js — acceptance tests for R82 build A, "put it right".

   R82 is a FIX round. Every section below pins a defect that was verified
   against the live production database by discovery panel #6, so each one
   states the wrong behaviour it replaces as well as the right one it demands.

   §A  A1 · THE COMPLIANCE GATE. settings.financial_promotions_approved was
       read in exactly ONE enforcement point in the whole system (the
       queue_automated_emails RPC, gating referral_request only) while BOTH
       protection_offer queue paths — the row's own Email button and R80's
       bulk "Queue protection intro" — inserted straight into email_queue and
       immediately fired a scoped send at what they had written. Production
       runs with the switch OFF. Both paths must now refuse, name the switch
       and where it lives, write NOTHING — and both must still work the moment
       an Owner approves. Plus: the two UI strings must no longer over-promise,
       and edge/process-emails-v20.ts must carry the send-time refusal.
   §B  A2 · THE BOARD-CACHE LIVELOCK. R76's stale-board guard detected a
       colleague's change off its own fresh read, toasted "…refreshing the
       board" and called loadPipeline() — which repainted the same session
       cache, because no write had happened in THIS tab. Press again, same
       toast, for ever; only F5 escaped. Pressing the control twice must
       CONVERGE: the second press is against the truth.
   §C  A2 · THE SAME SHAPE ON THE PROTECTION CALL LIST. protCache has
       boardCache's lifetime rule, so a colleague recording policy_taken left
       the ranked list re-offering that client for the rest of the session.
   §D  A3 · ROUTING TO PEOPLE WHO HAVE NEVER LOGGED IN. 1,575 of 2,017 cases —
       119 of the 130 OPEN ones — are assigned to staff who have never signed
       in, because leastLoadedAdviser ranks by open cases + open tasks and a
       dormant desk scores perfectly on both, permanently. The new live RPC
       get_staff_activity() is consumed DEFENSIVELY (missing ⇒ behave exactly
       as before), the exclusion mirrors the away-today rule including its
       empty-pool waiver, and the bulk retention path finally has the
       "assign to me" control the single row has had since R12b.
   §E  A4 · SCOPE KEYS LEAK BETWEEN USERS. nx_board_adviser / nx_diary_staff /
       nx_clients_adviser were stored un-namespaced against this file's own
       stated rule, and a stored value OUTRANKS the signed-in user's default —
       so on a shared browser Wayne's first Pipeline, Diary and Clients pages
       all opened filtered to Daniel Potts.
   §F  A5 · CONFLICT RECOVERY DESTROYED THE OTHER PERSON'S EDIT. The R18
       updated_at guard fired correctly and then the app said "Save again to
       overwrite" — which replayed ~40 opened-at form fields over a colleague's
       change and toasted the bare words "Case saved".
   §G  A6 · TODAY'S PROTECTION TAB IGNORED "MINE". loadProtection had no
       assigned_to filter and no scope control, so signed in as Wayne — who
       carries nothing — every panel on Today read 0 except this one, which
       listed five strangers with "discuss protection" beside each.
   §H  A7 · NO PHONE NUMBER ON THE PROTECTION PAGE. The firm's best revenue
       surface ("best 250 of 1,516 opportunities") carried zero tel: and zero
       sms: across the table, the call list and the GI band, because the RPC
       returns has_email and no phone — so every call cost a case modal.
   §I  A8 · WORK ASSIGNED TO SOMEBODY NEVER REACHED THEM. A task assigned to
       Wayne and due in ten days appeared on no page in this app except a Diary
       walked forward a month.
   §J  A9 · THE FREE 290ms. Google Fonts was render-blocking on every load.

   Standing rules obeyed: ground truth read from window.__mockDb at runtime,
   never hardcoded; PLAYWRIGHT-AWAIT (poll for the condition, never sleep and
   hope); a "colleague's" write that must NOT bust this tab's caches is made
   against the fixture arrays (window.__mock.db), because a write through
   window.__mockDb goes through the app's own db.from choke point and busts
   them — which is the whole thing these sections are about.

   Run:  node /root/nx/tests/r82_correct.js
   (Copy to /tmp and patch REPO/PORT to run against a worktree — HARNESS.md.)
   ========================================================================== */
"use strict";

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const REPO = "/root/nx";
const PORT = 8099;
const BASE = `http://localhost:${PORT}/admin/mock.html`;

let pass = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

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

const DESK = { width: 1400, height: 950 };
async function boot(browser, persona, initScript) {
  const ctx = await browser.newContext({ viewport: DESK });
  const page = await ctx.newPage();
  if (initScript) await page.addInitScript(initScript);
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
  await page.waitForTimeout(300);
  return page;
}
/* PLAYWRIGHT-AWAIT — poll for a condition rather than sleeping and hoping. */
async function waitFor(page, fn, arg, timeout = 9000) {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await page.waitForTimeout(120);
  }
}
const toastText = (page) => page.evaluate(() => (document.getElementById("toast") || {}).textContent || "");
const clearToast = (page) => page.evaluate(() => { const t = document.getElementById("toast"); if (t) { t.textContent = ""; t.classList.add("hidden"); } });
async function goPage(page, name, settle = 1600) {
  await page.evaluate((n) => window.nav(n), name);
  await page.waitForTimeout(settle);
}
/* The one way this suite turns the financial-promotions master switch on or off: write the
   fixture settings row and make the app re-read it, exactly as its own save path does. */
const setPromos = (page, on) => page.evaluate(async (v) => {
  const rows = window.__mock.db.settings;
  const row = rows.filter((r) => r.key === "financial_promotions_approved")[0];
  if (row) row.value = v; else rows.push({ key: "financial_promotions_approved", value: v });
  await window.__reloadSettings();
}, on ? "on" : "off");

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  try {
    /* =====================================================================
       §A · A1 — the compliance gate, on BOTH protection_offer paths
       ===================================================================== */
    console.log("\n— §A · A1 · financial promotions OFF must refuse both protection queue paths (p4 Daniel, owner)");
    {
      const page = await boot(browser, "p4");
      await setPromos(page, false);   // production's state, and the fixture's default
      const off = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("settings").select("value").eq("key", "financial_promotions_approved").maybeSingle();
        return String((data || {}).value ?? "off");
      });
      eq("A0 · precondition: the master switch is OFF (as production runs it)", off, "off");

      await goPage(page, "protection", 2500);
      const rowIds = await page.evaluate(() => [...document.querySelectorAll("#prot-list-table .prot-cb")].map((b) => b.dataset.id));
      ok("A0b · the call list has rows to act on", rowIds.length >= 2, String(rowIds.length));

      /* ---- the row's own Email button ---- */
      const qBefore = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      await clearToast(page);
      await page.evaluate((id) => window.protQueueEmail(id, null), rowIds[0]);
      await page.waitForTimeout(900);
      const t1 = await toastText(page);
      ok("A1a · the row's Email button REFUSES and says the switch is off",
        /financial promotions are switched OFF/i.test(t1), t1);
      ok("A1b · …and says exactly where to change it",
        /Settings › Rules that block work/.test(t1) && /Financial promotions approved/.test(t1), t1);
      ok("A1c · …and says nothing was queued and nothing was sent",
        /nothing was queued and nothing was sent/i.test(t1), t1);
      const overlayUp = await page.evaluate(() => {
        const b = document.querySelector("#overlay-backdrop");
        return !!b && !b.classList.contains("hidden");
      });
      eq("A1d · it refuses BEFORE the confirm — no overlay was raised at all", overlayUp, false);
      const qMid = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      eq("A1e · NOT a silent no-op with a write behind it — zero new protection_offer rows", qMid - qBefore, 0);

      /* ---- the bulk path ---- */
      await page.check(`#prot-list-table .prot-cb[data-id="${rowIds[0]}"]`);
      await page.check(`#prot-list-table .prot-cb[data-id="${rowIds[1]}"]`);
      await clearToast(page);
      await page.click("#prot-bulk-intro");
      await page.waitForTimeout(900);
      const t2 = await toastText(page);
      ok("A2a · the BULK button refuses too, in the same words",
        /financial promotions are switched OFF/i.test(t2) && /Settings › Rules that block work/.test(t2), t2);
      const bulkBox = await page.evaluate(() => !!document.querySelector("#prot-bulk-intro-box"));
      eq("A2b · …before the batch overlay is even built", bulkBox, false);
      const qAfter = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      eq("A2c · still zero new protection_offer rows", qAfter - qBefore, 0);

      /* ---- and it is a GATE, not a removal: approve, and both work ---- */
      await setPromos(page, true);
      await clearToast(page);
      await page.click("#prot-bulk-intro");
      const ov = await waitFor(page, () => {
        const b = document.querySelector("#prot-bulk-intro-box");
        return b ? { go: (b.querySelector("#prot-bulk-intro-go") || {}).textContent || "" } : null;
      });
      ok("A3a · with the switch ON the bulk overlay opens exactly as R80 built it", !!ov && /Queue \d+ email/.test(ov.go), ov && ov.go);
      await page.click("#prot-bulk-intro-go");
      await page.waitForTimeout(2200);
      const qOn = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      ok("A3b · …and it queues again — the switch gates, it does not delete the feature", qOn > qBefore, `${qBefore} → ${qOn}`);

      /* ---- the two UI strings must state what is enforced, not what was hoped ---- */
      await setPromos(page, false);
      await goPage(page, "settings", 3000);
      const note = await page.evaluate(() => (document.querySelector("#setting-note-financial_promotions_approved") || {}).textContent || "");
      ok("A4a · the Settings note no longer makes the old blanket promise",
        note.length > 0 && !/never leave, whatever their own switches say/i.test(note), note.slice(0, 120));
      ok("A4b · …it names the queueing job, the two protection buttons and the send-time cancel",
        /nightly queueing job/i.test(note) && /Queue protection intro/i.test(note) && /cancel/i.test(note), note.slice(0, 400));
      ok("A4c · …and it is honest that nothing in this app queues a GI email at all",
        /no button anywhere in this app that queues one/i.test(note), note.slice(-260));
      ok("A4d · …and it says what the switch does NOT touch",
        /rate-end reminders/i.test(note) && /not financial promotions/i.test(note), note.slice(0, 500));
      const golive = await page.evaluate(() => (document.querySelector("#golive-promos") || {}).textContent || "");
      ok("A4e0 · the go-live checklist carries the financial-promotions row", /Financial promotions approved/.test(golive), golive.slice(0, 120));
      ok("A4e · …and it states the same three enforcement points, not the old blanket claim",
        /never queued/i.test(golive) && /refuse/i.test(golive) && /cancelled at send time/i.test(golive)
        && !/none of them sends while this is off/i.test(golive), golive.slice(0, 420));
      ok("no console errors (§A)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* ---- the server-side belt: edge/process-emails-v20.ts ---- */
    console.log("\n— §A · A1 · edge/process-emails-v20.ts = v19 plus a send-time refusal, marked v20:");
    {
      const v19 = fs.readFileSync(path.join(REPO, "edge/process-emails-v19.ts"), "utf8");
      const v20p = path.join(REPO, "edge/process-emails-v20.ts");
      ok("A5a · the v20 source is versioned in the repo", fs.existsSync(v20p), v20p);
      const v20 = fs.existsSync(v20p) ? fs.readFileSync(v20p, "utf8") : "";
      ok("A5b · it names the three financial-promotion types and only those",
        /const FIN_PROMO_TYPES = \["referral_request", "protection_offer", "gi_exchange"\];/.test(v20), "FIN_PROMO_TYPES");
      ok("A5c · MARKETING_TYPES (the unsubscribe list) is left exactly as v19 had it — a different question",
        v20.includes('const MARKETING_TYPES = ["birthday_greeting", "completion_anniversary", "referral_request", "review_request"];'), "MARKETING_TYPES");
      ok("A5d · an unapproved promotion is CANCELLED with the reason on the row, not failed and not left queued",
        /status: "cancelled", error: "financial promotions not approved \(settings\.financial_promotions_approved\)"/.test(v20), "cancel + error");
      ok("A5e · …and counted in results beside v19's skipped_optout",
        /skipped_optout: 0, skipped_promos: 0/.test(v20) && /results\.skipped_promos\+\+/.test(v20), "skipped_promos");
      ok("A5f · the default is fail-closed (an absent settings row means nobody has approved anything)",
        /\(s\.financial_promotions_approved \?\? "off"\) !== "on"/.test(v20), "?? off");
      ok("A5g · every change is marked `v20:` exactly as v19 marked its own",
        (v20.match(/v20:/g) || []).length >= 3, String((v20.match(/v20:/g) || []).length));
      /* THE REPLICA RULE (HARNESS, binding): previewComposeEmail is a byte-exact client-side
         replica of the edge function's wording. v20 adds no template, no sentence and no subject —
         it CANCELS the row before compose() is ever reached — so the replica is untouched, and
         this check proves it: every line v19 and v20 share is identical apart from the three
         additions above, and none of them is inside a template. */
      const v19Lines = v19.split("\n"), v20Lines = v20.split("\n");
      const added = v20Lines.filter((l) => !v19Lines.includes(l));
      const removed = v19Lines.filter((l) => !v20Lines.includes(l));
      ok("A5h · exactly ONE v19 line is replaced (the results initialiser) — no template line changes",
        removed.length === 1 && /const results: any/.test(removed[0]), JSON.stringify(removed).slice(0, 200));
      ok("A5i · nothing added touches compose(): no client-facing sentence moves, so the app-side replica needs no change",
        added.every((l) => !/<p>|inner|subject =|`<p/.test(l)), JSON.stringify(added.filter((l) => /<p>|inner|subject =/.test(l))).slice(0, 200));
    }

    /* =====================================================================
       §B · A2 — the board-cache livelock: two presses must CONVERGE
       ===================================================================== */
    console.log("\n— §B · A2 · a stale-board refusal re-reads, so the second press is against the truth (p1 Kim)");
    {
      const page = await boot(browser, "p1");
      await goPage(page, "pipeline", 2500);
      /* A card at Enquiry: its Advance goes to Fact find, which raises no stage-entry prompt, so
         the two presses this section makes are a clean repro and nothing else. */
      const target = await page.evaluate(() => {
        const c = [...document.querySelectorAll('#board .card[data-stage="enquiry"]')].find((el) => el.querySelector(".card-advance"));
        return c ? { id: c.dataset.id, stage: c.dataset.stage } : null;
      });
      ok("B0 · found an Enquiry card with an Advance control", !!target, JSON.stringify(target));

      /* THE COLLEAGUE. Written against the fixture array, NOT through window.__mockDb: a write
         through the client would pass the app's own db.from choke point and bust boardCache,
         which is exactly the thing this tab never gets to see when the writer is another tab. */
      const moved = await page.evaluate((id) => {
        const row = window.__mock.db.cases.filter((c) => c.id === id)[0];
        if (!row) return null;
        row.stage = "fact_find";
        row.updated_at = new Date().toISOString();
        return row.stage;
      }, target.id);
      eq("B1 · a colleague advanced the case underneath this tab (fixture write, no cache bust)", moved, "fact_find");

      await clearToast(page);
      await page.click(`#board .card[data-id="${target.id}"] .card-advance`);
      await page.waitForTimeout(1000);
      const t1 = await toastText(page);
      ok("B2 · the R76 guard still fires and still names where the case actually went",
        /moved to .* since this board loaded — refreshing the board/i.test(t1), t1);

      /* THE FIX. "Refreshing the board" has to MEAN it: the repainted card must carry the stage
         the database holds, not the one the session snapshot was cut with. */
      const repainted = await waitFor(page, (id) => {
        const c = document.querySelector(`#board .card[data-id="${id}"]`);
        return c && c.dataset.stage === "fact_find" ? c.dataset.stage : null;
      }, target.id);
      eq("B3 · the refusal's own reload genuinely RE-READ — the card repaints at the true stage", repainted, "fact_find");

      await clearToast(page);
      const second = await page.evaluate(async (id) => {
        const c = document.querySelector(`#board .card[data-id="${id}"]`);
        if (!c) return { err: "card gone" };
        const btn = c.querySelector(".card-advance");
        if (!btn) return { err: "no advance control" };
        btn.click();
        return { pressedFrom: c.dataset.stage };
      }, target.id);
      await page.waitForTimeout(1400);
      const t2 = await toastText(page);
      eq("B4 · the second press is baked from the TRUE stage", second.pressedFrom, "fact_find");
      ok("B5 · …so it does NOT repeat the stale refusal — the loop is broken",
        !/since this board loaded/i.test(t2), t2);
      const dbStage = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("stage").eq("id", id).single();
        return (data || {}).stage;
      }, target.id);
      ok("B6 · …and the move it was refusing actually happens on the second press",
        dbStage !== "fact_find" && dbStage !== "enquiry", String(dbStage));
      ok("no console errors (§B)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §C · A2 — the same shape on the Protection call list (protCache)
       ===================================================================== */
    console.log("\n— §C · A2 · a colleague recording policy_taken must not leave the list re-offering that client (p4)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "protection", 2500);
      const pick = await page.evaluate(() => {
        const cb = document.querySelector("#prot-list-table .prot-cb");
        return cb ? cb.dataset.id : null;
      });
      ok("C0 · the ranked call list is offering a case", !!pick, String(pick));

      // The colleague again: fixture write, so nothing in this tab busts protCache.
      const set = await page.evaluate((id) => {
        const row = window.__mock.db.cases.filter((c) => c.id === id)[0];
        if (!row) return null;
        row.protection_status = "policy_taken";
        row.updated_at = new Date().toISOString();
        return row.protection_status;
      }, pick);
      eq("C1 · a colleague wrote the policy underneath this session's snapshot", set, "policy_taken");

      await clearToast(page);
      await page.evaluate((id) => window.protLogCall(id), pick);
      await page.waitForTimeout(1000);
      const t = await toastText(page);
      ok("C2 · Log call REFUSES rather than opening a call about a settled policy",
        /already recorded as/i.test(t) && /Policy taken/i.test(t), t);
      const modalUp = await page.evaluate(() => {
        const b = document.querySelector("#overlay-backdrop");
        return !!b && !b.classList.contains("hidden");
      });
      eq("C3 · …before the log-call overlay opens", modalUp, false);
      const gone = await waitFor(page, (id) => {
        const rows = [...document.querySelectorAll("#prot-list-table .prot-cb")].map((b) => b.dataset.id);
        return rows.length && !rows.includes(id) ? true : null;
      }, pick);
      eq("C4 · …and the refusal's reload RE-READ the RPC — the settled case has left the list", gone, true);

      await setPromos(page, true);   // so the promo gate is not what refuses below
      const pick2 = await page.evaluate(() => {
        const cb = document.querySelector("#prot-list-table .prot-cb");
        return cb ? cb.dataset.id : null;
      });
      await page.evaluate((id) => {
        const row = window.__mock.db.cases.filter((c) => c.id === id)[0];
        if (row) { row.protection_status = "declined"; row.updated_at = new Date().toISOString(); }
      }, pick2);
      const qBefore = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      await clearToast(page);
      await page.evaluate((id) => window.protQueueEmail(id, null), pick2);
      await page.waitForTimeout(1000);
      const t2 = await toastText(page);
      ok("C5 · the client-facing verb gets the same guard — no intro email to a settled case",
        /already recorded as/i.test(t2) && /Declined/i.test(t2), t2);
      const qAfter = await page.evaluate(async () => (await window.__mockDb.from("email_queue").select("id", { count: "exact", head: true }).eq("email_type", "protection_offer")).count);
      eq("C6 · …and nothing was queued", qAfter - qBefore, 0);
      ok("no console errors (§C)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §D · A3 — routing to people who have never logged in
       ===================================================================== */
    console.log("\n— §D · A3 · get_staff_activity is consumed defensively, and dormant desks leave the SUGGESTION (p1 Kim)");
    {
      /* §D1 pins the RPC-ABSENT path, and agent B has since registered get_staff_activity in the
         mock — so the absence has to be ASKED FOR rather than assumed. m12 is the mock's migration
         toggle for it: off ⇒ the function does not exist ⇒ 42883, which is exactly the production
         state this app must survive. §D2/§D3 below shim the RPC in-page and are unaffected. */
      const page = await boot(browser, "p1", () => { window.__mockMigrations = { m12: false }; });

      /* D1 — THE DEFENSIVE HALF, and it is the half that ships first. The mock does not register
         get_staff_activity yet (it is agent B's file), so the RPC answers 42883 — and the app must
         behave EXACTLY as it did before this round: no activity data, no exclusion, no guessing. */
      const before = await page.evaluate(() => ({
        supported: typeof STAFF_ACTIVITY_SUPPORTED === "undefined" ? "missing" : STAFF_ACTIVITY_SUPPORTED,
        rr: window.leastLoadedAdviser(),
        pool: window.advisingStaff().map((p) => p.id),
        anyNever: window.advisingStaff().some((p) => window.neverSignedIn(p.id)),
      }));
      eq("D1a · a missing RPC is recorded as 'no activity data', never as 'everyone is dormant'", before.supported, false);
      eq("D1b · …so nobody is treated as never-signed-in", before.anyNever, false);
      ok("D1c · …and the suggestion is exactly what it was before R82", before.pool.includes(before.rr), JSON.stringify(before));

      /* D2 — THE LIVE HALF. get_staff_activity() is deployed in production NOW; the mock does not
         carry it yet. Shim it in-page with the EXACT shape the CTO shipped — no arguments, a JSON
         array of { id, has_signed_in, last_sign_in_at, invited_at }, one entry per profile — which
         is also this suite's written record of that shape for whoever registers it in the mock. */
      const shim = async (dormantIds) => page.evaluate(async (dormant) => {
        if (!window.__realRpc) window.__realRpc = window.db.rpc.bind(window.db);
        const all = (typeof PROFILES !== "undefined" ? PROFILES : []).map((p) => p.id);   // PROFILES is a lexical global, not a window property
        window.db.rpc = function (name, args) {
          if (name === "get_staff_activity") {
            return Promise.resolve({
              data: all.map((id) => ({
                id,
                has_signed_in: !dormant.includes(id),
                last_sign_in_at: dormant.includes(id) ? null : new Date().toISOString(),
                invited_at: new Date(Date.now() - 86400000 * 30).toISOString(),
              })),
              error: null,
            });
          }
          return window.__realRpc(name, args);
        };
        return await window.loadStaffActivity();
      }, dormantIds);

      const twoDormant = before.pool.slice(0, Math.max(1, before.pool.length - 1));
      const okLoad = await shim(twoDormant);
      eq("D2a · the RPC's shape is accepted and recorded", okLoad, true);
      const afterA = await page.evaluate((d) => ({
        supported: STAFF_ACTIVITY_SUPPORTED,
        dormantFlagged: d.every((id) => window.neverSignedIn(id)),
        rr: window.leastLoadedAdviser(),
        opts: window.leadAdviserOptionsHtml(),
        title: window.leadLoadTitle(window.leastLoadedAdviser()),
      }), twoDormant);
      eq("D2b · STAFF_ACTIVITY_SUPPORTED flips true once the RPC answers", afterA.supported, true);
      eq("D2c · every profile the RPC reported as has_signed_in:false is flagged", afterA.dormantFlagged, true);
      ok("D2d · the routing SUGGESTION is no longer a dormant desk",
        afterA.rr && !twoDormant.includes(afterA.rr), JSON.stringify({ rr: afterA.rr, dormant: twoDormant }));
      ok("D2e · they stay in the dropdown, selectable, LABELLED — the away rule's own treatment",
        twoDormant.every((id) => new RegExp(`<option value="${id}"[^>]*>[^<]*\\(never signed in\\)`).test(afterA.opts)),
        afterA.opts.slice(0, 400));
      ok("D2f · the exclusion is said out loud beside the control, not left to be inferred",
        /never signed in is skipped for this suggestion; they are still in the list, labelled/.test(afterA.title), afterA.title.slice(-320));

      /* D3 — THE EMPTY-POOL WAIVER, mirroring R13 · M-31's away rule exactly: a lead that cannot
         be routed is worse than a lead routed to a dormant desk, and the label says which it is. */
      await shim(before.pool);
      const afterAll = await page.evaluate(() => ({
        rr: window.leastLoadedAdviser(),
        title: window.leadLoadTitle(window.leastLoadedAdviser()),
        order: window.leadRoundRobinOrder ? window.leadRoundRobinOrder() : null,
      }));
      ok("D3a · when EVERY advising colleague is dormant the exclusion is waived, not obeyed into silence",
        !!afterAll.rr && before.pool.includes(afterAll.rr), JSON.stringify(afterAll.rr));
      ok("D3b · …and the tooltip says the waiver happened rather than claiming a lightest desk",
        /Nobody who advises has ever signed in, so this is the lightest desk regardless/.test(afterAll.title), afterAll.title.slice(-300));
      ok("D3c · the accept-all round-robin shares the same pool and the same waiver",
        Array.isArray(afterAll.order) && afterAll.order.length > 0, JSON.stringify(afterAll.order));
      ok("no console errors (§D routing)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* ---- D4 · the bulk retention path finally gets "assign to me" ---- */
    console.log("\n— §D · A3 · bulk retention start offers 'assign to me' and honours it (p1 Kim)");
    {
      const page = await boot(browser, "p1");
      /* Two completed cases whose rate ends inside the nine-month window, on unique buildings (so
         the sold-property pre-flight has nothing to say), both inherited by p2. */
      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const ymd = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
        const mk = async (n) => {
          const { data: cl } = await db.from("clients").insert({ first_name: "Rowena", last_name: "Bulkret" + n, email: `rowena.bulkret${n}@example.com` }).select("id").single();
          const { data: ca } = await db.from("cases").insert({
            client_id: cl.id, case_kind: "remortgage", stage: "completed", lender: "Skipton",
            loan_amount: 210000, rate_end_date: ymd(90), assigned_to: "p2",
            property_address: `${n} Bulkret Row, Bournemouth BH9 9Z${n}`,
          }).select("id").single();
          return ca.id;
        };
        return [await mk(1), await mk(2)];
      });
      ok("D4a · seeded two eligible completed cases inherited by a colleague", seeded.length === 2 && seeded.every(Boolean), JSON.stringify(seeded));

      // Mark that colleague dormant, so the overlay's own warning has something true to say.
      await page.evaluate(async () => {
        if (!window.__realRpc) window.__realRpc = window.db.rpc.bind(window.db);
        const all = (typeof PROFILES !== "undefined" ? PROFILES : []).map((p) => p.id);   // PROFILES is a lexical global, not a window property
        window.db.rpc = function (name, args) {
          if (name === "get_staff_activity") {
            return Promise.resolve({ data: all.map((id) => ({ id, has_signed_in: id !== "p2", last_sign_in_at: null, invited_at: null })), error: null });
          }
          return window.__realRpc(name, args);
        };
        await window.loadStaffActivity();
      });

      page.evaluate((ids) => { window.__bulkRet = bulkStartRetentionRun(ids); }, seeded).catch(() => {});
      const ov = await waitFor(page, () => {
        const b = document.querySelector("#bulkret-tome");
        return b ? {
          label: (document.querySelector("#bulkret-tome-label") || {}).textContent || "",
          dormant: (document.querySelector("#bulkret-dormant") || {}).textContent || "",
        } : null;
      });
      ok("D4b · the bulk confirm offers 'assign to me' — the control the single row has had since R12b",
        !!ov && /Assign all 2 to me instead/.test(ov.label), ov && ov.label.slice(0, 200));
      ok("D4c · …and says how many would otherwise land elsewhere",
        !!ov && /2 of the 2 would otherwise go to the adviser on the completed case/.test(ov.label), ov && ov.label.slice(0, 220));
      ok("D4d · …and names the dormant desk they would otherwise land on",
        !!ov && /never signed in/i.test(ov.dormant), ov && ov.dormant.slice(0, 220));

      await page.check("#bulkret-tome");
      await page.click("#bulkret-ok");
      await page.waitForTimeout(3500);
      const outcome = await page.evaluate(async (ids) => {
        const db = window.__mockDb;
        const { data: succ } = await db.from("cases").select("id,assigned_to,retention_source_case_id").in("retention_source_case_id", ids);
        const { data: tasks } = await db.from("case_tasks").select("assigned_to,title").in("case_id", (succ || []).map((s) => s.id));
        return { n: (succ || []).length, owners: [...new Set((succ || []).map((s) => s.assigned_to))], taskOwners: [...new Set((tasks || []).map((t) => t.assigned_to))] };
      }, seeded);
      eq("D4e · both retention cases were created", outcome.n, 2);
      eq("D4f · …assigned to ME, not to the dormant adviser they were inherited from", outcome.owners, ["p1"]);
      eq("D4g · …and the call task follows the same one value (case, task and reminder never disagree)", outcome.taskOwners, ["p1"]);
      const t = await toastText(page);
      ok("D4h · the tally says out loud that they came to you", /assigned to you/i.test(t), t);
      ok("no console errors (§D bulk)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §E · A4 — the three scope keys are per user, and legacy is dropped
       ===================================================================== */
    console.log("\n— §E · A4 · nx_board_adviser / nx_diary_staff / nx_clients_adviser are namespaced per user");
    {
      const page = await boot(browser, "p2");
      await goPage(page, "pipeline", 2000);
      await page.selectOption("#board-adviser", "p3");
      await page.waitForTimeout(1200);
      const keys = await page.evaluate(() => ({
        namespaced: localStorage.getItem("nx_board_adviser_p2"),
        bare: localStorage.getItem("nx_board_adviser"),
      }));
      eq("E1a · an actual pick persists under the signed-in user's own key", keys.namespaced, "p3");
      eq("E1b · …and nothing is written to the shared, un-namespaced key", keys.bare, null);

      await goPage(page, "clients", 2500);
      await page.selectOption("#client-adviser", "all");
      await page.waitForTimeout(1200);
      const ck = await page.evaluate(() => ({
        namespaced: localStorage.getItem("nx_clients_adviser_p2"),
        bare: localStorage.getItem("nx_clients_adviser"),
      }));
      eq("E1c · the Clients filter obeys the same rule", ck.namespaced, "all");
      eq("E1d · …and leaves the bare key alone", ck.bare, null);
      await page.context().close();
    }
    {
      /* THE REPRO, exactly as verified: a shared browser where the owner used the app first. */
      const ctx = await browser.newContext({ viewport: DESK });
      const page = await ctx.newPage();
      page.__err = [];
      page.on("pageerror", (e) => page.__err.push(String(e)));
      await page.goto(`${BASE}?as=p2`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        // Daniel's session, in the shape R81 left it in: un-namespaced, and outranking the default.
        localStorage.setItem("nx_board_adviser", "p4");
        localStorage.setItem("nx_diary_staff", "p4");
        localStorage.setItem("nx_clients_adviser", "p4");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2600);
      await page.evaluate(() => { const b = document.querySelector("#tour-skip") || document.querySelector("#tour-end"); if (b) b.click(); });
      await page.waitForTimeout(300);
      const legacy = await page.evaluate(() => ["nx_board_adviser", "nx_diary_staff", "nx_clients_adviser"].map((k) => localStorage.getItem(k)));
      eq("E2a · the pre-R82 un-namespaced values are DROPPED at sign-in (stated: dropped, not migrated)", legacy, [null, null, null]);
      await page.evaluate(() => window.nav("pipeline"));
      await page.waitForTimeout(2000);
      const board = await page.evaluate(() => (document.querySelector("#board-adviser") || {}).value);
      eq("E2b · Wayne's first-ever Pipeline opens on Wayne, not on Daniel Potts", board, "p2");
      await page.evaluate(() => window.nav("diary"));
      await page.waitForTimeout(2200);
      const diary = await page.evaluate(() => (document.querySelector("#diary-staff") || {}).value);
      eq("E2c · …his Diary too", diary, "p2");
      await page.evaluate(() => window.nav("clients"));
      await page.waitForTimeout(2500);
      const clients = await page.evaluate(() => (document.querySelector("#client-adviser") || {}).value);
      eq("E2d · …and his Clients page", clients, "p2");

      /* And the other direction: a colleague's NAMESPACED value must not reach this user either. */
      await page.evaluate(() => {
        localStorage.setItem("nx_board_adviser_p4", "p4");
        localStorage.setItem("nx_board_adviser_p3", "p3");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2600);
      await page.evaluate(() => window.nav("pipeline"));
      await page.waitForTimeout(2000);
      const still = await page.evaluate(() => ({
        board: (document.querySelector("#board-adviser") || {}).value,
        mine: localStorage.getItem("nx_board_adviser_p2"),
      }));
      eq("E3a · another user's stored scope is invisible to this one", still.board, "p2");
      eq("E3b · …and this user's own key is untouched by their sessions", still.mine, null);
      ok("no console errors (§E)", !page.__err.length, JSON.stringify(page.__err));
      await ctx.close();
    }

    /* =====================================================================
       §F · A5 — conflict recovery names what changed, and stops the clobber
       ===================================================================== */
    console.log("\n— §F · A5 · a concurrent edit is named field by field, and 'Save again' no longer replays stale fields (p3 Luke)");
    {
      const page = await boot(browser, "p3");
      const caseId = await page.evaluate(async () => {
        const { data } = await window.__mockDb.from("cases").select("id,lender,product_name").not("lender", "is", null).limit(1);
        return (data || [])[0] || null;
      });
      ok("F0 · picked a case with a lender on it", !!caseId && !!caseId.id, JSON.stringify(caseId));

      /* ---- F1 · they changed a field I never touched ---- */
      await page.evaluate((id) => window.openCase(id), caseId.id);
      await page.waitForTimeout(1200);
      await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
      await page.fill("#case-form input[name='product_name']", "R82 MY UNSAVED EDIT");
      await page.evaluate(async (id) => {
        await window.__mockDb.from("cases").update({ lender: "Colleague Bank" }).eq("id", id);
      }, caseId.id);
      await page.click("#modal-save");
      const box = await waitFor(page, () => {
        const b = document.querySelector("#case-conflict-box");
        return b ? {
          text: b.textContent.replace(/\s+/g, " ").trim(),
          keep: (b.querySelector("#case-conflict-keep") || {}).textContent || "",
          clash: !!b.querySelector("#case-conflict-clash"),
        } : null;
      });
      ok("F1a · the conflict raises a house overlay, not a native confirm with nothing in it", !!box, "no #case-conflict-box");
      eq("F1b · no native dialog was used at all", page.__dialogs.filter((d) => /changed elsewhere/i.test(d.message)).length, 0);
      ok("F1c · it NAMES the field that changed underneath and shows their value",
        !!box && /lender/i.test(box.keep) && /Colleague Bank/.test(box.keep), box && box.keep.slice(0, 200));
      eq("F1d · a field I never touched is not a clash — nothing is presented as mine to overwrite", box && box.clash, false);
      ok("F1e · …and the overlay says their value is being KEPT, not replayed over",
        !!box && /dropped from your save/i.test(box.text), box && box.text.slice(0, 300));

      await page.click("#case-conflict-keepmine");
      await page.waitForTimeout(700);
      const midToast = await toastText(page);
      ok("F1f · the recovery toast names the colleague's change rather than 'the other change'",
        /keeps your colleague's 1 change \(lender\)/.test(midToast), midToast);

      await page.click("#modal-save");
      await page.waitForTimeout(1400);
      const after = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("lender,product_name").eq("id", id).single();
        return data;
      }, caseId.id);
      eq("F1g · Save again writes MY edit…", after.product_name, "R82 MY UNSAVED EDIT");
      eq("F1h · …and does NOT clobber the colleague's field with a stale form value", after.lender, "Colleague Bank");
      const doneToast = await toastText(page);
      ok("F1i · the success toast is no longer the bare words 'Case saved'",
        /Case saved/.test(doneToast) && /kept your colleague's 1 change/.test(doneToast), doneToast);

      /* ---- F2 · we both changed the same field: mine wins, and I am told ---- */
      await page.waitForTimeout(600);
      await page.evaluate((id) => window.openCase(id), caseId.id);
      await page.waitForTimeout(1200);
      await page.evaluate(() => { const d = document.querySelector("#modal .case-details"); if (d) d.open = true; });
      await page.fill("#case-form input[name='lender']", "My Bank");
      await page.evaluate(async (id) => {
        await window.__mockDb.from("cases").update({ lender: "Their Bank" }).eq("id", id);
      }, caseId.id);
      await page.click("#modal-save");
      const box2 = await waitFor(page, () => {
        const b = document.querySelector("#case-conflict-box");
        return b ? {
          clash: (b.querySelector("#case-conflict-clash") || {}).textContent || "",
          btn: (b.querySelector("#case-conflict-keepmine") || {}).textContent || "",
        } : null;
      });
      ok("F2a · a field we BOTH changed is presented as a clash, with both values",
        !!box2 && /lender/i.test(box2.clash) && /Their Bank/.test(box2.clash) && /My Bank/.test(box2.clash), box2 && box2.clash.slice(0, 220));
      ok("F2b · the button itself says how many fields Save again will overwrite",
        !!box2 && /Save again overwrites 1/.test(box2.btn), box2 && box2.btn);
      await page.click("#case-conflict-keepmine");
      await page.waitForTimeout(700);
      await page.click("#modal-save");
      await page.waitForTimeout(1400);
      const after2 = await page.evaluate(async (id) => {
        const { data } = await window.__mockDb.from("cases").select("lender").eq("id", id).single();
        return data;
      }, caseId.id);
      eq("F2c · my deliberate value wins — I typed it after the form opened", after2.lender, "My Bank");
      const t2 = await toastText(page);
      ok("F2d · …and the toast says, in as many words, that a colleague's change was overwritten",
        /OVERWROTE 1 field your colleague changed \(lender\)/.test(t2), t2);
      ok("no console errors (§F)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }
    /* =====================================================================
       §G · A6 — Today's Protection tab follows My Day's Mine/All toggle
       ===================================================================== */
    console.log("\n— §G · A6 · the Protection tab on Today is scoped to the reader (p2 Wayne, adviser)");
    {
      const page = await boot(browser, "p2");
      /* Ground truth, recomputed from the database with the panel's OWN predicate — never read off
         the screen it is checking, and never hardcoded. */
      const gt = await page.evaluate(async (meId) => {
        const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
        const { data } = await window.__mockDb.from("cases").select("id,assigned_to,stage,completed_at,protection_status");
        const hit = (c) => c.protection_status === "not_discussed"
          && (["application", "offer"].includes(c.stage) || (c.stage === "completed" && c.completed_at && c.completed_at >= cutoff));
        const all = (data || []).filter(hit);
        return { all: all.length, mine: all.filter((c) => c.assigned_to === meId).length };
      }, "p2");
      ok("G0 · fixture: the firm has protection rows and Wayne holds fewer of them than the firm does",
        gt.all > 0 && gt.mine < gt.all, JSON.stringify(gt));

      const mineView = await page.evaluate(() => ({
        note: (document.querySelector("#protection-scope-note") || {}).textContent || "",
        count: (document.querySelector("#tab-protection-count") || {}).textContent || "",
        rows: document.querySelectorAll("#protection-list .row-item").length,
      }));
      ok("G1a · an adviser's Today opens the panel on their OWN cases and says so",
        /your cases only/i.test(mineView.note), mineView.note);
      eq("G1b · …and it lists exactly Wayne's, not the firm's", mineView.rows, Math.min(gt.mine, 12));
      eq("G1c · …and the drawer's tab count agrees with the list", Number(mineView.count), Math.min(gt.mine, 12));

      /* Every row on screen must actually be his — the repro was five strangers. */
      const owners = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll("#protection-list .row-item .t")].map((t) => (t.getAttribute("onclick") || "").match(/openCase\('([^']+)'\)/)).filter(Boolean).map((m) => m[1]);
        if (!ids.length) return [];
        const { data } = await window.__mockDb.from("cases").select("id,assigned_to").in("id", ids);
        return [...new Set((data || []).map((c) => c.assigned_to))];
      });
      ok("G1d · every case listed is genuinely assigned to the signed-in adviser",
        owners.every((o) => o === "p2"), JSON.stringify(owners));

      await page.click("#brief-scope-all");
      await page.waitForTimeout(1800);
      const allView = await page.evaluate(() => ({
        note: (document.querySelector("#protection-scope-note") || {}).textContent || "",
        rows: document.querySelectorAll("#protection-list .row-item").length,
      }));
      ok("G2a · flipping My Day to All widens this panel with it, and the note says so",
        /every adviser's cases/i.test(allView.note), allView.note);
      eq("G2b · …to the firm-wide set (same cap)", allView.rows, Math.min(gt.all, 12));
      ok("no console errors (§G)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §H · A7 — phone numbers on the Protection page
       ===================================================================== */
    console.log("\n— §H · A7 · tel: and a pre-drafted sms: on every protection surface (p4 Daniel, owner)");
    {
      const page = await boot(browser, "p4");
      await goPage(page, "protection", 3000);
      /* Plant the two states this must get right, deterministically, ON ROWS THE PAGE IS ACTUALLY
         SHOWING (the default status filter narrows the ranked list, so "the RPC's top two" is not
         the same set): a client with a number who has NOT opted out of texts, and one who HAS.
         Then bust the session cache and reload the page, which is exactly the path a real edit
         takes through the R78 choke point. */
      const planted = await page.evaluate(async () => {
        const ids = [...document.querySelectorAll("#prot-list-table .prot-client")]
          .map((el) => ((el.getAttribute("onclick") || "").match(/openClient\('([^']+)'\)/) || [])[1])
          .filter(Boolean);
        const uniq = [...new Set(ids)];
        if (uniq.length < 2) return null;
        const db = window.__mockDb;
        await db.from("clients").update({ phone: "07700900123", sms_opt_out: false }).eq("id", uniq[0]);
        await db.from("clients").update({ phone: "07700900456", sms_opt_out: true }).eq("id", uniq[1]);
        window.__bustProtCache();
        await window.loadProtectionPage();
        return { ok: uniq[0], optout: uniq[1] };
      });
      ok("H0 · planted a textable client and an SMS-opted-out one on rows the page is showing", !!planted, JSON.stringify(planted));
      await page.waitForTimeout(1200);

      const table = await page.evaluate((p) => {
        const cell = (cid) => {
          const link = [...document.querySelectorAll("#prot-list-table .prot-client")].find((el) => (el.getAttribute("onclick") || "").includes(cid));
          return link ? link.closest("td") : null;
        };
        const read = (cid) => {
          const td = cell(cid);
          if (!td) return null;
          const tel = td.querySelector('a[href^="tel:"]');
          const sms = td.querySelector("a.row-sms-link");
          return {
            tel: tel ? tel.getAttribute("href") : null,
            telText: tel ? tel.textContent.trim() : null,
            telTitle: tel ? tel.getAttribute("title") : null,
            sms: sms ? sms.getAttribute("href") : null,
            optoutNote: (td.querySelector(".row-sms-optout") || {}).textContent || "",
          };
        };
        return { ok: read(p.ok), optout: read(p.optout), anyTel: document.querySelectorAll('#prot-list-table a[href^="tel:"]').length };
      }, planted);
      ok("H1a · the ranked table now carries a tel: link on the row's client cell",
        !!table.ok && table.ok.tel === "tel:07700900123", JSON.stringify(table.ok));
      ok("H1b · …and the pre-drafted sms: opener Retention uses, body and all",
        !!table.ok && /^sms:07700900123\?&amp;body=|^sms:07700900123\?&body=/.test(table.ok.sms || "")
        && /NexMoney/.test(decodeURIComponent((table.ok.sms || "").split("body=")[1] || "")), JSON.stringify(table.ok.sms));
      /* R69 · B2 pins this table fitting 1280 with nothing to scroll, so inside it the affordance
         is the two ICONS with the number in the title — the digits and the word "Text" are ~150px
         this layout does not have, and a click-to-call does not need them on screen. */
      ok("H1b2 · …in the table's compact form, with the number in the link's title",
        !!table.ok && table.ok.telText === "📞" && /07700900123/.test(table.ok.telTitle || ""), JSON.stringify(table.ok));
      ok("H1c · the table is no longer a page with zero phone numbers on it", table.anyTel > 0, String(table.anyTel));
      ok("H2a · a client marked sms_opt_out keeps the CALL…",
        !!table.optout && table.optout.tel === "tel:07700900456", JSON.stringify(table.optout));
      ok("H2b · …and loses the pre-drafted text, with the reason in its place",
        !!table.optout && !table.optout.sms && !!table.optout.optoutNote, JSON.stringify(table.optout));

      const bands = await page.evaluate(() => ({
        call: document.querySelectorAll('#prot-calllist a[href^="tel:"]').length,
        callRows: document.querySelectorAll("#prot-calllist .row-item").length,
        gi: document.querySelectorAll('#prot-gi-list a[href^="tel:"]').length,
        giRows: document.querySelectorAll("#prot-gi-list .row-item").length,
      }));
      ok("H3a · the completed-book call list carries them too (or has no rows to carry them on)",
        bands.callRows === 0 || bands.call > 0, JSON.stringify(bands));
      ok("H3b · …and so does the GI band", bands.giRows === 0 || bands.gi > 0, JSON.stringify(bands));
      const rowForm = await page.evaluate(() => {
        const a = document.querySelector('#prot-calllist a[href^="tel:"], #prot-gi-list a[href^="tel:"]');
        const sms = document.querySelector("#prot-calllist a.row-sms-link, #prot-gi-list a.row-sms-link");
        return { tel: a ? a.textContent.trim() : null, sms: sms ? sms.textContent.trim() : null };
      });
      ok("H3c · the row-item bands keep the FULL Retention form (number on screen, “💬 Text”) — only the table is compact",
        !rowForm.tel || (/\d/.test(rowForm.tel) && (!rowForm.sms || /Text/.test(rowForm.sms))), JSON.stringify(rowForm));

      /* The no-phone state Retention respects: nothing at all, never a dead "📞 —". */
      const dead = await page.evaluate(() => {
        const cells = [...document.querySelectorAll("#prot-list-table .prot-row .stick-col")];
        return cells.filter((td) => /📞/.test(td.textContent) && !td.querySelector('a[href^="tel:"]')).length;
      });
      eq("H4 · a client with no number renders no phone affordance at all — no dead 📞", dead, 0);
      ok("no console errors (§H)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §I · A8 — a task assigned to me, due later, is visible on arrival
       ===================================================================== */
    console.log("\n— §I · A8 · open tasks assigned to the signed-in user are surfaced on Today (p2 Wayne)");
    {
      const page = await boot(browser, "p2");
      const seeded = await page.evaluate(async () => {
        const db = window.__mockDb;
        const ymd = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
        const { data: cs } = await db.from("cases").select("id").limit(1);
        const caseId = (cs || [])[0].id;
        await db.from("case_tasks").insert([
          { case_id: caseId, title: "R82 A8 — ten days out", due_date: ymd(10), assigned_to: "p2" },
          { case_id: caseId, title: "R82 A8 — six days out", due_date: ymd(6), assigned_to: "p2" },
        ]);
        return { caseId, soonest: ymd(6) };
      });
      ok("I0 · seeded two open tasks assigned to Wayne, due later this fortnight", !!seeded.caseId, JSON.stringify(seeded));
      // Ground truth over the same rows the app's own read takes.
      const gt = await page.evaluate(async (meId) => {
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
        const horizon = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(Date.now() + 14 * 86400000));
        const { data } = await window.__mockDb.from("case_tasks").select("assigned_to,due_date,done_at").is("done_at", null).lte("due_date", horizon).limit(200);
        /* "across the team" means work that is ON somebody's desk — an unassigned task is nobody's
           and the line does not claim it, so the ground truth does not either. */
        const later = (data || []).filter((t) => t.assigned_to && t.due_date && String(t.due_date).slice(0, 10) > today);
        const mine = later.filter((t) => t.assigned_to === meId);
        return { mine: mine.length, all: later.length, soonest: mine.map((t) => t.due_date).sort()[0] || null };
      }, "p2");
      await page.evaluate(() => window.loadDashboard());
      await page.waitForTimeout(2500);
      const line = await waitFor(page, () => {
        const el = document.querySelector("#brief-ahead");
        return el && !el.classList.contains("hidden") ? {
          label: el.textContent.replace(/\s+/g, " ").trim(),
          text: el.getAttribute("title") || "",
          n: el.getAttribute("data-ahead-n") || "",
          go: (el.getAttribute("onclick") || "").includes("diary"),
          inHeading: !!el.closest("#briefing-panel h3"),
        } : null;
      });
      ok("I1a · Today now says how much assigned work is coming", !!line, "#brief-ahead never appeared");
      eq("I1b · …with the real count of tasks assigned to ME and due later", Number(line && line.n), gt.mine);
      ok("I1b2 · …on the face of the badge, not only in its tooltip",
        !!line && line.label === `${gt.mine} due later`, JSON.stringify(line && line.label));
      ok("I1b3 · …as a heading count, so it costs the phone layout no vertical space (R69 · B)",
        !!line && line.inHeading, JSON.stringify(line));
      ok("I1c · …attributed to the reader, not to the firm, on the Mine scope",
        !!line && /assigned to you/i.test(line.text), line && line.text);
      /* The expected date string comes from the APP's own fmtD, not from a second formatter in
         this file — Node's en-GB says "Sept", the browser's says "Sep", and a suite that spells a
         month for itself is a suite that fails on the wrong box. */
      const wantDate = await page.evaluate((d) => fmtD(d), gt.soonest);   // fmtD is a lexical global (core.js), not a window property
      ok("I1d · …naming the date the first of them lands",
        !!line && !!wantDate && line.text.includes(wantDate), JSON.stringify({ text: line && line.text, want: wantDate }));
      ok("I1e · …and offering somewhere to go and look at them", !!line && line.go, JSON.stringify(line));
      ok("I1f · …and it is honest that these are NOT the rows below it",
        !!line && /not on this list/i.test(line.text), line && line.text);

      /* The gap it fills: these tasks are genuinely absent from My Day's own list. */
      const inBrief = await page.evaluate(() => [...document.querySelectorAll("#briefing-list")].map((e) => e.textContent).join(" "));
      ok("I2 · the seeded due-later tasks are NOT in My Day's list (that is the gap this closes)",
        !/R82 A8 — ten days out/.test(inBrief), inBrief.slice(0, 200));

      await page.click("#brief-scope-all");
      await page.waitForTimeout(1800);
      const allLine = await page.evaluate(() => {
        const el = document.querySelector("#brief-ahead");
        return el && !el.classList.contains("hidden") ? { text: el.getAttribute("title") || "", n: Number(el.getAttribute("data-ahead-n") || 0) } : null;
      });
      ok("I3a · the line follows My Day's own Mine/All toggle", !!allLine && /across the team/i.test(allLine.text), allLine && allLine.text);
      ok("I3b · …and All is never fewer than Mine", !!allLine && allLine.n >= gt.mine && allLine.n === gt.all, JSON.stringify({ got: allLine && allLine.n, want: gt.all }));
      ok("no console errors (§I)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }

    /* =====================================================================
       §J · A9 — the font stops blocking the render (correctness, not timing)
       ===================================================================== */
    console.log("\n— §J · A9 · Google Fonts is non-blocking, and the fallback stack is real");
    {
      const html = fs.readFileSync(path.join(REPO, "admin/index.html"), "utf8");
      const css = fs.readFileSync(path.join(REPO, "admin/admin.css"), "utf8");
      ok("J1a · the Google Fonts stylesheet no longer blocks the render",
        /fonts\.googleapis\.com\/css2[^>]*rel="stylesheet" media="print" onload="this\.media='all'"/.test(html), "media=print onload swap");
      ok("J1b · …and a JS-off browser still gets the face", /<noscript><link href="https:\/\/fonts\.googleapis\.com/.test(html), "noscript fallback");
      ok("J1c · the URL still carries &display=swap, so text paints in the fallback rather than hiding",
        /fonts\.googleapis\.com\/css2\?family=Inter[^"]*&display=swap/.test(html), "display=swap");
      ok("J1d · the fallback stack is a real one, not a bare sans-serif",
        /--font:\s*"Inter",\s*-apple-system,\s*"Segoe UI",\s*system-ui,\s*Roboto,\s*Arial,\s*sans-serif/.test(css), "admin.css --font");
      /* mock.html is GENERATED from index.html and smoke.js throws on any drift but the one script
         tag — so the harness must be carrying the change too, or the two have forked. */
      const mock = fs.readFileSync(path.join(REPO, "admin/mock.html"), "utf8");
      ok("J1e · mock.html carries it too (it is regenerated from index.html)",
        /media="print" onload="this\.media='all'"/.test(mock), "mock.html");

      const page = await boot(browser, "p1");
      const painted = await page.evaluate(() => ({
        font: getComputedStyle(document.body).fontFamily,
        kpi: document.querySelectorAll("#kpi-row .kpi").length,
        brief: !!document.querySelector("#briefing-list"),
      }));
      ok("J2a · the page still renders normally with the stylesheet off the critical path",
        painted.kpi > 0 && painted.brief, JSON.stringify(painted));
      ok("J2b · …and body still resolves the Inter-first stack with real fallbacks behind it",
        /Inter/.test(painted.font) && /(system-ui|Segoe UI|-apple-system)/.test(painted.font), painted.font);
      ok("no console errors (§J)", !page.__err.length, JSON.stringify(page.__err));
      await page.context().close();
    }
  } finally {
    await browser.close();
    if (srv) { try { process.kill(-srv.pid); } catch (e) { try { srv.kill(); } catch (_) {} } }
  }

  console.log(`\nr82_correct: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { failures.forEach((f) => console.log("  FAIL: " + f)); process.exit(1); }
})();
