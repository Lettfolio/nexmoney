#!/usr/bin/env node
/* =============================================================================
   tests/r80_ledger.js — acceptance tests for R80 build B, "mine the book"
   (items B1–B3).

     §A  PROMOTERS NEVER ASKED — membership (p4). Ground truth recomputed from
         the fixture DB at runtime: score ≥ 9 in, 8 out; EITHER record of an
         ask disqualifies (Peter's email_queue row, Bruce's stamp-only
         referral_requested_at) with the asked-count line; the opted-out and
         no-email promoters are LISTED, flagged, phone-verb-only; sort, ids,
         basis and phone-note wording; the block is appended sixth to the
         owner's five R9 blocks.
     §B  THE VERBS are the existing paths: ✆ Call task → one case_tasks insert
         on the case's own adviser, due tomorrow rolled off a weekend
         (weekendRollYmd); ✉ Queue referral request → queueEmail with R79's
         holdLine in the confirm and the held toast, the referral_requested_at
         stamp, and the row's exit from the list; an opted-out client is
         REFUSED with a toast and nothing queues; the flagged rows carry no
         queue verb at all.
     §C  OWNER-ONLY, unchanged. Advocacy (promoters block included) stays
         hidden and empty for p1 admin and p2 adviser — r9_adv §9's original
         assertions, re-affirmed over the new block.
     §D  PRICE THE UNREACHABLE (B2). #dh-atrisk-email matches fixture
         arithmetic (N unreachable, £ = loan summed over in-window completed
         cases, fmtM format, "not a fee forecast"); the list is RANKED by that
         £, biggest first; affected rows carry .dh-rate-tag with date + £; the
         R77 inline fix still saves and still decrements the tile; an admin
         gets the count sentence and the "shown to the Owner" clause, no £;
         the Retention gone-quiet summary carries the short clause.
     §E  AUDIT COVERAGE (B3). Each post-R74 verb leaves audit_log rows via the
         tables it writes (the mock now mirrors prod's audit_row trigger list,
         fact_finds/leads/sms_queue included): bulk stage move, stage-move
         Undo, the completion overlay, diary drag + Undo, client merge,
         dup-create-anyway, the two regenerate-link paths, reassign_holdings —
         plus the accepted-gap invariant that email_queue never appears in
         audit_log.

   Run:  node /root/nx/tests/r80_ledger.js
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
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }

function serverUp() {
  return new Promise((res) => {
    const r = http.get({ host: "localhost", port: PORT, path: "/admin/mock.html" }, (x) => { x.resume(); res(x.statusCode === 200); });
    r.on("error", () => res(false));
  });
}
async function ensureServer() {
  if (await serverUp()) return null;
  const srv = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: REPO, stdio: "ignore" });
  for (let i = 0; i < 40 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 250));
  return srv;
}

async function boot(browser, persona) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await ctx.newPage();
  page.__ctx = ctx;
  page.__dialogs = [];
  page.on("dialog", (d) => { page.__dialogs.push({ type: d.type(), message: d.message() }); d.accept(); });
  page.__err = [];
  page.on("pageerror", (e) => page.__err.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") page.__err.push("console:" + m.text()); });
  await page.addInitScript(() => { window.__NEX_SKIP_TOUR = true; });
  await page.goto(`${BASE}?as=${persona}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  return page;
}
const realErrs = (page) => (page.__err || []).filter((e) => !/ERR_TUNNEL|ERR_NAME|Failed to fetch|Failed to load resource|favicon/i.test(e));
const wait = (page, ms) => page.waitForTimeout(ms);
const goPage = async (page, id, ms) => {
  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  await page.evaluate((p) => window.nav(p), id);
  await page.waitForTimeout(ms == null ? 2400 : ms);
};
const txt = (page, sel) => page.$eval(sel, (e) => (e.textContent || "").replace(/\s+/g, " ").trim()).catch(() => null);
const fmtGBP = (n) => "£" + Math.round(n).toLocaleString("en-GB");
const fmtDay = (ymd) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(ymd + "T12:00:00"));

/* Ground truth for the promoters list, recomputed from the fixture DB inside the page —
   the standing rule: never hardcode what the deterministic seed happens to produce.
   Membership mirrors the contract exactly: score ≥ 9, and NEITHER record of an ask —
   no referral_requested_at on ANY case, no non-cancelled referral_request queue row. */
const promoterGT = (page) => page.evaluate(async () => {
  const db = window.__mockDb;
  const cases = (await db.from("cases").select("id,client_id,stage,nps_score,completed_at,assigned_to,referral_requested_at")).data;
  const askedQ = new Set((await db.from("email_queue").select("client_id,status").eq("email_type", "referral_request").neq("status", "cancelled")).data.map((r) => r.client_id));
  const stamped = new Set(cases.filter((c) => c.referral_requested_at && c.client_id).map((c) => c.client_id));
  const optout = new Set((await db.from("clients").select("id").eq("comms_optout", true)).data.map((r) => r.id));
  const emails = new Map((await db.from("clients").select("id,email")).data.map((r) => [r.id, r.email || null]));
  const byClient = new Map();
  cases.forEach((c) => {
    if (c.nps_score == null || Number(c.nps_score) < 9 || !c.client_id) return;
    const cur = byClient.get(c.client_id);
    if (!cur || String(c.completed_at || "") > String(cur.completed_at || "")) byClient.set(c.client_id, c);
  });
  const rows = [...byClient.values()];
  const isAsked = (id) => stamped.has(id) || askedQ.has(id);
  return {
    waiting: rows.filter((c) => !isAsked(c.client_id))
      .sort((a, b) => Number(b.nps_score) - Number(a.nps_score)
        || String(b.completed_at || "").localeCompare(String(a.completed_at || ""))
        || String(a.id).localeCompare(String(b.id)))
      .map((c) => ({ client: c.client_id, kase: c.id, score: Number(c.nps_score),
        optedOut: optout.has(c.client_id), noEmail: !emails.get(c.client_id), adviser: c.assigned_to })),
    askedN: rows.filter((c) => isAsked(c.client_id)).length,
    stampOnly: rows.filter((c) => stamped.has(c.client_id) && !askedQ.has(c.client_id)).map((c) => c.client_id),
    queueAsked: rows.filter((c) => askedQ.has(c.client_id)).map((c) => c.client_id),
  };
});
const promoterDom = (page) => page.evaluate(() => ({
  blocks: [...document.querySelectorAll("#report-advocacy-grid .adv-block")].map((x) => x.id),
  rows: [...document.querySelectorAll(".adv-promo-row")].map((r) => ({
    client: r.dataset.client, kase: r.dataset.case,
    score: (r.querySelector(".adv-promo-score") || {}).textContent || "",
    text: (r.textContent || "").replace(/\s+/g, " ").trim(),
    call: !!r.querySelector(".adv-promo-call"),
    ask: !!r.querySelector(".adv-promo-ask"),
    optoutFlag: !!r.querySelector(".adv-promo-optout"),
    noEmailFlag: !!r.querySelector(".adv-promo-noemail"),
  })),
  basis: (document.querySelector("#adv-promoters-basis") || {}).textContent || "",
  asked: (document.querySelector("#adv-promoters-asked") || {}).textContent || "",
  phoneNote: (document.querySelector("#adv-promoters-phone") || {}).textContent || "",
  empty: (document.querySelector("#adv-promoters-empty") || {}).textContent || "",
  panelHidden: document.querySelector("#report-advocacy-panel").classList.contains("hidden"),
}));

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();

  /* =======================================================================
     §A · B1 — membership, exclusions, flags, wording (p4 Daniel)
     ===================================================================== */
  {
    console.log("\n— §A · promoters never asked: membership from fixture ground truth (p4)");
    const page = await boot(browser, "p4");
    await goPage(page, "reports");
    const gt = await promoterGT(page);
    const dom = await promoterDom(page);
    ok("A0 · fixtures — promoters wait, both ask-records are represented, one opted out, one has no email",
      gt.waiting.length >= 2 && gt.queueAsked.length >= 1 && gt.stampOnly.length >= 1
      && gt.waiting.some((w) => w.optedOut) && gt.waiting.some((w) => w.noEmail), JSON.stringify(gt));
    eq("A1 · the owner grid holds the five R9 blocks plus the promoters block, sixth",
      dom.blocks, ["adv-block-nps", "adv-block-series", "adv-block-ratio", "adv-block-top", "adv-block-detractors", "adv-block-promoters"]);
    eq("A2 · the listed rows are EXACTLY the ground-truth waiting set, in its order (score desc, newest completion)",
      dom.rows.map((r) => ({ client: r.client, kase: r.kase })),
      gt.waiting.map((r) => ({ client: r.client, kase: r.kase })));
    ok("A2b · every row prints its score as N/10 and matches the case's own score",
      dom.rows.every((r, i) => r.score === `${gt.waiting[i].score}/10`), JSON.stringify(dom.rows.map((r) => r.score)));
    ok("A2c · every row carries the call-task verb and an Open case button",
      dom.rows.every((r) => r.call && /Open case/.test(r.text)), JSON.stringify(dom.rows.map((r) => [r.call, r.text.slice(0, 40)])));
    ok("A2d · every row names a completed date (the promoters are the completed book)",
      dom.rows.every((r) => /completed /.test(r.text)), JSON.stringify(dom.rows.map((r) => r.text.slice(0, 60))));

    // A3 — a score of 8 is NOT a promoter: no 8-scored client leaks in.
    const eights = await page.evaluate(async () => {
      const db = window.__mockDb;
      const cases = (await db.from("cases").select("client_id,nps_score")).data;
      const nine = new Set(cases.filter((c) => Number(c.nps_score) >= 9).map((c) => c.client_id));
      return cases.filter((c) => Number(c.nps_score) === 8 && !nine.has(c.client_id)).map((c) => c.client_id);
    });
    ok("A3 · fixtures — the book holds 8-scored clients with no ≥9 case", eights.length >= 1, JSON.stringify(eights));
    ok("A3b · …and none of them is listed (9 is the line, not 8)",
      dom.rows.every((r) => !eights.includes(r.client)), JSON.stringify(dom.rows.map((r) => r.client)));

    // A4 — EITHER record of an ask disqualifies: Peter (queue row) and Bruce (stamp only).
    const asked = await page.evaluate(async () => {
      const db = window.__mockDb;
      const peter = (await db.from("clients").select("id").eq("last_name", "Thackeray")).data[0];
      const bruce = (await db.from("clients").select("id").eq("last_name", "Lindquist")).data[0];
      const bq = (await db.from("email_queue").select("id").eq("email_type", "referral_request").eq("client_id", bruce.id)).data.length;
      const bStamp = (await db.from("cases").select("referral_requested_at").eq("client_id", bruce.id)).data.some((c) => c.referral_requested_at);
      return { peter: peter.id, bruce: bruce.id, bruceQueueRows: bq, bruceStamped: bStamp };
    });
    ok("A4 · fixture — Bruce carries the stamp ALONE (no queue row); Peter carries the queue row",
      asked.bruceQueueRows === 0 && asked.bruceStamped && gt.queueAsked.includes(asked.peter), JSON.stringify(asked));
    ok("A4b · neither already-asked promoter is listed",
      dom.rows.every((r) => r.client !== asked.peter && r.client !== asked.bruce), JSON.stringify(dom.rows.map((r) => r.client)));
    ok("A4c · the asked-count line counts them and explains",
      new RegExp(`^${gt.askedN} promoter`).test(dom.asked) && /already been queued or sent/.test(dom.asked), dom.asked);

    // A5 — the opted-out promoter is LISTED, flagged, phone-only (the spec's rule: they said no
    // to relationship email, not to being asked — the panel says so and gives the phone verb only).
    const damian = await page.evaluate(async () =>
      (await window.__mockDb.from("clients").select("id,comms_optout").eq("last_name", "Fairhurst")).data[0]);
    ok("A5 · fixture — Damian Fairhurst is an opted-out promoter", damian && damian.comms_optout === true, JSON.stringify(damian));
    const dRow = dom.rows.find((r) => r.client === damian.id);
    ok("A5b · he IS listed, flagged 'opted out — ask by phone'", !!dRow && dRow.optoutFlag && /opted out — ask by phone/.test(dRow.text), JSON.stringify(dRow));
    ok("A5c · …with the call verb and WITHOUT the queue verb", !!dRow && dRow.call && !dRow.ask, JSON.stringify(dRow));

    // A6 — the no-email promoter (Yvonne Kerr) gets the same phone-only treatment.
    const yvonne = await page.evaluate(async () =>
      (await window.__mockDb.from("clients").select("id,email").eq("last_name", "Kerr")).data[0]);
    ok("A6 · fixture — Yvonne Kerr is a promoter with no email", yvonne && !yvonne.email, JSON.stringify(yvonne));
    const yRow = dom.rows.find((r) => r.client === yvonne.id);
    ok("A6b · she IS listed, flagged 'no email — ask by phone', call verb only",
      !!yRow && yRow.noEmailFlag && yRow.call && !yRow.ask, JSON.stringify(yRow));

    // A7 — wording contracts.
    ok("A7 · the basis names the ≥9 rule and BOTH halves of never-asked",
      /9 or 10/.test(dom.basis) && /no referral request has ever been queued/.test(dom.basis)
      && /no stamp on any of their cases/.test(dom.basis) && /except cancelled/.test(dom.basis), dom.basis);
    ok("A7b · the phone note says an opted-out promoter can still be ASKED BY PHONE",
      /ASKED BY PHONE/.test(dom.phoneNote) && /call verb only/.test(dom.phoneNote), dom.phoneNote);
    ok("A7c · every unflagged row DOES carry the queue verb",
      dom.rows.filter((r) => !r.optoutFlag && !r.noEmailFlag).every((r) => r.ask), JSON.stringify(dom.rows.map((r) => [r.optoutFlag, r.noEmailFlag, r.ask])));
    ok("§A · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §B · B1 — the verbs are the existing paths (p4)
     ===================================================================== */
  {
    console.log("\n— §B · ✆ Call task / ✉ Queue referral request (p4)");
    const page = await boot(browser, "p4");
    await goPage(page, "reports");
    const gt = await promoterGT(page);
    const first = gt.waiting.find((w) => !w.optedOut && !w.noEmail);
    ok("B0 · fixture — an unflagged (emailable) promoter exists to drive the verbs on", !!first, JSON.stringify(gt.waiting));

    // B1 — ✆ Call task: one case_tasks insert, case's adviser, due tomorrow rolled (weekendRollYmd).
    const expectedDue = await page.evaluate(() => {
      const d = new Date(Date.now() + 86400000);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return window.weekendRollYmd(ymd);   // suites compute the roll through the exposed helper
    });
    await page.click(`.adv-promo-row[data-case="${first.kase}"] .adv-promo-call`);
    await wait(page, 1200);
    const call = await page.evaluate(async (id) => {
      const db = window.__mockDb;
      const rows = (await db.from("case_tasks").select("title,due_date,assigned_to,created_by").eq("case_id", id)).data
        .filter((t) => /thank them and ask for a referral/.test(t.title || ""));
      const kase = (await db.from("cases").select("assigned_to,client_id").eq("id", id).single()).data;
      const cl = (await db.from("clients").select("first_name,last_name").eq("id", kase.client_id).single()).data;
      return { rows, caseAdviser: kase.assigned_to, name: [cl.first_name, cl.last_name].filter(Boolean).join(" "), toast: document.querySelector("#toast").textContent };
    }, first.kase);
    eq("B1 · the call task landed on the case, once", call.rows.length, 1);
    eq("B1b · titled with the client's name and the ask", call.rows[0].title, `Call ${call.name} — thank them and ask for a referral`);
    eq("B1c · due tomorrow, weekend-rolled (weekendRollYmd's own answer)", call.rows[0].due_date, expectedDue.date);
    eq("B1d · assigned to the case's own adviser", call.rows[0].assigned_to, call.caseAdviser);
    ok("B1e · the toast says which day it booked",
      expectedDue.rolled ? /Call task added for Monday — skipped the weekend/.test(call.toast) : /Call task added for tomorrow/.test(call.toast), call.toast);

    // B2 — ✉ Queue referral request: queueEmail, holdLine, held toast, stamp, exit.
    page.__dialogs = [];
    await page.evaluate((id) => { window.advPromoAsk(id); }, first.kase);
    await wait(page, 2600);
    const asked = await page.evaluate(async (o) => {
      const db = window.__mockDb;
      return {
        q: (await db.from("email_queue").select("status,to_email").eq("email_type", "referral_request").eq("client_id", o.client)).data,
        stamp: (await db.from("cases").select("referral_requested_at").eq("id", o.kase).single()).data.referral_requested_at,
        toast: document.querySelector("#toast").textContent,
        rows: [...document.querySelectorAll(".adv-promo-row")].map((r) => r.dataset.case),
        asked: (document.querySelector("#adv-promoters-asked") || {}).textContent || "",
      };
    }, first);
    ok("B2 · the confirm is queueEmail's own, with R79's holdLine word for word",
      page.__dialogs.length === 1 && /Send referral request email to /.test(page.__dialogs[0].message)
      && /Sending is currently ON HOLD \(Settings › Email sending\) — this will queue and wait; nothing is sent now\./.test(page.__dialogs[0].message),
      JSON.stringify(page.__dialogs));
    eq("B2b · exactly one referral_request row queued for the client (held, not sent)",
      asked.q.map((r) => r.status), ["queued"]);
    ok("B2c · the held toast, word for word",
      /Email queued and HELD — nothing sends until the hold is released \(Settings › Email sending\)\./.test(asked.toast), asked.toast);
    ok("B2d · the referral_requested_at stamp is on the case (queueEmail writes it now)", !!asked.stamp, JSON.stringify(asked.stamp));
    ok("B2e · the row leaves the list — the re-render reads the records the verb just wrote",
      !asked.rows.includes(first.kase), JSON.stringify(asked.rows));
    ok("B2f · …and the asked-count line takes it over",
      new RegExp(`^${gt.askedN + 1} promoter`).test(asked.asked), asked.asked);

    // B3 — an opted-out promoter is refused before anything queues (belt over the hidden button).
    const damianCase = await page.evaluate(async () => {
      const db = window.__mockDb;
      const cl = (await db.from("clients").select("id").eq("last_name", "Fairhurst")).data[0];
      const c = (await db.from("cases").select("id,client_id,nps_score").eq("client_id", cl.id)).data.filter((x) => Number(x.nps_score) >= 9)[0];
      return { caseId: c.id, clientId: cl.id };
    });
    page.__dialogs = [];
    await page.evaluate((id) => { window.advPromoAsk(id); }, damianCase.caseId);
    await wait(page, 1200);
    const refused = await page.evaluate(async (o) => ({
      q: (await window.__mockDb.from("email_queue").select("id").eq("email_type", "referral_request").eq("client_id", o.clientId)).data.length,
      toast: document.querySelector("#toast").textContent,
    }), damianCase);
    eq("B3 · nothing was queued for the opted-out client", refused.q, 0);
    ok("B3b · the refusal toast names the opt-out, the certain cancellation, and the phone",
      /opted out of relationship emails/.test(refused.toast) && /cancelled at send/.test(refused.toast) && /phone/.test(refused.toast), refused.toast);
    eq("B3c · no confirm was even raised — refused before the ask", page.__dialogs.length, 0);
    ok("§B · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  /* =======================================================================
     §C · B1 — the panel stays OWNER-ONLY, promoters block included (p1, p2)
     ===================================================================== */
  {
    console.log("\n— §C · owner gate unchanged (p1 Kim admin, p2 Wayne adviser)");
    for (const persona of ["p1", "p2"]) {
      const page = await boot(browser, persona);
      await goPage(page, "reports");
      const g = await page.evaluate(() => ({
        hidden: document.querySelector("#report-advocacy-panel").classList.contains("hidden"),
        anyBlock: document.querySelectorAll("#report-advocacy-grid .adv-block").length,
        basis: (document.querySelector("#report-advocacy-basis") || {}).textContent || "",
        promoRows: document.querySelectorAll(".adv-promo-row").length,
      }));
      eq(`C1 · ${persona} · the advocacy panel is hidden (r9_adv §9's rule, promoters included)`, g.hidden, true);
      eq(`C1b · ${persona} · …and nothing is rendered inside it — no promoters block, no rows`, [g.anyBlock, g.promoRows], [0, 0]);
      eq(`C1c · ${persona} · …not even the basis line`, g.basis.trim(), "");
      ok(`§C · no console errors (${persona})`, realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
      await page.close();
    }
  }

  /* =======================================================================
     §D · B2 — price the unreachable (p4 owner, then p1 admin)
     ===================================================================== */
  /* Ground truth, recomputed the panel's own way: forward window = rate_reminder_months × 30d,
     £ = loan on completed in-window cases summed per client — Retention's value-at-risk reading. */
  const dhGT = (page) => page.evaluate(async () => {
    const db = window.__mockDb;
    const months = Number(((await db.from("settings").select("value").eq("key", "rate_reminder_months")).data[0] || {}).value) || 6;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const edgeD = new Date(today + "T12:00:00"); edgeD.setDate(edgeD.getDate() + months * 30);
    const edge = `${edgeD.getFullYear()}-${String(edgeD.getMonth() + 1).padStart(2, "0")}-${String(edgeD.getDate()).padStart(2, "0")}`;
    const cases = (await db.from("cases").select("client_id,stage,rate_end_date,loan_amount")).data;
    const risk = new Map();
    cases.forEach((c) => {
      if (c.stage !== "completed" || !c.rate_end_date) return;
      const d = String(c.rate_end_date).slice(0, 10);
      if (d < today || d > edge) return;
      const cur = risk.get(c.client_id) || { date: d, loan: 0, n: 0 };
      if (d < cur.date) cur.date = d;
      cur.n++; cur.loan += Number(c.loan_amount || 0);
      risk.set(c.client_id, cur);
    });
    const missE = ((await db.rpc("get_data_quality")).data || {}).missing_email || [];
    /* THE RANK the panel promises: priced first by loan desc (soonest date breaks a tie), the
       unpriced rest in RPC order — replicated with the same stable sort the renderer uses. */
    const ranked = missE.slice().sort((a, b) => {
      const ra = risk.get(a.id), rb = risk.get(b.id);
      return ((rb ? rb.loan : 0) - (ra ? ra.loan : 0))
        || String((ra ? ra.date : "￿")).localeCompare(String(rb ? rb.date : "￿"));
    });
    const hit = missE.filter((r) => risk.has(r.id));
    return {
      months,
      hit: hit.map((r) => r.id),
      loan: hit.reduce((s, r) => s + risk.get(r.id).loan, 0),
      nCases: hit.reduce((s, r) => s + risk.get(r.id).n, 0),
      perClient: Object.fromEntries(hit.map((r) => [r.id, risk.get(r.id)])),
      rankedIds: ranked.map((r) => r.id),
      total: missE.length,
    };
  });
  {
    console.log("\n— §D · Data health £-headline, £-rank, tags, inline fix; Retention's short clause (p4, then p1)");
    const page = await boot(browser, "p4");
    await goPage(page, "data", 2800);
    const gt = await dhGT(page);
    ok("D0 · fixtures — at least one unreachable client holds an in-window maturing rate",
      gt.hit.length >= 1 && gt.loan > 0, JSON.stringify(gt));
    const lineE = await txt(page, "#dh-atrisk-email");
    ok("D1 · the headline counts the unreachable and prices them: 'N unreachable clients hold £X of maturing lending'",
      (lineE || "").startsWith(`${gt.hit.length} unreachable client${gt.hit.length === 1 ? "" : "s"} hold${gt.hit.length === 1 ? "s" : ""} ${fmtGBP(gt.loan)} of maturing lending`), `${lineE} · want ${fmtGBP(gt.loan)}`);
    ok("D1b · …and says the automation cannot chase any of it",
      /the automation cannot chase any of it/.test(lineE || ""), lineE);
    ok("D1c · the basis is stated IN the line — Retention's value-at-risk reading, not a fee forecast, the named window",
      new RegExp(`the ${gt.nCases} completed cases|the one completed case`).test(lineE || "")
      && /value-at-risk/.test(lineE || "") && /not a fee forecast/i.test(lineE || "")
      && (lineE || "").includes(`within ${gt.months} months`), lineE);
    ok("D1d · …and names the rank: biggest first, fix the expensive ones first",
      /ranked by it, biggest first/.test(lineE || "") && /fix the expensive ones first/i.test(lineE || ""), lineE);

    // D2 — THE RANK: the DOM rows follow the £, biggest first; unpriced rows keep the RPC's order.
    const domOrder = await page.evaluate(() =>
      [...document.querySelectorAll("#dh-missing-panel [data-fix-row]")].map((r) => r.dataset.fixRow));
    eq("D2 · the missing-email list is ranked by at-risk £, biggest first (full order matches the replicated stable sort)",
      domOrder, gt.rankedIds.slice(0, domOrder.length));
    ok("D2b · the top row is the single most expensive fault",
      domOrder[0] === gt.rankedIds[0] && gt.perClient[domOrder[0]]
      && gt.perClient[domOrder[0]].loan === Math.max(...Object.values(gt.perClient).map((x) => x.loan)),
      JSON.stringify({ top: domOrder[0], perClient: gt.perClient }));

    // D3 — the tags: date + £ per affected row (owner sees the £).
    const tags = await page.evaluate(() =>
      [...document.querySelectorAll("#dh-missing-panel .dh-rate-tag")].map((t) => ({ c: t.dataset.client, t: (t.textContent || "").replace(/\s+/g, " ").trim() })));
    eq("D3 · every priced row carries the rate-ending tag with its soonest date and its £ — and only those rows",
      tags, gt.rankedIds.filter((id) => gt.perClient[id]).map((id) => ({
        c: id, t: `rate ending ${fmtDay(gt.perClient[id].date)}${gt.perClient[id].loan ? ` · ${gt.perClient[id].loan.toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 })}` : ""}`,
      })));

    // D4 — the R77 inline fix still works on the ranked list, and the tile still decrements.
    const before = await page.evaluate(() => ({
      tile: (document.querySelector("#dh-tile-email .num") || {}).textContent.trim(),
      top: document.querySelector("#dh-missing-panel .dh-fix[data-client]").dataset.client,
    }));
    await page.evaluate((id) => {
      const w = document.querySelector(`#dh-missing-panel .dh-fix[data-client="${id}"]`);
      w.querySelector(".dh-fix-input").value = "fixed.r80@example.com";
      w.querySelector(".dh-fix-save").click();
    }, before.top);
    await wait(page, 1100);
    const after = await page.evaluate(async (id) => ({
      db: ((await window.__mockDb.from("clients").select("email").eq("id", id).single()).data || {}).email,
      rowGone: !document.querySelector(`#dh-missing-panel .dh-fix[data-client="${id}"]`),
      tile: (document.querySelector("#dh-tile-email .num") || {}).textContent.trim(),
    }), before.top);
    ok("D4 · the top (most expensive) row's inline fix saves and the row leaves",
      after.db === "fixed.r80@example.com" && after.rowGone, JSON.stringify(after));
    const bN = before.tile.match(/^(\d+)/), aN = after.tile.match(/^(\d+)/);
    ok("D4b · the missing-email tile comes down by one (R77's counter contract, unbroken by the rank)",
      bN && aN && Number(aN[1]) === Number(bN[1]) - 1, `${before.tile} → ${after.tile}`);

    // D5 — the Retention gone-quiet summary carries the SHORT clause where it applies.
    await goPage(page, "retention", 3000);
    const retGT = await page.evaluate(async () => {
      const data = await window.clientDataCached(true);
      const cold = window.coldClients(data, "all");
      const months = Number(((await window.__mockDb.from("settings").select("value").eq("key", "rate_reminder_months")).data[0] || {}).value) || 6;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const edgeD = new Date(today + "T12:00:00"); edgeD.setDate(edgeD.getDate() + months * 30);
      const edge = `${edgeD.getFullYear()}-${String(edgeD.getMonth() + 1).padStart(2, "0")}-${String(edgeD.getDate()).padStart(2, "0")}`;
      const noEmail = cold.filter((c) => !c.email);
      const loan = noEmail.reduce((s, c) => s + (c.cases || []).reduce((t, x) => {
        const d = x && x.stage === "completed" && x.rate_end_date ? String(x.rate_end_date).slice(0, 10) : null;
        return t + (d && d >= today && d <= edge && x.loan_amount ? Number(x.loan_amount) : 0);
      }, 0), 0);
      return { n: noEmail.length, loan };
    });
    const sub = await txt(page, "#ret-cold-sub");
    if (retGT.n) {
      ok("D5 · the gone-quiet summary names its unreachable clients and the only chase there is",
        new RegExp(`${retGT.n === 1 ? "One of these clients has" : `${retGT.n} of these clients have`} no email on file`).test(sub || "")
        && /the call is the only chase there is/.test(sub || ""), sub);
      ok("D5b · …with the short £ clause where the lending matures (or none where none does)",
        retGT.loan ? ((sub || "").includes(fmtGBP(retGT.loan)) && /not a fee forecast/.test(sub || "") && /Data health/.test(sub || "")) : !/rides on it/.test(sub || ""),
        `${sub} · want £=${retGT.loan}`);
    } else {
      ok("D5 · no gone-quiet client lacks an email, so the clause honestly does not render", !/no email on file/.test(sub || ""), sub);
    }
    /* D5c — drive the clause deliberately: a gone-quiet, no-email client with an in-window
       maturing completed case is seeded IN THIS PAGE ONLY (the mock DB is per-tab, so the
       battery's shared fixtures never move), then the panel is re-rendered. Whatever the
       natural book held, this proves the sentence, the £ and the Data-health pointer render
       when the fact is true. */
    const seeded = await page.evaluate(async () => {
      const db = window.__mockDb;
      const edge = new Date(Date.now() + 80 * 86400000);
      const ymd = `${edge.getFullYear()}-${String(edge.getMonth() + 1).padStart(2, "0")}-${String(edge.getDate()).padStart(2, "0")}`;
      const { data: cl } = await db.from("clients").insert({ first_name: "Quietly", last_name: "R80unreach", email: null, phone: "07700 900321" }).select("id").single();
      await db.from("cases").insert({ client_id: cl.id, case_kind: "remortgage", stage: "completed", loan_amount: 91000, rate_end_date: ymd, assigned_to: "p2", completed_at: new Date(Date.now() - 400 * 86400000).toISOString() });
      return { clientId: cl.id };
    });
    await goPage(page, "retention", 3000);
    const retGT2 = await page.evaluate(async () => {
      const data = await window.clientDataCached(true);
      const cold = window.coldClients(data, "all");
      const months = Number(((await window.__mockDb.from("settings").select("value").eq("key", "rate_reminder_months")).data[0] || {}).value) || 6;
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const edgeD = new Date(today + "T12:00:00"); edgeD.setDate(edgeD.getDate() + months * 30);
      const edge = `${edgeD.getFullYear()}-${String(edgeD.getMonth() + 1).padStart(2, "0")}-${String(edgeD.getDate()).padStart(2, "0")}`;
      const noEmail = cold.filter((c) => !c.email);
      const loan = noEmail.reduce((s, c) => s + (c.cases || []).reduce((t, x) => {
        const d = x && x.stage === "completed" && x.rate_end_date ? String(x.rate_end_date).slice(0, 10) : null;
        return t + (d && d >= today && d <= edge && x.loan_amount ? Number(x.loan_amount) : 0);
      }, 0), 0);
      return { n: noEmail.length, loan, seededCold: noEmail.some((c) => c.last_name === "R80unreach") };
    });
    const sub2 = await txt(page, "#ret-cold-sub");
    ok("D5c · the seeded no-email client IS gone-quiet (no comms ever) and carries in-window lending",
      retGT2.seededCold && retGT2.n >= 1 && retGT2.loan >= 91000, JSON.stringify(retGT2));
    ok("D5d · the summary now carries the clause: N, the only-chase sentence, the £, the pointer",
      new RegExp(`${retGT2.n === 1 ? "One of these clients has" : `${retGT2.n} of these clients have`} no email on file`).test(sub2 || "")
      && /the call is the only chase there is/.test(sub2 || "")
      && (sub2 || "").includes(fmtGBP(retGT2.loan)) && /not a fee forecast/.test(sub2 || "") && /Data health/.test(sub2 || ""), sub2);
    void seeded;
    ok("§D · no console errors (p4)", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();

    // D6 — an admin gets the count and the honest £-gate clause, no figure, £-less tags.
    const p1 = await boot(browser, "p1");
    await goPage(p1, "data", 2800);
    const gt1 = await dhGT(p1);   // re-read: §D4's fix above removed one row for good
    const admE = await txt(p1, "#dh-atrisk-email");
    ok("D6 · admin: the count sentence renders", (admE || "").startsWith(`${gt1.hit.length} unreachable client`), admE);
    ok("D6b · …the £ is withheld with the reason, not silently",
      /The £ at stake is shown to the Owner\./.test(admE || "") && !/£\d/.test(admE || ""), admE);
    const admTag = await p1.evaluate(() =>
      [...document.querySelectorAll("#dh-missing-panel .dh-rate-tag")].map((t) => t.textContent));
    ok("D6c · the tags keep their date and drop their £ for an admin",
      admTag.length === gt1.hit.length && admTag.every((t) => /rate ending /.test(t) && !/£/.test(t)), JSON.stringify(admTag));
    ok("§D · no console errors (p1)", realErrs(p1).length === 0, realErrs(p1).join(" | ").slice(0, 300));
    await p1.close();
  }

  /* =======================================================================
     §E · B3 — audit coverage, verb by verb
     ===================================================================== */
  const auditRowsFor = (page, table, rowId) => page.evaluate(async (o) => {
    let q = window.__mockDb.from("audit_log").select("action,table_name,row_id,summary,changes,actor").eq("table_name", o.table);
    const rows = (await q).data || [];
    return rows.filter((r) => !o.rowId || r.row_id === o.rowId).map((r) => ({ action: r.action, row_id: r.row_id, changes: r.changes }));
  }, { table, rowId: rowId || null });
  const mkClientCase = (page, o) => page.evaluate(async (opt) => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({
      first_name: opt.first, last_name: opt.last, email: opt.email === undefined ? null : opt.email,
    }).select("id").single();
    const row = Object.assign({ client_id: cl.id, case_kind: "remortgage", stage: "application", assigned_to: "p2", protection_status: "discussed" }, opt.kase || {});
    const { data: cs } = await db.from("cases").insert(row).select("id").single();
    return { clientId: cl.id, caseId: cs.id };
  }, o);

  {
    console.log("\n— §E1 · bulk stage move audits via the cases trigger (p1)");
    const page = await boot(browser, "p1");
    const ids = [];
    for (const n of ["Auditone", "Audittwo"]) ids.push((await mkClientCase(page, { first: "R80", last: n, kase: { stage: "enquiry" } })).caseId);
    await goPage(page, "pipeline", 2000);
    const isBoard = await page.evaluate(() => !document.querySelector("#board").classList.contains("hidden"));
    if (isBoard) { await page.click("#view-toggle"); await wait(page, 1200); }
    for (const id of ids) await page.check(`#pipe-table .bulk-cb[data-id="${id}"]`);
    await page.selectOption("#pipe-bulk-stage", "fact_find");
    await wait(page, 1200);
    await page.click("#ovl-confirm-ok");
    await wait(page, 2400);
    for (const id of ids) {
      const rows = (await auditRowsFor(page, "cases", id)).filter((r) => r.action === "update" && r.changes && r.changes.stage);
      ok(`E1 · bulkMoveStage left a cases-update audit row (stage diff) for ${id === ids[0] ? "case 1" : "case 2"}`,
        rows.length >= 1 && rows.some((r) => r.changes.stage.new === "fact_find"), JSON.stringify(rows));
    }
    ok("§E1 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E2 · a stage move and its Undo are BOTH audited cases updates (p1)");
    const page = await boot(browser, "p1");
    const gt = await mkClientCase(page, { first: "R80", last: "Undomove", kase: { stage: "fact_find" } });
    await goPage(page, "pipeline", 2000);
    await page.evaluate((id) => window.moveCaseToStage(id, "decision_in_principle"), gt.caseId);
    await wait(page, 1600);
    const moved = (await auditRowsFor(page, "cases", gt.caseId)).filter((r) => r.action === "update" && r.changes && r.changes.stage);
    ok("E2 · the move itself is an audited cases update (fact_find → DIP)",
      moved.length === 1 && moved[0].changes.stage.new === "decision_in_principle", JSON.stringify(moved));
    await page.click("#toast-action");   // the R74 Undo, riding the move's own toast
    await wait(page, 1600);
    const undone = (await auditRowsFor(page, "cases", gt.caseId)).filter((r) => r.action === "update" && r.changes && r.changes.stage);
    ok("E2b · the Undo is a SECOND audited update back to fact_find — the trail keeps both",
      undone.length === 2 && undone.some((r) => r.changes.stage.new === "fact_find" && r.changes.stage.old === "decision_in_principle"), JSON.stringify(undone));
    ok("§E2 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E3 · the completion overlay audits, and email_queue never does (p4)");
    const page = await boot(browser, "p4");
    const gt = await mkClientCase(page, { first: "R80", last: "Completer", email: "r80.completer@example.com", kase: { stage: "exchange", rate_end_date: "2029-01-01" } });
    await page.evaluate(({ id }) => { window.__r80mv = window.moveCaseToStage(id, "completed"); }, { id: gt.caseId });
    await page.waitForSelector("#stage-completed-ok", { timeout: 8000 });
    await page.click("#stage-completed-ok");
    await wait(page, 1600);
    const rows = (await auditRowsFor(page, "cases", gt.caseId)).filter((r) => r.action === "update");
    ok("E3 · the overlay's move left a cases-update audit row carrying the stage change",
      rows.some((r) => r.changes && r.changes.stage && r.changes.stage.new === "completed"), JSON.stringify(rows));
    // The accepted gap, pinned as an invariant: email_queue NEVER appears in audit_log —
    // production gives it log_email_event only, not audit_row, and the mock mirrors that.
    const eqAudit = await page.evaluate(async () =>
      (await window.__mockDb.from("audit_log").select("id").eq("table_name", "email_queue")).data.length);
    eq("E3b · email_queue rows (the completion trigger's congrats included) leave NO audit_log row — the documented gap", eqAudit, 0);
    ok("§E3 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E4 · diary drag + Undo audit as appointment updates (p2)");
    const page = await boot(browser, "p2");
    const gt = await mkClientCase(page, { first: "R80", last: "Diarymove", kase: { assigned_to: "p2" } });
    const base = new Date(); base.setDate(base.getDate() + 1);
    const at = (d, h) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, 0).toISOString();
    const apptId = await page.evaluate(async (o) => {
      const { data } = await window.__mockDb.from("appointments").insert({
        client_id: o.clientId, case_id: o.caseId, title: "R80 audit drag",
        starts_at: o.s, ends_at: o.e, staff_id: "p2",
      }).select("id").single();
      return data.id;
    }, { clientId: gt.clientId, caseId: gt.caseId, s: at(base, 10), e: at(base, 11) });
    await goPage(page, "diary", 2600);
    const target = new Date(base); target.setDate(target.getDate() + 1);
    const ymd = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
    await page.evaluate(async ({ id, d }) => { await window.diaryMoveAppt(id, { date: d }); }, { id: apptId, d: ymd });
    await wait(page, 1400);
    const afterMove = await auditRowsFor(page, "appointments", apptId);
    ok("E4 · the drag verb left an appointments-update audit row",
      afterMove.filter((r) => r.action === "update").length === 1, JSON.stringify(afterMove));
    await page.click("#toast-action");
    await wait(page, 1400);
    const afterUndo = await auditRowsFor(page, "appointments", apptId);
    eq("E4b · Undo is a second audited update — the trail keeps both moves",
      afterUndo.filter((r) => r.action === "update").length, 2);
    ok("§E4 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E5 · client merge audits every write it makes (p1)");
    const page = await boot(browser, "p1");
    await goPage(page, "data", 2000);
    const pair = await page.evaluate(async () => {
      const db = window.__mockDb;
      const { data: keep } = await db.from("clients").insert({ first_name: "Ramona", last_name: "Auditmerge", email: "r.auditmerge@r80.example.com", phone: null }).select("id").single();
      const { data: lose } = await db.from("clients").insert({ first_name: "Ramona", last_name: "Auditmerge", email: "R.Auditmerge@R80.Example.com", phone: "07999 880001" }).select("id").single();
      const { data: cs } = await db.from("cases").insert({ client_id: keep.id, case_kind: "purchase", stage: "enquiry", assigned_to: "p2" }).select("id").single();
      return { keep: keep.id, lose: lose.id, caseId: cs.id };
    });
    await page.evaluate(({ a, b }) => window.openMergeClients(a, b, "same email address", 0.98), { a: pair.keep, b: pair.lose });
    await wait(page, 900);
    await page.click("#merge-now");
    await wait(page, 1800);
    const audit = await page.evaluate(async (o) => {
      const db = window.__mockDb;
      const rows = (await db.from("audit_log").select("action,table_name,row_id").in("table_name", ["clients", "case_notes"])).data;
      return {
        loserDeleted: rows.filter((r) => r.table_name === "clients" && r.action === "delete" && r.row_id === o.lose).length,
        survivorUpdated: rows.filter((r) => r.table_name === "clients" && r.action === "update" && r.row_id === o.keep).length,
        noteInserted: (await db.from("case_notes").select("id,body").eq("case_id", o.caseId)).data
          .filter((n) => /merged by/.test(n.body)).length,
        noteAudited: rows.filter((r) => r.table_name === "case_notes" && r.action === "insert").length,
      };
    }, pair);
    ok("E5 · the loser's deletion is audited", audit.loserDeleted === 1, JSON.stringify(audit));
    ok("E5b · the survivor's field update is audited", audit.survivorUpdated >= 1, JSON.stringify(audit));
    ok("E5c · the merge note exists and its insert is audited (the note IS the human trail)",
      audit.noteInserted === 1 && audit.noteAudited >= 1, JSON.stringify(audit));
    ok("§E5 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E6 · dup-create-anyway audits the deliberate duplicate (p1)");
    const page = await boot(browser, "p1");
    const target = await page.evaluate(async () =>
      (await window.__mockDb.from("clients").select("id,email").eq("id", "cl001").single()).data);
    await goPage(page, "clients", 1800);
    await page.click("#new-client-btn");
    await wait(page, 500);
    await page.fill('#client-form [name="first_name"]', "Deliberate");
    await page.fill('#client-form [name="last_name"]', "R80dupe");
    await page.fill('#client-form [name="email"]', target.email);
    await page.click("#modal-save");
    await wait(page, 900);
    ok("E6 · the gate raised the overlay first", !!(await page.$("#dup-client-overlay")));
    await page.click("#dup-client-create");
    await wait(page, 1300);
    const made = await page.evaluate(async () => {
      const db = window.__mockDb;
      const cl = (await db.from("clients").select("id").eq("last_name", "R80dupe")).data[0];
      const rows = (await db.from("audit_log").select("action,row_id,actor").eq("table_name", "clients")).data
        .filter((r) => cl && r.row_id === cl.id && r.action === "insert");
      return { made: !!cl, audited: rows.length, actor: rows[0] && rows[0].actor };
    });
    ok("E6b · Create anyway's insert is audited, with the pressing person as actor",
      made.made && made.audited === 1 && made.actor === "p1", JSON.stringify(made));
    ok("§E6 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E7 · both regenerate-link paths audit their token rotation (p1)");
    const page = await boot(browser, "p1");
    // (a) the fact-find regenerate — the verb the new fact_finds parity exists for.
    const expired = await page.evaluate(async () =>
      (await window.__mockDb.from("fact_finds").select("id,case_id,client_id").eq("token", "ff-demo-0002-sent").single()).data);
    await page.evaluate((o) => window.factFind(o.case_id, o.client_id), expired);
    await wait(page, 900);
    await page.evaluate(() => document.querySelector("#ff-regen").click());
    await wait(page, 600);
    await page.click("#ovl-confirm-ok");
    await wait(page, 1100);
    const ffAudit = await auditRowsFor(page, "fact_finds", expired.id);
    ok("E7 · #ff-regen leaves a fact_finds-update audit row carrying the token diff (new mock parity)",
      ffAudit.some((r) => r.action === "update" && r.changes && r.changes.token && r.changes.token.old === "ff-demo-0002-sent"),
      JSON.stringify(ffAudit));
    await page.evaluate(() => window.closeModal());
    // (b) the doc-link regenerate — cases has always been audited; the verb is pinned anyway.
    const quirke = await page.evaluate(async () =>
      (await window.__mockDb.from("cases").select("id,doc_token").eq("doc_token", "doc-quirke-90b7ae").single()).data);
    await page.evaluate((id) => window.openCase(id), quirke.id);
    await wait(page, 1600);
    await page.click("#docs-link-regen");
    await wait(page, 600);
    await page.click("#ovl-confirm-ok");
    await wait(page, 1300);
    const docAudit = (await auditRowsFor(page, "cases", quirke.id)).filter((r) => r.action === "update" && r.changes && r.changes.doc_token);
    ok("E7b · #docs-link-regen leaves a cases-update audit row carrying the doc_token diff",
      docAudit.length >= 1 && docAudit.some((r) => r.changes.doc_token.old === "doc-quirke-90b7ae"), JSON.stringify(docAudit));
    ok("§E7 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  {
    console.log("\n— §E8 · reassign_holdings audits every case it moves (p4)");
    const page = await boot(browser, "p4");
    await goPage(page, "pipeline", 2000);
    const moved = await page.evaluate(async () => {
      const db = window.__mockDb;
      /* the RPC's own scope: LIVE cases only — a completed file stays on its history's adviser */
      const before = (await db.from("cases").select("id,stage").eq("assigned_to", "p2")).data
        .filter((r) => r.stage !== "completed" && r.stage !== "not_proceeding")
        .map((r) => r.id);
      const t = await window.reassignHoldingsRpc("p2", "p3");
      const audits = (await db.from("audit_log").select("action,row_id,changes").eq("table_name", "cases")).data
        .filter((r) => r.action === "update" && r.changes && r.changes.assigned_to && r.changes.assigned_to.new === "p3");
      return { tally: t, movedIds: before, auditedIds: audits.map((r) => r.row_id) };
    });
    ok("E8 · the RPC moved a real book", moved.tally && moved.tally.cases >= 1, JSON.stringify(moved.tally));
    ok("E8b · every reassigned case has an assigned_to audit row (the RPC audits per case)",
      moved.movedIds.length >= 1 && moved.movedIds.every((id) => moved.auditedIds.includes(id)),
      JSON.stringify({ moved: moved.movedIds.length, audited: moved.auditedIds.length }));
    ok("§E8 · no console errors", realErrs(page).length === 0, realErrs(page).join(" | ").slice(0, 300));
    await page.close();
  }

  await browser.close();
  if (srv) srv.kill();
  console.log(`\nr80_ledger: ${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => "  ✗ " + f).join("\n")); process.exit(1); }
})();
