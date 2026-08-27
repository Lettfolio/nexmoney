#!/usr/bin/env node
/* =============================================================================
   tests/r66_comms.js — acceptance tests for R66 · agent B (comms + referrals)

   §A  CUSTOM EMAIL (M8) — "✉️ Write to client" on the case action bar: primary
       at every live stage and on a completed case that still tracks a rate,
       demoted (never removed) on a completed case with nothing tracked, and
       ABSENT on not_proceeding. The overlay validates (no subject / no body
       refused; a client with no email address disables the whole thing and
       says why), carries the sign-off preview and the standing HELD note, and
       queues exactly ONE email_queue row: email_type 'custom', the client's
       address, the adviser's subject, and body_html = the plain text ESCAPED
       and split into <p> paragraphs (blank line = paragraph, single newline =
       <br>). The case timeline then reads
       "Email (written by adviser) — <subject>".

   §B  REFERRAL KINDS + `referred` (M6a) — protection and GI join survey and
       conveyancing: same overlay, same chase task, rows with the right `kind`.
       A protection referral from a case at not_discussed/discussed OFFERS
       (ticked) to set protection_status to `referred`, and honours the tick
       both ways. `referred` then renders in the case form select, on the
       Protection page (badge + its own R61 band), passes the protection gate
       exactly as quoted/policy_taken/declined do, and is NOT counted as a
       protection gap on the client record (R56's gap card).

   §C  REFERRALS-OUT REPORT (M6b) — Reports gains a sixth section with its jump
       chip. The kind × status × adviser grouping is checked against counts
       recomputed independently off window.__mockDb, the month picker scopes it,
       the Mine/All segment scopes it, and the CSV carries every row in scope.

   §D  No console/page errors on the two personas this round touches (p2, p4).

   Run:  node /root/nx/tests/r66_comms.js   (expects a static server on 8099;
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
function eq(name, got, want) { ok(name, got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); }

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

/* CSV capture — the technique tests/r20.js established: miCsv() is not exposed on window, so
   URL.createObjectURL + the <a download> click are overridden and the Blob is read back. */
async function armCsvCapture(page) {
  await page.evaluate(() => {
    window.__csvBlob = null; window.__csvName = null;
    if (!window.__csvArmed) {
      const origCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b) => { window.__csvBlob = b; try { return origCreate(b); } catch (e) { return "blob:captured"; } };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { if (this.hasAttribute("download")) { window.__csvName = this.getAttribute("download"); return; } return origClick.apply(this, arguments); };
      window.__csvArmed = true;
    }
  });
}
const readCsv = (page) => page.evaluate(async () => (window.__csvBlob ? await window.__csvBlob.text() : null));
const readCsvName = (page) => page.evaluate(() => window.__csvName);

const openCase = async (page, id) => { await page.evaluate((i) => window.openCase(i), id); await page.waitForTimeout(900); };
const closeModal = async (page) => { await page.evaluate(() => window.closeModal && window.closeModal()); await page.waitForTimeout(300); };

(async () => {
  const srv = await ensureServer();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(`${BASE}?as=p4`, { waitUntil: "networkidle" });
  await page.waitForTimeout(SETTLE);

  /* ---------------- fixtures ---------------- */
  const fx = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cls } = await db.from("clients").select("id,email,first_name,last_name").not("email", "is", null).limit(1);
    const cl = cls[0];
    const { data: noEmailClient } = await db.from("clients")
      .insert({ first_name: "Nomail", last_name: "Tester" }).select("id").single();
    const mk = async (o) => (await db.from("cases")
      .insert(Object.assign({ client_id: cl.id, case_kind: "purchase", assigned_to: "p4" }, o))
      .select("id").single()).data.id;
    return {
      clientId: cl.id,
      email: cl.email,
      who: [cl.first_name, cl.last_name].filter(Boolean).join(" "),
      live: await mk({ stage: "application", protection_status: "discussed" }),
      np: await mk({ stage: "not_proceeding" }),
      compTracked: await mk({ stage: "completed", rate_end_date: "2030-06-01" }),
      compNoRate: await mk({ stage: "completed" }),
      noEmail: (await db.from("cases").insert({ client_id: noEmailClient.id, case_kind: "purchase", stage: "application", assigned_to: "p4" }).select("id").single()).data.id,
      protDiscussed: await mk({ stage: "offer", protection_status: "discussed" }),
      protNotDiscussed: await mk({ stage: "offer", protection_status: "not_discussed" }),
      protQuoted: await mk({ stage: "offer", protection_status: "quoted" }),
      giCase: await mk({ stage: "exchange", protection_status: "quoted" }),
    };
  });

  /* =================== §A · the email somebody writes =================== */
  console.log("— §A · custom email from the case");

  const barAt = async (id) => {
    await openCase(page, id);
    return page.evaluate(() => ({
      present: !!document.querySelector("#act-write"),
      primary: !!document.querySelector("#case-action-bar > #act-write"),
      overflow: !!document.querySelector("#case-more-actions #act-write"),
    }));
  };
  const aLive = await barAt(fx.live);
  ok("A1 · Write to client is a PRIMARY action on a live case", aLive.present && aLive.primary, JSON.stringify(aLive));
  const aTracked = await barAt(fx.compTracked);
  ok("A2 · …and on a completed case that still tracks a rate", aTracked.present && aTracked.primary, JSON.stringify(aTracked));
  const aNoRate = await barAt(fx.compNoRate);
  ok("A3 · completed with nothing tracked demotes it to the overflow, never removes it", aNoRate.present && !aNoRate.primary && aNoRate.overflow, JSON.stringify(aNoRate));
  const aNp = await barAt(fx.np);
  ok("A4 · absent entirely on a not_proceeding case", !aNp.present, JSON.stringify(aNp));
  await closeModal(page);

  // The overlay, on a client with no email at all.
  await openCase(page, fx.noEmail);
  await page.click("#act-write");
  await page.waitForTimeout(400);
  const aNoEmail = await page.evaluate(() => ({
    open: !!document.querySelector("#overlay-modal #cust-to"),
    toDisabled: !!(document.querySelector("#cust-to") || {}).disabled,
    okDisabled: !!(document.querySelector("#cust-ok") || {}).disabled,
    explains: !!document.querySelector(".cust-noemail"),
    explainText: (document.querySelector(".cust-noemail") || {}).textContent || "",
  }));
  ok("A5 · a client with no email address disables the form and says why", aNoEmail.open && aNoEmail.toDisabled && aNoEmail.okDisabled && aNoEmail.explains && /no email address/i.test(aNoEmail.explainText), JSON.stringify(aNoEmail));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await closeModal(page);

  // The overlay proper.
  await openCase(page, fx.live);
  await page.click("#act-write");
  await page.waitForTimeout(400);
  const aOv = await page.evaluate(() => ({
    to: (document.querySelector("#cust-to") || {}).value,
    readonly: !!(document.querySelector("#cust-to") || {}).readOnly,
    preview: (document.querySelector("#cust-preview") || {}).textContent || "",
    held: (document.querySelector("#cust-held") || {}).textContent || "",
    max: (document.querySelector("#cust-body") || {}).getAttribute ? document.querySelector("#cust-body").getAttribute("maxlength") : null,
  }));
  eq("A6 · To is the client's address, read-only", aOv.to, fx.email);
  ok("A6b · …and it cannot be typed over", aOv.readonly);
  ok("A7 · the sign-off preview names the signatory and the house template", /Sent as/.test(aOv.preview) && /sign-off/.test(aOv.preview) && /house template/.test(aOv.preview), JSON.stringify(aOv.preview));
  ok("A8 · the standing HELD note is on the overlay", /QUEUED and held/.test(aOv.held) && /email sending goes live/.test(aOv.held), JSON.stringify(aOv.held));
  eq("A9 · the body is capped at 4,000 characters", aOv.max, "4000");

  await page.click("#cust-ok");
  await page.waitForTimeout(250);
  const aErr1 = await page.evaluate(() => (document.querySelector("#cust-err") || {}).textContent || "");
  ok("A10 · an empty subject is refused", /subject/i.test(aErr1), JSON.stringify(aErr1));
  await page.fill("#overlay-modal #cust-subject", "Quick one before your Oct rate");
  await page.click("#cust-ok");
  await page.waitForTimeout(250);
  const aErr2 = await page.evaluate(() => (document.querySelector("#cust-err") || {}).textContent || "");
  ok("A11 · an empty body is refused", /message/i.test(aErr2), JSON.stringify(aErr2));
  ok("A12 · nothing was queued while the form was invalid",
    (await page.evaluate(async (id) => (await window.__mockDb.from("email_queue").select("id").eq("case_id", id)).data.length, fx.live)) === 0);

  await page.fill("#overlay-modal #cust-body", "Hi Sarah,\nAre you still keeping <b>number 12</b>?\n\nBest,\nDan");
  await page.click("#cust-ok");
  await page.waitForTimeout(1600);

  const aRow = await page.evaluate(async (id) => {
    const { data } = await window.__mockDb.from("email_queue").select("*").eq("case_id", id);
    return data;
  }, fx.live);
  eq("A13 · exactly one email_queue row was written", aRow.length, 1);
  const q = aRow[0] || {};
  eq("A14 · …email_type is 'custom'", q.email_type, "custom");
  eq("A15 · …to_email is the client's address", q.to_email, fx.email);
  eq("A16 · …client_id is the case's client", q.client_id, fx.clientId);
  eq("A17 · …subject is the adviser's own", q.subject, "Quick one before your Oct rate");
  eq("A18 · …body_html is escaped text in <p> paragraphs, single newline = <br>",
    q.body_html, "<p>Hi Sarah,<br>Are you still keeping &lt;b&gt;number 12&lt;/b&gt;?</p><p>Best,<br>Dan</p>");
  ok("A19 · …the adviser's literal <b> reaches the client as text, not as markup",
    /&lt;b&gt;/.test(q.body_html || "") && !/<b>/.test(q.body_html || ""), JSON.stringify(q.body_html));

  const aSend = await page.evaluate(() => {
    const r = window.__mock.lastEmailRun();
    const c = (r && r.composed || []).filter((x) => x.email_type === "custom")[0] || null;
    return { sent: r && r.sent, scoped: r && r.scoped, composed: c };
  });
  ok("A20 · the send stub treats it like any other row (queued → sent, scoped to that row)", aSend.sent === 1 && aSend.scoped === true, JSON.stringify({ sent: aSend.sent, scoped: aSend.scoped }));
  eq("A21 · …and body_html survives compose verbatim", aSend.composed && aSend.composed.body_html, q.body_html);
  eq("A22 · …with the adviser's subject, not a composed one", aSend.composed && aSend.composed.subject, "Quick one before your Oct rate");
  eq("A23 · the row's status flowed to sent", q.status, "sent");

  await openCase(page, fx.live);
  await page.waitForTimeout(600);
  const aTl = await page.evaluate(() => [...document.querySelectorAll(".tl-row")]
    .map((r) => (r.querySelector(".tl-title") || {}).textContent || "")
    .filter((t) => /written by adviser/.test(t)));
  ok("A24 · the case timeline reads 'Email (written by adviser) — <subject>'",
    aTl.length === 1 && /Email \(written by adviser\) — Quick one before your Oct rate/.test(aTl[0]), JSON.stringify(aTl));
  await closeModal(page);

  // The mock's enum mirror: 'custom' is accepted, an invented type is not.
  const aEnum = await page.evaluate(async (o) => {
    const db = window.__mockDb;
    const good = await db.from("email_queue").insert({ case_id: o.live, client_id: o.clientId, email_type: "custom", to_email: o.email, subject: "s", body_html: "<p>x</p>" }).select("id").single();
    const bad = await db.from("email_queue").insert({ case_id: o.live, client_id: o.clientId, email_type: "not_a_type", to_email: o.email }).select("id").single();
    if (good.data && good.data.id) await db.from("email_queue").delete().eq("id", good.data.id);
    return { goodOk: !good.error, badErr: bad.error ? bad.error.code : null, badMsg: bad.error ? bad.error.message : null };
  }, fx);
  ok("A25 · the mock accepts 'custom' as an email_type", aEnum.goodOk, JSON.stringify(aEnum));
  ok("A26 · …and still refuses a type the enum has never heard of", aEnum.badErr === "22P02" && /email_type/.test(aEnum.badMsg || ""), JSON.stringify(aEnum));

  // The Clients bulk bar note now describes what exists.
  await page.evaluate(() => { location.hash = "#clients"; });
  await page.waitForTimeout(SETTLE);
  const aNote = await page.evaluate(() => {
    const cb = document.querySelector("#client-list .client-cb, #client-list input[type=checkbox]");
    if (cb) { cb.click(); }
    return null;
  });
  await page.waitForTimeout(900);
  const aNoteText = await page.evaluate(() => (document.querySelector("#client-bulk-note") || {}).textContent || "");
  ok("A27 · the Clients bulk bar note says a written email exists per case, and bulk waits on a template",
    /Write to client/.test(aNoteText) && /template decision/.test(aNoteText), JSON.stringify(aNoteText.slice(0, 200)));

  /* ============== §B · referral kinds + the `referred` status ============== */
  console.log("\n— §B · protection / GI referrals and the `referred` protection status");

  await openCase(page, fx.protDiscussed);
  const bTiles = await page.evaluate(() => ({
    prot: !!document.querySelector("#act-ref-protection"),
    protPrimary: !!document.querySelector("#case-action-bar > #act-ref-protection"),
    gi: !!document.querySelector("#act-ref-gi"),
    survey: !!document.querySelector("#act-ref-survey"),
  }));
  ok("B1 · the protection and GI referral actions exist on the case", bTiles.prot && bTiles.gi, JSON.stringify(bTiles));
  ok("B2 · protection is primary at offer", bTiles.protPrimary, JSON.stringify(bTiles));

  await page.click("#act-ref-protection");
  await page.waitForTimeout(400);
  const bOv = await page.evaluate(() => ({
    open: !!document.querySelector("#overlay-modal #ref-to"),
    tick: !!document.querySelector("#overlay-modal #ref-set-prot"),
    ticked: !!(document.querySelector("#overlay-modal #ref-set-prot") || {}).checked,
    heading: (document.querySelector("#overlay-modal h3") || {}).textContent || "",
  }));
  ok("B3 · the capture overlay opens with the protection heading", bOv.open && /protection advice/i.test(bOv.heading), JSON.stringify(bOv));
  ok("B4 · …and offers to set the case to Referred, ticked by default", bOv.tick && bOv.ticked, JSON.stringify(bOv));
  await page.fill("#overlay-modal #ref-to", "Network Protection Team");
  await page.click("#overlay-modal #ref-ok");
  await page.waitForTimeout(1400);

  const bAfter = await page.evaluate(async (id) => {
    const db = window.__mockDb;
    const { data: c } = await db.from("cases").select("protection_status").eq("id", id).single();
    const { data: refs } = await db.from("referrals").select("*").eq("case_id", id);
    const { data: tasks } = await db.from("case_tasks").select("title").eq("case_id", id);
    return { prot: c.protection_status, refs: (refs || []).map((r) => ({ kind: r.kind, to: r.referred_to, status: r.status })), tasks: (tasks || []).map((t) => t.title) };
  }, fx.protDiscussed);
  eq("B5 · one referrals row, kind 'protection'", (bAfter.refs[0] || {}).kind, "protection");
  eq("B6 · …referred_to captured", (bAfter.refs[0] || {}).to, "Network Protection Team");
  ok("B7 · …with the same chase task the survey referral creates", bAfter.tasks.some((t) => /Chase protection referral outcome/.test(t)), JSON.stringify(bAfter.tasks));
  eq("B8 · the ticked box set protection_status to `referred` in the same gesture", bAfter.prot, "referred");
  await closeModal(page);

  // Unticked: the referral lands, the status does not move.
  await openCase(page, fx.protNotDiscussed);
  await page.click("#act-ref-protection");
  await page.waitForTimeout(400);
  await page.fill("#overlay-modal #ref-to", "Network Protection Team");
  await page.uncheck("#overlay-modal #ref-set-prot");
  await page.click("#overlay-modal #ref-ok");
  await page.waitForTimeout(1400);
  const bUntick = await page.evaluate(async (id) => {
    const db = window.__mockDb;
    const { data: c } = await db.from("cases").select("protection_status").eq("id", id).single();
    const { data: refs } = await db.from("referrals").select("kind").eq("case_id", id);
    return { prot: c.protection_status, n: (refs || []).length };
  }, fx.protNotDiscussed);
  eq("B9 · unticked, the protection status is left exactly where it was", bUntick.prot, "not_discussed");
  eq("B9b · …and the referral still landed", bUntick.n, 1);
  await closeModal(page);

  // A case already quoted is never offered the downgrade.
  await openCase(page, fx.protQuoted);
  await page.click("#act-ref-protection");
  await page.waitForTimeout(400);
  ok("B10 · a case already quoted is not offered the status change (no outcome is ever walked back)",
    !(await page.evaluate(() => !!document.querySelector("#overlay-modal #ref-set-prot"))));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await closeModal(page);

  // GI.
  await openCase(page, fx.giCase);
  await page.click("#act-ref-gi");
  await page.waitForTimeout(400);
  ok("B11 · the GI overlay opens", await page.evaluate(() => !!document.querySelector("#overlay-modal #ref-to")));
  await page.fill("#overlay-modal #ref-to", "Paymentshield");
  await page.click("#overlay-modal #ref-ok");
  await page.waitForTimeout(1400);
  const bGi = await page.evaluate(async (id) => {
    const db = window.__mockDb;
    const { data: refs } = await db.from("referrals").select("kind,referred_to").eq("case_id", id);
    const { data: tasks } = await db.from("case_tasks").select("title").eq("case_id", id);
    return { refs: refs || [], tasks: (tasks || []).map((t) => t.title) };
  }, fx.giCase);
  eq("B12 · the GI referral row carries kind 'gi'", (bGi.refs[0] || {}).kind, "gi");
  ok("B13 · …and its own chase task", bGi.tasks.some((t) => /Chase gi referral outcome/i.test(t)), JSON.stringify(bGi.tasks));
  await closeModal(page);

  // The mock's widened CHECK.
  const bKinds = await page.evaluate(async (id) => {
    const db = window.__mockDb;
    const out = {};
    for (const k of ["survey", "conveyancing", "protection", "gi", "other", "nonsense"]) {
      const r = await db.from("referrals").insert({ case_id: id, kind: k, referred_to: "x" }).select("id").single();
      out[k] = r.error ? r.error.code : "ok";
      if (r.data && r.data.id) await db.from("referrals").delete().eq("id", r.data.id);
    }
    return out;
  }, fx.giCase);
  ok("B14 · the mock's referrals.kind CHECK accepts all five kinds",
    ["survey", "conveyancing", "protection", "gi", "other"].every((k) => bKinds[k] === "ok"), JSON.stringify(bKinds));
  eq("B15 · …and still refuses one that is not in the CHECK", bKinds.nonsense, "23514");

  // `referred` in the case form select.
  await openCase(page, fx.protDiscussed);
  const bSel = await page.evaluate(() => {
    const s = document.querySelector("#case-form") && document.querySelector("#case-form").elements.protection_status;
    if (!s) return null;
    return { values: [...s.options].map((o) => o.value), labels: [...s.options].map((o) => o.textContent), value: s.value };
  });
  ok("B16 · the case form's Protection select offers `referred`", bSel && bSel.values.includes("referred"), JSON.stringify(bSel && bSel.values));
  ok("B17 · …labelled in the firm's words", bSel && bSel.labels.some((l) => /Referred to protection adviser/i.test(l)), JSON.stringify(bSel && bSel.labels));
  eq("B18 · …and the referred case opens on it", bSel && bSel.value, "referred");
  const bChip = await page.evaluate(() => {
    const el = document.querySelector("#cs-prot-warn");
    return el ? { prot: el.dataset.prot, text: el.textContent } : null;
  });
  eq("B19 · the case header chip says referred", bChip && bChip.prot, "referred");
  ok("B19b · …in words a reader understands", bChip && /referred to protection adviser/i.test(bChip.text), JSON.stringify(bChip));
  await closeModal(page);

  // The gate: `referred` passes exactly as the other recorded outcomes do.
  const bGate = await page.evaluate(() => {
    const t = (st) => window.protectionGateBlocks({ stage: "fact_find", protection_status: st }, "application");
    return { not_discussed: t("not_discussed"), discussed: t("discussed"), quoted: t("quoted"), referred: t("referred"), policy_taken: t("policy_taken"), declined: t("declined") };
  });
  ok("B20 · `referred` passes the protection gate, exactly like quoted / policy_taken / declined",
    bGate.referred === false && bGate.quoted === false && bGate.policy_taken === false && bGate.declined === false && bGate.not_discussed === true, JSON.stringify(bGate));

  // The Protection page: badge + its own R61 band.
  await page.evaluate(() => { location.hash = "#protection"; });
  await page.waitForTimeout(SETTLE + 600);
  await page.evaluate(() => { const s = document.querySelector("#prot-filter"); if (s) { s.value = "all"; s.dispatchEvent(new Event("change")); } });
  await page.waitForTimeout(1400);
  const bProt = await page.evaluate(() => ({
    bulkOptions: [...document.querySelectorAll("#prot-bulk-status option, .prot-status-set option")].map((o) => o.value),
    referredBadges: [...document.querySelectorAll("#prot-list-table .badge")].filter((b) => /REFERRED/.test(b.textContent)).length,
    band: !!document.querySelector("#prot-list-table tr.prot-band-referred"),
    bandText: (document.querySelector("#prot-list-table tr.prot-band-referred") || {}).textContent || "",
    bandOrder: [...document.querySelectorAll("#prot-list-table tr.prot-band")].map((r) => (r.className.match(/prot-band-(\w+)/) || [])[1]),
  }));
  ok("B21 · `referred` is a settable protection status (the shared PROT_BULK_STATUS list)", bProt.bulkOptions.includes("referred"), JSON.stringify([...new Set(bProt.bulkOptions)]));
  ok("B22 · a referred case carries the REFERRED badge on the Protection table", bProt.referredBadges >= 1, JSON.stringify(bProt));
  ok("B23 · …under its own R61 band", bProt.band && /Referred/.test(bProt.bandText), JSON.stringify(bProt.bandText));
  const bi = bProt.bandOrder.indexOf("referred"), qi = bProt.bandOrder.indexOf("quoted"), di = bProt.bandOrder.indexOf("discussed");
  ok("B24 · …placed between quoted and discussed", bi >= 0 && (qi === -1 || qi < bi) && (di === -1 || bi < di), JSON.stringify(bProt.bandOrder));

  // The client record: a referred case is NOT a protection gap.
  const bGap = await page.evaluate(async () => {
    const db = window.__mockDb;
    const { data: cl } = await db.from("clients").insert({ first_name: "Gapcheck", last_name: "Referred" }).select("id").single();
    const { data: cs } = await db.from("cases").insert({ client_id: cl.id, case_kind: "purchase", stage: "offer", loan_amount: 200000, protection_status: "discussed" }).select("id").single();
    return { clientId: cl.id, caseId: cs.id };
  });
  await page.evaluate((id) => window.openClient(id), bGap.clientId);
  await page.waitForTimeout(1400);
  const bGapBefore = await page.evaluate(() => !!document.querySelector(".cl-gap-card"));
  ok("B25 · a mortgage book with only a `discussed` case still shows the protection gap card", bGapBefore);
  await closeModal(page);
  await page.evaluate(async (o) => { await window.__mockDb.from("cases").update({ protection_status: "referred" }).eq("id", o.caseId); }, bGap);
  await page.evaluate((id) => window.openClient(id), bGap.clientId);
  await page.waitForTimeout(1400);
  const bGapAfter = await page.evaluate(() => ({
    gap: !!document.querySelector(".cl-gap-card"),
    chip: (document.querySelector(".cl-prot-chip") || {}).dataset ? document.querySelector(".cl-prot-chip").dataset.prot : null,
    chipText: (document.querySelector(".cl-prot-chip") || {}).textContent || "",
  }));
  ok("B26 · once referred, it is NOT a protection gap", bGapAfter.gap === false, JSON.stringify(bGapAfter));
  eq("B27 · …and the client-record chip says so", bGapAfter.chip, "referred");
  ok("B27b · …in one word", /Referred/.test(bGapAfter.chipText), JSON.stringify(bGapAfter.chipText));
  await closeModal(page);

  /* ===================== §C · the referrals-out report ===================== */
  console.log("\n— §C · Reports §6 — referrals out");

  const thisMonth = await page.evaluate(() => {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  });
  const lastMonth = await page.evaluate(() => {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  });
  // Seed a spread: 4 kinds × 2 advisers × 2 statuses, this month; 3 more last month.
  const cSeed = await page.evaluate(async (o) => {
    const db = window.__mockDb;
    const { data: cases } = await db.from("cases").select("id,client_id").limit(8);
    const mkAt = (mv, day) => mv + "-" + String(day).padStart(2, "0") + "T10:00:00.000Z";
    const kinds = ["survey", "conveyancing", "protection", "gi"];
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const c = cases[i % cases.length];
      await db.from("referrals").insert({
        case_id: c.id, client_id: c.client_id, kind: kinds[i % 4],
        referred_to: "Partner " + (i % 4), created_by: i % 2 ? "p2" : "p4",
        status: i % 3 === 0 ? "completed" : "made",
        created_at: mkAt(o.thisMonth, 3 + i),
      });
      n++;
    }
    for (let i = 0; i < 3; i++) {
      const c = cases[i % cases.length];
      await db.from("referrals").insert({
        case_id: c.id, client_id: c.client_id, kind: "survey",
        referred_to: "Old partner", created_by: "p4", status: "made",
        created_at: mkAt(o.lastMonth, 10 + i),
      });
    }
    return { seeded: n };
  }, { thisMonth, lastMonth });
  ok("C0 · fixtures seeded across kinds, advisers, statuses and two months", cSeed.seeded === 8);

  await page.evaluate((mv) => { const p = document.querySelector("#report-month"); if (p) p.value = mv; location.hash = "#reports"; }, thisMonth);
  await page.waitForTimeout(SETTLE + 900);
  await page.evaluate((mv) => { const p = document.querySelector("#report-month"); if (p && p.value !== mv) { p.value = mv; p.dispatchEvent(new Event("change")); } });
  await page.waitForTimeout(1600);

  const cSec = await page.evaluate(() => ({
    head: !!document.querySelector("#rsec-referrals"),
    headHidden: (document.querySelector("#rsec-referrals") || {}).classList ? document.querySelector("#rsec-referrals").classList.contains("hidden") : null,
    panel: !!document.querySelector("#report-referrals-panel"),
    chip: !!document.querySelector("#reports-nav-referrals"),
    chipLabels: [...document.querySelectorAll("#reports-jump-chips .seg-btn")].map((b) => b.textContent),
    panelChip: !!document.querySelector("#rep-nav-referralsout"),
  }));
  ok("C1 · Reports has a sixth section with its own header and panel", cSec.head && cSec.panel && cSec.headHidden === false, JSON.stringify(cSec));
  ok("C2 · …and its jump chip", cSec.chip && cSec.chipLabels.includes("Referrals out"), JSON.stringify(cSec.chipLabels));
  ok("C2b · …plus the per-panel chip on the sticky strip", cSec.panelChip);

  // Owner opens on All. Recompute the grouping independently off the mock DB.
  const cGroups = await page.evaluate(async (mv) => {
    const db = window.__mockDb;
    const { data } = await db.from("referrals").select("*");
    const mine = (data || []).filter((r) => String(r.created_at).slice(0, 7) === mv);
    const map = {};
    mine.forEach((r) => {
      const k = [r.kind || "other", r.status || "made", r.created_by || ""].join("|");
      map[k] = (map[k] || 0) + 1;
    });
    const rendered = {};
    [...document.querySelectorAll("#report-ref-group-table .refout-group-row")].forEach((tr) => {
      rendered[[tr.dataset.kind, tr.dataset.status, tr.dataset.adviser].join("|")] = Number(tr.querySelector(".refout-n").textContent);
    });
    return { expected: map, rendered, total: Number((document.querySelector("#report-ref-total") || {}).textContent || 0), n: mine.length };
  }, thisMonth);
  const sameGroups = JSON.stringify(cGroups.expected) === JSON.stringify(cGroups.rendered)
    || (Object.keys(cGroups.expected).length === Object.keys(cGroups.rendered).length
        && Object.keys(cGroups.expected).every((k) => cGroups.expected[k] === cGroups.rendered[k]));
  ok("C3 · the kind × status × adviser grouping matches a count recomputed off window.__mockDb", sameGroups, JSON.stringify(cGroups));
  eq("C4 · …and the total agrees with the row count", cGroups.total, cGroups.n);

  const cList = await page.evaluate(() => ({
    rows: document.querySelectorAll("#report-ref-list tr.refout-row").length,
    cols: [...document.querySelectorAll("#report-ref-list-table tr th")].map((t) => t.textContent),
    ledgerN: ((document.querySelector("#report-ref-list") || {}).closest ? document.querySelector("#report-ref-list").closest("details").querySelector(".ledger-n").textContent : ""),
  }));
  eq("C5 · the flat ledger lists every referral in the period", cList.rows, cGroups.n);
  ok("C6 · …with date · client · property · kind · referred to · status · adviser",
    JSON.stringify(cList.cols) === JSON.stringify(["Date", "Client", "Property", "Kind", "Referred to", "Status", "Adviser"]), JSON.stringify(cList.cols));
  ok("C7 · …and the drawer carries its own row count like the other five ledgers", /referral/.test(cList.ledgerN), JSON.stringify(cList.ledgerN));

  // Period filter.
  await page.evaluate((mv) => { const p = document.querySelector("#report-month"); p.value = mv; p.dispatchEvent(new Event("change")); }, lastMonth);
  await page.waitForTimeout(2000);
  const cLast = await page.evaluate(async (mv) => {
    const { data } = await window.__mockDb.from("referrals").select("created_at");
    return {
      expected: (data || []).filter((r) => String(r.created_at).slice(0, 7) === mv).length,
      rendered: document.querySelectorAll("#report-ref-list tr.refout-row").length,
      basis: (document.querySelector("#report-ref-basis") || {}).textContent || "",
    };
  }, lastMonth);
  eq("C8 · the month picker scopes the report", cLast.rendered, cLast.expected);
  ok("C8b · …and the basis line names the month it is showing", /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/.test(cLast.basis), JSON.stringify(cLast.basis.slice(0, 120)));
  await page.evaluate((mv) => { const p = document.querySelector("#report-month"); p.value = mv; p.dispatchEvent(new Event("change")); }, thisMonth);
  await page.waitForTimeout(2000);

  // Mine / All.
  const cScopeOwner = await page.evaluate(() => ({
    mine: (document.querySelector("#report-ref-scope-mine") || {}).className,
    all: (document.querySelector("#report-ref-scope-all") || {}).className,
  }));
  ok("C9 · an Owner opens on All (the firm-wide question)", /active/.test(cScopeOwner.all) && !/active/.test(cScopeOwner.mine), JSON.stringify(cScopeOwner));
  await page.click("#report-ref-scope-mine");
  await page.waitForTimeout(1400);
  const cMine = await page.evaluate(async () => {
    const { data } = await window.__mockDb.from("referrals").select("*");
    const mv = (document.querySelector("#report-month") || {}).value;
    const uid = "p4";
    return {
      expected: (data || []).filter((r) => String(r.created_at).slice(0, 7) === mv && r.created_by === uid).length,
      rendered: document.querySelectorAll("#report-ref-list tr.refout-row").length,
    };
  });
  eq("C10 · Mine narrows to the signed-in adviser's own referrals", cMine.rendered, cMine.expected);
  ok("C10b · …and that is genuinely narrower than All", cMine.expected < cGroups.n, JSON.stringify({ mine: cMine.expected, all: cGroups.n }));

  // CSV.
  await armCsvCapture(page);
  await page.click("#report-ref-csv");
  await page.waitForTimeout(700);
  const csv = await readCsv(page);
  const csvName = await readCsvName(page);
  const csvLines = (csv || "").trim().split("\n");
  ok("C11 · the CSV downloads with a period-stamped filename", !!csvName && csvName.indexOf("referrals-out-" + thisMonth) >= 0, JSON.stringify(csvName));
  eq("C12 · …one header row plus one row per referral in scope", csvLines.length - 1, cMine.expected);
  ok("C13 · …with the ledger's own columns", /^"Date","Client","Property","Kind","Referred to","Status","Adviser"$/.test(csvLines[0] || ""), JSON.stringify(csvLines[0]));
  await page.click("#report-ref-scope-all");
  await page.waitForTimeout(1400);

  // An adviser: visible (no money on the panel) and defaulted to Mine.
  const page2 = await ctx.newPage();
  page2.on("dialog", (d) => d.accept());
  const errors2 = [];
  page2.on("pageerror", (e) => errors2.push("pageerror: " + String(e)));
  page2.on("console", (m) => { if (m.type() === "error" && !/ERR_TUNNEL_CONNECTION_FAILED|net::ERR_/.test(m.text())) errors2.push("console: " + m.text()); });
  await page2.goto(`${BASE}?as=p2`, { waitUntil: "networkidle" });
  await page2.waitForTimeout(SETTLE);
  await page2.evaluate(() => { location.hash = "#reports"; });
  await page2.waitForTimeout(SETTLE + 1200);
  const cAdv = await page2.evaluate(() => ({
    panel: !!document.querySelector("#report-referrals-panel"),
    hidden: (document.querySelector("#report-referrals-panel") || {}).classList ? document.querySelector("#report-referrals-panel").classList.contains("hidden") : null,
    chip: !!document.querySelector("#reports-nav-referrals"),
    mineActive: /active/.test((document.querySelector("#report-ref-scope-mine") || {}).className || ""),
    basis: (document.querySelector("#report-ref-basis") || {}).textContent || "",
    money: /£/.test((document.querySelector("#report-referrals-panel") || { textContent: "" }).textContent),
  }));
  ok("C14 · an adviser sees the section (referral counts are not money)", cAdv.panel && cAdv.hidden === false && cAdv.chip, JSON.stringify(cAdv));
  ok("C15 · …opened on Mine by default", cAdv.mineActive, JSON.stringify(cAdv));
  ok("C16 · …with no money anywhere on the panel", cAdv.money === false);
  ok("C17 · …and the basis line says whose referrals are on screen", /your own referrals/.test(cAdv.basis), JSON.stringify(cAdv.basis.slice(0, 160)));

  /* ========================= §D · console hygiene ========================= */
  console.log("\n— §D · no console or page errors");
  ok("D1 · owner (p4) session raised no page/console errors", errors.length === 0, JSON.stringify(errors.slice(0, 4)));
  ok("D2 · adviser (p2) session raised no page/console errors", errors2.length === 0, JSON.stringify(errors2.slice(0, 4)));

  console.log(`\nR66-COMMS: ${pass} checks passed, ${failures.length} failed`);
  if (failures.length) failures.forEach((f) => console.log("  ✗ " + f));
  await browser.close();
  if (srv) { try { process.kill(-srv.pid); } catch (e) { /* someone else's server */ } }
  process.exit(failures.length ? 1 : 0);
})();
