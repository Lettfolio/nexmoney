/* ==========================================================================
   NexMoney Back Office — admin/reports-money.js  (R81 · A1)

   THE SECOND CARVE OF app.js: the REPORTS + MONEY page family — every panel,
   model and helper from the "---------- Reports ----------" marker down
   to (and including) the R44 reconciliation wiring IIFE — moved VERBATIM.
   Loaded via a classic <script> tag AFTER /admin/core.js and BEFORE
   /admin/app.js (see index.html for why that order is proven, not assumed).
   Classic scripts share one global scope, so everything declared here is
   visible to app.js exactly as it was when these lived there.

   WHY THIS FILE LOADS BEFORE app.js (the R78 rule, applied in reverse):
     - This file's own top-level eval references NOTHING from app.js — only
       core.js's $ and JS globals (verified by AST scan of every eval-time
       identifier: the two wiring IIFEs use $ alone; every other top-level
       statement is a declaration whose initializer is pure data or an arrow).
     - app.js's top-level eval references NOTHING declared here (same scan,
       other direction) — BUT app.js's last line calls init(), whose awaits
       (getSession / resolveMyRole) resolve from MICROTASKS, and microtask
       checkpoints run BETWEEN classic scripts. Were this file loaded after
       app.js, a deep link to #reports or #money could reach nav()'s page map
       — which names loadReports / loadMoneyPage — before this script had
       evaluated: ReferenceError, blank page. app.js therefore stays LAST.

   THE MOVE RULE (HARNESS.md "R81 · A"): function bodies are byte-identical to
   R80's app.js, comments included. The ONLY in-move edits are the tagged
   "R81 · A2" wave collapse in/around loadMoneyPage and the tagged "R81 · A4"
   dbFail conversions — nothing else was touched. A duplicate top-level
   declaration across the three scripts is a SyntaxError that kills the whole
   later script, so anything moved here was DELETED from app.js in the same
   commit.
   ========================================================================== */

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
   R68 · M7 — ONE IMPLEMENTATION OF EACH PER-ADVISER FIGURE.

   Until now the owner-only Adviser scoreboard was the ONLY place that knew how
   to compute "fees earned this month by this person", "what share of their
   completions took a policy" and (firm-wide, one screen lower) "how many
   retention cases converted". The adviser those numbers describe could not see
   any of them, and the moment we put them on Reports › My numbers as well there
   were two copies of each rule — which is how two screens in the same app end
   up disagreeing about the same person in the same month, with no way to tell
   which one is wrong.

   So the arithmetic moves here, once, and BOTH surfaces call it. The scoreboard's
   numbers are deliberately unchanged (r19/r20/r42 lock them): every helper below
   is the scoreboard's own expression, lifted verbatim.

   `adviserOwns` carries the scoreboard's one subtlety — a falsy adviser id means
   the UNASSIGNED bucket (`!c.assigned_to`), not "nobody", because the scoreboard
   builds that row with mkAdvRow(null, "Unassigned") and it has to keep totalling.
   ========================================================================== */
const adviserOwns = (c, adviserId) => (adviserId ? c.assigned_to === adviserId : !c.assigned_to);
// The month's completions for one adviser, on the SAME UK-local month bucket every
// other figure on Reports uses (localMonthStr — see monthKpiSet).
function adviserMonthCompletions(cases, adviserId, mv) {
  return (cases || []).filter((c) => adviserOwns(c, adviserId) && c.completed_at && localMonthStr(c.completed_at) === mv);
}
/* Fees EARNED on those completions — procuration + broker + solicitor, paid or not.
   The same basis as the firm "Fees earned vs target" bar (earnedOnCompletion sums the
   same three fees), and deliberately NOT the cash "Fees banked" figure beside it. */
function adviserMonthEarned(cases, adviserId, mv) {
  const done = adviserMonthCompletions(cases, adviserId, mv);
  return { total: done.reduce((s, c) => s + (Number(c.proc_fee) || 0) + (Number(c.broker_fee) || 0) + (Number(c.sols_fee) || 0), 0), n: done.length };
}
/* R7-3's protection attach rate. `pct` is null — never 0 — when there were no
   completions at all, because nobody attached nothing to nothing; the caller renders
   that as "—". The count travels with the percentage: on a month's completions a
   single case moves it a long way, so the bracket is read before the number. */
function adviserAttachRate(cases, adviserId, mv) {
  const done = adviserMonthCompletions(cases, adviserId, mv);
  const taken = done.filter((c) => c.protection_status === "policy_taken").length;
  return { pct: done.length ? Math.round((taken / done.length) * 100) : null, taken, n: done.length };
}
/* Retention conversion, exactly as the firm KPI tile on this page has always defined it:
   of the cases that exist BECAUSE an earlier case's rate was ending (retention_source_case_id
   set), how many completed against how many were lost. Cases still in flight are in neither
   half — they have not converted or failed to yet. It is an ALL-TIME figure, not month-scoped:
   a retention case started in March and completed in July belongs to both months and neither,
   and the firm tile has always counted it whole. The scope line says so out loud. */
function retentionConversion(cases) {
  const rets = (cases || []).filter((c) => c.retention_source_case_id);
  const won = rets.filter((c) => c.stage === "completed").length;
  const lost = rets.filter((c) => c.stage === "not_proceeding").length;
  return { pct: won + lost ? Math.round((won / (won + lost)) * 100) : null, won, lost, n: won + lost, open: rets.length - won - lost };
}
function adviserRetentionConversion(cases, adviserId) {
  return retentionConversion((cases || []).filter((c) => adviserOwns(c, adviserId)));
}
/* R68 · M7 — the target BAR itself, lifted out of renderMonthReport unchanged so the adviser's
   own bar on My numbers is the same object as the firm's, not a lookalike. R6-B4's rule is the
   part worth keeping in one place: under target the track's right end IS target; over target the
   track stretches 12% past what was achieved so there is visible track and a marker where target
   sat — a fill clamped to 100% made 122% look identical to 100%. Colour matches the scoreboard's
   Target cell: green ≥100 / amber ≥60 / red below. */
function feeBarHtml(pct, target, ariaWhat) {
  const color = pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--red)";
  const over = pct > 100;
  const scale = over ? Math.ceil(pct * 1.12) : 100;
  const fillPct = Math.max(0, Math.min(100, (pct / scale) * 100));
  const markPct = (100 / scale) * 100;
  return `<div class="fee-bar" role="img" aria-label="${pct}% of the ${fmtM(target)} ${esc(ariaWhat || "monthly fee target")}">
            <div class="fee-bar-fill" style="width:${fillPct}%;background:${color};"></div>
            ${over ? `<div class="fee-bar-mark" style="left:${markPct}%;" title="Target — ${fmtM(target)}"></div>` : ""}
          </div>
          ${over ? `<span class="fee-bar-mark-lbl">The marker is the ${fmtM(target)} target; the bar runs to ${pct}% of it.</span>` : ""}`;
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
function renderMyNumbers(all, yr, mv) {
  const panel = $("#report-mine-panel");
  if (!panel) return;
  const on = showMyNumbers();
  panel.classList.toggle("hidden", !on);
  const tgtEl = $("#report-mine-target");
  if (!on) { $("#report-mine").innerHTML = ""; if (tgtEl) tgtEl.innerHTML = ""; const s0 = $("#report-mine-scope"); if (s0) s0.textContent = ""; return; }
  // R68 · M7 — the month the picker is on. Defensive default so a caller that has not been
  // taught to pass it still renders this month rather than NaN.
  const mvNow = mv || localMonthStr();
  const mLabel = monthLabel(mvNow);

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

  /* ==========================================================================
     R68 · M7 — THE TARGET REACHES THE PERSON IT IS SET FOR.
     A per-adviser monthly fee target has existed since R26 and lived entirely on the
     owner-only scoreboard: the one person who could act on it was the one person who
     could not see it. These three figures are the adviser's own row of that scoreboard,
     computed by the SAME helpers it uses (adviserMonthEarned / adviserAttachRate /
     adviserRetentionConversion), so "Luke is 40% under" reads identically on both screens.
     No target set is a real and normal state — this firm has set none — so it says so in
     words and never renders NaN or a 0% that would read as a failure.
     ========================================================================== */
  const myTarget = Number(adviserTargets()[ME.id] || 0);
  const myEarned = adviserMonthEarned(all, ME.id, mvNow);
  const myAttach = adviserAttachRate(all, ME.id, mvNow);
  const myRet = adviserRetentionConversion(all, ME.id);

  const scope = $("#report-mine-scope");
  if (scope) {
    scope.textContent = `Your own figures only — every number on this card counts cases assigned to you (${mine.length} case${mine.length === 1 ? "" : "s"}). `
      + `Nothing here is a firm total and no colleague's cases are in it. `
      /* R68 · M7 — three different windows on one card is exactly how two people end up
         arguing about which number is wrong, so the card states each one. */
      + `“My fees banked” is the calendar year ${yr}. “Fees earned this month vs my target” and “My attach rate” follow the month picker above and are showing ${mLabel}. `
      + `“My retention conversion” is all-time — a retention case can be started in one month and completed in another, so the firm figure it matches has never been cut by month. `
      + `${ATTRIB_NOTE}`;
  }
  $("#report-mine").innerHTML = `
    <div class="kpi"><div class="num" title="${esc(fmtM(banked.total))}">${fmtM(banked.total)}</div><div class="lbl">My fees banked ${yr}</div>${basisLine(BASIS_MY_CASH_YTD + (banked.futureN ? ` — ${fmtM(banked.futureTotal)} dated after today (${banked.futureN}) is excluded` : ""))}</div>
    <div class="kpi ${outstanding ? "warn" : ""}"><div class="num" title="${esc(fmtM(outstanding))}">${fmtM(outstanding)}</div><div class="lbl">My fees outstanding</div>${basisLine(BASIS_MY_OUTSTANDING + ` — ${outstandingN} fee${outstandingN === 1 ? "" : "s"} across ${outstandingCases.size} completed case${outstandingCases.size === 1 ? "" : "s"} with no paid date`)}</div>
    <div class="kpi"><div class="num" title="${esc(fmtM(pipeline))}">${fmtM(pipeline)}</div><div class="lbl">My pipeline at Offer+</div>${basisLine(BASIS_MY_PIPELINE + ` — ${offerPlus.length} case${offerPlus.length === 1 ? "" : "s"} at Offer or Exchange, not weighted for fall-through`)}</div>
    ${/* R7-3's rule verbatim: no completions in the month means there was nothing to attach a
         policy to, so it is "—" and never 0%. The bracket count is read before the percentage. */ ""}
    <div class="kpi" id="report-mine-attach"><div class="num">${myAttach.pct == null ? "—" : `${myAttach.pct}%`}</div><div class="lbl">My attach rate (${esc(mLabel)})</div>${basisLine(myAttach.pct == null
      ? `(policy taken ÷ my completions · ${esc(mLabel)}) — no completions in this month, so there is nothing to attach a policy to`
      : `(policy taken ÷ my completions · ${esc(mLabel)}) — ${myAttach.taken} of ${myAttach.n} completion${myAttach.n === 1 ? "" : "s"}${myAttach.n < 3 ? ", too small a sample to read as a ranking" : ""}`)}</div>
    <div class="kpi" id="report-mine-retention"><div class="num">${myRet.pct == null ? "—" : `${myRet.pct}%`}</div><div class="lbl">My retention conversion</div>${basisLine(myRet.pct == null
      ? "(completed ÷ decided · my retention cases · all time) — none of your retention cases has been won or lost yet"
      : `(completed ÷ decided · my retention cases · all time) — ${myRet.won} completed, ${myRet.lost} lost${myRet.open ? `, ${myRet.open} still in flight and in neither half` : ""}`)}</div>`;

  if (tgtEl) {
    if (!(myTarget > 0)) {
      /* No target is the state this firm is actually in (adviser_fee_targets has never been
         written), so it is the state this line is written for: say what is missing and who can
         fix it. A 0% bar here would be a claim about performance, and it would be false. */
      tgtEl.innerHTML = `<div class="panel-sub target-headline" id="report-mine-target-none" style="margin:12px 0 4px;">Fees earned this month vs my target — <strong>no monthly target set for you yet</strong> — ask the owner to set one in Settings › Adviser targets. `
        + `You earned ${fmtM(myEarned.total)} in ${esc(mLabel)} <span class="money-basis">${esc(BASIS_TARGET_EARNED)} — ${myEarned.n} completion${myEarned.n === 1 ? "" : "s"} this month, paid or not</span></div>`;
    } else {
      const pct = Math.round((myEarned.total / myTarget) * 100);
      tgtEl.innerHTML = `<div class="panel-sub target-headline" id="report-mine-target-line" style="margin:12px 0 4px;">Fees earned this month vs my target — ${fmtM(myEarned.total)} of ${fmtM(myTarget)} target · ${pct}% <span class="money-basis">${esc(BASIS_TARGET_EARNED)} — ${myEarned.n} completion${myEarned.n === 1 ? "" : "s"} this month, paid or not</span></div>`
        + feeBarHtml(pct, myTarget, "monthly fee target");
    }
  }
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
  /* R74 · A4a — the fold follows the paragraph it holds: an empty disclosure handle on an
     adviser's page would be a control that opens onto nothing. */
  const basisFold = $("#report-basis-fold");
  if (basisFold) basisFold.hidden = !!(basisLegend && basisLegend.classList.contains("hidden"));
  /* R5-F2 — "Completed £" is the headline: fee value EARNED on the cases that completed this
     month. It is not moved (the tile order is load-bearing for the delta chips beside it) and its
     label is unchanged; the emphasis is carried by kpi-headline, and by the target bar below, which
     now measures the same basis. */
  $("#month-kpis").innerHTML = `
    <div class="kpi"><div class="num">${cur.nSub}</div><div class="lbl">Applications submitted</div>${cmpCount("nSub")}</div>
    ${money ? `<div class="kpi kpi-secondary"><div class="num">${fmtM(cur.subTotal)}</div><div class="lbl">Submitted £ (proc+broker+sols)</div>${basisLine(BASIS_EARNED_ALL)}${cmpMoney("subTotal")}</div>` : ""}
    <div class="kpi"><div class="num">${cur.nDone}</div><div class="lbl">Completions</div>${cmpCount("nDone")}</div>
    ${money ? `<div class="kpi kpi-headline"><div class="num">${fmtM(cur.doneTotal)}</div><div class="lbl">Completed £ (proc+broker+sols)</div>${basisLine(BASIS_EARNED_ALL)}${cmpMoney("doneTotal")}</div>` : ""}`;

  /* ==========================================================================
     R74 · A4a (panel D#12) — THE HERO ROW, AT THE TOP OF THE PAGE.

     Every figure here is one the code above has already computed for the panel
     below (cur.doneTotal, and the earned/target pair the bar uses), read from
     the same helpers rather than re-derived, so the hero and the Monthly
     business panel can never disagree. What the hero adds is placement: the
     number the owner is judged on, first, at a size that says so.

     Owner-only, on the same showMoney() gate as everything else it quotes. No
     target set is a real state (and the honest one for two of the four
     advisers here) — the hero then leads with the earned figure alone rather
     than inventing a percentage.
     ========================================================================== */
  const heroEl = $("#report-hero"), heroStrip = $("#report-hero-strip");
  if (heroEl) {
    const heroTarget = money ? Number(settings.monthly_fee_target || 0) : 0;
    const heroEarned = money ? earnedOnCompletion(all, mv) : null;
    heroEl.classList.toggle("hidden", !money);
    if (heroStrip) heroStrip.classList.toggle("hidden", !money);
    if (!money) { heroEl.innerHTML = ""; if (heroStrip) heroStrip.innerHTML = ""; }
    else {
      const heroPct = heroTarget > 0 ? Math.round((heroEarned.total / heroTarget) * 100) : null;
      const pctColour = heroPct == null ? "" : heroPct >= 100 ? "var(--green)" : heroPct >= 60 ? "var(--amber)" : "var(--red)";
      heroEl.innerHTML = `<span class="rep-hero-num" title="${esc(fmtM(heroEarned.total))}">${fmtM(heroEarned.total)} earned</span>`
        + (heroPct == null
          ? `<span class="rep-hero-lbl">No firm monthly target is set, so there is no percentage to read this against — set one in Settings › Targets.</span>`
          : `<span class="rep-hero-pct" style="color:${pctColour};">${heroPct}% of target</span>
             <span class="rep-hero-lbl">${esc(monthLabel(mv))} · target ${fmtM(heroTarget)}</span>`)
        + `<span class="rep-hero-basis">Fee value (procuration + broker + solicitor) on the ${heroEarned.n} case${heroEarned.n === 1 ? "" : "s"} that COMPLETED in ${esc(monthLabel(mv))}, paid or not. <span class="money-basis">${esc(BASIS_TARGET_EARNED)}</span> The bar, the month-on-month comparison and the cash figure beside it are in <strong>Monthly business</strong> below.</span>`;
      /* The other three month figures, demoted rather than deleted OR duplicated: one quiet line
         under the hero, deliberately NOT a second row of tiles — the tiles with their
         month-on-month deltas are the Monthly business panel's own job, and printing them twice
         within one screen is the disease this round is treating. */
      if (heroStrip) {
        heroStrip.innerHTML = `<span class="rep-hero-sec-i"><strong>${cur.nDone}</strong> completion${cur.nDone === 1 ? "" : "s"}</span>`
          + `<span class="rep-hero-sec-i"><strong>${cur.nSub}</strong> application${cur.nSub === 1 ? "" : "s"} submitted</span>`
          /* No basis caption here on purpose: the tile in Monthly business below carries it (and
             r5_batch6 pins "(earned · all fee types)" to exactly the two tiles that are the
             earned figures). This line is a pointer to those tiles, not a third copy of them. */
          + `<span class="rep-hero-sec-i"><strong>${fmtM(cur.subTotal)}</strong> submitted £</span>`;
      }
    }
  }

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
      targetEl.innerHTML = `
        <div class="panel-sub target-headline" style="margin:12px 0 4px;">Fees earned vs target — ${fmtM(earned.total)} of ${fmtM(target)} (${pct}%) <span class="money-basis">${esc(BASIS_TARGET_EARNED)} — ${earned.n} completion${earned.n === 1 ? "" : "s"} this month, paid or not</span></div>
        ${/* R6-B4 (D6-23) — the fill used to be min(pct,100)% of a track, so anything
             at or over target was a solid full-width slab: the track was invisible and
             122% looked identical to 100%. The bar now scales to max(pct,100), so an
             overshoot leaves visible track and a marker shows where target sat. Inline
             styles moved to .fee-bar-* classes, except the one that is genuinely data
             (the fill's width and its earned/target colour). */ ""}
        ${/* R68 · M7 — the bar's own markup moved to feeBarHtml(), unchanged, so the adviser's
             "vs my target" bar on My numbers is literally the same bar and cannot drift. */ ""}
        ${feeBarHtml(pct, target, "monthly fee target")}
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
    ${rows.map((r) => `<tr${r.nSub || r.nDone ? "" : ' class="stat-weak" title="No activity in this month — listed so the previous-month comparison column still totals that month\'s own report."'}><td><strong>${esc(r.name)}</strong></td><td class="num">${r.nSub}</td>${money ? `<td class="num">${fmtM(r.sProc)}</td><td class="num">${fmtM(r.sBrk)}</td><td class="num">${fmtM(r.sSol)}</td>` : ""}<td class="num">${r.nDone}</td>${money ? `<td class="num">${fmtM(r.dTot)}</td>` : ""}<td class="stat-weak num">${r.pDone}</td>${money ? `<td class="stat-weak num">${fmtM(r.pTot)}</td>` : ""}</tr>`).join("")}
  </table></div>
  <p class="panel-sub month-attrib" id="month-advisers-attrib" style="margin:8px 0 0;">${esc(ATTRIB_NOTE)} The previous-month columns list every adviser who completed anything in ${esc(monthLabel(prevMv))}, including advisers with no activity in ${esc(monthLabel(mv))}, so they total that month's own report.</p>` : '<div class="empty">No submissions or completions recorded for this month.</div>';
}

/* ==========================================================================
   R72 · A1 — THE ADOPTION STRIP (R70 panel, H5a · Sam F4 / Priya F2)

   THE PROBLEM, in one production fact: of the four back-office logins, only
   Daniel has ever signed in. Kim, Wayne and Luke were created on 4 July and
   have never opened the app. Nothing anywhere in this back office says so.
   The owner's scoreboard above is a book report — cases, fees, attach rate —
   and it happily prints a row for a person who has not been here, because a
   completed case keeps its adviser whether or not that adviser ever logged in.

   WHAT THIS STRIP CAN AND CANNOT KNOW, said out loud because the difference
   matters and the copy under the table says it to the reader too:
     · `auth.users.last_sign_in_at` is NOT client-readable. There is no query
       from this app that can answer "who has signed in". Anything claiming to
       is guessing.
     · What the app CAN read is `audit_log` — R68's change-history panel and
       its CSV export read the whole table already, so this costs no new
       permission and no new column. Every insert/update/delete on a client, a
       case, a task, a note, an appointment, a setting or a login writes one
       row with the actor on it. So "last active" here means THE LAST CHANGE
       THIS PERSON RECORDED, not the last time they signed in. Somebody who
       signs in and reads for an hour leaves no row — which is the honest
       limit, and is stated on screen rather than hidden behind a word.

   SYSTEM ROWS ARE NOT HUMAN ACTIVITY. On production the nightly automation has
   written 9,214 of the last 30 days' 9,438 audit rows across 1,817 cases; if
   they counted, every adviser would look busy and the strip would say the
   opposite of the truth. The automation's rows carry `actor IS NULL` — the
   same convention the change-history "Who" filter already keys on (CH_SYSTEM),
   whose label is "System (automation)". Filtering `actor` to the four staff
   ids with `.in()` therefore excludes them at the database, not client-side:
   a null actor can never match an `in` list. Four ids is one long way under
   the inChunks threshold, so this read is deliberately NOT chunked — but any
   future widening of it (every profile ever, say) would have to be.

   COST: two bounded reads, in parallel, both through readAll().
     1. audit_log — actor/case_id/happened_at only (no `changes` blobs), the
        actor filtered to the staff ids, windowed to ADOPTION_WINDOW_DAYS.
     2. case_tasks — open (done_at null) and already overdue (due_date before
        today, Europe/London), grouped by assigned_to in JS.
   The scoreboard's own "Overdue" column comes from get_reports and is keyed on
   whatever that RPC counts; this one is stated in its own words on the row so
   the two can be read together rather than argued about.
   ========================================================================== */
const ADOPTION_WINDOW_DAYS = 90;   // "last active" is read over this window; older than that reads "never"
const ADOPTION_TOUCH_DAYS = 30;    // "cases touched" is the tighter, 30-day question the panel asked for
/* Anyone with a back-office login — TEAM, not advisingStaff(). The question this answers is "has
   this person used the app", and the administrator (who on this firm has 1 overdue task and has
   never signed in) is exactly the person it must not leave out. */
function adoptionRoster() { return TEAM.slice(); }
/* ==========================================================================
   R82 · B3 — THE BLIND SPOT IS CLOSED: get_staff_activity()

   Until this round the panel below had to say, honestly, that this app cannot
   see sign-ins — they live in the authentication service, and `auth.users` is
   not readable from the browser client. The CTO has shipped a SECURITY DEFINER
   RPC that answers exactly that question and nothing else:

     get_staff_activity() → [ { id, has_signed_in, last_sign_in_at, invited_at } ]

   one entry per `profiles` row, guarded to signed-in staff (anybody else gets
   an empty array). It matters because of what the live database says today:
   Kim, Wayne and Luke were invited on 4 July 2026 and have NEVER signed in;
   Daniel is the only human who has ever used this system. This panel is the
   owner's only view of that fact, and until now it could not tell "signed in
   and read quietly" apart from "never came" — both read `never` under Last
   active, which is a claim about a person made on missing evidence.

   CONSUMED DEFENSIVELY, exactly as app.js consumes it (the PROT_QUOTE_SUPPORTED
   / absencesSupported pattern): a 42883, an RLS refusal, a transport failure or
   a shape this code does not recognise all mean ONE thing — "we do not know" —
   and the panel then renders today's behaviour and today's wording, down to the
   old disclaimer paragraph. A FAILED READ NEVER MAKES A COLLEAGUE LOOK
   INACTIVE: `never signed in` is printed only where the RPC positively said
   has_signed_in:false. Unknown prints the panel's own em dash, never a zero and
   never a "never".

   Its own read, not app.js's. app.js keeps STAFF_ACTIVITY for lead routing;
   this file loads FIRST (see the header) and must not depend on a global
   declared after it, so the panel asks the same question for itself. One extra
   RPC, folded into the two reads this panel already fires in parallel — no
   extra wave.
   ========================================================================== */
let ADOPTION_ACTIVITY = {};                 // profile id → { known, has_signed_in, last_sign_in_at, invited_at }
let ADOPTION_ACTIVITY_SUPPORTED = null;     // null = not asked · false = no data, behave as before R82
async function readStaffActivity() {
  try {
    const { data, error } = await db.rpc("get_staff_activity");
    if (error || !Array.isArray(data)) { ADOPTION_ACTIVITY = {}; ADOPTION_ACTIVITY_SUPPORTED = false; return false; }
    const map = {};
    data.forEach((r) => {
      if (!r || !r.id) return;
      map[r.id] = {
        /* `known` is the whole discipline: only a real boolean from the server counts. A row
           the RPC did not carry, or carried without the flag, is unknown — not dormant. */
        known: typeof r.has_signed_in === "boolean",
        has_signed_in: r.has_signed_in === true,
        last_sign_in_at: r.last_sign_in_at || null,
        invited_at: r.invited_at || null,
      };
    });
    ADOPTION_ACTIVITY = map; ADOPTION_ACTIVITY_SUPPORTED = true; return true;
  } catch (_) { ADOPTION_ACTIVITY = {}; ADOPTION_ACTIVITY_SUPPORTED = false; return false; }
}
/* The one test, mirroring app.js's neverSignedIn: false whenever we do not KNOW. */
function adoptionNeverSignedIn(id) {
  if (ADOPTION_ACTIVITY_SUPPORTED !== true || !id) return false;
  const a = ADOPTION_ACTIVITY[id];
  return !!a && a.known === true && a.has_signed_in === false;
}
async function readAdoptionData() {
  const ids = adoptionRoster().map((p) => p.id).filter(Boolean);
  if (!ids.length) return { audit: [], tasks: [], auditErr: null, tasksErr: null };
  const sinceIso = new Date(Date.now() - ADOPTION_WINDOW_DAYS * 86400000).toISOString();
  const today = localDateStr();   // Europe/London, like every other date comparison in this file
  const [aud, tsk] = await Promise.all([   // R82 · B3 — readStaffActivity() rides this wave (below)
    /* `.in("actor", ids)` — four ids, no chunking needed (see the block comment). ORDER is
       required by readAll's pager, and `happened_at` alone is not unique, so `id` breaks ties. */
    readAll(db.from("audit_log").select("actor,case_id,happened_at")
      .in("actor", ids).gte("happened_at", sinceIso)
      .order("happened_at", { ascending: false }).order("id", { ascending: false }), { cap: OWNER_ROW_CAP }),
    readAll(db.from("case_tasks").select("assigned_to,due_date,done_at")
      .is("done_at", null).lt("due_date", today).order("id"), { cap: OWNER_ROW_CAP }),
    /* R82 · B3 — the sign-in read, in the SAME wave as the two above. It resolves to a boolean
       and never rejects (readStaffActivity swallows its own failure into "we do not know"), so
       it can never take the panel down with it. */
    readStaffActivity(),
  ]);
  return { audit: (aud && aud.data) || [], tasks: (tsk && tsk.data) || [],
    auditErr: aud && aud.error, tasksErr: tsk && tsk.error };
}
/* The three figures per person, from the two row sets above. Pure, so the suite can recompute it. */
function adoptionRowsFrom(roster, audit, tasks) {
  const touchSince = new Date(Date.now() - ADOPTION_TOUCH_DAYS * 86400000).toISOString();
  const byId = {};
  roster.forEach((p) => { byId[p.id] = { id: p.id, name: p.full_name || p.email, role: p.role, last: null, cases: new Set(), overdue: 0 }; });
  (audit || []).forEach((r) => {
    /* Belt and braces on top of the `.in()` above: a row with no actor is the automation's, and
       must never land on a person's line whatever the query returned. */
    if (!r || !r.actor) return;
    const row = byId[r.actor];
    if (!row) return;
    if (r.happened_at && (!row.last || String(r.happened_at) > String(row.last))) row.last = String(r.happened_at);
    if (r.case_id && String(r.happened_at || "") >= touchSince) row.cases.add(r.case_id);
  });
  (tasks || []).forEach((t) => { if (t && t.assigned_to && byId[t.assigned_to]) byId[t.assigned_to].overdue++; });
  return roster.map((p) => {
    const r = byId[p.id];
    return { id: r.id, name: r.name, role: r.role, last: r.last, casesTouched: r.cases.size, overdue: r.overdue };
  });
}
/* R82 · B3 — the Signed in cell. THREE states and no fourth, because a fourth would be a guess:
     · unknown  — the RPC is absent, refused or answered a shape we do not recognise. The panel's
                  own em dash (never a 0, never the word "never"), and the title says the read
                  failed rather than saying anything about the person.
     · never    — the RPC positively reported has_signed_in:false. Says how long ago they were
                  invited when it knows, because "invited two months ago and never came" is a
                  different fact from "invited yesterday".
     · signed in— the date, plus today/yesterday/N days ago in the Last active cell's own idiom.
   A SIGN-IN IS NOT USAGE and the cell never implies it is: it says when somebody came, not what
   they did. What they did is the column next to it. */
function adoptionSignInCell(id) {
  const a = ADOPTION_ACTIVITY_SUPPORTED === true ? ADOPTION_ACTIVITY[id] : null;
  if (!a || a.known !== true) {
    return '<td class="adopt-signin adopt-signin-unknown" data-signin="unknown"' +
      ' title="The sign-in record could not be read just now, so this says nothing either way. It is a failed question, not a finding about this person."><span class="cs-muted">—</span></td>';
  }
  if (a.has_signed_in !== true) {
    const invitedDays = a.invited_at ? daysSinceLocal(a.invited_at) : null;
    const invited = invitedDays == null ? "" :
      invitedDays === 0 ? "invited today" : invitedDays === 1 ? "invited yesterday" : `invited ${invitedDays} days ago`;
    return `<td class="adopt-signin adopt-signin-never" data-signin="never" data-invited="${esc(String(a.invited_at || ""))}"` +
      ` title="The authentication service has no sign-in on record for this login${a.invited_at ? ` — invited ${esc(new Date(a.invited_at).toLocaleString("en-GB"))}` : ""}. They have never opened the app.">` +
      `never${invited ? ` <span class="cs-muted">(${esc(invited)})</span>` : ""}</td>`;
  }
  const last = a.last_sign_in_at;
  if (!last) {
    return '<td class="adopt-signin" data-signin="yes" title="This login has signed in, but the authentication service did not report when.">yes <span class="cs-muted">(date not reported)</span></td>';
  }
  const days = daysSinceLocal(last);
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `<td class="adopt-signin" data-signin="yes" data-last-signin="${esc(String(last))}"` +
    ` title="The last time this login signed in — ${esc(new Date(last).toLocaleString("en-GB"))}. Signing in is not the same as doing something; the column beside this one is what they did.">` +
    `${esc(fmtD(String(last).slice(0, 10)))} <span class="cs-muted">(${esc(when)})</span></td>`;
}

/* R82 · B3 — THE EXPLANATORY PARAGRAPH, in two versions, and the difference between them is
   whether a limitation still exists.

   BEFORE this round it said, correctly: “This app cannot see sign-ins: that lives in the
   authentication service and is not readable from here.” That is no longer true, and a panel
   whose whole character is scrupulousness about what a number means may not go on disclaiming a
   blind spot it does not have. The supported version therefore states the two columns as the two
   different questions they are — and is just as precise about the NEW limitation, which is real:
   a sign-in is not usage. Somebody can sign in, read one page and do nothing, and this panel will
   show it as exactly that (a sign-in date beside “never” active), not as work.

   The UNSUPPORTED version is the old paragraph, unchanged in substance, because when the sign-in
   read fails the old limitation is precisely the situation we are in again — plus one sentence
   saying so, so the em dashes in the column are not read as findings. */
function adoptionSubHtml(tasksErr) {
  const tail = `Read over the last ${ADOPTION_WINDOW_DAYS} days; “never” under Last active means nothing recorded in that window. <strong>The nightly automation is excluded</strong> — its rows are logged with no person against them (they show as “System (automation)” in the change history), so they can never make a colleague look busy. Everyone with a back-office login is listed, not only advisers.${tasksErr ? " Overdue tasks could not be read just now and are shown as 0." : ""}`;
  if (ADOPTION_ACTIVITY_SUPPORTED === true) {
    return `<p class="panel-sub" id="report-adoption-sub"><strong>These are two different questions.</strong> <strong>“Signed in”</strong> comes from the authentication service — whether this login has ever been used at all, and when it last was. <strong>“Last active” means the last change this person recorded</strong> — a case edited, a task ticked, a note or an appointment written — as logged in the <strong>change history</strong> at the bottom of Settings; <strong>it is not a sign-in</strong>, and a sign-in is not work. Somebody who signs in and only reads leaves no trace on the change history, so a recent sign-in beside “never” active means they came and did nothing — which is a different finding from never having come at all, and now you can tell them apart. ${tail}</p>`;
  }
  return `<p class="panel-sub" id="report-adoption-sub"><strong>“Last active” means the last change this person recorded</strong> — a case edited, a task ticked, a note or an appointment written — as logged in the <strong>change history</strong> at the bottom of Settings. <strong>It is not a sign-in.</strong> The sign-in record could not be read just now, so the “Signed in” column says nothing about anybody and shows “—” for everyone — that is a failed question, not a finding. Somebody who signs in and only reads leaves no trace on this table. ${tail}</p>`;
}

async function renderAdoptionStrip() {
  const el = $("#report-adoption");
  if (!el) return;
  /* Rides the scoreboard's gate rather than owning a second one: #report-scoreboard-panel is
     hidden for anyone but the Owner (showMoney()), and a strip rendered inside a hidden panel is
     a read spent on nothing. */
  if (!showMoney()) { el.innerHTML = ""; return; }
  const roster = adoptionRoster();
  if (!roster.length) { el.innerHTML = ""; return; }
  el.innerHTML = `<h4 class="adopt-h" id="report-adoption-h">Is anyone using it?</h4><p class="panel-sub">Checking the change history…</p>`;
  const { audit, tasks, auditErr, tasksErr } = await readAdoptionData();
  if (auditErr) {
    /* A log this session cannot read costs the strip and says so — it never degrades into a table
       of "never"s, which would read as a finding rather than as a failed question. */
    el.innerHTML = `<h4 class="adopt-h" id="report-adoption-h">Is anyone using it?</h4>
      <p class="panel-sub" id="report-adoption-sub">The change history could not be read just now (${esc((auditErr && auditErr.message) || "no answer")}), so there is nothing honest to say about who has been active. Nothing is wrong with the book — this is a failed question.</p>`;
    return;
  }
  const rows = adoptionRowsFrom(roster, audit, tasks);
  const activeN = rows.filter((r) => r.last).length;
  const cell = (r) => {
    if (!r.last) {
      /* R82 · B3 — this title used to end "that is not proof they have never signed in — the
         app cannot see sign-ins". It can now, so the sentence says what the sign-in column
         beside it actually reports rather than disclaiming a limitation that has gone. When the
         sign-in read failed, the ORIGINAL wording stands — it was true then and it is true now. */
      const signInWord = ADOPTION_ACTIVITY_SUPPORTED !== true
        ? `That is not proof they have never signed in — the sign-in record could not be read just now — but they have changed nothing.`
        : adoptionNeverSignedIn(r.id)
          ? `They have never signed in either, so there is nothing to explain: this login has not been used.`
          : `They have signed in — see the column beside this one — so they have been in and changed nothing.`;
      return `<td class="adopt-last adopt-never" data-last="" title="Nothing this person did was recorded in the change history in the last ${ADOPTION_WINDOW_DAYS} days. ${signInWord}">never</td>`;
    }
    const days = daysSinceLocal(r.last);
    const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
    return `<td class="adopt-last" data-last="${esc(String(r.last))}" title="The most recent change this person recorded — ${esc(new Date(r.last).toLocaleString("en-GB"))}.">${esc(fmtD(String(r.last).slice(0, 10)))} <span class="cs-muted">(${esc(when)})</span></td>`;
  };
  /* R82 · B3 — the second pill exists ONLY when the RPC answered. It is the headline the
     production book would show today (three of four logins never signed in), and it is left off
     entirely rather than shown as "0 never signed in" when we do not know — a zero would be a
     claim. The first pill keeps its place and its wording, so nothing reading `.adopt-h .count`
     moves. */
  const dormant = ADOPTION_ACTIVITY_SUPPORTED === true ? rows.filter((r) => adoptionNeverSignedIn(r.id)).length : null;
  const dormantPill = dormant ? ` <span class="count hot" id="report-adoption-dormant" data-n="${dormant}" title="These logins exist and have never been signed in to. Everything else on this row is therefore about a desk nobody has opened.">${dormant} never signed in</span>` : "";
  el.innerHTML = `<h4 class="adopt-h" id="report-adoption-h">Is anyone using it? <span class="count${activeN === rows.length ? "" : " hot"}">${activeN} of ${rows.length} active</span>${dormantPill}</h4>
    <div style="overflow-x:auto;"><table class="imp-table" id="report-adoption-table">
      <tr><th>Person</th><th>Role</th><th title="${ADOPTION_ACTIVITY_SUPPORTED === true ? `Whether this login has ever signed in at all, and when it last did — read from the authentication service, not from anything recorded in this app.` : `The sign-in record could not be read just now, so this column says nothing about anybody.`}">Signed in</th><th title="The most recent change this person recorded in the change history, over the last ${ADOPTION_WINDOW_DAYS} days.">Last active</th><th title="How many different cases this person changed something on in the last ${ADOPTION_TOUCH_DAYS} days.">Cases touched (${ADOPTION_TOUCH_DAYS}d)</th><th title="Open tasks assigned to this person whose due date is already past.">Overdue tasks</th></tr>
      ${rows.map((r) => `<tr class="adopt-row${r.last ? "" : " row-warn"}" data-staff="${esc(r.id)}">
        <td><strong>${esc(r.name)}</strong></td>
        <td>${esc(ROLE_LABEL[r.role] || r.role || "")}</td>
        ${adoptionSignInCell(r.id)}
        ${cell(r)}
        <td class="num adopt-touched" data-n="${r.casesTouched}">${r.casesTouched || '<span class="cs-muted">—</span>'}</td>
        ${/* R73 · B2 — AMBER, and an em dash. The identical metric ("open tasks whose
             due date has passed") was RED here and on the scoreboard below, and AMBER
             on Monday money, so the same three numbers changed severity depending on
             which page Daniel opened. Amber wins: overdue tasks are a nudge, not a
             breach, and red is reserved on this app for things that have failed. A
             bare 0 in a column of counts reads as a measured zero the eye still has to
             stop on; — says "nothing here" and gets out of the way. */ ""}
        <td class="num adopt-overdue" data-n="${r.overdue}">${r.overdue ? `<span class="badge amber">${r.overdue}</span>` : '<span class="cs-muted">—</span>'}</td>
      </tr>`).join("")}
    </table></div>
    ${adoptionSubHtml(tasksErr)}`;
}

/* BUILD 5c — the Reports month picker (defaults to the current month) now threads into every
   panel where a month scope is meaningful: adviser scoreboard, pipeline funnel, lead sources.
   Open-case counts and overdue-task counts describe "right now" rather than a historical window,
   so those stay live even inside the threaded scoreboard panel. Computed entirely client-side from
   `all` (the same cases already fetched for the rest of Reports) — no RPC change needed. */
function renderThreadedPanels(all, mv, repAdvisers) {
  const inMonth = (d) => d && localMonthStr(d) === mv;
  const label = monthLabel(mv);
  /* R74 · A2 — the short month the Attach column header carries, from the same fixed table fmtD
     uses (R73: never Intl, so "Sep" is never "Sept"). */
  const attachShort = MONTH_SHORT[Number(String(mv).slice(5, 7)) - 1] || label;
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
    const mine = all.filter((c) => adviserOwns(c, id));
    const open = mine.filter((c) => activeStages.includes(c.stage)).length;
    // R68 · M7 — the month's completions now come from the shared helper (same expression,
    // one copy), so Reports › My numbers cannot drift from this row.
    const done = adviserMonthCompletions(all, id, mv);
    // B7 / Batch 6.4 — broker cash counted on the BROKER fee's own paid date (M2), falling back to
    // the legacy single date, and never counting a payment dated in the future.
    const feesBanked = cashInMonth(mine, mv, ["broker"]).total;
    const days = done.map((c) => Math.round((new Date(c.completed_at) - new Date(c.created_at)) / 86400000)).filter((n) => n > 0);
    const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
    const trend = months6.map((m) => mine.filter((c) => c.completed_at && localMonthStr(c.completed_at) === m).length);
    const trendTitle = months6.map((m, i) => `${MONTH_SHORT[Number(m.slice(5, 7)) - 1]}: ${trend[i]}`).join(" · ");
    const overdue = id ? (overdueById[id] != null ? overdueById[id] : overdueByName[name]) : undefined;
    /* R7-3 — PROTECTION ATTACH RATE. Of the cases this adviser completed in the selected month,
       how many ended with a policy. Scoped to the same month as every other column on this row
       (mixing an all-time attach rate into a month-scoped table is how two people end up arguing
       about which figure is wrong), and the sample size travels with the percentage because a
       month is a small denominator: 1 of 2 is 50% and means almost nothing. Zero completions
       renders as "—", never as 0%, because nobody attached nothing to nothing. */
    // R68 · M7 — same rule, one copy (adviserAttachRate). The adviser sees this exact figure
    // for themselves on Reports › My numbers.
    const att = adviserAttachRate(all, id, mv);
    const protTaken = att.taken;
    const attach = att.pct;
    /* R26 — broker fee EARNED on this adviser's completions in the selected month, paid or not.
       The adviser-attributed analogue of the firm "Fees earned vs target" bar (broker only, because
       proc/sols fees don't attribute cleanly to one adviser). This is the attainment basis for the
       new per-adviser Target column — deliberately NOT the cash "Fees banked" figure beside it. */
    // R28 (Daniel-approved) — target basis now folds procuration + solicitor fees in with the broker
    // fee, so it matches the firm "Fees earned vs target" bar EXACTLY (earnedOnCompletion = proc+broker+
    // sols on the month's completions). Each fee sits on the case, summed over the adviser's completions.
    // R68 · M7 — same rule, one copy (adviserMonthEarned).
    const feeEarnedTotal = adviserMonthEarned(all, id, mv).total;
    return { id, name, offTeam: !!offTeam, open, completions: done.length, feesBanked, overdue, avg, n: days.length, trend, trendTitle, protTaken, attach, feeEarnedTotal };
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
  /* R26 — per-adviser monthly fee targets (owner-only, same JSON settings key everywhere). The cell
     measures feeEarnedTotal (procuration + broker + solicitor fees EARNED on this month's completions,
     paid or not) against this adviser's target — the SAME basis as the firm "Fees earned vs target" bar
     above (earnedOnCompletion sums the same three fees), NOT the
     cash "Fees banked" column beside it. Colour rule mirrors the firm bar: green>=100 / amber>=60 /
     red<60. No target (or the Unassigned/off-team rows, id falsy) → "—", never 0%. */
  const advTargets = adviserTargets();
  const advTargetCell = (a) => {
    const t = a.id ? Number(advTargets[a.id] || 0) : 0;
    // R74 · A2 — the dash means "no target set for this person", and now says so on hover.
    if (!(t > 0)) return `<td class="adv-target-cell" data-pct="">${naDash(a.id ? `No monthly target is set for ${a.name} in Settings, so there is nothing to measure their earnings against. This is not 0% — it is not applicable.` : "This row is not a person with a target — it is the unassigned / off-team bucket.")}</td>`;
    const earned = Number(a.feeEarnedTotal) || 0;
    const pct = Math.round((earned / t) * 100);
    const color = pct >= 100 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--red)";
    const fill = Math.max(0, Math.min(100, pct));
    const title = `Fees earned (procuration + broker + solicitor) on ${a.name}'s completions in ${label} vs their monthly target — earned on completion, paid or not, so it matches the firm 'Fees earned vs target' bar above, not the cash 'Fees banked' column beside it.`;
    return `<td class="adv-target-cell" data-pct="${pct}" title="${esc(title)}">${fmtM(earned)} / ${fmtM(t)} <span style="color:${color};font-weight:600;">${pct}%</span><div class="adv-target-bar" style="margin-top:3px;height:5px;border-radius:3px;background:var(--light);overflow:hidden;"><div style="width:${fill}%;height:100%;background:${color};"></div></div></td>`;
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
  /* R74 · A4b (panel D#14) — ONE SENTENCE, THEN A DISCLOSURE. This paragraph had grown to ten
     lines of essay sitting between the reader and the table it describes, and the reader who needs
     it needs it once. The lead sentence says what the table is scoped to; everything else — every
     column's basis, the two reconciliations, the attribution note — moves behind "▸ How these are
     counted", which is the same fold pattern Settings uses and is closed by default.
     NOTHING IS DELETED and no wording is softened: the column bases below are the SAME strings the
     column headers used to print under themselves (R5-17's labels, still on the page and still
     findable), moved here so each header can be one line and the table can fit its panel. */
  const sbScope = $("#report-scoreboard-scope");
  if (sbScope) sbScope.innerHTML = `Completions, fees banked, attach rate and average days are for <strong>${esc(label)}</strong>; open cases are as of now.
    <details class="rep-howcounted" id="report-scoreboard-how"><summary>How these are counted</summary>
      <div class="rep-howcounted-body">
        <p><strong>Fees banked (paid)</strong> <span class="money-basis">${esc(BASIS_CASH_MONTH)}</span> — broker fees actually received this month, each counted on the date that fee was paid. A different scope from "Completed £ (earned)" on the Monthly business panel above, which is fee value earned on cases completed this month regardless of payment status.${bankedFuture ? ` Excludes future-dated payments (${bankedFuture}).` : ""}</p>
        <p><strong>Target</strong> <span class="money-basis">(fees earned ÷ target · this month)</span> — fees earned (procuration + broker + solicitor) on that adviser's ${esc(label)} completions, paid or not, against the per-adviser monthly target set in Settings. The same earned-on-completion basis as the firm "Fees earned vs target" bar above, and deliberately a different figure from the cash "Fees banked" column beside it; advisers with no target set show "—".</p>
        <p><strong>Banked ${ytdYear}</strong> <span class="money-basis">(broker only · cash · YTD)</span> — that adviser's broker cash for the calendar year, straight from get_reports.${ytdGap ? ` It covers people who still have a login, so it totals ${fmtM(ytdRpcSum)} against the ${fmtM(ytdFirm)} on the "Fees banked ${ytdYear}" tile below — the ${fmtM(ytdGap)} difference sits on completed cases still attributed to someone whose access has been removed.` : ""}</p>
        <p><strong>Attach (${esc(attachShort)})</strong> <span class="money-basis">(policy taken ÷ completions · this month)</span> — the share of THIS MONTH's completions that ended with a protection policy, with the count in brackets. On a month's worth of completions a single case moves it a long way, so read the bracket before the percentage. The Monday money page carries the same measure over the whole calendar year, and its header says so.</p>
        <p><strong>Avg days</strong> — mean days from case created to completed, over completions in ${esc(label)} only; fewer than three completions is greyed and is not a ranking. <strong>6-mo trend</strong> — completions per month over the last 6 calendar months, every row on one shared scale.</p>
        ${/* R74 · A4b — the Overdue column left this table; say where it went rather than letting
              the reader assume it was lost. */ ""}
        <p><strong>Overdue tasks</strong> are not a column here any more — the same figure, per person, is in "Is anyone using it?" directly below this table, and again on Monday money. It was the tenth column of a ten-column table and it was the one being clipped off the right-hand edge.</p>
        <p>${esc(ATTRIB_NOTE)}</p>
      </div>
    </details>`;
  /* R26 — foot Target cell: apples-to-apples, summing ONLY advisers who HAVE a target on both
     sides (their fees earned — proc+broker+sols — this month vs the sum of set targets). None set → "—". */
  const footTargetCell = (() => {
    let sumTargets = 0, sumEarned = 0;
    advRows.forEach((a) => { const t = a.id ? Number(advTargets[a.id] || 0) : 0; if (t > 0) { sumTargets += t; sumEarned += Number(a.feeEarnedTotal) || 0; } });
    if (!(sumTargets > 0)) return `<td class="adv-target-cell">—</td>`;
    const p = Math.round((sumEarned / sumTargets) * 100);
    const c = p >= 100 ? "var(--green)" : p >= 60 ? "var(--amber)" : "var(--red)";
    return `<td class="adv-target-cell"><strong>${fmtM(sumEarned)} / ${fmtM(sumTargets)}</strong> <span style="color:${c};font-weight:600;">(${p}%)</span></td>`;
  })();
  $("#report-advisers").innerHTML = advRows.length ? `<table class="imp-table">
    ${/* R74 · A2/A4b — ONE-LINE HEADERS WITH THEIR BASIS IN THE NAME. The three-line
          <span class="money-basis"> blocks under four of these headings were what made a
          ten-column table 1,300px wide inside a 1,160px panel, so Attach, Overdue, Avg days and
          the trend were clipped off the right-hand edge with no scrollbar to say so. Each basis
          now lives in the header's own title= (and, in full, behind "How these are counted"
          above). ATTACH CARRIES ITS PERIOD IN THE HEADER — "Attach (Aug)" here, "Attach (2026)"
          on Monday money — because the same person read 0% on one page and 43% on the other and
          nothing on either said one was a month and the other a year. */ ""}
    <tr><th>Adviser</th><th>Open</th><th>Completions</th><th title="Broker fees actually received this month, counted on the broker fee's own paid date. Payments dated in the future are excluded. ${esc(BASIS_CASH_MONTH)}">Fees banked</th><th title="Fees earned (procuration + broker + solicitor) on each adviser's completions this month (paid or not) versus their monthly target set in Settings — the same earned-on-completion basis as the firm 'Fees earned vs target' bar above, NOT the cash 'Fees banked' column beside it. Blank target = no target (shows —). (fees earned ÷ target · this month)">Target</th><th title="Broker fees this adviser has banked so far in ${ytdYear}, as reported by get_reports (M5) — the same coalesce(broker_fee_paid_at, fee_paid_at) basis as the column beside it, widened to the whole year. (broker only · cash · YTD)">Banked ${ytdYear}</th><th title="Of the cases this adviser completed in ${esc(label)}, the share that ended with a protection policy (protection_status = policy taken). The count is in brackets — a month is a small sample and a single case can swing it. Monday money measures the same thing over the whole of ${ytdYear}, which is why the two pages can differ. (policy taken ÷ completions · this month)">Attach (${esc(attachShort)})</th><th title="Mean days from case created to completed, over completions in the selected month only. The sample size is in brackets; fewer than 3 completions is greyed and should not be read as a ranking.">Avg days</th><th title="Completions per month over the last 6 calendar months. Every row shares one vertical scale (peak ${sparkMax}); the number is this month's value.">6-mo trend</th></tr>
    ${advRows.map((a) => `<tr${a.offTeam ? ' class="row-warn"' : ""}>
      <td>${advName(a)}</td>
      <td class="num">${a.open}</td>
      <td class="num">${a.completions}</td>
      <td class="num">${fmtM(a.feesBanked)}</td>
      ${advTargetCell(a)}
      <td${a.id && ytdById[a.id] == null ? ' class="stat-weak" title="Not covered by get_reports — this row has no active login."' : ""}>${a.id && ytdById[a.id] != null ? fmtM(ytdById[a.id]) : "—"}</td>
      <td${a.attach == null ? ' class="stat-weak" title="No completions in this month, so there is nothing to attach a policy to."' : (a.completions < 3 ? ' class="stat-weak" title="Fewer than 3 completions — too small a sample to read as a ranking."' : "")}>${a.attach == null ? "—" : `${a.attach}% <span class="cs-muted">(${a.protTaken}/${a.completions})</span>`}</td>
      ${/* R74 · A4b — the Overdue column has LEFT this table (it rendered twice more on the same
           page: the adoption strip immediately below, and Monday money). R73's one-amber-badge
           rule is unchanged and still lives on both of those. */ ""}
      <td>${advAvg(a)}</td>
      <td title="${esc(a.trendTitle)}">${sparklineSvg(a.trend, sparkMax)} <span class="spark-now">${a.trend[a.trend.length - 1]}</span></td>
    </tr>`).join("")}
    <tr id="report-scoreboard-foot" class="scoreboard-foot">
      <td><strong>Total</strong></td>
      <td><strong>${openSum}</strong></td>
      ${/* R74 · A4b — the reconciliation SENTENCE has left the table and now sits under it. A
            60-character sentence in a colspan="2" cell was setting the minimum width of the
            Completions and Fees banked columns, which is most of why a nine-column table would
            not fit its own panel and lost Attach, Avg days and the trend off the right edge. The
            colspan is kept (r26 §E3 pins the foot row's colspan-sum to the header's) and the
            sentence is rendered in full below, where it has the width to be read. */ ""}
      <td colspan="2"></td>
      ${footTargetCell}
      <td colspan="4"></td>
    </tr>
  </table>
  <p class="panel-sub" id="report-scoreboard-reconcile" style="margin:8px 0 0;">The ${openSum} open cases above ${openSum === liveTotal ? "<strong>reconcile with</strong>" : "<strong>do not reconcile with</strong>"} the ${liveTotal} live cases on the KPI row below${unassignedLive ? ` · ${unassignedLive} of them unassigned` : ""}.</p>` : `<div class="empty">No adviser activity in ${label}.</div>`;
  }

  // ---- Pipeline funnel: cases created in the selected month, by current stage (all 8 stages,
  // so a month's cohort that has already completed or dropped out still shows up). ----
  const monthCases = all.filter((c) => inMonth(c.created_at));
  /* R37 · P1-corrected — say the SCOPE loudly, because the page carries two funnels and they are
     not duplicates: this one is a month COHORT (created in <label>, wherever they have got to),
     the MI one is the live book right now. The pointer to the other is only offered when the
     reader can actually see it — Pipeline MI is isAdminOrOwner-gated, and directing an adviser to
     a section that is not on their page would be worse than saying nothing. */
  $("#report-funnel-scope").innerHTML = `<strong>Cases CREATED in ${esc(label)}</strong> — how far they have got, by current stage. ${monthCases.length} case${monthCases.length === 1 ? "" : "s"}.`
    + (isAdminOrOwner() ? ` <em>(The live snapshot — everything open right now, whenever it started — is “Funnel &amp; conversion” in Pipeline MI above.)</em>` : "");
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

  /* R77 · A2b — the Lead-sources table moved into its own renderer with the Losses panel's
     This-month / All-time toggle and case-insensitive grouping. Same columns, same convCell
     small-sample honesty, same everyone-sees-volumes / owner-sees-Revenue split. */
  renderLeadSourcesPanel(all, mv);

  renderLossesPanel(all, mv);
}

/* ==========================================================================
   R77 · A2b — LEAD SOURCES: READ WHAT A2a CAPTURES, WITHOUT SPLINTERING IT.

   Two changes to the table that was previously inlined in renderThreadedPanels,
   both driven by the production data: lead_source is blank on 130 of 132 live
   cases, so (a) a SINGLE month of it is usually too few rows to read — the
   panel gains the Losses panel's exact This-month / All-time toggle (All time
   = every case on the book, matching what Losses chose); and (b) the moment
   capture starts working, "google" beside "Google" is two rows pretending to
   be two sources — grouping is now case-insensitive (trim + lowercase key),
   displaying the casing the book uses most. Columns, the convCell (n<5)
   small-sample honesty and the owner-only Revenue column are unchanged.
   ========================================================================== */
let sourcesAllTime = false;
let sourcesState = { all: [], mv: null };
function renderLeadSourcesPanel(all, mv) {
  sourcesState.all = all || sourcesState.all;
  sourcesState.mv = mv || sourcesState.mv;
  const rowsAll = sourcesState.all || [];
  const label = monthLabel(sourcesState.mv);
  const money = showMoney();
  const scoped = sourcesAllTime ? rowsAll
    : rowsAll.filter((c) => c.created_at && localMonthStr(c.created_at) === sourcesState.mv);
  const btn = $("#report-sources-scope-btn");
  if (btn) btn.textContent = sourcesAllTime ? "This month" : "All time";
  const scopeEl = $("#report-sources-scope");
  if (scopeEl) {
    scopeEl.textContent = sourcesAllTime
      ? `Set the lead source on cases to build this up. Every case on the book, all time (${rowsAll.length}). Sources are grouped case-insensitively — “google” and “Google” are one row.`
      : `Set the lead source on cases to build this up. Scoped to leads created in ${label}.`;
  }
  const srcMap = {};   // trim+lowercase key → aggregate; display = the most common casing
  scoped.forEach((c) => {
    const raw = (c.lead_source || "").trim();
    const k = raw ? raw.toLowerCase() : "(not set)";
    const v = srcMap[k] || (srcMap[k] = { cases: 0, completed: 0, lost: 0, live: 0, revenue: 0, last: null, variants: new Map() });
    if (raw) v.variants.set(raw, (v.variants.get(raw) || 0) + 1);
    v.cases++;
    if (c.created_at && (!v.last || c.created_at > v.last)) v.last = c.created_at;
    if (c.stage === "completed") { v.completed++; v.revenue += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0); }
    else if (c.stage === "not_proceeding") v.lost++;
    else v.live++;
  });
  const displayOf = (k, v) => {
    if (k === "(not set)") return "(not set)";
    let best = null, bestN = -1;
    v.variants.forEach((n, variant) => { if (n > bestN) { best = variant; bestN = n; } });
    return best || k;
  };
  // Lead-source VOLUMES are operational and stay for everyone; the Revenue column is money.
  $("#report-sources").innerHTML = scoped.length ? `<table class="imp-table">
    <tr><th>Source</th><th>Cases</th><th title="Still in the live pipeline — neither won nor lost, and excluded from Conversion">Live</th><th>Completed</th><th title="${esc(CONV_TH_TITLE)}">Conversion</th><th>Last lead</th>${money ? "<th>Revenue</th>" : ""}</tr>
    ${Object.entries(srcMap).sort((a, b) => b[1].cases - a[1].cases).map(([k, v]) => {
      const disp = displayOf(k, v);
      return `<tr>
      <td>${k === "(not set)" ? esc(disp) : `<button type="button" class="linkish" onclick="reportGotoSearch('${jsArg(disp)}')" title="Open the pipeline filtered to ${esc(disp)}">${esc(disp)}</button>`}</td>
      <td>${v.cases}</td>
      <td>${v.live}</td>
      <td>${v.completed}</td>
      <td>${convCell(v.completed, v.lost)}</td>
      <td>${fmtD(v.last)}</td>
      ${money ? `<td class="num">${fmtM(v.revenue)}</td>` : ""}
    </tr>`; }).join("")}
  </table>` : `<div class="empty">${sourcesAllTime ? "No cases on the book yet." : `No leads created in ${label}.`}</div>`;
}
window.toggleSourcesScope = function () {
  sourcesAllTime = !sourcesAllTime;
  renderLeadSourcesPanel(null, null);
};

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
      <td class="num">${fmtM(b.loan)}</td>
      <td class="num">${fmtM(b.fees)}</td>
      <td class="loss-advisers">${advBits(b)}</td>
    </tr>`).join("")}
    <tr class="scoreboard-foot"><td><strong>Total</strong></td><td><strong>${tot.n}</strong></td><td class="num"><strong>${fmtM(tot.loan)}</strong></td><td class="num"><strong>${fmtM(tot.fees)}</strong></td><td></td></tr>
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
  if (!showMoney()) {
    $("#report-forecast-headline").innerHTML = ""; $("#report-forecast-buckets").innerHTML = "";
    const tOff = $("#report-forecast-target"); if (tOff) tOff.innerHTML = "";   // R77 · A1a
    return;
  }
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
  /* ==========================================================================
     R77 · A1a — THE FORECAST MEETS THE TARGET.

     The buckets above say what is coming; the firm's monthly fee target
     (settings.monthly_fee_target — the SAME key the hero and the target bar
     read) says what is needed; nothing on this panel ever put the two in one
     sentence. One line does it now: the ≤30-days weighted figure against the
     monthly target, with the gap named in whichever direction it runs. And
     because in production the "No date" bucket is effectively the whole book
     (131 of 132 live cases carry no expected completion date), the same line
     carries the no-date clause, wired to the EXISTING toggleForecastNoneList
     list so the offending cases are one click away — capture before
     comparison. No target set is a real state: the line says so and points at
     Settings rather than inventing a gap against zero.
     ========================================================================== */
  const targetLineEl = $("#report-forecast-target");
  if (targetLineEl) {
    if (!open.length) targetLineEl.innerHTML = "";
    else {
      const fcTarget = Number(settings.monthly_fee_target || 0);
      let line;
      if (fcTarget > 0) {
        const h30w = buckets.h30.weighted;
        const gap = fcTarget - h30w;
        line = `<span id="report-forecast-target-line">≤30 days weighted <strong>${fmtM(h30w)}</strong> vs monthly target ${fmtM(fcTarget)} → ${gap > 0
          ? `gap <strong>${fmtM(gap)}</strong>`
          : `<strong>${fmtM(-gap)}</strong> ahead of target`}</span>`;
      } else {
        line = `<span id="report-forecast-target-line">No monthly fee target is set, so there is no gap to read this against — <button type="button" class="linkish" id="report-forecast-target-set" onclick="nav('settings')">set one in Settings › Targets</button>.</span>`;
      }
      const noneLine = buckets.none.cases
        ? ` · <button type="button" class="linkish" id="report-forecast-none-line" onclick="toggleForecastNoneList()" title="Show which cases have no expected completion date">${buckets.none.cases} case${buckets.none.cases === 1 ? "" : "s"} (${fmtM(buckets.none.weighted)} weighted) ${buckets.none.cases === 1 ? "has" : "have"} no expected completion date</button>`
        : "";
      targetLineEl.innerHTML = `<p class="panel-sub" style="margin:8px 0 0;">${line}${noneLine}</p>`;
    }
  }
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

/* ==========================================================================
   R77 · A4 — BUSINESS MIX BY CASE TYPE.

   The one question no Reports panel answered: WHAT KIND of business is the
   firm actually writing? Completions year-to-date and the live pipeline,
   grouped by case_kind — count, broker-fee sum and average per group — in
   Money & book, because the Reports read already carries case_kind on every
   row (no new query) and the neighbouring panels are the money this mixes.

   Rules, all inherited rather than invented:
     · Owner-only (broker fees), the same showMoney() presentation gate as the
       forecast panel above it.
     · YTD is by completed_at on localDateStr's Europe/London basis — the same
       yearOf the KPI tiles use, so "Completions YTD" here and the tile can
       never disagree.
     · Live = the six MI_LIVE_STAGES (enquiry → exchange), the same set the
       funnel and the MI forecast call the live pipeline.
     · Kinds are named by the case form's own KINDS list; a case with no kind
       recorded keeps its row, labelled "(not recorded)", last — hidden rows
       are how a mix report lies.
     · CSV via miCsv, the panel-header affordance its Money & book neighbours
       (Money owed, the MI panels) already carry.
   ========================================================================== */
function renderBusinessMix(all, yr) {
  const panel = $("#report-mix-panel");
  if (!panel) return;
  const money = showMoney();
  panel.classList.toggle("hidden", !money);
  if (!money) { const el = $("#report-mix"); if (el) el.innerHTML = ""; return; }
  const rows = all || [];
  const yearOf = (d) => localDateStr(d).slice(0, 4);
  const doneYtd = rows.filter((c) => c.completed_at && yearOf(c.completed_at) === String(yr));
  const liveRows = rows.filter((c) => MI_LIVE_STAGES.includes(c.stage));
  const agg = new Map();   // kind key ("" = not recorded) → aggregate
  const bump = (c, slot) => {
    const k = (c.case_kind || "").trim();
    let a = agg.get(k);
    if (!a) { a = { kind: k, doneN: 0, doneFees: 0, liveN: 0, liveFees: 0 }; agg.set(k, a); }
    a[slot + "N"]++;
    a[slot + "Fees"] += Number(c.broker_fee || 0);
  };
  doneYtd.forEach((c) => bump(c, "done"));
  liveRows.forEach((c) => bump(c, "live"));
  const scopeEl = $("#report-mix-scope");
  if (scopeEl) scopeEl.textContent = `Completions are ${yr} year-to-date by completion date; live pipeline is enquiry → exchange right now. Fees are the broker fee only — earned on the case, not necessarily paid. Averages are over each group's own cases, fee or no fee.`;
  const kindLabel = (k) => (k ? ((KINDS.find((x) => x[0] === k) || [])[1] || k) : "(not recorded)");
  const KIND_ORDER = KINDS.map(([k]) => k);
  const orderOf = (k) => { if (!k) return KIND_ORDER.length + 1; const i = KIND_ORDER.indexOf(k); return i === -1 ? KIND_ORDER.length : i; };
  const list = [...agg.values()].sort((a, b) => orderOf(a.kind) - orderOf(b.kind) || a.kind.localeCompare(b.kind));
  const avg = (fees, n) => (n ? fmtM(Math.round(fees / n)) : '<span class="cs-muted">—</span>');
  const tot = list.reduce((s, a) => ({ doneN: s.doneN + a.doneN, doneFees: s.doneFees + a.doneFees, liveN: s.liveN + a.liveN, liveFees: s.liveFees + a.liveFees }),
    { doneN: 0, doneFees: 0, liveN: 0, liveFees: 0 });
  $("#report-mix").innerHTML = list.length ? `<table class="imp-table">
    <tr><th>Case type</th><th>Completed YTD</th><th title="Broker fee on this type's YTD completions — earned, not necessarily paid">Fees YTD</th><th title="Fees YTD ÷ completed YTD">Avg fee</th><th>Live pipeline</th><th title="Broker fee on this type's live cases">Live fees</th><th title="Live fees ÷ live cases">Avg fee</th></tr>
    ${list.map((a) => `<tr${a.kind ? "" : ' class="loss-unrecorded"'}>
      <td>${esc(kindLabel(a.kind))}</td>
      <td>${a.doneN}</td>
      <td class="num">${fmtM(a.doneFees)}</td>
      <td class="num">${avg(a.doneFees, a.doneN)}</td>
      <td>${a.liveN}</td>
      <td class="num">${fmtM(a.liveFees)}</td>
      <td class="num">${avg(a.liveFees, a.liveN)}</td>
    </tr>`).join("")}
    <tr class="scoreboard-foot"><td><strong>Total</strong></td><td><strong>${tot.doneN}</strong></td><td class="num"><strong>${fmtM(tot.doneFees)}</strong></td><td class="num">${avg(tot.doneFees, tot.doneN)}</td><td><strong>${tot.liveN}</strong></td><td class="num"><strong>${fmtM(tot.liveFees)}</strong></td><td class="num">${avg(tot.liveFees, tot.liveN)}</td></tr>
  </table>` : '<div class="empty">No completed or live cases on the book yet.</div>';
  const csvBtn = $("#report-mix-csv");
  if (csvBtn) csvBtn.onclick = () => {
    const dstr = new Date().toISOString().slice(0, 10);
    const r = list.map((a) => [kindLabel(a.kind), a.doneN, a.doneFees, a.doneN ? Math.round(a.doneFees / a.doneN) : "", a.liveN, a.liveFees, a.liveN ? Math.round(a.liveFees / a.liveN) : ""]);
    r.push(["Total", tot.doneN, tot.doneFees, tot.doneN ? Math.round(tot.doneFees / tot.doneN) : "", tot.liveN, tot.liveFees, tot.liveN ? Math.round(tot.liveFees / tot.liveN) : ""]);
    miCsv(`nexmoney-business-mix-${dstr}.csv`, ["Case type", `Completed YTD (${yr})`, "Fees YTD £", "Avg fee £", "Live cases", "Live fees £", "Avg fee £"], r);
  };
}

/* ==========================================================================
   R19 — PIPELINE MI (Owner / Admin management information).

   Owner-facing MI, computed CLIENT-SIDE in a single O(n) pass over the same
   `all` cases Reports already reads, plus the submitted_at / offer_issued_date
   milestone dates now in the Reports select. NO new DB schema.

   DATA REALITY (CTO): the DB holds only ~36 stage_changed case_events today
   (pre-launch), so the funnel/conversion/velocity are derived from the POPULATED
   milestone DATE columns — created_at → submitted_at → offer_issued_date →
   completed_at — NOT from stage-change history. These are real data now and get
   richer as the book grows. Every panel guards thin data explicitly.

   Four panels, all inside #report-mi-section (OWNER/ADMIN-gated as a whole):
     1. Funnel (live pipeline by stage) + historical conversion from milestone
        dates + win rate among terminal cases (thin-data guard <5).
     2. Velocity — median (headline) & average days between milestones, with the
        slowest sub-step named as the bottleneck.
     3. Revenue — monthly completed-fee run-rate (broker+proc, last 12 months) +
        a stage-weighted pipeline forecast (historical weights, default fallback).
     4. Per-adviser scoreboard.
   ========================================================================== */
const MI_STAGE_DEFAULT_WEIGHT = { enquiry: 0.1, fact_find: 0.2, decision_in_principle: 0.4, application: 0.6, offer: 0.85, exchange: 0.95 };
const MI_LIVE_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
const miMedian = (arr) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const miMean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);
const miDays = (a, b) => { const d = Math.round((new Date(b) - new Date(a)) / 86400000); return isNaN(d) ? null : d; };

function renderPipelineMI(all, mv) {
  const sec = $("#report-mi-section");
  if (!sec) return;
  /* OWNER/ADMIN gate — the whole section, hidden for plain advisers. Same mechanism the money
     panels use (classList.toggle('hidden')), and the jump nav reads that .hidden to decide whether
     to draw a chip, so an adviser gets neither the section nor a chip for it. isAdminOrOwner()
     rather than showMoney()/isOwner() because MI is explicitly owner-AND-admin (per spec). */
  const show = isAdminOrOwner();
  sec.classList.toggle("hidden", !show);
  if (!show) return;
  const rows = all || [];
  const fee = (c) => Number(c.broker_fee || 0) + Number(c.proc_fee || 0);

  // ---- last 12 completion months for the run-rate, oldest→newest ----
  const now = new Date();
  const runMonths = [];
  for (let i = 11; i >= 0; i--) runMonths.push(localMonthStr(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  const runMap = Object.fromEntries(runMonths.map((m) => [m, 0]));

  // ---- ONE O(n) pass: funnel, conversion milestones, terminal outcomes, velocity arrays,
  // run-rate month map, live fee by stage, per-adviser aggregate ----
  const funnel = Object.fromEntries(MI_LIVE_STAGES.map((s) => [s, 0]));
  const liveFeeByStage = Object.fromEntries(MI_LIVE_STAGES.map((s) => [s, 0]));
  let reachedApp = 0, reachedOffer = 0, reachedCompleted = 0;   // milestone-date counts
  let completedN = 0, notProceedingN = 0;                       // terminal outcomes
  let appAndCompleted = 0, offerAndCompleted = 0;               // for historical stage weights
  const vCreatedApp = [], vAppOffer = [], vOfferComp = [], vCreatedComp = [];
  const advMap = new Map(); // assigned_to || "__unassigned"

  let miSkipped = 0;   // R21 Part B — one bad case must not abort the whole MI aggregation
  /* R77 · A3 — HOW THIN IS THE DATE COVERAGE? The conversion and velocity figures below are built
     from milestone DATES, and in production those are mostly blank (104 cases completed in 2026
     carry no submitted_at; one case in the whole book has an offer_issued_date) — which is how the
     conversion table prints "Completed 30 (3000%)". Count, per case, the EARLIEST milestone date
     its stage says it should carry but doesn't (Data health's dh-tile-milestone rule, without its
     back-book age cut — this is about what THESE figures can and cannot see). */
  const MI_RANKS = Object.fromEntries(STAGES.map(([k], i) => [k, i]));
  const MI_APP_RANK = MI_RANKS["application"], MI_OFFER_RANK = MI_RANKS["offer"];
  let missMilestone = 0;
  rows.forEach((c) => {
    try {
    const live = MI_LIVE_STAGES.includes(c.stage);
    // R77 · A3 — the coverage counter (see above). A dropped case owes no milestone date.
    if (c.stage !== "not_proceeding") {
      const rank = MI_RANKS[c.stage];
      if (rank != null && rank >= MI_APP_RANK && !c.submitted_at) missMilestone++;
      else if (rank != null && rank >= MI_OFFER_RANK && !c.offer_issued_date) missMilestone++;
    }
    if (live) { funnel[c.stage]++; liveFeeByStage[c.stage] += fee(c); }

    const hasApp = !!c.submitted_at, hasOffer = !!c.offer_issued_date, hasComp = !!c.completed_at;
    if (hasApp) reachedApp++;
    if (hasOffer) reachedOffer++;
    if (hasComp) reachedCompleted++;
    if (hasApp && hasComp) appAndCompleted++;
    if (hasOffer && hasComp) offerAndCompleted++;

    if (c.stage === "completed") completedN++;
    else if (c.stage === "not_proceeding") notProceedingN++;

    // velocity — only where BOTH endpoints exist and the gap is sane (>= 0)
    if (c.created_at && hasApp) { const d = miDays(c.created_at, c.submitted_at); if (d != null && d >= 0) vCreatedApp.push(d); }
    if (hasApp && hasOffer) { const d = miDays(c.submitted_at, c.offer_issued_date); if (d != null && d >= 0) vAppOffer.push(d); }
    if (hasOffer && hasComp) { const d = miDays(c.offer_issued_date, c.completed_at); if (d != null && d >= 0) vOfferComp.push(d); }
    if (c.created_at && hasComp) { const d = miDays(c.created_at, c.completed_at); if (d != null && d >= 0) vCreatedComp.push(d); }

    // run-rate — completed fee income (broker + proc) bucketed by completed_at month
    if (hasComp) { const m = localMonthStr(c.completed_at); if (m in runMap) runMap[m] += fee(c); }

    // per-adviser aggregate
    const key = c.assigned_to || "__unassigned";
    let a = advMap.get(key);
    if (!a) { a = { id: c.assigned_to || null, live: 0, completedPeriod: 0, feesPeriod: 0, won: 0, lost: 0, cycles: [] }; advMap.set(key, a); }
    if (live) a.live++;
    if (c.stage === "completed") { a.won++; if (c.created_at && hasComp) { const d = miDays(c.created_at, c.completed_at); if (d != null && d >= 0) a.cycles.push(d); } }
    else if (c.stage === "not_proceeding") a.lost++;
    if (hasComp && localMonthStr(c.completed_at) === mv) { a.completedPeriod++; a.feesPeriod += fee(c); }
    } catch (err) {
      miSkipped++;
      logClientError("caught", "reports MI aggregation failed for a case: " + ((err && err.message) || err), { recordId: c && c.id, where: "renderPipelineMI" });
    }
  });

  const label = monthLabel(mv);
  $("#report-mi-scope").textContent = "Owner management information, derived from the case book's milestone dates (created → submitted → offer issued → completed). Pre-launch the samples are small; every figure below states its own basis and sharpens as the book grows.";
  if (miSkipped > 0) $("#report-mi-scope").insertAdjacentHTML("beforeend", ` <span class="client-list-cap-note">${miSkipped} record(s) couldn't be displayed — logged</span>`);

  // ---- Panel 1: funnel + conversion + win rate ----
  const liveTot = MI_LIVE_STAGES.reduce((s, st) => s + funnel[st], 0);
  const maxFun = Math.max(...MI_LIVE_STAGES.map((s) => funnel[s]), 1);
  /* R20 — each stage bar is now a real <button> (keyboard-accessible, Enter/Space native) that
     drills to the live cases at that stage. A zero-count bar is `disabled` so it is neither
     focusable nor clickable — there is nothing to open behind it. Listeners wired below. */
  $("#report-mi-funnel").innerHTML = liveTot ? MI_LIVE_STAGES.map((s) => `
    <button type="button" class="mi-bar-row mi-drill" data-mi-stage="${s}"${funnel[s] ? ` title="Click to see the cases"` : " disabled"} aria-label="${esc(STAGE_LABEL[s])}: ${funnel[s]} live case${funnel[s] === 1 ? "" : "s"}">
      <span class="mi-bar-lbl">${STAGE_LABEL[s]}</span>
      <span class="mi-bar-track"><span class="mi-bar-fill" style="width:${(funnel[s] / maxFun) * 100}%;"></span></span>
      <span class="mi-bar-n">${funnel[s]}</span>
    </button>`).join("") : '<div class="empty">No live cases in the pipeline.</div>';

  const total = rows.length;
  const stepPct = (num, den) => (den ? Math.round((num / den) * 100) + "%" : "—");
  /* R77 · A3 — THE COVERAGE GUARD: NEVER PRINT 3000%. A later milestone counting MORE cases than
     the one before it is not a conversion rate, it is a hole in the dates (a case can only reach
     offer THROUGH application — the arithmetic can exceed 100% only because the earlier date is
     missing). Where that happens the percentage is replaced — never the row, never silently — by
     an honest clause naming how many cases are missing their dates, linking to Data health's own
     missing-milestone list (dh-tile-milestone), whose tile copy already points back at this table.
     The same clause replaces a velocity median/average computed from n≤1 dated cases: a "median"
     of one case is that case, not a rate the firm can plan on. */
  const miCoverageClause = (n) => `<button type="button" class="linkish mi-coverage-clause" onclick="miGotoMilestoneHealth()" title="Open Data health at the missing application/offer date list">date coverage too thin — ${n} case${n === 1 ? " is" : "s are"} missing application/offer dates → fix in Data health</button>`;
  const stepCell = (num, den) => (num > den ? miCoverageClause(missMilestone) : stepPct(num, den));
  $("#report-mi-conversion").innerHTML = `
    <table class="imp-table">
      <tr><th>Milestone</th><th>Cases</th><th title="Share reaching this milestone from the one before it">Step %</th></tr>
      <tr><td>Created</td><td>${total}</td><td><span class="cs-muted">—</span></td></tr>
      <tr><td>Reached application <span class="cs-muted">(submitted)</span></td><td>${reachedApp}</td><td>${stepCell(reachedApp, total)}</td></tr>
      <tr><td>Reached offer <span class="cs-muted">(offer issued)</span></td><td>${reachedOffer}</td><td>${stepCell(reachedOffer, reachedApp)}</td></tr>
      <tr><td>Completed</td><td>${reachedCompleted}</td><td>${stepCell(reachedCompleted, reachedOffer)}</td></tr>
    </table>
    <p class="panel-sub" style="margin:6px 0 0;">From milestone dates, not stage-change history.</p>`;

  const terminal = completedN + notProceedingN;
  $("#report-mi-winrate").innerHTML = terminal < 5
    ? `<span class="stat-weak">Win rate: not enough completed cases yet for a reliable rate (${terminal} terminal case${terminal === 1 ? "" : "s"}).</span>`
    : `<button type="button" class="linkish mi-drill" id="report-mi-winrate-link" title="Click to see the cases"><strong>Win rate ${Math.round((completedN / terminal) * 100)}%</strong> — ${completedN} completed of ${terminal} terminal (completed + not proceeding).</button>`;

  // ---- Panel 2: velocity ----
  const vMetrics = [
    { label: "Created → application", arr: vCreatedApp },
    { label: "Application → offer", arr: vAppOffer },
    { label: "Offer → completion", arr: vOfferComp },
    { label: "Created → completion (total)", arr: vCreatedComp },
  ];
  $("#report-mi-velocity").innerHTML = `<table class="imp-table">
    <tr><th>Transition</th><th title="Headline — robust to outliers">Median</th><th>Average</th><th>n</th></tr>
    ${vMetrics.map((m) => {
      const md = miMedian(m.arr), av = miMean(m.arr);
      /* R77 · A3 — a velocity figure from n≤1 dated cases is one case wearing a median's clothes.
         Where the thinness is CAUSED by missing dates the row keeps its place and its n, and the
         numbers are replaced by the coverage clause; a genuinely tiny book with nothing missing
         (missMilestone 0) keeps the plain "—"/number — there is nothing to send anyone to fix. */
      if (m.arr.length <= 1 && missMilestone > 0) {
        return `<tr>
        <td>${m.label}</td>
        <td colspan="2">${miCoverageClause(missMilestone)}</td>
        <td>${m.arr.length}</td>
      </tr>`;
      }
      return `<tr>
        <td>${m.label}</td>
        <td>${md == null ? '<span class="cs-muted">—</span>' : `<strong>${md}d</strong>`}</td>
        <td>${av == null ? '<span class="cs-muted">—</span>' : av + "d"}</td>
        <td>${m.arr.length}</td>
      </tr>`;
    }).join("")}
  </table>`;
  const subSteps = [
    { name: "to application", arr: vCreatedApp },
    { name: "underwriting", arr: vAppOffer },
    { name: "completion", arr: vOfferComp },
  ].map((s) => ({ name: s.name, med: miMedian(s.arr), n: s.arr.length })).filter((s) => s.med != null);
  subSteps.sort((a, b) => b.med - a.med);
  $("#report-mi-bottleneck").innerHTML = subSteps.length
    ? `Longest stage: <strong>${subSteps[0].name}</strong>, median ${subSteps[0].med} day${subSteps[0].med === 1 ? "" : "s"} (n=${subSteps[0].n}).`
    : "Not enough dated cases yet to identify a bottleneck.";

  // ---- Panel 3: run-rate + forecast ----
  const runVals = runMonths.map((m) => runMap[m]);
  const runTotal = runVals.reduce((a, b) => a + b, 0);
  const maxRun = Math.max(...runVals, 1);
  $("#report-mi-runrate").innerHTML = runMonths.map((m, i) => {
    const v = runVals[i];
    const lbl = MONTH_SHORT[Number(m.slice(5, 7)) - 1] + " " + m.slice(2, 4);
    return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;" title="${m}: ${esc(fmtM(v))}">
      <span style="width:56px;font-size:11px;color:var(--muted);">${lbl}</span>
      <div style="flex:1;background:var(--light);border-radius:4px;"><div style="width:${(v / maxRun) * 100}%;background:var(--orange);border-radius:4px;height:14px;"></div></div>
      <span style="width:84px;font-size:12px;font-weight:600;text-align:right;">${v ? fmtM(v) : '<span class="cs-muted">—</span>'}</span>
    </div>`;
  }).join("");
  $("#report-mi-runrate-basis").innerHTML = `Completed-fee income (broker + proc) by completion month, last 12 months. 12-month total <strong>${fmtM(runTotal)}</strong>.`;

  // stage weights: historical stage→completed rate where the sample is big enough, defaults otherwise.
  const thin = reachedCompleted < 5;
  const weightOf = {};
  MI_LIVE_STAGES.forEach((s) => { weightOf[s] = MI_STAGE_DEFAULT_WEIGHT[s]; });
  let calibrated = false;
  if (!thin) {
    if (reachedApp >= 5) { weightOf.application = appAndCompleted / reachedApp; calibrated = true; }
    if (reachedOffer >= 5) { weightOf.offer = offerAndCompleted / reachedOffer; calibrated = true; }
  }
  const liveFeeTotal = MI_LIVE_STAGES.reduce((s, st) => s + liveFeeByStage[st], 0);
  const weightedTotal = MI_LIVE_STAGES.reduce((s, st) => s + liveFeeByStage[st] * weightOf[st], 0);
  const weightLabel = calibrated
    ? "(application/offer weights calibrated from history; other stages default likelihoods)"
    : "(default likelihoods — will calibrate as cases complete)";
  $("#report-mi-forecast-headline").innerHTML = `
    <div class="kpi kpi-headline"><div class="num" title="${esc(fmtM(weightedTotal))}">${fmtM(weightedTotal)}</div><div class="lbl">Weighted-expected to land</div></div>
    <div class="kpi"><div class="num" title="${esc(fmtM(liveFeeTotal))}">${fmtM(liveFeeTotal)}</div><div class="lbl">Fees in live pipeline</div></div>`;
  $("#report-mi-forecast").innerHTML = `
    <p class="panel-sub" style="margin:0 0 6px;"><strong>${fmtM(liveFeeTotal)}</strong> of fees in the live pipeline, <strong>~${fmtM(weightedTotal)}</strong> weighted-expected to land. <span class="money-basis">${weightLabel}</span></p>
    <table class="imp-table">
      <tr><th>Stage</th><th>Live £</th><th title="Completion likelihood">Weight</th><th>Expected £</th></tr>
      ${MI_LIVE_STAGES.map((s) => `<tr>
        <td>${STAGE_LABEL[s]}</td>
        <td class="num">${fmtM(liveFeeByStage[s])}</td>
        <td>${Math.round(weightOf[s] * 100)}%</td>
        <td class="num">${fmtM(liveFeeByStage[s] * weightOf[s])}</td>
      </tr>`).join("")}
    </table>`;

  // ---- Panel 4: per-adviser scoreboard ----
  const boardRows = [...advMap.values()]
    .filter((a) => a.live || a.completedPeriod || a.feesPeriod || a.won || a.lost)
    .map((a) => {
      const term = a.won + a.lost;
      return {
        id: a.id, key: a.id || "__unassigned", live: a.live, completedPeriod: a.completedPeriod, feesPeriod: a.feesPeriod,
        term, winPct: term ? Math.round((a.won / term) * 100) : null, medCycle: miMedian(a.cycles),
        name: a.id ? staffName(a.id) : "Unassigned",
      };
    })
    .sort((x, y) => y.feesPeriod - x.feesPeriod);
  $("#report-mi-scoreboard-scope").textContent = `Live cases are as of now; completed and fees written are for ${label}; win rate and median cycle are all-time. Sorted by fees written.`;
  $("#report-mi-scoreboard").innerHTML = boardRows.length ? `<table class="imp-table">
    <tr><th>Adviser</th><th>Live</th><th title="Completed in ${esc(label)}">Completed</th><th title="Broker + proc fee on cases completed in ${esc(label)}">Fees written</th><th title="All-time completed ÷ (completed + not proceeding)">Win rate</th><th title="All-time median days, created → completed">Median cycle</th></tr>
    ${boardRows.map((a) => `<tr>
      <td><button type="button" class="linkish mi-drill mi-adv-link" data-mi-adv="${esc(a.key)}" title="Click to see the cases">${esc(a.name)}</button></td>
      <td>${a.live}</td>
      <td>${a.completedPeriod}</td>
      <td class="num">${fmtM(a.feesPeriod)}</td>
      <td>${a.winPct == null ? '<span class="cs-muted">—</span>' : (a.term < 5 ? `<span class="stat-weak" title="Fewer than 5 terminal cases — not a reliable rate">${a.winPct}% <span class="stat-n">(${a.term})</span></span>` : `${a.winPct}% <span class="cs-muted">(${a.term})</span>`)}</td>
      <td>${a.medCycle == null ? '<span class="cs-muted">—</span>' : a.medCycle + "d"}</td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No adviser activity yet.</div>';

  /* ============================ R20 — ACTIONABLE MI ============================
     Drill-downs and per-panel CSV, all off the in-scope `all`/`rows` set already read by
     Reports (no new query) and inside this owner/admin-gated render (gate inherited). The
     click targets rendered above are real <button>s, so Enter/Space work natively; each just
     filters `rows` and hands the subset to miDrilldown(). CSV buttons live in the static panel
     headers; their handlers reuse the aggregates computed above and emit via miCsv() (which
     mirrors exportCsv's serialization — same injection guard, BOM, Blob, anchor download). */
  const dstr = new Date().toISOString().slice(0, 10);

  // Funnel stage bars → live cases at that stage.
  $("#report-mi-funnel").querySelectorAll(".mi-bar-row[data-mi-stage]").forEach((btn) => {
    const s = btn.getAttribute("data-mi-stage");
    btn.addEventListener("click", () => miDrilldown(`Live cases · ${STAGE_LABEL[s] || s}`, rows.filter((c) => c.stage === s)));
  });
  // Scoreboard adviser rows → that adviser's cases (all of them, live + terminal).
  $("#report-mi-scoreboard").querySelectorAll(".mi-adv-link[data-mi-adv]").forEach((btn) => {
    const key = btn.getAttribute("data-mi-adv");
    const nm = key === "__unassigned" ? "Unassigned" : staffName(key);
    btn.addEventListener("click", () => miDrilldown(`${nm} · all cases`, rows.filter((c) => (c.assigned_to || "__unassigned") === key)));
  });
  // Win-rate figure → the terminal cases (completed + not proceeding) behind the rate.
  const wrLink = $("#report-mi-winrate-link");
  if (wrLink) wrLink.addEventListener("click", () => miDrilldown("Terminal cases · win rate", rows.filter((c) => c.stage === "completed" || c.stage === "not_proceeding")));

  // ---- Per-panel CSV export ----
  const csvFunnel = $("#report-mi-csv-funnel");
  if (csvFunnel) csvFunnel.onclick = () => {
    const r = [];
    MI_LIVE_STAGES.forEach((s) => r.push(["Live funnel", STAGE_LABEL[s], funnel[s], ""]));
    r.push(["Conversion", "Created", total, ""]);
    // R77 · A3 — the CSV keeps the guard: an impossible % is no truer in a spreadsheet.
    const stepCsv = (num, den) => (num > den ? `date coverage too thin (${missMilestone} missing dates)` : stepPct(num, den));
    r.push(["Conversion", "Reached application (submitted)", reachedApp, stepCsv(reachedApp, total)]);
    r.push(["Conversion", "Reached offer (offer issued)", reachedOffer, stepCsv(reachedOffer, reachedApp)]);
    r.push(["Conversion", "Completed", reachedCompleted, stepCsv(reachedCompleted, reachedOffer)]);
    r.push(["Win rate", `${completedN} completed of ${terminal} terminal`, terminal >= 5 ? Math.round((completedN / terminal) * 100) + "%" : "n/a (<5 terminal)", ""]);
    miCsv(`nexmoney-mi-funnel-${dstr}.csv`, ["Section", "Item", "Count", "Step %"], r);
  };
  const csvVel = $("#report-mi-csv-velocity");
  if (csvVel) csvVel.onclick = () => {
    const r = vMetrics.map((m) => [m.label, miMedian(m.arr) ?? "", miMean(m.arr) ?? "", m.arr.length]);
    miCsv(`nexmoney-mi-velocity-${dstr}.csv`, ["Transition", "Median days", "Mean days", "n"], r);
  };
  const csvRev = $("#report-mi-csv-revenue");
  if (csvRev) csvRev.onclick = () => {
    const r = [];
    runMonths.forEach((m, i) => r.push(["Run-rate", m, runVals[i], "", ""]));
    r.push(["Run-rate", "12-month total", runTotal, "", ""]);
    MI_LIVE_STAGES.forEach((s) => r.push(["Forecast", STAGE_LABEL[s], liveFeeByStage[s], Math.round(weightOf[s] * 100) + "%", Math.round(liveFeeByStage[s] * weightOf[s])]));
    r.push(["Forecast", "Live pipeline total", liveFeeTotal, "", Math.round(weightedTotal)]);
    miCsv(`nexmoney-mi-revenue-${dstr}.csv`, ["Section", "Item", "£ / count", "Weight", "Weighted £"], r);
  };
  const csvBoard = $("#report-mi-csv-scoreboard");
  if (csvBoard) csvBoard.onclick = () => {
    const r = boardRows.map((a) => [a.name, a.live, a.completedPeriod, a.feesPeriod, a.winPct == null ? "" : a.winPct + "%", a.term, a.medCycle == null ? "" : a.medCycle]);
    miCsv(`nexmoney-mi-scoreboard-${dstr}.csv`, ["Adviser", "Live", `Completed (${label})`, "Fees written £", "Win rate", "Terminal n", "Median cycle days"], r);
  };
}

/* R77 · A3 — the coverage clause's destination: Data health's OWN missing-milestone list
   (dh-tile-milestone → #dh-milestone-panel), whose tile copy has said since R25 that these blanks
   "silently skew the Reports velocity & funnel". This is the reverse link. Same nav-then-reveal
   shape as the clawback tile's cross-page jump (Data health renders async; the panel is revealed
   rather than toggled so a second click can never hide it). */
window.miGotoMilestoneHealth = function () {
  nav("data");
  setTimeout(() => {
    const p = $("#dh-milestone-panel");
    if (p) { p.classList.remove("hidden"); p.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }, 700);
};

/* R20 — one thin CSV emitter for the MI panels and drill-downs. exportCsv() (~8735) is
   case-book-shaped: fixed columns + a fixed `pipeline-…` filename, so it cannot serialize the
   aggregate MI tables. Rather than a second CSV library, this reuses exportCsv's EXACT
   serialization contract — the same formula-injection guard, the same UTF-8 BOM, the same
   Blob + anchor download — parameterized by filename/header/rows. Owner/admin-gated by virtue
   of only being reachable from inside #report-mi-section. */
function miCsv(filename, header, rows) {
  const q2 = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula injection, same guard as exportCsv
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [header.map(q2).join(",")].concat((rows || []).map((r) => r.map(q2).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

/* R20 — the reusable drill-down modal. Reuses the existing #modal / openModal() infra (same
   pattern as the merge/appointment modals: set #modal.innerHTML, then openModal()). Lists the
   passed-in cases (already filtered from `all` by the caller — no query), each row client ·
   stage · adviser · fee, with an Open button that routes through openCase(), a header count,
   and its own CSV (client, stage, adviser, fee, key milestone dates). Empty → "No cases match." */
function miDrilldown(title, cases) {
  const list = (cases || []).slice();
  const feeOf = (c) => Number(c.broker_fee || 0) + Number(c.proc_fee || 0);
  const nameOf = (c) => [c.clients && c.clients.first_name, c.clients && c.clients.last_name].filter(Boolean).join(" ") || "—";
  list.sort((a, b) => feeOf(b) - feeOf(a) || nameOf(a).localeCompare(nameOf(b)));
  const body = list.length ? `<table class="imp-table mi-drill-table">
    <tr><th>Client</th><th>Stage</th><th>Adviser</th><th>Fee</th><th></th></tr>
    ${list.map((c) => `<tr>
      <td>${esc(nameOf(c))}</td>
      <td>${esc(STAGE_LABEL[c.stage] || c.stage)}</td>
      <td>${c.assigned_to ? esc(staffName(c.assigned_to)) : '<span class="cs-muted">Unassigned</span>'}</td>
      <td class="num">${fmtM(feeOf(c))}</td>
      <td><button type="button" class="btn btn-sm" onclick="closeModal(); openCase('${c.id}')">Open</button></td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No cases match.</div>';
  $("#modal").innerHTML = `<div id="mi-drilldown" class="mi-drilldown">
    <h3>${esc(title)} <span class="mi-drill-count">${list.length}</span>${list.length ? `<button type="button" class="btn btn-sm mi-csv-btn" id="mi-drilldown-csv" title="Download these cases as CSV">⭳ CSV</button>` : ""}</h3>
    ${body}
    <div class="modal-actions"><div></div><div class="right"><button type="button" class="btn" id="mi-drilldown-close">Close</button></div></div>
  </div>`;
  openModal();
  const closeBtn = $("#mi-drilldown-close");
  if (closeBtn) closeBtn.onclick = closeModalGuarded;
  const csvBtn = $("#mi-drilldown-csv");
  if (csvBtn) csvBtn.onclick = () => {
    const rowsOut = list.map((c) => [
      nameOf(c), STAGE_LABEL[c.stage] || c.stage, c.assigned_to ? staffName(c.assigned_to) : "Unassigned", feeOf(c),
      (c.created_at || "").slice(0, 10), (c.submitted_at || "").slice(0, 10), (c.offer_issued_date || "").slice(0, 10), (c.completed_at || "").slice(0, 10),
    ]);
    miCsv(`nexmoney-mi-drilldown-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Client", "Stage", "Adviser", "Fee £", "Created", "Submitted", "Offer issued", "Completed"], rowsOut);
  };
}
window.miDrilldown = miDrilldown;

/* ==========================================================================
   R21 Part C — OWNER/ADMIN diagnostics panel (#report-diag-section).
   Gated exactly like renderPipelineMI's #report-mi-section (isAdminOrOwner() +
   classList.toggle('hidden')). Renders a health summary + a newest-first table of
   the in-memory ERROR_LOG, and wires the CSV / copy / clear buttons. Reuses miCsv
   (as the MI CSV buttons do), toast, esc — no new libraries, no network send. */
function diagTimeFmt(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  // local, human — date + HH:MM:SS
  const p = (n) => String(n).padStart(2, "0");
  return `${fmtD(iso)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function diagErrorTotal() {
  return ERROR_LOG.reduce((s, e) => s + (e.count || 1), 0);
}
function renderDiagnostics(all) {
  const sec = $("#report-diag-section");
  if (!sec) return;
  const show = isAdminOrOwner();
  sec.classList.toggle("hidden", !show);
  /* R33 — the block now lives inside a <details> on Settings. The gate is unchanged; it just has
     to reach the wrapper too, or an adviser would be offered a "Diagnostics" disclosure that
     opens onto nothing. */
  const det = $("#diag-details");
  if (det) det.classList.toggle("hidden", !show);
  if (!show) return;
  /* R33 — `all` is the Reports read this used to be rendered from. Called from Settings there is
     no such read and `all` is null: the record count is then OMITTED rather than reported as 0,
     which would be a made-up number about a page the reader isn't on. */
  const recCount = all == null ? null : all.length;
  const total = diagErrorTotal();

  const health = $("#report-diag-health");
  if (health) health.innerHTML =
    (recCount == null ? "" : `<span>Records loaded (last Reports read): <strong>${recCount}</strong></span> · `) +
    `<span>User: <strong>${esc((ME && ME.email) || "—")}</strong> (${esc(MY_ROLE)})</span> · ` +
    `<span>Origin: <strong>${esc(location.origin)}</strong></span> · ` +
    `<span>Errors this session: <strong>${total}</strong></span>`;

  const tbl = $("#diag-error-table");
  if (tbl) {
    if (!ERROR_LOG.length) {
      tbl.innerHTML = `<div class="empty">No errors logged this session. ✅</div>`;
    } else {
      const rowsNewestFirst = ERROR_LOG.slice().reverse();
      tbl.innerHTML = `<table class="imp-table"><tr><th>Time</th><th>Kind</th><th>Message</th><th title="Times this identical error repeated">×</th><th>Where</th></tr>` +
        rowsNewestFirst.map((e) => `<tr>
          <td style="white-space:nowrap;">${esc(diagTimeFmt(e.t))}</td>
          <td>${esc(e.kind || "")}</td>
          <td>${esc(e.msg || "")}</td>
          <td>${e.count || 1}</td>
          <td>${esc(e.where || "")}</td>
        </tr>`).join("") + `</table>`;
    }
  }

  const csvBtn = $("#report-diag-csv");
  if (csvBtn) csvBtn.onclick = () => {
    const rowsOut = ERROR_LOG.slice().reverse().map((e) =>
      [e.t || "", e.kind || "", e.msg || "", e.count || 1, e.where || "", e.view || "", e.role || ""]);
    miCsv(`nexmoney-diagnostics-${new Date().toISOString().slice(0, 10)}.csv`,
      ["time", "kind", "message", "count", "where", "view", "role"], rowsOut);
  };
  const copyBtn = $("#report-diag-copy");
  if (copyBtn) copyBtn.onclick = () => copyDiagnostics(recCount);
  const clearBtn = $("#report-diag-clear");
  if (clearBtn) clearBtn.onclick = () => { ERROR_LOG.length = 0; renderDiagnostics(all); toast("Diagnostics cleared for this session."); };
  /* R30 — fill the additive cross-session table (async, self-contained). renderDiagnostics
     stays sync; loadPersistedDiagnostics never throws and never calls logClientError. */
  try { loadPersistedDiagnostics(); } catch (_) {}
}
/* R30 — the PERSISTED, cross-session error log (owner/admin), additive to the session
   table above. Reads the sanitised error_events fingerprints, aggregates by
   error_type|location|page → count + last-seen + roles, and renders it. Defensive by
   design: it must NEVER throw and NEVER call logClientError (either would re-enter the
   error path), so every branch swallows and an unsupported DB degrades to a plain note. */
async function loadPersistedDiagnostics() {
  const box = $("#diag-persist-table");
  if (!box) return;
  let res;
  try {
    res = await readAll(db.from("error_events").select("error_type,location,page,role,created_at").order("created_at", { ascending: false }).order("id"));
  } catch (e) { res = { error: e }; }
  try {
    if (!res || res.error || !Array.isArray(res.data)) {
      box.innerHTML = '<div class="empty">Cross-session error log isn’t enabled on this database.</div>';
      return;
    }
    const rows = res.data;
    if (!rows.length) {
      box.innerHTML = `<div class="empty">No cross-session errors recorded. ✅</div>`;
    } else {
      const groups = new Map();
      rows.forEach((r) => {
        const key = (r.error_type || "") + "|" + (r.location || "") + "|" + (r.page || "");
        let g = groups.get(key);
        if (!g) { g = { error_type: r.error_type || "", location: r.location || "", page: r.page || "", count: 0, last: "", roles: new Set() }; groups.set(key, g); }
        g.count++;
        if (r.created_at && r.created_at > g.last) g.last = r.created_at;
        if (r.role) g.roles.add(r.role);
      });
      const list = Array.from(groups.values()).sort((a, b) => (b.count - a.count) || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
      box.innerHTML = `<table class="imp-table"><tr><th>Type</th><th>Where</th><th>Page</th><th title="Times seen">×</th><th>Last seen</th><th>Roles</th></tr>` +
        list.map((g) => `<tr>
          <td>${esc(g.error_type)}</td>
          <td>${esc(g.location)}</td>
          <td>${esc(g.page)}</td>
          <td>${g.count}</td>
          <td style="white-space:nowrap;">${esc(diagTimeFmt(g.last))}</td>
          <td>${esc(Array.from(g.roles).join(", "))}</td>
        </tr>`).join("") + `</table>`;
    }
    const clearBtn = $("#report-diag-persist-clear");
    if (clearBtn) clearBtn.onclick = async () => {
      try { await db.from("error_events").delete().gte("id", 0); } catch (_) {}   // .gte("id",0) matches all (delete needs a filter)
      try { loadPersistedDiagnostics(); } catch (_) {}
      try { toast("Persisted diagnostics cleared."); } catch (_) {}
    };
  } catch (_) {
    try { box.innerHTML = '<div class="empty">Cross-session error log isn’t enabled on this database.</div>'; } catch (__) {}
  }
}
/* Plain-text dump (health summary + error rows) → clipboard, so an owner can paste it to
   support. navigator.clipboard is wrapped: absent/denied → a toast, never an exception. */
function copyDiagnostics(recCount) {
  try {
    const lines = [];
    lines.push("NexMoney diagnostics — " + new Date().toISOString());
    lines.push("User: " + ((ME && ME.email) || "—") + " (" + MY_ROLE + ")");
    lines.push("Origin: " + location.origin);
    // R33 — omitted entirely when there is no Reports read behind this render (see renderDiagnostics).
    if (recCount != null) lines.push("Records loaded (last Reports read): " + recCount);
    lines.push("Errors this session: " + diagErrorTotal());
    lines.push("");
    if (!ERROR_LOG.length) {
      lines.push("No errors logged this session.");
    } else {
      ERROR_LOG.slice().reverse().forEach((e) => {
        lines.push([diagTimeFmt(e.t), e.kind, "x" + (e.count || 1), e.where || "-", String(e.msg || "").replace(/\s+/g, " ")].join(" | "));
      });
    }
    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("Diagnostics copied to clipboard."),
        () => toast("Couldn't copy — check clipboard permissions, or use ⭳ CSV."));
    } else {
      toast("Clipboard unavailable — use ⭳ CSV instead.");
    }
  } catch (_) {
    toast("Couldn't copy diagnostics.");
  }
}

/* Batch 6 feature-detection (M2). PostgREST answers a select naming a column that doesn't exist
   with 42703 for the WHOLE statement, so these columns are read in a separate, small query: on an
   older database it fails alone and Reports still renders with the legacy single fee_paid_at and
   an all-"(not recorded)" losses panel. Returns id → {…columns} or null when unavailable. */
/* G1N-4 — one ordered, explicitly-bounded walk shared by every Reports select. The M2 columns are
   merged onto the main cases select BY ID, so if the two queries ever return different subsets the
   missing rows silently revert to the legacy single fee_paid_at and to the "(not recorded)" loss
   bucket — no error, nothing on screen, exactly the failure mode M2/M5 were built to end. Past
   PostgREST's max-rows cap (1000 by default) an unordered, unbounded select is free to do that.
   Ordering both by id and asking for the same explicit ceiling keeps them walking the same set.
   R69-HF1 — the ceiling below is now an APPLICATION cap, applied by readAll() as it pages, not a
   `.limit()` handed to the server. `.limit(20000)` never lifted PostgREST's max-rows: the server
   clamped it to 1,000 and said nothing, so "the same explicit ceiling" above was in truth "the
   first 1,000 rows" on both selects since the back-book import. readAll() walks the whole ordered
   set in 1,000-row `.range()` pages and stops AT this cap, which is what the notice below has
   always claimed. See the readAll block comment (~line 549) for the proof. */
let REPORTS_ROW_CAP = 20000; // R18-P7 — raised 5000→20000: stage_changed case_events already exceed 5000 at current scale, so 5000 silently truncated MI. Truncation-disclosure note below still fires at the new ceiling.
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
/* R23 — the same silent-1000-cap fix, extended to the owner-facing full-table reads R18 left
   unbounded (Dashboard, Pipeline, Clients, Data health, plus the client pickers and the Revolution
   importer). ONE shared ceiling with Reports: below it (20,000 ≫ Daniel's ~2,000) every capped read
   is byte-identical to today — it only lifts PostgREST's silent 1,000-row ceiling so a 2,000+ book is
   read whole instead of an arbitrary first ~1,000. A read that comes back holding EXACTLY the cap is,
   as far as the client can tell, truncated (same `=== cap` principle Reports uses above), so the page
   surfaces one small notice. This effectively NEVER fires for Daniel — it is the safety net.

   R69-HF1 — THE SENTENCE ABOVE WAS WRONG ABOUT HOW, AND THE COST WAS REAL. `.limit(20000)` does not
   lift PostgREST's 1,000-row ceiling; nothing sent from the client can. From the back-book import
   (1,161 clients / 2,015 cases) until this fix, every one of these reads returned the first 1,000
   rows of its order and no notice ever fired, because 1,000 ≠ 20,000. The ceiling is now reached the
   only way it can be — readAll() pages the ordered query with `.range()` until the table runs out or
   this cap is hit — so `ownerCapHit` (`rows.length === OWNER_ROW_CAP`) means what it always said. */
let OWNER_ROW_CAP = REPORTS_ROW_CAP;
const ownerCapHit = (rows) => Array.isArray(rows) && rows.length === OWNER_ROW_CAP;
function renderOwnerCapNotice(sel, hit) {
  const el = $(sel);
  if (!el) return;
  el.classList.toggle("hidden", !hit);
  el.textContent = hit
    ? `⚠ Showing the first ${OWNER_ROW_CAP.toLocaleString("en-GB")} records — this view describes a subset, not the whole book.`
    : "";
}
/* SANDBOX ONLY — the mock harness needs to make the cap bite on a 50-case fixture. Defined only
   when the mock supabase bundle is what loaded, so it cannot exist in the shipped app. */
if (typeof window !== "undefined" && window.supabase && window.supabase.__isMock) {
  window.__setReportsRowCap = function (n) { REPORTS_ROW_CAP = Number(n) || 5000; return REPORTS_ROW_CAP; };
  /* R78 · A5 — a cap change invalidates the board cache too: the cached snapshot was taken
     under the OLD cap, so serving it under the new one would show rows the cap now excludes
     (this is also what keeps r23 §D honest — every post-cap-change board load re-reads). */
  window.__setOwnerRowCap = function (n) { OWNER_ROW_CAP = Number(n) || 5000; bustBoardCache(); return OWNER_ROW_CAP; };
  /* R78 · A5 — sandbox hook so a suite can force the next board load to refetch (r24 §D reads
     the SELECT string off a fresh load; the cache would otherwise serve it silently). */
  window.__bustBoardCache = function () { bustBoardCache(); };
  /* R80 · A2 — same idea for the Protection page's session cache: a suite that seeds candidates
     internally (window.__mock.seedProtectionBook pushes rows without a db.from write, so the
     choke point never sees it) can force the next Protection load to refetch. */
  window.__bustProtCache = function () { bustProtCache(); };
  /* R68 · M7 — re-read the settings table into `settings`. Production re-reads it at sign-in and
     after a save, which is the only time it changes; a harness that has just written a row (an
     adviser fee target, the email hold) needs the same refresh WITHOUT owning the Save button
     that normally performs it. Sandbox-only, for the same reason as the two caps above. */
  window.__reloadSettings = function () { return loadSettings(); };
  /* R74 · A1 — the rate-book classification, so a suite can test the ONE definition directly
     rather than inferring it from three renderings of it. Sandbox-only, same rule as above. */
  window.__r74RateBookCounts = function (feed, rows) { return rateBookCounts(feed, rows); };
  /* R74 · A4c — how many level-2 panel chips exist across ALL sections for this role, so a suite
     can prove the section-scoped strips between them still reach every panel. */
  window.__r74AllRepChips = function () {
    return REPORT_JUMP_SECTIONS.map(([k, l, sel]) => $(sel)).filter((el) => el && repJumpVisible(el)).length;
  };
}
/* G1N-9 — "…→ not_proceeding" (the move INTO the lost stage), never "not_proceeding → …" (a
   reopen). The bare-name alternative covers a writer that records only the new stage. */
const LOST_EVENT_RE = /(?:→|->)\s*not_proceeding\s*$|^\s*not_proceeding\s*$/;
async function loadCaseExtraColumns() {
  try {
    const { data, error } = await readAll(db.from("cases").select("id,lost_reason,broker_fee_paid_at,proc_fee_paid_at,sols_fee_paid_at")
      .order("id"), { cap: REPORTS_ROW_CAP });
    if (error) return null;
    noteRowCap("case fee dates", data);
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) { const { id, ...rest } = r; map[id] = rest; } });
    return map;
  } catch (_) { return null; }
}
/* R7 — M7's property_address, read the same way loadCaseExtraColumns reads M2's: its own small,
   ordered, capped query, so a database that has not taken the migration costs the rate-end
   ledger's de-duplication and its property chips, and nothing else on the page. Returns
   id → address (possibly null) or null when the column isn't there at all. */
async function loadCasePropColumn() {
  try {
    if ((await propAddrSupported()) === false) return null;
    const { data, error } = await readAll(db.from("cases").select("id,property_address").order("id"), { cap: REPORTS_ROW_CAP });
    if (error) { if (isMissingColumnError(error)) PROP_ADDR_SUPPORTED = false; return null; }
    noteRowCap("case property addresses", data);
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) map[r.id] = r.property_address ?? null; });
    return map;
  } catch (_) { return null; }
}
/* R12b · W-15c — the four call-pack columns, read exactly the way M2's and M7's are above: its
   own small, ordered, capped query, so a database that has not taken them costs the "£X/mo more"
   estimate on the Recover rows and nothing else on the page. `rate_percent` comes from the main
   select, so this only has to fetch what that select cannot risk naming. */
async function loadCaseCallPack() {
  try {
    if ((await callPackSupported()) === false) return null;
    const { data, error } = await readAll(db.from("cases").select("id," + CALLPACK_SELECT).order("id"), { cap: REPORTS_ROW_CAP });
    if (error) { if (isMissingColumnError(error)) CALLPACK_SUPPORTED = false; return null; }
    noteRowCap("case call-pack figures", data);
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
    const { data, error } = await readAll(db.from("case_events").select("case_id,event,detail,created_at")
      .eq("event", "stage_changed").order("created_at").order("id"), { cap: REPORTS_ROW_CAP });
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
  const [{ data: cases }, { data: intros }, repRes, extraCols, lostAt, propCols, leadRes, refCols, advDates, detrTasks, solCols, callPack, advRefQ, advOptoutRes, advEmailRes] = await Promise.all([
    // G1N-4 — same order and same explicit ceiling as loadCaseExtraColumns, so the two selects
    // that are merged by id below can never walk different subsets of the table.
    /* R7 — widened by five BASE columns (client_id, lender, rate_end_date, rate_end_estimated)
       so the Money owed and Rate-end book value panels below cost no second walk of the table.
       Every one of them has existed since the original schema, so this select cannot start
       42703-ing on an older database; the two columns that CAN (M2's per-type paid dates, M7's
       property_address) stay in their own small queries underneath, exactly as before. */
    /* R9-2 — plus review_requested_at, which the advocacy panel's monthly series falls back to
       when the database records no date for when a score came BACK. It is an original-schema
       column (the review drip has stamped it since round 5), so it cannot 42703 this select. */
    /* R12b · W-15c — plus `rate_percent`, the third input the "£X/mo more" estimate needs (the
       other two ride in loadCaseCallPack's own query). It is an ORIGINAL-schema column — the case
       form, the pipeline table and the CSV export have all selected it since day one — so, like
       the five R7 widened this select by, it cannot start 42703-ing an older database. */
    /* R19 — plus `offer_issued_date`, the fourth pipeline milestone date the Pipeline MI section
       reads (created_at → submitted_at → offer_issued_date → completed_at) for its conversion funnel
       and velocity. It is an R13 date column, present in prod (like submitted_at beside it), so it
       cannot 42703 this select on the current database; on an older one it simply comes back
       undefined and the MI conversion/velocity fall back to the milestones that ARE populated. */
    /* R80 · B1 — plus `referral_requested_at`, half of the "has this client ever been asked for a
       referral" answer the promoters block needs (the other half is the email_queue read added to
       this Promise.all below). A real production column — it stamps when a referral request queues
       (CTO-verified, like review_requested_at beside it) — so it cannot 42703 this select. */
    readAll(db.from("cases").select("id,client_id,stage,case_kind,lender,loan_amount,broker_fee,proc_fee,sols_fee,submitted_at,offer_issued_date,fee_status,fee_paid_at,completed_at,created_at,updated_at,rate_percent,rate_end_date,rate_end_estimated,lead_source,introducer_id,protection_status,retention_source_case_id,assigned_to,nps_score,review_requested_at,referral_requested_at,expected_completion_date,clients!client_id(first_name,last_name)")
      .order("id"), { cap: REPORTS_ROW_CAP }),
    db.from("introducers").select("id,name"),
    db.rpc("get_reports"),
    // M2 columns in their OWN query, so an un-migrated database (42703 on the whole select) costs
    // the losses panel and the per-type cash dates, not the entire Reports page.
    loadCaseExtraColumns(),
    loadLostDates(),
    // R7 — M7's property column, for the same reason: without it the rate-end ledger cannot
    // collapse two cases on one building, and says so on the panel rather than failing to render.
    loadCasePropColumn(),
    /* R7-5 — the leads themselves, for the Lead-response panel. select("*") ON PURPOSE: naming
       first_contact_at would 42703 the whole query on a database that has not taken the lead-SLA
       migration, and this way the columns are simply absent and the panel says so. Unfiltered by
       date because the "breaching now" count has to see an enquiry that has been sitting there
       since before the 90-day window; the window is applied to the statistics client-side. */
    db.from("leads").select("*").order("created_at", { ascending: false }).limit(LEAD_RESP_ROW_CAP)
      .then((r) => r).catch(() => ({ data: [], error: true })),
    /* R9-2 — the three reads the advocacy panel needs, each in its own small query for exactly the
       reason M2's and M7's are: a database without m11 (or without a score-capture date, or with
       case_tasks locked down by RLS) loses one BLOCK of that panel and says so, rather than
       taking the whole Reports page down with it. */
    loadReferrerColumn(REPORTS_ROW_CAP),
    loadAdvScoreDates(REPORTS_ROW_CAP),
    loadDetractorTasks(),
    /* R9-6 — and m10's solicitor column, in its own query for exactly the same reason: without the
       migration the conveyancer panel says so and every other panel on the page is unaffected. */
    loadSolicitorColumn(REPORTS_ROW_CAP),
    /* R12b · W-15c — and the call-pack columns, same discipline again. */
    loadCaseCallPack(),
    /* R80 · B1 — the three small reads the "Promoters never asked" list needs. The email_queue
       read is half of the membership truth: a client with any non-cancelled referral_request row
       has been asked, whatever became of the send (the other half — referral_requested_at — rides
       on the widened cases select above, because a stamp with no queue row behind it still means
       somebody asked once). The ERROR is kept, not swallowed: an unreadable queue means "who has
       been asked is unknown", and a list rendered over that unknown would over-ask — the block
       says so instead of guessing. */
    readAll(db.from("email_queue").select("client_id,status").eq("email_type", "referral_request").neq("status", "cancelled").order("id")),
    /* R80 · B1 — who has opted out (R79's comms_optout). Soft: on a database without the
       column no row is flagged, and v19's send-time opt-out gate (plus advPromoAsk's own
       pre-flight) remains the backstop for the four marketing-adjacent types. */
    db.from("clients").select("id").eq("comms_optout", true).then((r) => r).catch(() => ({ data: null, error: true })),
    /* R80 · B1 — who HAS an email address, so the queue verb can be withheld from a row it
       could only fail on (queueEmail refuses a no-email client anyway; hiding the button is the
       honest rendering of that refusal). Base-schema columns only — this cannot 42703. */
    readAll(db.from("clients").select("id,email").order("id")),
  ]);
  const all = cases || [];
  noteRowCap("cases", cases);
  renderCapNotice();
  // Merge the feature-detected columns onto the rows. Where the migration hasn't run these stay
  // undefined and every consumer falls back: feeCashDate → fee_paid_at, lost_reason → "(not
  // recorded)".
  if (extraCols) all.forEach((c) => { const x = extraCols[c.id]; if (x) Object.assign(c, x); });
  if (propCols) all.forEach((c) => { if (propCols[c.id] !== undefined) c.property_address = propCols[c.id]; });
  if (callPack) all.forEach((c) => { const x = callPack[c.id]; if (x) Object.assign(c, x); });
  lossState.lostAt = lostAt || {};
  // R68 · M7 — `mv` too: the target bar and attach rate on this card follow the month picker,
  // while "My fees banked" stays the calendar year. Both scopes are named on the card.
  renderMyNumbers(all, yr, mv);
  renderMonthReport(all, mv);
  /* R7-1 / R7-2 — the two new money panels, from the same rows the rest of the page uses. Both
     hide themselves for anyone but the Owner (see renderMoneyOwed / renderRateEndBook). */
  renderMoneyOwed(all);
  renderRateEndBook(all);
  /* R7-5 — and the speed-to-lead panel, from the leads read above joined to those same case rows
     for the adviser each accepted lead went to. Owner-only, like the two above it. */
  const leadRows = (leadRes && !leadRes.error && leadRes.data) || [];
  if (leadRows.length) noteLeadSlaFromStarRow(leadRows[0]);
  renderLeadResponse(leadRows, all);
  /* R9-2 — the advocacy dashboard, from those same rows plus its three feature-detected extras.
     Owner-gated inside renderAdvocacy, like every panel above it. */
  if (refCols) all.forEach((c) => { if (refCols[c.id] !== undefined) c.referrer_client_id = refCols[c.id]; });
  /* R80 · B1 — the promoters-list context rides in beside the R9 extras. `referralAsked` is
     null when the queue read failed (the block refuses to render a list that would over-ask);
     `optoutIds` is null when comms_optout is unreadable (no row is flagged); `clientEmails` is
     null when the clients read failed (no queue verb is withheld — queueEmail still refuses). */
  renderAdvocacy(all, {
    referrers: refCols, scoreDates: advDates, detractorTasks: detrTasks,
    referralAsked: (advRefQ && !advRefQ.error) ? new Set((advRefQ.data || []).map((r) => r.client_id).filter(Boolean)) : null,
    optoutIds: (advOptoutRes && !advOptoutRes.error && Array.isArray(advOptoutRes.data)) ? new Set(advOptoutRes.data.map((r) => r.id)) : null,
    clientEmails: (advEmailRes && !advEmailRes.error && Array.isArray(advEmailRes.data)) ? new Map(advEmailRes.data.map((r) => [r.id, r.email || null])) : null,
  });
  /* R9-6 — and the conveyancer-speed panel, from the same rows plus m10's solicitor column.
     Owner-gated inside renderConveyancerSpeed, like every panel above it. */
  if (solCols) all.forEach((c) => { if (solCols[c.id] !== undefined) c.solicitor_firm = solCols[c.id]; });
  renderConveyancerSpeed(all, solCols);
  const activeStages =["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
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
  /* R68 · M7 — the firm tile now reads the shared primitive, so an adviser's own
     "My retention conversion" is the same arithmetic scoped to their cases and the two
     figures can be reconciled rather than argued about. Same numbers as before. */
  const firmRet = retentionConversion(all);
  const rWon = firmRet.won;
  const rLost = firmRet.lost;
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
    /* R37 · item 22 — STATE THE RULE, for the reader it is most confusing to. An admin's Reports
       simply stops where the owner-only money panels begin: they get the Pipeline MI run-rate (an
       aggregate, admin-visible) and then nothing, with no line anywhere saying that the £-detail
       below it exists and is withheld deliberately. That reads as a page that failed to load. The
       sentence is added for ADMIN ONLY — an adviser sees no run-rate at all, so telling them
       "the aggregate run-rate above is the admin view" would be a pointer to a panel that is not
       on their page. Owner sees no note at all, exactly as before. */
    moneyNote.textContent = money ? "" : ("Firm-wide money figures — fees banked and outstanding, pipeline loan value, the adviser scoreboard, the forecast, introducer revenue and client lifetime value — are shown to the Owner only. Case counts, the funnel, completions and lead sources are below, your own numbers are in the My numbers card at the top, and the fees on your own cases are on each case."
      + (MY_ROLE === "admin"
        ? " As an Admin this page ENDS where that £-detail begins, and that is the rule rather than a page that failed to load: Money owed, the commission and completion forecasts, the rate-end book value, introducer revenue and client lifetime value are Owner-only. The aggregate run-rate in Pipeline MI above is the admin view of the firm's money."
        : ""));
  }
  /* R5-F2 (Daniel-approved) — the HEADLINE fee figure for the year is now what the firm EARNED on
     the cases it completed (proc+broker+sols on completed_at), not what happened to arrive in the
     bank. "Fees banked" is not deleted and its arithmetic is untouched — it keeps its tile, its
     basis label and its future-dated footnote, one place further along and marked secondary. */
  const earnedYr = earnedOnCompletion(all, String(yr));
  /* R74 · A2 — the Money-owed panel's OWN model, called here rather than re-derived, so the tile
     and the panel further down this page can never disagree by a penny. Pure arithmetic over rows
     already in hand; no read. */
  const owedNow = moneyOwedModel(all);
  $("#report-kpis").innerHTML = `
    <div class="kpi dq-clickable" onclick="kpiGoto('completed')" title="View completed cases in the pipeline"><div class="num">${completedYr.length}</div><div class="lbl">Completions ${yr}</div></div>
    <div class="kpi dq-clickable" onclick="kpiGoto('active')" title="View the pipeline"><div class="num">${active.length}</div><div class="lbl">Live cases</div></div>
    ${money ? `<div class="kpi dq-clickable" onclick="kpiGoto('active')" title="View the pipeline — loan value of the ${active.length} live cases"><div class="num" title="${esc(fmtM(pipelineValue))}">${fmtM(pipelineValue)}</div><div class="lbl">Pipeline loan value</div></div>` : ""}
    ${money ? `<div class="kpi kpi-headline"><div class="num" title="${esc(fmtM(earnedYr.total))}">${fmtM(earnedYr.total)}</div><div class="lbl">Fees earned ${yr}</div>${basisLine(BASIS_EARNED_YTD + ` — ${earnedYr.n} completion${earnedYr.n === 1 ? "" : "s"}, paid or not`)}</div>
    ${/* R74 · A2 — spans two columns so the two DEBTOR tiles below it start a fresh row and sit
          side by side, which is the whole point of putting them together. It also gives this
          tile's long footnote the width it was wrapping onto three lines without. */ ""}
    <div class="kpi kpi-secondary kpi-wide"><div class="num" title="${esc(fmtM(feesPaidYr))}">${fmtM(feesPaidYr)}</div><div class="lbl">Fees banked ${yr}</div>${basisLine(BASIS_CASH_YTD + (feesPaidYrFutureN ? ` — includes ${fmtM(feesPaidYrFuture)} dated after today (${feesPaidYrFutureN}); ${fmtM(feesPaidYr - feesPaidYrFuture)} actually received` : ""))}</div>
    ${/* R74 · A2 (panel D#2) — THE TWO DEBTOR FIGURES, SIDE BY SIDE, WITH THEIR BASES IN THE LABEL.
          "Fees outstanding £14,270" sat one screen above "Money owed £27,035" and the reader had to
          find an 11px caption on each to discover they count different things. They are not a
          contradiction and neither is wrong: this one is the BROKER fee on every case at any live
          stage that has not been paid; the one beside it is proc + solicitor + broker on cases that
          have COMPLETED. Same arithmetic as before on both — moneyOwedModel is the Money-owed
          panel's own model, reused rather than re-derived — but the basis now lives in the label,
          where it is read, instead of under it, where it was not. */ ""}
    <div class="kpi dq-clickable ${feesOutstanding ? "warn" : ""}" onclick="kpiGoto('fees')" title="Broker fees on cases at ANY stage with no payment recorded — fee_status “not requested” or “requested”. Not proceeding is excluded. View the Protection &amp; Fees drawer — Fees due tab."><div class="num" title="${esc(fmtM(feesOutstanding))}">${fmtM(feesOutstanding)}</div><div class="lbl">Broker fees outstanding (all stages)</div>${basisLine(`(broker only · not yet received · ${fmtM(feesInvoiced)} invoiced + ${fmtM(feesNotInvoiced)} not yet invoiced)`)}</div>
    <div class="kpi dq-clickable ${owedNow.grand ? "warn" : ""}" id="report-kpi-owed" onclick="gotoMoneyOwed()" title="Procuration, solicitor and broker fees on cases that have COMPLETED and carry no paid date — the money the firm has earned and not been paid. A wider set of fee types than the tile beside it, over a narrower set of cases. Opens the Money owed panel below."><div class="num" title="${esc(fmtM(owedNow.grand))}">${fmtM(owedNow.grand)}</div><div class="lbl">Owed on completed cases</div>${basisLine(`(proc + sols + broker · earned, not yet received · ${owedNow.n} completed case${owedNow.n === 1 ? "" : "s"})`)}</div>` : ""}
    <div class="kpi"><div class="num">${rWon + rLost ? Math.round((rWon / (rWon + rLost)) * 100) + "%" : "—"}</div><div class="lbl">Retention conversion</div></div>
    <div class="kpi"><div class="num">${completedYr.length ? Math.round((protDone / completedYr.length) * 100) + "%" : "—"}</div><div class="lbl">Protection uptake ${yr}</div></div>
    <div class="kpi ${scored.length ? "dq-clickable" : ""}" ${scored.length ? `id="report-nps-tile" onclick="toggleNpsList()" title="List every case that returned a review score"` : ""}><div class="num">${scored.length ? avgNps.toFixed(1) : "—"}</div><div class="lbl">Avg review score (${scored.length})${promoterPct != null ? ` · ${promoterPct}% promoters` : ""}${scored.length ? " ▾" : ""}</div></div>`;
  activateAll("#report-kpis .kpi.dq-clickable");   // R73 · B1 — same gesture as the other three
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
        .map(([k, v]) => `<tr><td><button type="button" class="linkish" onclick="reportGotoSearch('${jsArg(k)}')" title="Open the pipeline filtered to ${esc(k)}">${esc(k)}</button></td><td>${v.total}</td><td>${v.live}</td><td>${v.done}</td><td>${convCell(v.done, v.lost)}</td><td>${fmtD(v.last)}</td>${money ? `<td class="num">${fmtM(v.revenue)}</td>` : ""}</tr>`).join("") + `</table>`
      // R5-17 — the Revenue basis sits UNDER the table rather than in the column head: this panel
      // shares a two-column grid with the completions chart, and a long unwrapping heading sets
      // the table's min-content width, which squeezes the chart beside it to a sliver.
      + (money ? `<p class="panel-sub" style="margin:8px 0 0;">Revenue ${esc(BASIS_INTRO_REV)} — fee value on this introducer's completed cases, whether or not it has been paid.</p>` : "")
    : '<div class="empty">No cases assigned to introducers yet.</div>';

  const rep = repRes && !repRes.error ? repRes.data : null;
  renderThreadedPanels(all, mv, rep ? rep.advisers : null);
  /* R72 · A1 — the adoption strip inside the scoreboard panel renderThreadedPanels has just
     painted. NOT awaited, for the same reason the ops strip on Today is not: it owns two reads of
     its own and a strip arriving 200ms after the table above it is still a strip. It gates itself
     on showMoney(), so for an admin or an adviser this is one function call and no query. */
  renderAdoptionStrip();
  /* R19 — the OWNER/ADMIN Pipeline MI section, from the same `all` rows plus the two milestone
     dates in the select above. Gated inside (isAdminOrOwner); hidden for plain advisers. */
  renderPipelineMI(all, mv);
  /* R21 Part C / R33 — the diagnostics panel used to render from here, off the `all` count in
     scope. It now lives on Settings (renderSettings → renderDiagnostics(null)): it is a support
     artefact, not management information, and it was costing every owner a scroll past it on
     every Reports read. Nothing else about it changed. */
  renderForecastBuckets(all);
  /* R77 · A4 — the business-mix table, from the same rows (the Reports select has always carried
     case_kind) and the same yr basis as the KPI tiles above. Owner-gated inside. */
  renderBusinessMix(all, yr);
  // Client LTV is the one remaining RPC-only panel (needs client_id/name joins this page doesn't
  // otherwise fetch) — hide it gracefully if the RPC failed; everything else above still renders.
  renderReportExtras(rep);
  /* R66 · M6b — §6, the referrals-out ledger. AWAITED, unlike every renderer above it, because it
     owns two reads of its own (the month's referrals and one inChunks resolve of the cases they
     point at) and the two nav builders below have to see the panel it produces. `all` is passed so
     a case already on this page — property column merged and client embedded — is never re-read. */
  await renderReferralsOut(all, mv);
  /* R77 · B1 — §5's appointment-outcomes panel. AWAITED for the same reason renderReferralsOut
     is: it owns one bounded read of its own (90 days of appointments), and the two nav builders
     below must see whether the panel exists before they draw its chip. Gates itself on
     showMoney(), so for an adviser this is one function call and no query. */
  await renderApptOutcomes();
  /* R11-4 — LAST, deliberately. Every panel above has just decided whether it exists for this
     role and this data, and the jump bar is built by READING those decisions rather than by
     re-deriving them: one gate, not seventeen copies of one, so a money panel and its chip can
     never disagree. */
  /* R42 · F3 — and on the same terms, for the same reason: the five section buttons ask the panels
     that have just rendered whether anything under each header exists for this role, and the six
     ledger drawers take their row counts off rows that are already on the page.
     R74 · A4c — the SECTIONS are built FIRST now: the chip strip below them is scoped to the
     selected section, so it cannot be built until the sections have decided which of them exist. */
  buildReportSectionNav();
  buildReportsJumpNav();
  buildReportLedgerCounts();
  /* R69 · B3/L8 — and LAST of all, once every panel above has put its table on the page. */
  watchReportTables();
  syncNumHeaders("#page-reports");      // R73 · B4 — after every panel has rendered
}

/* ==========================================================================
   R69 · B3/L8 — EVERY TABLE ON REPORTS SCROLLS INSIDE ITS OWN BOX.

   Measured at 390×844 as p4: eighteen tables on this page, twelve of them wider
   than the 332px column they sit in — the adviser table 1284px, Money owed
   1166px, the rate-end book 806px, the MI scoreboard 565px. Their panels are
   plain <div>s with overflow visible, and `html, body { overflow-x: clip }` (the
   M1 viewport containment) then CLIPS the overflow rather than scrolling it. So
   the last four columns of the scoreboard did not exist on a phone: no scrollbar,
   no cut-off cue, no way to reach them at all. That is worse than a wide page —
   a wide page at least tells you it is wide.

   Every <table> under #page-reports is put inside a .table-scroll (overflow-x:
   auto, touch momentum, and a right-edge fade that is painted by the container's
   own background and therefore disappears by itself once you reach the end —
   see admin.css). Done in the DOM rather than in eighteen template strings
   because half of these panels re-render on their own (the month picker, the
   adviser drill-down, the ledger drawers) and a wrapper written into one
   template would be wiped by the next innerHTML: a MutationObserver on the page
   re-wraps whatever appears, so a panel added in a later round is covered on the
   day it is written. The observer is installed once, does one pass per tick, and
   its own wrapping is a no-op on the second pass, so it cannot loop.
   ========================================================================== */
let reportTablesObs = null;
function wrapReportTables() {
  const pg = document.getElementById("page-reports");
  if (!pg) return;
  pg.querySelectorAll("table").forEach((t) => {
    const p = t.parentNode;
    if (!p || !p.classList || p.classList.contains("table-scroll")) return;
    const box = document.createElement("div");
    box.className = "table-scroll";
    p.insertBefore(box, t);
    box.appendChild(t);
  });
}
function watchReportTables() {
  const pg = document.getElementById("page-reports");
  if (!pg) return;
  if (!reportTablesObs && typeof MutationObserver === "function") {
    let queued = false;
    reportTablesObs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; wrapReportTables(); }, 0);
    });
    reportTablesObs.observe(pg, { childList: true, subtree: true });
  }
  wrapReportTables();
}

/* ==========================================================================
   R11-4 — THE REPORTS JUMP NAV.

   Reports is one page about sixteen different questions, stacked, roughly
   7,700px tall on an Owner's screen. The only navigation it had was the scroll
   wheel, so "what is the rate-end book worth" meant six seconds of scrolling
   past four panels about something else, every time.

   Three decisions worth stating:

   · THE CHIP LIST IS READ, NOT DECLARED. Half these panels are Owner-only and
     each one already owns its own gate (showMoney() inside renderMoneyOwed,
     renderRateEndBook, renderLeadResponse, renderAdvocacy, …). Re-testing the
     role here would be a second copy of the gate that could drift from the
     first, which is exactly how a money chip leaks to an adviser. So the bar
     is built at the END of loadReports and simply asks each target element
     whether it — or anything it sits inside — is .hidden. An adviser's bar has
     no chip for a panel an adviser has no panel for, because the panel said so.

   · IT IS BUILT ONCE THE ANSWER IS KNOWN. The markup ships EMPTY and `hidden`;
     nothing is rendered before role and data are in hand, so there is no
     moment where a money chip is on screen and then withdrawn.

   · HIGHLIGHTING IS A SCROLL LISTENER, NOT AN OBSERVER. rAF-throttled, one
     getBoundingClientRect per visible section per frame that actually scrolls,
     and it returns immediately when Reports is not the open page. An
     IntersectionObserver would need a rootMargin recomputed from the sticky
     bar's own measured height anyway, and would still have to break ties
     between the several panels visible at once on a laptop.
   ========================================================================== */
const REPORT_JUMP_SECTIONS = [
  ["mine", "My numbers", "#report-mine-panel"],
  ["month", "Monthly business", "#report-month-panel"],
  ["advisers", "Adviser scoreboard", "#report-scoreboard-panel"],
  ["mi", "Pipeline MI", "#report-mi-funnel-panel"],
  ["mivelocity", "Velocity", "#report-mi-velocity-panel"],
  ["mirevenue", "Run-rate", "#report-mi-revenue-panel"],
  ["miboard", "MI scoreboard", "#report-mi-scoreboard-panel"],
  ["funnel", "Funnel", "#report-funnel-panel"],
  ["sources", "Lead sources", "#report-sources-panel"],
  ["losses", "Losses", "#report-losses-panel"],
  ["live", "Live snapshot", "#report-live-note"],
  ["owed", "Money owed", "#report-owed-panel"],
  ["rateend", "Rate-end book", "#report-rateend-panel"],
  ["forecast", "Forecast", "#report-forecast-panel"],
  ["mix", "Business mix", "#report-mix-panel"],   // R77 · A4 — sits after the forecast in the DOM
  ["months", "Completions", "#report-months-panel"],
  ["introducers", "Introducers", "#report-introducers-panel"],
  ["ltv", "Client LTV", "#report-ltv-panel"],
  /* R42 · F3 — lead response, advocacy and conveyancers moved BELOW the money panels when Reports
     was grouped into its five sections (they are §5 Service & quality; the money panels are §4).
     This list is re-ordered to match, and that is not cosmetic: onRepJumpScroll() walks it in order
     and BREAKS at the first section below the fold line, so a list in a different order from the
     DOM stops highlighting at the first entry that has moved — every chip below it would have gone
     dead. Keep this array in DOM order. Keys, labels and chip ids are unchanged. */
  ["leadresp", "Lead response", "#report-leadresp-panel"],
  ["advocacy", "Advocacy", "#report-advocacy-panel"],
  ["conveyancer", "Conveyancers", "#report-conveyancer-panel"],
  // R77 · B1 — in DOM order (the panel sits after conveyancers, closing §5), per the note above.
  ["apptoutcomes", "Appointments", "#report-outcomes-panel"],
  // R66 · M6b — last in the DOM, therefore last here (see the DOM-order note above).
  ["referralsout", "Referrals out", "#report-referrals-panel"],
];
/* Visible = on the page AND not inside anything hidden. The .grid-2 wrappers mean a panel's own
   class is not the whole answer, so walk up to the page section. */
function repJumpVisible(el) {
  let n = el;
  while (n && n.id !== "page-reports") {
    if (n.classList && n.classList.contains("hidden")) return false;
    n = n.parentElement;
  }
  return !!n;
}
/* The gap a jumped-to heading is left sitting below the bar, and — because they must be the same
   number — the line the highlighter measures "is this section at the top of the screen" against.
   With two different constants a chip you had just clicked could arrive one pixel short of its own
   threshold and light up the section ABOVE it, which is how a jump nav ends up looking broken. */
const REP_JUMP_GAP = 12;
let repJumpItems = [];
let repJumpActive = "";
let repJumpTick = false;
let repJumpWired = false;
/* ==========================================================================
   R74 · A4c (panel D#6) — THE LEVEL-2 STRIP SHOWS ONE SECTION'S PANELS.

   Reports carries two strips: five or six SECTION pills, and one chip per
   PANEL. The panel strip listed all twenty at once, so on a 1,160px laptop
   fourteen of them lived off the right-hand edge behind a chevron, and the two
   strips answered the same question at two different resolutions with no
   relationship between them.

   The section pills are now a real control: picking one scopes the chip strip
   below it to that section's own panels (four to six — no overflow at any
   width this app supports), and SCROLLING re-picks it, so the strip always
   describes where the reader is. Both strips stay stuck to the top while you
   move, because a level-1 control that scrolls away the moment you use it is
   the thing being fixed.

   Membership is DERIVED, not declared twice: a panel belongs to the last
   `.report-section-head` that precedes it in the document. REPORT_SECTIONS
   already declares which panels sit under which head for the gating walk, and
   a second hand-maintained copy of that mapping is how a chip ends up in the
   wrong section after a panel moves.
   ========================================================================== */
let repSectionActive = "";
let repSectionItems = [];       // the live level-1 sections, in DOM order
/* Which section an element sits in: the last live section head at or before it in the DOM.
   compareDocumentPosition rather than offsetTop, so it is a structural answer and cannot be
   thrown by a panel that has not laid out yet. */
function repSectionOfEl(el) {
  if (!el) return "";
  let cur = "";
  for (const s of repSectionItems) {
    if (!s.head) continue;
    // FOLLOWING = s.head comes after el in document order → we have gone past it.
    if (s.head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) cur = s.key;
    else break;
  }
  return cur || (repSectionItems[0] && repSectionItems[0].key) || "";
}
function buildReportsJumpNav() {
  /* R78 · A4 — through the shared builder. What stays here is Reports' own: the R74 · A4c
     section scoping (filterItems), the guard on the PAGE's items rather than the scoped strip
     (guardOn:"all" — a one-panel section keeps its single chip and the sticky bar its height),
     and the jump-settle stamp the scroll-spy respects. scroll-margin-top (set from the measured
     bar height below) is still what stops the sticky bar landing on the heading it just took
     you to. */
  const built = buildJumpNav("rep-nav", "rep-nav-chips", REPORT_JUMP_SECTIONS, repJumpVisible, {
    attr: "data-rep-jump", chipIdPrefix: "rep-nav-", guardOn: "all",
    filterItems: (allItems) => {
      allItems.forEach((s) => { s.section = repSectionOfEl(s.el); });
      /* A section the reader picked that no longer exists (role change, a panel that went hidden)
         falls back to the first live one rather than emptying the strip. */
      if (!repSectionItems.some((x) => x.key === repSectionActive)) repSectionActive = (repSectionItems[0] || {}).key || "";
      return allItems.filter((s) => !repSectionActive || s.section === repSectionActive);
    },
    beforeJump: () => { repJumpUntil = Date.now() + REP_JUMP_SETTLE_MS; },   // R74 · A4c — see onRepJumpScroll
    setActive: setRepJumpActive,
  });
  repJumpItems = built ? built.items : [];
  if (!built) return;
  repJumpActive = "";                 // the chips are new elements — nothing is active yet
  measureRepJumpOffsets();
  if (!repJumpWired) {
    repJumpWired = true;
    window.addEventListener("scroll", onRepJumpScroll, { passive: true });
    window.addEventListener("resize", () => { measureRepJumpOffsets(); onRepJumpScroll(); }, { passive: true });
  }
  onRepJumpScroll();
}
/* The sticky offset is not a constant: at =<760px .app-shell stacks and the sidebar becomes a
   sticky strip across the top, so the jump bar has to sit under it. Measured from the layout that
   is actually in force rather than from a duplicated breakpoint number. */
function measureRepJumpOffsets() {
  const bar = $("#rep-nav"), page = $("#page-reports");
  // A resize while another page is open would measure a bar of height 0 and leave every heading on
  // Reports with a 12px scroll margin. Nothing to measure until Reports is the page on screen.
  if (!bar || bar.hidden || !page || page.classList.contains("hidden")) return;
  const shell = document.querySelector(".app-shell");
  const side = document.querySelector(".sidebar");
  let off = 0;
  try {
    if (shell && side && getComputedStyle(shell).flexDirection === "column") off = Math.round(side.getBoundingClientRect().height);
  } catch (_) { off = 0; }
  /* R74 · A4c — TWO sticky strips now, stacked: sections on top, the section's panels under it.
     Both offsets come from the same measurement pass, so the pair can never overlap.
     R73-HF1's rule holds: nothing is written from an unguarded measurement — the section strip is
     only measured (and only given a top) while it is actually on the page and not hidden. */
  const sec = $("#reports-jump");
  let secH = 0;
  if (sec && !sec.hidden) {
    sec.style.top = off + "px";
    secH = Math.round(sec.getBoundingClientRect().height);
  }
  bar.style.top = (off + secH) + "px";
  const h = Math.round(bar.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--rep-jump-scroll", (off + secH + h + REP_JUMP_GAP) + "px");
  // Only fade the right edge when there is genuinely more strip out there to scroll to.
  // R73 · A5 — the fade AND the chevron, both decided by the same measurement, and both switched
  // off once the strip is at its right-hand end.
  wireChipStripOverflow("rep-nav", "rep-nav-chips");
}
function setRepJumpActive(key) {
  if (key === repJumpActive) return;
  repJumpActive = key;
  jumpNavActivePaint("rep-nav-chips", "data-rep-jump", "rep-nav-", key);   // R78 · A4
}
function onRepJumpScroll() {
  if (repJumpTick) return;
  repJumpTick = true;
  requestAnimationFrame(() => {
    repJumpTick = false;
    const page = $("#page-reports"), bar = $("#rep-nav");
    if (!page || page.classList.contains("hidden") || !bar || bar.hidden || !repJumpItems.length) return;
    const line = bar.getBoundingClientRect().bottom + REP_JUMP_GAP + 2;
    /* R74 · A4c — the SECTION follows the reader too. Scrolling out of "This month" and into
       "Money & book" re-scopes the chip strip, so it never describes a part of the page that is
       no longer on screen. Same walk, same threshold line, over the section heads.
       …EXCEPT while a jump this control started is still in flight. scrollIntoView({behavior:
       "smooth"}) travels through every section between here and there, and a spy that re-picked on
       the way would repaint the strip four times and land wherever the animation happened to be
       when it stopped. The jump names its destination; the spy stands aside until it arrives. */
    if (repJumpUntil > Date.now()) return;
    if (repSectionItems.length > 1) {
      let secNow = repSectionItems[0].key;
      for (const s of repSectionItems) {
        if (s.head && s.head.getBoundingClientRect().top <= line) secNow = s.key; else break;
      }
      if (secNow !== repSectionActive) { repSetSection(secNow); return; }
    }
    let cur = repJumpItems[0].key;
    for (const s of repJumpItems) {
      if (s.el && s.el.getBoundingClientRect().top <= line) cur = s.key; else break;
    }
    /* At the very bottom of the page the last panel may never reach the line (it is shorter than
       the viewport), which would leave the second-to-last chip lit on a page that has stopped
       scrolling. Bottom of the document means the last section. */
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) cur = repJumpItems[repJumpItems.length - 1].key;
    setRepJumpActive(cur);
  });
}

/* ==========================================================================
   R42 · F3 — REPORTS SECTIONS.

   Reports answers five questions — my numbers, this month, where the work is,
   where the money is, how well we are serving people — and it had been
   answering them in one flat 7,700px stack of seventeen panels. The panels have
   MOVED into those five groups (ids, gates and render code all untouched); each
   group carries a slim <h3 class="report-section-head" id="rsec-*"> and one
   button in #reports-jump.

   THE SECTIONS DO NOT COLLAPSE. This is grouping and wayfinding. Anything a
   role can see, it still sees on arrival.

   THE ROLE RULE IS THE ONE R11-4 ESTABLISHED AND IS NOT COPIED: every panel
   already owns its own gate, so a section asks its PANELS whether any of them
   is visible (repJumpVisible, the same walk the chip bar uses) rather than
   re-testing MY_ROLE here — which is how a money button leaks to an adviser.
   A section with nothing visible under it loses its button AND its header: an
   empty "Money & book" heading is worse than no heading at all.

   The membership list below is declared, unlike #rep-nav's chip list, because
   the page is flat markup: a section is a header plus the panels that follow
   it, and there is no wrapper element to ask. Keep it in DOM order — the nav
   reads top to bottom.
   ========================================================================== */
const REPORT_SECTIONS = [
  ["mine", "My numbers", "#rsec-mine", ["#report-mine-panel"]],
  ["month", "This month", "#rsec-month", ["#report-month-panel", "#report-scoreboard-panel"]],
  ["mi", "Pipeline MI", "#rsec-mi", ["#report-mi-section", "#report-funnel-panel", "#report-sources-panel", "#report-losses-panel"]],
  ["money", "Money & book", "#rsec-money", ["#report-kpis", "#report-owed-panel", "#report-rateend-panel", "#report-forecast-panel", "#report-mix-panel", "#report-months-panel", "#report-introducers-panel", "#report-ltv-panel"]],   // R77 · A4 — mix panel joins its section
  // R77 · B1 — "#report-outcomes-panel" appended (agent B's only entry in this list).
  ["quality", "Service & quality", "#rsec-quality", ["#report-leadresp-panel", "#report-nps-panel", "#report-advocacy-panel", "#report-conveyancer-panel", "#report-outcomes-panel"]],
  /* R66 · M6b — §6. The sixth question this page answers: what did we send OUT, and to whom. One
     panel, visible to every staff role (no money on it), so unlike §4 and §5 this section is never
     empty for anybody — but it still goes through the same repJumpVisible walk as the other five
     rather than being special-cased, because that walk is the ONE gate. */
  ["referrals", "Referrals out", "#rsec-referrals", ["#report-referrals-panel"]],
];
function buildReportSectionNav() {
  const bar = $("#reports-jump"), wrap = $("#reports-jump-chips");
  if (!bar || !wrap) return;
  const live = REPORT_SECTIONS.map(([key, label, headSel, panels]) => {
    const head = $(headSel);
    const on = panels.some((sel) => { const el = $(sel); return el && repJumpVisible(el); });
    // The header goes with the button — one decision, applied to both.
    if (head) head.classList.toggle("hidden", !on);
    return { key, label, head, on };
  }).filter((s) => s.head && s.on);
  // One button is not navigation, it is decoration — the same guard #rep-nav uses.
  if (live.length < 2) { wrap.innerHTML = ""; bar.hidden = true; return; }
  /* R74 · A4c — these pills SELECT as well as jump: the chip strip below is scoped to the chosen
     section. aria-selected is now a live state rather than a permanent "false". */
  repSectionItems = live;
  if (!live.some((x) => x.key === repSectionActive)) repSectionActive = live[0].key;
  wrap.innerHTML = live.map((s) =>
    `<button type="button" class="seg-btn${s.key === repSectionActive ? " active" : ""}" id="reports-nav-${esc(s.key)}" role="tab" aria-selected="${s.key === repSectionActive}" data-reports-jump="${esc(s.key)}" title="Show the ${esc(s.label)} panels and jump to them">${esc(s.label)}</button>`).join("");
  wrap.querySelectorAll("[data-reports-jump]").forEach((b) => (b.onclick = () => {
    const it = live.find((s) => s.key === b.dataset.reportsJump);
    if (!it) return;
    repSetSection(it.key);
    repJumpUntil = Date.now() + REP_JUMP_SETTLE_MS;
    // scroll-margin-top on .report-section-head (--rep-jump-scroll, measured) is what stops the
    // sticky strips landing on top of the header this just took you to.
    if (it.head) it.head.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  bar.hidden = false;
  /* R73 · A5 — this strip had NO overflow affordance at all, not even the fade #rep-nav has:
     five section buttons fit a laptop and do not fit a phone, and the ones off the edge were
     invisible and un-guessable. Same control as the other two strips. */
  wireChipStripOverflow("reports-jump", "reports-jump-chips");
}
/* R74 · A4c — pick a section: repaint the pills, rebuild the chip strip beneath them to that
   section's panels only, and re-measure (a strip of 5 chips is a different height from one of 20
   once it stops wrapping). Does NOT scroll — the callers decide whether this is a jump or a
   scroll-spy correction, and a spy that scrolled would fight the scroll that triggered it. */
/* How long a programmatic jump owns the section choice. Long enough for a smooth scroll across
   the whole page, short enough that a reader who grabs the wheel mid-flight gets the spy back. */
const REP_JUMP_SETTLE_MS = 900;
let repJumpUntil = 0;
function repSetSection(key, opts) {
  if (!key || key === repSectionActive) return;
  repSectionActive = key;
  document.querySelectorAll("#reports-jump-chips [data-reports-jump]").forEach((b) => {
    const on = b.dataset.reportsJump === key;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  buildReportsJumpNav();
  if (!(opts && opts.quiet)) measureRepJumpOffsets();
}
/* R74 · A4c — THE DEEP-LINK DOOR. Anything that takes the reader straight to a Reports panel —
   the Watchtower's "Money owed →", a KPI tile, a future palette verb — goes through here, because
   scrolling to a panel whose SECTION is not the selected one would leave the chip strip describing
   somewhere else entirely. Switch the section first, then scroll. Safe to call before Reports has
   finished rendering: the section list is empty until buildReportSectionNav runs, and the scroll
   is guarded on the panel being both present and visible, exactly as it was before. */
window.repRevealPanel = function (sel) {
  const p = $(sel);
  if (!p || p.classList.contains("hidden") || !repJumpVisible(p)) return false;
  const key = repSectionOfEl(p);
  if (key) { repSetSection(key); setRepJumpActive(""); }
  repJumpUntil = Date.now() + REP_JUMP_SETTLE_MS;
  p.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
};

/* R42 · F3 — LEDGER DRAWERS. Six Reports panels lead with a figure and then print a table of
   every row behind it. The figure is the answer; the table is the evidence, wanted on the day you
   act on it. Each row-listing div is now inside a <details class="report-ledger"> (markup only —
   the ids live on inside it and every render function still writes into them unchanged), closed
   by default, with nothing persisted: a drawer that remembers is a drawer that surprises.

   The count is appended here rather than baked into each renderer, because it is the same fact in
   six places and it is FREE: the rows are already in the DOM by the time this runs. Per-panel row
   selectors, not one generic "count the <tr>s", because "every unpaid fee line" and "the 24-month
   table" are counting different things and a total-row or a header would be counted as evidence. */
const REPORT_LEDGERS = [
  ["#report-owed-table", ".owed-case-row", "line"],
  ["#report-rateend-table", "tr.rb-bucket-row", "bucket"],
  ["#report-nps-list", ".nps-row", "respondent"],
  ["#report-ltv", "table tr + tr", "client"],
  ["#report-conveyancer-body", "tr[data-firm]", "firm"],
  ["#report-introducers", "table tr + tr", "introducer"],
  // R66 · M6b — the referral rows only; the header and the "…and N more" line are not evidence.
  ["#report-ref-list", "tr.refout-row", "referral"],
];
function buildReportLedgerCounts() {
  REPORT_LEDGERS.forEach(([sel, rowSel, noun]) => {
    const box = $(sel);
    if (!box) return;
    const det = box.closest("details.report-ledger");
    const out = det && det.querySelector(".ledger-n");
    if (!out) return;
    const n = box.querySelectorAll(rowSel).length;
    // No count at all rather than "0 lines": the panel's own empty state is inside the drawer and
    // says it better than a zero on the handle would.
    out.textContent = n ? ` — ${n} ${noun}${n === 1 ? "" : "s"}` : "";
  });
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
  /* R42 · F3 — the list is inside a .report-ledger drawer like every other Reports row-listing, and
     that drawer ships closed. This panel is the one case where the drawer must not stay closed on
     arrival: the whole panel is already opt-in — you get here by pressing "Avg review score ▾",
     which IS the request to read the respondents — so revealing the panel and then making you open
     a second disclosure inside it would be a drawer guarding a drawer. Opened here, not defaulted
     open in the markup, so the "closed by default, nothing persisted" rule still holds. */
  const det = $("#report-nps-list") && $("#report-nps-list").closest("details.report-ledger");
  if (det) det.open = npsListOpen;
  if (npsListOpen && panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
};

/* ==========================================================================
   R9-2 · THE ADVOCACY DASHBOARD  (Reports, Owner-only)

   Five blocks, five separate honest empty states, one shared set of rows —
   the same `all` array the rest of Reports is computed from, so a figure here
   can be reconciled against the figure it came from rather than argued with.

   THE SUPPRESSION RULE IS ROUND 3's, VERBATIM. Below five scored cases an
   adviser's average is shown but marked (n<5) and greyed, exactly the way
   convCell() has marked thin conversion rates since T1-20 — because at n=2 a
   league table produces a 10.0 and a 4.0 with equal confidence and someone
   reads it as a performance difference. Five is the boundary: n=4 is marked,
   n=5 is not. Nothing is HIDDEN by the rule — an adviser with one furious
   client is exactly who an owner needs to see — it is labelled.

   THE MONEY OBEYS THE OWNER RULE. "Converted value" on the top-referrer table
   is fee value, so it is behind showMoney() as well as behind the panel's own
   owner gate: two independent checks, because a money column that leaks is
   the one mistake on this page that cannot be taken back. The referral COUNTS
   are not money and would be safe to show more widely — they are inside the
   owner panel only because the panel is one panel.

   AND THE DATES ARE HONEST ABOUT THEMSELVES. There is no column recording
   when a score CAME BACK unless the review-capture migration added one, so
   the monthly series says which date it is actually counting on — the capture
   stamp where it exists, the request stamp where it does not — rather than
   quietly presenting "when we asked" as "when they answered".
   ========================================================================== */
const ADV_MIN_N = 5;                 // the round-3 conversion boundary, reused
const ADV_TOP_REFERRERS = 10;
const ADV_SERIES_MONTHS = 6;
/* The score on a case, whichever of the two names the column carries. `nps_score` is what this
   schema has always called it; `review_score` is the name the round-9 brief uses. Reading both
   costs one `??` and means the dashboard cannot be silently emptied by a rename. */
const caseReviewScore = (c) => {
  const v = c && (c.review_score != null ? c.review_score : c.nps_score);
  return v == null || v === "" ? null : Number(v);
};
/* Candidate names for "when the score came back", newest convention first. Probed ONCE against a
   select("*") row (the notePropAddrFromStarRow trick — one query, definitive) rather than five
   speculative selects. Null means the database records no such date and the series falls back. */
const ADV_SCORE_DATE_COLS = ["review_score_at", "review_scored_at", "nps_scored_at", "nps_score_at", "reviewed_at"];
let ADV_SCORE_DATE_COL;              // undefined = not asked yet · null = none · string = the column
async function advScoreDateColumn() {
  if (ADV_SCORE_DATE_COL !== undefined) return ADV_SCORE_DATE_COL;
  ADV_SCORE_DATE_COL = null;
  try {
    const { data, error } = await db.from("cases").select("*").limit(1);
    if (!error && data && data.length) {
      ADV_SCORE_DATE_COL = ADV_SCORE_DATE_COLS.find((k) => Object.prototype.hasOwnProperty.call(data[0], k)) || null;
    }
  } catch (_) { /* stays null — the series falls back and says so */ }
  return ADV_SCORE_DATE_COL;
}
/* One batched read of that column for every case on the page, or null when there is no such
   column. Same shape and same reasoning as loadCasePropColumn. */
async function loadAdvScoreDates(cap) {
  const col = await advScoreDateColumn();
  if (!col) return null;
  try {
    const { data, error } = await db.from("cases").select("id," + col).order("id").limit(cap || REPORTS_ROW_CAP);
    if (error) return null;
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) map[r.id] = r[col] ?? null; });
    return { col, map };
  } catch (_) { return null; }
}
/* The round-3 marking, applied to a mean rather than a percentage. Same class names, same (n<5)
   marker, same "indicative only, not a track record" sentence, so the two tables teach the reader
   one rule instead of two. */
function advScoreCell(scores) {
  const n = scores.length;
  const marker = ' <span class="stat-n">(n&lt;' + ADV_MIN_N + ')</span>';
  if (!n) return `<span class="stat-weak" title="Nobody on this adviser's completed cases has returned a score yet. That is an absence of data, not a bad result.">—${marker}</span>`;
  const avg = scores.reduce((s, x) => s + x, 0) / n;
  const det = scores.filter((x) => x <= 6).length;
  const basis = `Mean of ${n} score${n === 1 ? "" : "s"} returned on this adviser's completed cases, all time${det ? ` · ${det} detractor${det === 1 ? "" : "s"} (6 or below)` : ""}.`;
  return n < ADV_MIN_N
    ? `<span class="stat-weak" title="${esc(basis)} Fewer than ${ADV_MIN_N} scores — indicative only, not a track record.">${avg.toFixed(1)}${marker}</span>`
    : `<span title="${esc(basis)}">${avg.toFixed(1)}</span>`;
}
const ADV_EMPTY = (txt) => `<div class="adv-empty">${txt}</div>`;
/* A tiny bar column — six months of counts. Not sparklineSvg(): that draws a LINE, and a line
   between two months of zero and one month of one implies a trend that three reviews cannot
   support. Bars say "three things happened in March" and nothing more. */
function advMiniSeries(months, counts) {
  const max = Math.max(...counts, 1);
  return `<div class="adv-series">` + months.map((mv, i) => {
    const n = counts[i];
    const h = Math.round((n / max) * 44);
    return `<div class="adv-mon" title="${esc(monthLabel(mv))}: ${n} review${n === 1 ? "" : "s"}">
      <div class="adv-mn">${n || ""}</div>
      <div class="adv-bar" style="height:${Math.max(n ? h : 0, n ? 3 : 0)}px;"></div>
      <div class="adv-mlbl">${esc(MONTH_SHORT[Number(mv.slice(5, 7)) - 1] || mv)}</div>
    </div>`;
  }).join("") + `</div>`;
}
/* ==========================================================================
   R80 · B1 — "PROMOTERS NEVER ASKED" — mine the book for the referral list.

   A client who scored us 9 or 10 said, in a number, that they would recommend
   us — and the firm never asked them to. This block lists exactly those
   people: a case carrying a review score ≥ 9 (caseReviewScore — the ONE
   reading of a score this panel uses) where the client has NEVER had a
   referral request queued.

   "NEVER ASKED" IS READ FROM BOTH RECORDS, AND EITHER ONE DISQUALIFIES:
     · `cases.referral_requested_at` on ANY of the client's cases — the stamp
       queueEmail leaves (this round taught it to; production stamps it when a
       referral request queues), and
     · any email_queue `referral_request` row for the client in any status
       except cancelled — queued, held, sent or failed, the firm has made the
       ask (or is about to).
   When the queue read itself failed the list is NOT rendered — a list built
   over "who has been asked is unknown" would over-ask — and the block says so.

   OPT-OUT MEANS PHONE, NOT SILENCE. A promoter who unsubscribed from
   relationship emails said no to the EMAIL, not to the relationship: their row
   STAYS on the list, flagged, with the call verb only — the queue verb is
   withheld because the send is certain to be cancelled (v19's opt-out gate),
   and the panel says an opted-out promoter can still be asked by phone. A
   promoter with no email address on file gets the same treatment for the same
   mechanical reason.

   The panel's owner-gate is untouched: Advocacy is Owner-only and this block
   renders inside it, sixth after the five R9 blocks.

   THE VERBS ARE EXISTING PATHS wearing this block's ids:
     · ✆ Call task → advPromoCallTask → one case_tasks insert, assigned to the
       case's own adviser, due TOMORROW rolled off a weekend (weekendRollYmd —
       protCallTask's exact shape).
     · ✉ Queue referral request → advPromoAsk → queueEmail(...,
       "referral_request") — the ONE email writer, R79 held honesty and all;
       nothing new composes or sends anything.
     · Open case → openCase, as everywhere.
   ========================================================================== */
function advPromoterModel(all, ctx) {
  const askedQ = ctx && ctx.referralAsked;   // Set of client_ids | null = queue unreadable
  const optout = ctx && ctx.optoutIds;       // Set of client_ids | null = column unreadable
  const emails = ctx && ctx.clientEmails;    // Map client_id → email|null | null = unreadable
  const stamped = new Set();                 // referral_requested_at on ANY case disqualifies
  (all || []).forEach((c) => { if (c.referral_requested_at && c.client_id) stamped.add(c.client_id); });
  const byClient = new Map();                // one row per PERSON — their newest scored ≥9 case
  (all || []).forEach((c) => {
    const s = caseReviewScore(c);
    if (s == null || s < 9 || !c.client_id) return;
    const cur = byClient.get(c.client_id);
    if (!cur || String(c.completed_at || "") > String(cur.completed_at || "")) byClient.set(c.client_id, c);
  });
  const rows = [...byClient.values()];
  const isAsked = (id) => stamped.has(id) || (askedQ && askedQ.has(id));
  const askedN = rows.filter((c) => isAsked(c.client_id)).length;
  const waiting = rows
    .filter((c) => !isAsked(c.client_id))
    .sort((a, b) => caseReviewScore(b) - caseReviewScore(a)
      || String(b.completed_at || "").localeCompare(String(a.completed_at || ""))
      || String(a.id).localeCompare(String(b.id)))
    .map((c) => ({
      c,
      optedOut: !!(optout && optout.has(c.client_id)),
      noEmail: !!(emails && !emails.get(c.client_id)),
    }));
  return { waiting, askedN, askedKnown: !!askedQ, phoneOnlyN: waiting.filter((w) => w.optedOut || w.noEmail).length };
}
function advPromotersBlockHtml(all, ctx) {
  const m = advPromoterModel(all, ctx);
  let body;
  if (!m.askedKnown) {
    /* HONESTY over helpfulness: without the queue, "never asked" cannot be computed. */
    body = `<div class="adv-empty" id="adv-promoters-empty">The email queue could not be read just now, so who has already been asked is unknown — a list shown anyway would ask some of these clients twice. Reload to try again.</div>`;
  } else if (!m.waiting.length) {
    body = `<div class="adv-empty" id="adv-promoters-empty">No promoters are waiting to be asked — ${m.askedN ? "every client who scored 9 or 10 has been asked already" : "no case carries a score of 9 or more yet"}.</div>`;
  } else {
    body = `<div id="adv-promoters-list">` + m.waiting.slice(0, 50).map(({ c, optedOut, noEmail }) => {
      const name = [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ").trim() || "(no name)";
      const s = caseReviewScore(c);
      /* The queue verb is withheld where the send could only be refused: v19 cancels every
         relationship email to an opted-out client, and queueEmail refuses a no-email one. The
         flag says WHY in the row, so a missing button never reads as a rendering fault. */
      const flag = optedOut
        ? ` <span class="badge grey adv-promo-optout" title="This client opted out of relationship emails (a referral request is one of them), so the queue verb is withheld — the send would be cancelled. They said no to the email, not to the relationship: ask on the phone.">opted out — ask by phone</span>`
        : noEmail
          ? ` <span class="badge grey adv-promo-noemail" title="No email address on file, so there is nothing to queue a referral request to — the call is the ask. (Data health's missing-email list is where the address gets fixed.)">no email — ask by phone</span>`
          : "";
      return `<div class="row-item adv-promo-row" data-client="${esc(c.client_id)}" data-case="${esc(c.id)}">
        <div class="row-main">
          <div class="t"><button type="button" class="linkish" onclick="openClient('${jsArg(c.client_id)}')" title="Open this client's record">${esc(name)}</button>${flag}</div>
          <div class="s"><span class="adv-promo-score">${s}/10</span>${c.completed_at ? ` · completed ${fmtD(c.completed_at)}` : " · not completed"}${c.lender ? ` · ${esc(c.lender)}` : ""}${c.assigned_to ? ` · ${esc(staffName(c.assigned_to))}` : ""}</div>
          <div class="ret-row-acts adv-promo-acts">
            <button type="button" class="btn btn-sm ret-row-chip adv-promo-call" onclick="event.stopPropagation();advPromoCallTask('${jsArg(c.id)}')" title="Add a call task on this case — assigned to the case's adviser, due tomorrow (a weekend landing rolls to Monday). A thank-you call is how most referral asks actually happen.">✆ Call task</button>
            ${optedOut || noEmail ? "" : `<button type="button" class="btn btn-sm ret-row-chip adv-promo-ask" onclick="event.stopPropagation();advPromoAsk('${jsArg(c.id)}', event)" title="Queue the house referral-request email for this client — the same writer as every other send, so the hold, the opt-out rule and the unsubscribe footer all apply.">✉ Queue referral request</button>`}
          </div>
        </div>
        <button class="btn btn-sm" onclick="openCase('${jsArg(c.id)}')">Open case</button>
      </div>`;
    }).join("") + (m.waiting.length > 50 ? `<div class="empty">…and ${m.waiting.length - 50} more — queue or call the ones above first.</div>` : "") + `</div>`;
  }
  const noteBits = [];
  if (m.askedKnown && m.askedN) noteBits.push(`<span id="adv-promoters-asked">${m.askedN} promoter${m.askedN === 1 ? " is" : "s are"} not listed — a referral request has already been queued or sent for ${m.askedN === 1 ? "them" : "each of them"}.</span>`);
  if (m.phoneOnlyN) noteBits.push(`<span id="adv-promoters-phone">${m.phoneOnlyN === 1 ? "One flagged row carries" : `${m.phoneOnlyN} flagged rows carry`} the call verb only — an opted-out promoter said no to relationship email, not to being asked, and can still be ASKED BY PHONE (a no-email promoter can only be).</span>`);
  return `<div class="adv-block" id="adv-block-promoters"><h4>Promoters never asked</h4>
    <p class="adv-basis" id="adv-promoters-basis">Clients whose case carries a review score of <strong>9 or 10</strong> and for whom <strong>no referral request has ever been queued</strong> — no stamp on any of their cases, and no email_queue row in any status except cancelled. Ranked best score first, newest completion first.</p>
    ${body}
    ${noteBits.length ? `<p class="adv-basis" id="adv-promoters-excl">${noteBits.join(" ")}</p>` : ""}</div>`;
}
/* R80 · B1 — the call verb: ONE case_tasks insert, protCallTask's exact shape (assigned to the
   case's own adviser, due tomorrow, a weekend landing rolled to Monday by weekendRollYmd, dbFail
   on the error). Nothing here emails anybody — the task IS the phone ask. */
window.advPromoCallTask = async function (caseId) {
  const { data: c, error } = await db.from("cases")
    .select("id,assigned_to,clients!client_id(first_name,last_name)")
    .eq("id", caseId).single();
  if (error || !c) return dbFail("advPromoCallTask", error, "Couldn't open that case — " + ((error && error.message) || "it may have been deleted"));   // R81 · A4
  const who = [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ").trim() || "client";
  const roll = weekendRollYmd(localDateStr(Date.now() + 86400000));
  const { error: terr } = await db.from("case_tasks").insert({
    case_id: caseId, title: `Call ${who} — thank them and ask for a referral`, due_date: roll.date,
    created_by: (ME && ME.id) || null, assigned_to: c.assigned_to || (ME && ME.id) || null,
  });
  if (terr) return dbFail("advPromoCallTask", terr);
  toast(roll.rolled ? "Call task added for Monday — skipped the weekend" : "Call task added for tomorrow");
};
/* R80 · B1 — queue the referral request through the ONE email writer. queueEmail supplies the
   confirm (with R79's holdLine while sending is held), the insert, the scoped send,
   sendResultToast's held wording and the referral_requested_at stamp; this function adds only the
   opt-out pre-flight — the same judgement as the R13 suppression pre-flight: a send that is
   CERTAIN to be cancelled should be refused with the reason, not queued and reported as a skip.
   v19's send-time gate stays the backstop for every other route. */
window.advPromoAsk = async function (caseId, ev) {
  const { data: c, error } = await db.from("cases")
    .select("id,client_id,assigned_to,stage,lender,broker_fee,fee_status,rate_end_date,completed_at,clients!client_id(first_name,last_name)")
    .eq("id", caseId).single();
  if (error || !c) return dbFail("advPromoAsk", error, "Couldn't open that case — " + ((error && error.message) || "it may have been deleted"));   // R81 · A4
  const { data: optRow } = await db.from("clients").select("comms_optout").eq("id", c.client_id).single();
  if (optRow && optRow.comms_optout === true) {
    return toast("This client has opted out of relationship emails — a referral request would be cancelled at send, so nothing was queued. Ask them on the phone instead.");
  }
  const res = await queueEmail(caseId, c.client_id, "referral_request", c, ev);
  if (res === true && currentPage === "reports") loadReports();   // the row has earned its exit
  return res;
};
function renderAdvocacy(all, ctx) {
  const panel = $("#report-advocacy-panel");
  if (!panel) return;
  /* The gate, both halves. isOwner() decides whether the panel exists at all; showMoney() decides
     the money column inside it. They are the same person today — that is the point of writing
     both, so a future role change cannot silently widen one without the other. R80 · B1 — the
     promoters block renders INSIDE this gate, sixth: the referral list is an owner surface like
     the rest of Advocacy, exactly as it was. */
  if (!isOwner()) { panel.classList.add("hidden"); $("#report-advocacy-grid").innerHTML = ""; return; }
  const promotersBlock = advPromotersBlockHtml(all, ctx);
  panel.classList.remove("hidden");
  const rows = all || [];
  const refMap = ctx && ctx.referrers;          // null ⇒ migration m11 absent
  const scoreDates = ctx && ctx.scoreDates;     // null ⇒ no capture-date column
  const tasks = (ctx && ctx.detractorTasks) || [];
  const money = showMoney();
  const nameOf = (c) => [c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ").trim();

  // ---- 1 · NPS by adviser -------------------------------------------------
  const completed = rows.filter((c) => c.stage === "completed");
  const byAdviser = new Map();
  completed.forEach((c) => {
    const s = caseReviewScore(c);
    if (s == null) return;
    const k = c.assigned_to || "";
    if (!byAdviser.has(k)) byAdviser.set(k, []);
    byAdviser.get(k).push(s);
  });
  const advRowsList = [...byAdviser.entries()]
    .map(([k, scores]) => ({ id: k, name: k ? (profileName(k) || staffName(k)) : "Unassigned", scores }))
    .sort((a, b) => b.scores.length - a.scores.length || String(a.name).localeCompare(String(b.name)));
  const totalScored = advRowsList.reduce((s, a) => s + a.scores.length, 0);
  const thinN = advRowsList.filter((a) => a.scores.length < ADV_MIN_N).length;
  const npsBlock = advRowsList.length
    ? `<table id="adv-nps-table"><tr><th>Adviser</th><th class="num">Scores</th><th class="num" title="Mean score out of 10 on that adviser's completed cases. Marked (n&lt;${ADV_MIN_N}) where fewer than ${ADV_MIN_N} clients have answered.">Avg</th><th class="num" title="Scores of 6 or below.">Detractors</th></tr>`
      + advRowsList.map((a) => `<tr data-adviser="${esc(a.id)}"><td>${esc(a.name)}</td><td class="num">${a.scores.length}</td><td class="num adv-avg">${advScoreCell(a.scores)}</td><td class="num">${a.scores.filter((x) => x <= 6).length || ""}</td></tr>`).join("")
      + `</table>`
      + `<p class="adv-basis" id="adv-nps-note">${totalScored} score${totalScored === 1 ? "" : "s"} across ${advRowsList.length} adviser${advRowsList.length === 1 ? "" : "s"}${thinN ? ` · ${thinN} marked (n&lt;${ADV_MIN_N}) — too few answers to read as a track record` : ""}.</p>`
    : ADV_EMPTY(`No completed case has returned a review score yet, so there is nothing to average. Switch review requests on in Settings and the first scores will appear here — a blank table is the truthful state, not a broken one.`);

  // ---- 2 · Reviews received per month ------------------------------------
  const months = last6Months().slice(-ADV_SERIES_MONTHS);
  /* WHICH DATE. The capture stamp if the database keeps one; the request stamp otherwise; and the
     basis line below says which, in words, so nobody reads "when we asked" as "when they replied". */
  const dateOf = (c) => (scoreDates && scoreDates.map[c.id]) || c.review_requested_at || c.completed_at || null;
  const scoredRows = rows.filter((c) => caseReviewScore(c) != null);
  const perMonth = months.map((mv) => scoredRows.filter((c) => { const d = dateOf(c); return d && localMonthStr(d) === mv; }).length);
  const seriesTotal = perMonth.reduce((s, n) => s + n, 0);
  const dateBasis = scoreDates
    ? `dated by <code>${esc(scoreDates.col)}</code> — when the score came back`
    : (`dated by <code>review_requested_at</code> — <strong>the database records no date for when a score came back</strong>, so this is when the request went out. `
      + `Treat it as "reviews prompted", not "reviews received", until that column exists.`);
  const reviewsBlock = seriesTotal
    ? advMiniSeries(months, perMonth) + `<p class="adv-basis" id="adv-series-basis">${seriesTotal} score${seriesTotal === 1 ? "" : "s"} in the last ${ADV_SERIES_MONTHS} months · ${dateBasis}</p>`
    : ADV_EMPTY(`No scores fall in the last ${ADV_SERIES_MONTHS} months${scoredRows.length ? ` (the book holds ${scoredRows.length} in total, all older)` : ""}. ${scoreDates ? "" : "There is also no column recording when a score came back, so even the older ones can only be dated by when they were asked for."}`);

  // ---- 3 · Referrals per completion --------------------------------------
  /* PEOPLE per completion, not cases: one friend who takes two mortgages is one referral. The
     denominator is completed cases, all time, which is what "per completion" has to mean if the
     figure is to be comparable month to month. */
  let referralBlock;
  if (!refMap) {
    referralBlock = ADV_EMPTY(`Referrals are not being recorded yet — this database has not taken migration <code>m11</code> (<code>cases.referrer_client_id</code>), so no case can name who sent the client. Nothing here is a zero; it is an absence.`);
  } else {
    const referredCases = rows.filter((c) => refMap[c.id]);
    const referredPeople = new Set(referredCases.map((c) => c.client_id).filter(Boolean));
    const nDone = completed.length;
    const ratio = nDone ? referredPeople.size / nDone : null;
    referralBlock = `<div class="adv-headline">
        <span class="adv-big" id="adv-ratio">${ratio == null ? "—" : ratio.toFixed(2)}</span>
        <span class="cs-muted">referrals per completion</span>
      </div>
      <p class="adv-basis" id="adv-ratio-basis">${referredPeople.size} referred client${referredPeople.size === 1 ? "" : "s"} ÷ ${nDone} completed case${nDone === 1 ? "" : "s"} — all time, whole book. Counted as PEOPLE referred (a client who came back for a second mortgage is one referral, not two) over completions, so a firm doing more business has to earn more referrals to hold the number steady.${referredCases.length !== referredPeople.size ? ` ${referredCases.length} referred cases sit behind those ${referredPeople.size} people.` : ""}${nDone ? "" : " No completions yet, so there is nothing to divide by."}</p>`;
  }

  // ---- 4 · Top referrers -------------------------------------------------
  let topBlock;
  if (!refMap) {
    topBlock = ADV_EMPTY(`No referrer can be named until migration <code>m11</code> is in place.`);
  } else {
    const byReferrer = new Map();
    rows.forEach((c) => {
      const rid = refMap[c.id];
      if (!rid) return;
      if (!byReferrer.has(rid)) byReferrer.set(rid, { id: rid, clients: new Set(), cases: 0, done: 0, value: 0 });
      const v = byReferrer.get(rid);
      v.cases++;
      if (c.client_id) v.clients.add(c.client_id);
      /* CONVERTED VALUE = fee value EARNED on the referred cases that completed — proc + broker +
         sols, paid or not. Deliberately the same expression earnedOnCompletion() uses for the
         headline "Fees earned" tile, so the two cannot disagree about what a completion is worth. */
      if (c.stage === "completed") { v.done++; v.value += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0); }
    });
    const list = [...byReferrer.values()]
      .sort((a, b) => b.clients.size - a.clients.size || b.value - a.value)
      .slice(0, ADV_TOP_REFERRERS);
    /* The referrer's own name comes from any case of theirs on this page; where they have none
       (they referred somebody but have no case in the capped set) the row still counts, and says
       so, rather than being dropped for want of a label. */
    const nameById = {};
    rows.forEach((c) => { if (c.client_id && !nameById[c.client_id]) { const n = nameOf(c); if (n) nameById[c.client_id] = n; } });
    topBlock = list.length
      ? `<table id="adv-top-table"><tr><th>Referrer</th><th class="num" title="Distinct people they have sent us.">Referrals</th><th class="num" title="How many of those referred cases have completed.">Completed</th>${money ? `<th class="num" title="Fee value (proc + broker + sols) earned on this referrer's referred cases that completed — paid or not. All time.">Converted value</th>` : ""}</tr>`
        + list.map((v) => `<tr data-referrer="${esc(v.id)}"><td><button type="button" class="linkish" onclick="openClient('${jsArg(v.id)}')" title="Open this client's record">${esc(nameById[v.id] || "(client not in this view)")}</button></td><td class="num">${v.clients.size}</td><td class="num">${v.done}</td>${money ? `<td class="num adv-value">${fmtM(v.value)}</td>` : ""}</tr>`).join("")
        + `</table>`
        + (money ? `<p class="adv-basis" id="adv-top-basis">Converted value ${esc(BASIS_INTRO_REV)} — fee value on the completed cases behind each referral, whether or not it has been paid. Not cash.</p>`
          : `<p class="adv-basis" id="adv-top-basis">Referral counts only — fee value is not shown at your access level.</p>`)
      : ADV_EMPTY(`Nobody has been recorded as a referrer yet. The field is on the case form (“Referred by (client)”), under Lead source — fill it in as referrals arrive and this table builds itself.`);
  }

  // ---- 5 · Detractor follow-ups outstanding ------------------------------
  const todayStr = localDateStr();
  const openTasks = tasks.slice().sort((a, b) => String(a.due_date || "").localeCompare(String(b.due_date || "")));
  const overdueN = openTasks.filter((t) => t.due_date && t.due_date < todayStr).length;
  const detractorBlock = openTasks.length
    ? `<table id="adv-detractor-table"><tr><th>Client</th><th>Task</th><th class="num">Due</th><th>Adviser</th><th></th></tr>`
      + openTasks.map((t) => {
        const who = t.cases?.clients ? [t.cases.clients.first_name, t.cases.clients.last_name].filter(Boolean).join(" ") : "(client unknown)";
        const late = t.due_date && t.due_date < todayStr;
        return `<tr data-task="${esc(t.id)}"><td>${esc(who)}</td><td>${esc(t.title)}</td><td class="num${late ? " cs-danger-txt" : ""}">${t.due_date ? fmtD(t.due_date) : "—"}${late ? " <span class=\"badge red\">overdue</span>" : ""}</td><td>${t.assigned_to ? esc(staffName(t.assigned_to)) : '<span class="cs-muted">unassigned</span>'}</td>`
          + `<td>${t.case_id ? `<button type="button" class="btn btn-sm adv-open-btn" onclick="openCase('${jsArg(t.case_id)}')" title="Open the case — the timeline holds what the client actually said">Open</button>` : ""}</td></tr>`;
      }).join("")
      + `</table>`
      + `<p class="adv-basis" id="adv-detractor-basis">${openTasks.length} open review-feedback task${openTasks.length === 1 ? "" : "s"}${overdueN ? ` · <strong>${overdueN} overdue</strong>` : ""}. These are raised when an unhappy client answers a review request; the score and their comment are on the case timeline. Open tasks only — a completed call-back drops off this list.</p>`
    : ADV_EMPTY(`No review-feedback call-backs are outstanding. That means either nobody has scored us badly, or every one that came in has been rung back and closed — the case timelines say which.`);

  $("#report-advocacy-grid").innerHTML = `
    <div class="adv-block" id="adv-block-nps"><h4>Review score by adviser</h4>
      <p class="adv-basis">Mean score out of 10 on each adviser's <strong>completed</strong> cases, all time. Fewer than ${ADV_MIN_N} answers is marked (n&lt;${ADV_MIN_N}) and greyed — the same rule the conversion columns use.</p>${npsBlock}</div>
    <div class="adv-block" id="adv-block-series"><h4>Reviews per month — last ${ADV_SERIES_MONTHS}</h4>${reviewsBlock}</div>
    <div class="adv-block" id="adv-block-ratio"><h4>Referrals per completion</h4>${referralBlock}</div>
    <div class="adv-block" id="adv-block-top"><h4>Top referrers</h4>${topBlock}</div>
    <div class="adv-block" id="adv-block-detractors"><h4>Detractor follow-ups outstanding</h4>${detractorBlock}</div>
    ${promotersBlock}`;
  const basis = $("#report-advocacy-basis");
  if (basis) basis.innerHTML = `Everything on this panel is computed from the ${rows.length} case row${rows.length === 1 ? "" : "s"} this page already holds — no separate report, nothing scoped to the month picker above. `
    + `${refMap ? "" : "<strong>Referral figures are unavailable: migration m11 has not run.</strong> "}`
    + `Owner-only, like the rest of the firm-wide figures here.`;
}
/* ==========================================================================
   R9-6 · CONVEYANCER SPEED  (Reports, Owner-only)

   The one number a firm can act on about its solicitors: how long a case takes
   from submission to completion, by the firm doing the conveyancing. A broker
   cannot make a slow conveyancer faster, but they can stop recommending one —
   and until this panel existed there was nowhere the difference showed up.

   THE BASIS IS STATED BECAUSE IT IS NOT THE OBVIOUS ONE. There is no column
   anywhere recording the date an offer was ISSUED (offer_expiry_date is the
   date it runs out, which is a different fact), so "offer to completion"
   cannot be computed from this schema without inventing a date. What CAN be
   computed honestly is submission to completion, and that is what this is —
   said in words on the panel rather than left for someone to assume.

   n<3 IS MARKED, NOT HIDDEN. Three completions is not a track record, but a
   firm you have used twice and both times took ten weeks is exactly what an
   owner wants to see. Same discipline as the advocacy panel's n<5, with a
   lower boundary because a conveyancer is picked case by case, not annually.
   ========================================================================== */
const CONV_MIN_N = 3;
const CONV_DAY = 86400000;
function renderConveyancerSpeed(all, firmMap) {
  const panel = $("#report-conveyancer-panel");
  if (!panel) return;
  if (!isOwner()) { panel.classList.add("hidden"); $("#report-conveyancer-body").innerHTML = ""; return; }
  panel.classList.remove("hidden");
  const body = $("#report-conveyancer-body");
  const basisEl = $("#report-conveyancer-basis");
  if (basisEl) {
    basisEl.innerHTML = `Average days from <strong>application submitted</strong> to <strong>completed</strong>, grouped by the solicitor named on the case. `
      + `The database records no date an offer was issued — <code>offer_expiry_date</code> is when an offer runs out, not when it arrived — so this measures from submission, which is the last date on a case that is definitely real. `
      + `Owner-only, like the rest of the firm-wide figures here.`;
  }
  if (!firmMap) {
    body.innerHTML = `<div class="adv-empty">Solicitors are not being recorded yet — this database has not taken migration <code>m10</code> (<code>cases.solicitor_firm</code>), so no case can name its conveyancer. Nothing here is a zero; it is an absence.</div>`;
    return;
  }
  /* Rounded to whole days per case BEFORE averaging, deliberately: that is how anybody checking
     this by hand off two dates would do it, and it means the panel's figure can be reconciled
     against a case-by-case count rather than argued with. */
  const byFirm = new Map();
  let named = 0, unnamed = 0;
  (all || []).forEach((c) => {
    if (c.stage !== "completed" || !c.completed_at || !c.submitted_at) return;
    const firm = (firmMap[c.id] || "").trim();
    const days = Math.round((new Date(c.completed_at) - new Date(c.submitted_at)) / CONV_DAY);
    if (!(days > 0)) return;              // a same-day or reversed pair is bad data, not a fast solicitor
    if (!firm) { unnamed++; return; }
    named++;
    if (!byFirm.has(firm)) byFirm.set(firm, []);
    byFirm.get(firm).push(days);
  });
  if (!byFirm.size) {
    body.innerHTML = `<div class="adv-empty">No completed case names a solicitor yet${unnamed ? ` — ${unnamed} completion${unnamed === 1 ? " has" : "s have"} a submission and completion date but no firm on the case` : ""}. The field is on the case form (“Solicitor firm”), beside “Waiting on”; fill it in as cases complete and this table builds itself. A product transfer has no conveyancer, so leaving those blank is correct.</div>`;
    return;
  }
  const rows = [...byFirm.entries()].map(([firm, days]) => ({
    firm, n: days.length,
    avg: days.reduce((s, d) => s + d, 0) / days.length,
    min: Math.min(...days), max: Math.max(...days),
  })).sort((a, b) => a.avg - b.avg);
  /* "Slowest" is only a meaningful word when there is somebody to be slower THAN, and only when
     the row is not itself marked as too thin to read. Two firms with three cases each is a
     comparison; one firm with two is a fact about one firm. */
  const solid = rows.filter((r) => r.n >= CONV_MIN_N);
  const slowest = solid.length > 1 ? solid[solid.length - 1].firm : null;
  const thin = rows.filter((r) => r.n < CONV_MIN_N).length;
  const spread = solid.length > 1 ? solid[solid.length - 1].avg - solid[0].avg : null;
  body.innerHTML = `<table id="conv-table">
      <tr><th>Solicitor</th><th class="num" title="Completed cases with both a submission and a completion date on them.">Cases</th><th class="num" title="Mean days from submission to completion. Marked (n&lt;${CONV_MIN_N}) where fewer than ${CONV_MIN_N} cases sit behind it.">Avg days</th><th class="num" title="Fastest and slowest single case for this firm.">Range</th></tr>
      ${rows.map((r) => `<tr data-firm="${esc(r.firm)}" class="${r.firm === slowest ? "conv-slowest" : ""}">
        <td>${esc(r.firm)}${r.firm === slowest ? ' <span class="badge red conv-slow-badge" title="The slowest firm you use with enough cases behind it to say so.">slowest</span>' : ""}</td>
        <td class="num">${r.n}</td>
        <td class="num conv-avg">${r.n < CONV_MIN_N
          ? `<span class="stat-weak" title="Mean of ${r.n} case${r.n === 1 ? "" : "s"} — fewer than ${CONV_MIN_N}, so indicative only, not a track record.">${r.avg.toFixed(1)} <span class="stat-n">(n&lt;${CONV_MIN_N})</span></span>`
          : `<span title="Mean of ${r.n} completed cases.">${r.avg.toFixed(1)}</span>`}</td>
        <td class="num">${r.min}–${r.max}</td>
      </tr>`).join("")}
    </table>
    <p class="adv-basis" id="conv-basis">${named} completion${named === 1 ? "" : "s"} across ${rows.length} firm${rows.length === 1 ? "" : "s"}`
    + `${thin ? ` · ${thin} marked (n&lt;${CONV_MIN_N})` : ""}`
    + `${spread != null ? ` · ${spread.toFixed(1)} days between your fastest and slowest firm` : ""}`
    + `${unnamed ? ` · ${unnamed} completion${unnamed === 1 ? "" : "s"} name no solicitor and ${unnamed === 1 ? "is" : "are"} left out entirely — a product transfer has no conveyancer, so blank is often correct` : ""}.</p>`;
}

/* ==========================================================================
   R66 · M6b — REFERRALS OUT, THE READ.

   `referrals` has been WRITE-ONLY since R56: one insert from the case modal,
   and exactly one reader — loadCaseReferrals, which is `.eq("case_id")`. So the
   firm can see every referral on a case it already has open, and cannot see a
   single one any other way. "Who did I refer this quarter, and did any of it
   come back?" had no answer at all.

   THE READS, and there are two, both bounded:
     · ONE `referrals` select for the selected month. No `.eq("case_id")` —
       that is the whole point — and no join, because PostgREST cannot embed
       `cases` from here without an FK hint the table does not carry a policy
       for. Ordered newest-first, capped.
     · ONE `inChunks` read of the cases those referrals point at, for the
       client name, the property and the case adviser. inChunks because a busy
       quarter's referral list is feed-sized and `.in()` 400s above ~500 ids
       (R64 · rule 14). The Reports page's own `all` array is used FIRST where
       it already holds the case — it carries the property column this select
       deliberately does not name (m7 is feature-detected on the page and a
       42703 here would take the panel down over an optional column).

   WHOSE REFERRAL IS IT? `created_by` — the person who pressed the button —
   falling back to the case's adviser where the row predates that column being
   populated. Said on the panel, because "mine" has to mean something exact.

   NOT OWNER-GATED. A referral count is not money and no £ appears here; see
   the markup's own block comment.
   ========================================================================== */
/* ==========================================================================
   R77 · B1 — APPOINTMENT OUTCOMES, COUNTED AT LAST.

   `appointments.outcome` (attended / no_show / rearranged, null = not
   recorded) has been written by the ✓ ✗ ↻ chips on Today and the editor's
   radios since r12b, and read by NOTHING — the column's own comment deferred
   the counting to "a later round". This is that round, and the r12b warning
   ("a report built on three days of outcome data says more about when the
   column shipped than about anybody's diary") is answered by making the
   RECORDING GAP the first-class number: the headline leads with the share of
   past appointments carrying NO outcome, because every other figure on the
   panel is only as good as that share is small — and the panel says so
   instead of drawing confident bars over unscored rows.

   THE WINDOW is the last 90 days of appointments that have already STARTED:
   a future booking has no outcome to record and is not "unrecorded", it is
   pending — counting it would inflate the honesty number with rows nobody
   could have scored. Window arithmetic through localDateStr (Europe/London).

   PER ADVISER by staff_id (the diary's own "who is this booked for"), plus
   the short register of clients with 2+ recorded no-shows in the window —
   the "who wasted my Tuesday?" answer r12b promised. Read-only: Open links,
   no verbs; what to do about a serial no-show is a conversation, not a
   button.

   OWNER-ONLY (showMoney) — per-adviser conduct numbers, the same gate as the
   per-adviser review scores in the Advocacy panel, and the gate r42 §B pins
   for this section on an adviser login. One bounded read of its own; empty
   and thin data render honestly through emptyState / the basis line.
   ========================================================================== */
const APPT_OUTCOME_WINDOW_DAYS = 90;
async function renderApptOutcomes() {
  const panel = $("#report-outcomes-panel");
  if (!panel) return;
  const parts = ["#report-outcomes-headline", "#report-outcomes-adviser", "#report-outcomes-noshows", "#report-outcomes-basis"];
  if (!showMoney()) {
    panel.classList.add("hidden");
    parts.forEach((s) => { const el = $(s); if (el) el.innerHTML = ""; });
    return;
  }
  panel.classList.remove("hidden");
  const today = localDateStr();
  const d = new Date(today + "T12:00:00");
  d.setDate(d.getDate() - APPT_OUTCOME_WINDOW_DAYS);
  const since = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const { data: rows, error } = await readAll(
    db.from("appointments").select("id,staff_id,client_id,outcome,starts_at,clients(first_name,last_name)")
      .gte("starts_at", since + "T00:00:00").order("id"));
  if (error) {
    $("#report-outcomes-basis").innerHTML = `Appointment outcomes could not be read just now (${esc(error.message || "no answer")}) — this panel is a failed question, not an empty diary.`;
    ["#report-outcomes-headline", "#report-outcomes-adviser", "#report-outcomes-noshows"].forEach((s) => { const el = $(s); if (el) el.innerHTML = ""; });
    return;
  }
  const nowMs = Date.now();
  // Already started = judged or judgeable. A future booking is pending, not unrecorded.
  const past = (rows || []).filter((a) => {
    const t = new Date(a.starts_at || "").getTime();
    return isFinite(t) && t <= nowMs;
  });
  const known = (k) => k === "attended" || k === "no_show" || k === "rearranged";
  const total = past.length;
  const unrecorded = past.filter((a) => !known(a.outcome)).length;
  const noShows = past.filter((a) => a.outcome === "no_show");
  const unrecPct = total ? Math.round((unrecorded / total) * 100) : 0;
  $("#report-outcomes-basis").innerHTML =
    `Every appointment that has already started in the <strong>last ${APPT_OUTCOME_WINDOW_DAYS} days</strong> (since ${esc(fmtD(since))}) — ${total} of them — counted by the adviser it was booked for. `
    + `The outcome is what the <strong>✓ ✗ ↻ chips on Today</strong> (and the radios in the appointment editor) record; <strong>null means not recorded</strong>, and that share leads the numbers below because every other figure on this panel is only as good as the recording. `
    + `Future bookings are pending, not unrecorded, and are not counted. Not scoped to the month picker.`;
  if (!total) {
    $("#report-outcomes-headline").innerHTML = "";
    $("#report-outcomes-adviser").innerHTML = emptyState({
      headline: "No appointments in the window.",
      sub: `Nothing in the diary has started in the last ${APPT_OUTCOME_WINDOW_DAYS} days, so there is nothing to count — this is an empty diary, not a clean sheet.`,
    });
    $("#report-outcomes-noshows").innerHTML = "";
    return;
  }
  /* The headline: the recording gap FIRST and loudest, then the two counts it qualifies. */
  $("#report-outcomes-headline").innerHTML = [
    `<div class="kpi ${unrecorded ? "warn" : ""}" id="outcomes-unrecorded-kpi" title="Past appointments in the window with no outcome recorded. The ✓ ✗ ↻ chips on each appointment on Today record one in a click."><div class="num" id="outcomes-unrecorded-pct">${unrecPct}%</div><div class="lbl">unrecorded — the chips on Today record it</div><div class="s">${unrecorded} of ${total} past appointments</div></div>`,
    `<div class="kpi"><div class="num">${total - unrecorded}</div><div class="lbl">outcomes recorded</div><div class="s">attended, no-show or rearranged</div></div>`,
    `<div class="kpi ${noShows.length ? "warn" : ""}"><div class="num" id="outcomes-noshow-n">${noShows.length}</div><div class="lbl">no-shows recorded</div><div class="s">in the ${APPT_OUTCOME_WINDOW_DAYS}-day window</div></div>`,
  ].join("");
  /* Per adviser, biggest diary first. staffName answers for departed logins too. */
  const byAdv = new Map();
  past.forEach((a) => {
    const k = a.staff_id || "";
    if (!byAdv.has(k)) byAdv.set(k, { total: 0, attended: 0, no_show: 0, rearranged: 0, unrecorded: 0 });
    const b = byAdv.get(k);
    b.total++;
    if (known(a.outcome)) b[a.outcome]++; else b.unrecorded++;
  });
  const advRows = [...byAdv.entries()]
    .map(([id, b]) => ({ id, name: id ? staffName(id) : "(nobody booked)", ...b }))
    .sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
  $("#report-outcomes-adviser").innerHTML = `<h4 class="leadresp-h">By adviser</h4>
    <div style="overflow-x:auto;"><table class="imp-table outcomes-table" id="report-outcomes-table">
      <tr><th>Adviser</th><th class="num">Appointments</th><th class="num">Attended</th><th class="num">No-show</th><th class="num">Rearranged</th><th class="num" title="Past appointments this adviser has not recorded an outcome for — the share in brackets is theirs, not the firm's">Not recorded</th></tr>
      ${advRows.map((r) => `<tr data-adviser="${esc(r.id)}">
        <td>${esc(r.name)}</td>
        <td class="num">${r.total}</td>
        <td class="num">${r.attended}</td>
        <td class="num">${r.no_show}</td>
        <td class="num">${r.rearranged}</td>
        <td class="num"${r.unrecorded ? ` style="font-weight:600;"` : ""}>${r.unrecorded}${r.total ? ` (${Math.round((r.unrecorded / r.total) * 100)}%)` : ""}</td>
      </tr>`).join("")}
    </table></div>`;
  /* Clients with 2+ recorded no-shows — the actionable short list, honestly framed: it can only
     ever be as complete as the recording above it, and when nothing is recorded it says so
     rather than printing a clean sheet. */
  const byClient = new Map();
  noShows.forEach((a) => {
    const k = a.client_id || "";
    if (!k) return;
    if (!byClient.has(k)) {
      const nm = a.clients ? [a.clients.first_name, a.clients.last_name].filter(Boolean).join(" ") : "";
      byClient.set(k, { id: k, name: nm || "(no name)", n: 0, last: "" });
    }
    const c = byClient.get(k);
    c.n++;
    if (String(a.starts_at || "") > c.last) c.last = a.starts_at || "";
  });
  const repeat = [...byClient.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n || String(b.last).localeCompare(String(a.last)));
  $("#report-outcomes-noshows").innerHTML = `<h4 class="leadresp-h">Clients with 2+ no-shows · last ${APPT_OUTCOME_WINDOW_DAYS} days</h4>`
    + (repeat.length
      ? `<div id="report-outcomes-noshow-list">${repeat.map((c) => `
        <div class="row-item" data-client="${esc(c.id)}">
          <div class="row-main"><div class="t" onclick="openClient('${jsArg(c.id)}')">${esc(c.name)}</div><div class="s"><strong>${c.n}</strong> recorded no-show${c.n === 1 ? "" : "s"} · last one ${esc(fmtD(c.last))}</div></div>
          <button class="btn btn-sm" onclick="openClient('${jsArg(c.id)}')">Open</button>
        </div>`).join("")}</div>`
      : emptyState({
        headline: "No client has 2+ recorded no-shows.",
        sub: unrecorded
          ? `${unrecorded} of the ${total} past appointments in the window carry no outcome at all, so this list can only be as good as the recording above it.`
          : "Every past appointment in the window carries an outcome, so this is a real clean sheet.",
      }));
}
const REFOUT_ROW_CAP = 500;      // referrals read for one month — bounded like every Reports select
const REFOUT_LIST_CAP = 100;     // rows drawn in the ledger drawer; the CSV carries the lot
let refOutScope = null;          // "mine" | "all"; null = not yet defaulted for this role
let refOutRows = [];             // the period's rows, resolved — kept so the CSV needs no re-read
/* Adviser default: an adviser opens on their own referrals (the question they ask is "who did I
   refer"), an owner/admin on the firm's (the question they ask is "what is the network getting").
   Sticky for the session once the operator picks, exactly like the Protection page's scope. */
function refOutDefaultScope() { return isAdminOrOwner() ? "all" : "mine"; }
function refOutAdviser(r) { return r.created_by || r.case_assigned_to || null; }
async function renderReferralsOut(all, mv) {
  const panel = $("#report-referrals-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  if (refOutScope === null) refOutScope = refOutDefaultScope();
  const groupsEl = $("#report-ref-groups"), listEl = $("#report-ref-list"), basisEl = $("#report-ref-basis");
  const label = monthLabel(mv);
  // The month, as a half-open [start, next) range on created_at — the same shape every other
  // month-scoped read on this page uses, so a referral made at 23:59 on the 31st is in the month
  // it was made in and not the one after.
  const start = mv + "-01T00:00:00.000Z";
  const endM = monthAdd(mv, 1);
  const end = endM + "-01T00:00:00.000Z";
  const refs = await softRows(db.from("referrals").select("*")
    .gte("created_at", start).lt("created_at", end)
    .order("created_at", { ascending: false }).limit(REFOUT_ROW_CAP));
  const allById = {};
  (all || []).forEach((c) => { if (c && c.id) allById[c.id] = c; });
  const missing = [...new Set(refs.map((r) => r.case_id).filter((id) => id && !allById[id]))];
  if (missing.length) {
    /* Deliberately NOT naming property_address: it is the one optional column on this table
       (m7, feature-detected elsewhere on this page) and a 42703 would lose the whole panel over
       an address. Cases already in `all` bring their address with them. */
    const { data: extra } = await inChunks(missing, (sl) =>
      db.from("cases").select("id,client_id,case_kind,stage,assigned_to,clients!client_id(first_name,last_name)").in("id", sl));
    (extra || []).forEach((c) => { if (c && c.id && !allById[c.id]) allById[c.id] = c; });
  }
  refOutRows = refs.map((r) => {
    const cs = allById[r.case_id] || null;
    const cl = cs && cs.clients ? cs.clients : null;
    return {
      ...r,
      case_assigned_to: cs ? cs.assigned_to : null,
      client_name: [cl && cl.first_name, cl && cl.last_name].filter(Boolean).join(" ").trim() || "(client not on file)",
      property: (cs && propAddress(cs)) || "",
    };
  });
  const scoped = refOutScope === "mine"
    ? refOutRows.filter((r) => ME && refOutAdviser(r) === ME.id)
    : refOutRows;
  // The scope buttons: painted from the current state every render, so a role change or a reload
  // can never leave both lit (or neither).
  ["mine", "all"].forEach((k) => {
    const b = $("#report-ref-scope-" + k);
    if (!b) return;
    b.classList.toggle("active", refOutScope === k);
    b.setAttribute("aria-selected", refOutScope === k ? "true" : "false");
    b.onclick = () => { refOutScope = k; renderReferralsOut(all, mv); };
  });
  if (basisEl) {
    basisEl.innerHTML = `Referrals this firm made OUT to somebody else, counted on the date they were recorded, scoped to <strong>${esc(label)}</strong> (the month picker at the top of this page). `
      + `Showing <strong>${refOutScope === "mine" ? "your own referrals" : "every adviser's referrals"}</strong> — a referral belongs to the person who recorded it, falling back to the case's adviser where nobody is stamped on the row. `
      + `Status is what somebody set on the case afterwards: <em>Referred</em> means nobody has come back yet. `
      + `No money on this panel — the firm's share of a referral is not held anywhere in this system — so it is visible to everyone.`
      + (refs.length >= REFOUT_ROW_CAP ? ` <span class="client-list-cap-note">Showing the newest ${REFOUT_ROW_CAP} of this month's referrals.</span>` : "");
  }
  if (!scoped.length) {
    groupsEl.innerHTML = `<div class="empty">No referrals recorded in ${esc(label)}${refOutScope === "mine" ? " against your name" : ""}. Referrals are recorded from a case — the “Refer for …” actions on the case screen.</div>`;
    listEl.innerHTML = "";
    buildReportLedgerCounts();
    return;
  }
  /* THE GROUPING. kind × status × adviser, counted. One pass, a plain key join, and the key is
     split back out for rendering — no nested maps, because the table is flat and a reader
     checking the arithmetic should be able to see the same rows this loop saw. */
  const groups = new Map();
  scoped.forEach((r) => {
    const kind = r.kind || "other";
    const status = r.status || "made";
    const adv = refOutAdviser(r);
    const key = [kind, status, adv || ""].join(" ");
    if (!groups.has(key)) groups.set(key, { kind, status, adviser: adv, n: 0 });
    groups.get(key).n++;
  });
  const rows = [...groups.values()].sort((a, b) =>
    (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)
    || (a.status < b.status ? -1 : a.status > b.status ? 1 : 0)
    || b.n - a.n);
  const advName = (id) => (id ? (profileName(id) || staffName(id)) : "— unassigned —");
  const kindLabel = (k) => { const m = REFERRAL_META[k] || REFERRAL_META.other; return `${m.icon} ${m.label}`; };
  const statusLabel = (s) => (REFERRAL_STATUS_BADGE[s] || ["grey", String(s)])[1];
  groupsEl.innerHTML = `<div class="board-scroll-wrap board-scroll-wrap--table"><div class="panel" style="padding:0;">
    <table class="imp-table" id="report-ref-group-table">
      <tr><th>Kind</th><th>Status</th><th>Adviser</th><th class="num-col">Referrals</th></tr>
      ${rows.map((g) => {
        const b = REFERRAL_STATUS_BADGE[g.status] || ["grey", String(g.status)];
        return `<tr class="refout-group-row" data-kind="${esc(g.kind)}" data-status="${esc(g.status)}" data-adviser="${esc(g.adviser || "")}">
          <td>${esc(kindLabel(g.kind))}</td>
          <td><span class="badge ${b[0]}">${esc(b[1])}</span></td>
          <td>${esc(advName(g.adviser))}</td>
          <td class="num-col"><strong class="refout-n">${g.n}</strong></td>
        </tr>`;
      }).join("")}
      <tr class="refout-total-row"><td colspan="3"><strong>Total</strong></td><td class="num-col"><strong id="report-ref-total">${scoped.length}</strong></td></tr>
    </table>
  </div></div>`;
  const shown = scoped.slice(0, REFOUT_LIST_CAP);
  listEl.innerHTML = `<table class="imp-table" id="report-ref-list-table">
      <tr><th>Date</th><th>Client</th><th>Property</th><th>Kind</th><th>Referred to</th><th>Status</th><th>Adviser</th></tr>
      ${shown.map((r) => {
        const b = REFERRAL_STATUS_BADGE[r.status] || ["grey", String(r.status)];
        return `<tr class="refout-row" data-ref-id="${esc(r.id)}">
          <td>${esc(fmtD(r.created_at))}</td>
          <td>${r.case_id ? `<button type="button" class="linkish" onclick="openCase('${esc(r.case_id)}')" title="Open the case this referral was made from">${esc(r.client_name)}</button>` : esc(r.client_name)}</td>
          <td>${esc(r.property || "—")}</td>
          <td>${esc(kindLabel(r.kind))}</td>
          <td>${esc(r.referred_to || "(not recorded)")}</td>
          <td><span class="badge ${b[0]}">${esc(b[1])}</span></td>
          <td>${esc(advName(refOutAdviser(r)))}</td>
        </tr>`;
      }).join("")}
    </table>${scoped.length > REFOUT_LIST_CAP
      ? `<div class="empty">…and ${scoped.length - REFOUT_LIST_CAP} more in ${esc(label)} — the CSV below carries every one of them.</div>` : ""}`;
  const csvBtn = $("#report-ref-csv");
  if (csvBtn) csvBtn.onclick = () => {
    miCsv(`nexmoney-referrals-out-${mv}.csv`,
      ["Date", "Client", "Property", "Kind", "Referred to", "Status", "Adviser"],
      scoped.map((r) => [
        localDateStr(r.created_at), r.client_name, r.property,
        (REFERRAL_META[r.kind] || REFERRAL_META.other).label,
        r.referred_to || "", statusLabel(r.status), advName(refOutAdviser(r)),
      ]));
  };
  buildReportLedgerCounts();
}

/* The open "review feedback" call-backs behind block 5. Its own small read (the Reports page does
   not otherwise fetch tasks), matched on the title phrase rather than on an exact string — see the
   R9-3 block comment for why. Best-effort: on error the block renders its empty state. */
async function loadDetractorTasks() {
  try {
    const { data, error } = await readAll(db.from("case_tasks")
      .select("id,title,due_date,case_id,assigned_to,done_at,cases(client_id,clients!client_id(first_name,last_name))")
      .is("done_at", null).order("due_date").order("id"), { cap: REPORTS_ROW_CAP });
    if (error) return [];
    return (data || []).filter((t) => t && isReviewFeedbackTask(t.title));
  } catch (_) { return []; }
}

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
      <td class="num">${fmtM(c.ltv)}</td>
    </tr>`).join("")}
  </table>` : '<div class="empty">No completed revenue yet.</div>';
}

/* ==========================================================================
   ROUND 7 — THE MONEY PACK
   ==========================================================================
   Four surfaces, one subject: where the firm's money actually is.

     R7-1  MONEY OWED           — every completed case carrying an unpaid fee,
                                  aged from its completion date. (Reports.)
     R7-2  RATE-END BOOK VALUE  — what the completed book is worth as it
                                  matures over the next 24 months, plus the
                                  RECOVER lane for rates that already ended.
                                  (Reports.)
     R7-3  PROTECTION QUOTE CLOCK — how old each quote is, and the commission a
                                  policy is worth. (Protection page + Reports.)
     R7-4  MONDAY MONEY         — the weekly read, on its own page.

   EVERY ONE OF THESE IS FIRM-WIDE MONEY, so every one of them is OWNER-ONLY IN
   THE UI, behind the same showMoney() gate the rest of Reports uses. An adviser
   keeps exactly what round 5 gave them and nothing more: the "My numbers" card,
   scoped to their own cases. The same standing caveat applies verbatim — THIS
   IS PRESENTATION, NOT A SECURITY CONTROL. The cases table still carries
   proc_fee / broker_fee / sols_fee to every signed-in staff session and anyone
   with a browser console can read what these panels withhold. Do not describe
   any of it as a control and do not rely on it for anything that matters.

   Nothing here adds an RPC, a view or a column. Every figure is computed in the
   browser from reads the app already makes, and every figure states its basis
   in the round-6 form, so a number here can be reconciled against the number it
   came from instead of argued with.
   ========================================================================== */

const R7_DAY = 86400000;

/* --------------------------------------------------------------------------
   R7-1a — WHAT "OWED" MEANS, in one place.

   A fee is owed when the case has an AMOUNT for it and no date on which that
   money arrived. The date is read through feeCashDate(), i.e.
   coalesce(<type>_fee_paid_at, fee_paid_at) — the same expression M5 puts in
   get_reports and the same one the My-numbers "outstanding" tile uses, so the
   two figures reconcile by construction rather than by luck.

   The ONE exception is fee_status = 'waived'. fee_status is a BROKER-fee
   workflow field (see the FEE_TYPES note and markFeePaid): "waived" means the
   firm decided not to charge the client. Money you chose not to charge is not
   money you are owed, so the broker line drops out — and only the broker line.
   A lender's procuration fee and a solicitor referral fee are not the firm's to
   waive, so 'waived' has no bearing on either, and they stay.

   Deliberately NOT keyed off fee_status otherwise: 'not_requested' and
   'requested' describe whether an invoice has gone out, not whether the money
   has arrived, and a case can sit at 'paid' with a proc fee still outstanding.
   "No cash date" is the question this panel asks.
   -------------------------------------------------------------------------- */
function feeOwedLines(c) {
  const out = [];
  if (!c) return out;
  FEE_TYPES.forEach((f) => {
    const amt = Number(c[f.amountCol] || 0);
    if (!(amt > 0)) return;
    if (feeCashDate(c, f.dateCol)) return;                     // banked
    if (f.key === "broker" && c.fee_status === "waived") return; // written off, not owed
    out.push({ key: f.key, label: f.label, amount: amt });
  });
  return out;
}
/* Ageing from the COMPLETION date — the day the work finished and the clock on
   getting paid started. Not from the invoice date (there isn't one on the
   schema) and not from updated_at (an edit is not an event). */
const OWED_BUCKETS = [
  { key: "0-30", label: "0–30 days", lo: 0, hi: 30 },
  { key: "30-60", label: "30–60 days", lo: 30, hi: 60 },
  { key: "60-90", label: "60–90 days", lo: 60, hi: 90 },
  { key: "90+", label: "90+ days", lo: 90, hi: Infinity },
];
/* A completed case with no completed_at cannot be aged at all. It is NOT
   quietly dropped (that is money) and NOT parked in 90+ (that is a claim the
   data doesn't support) — it gets its own bucket, which stays off the screen
   entirely while it is empty. */
const OWED_UNDATED = "undated";
const OWED_BUCKET_LABEL = Object.fromEntries(OWED_BUCKETS.map((b) => [b.key, b.label]).concat([[OWED_UNDATED, "No completion date"]]));
function owedBucketKey(days) {
  if (days == null) return OWED_UNDATED;
  const b = OWED_BUCKETS.find((x) => days >= x.lo && days < x.hi);
  return b ? b.key : OWED_BUCKETS[OWED_BUCKETS.length - 1].key;
}
/* The model behind the Money owed panel, the Monday money ageing block and the
   CSV alike — built once, from rows the caller already holds. */
function moneyOwedModel(all) {
  const rows = [];
  (all || []).forEach((c) => {
    if (c.stage !== "completed") return;
    const lines = feeOwedLines(c);
    if (!lines.length) return;
    const days = daysSince(c.completed_at);
    const amt = (k) => (lines.find((l) => l.key === k) || {}).amount || 0;
    rows.push({
      id: c.id, c, lines, days, bucket: owedBucketKey(days),
      proc: amt("proc"), sols: amt("sols"), broker: amt("broker"),
      total: lines.reduce((s, l) => s + l.amount, 0),
    });
  });
  const buckets = {};
  OWED_BUCKETS.concat([{ key: OWED_UNDATED }]).forEach((b) => (buckets[b.key] = { key: b.key, n: 0, total: 0, rows: [] }));
  rows.forEach((r) => { const b = buckets[r.bucket]; b.n++; b.total += r.total; b.rows.push(r); });
  const grand = rows.reduce((s, r) => s + r.total, 0);
  const bucketList = OWED_BUCKETS.map((b) => buckets[b.key]).concat(buckets[OWED_UNDATED].n ? [buckets[OWED_UNDATED]] : []);
  return { rows, buckets, bucketList, grand, n: rows.length,
           procTotal: rows.reduce((s, r) => s + r.proc, 0),
           solsTotal: rows.reduce((s, r) => s + r.sols, 0),
           brokerTotal: rows.reduce((s, r) => s + r.broker, 0) };
}
const BASIS_OWED = "(earned · not yet received · completed cases · aged from completion date)";
/* ==========================================================================
   R74 · A2 (panel D#4) — ONE ZERO CONVENTION, STATED ONCE.

   A dash and a zero are different facts, and this app was using them
   interchangeably for the SAME rows: the Money-owed ageing buckets on Reports
   printed "£0 · 0 cases" for an empty band while Monday money printed "—" for
   that identical band computed from that identical model, one page away. A
   reader comparing the two pages cannot tell whether the second one measured
   nothing or found nothing.

   The rule from here:
     · "—" means THE QUESTION DOES NOT APPLY to this row. No completions this
       month, so there is nothing to attach a policy to; no target set for this
       adviser; no login for get_reports to report on. It always carries a
       title saying which — a bare dash is the thing being fixed.
     · "0" / "£0" means the question applies and the answer is nothing. Zero
       owed in the 90+ band is a real and reassuring answer, and hiding it
       behind a dash makes a clean band look unmeasured. Rendered muted so a
       column of real zeros stays quiet without lying about being blank.

   Applied on: the Reports adviser scoreboard (Target / Attach / Banked YTD),
   both Money-owed ageing renderings (the Reports bucket tiles and the
   per-lender / per-adviser ledger crosstab under them, and Monday money's own
   ageing block) and Monday money's Unpaid proc column.
   ========================================================================== */
const naDash = (why) => `<span class="cs-muted" title="${esc(why)}">—</span>`;
const zeroMoney = (n) => (Number(n) ? fmtM(n) : `<span class="cs-muted" title="Nothing in this band — a real zero, not a missing figure.">${fmtM(0)}</span>`);

/* --------------------------------------------------------------------------
   R7-1b — the panel. Grouped by lender or by adviser, because those are the two
   people you chase: the lender's payments team for a proc fee, and the adviser
   for the client's broker fee. The grouping is a view toggle, never a filter —
   both groupings contain exactly the same rows and add to the same grand total,
   which is the point of putting the totals row at the bottom of each.
   -------------------------------------------------------------------------- */
let owedGroupBy = "lender";
let owedState = { model: null, all: null };
function renderMoneyOwed(all) {
  const panel = $("#report-owed-panel");
  if (!panel) return;
  owedState.all = all || [];
  if (!showMoney()) {
    panel.classList.add("hidden");
    owedState.model = null;
    $("#report-owed-table").innerHTML = "";
    $("#report-owed-buckets").innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  const m = moneyOwedModel(all);
  owedState.model = m;
  /* R42 · F7 — BASIS REPEAT TRIMMED. Two clauses here were saying what #report-basis-legend says
     four panels up the same page, to the same reader (this panel is Owner-only and the legend is
     shown to exactly that reader): "the same basis as 'Fees banked' above" re-derived the cash
     basis, and the tail label "(earned · not yet received · …)" is the legend's own definition of
     OUTSTANDING, plus a second copy of "aged from completion date" one clause after the first. The
     panel-specific facts — which column each fee type is counted on, what a waived fee does, what
     it is aged from — are what this line is FOR and are untouched. BASIS_OWED itself is not
     touched: Monday money (#money-owed-basis) still prints it and that page is out of scope. */
  $("#report-owed-basis").innerHTML =
    `Every completed case carrying a fee amount with no paid date against it — proc, solicitor and broker fees counted separately, each on <code>coalesce(&lt;type&gt;_fee_paid_at, fee_paid_at)</code>. `
    + `A broker fee marked <strong>waived</strong> is excluded (money you chose not to charge is not money you are owed); a waived status has no effect on proc or solicitor fees. `
    + `Aged from <strong>completed_at</strong>. <span class="money-basis">— basis: outstanding (see legend above)</span>`;

  $("#report-owed-buckets").innerHTML = m.bucketList.map((b) => {
    const hot = b.key === "60-90" || b.key === "90+";
    return `<div class="kpi ${b.total && hot ? (b.key === "90+" ? "bad" : "warn") : ""}">
      <div class="num" title="${esc(fmtM(b.total))}">${zeroMoney(b.total)}</div>
      <div class="lbl">${esc(OWED_BUCKET_LABEL[b.key])}</div>
      <div class="s">${b.n} case${b.n === 1 ? "" : "s"}</div>
    </div>`;
  }).join("") + `<div class="kpi kpi-headline"><div class="num" title="${esc(fmtM(m.grand))}">${fmtM(m.grand)}</div><div class="lbl">Total owed</div><div class="s">${m.n} case${m.n === 1 ? "" : "s"} · proc ${fmtM(m.procTotal)} · sols ${fmtM(m.solsTotal)} · broker ${fmtM(m.brokerTotal)}</div></div>`;

  $("#owed-group-lender").classList.toggle("scope-active", owedGroupBy === "lender");
  $("#owed-group-adviser").classList.toggle("scope-active", owedGroupBy === "adviser");

  if (!m.n) {
    $("#report-owed-table").innerHTML = '<div class="empty">Nothing outstanding — every completed case with a fee on it has a date against the money. 👏</div>';
    return;
  }
  const groupOf = (r) => owedGroupBy === "lender"
    ? (r.c.lender || "(no lender recorded)")
    : (r.c.assigned_to ? (profileName(r.c.assigned_to) || staffName(r.c.assigned_to)) : "(unassigned)");
  const groups = new Map();
  m.rows.forEach((r) => { const k = groupOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const cols = m.bucketList.map((b) => b.key);
  const sorted = [...groups.entries()].sort((a, b) => {
    const at = a[1].reduce((s, r) => s + r.total, 0), bt = b[1].reduce((s, r) => s + r.total, 0);
    return bt - at;
  });
  const cellsFor = (rows) => cols.map((k) => {
    const t = rows.filter((r) => r.bucket === k).reduce((s, r) => s + r.total, 0);
    // R74 · A2 — a lender with nothing owed in this band owes £0; that is an answer, not a gap.
    return `<td class="owed-cell">${zeroMoney(t)}</td>`;
  }).join("");
  const body = sorted.map(([name, rows]) => {
    const gTot = rows.reduce((s, r) => s + r.total, 0);
    const head = `<tr class="owed-group-row"><td><strong>${owedGroupBy === "lender" ? lenderIcon(name === "(no lender recorded)" ? "" : name) : ""}${esc(name)}</strong> <span class="cs-muted">${rows.length} case${rows.length === 1 ? "" : "s"}</span></td>${cellsFor(rows)}<td class="owed-cell"><strong>${fmtM(gTot)}</strong></td></tr>`;
    const caseRows = rows.slice().sort((a, b) => (b.days ?? -1) - (a.days ?? -1)).map((r) => {
      const parts = r.lines.map((l) => `${l.label} ${fmtM(l.amount)}`).join(" · ");
      return `<tr class="owed-case-row" onclick="openCase('${r.id}')" title="Open this case">
        <td class="owed-case-cell">${esc([r.c.clients?.first_name, r.c.clients?.last_name].filter(Boolean).join(" ")) || "(no name)"}
          ${propChip(r.c, { cls: "row-prop" }) || ""}
          <div class="s">${esc(parts)}${r.c.completed_at ? ` · completed ${fmtD(r.c.completed_at)}` : ""}${r.days == null ? " · <em>no completion date recorded</em>" : ` · ${r.days}d`}</div></td>
        ${cols.map((k) => `<td class="owed-cell">${r.bucket === k ? fmtM(r.total) : '<span class="cs-muted">—</span>'}</td>`).join("")}
        <td class="owed-cell">${fmtM(r.total)}</td>
      </tr>`;
    }).join("");
    return head + caseRows;
  }).join("");
  $("#report-owed-table").innerHTML = `<div style="overflow-x:auto;"><table class="imp-table owed-table" id="owed-table">
    <tr><th>${owedGroupBy === "lender" ? "Lender" : "Adviser"}</th>${cols.map((k) => `<th>${esc(OWED_BUCKET_LABEL[k])}</th>`).join("")}<th>Total owed</th></tr>
    ${body}
    <tr class="owed-total-row"><td><strong>All ${owedGroupBy === "lender" ? "lenders" : "advisers"}</strong></td>${cellsFor(m.rows)}<td class="owed-cell"><strong>${fmtM(m.grand)}</strong></td></tr>
  </table></div>
  <p class="panel-sub" style="margin:10px 0 0;">Both groupings hold the same ${m.n} case${m.n === 1 ? "" : "s"} and add to the same ${fmtM(m.grand)} — the toggle changes who you would chase, never what is outstanding. Click any case row to open it.</p>`;
}
window.setOwedGroup = function (g) {
  if (g === owedGroupBy) return;
  owedGroupBy = g;
  renderMoneyOwed(owedState.all || []);
};
/* R7-1c — the owner export. It carries the proc and sols columns the pipeline
   CSV has never had: this file is the chase list, and a proc fee you cannot see
   is a proc fee nobody rings the lender about. Owner-only, like the panel. */
window.exportOwedCsv = function () {
  if (!showMoney()) return toast("The money-owed export is Owner-only.");
  const m = owedState.model;
  if (!m || !m.n) return toast("Nothing outstanding to export.");
  const q2 = (v) => {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const head = ["Client", "Property", "Adviser", "Lender", "Completed", "Days since completion", "Ageing bucket",
                "Proc fee owed", "Sols fee owed", "Broker fee owed", "Total owed", "Fee status", "Case id"];
  const lines = [head.map(q2).join(",")].concat(m.rows
    .slice()
    .sort((a, b) => (b.days ?? -1) - (a.days ?? -1))
    .map((r) => [
      [r.c.clients?.first_name, r.c.clients?.last_name].filter(Boolean).join(" "),
      propAddress(r.c) || "",
      r.c.assigned_to ? staffName(r.c.assigned_to) : "",
      r.c.lender || "",
      (r.c.completed_at || "").slice(0, 10),
      r.days == null ? "" : r.days,
      OWED_BUCKET_LABEL[r.bucket],
      r.proc || "", r.sols || "", r.broker || "", r.total,
      r.c.fee_status || "",
      r.id,
    ].map(q2).join(",")));
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `money-owed-${localDateStr()}.csv`;
  a.click();
  toast(`Exported ${m.n} case${m.n === 1 ? "" : "s"} · ${fmtM(m.grand)} outstanding`);
};
/* R7-1d — where the fee_aging_60 Watchtower alerts land. */
window.gotoMoneyOwed = function () {
  if (!showMoney()) return toast("Money owed is Owner-only.");
  nav("reports");
  // R74 · A4c — through repRevealPanel, so arriving from Watchtower selects "Money & book" on the
  // section strip rather than dropping the reader into a section the tabs say they are not in.
  setTimeout(() => { window.repRevealPanel("#report-owed-panel"); }, 350);
};

/* --------------------------------------------------------------------------
   R7-2 — RATE-END BOOK VALUE.

   The completed book, laid out by when each mortgage's rate matures over the
   next 24 months. Three things it is careful about:

   · WHOSE ROWS. Completed cases only, and only those carrying a rate end date.
     A live case's rate end is a plan, not book value.

   · DE-DUPLICATION. One building whose rate ends on one date is ONE maturity,
     however many case rows the firm holds for it — a product transfer followed
     by a remortgage on the same flat is two cases and one mortgage. Rows are
     collapsed on propKey + rate_end_date and badged "N cases", and the
     surviving row is the most recently completed one (the live mortgage). Both
     the ledger totals and the per-case list use the collapsed set, so the book
     is not double-counted. Cases with no address cannot be collapsed and are
     never guessed at — they each stand alone.

   · THE FEE. There is no "expected fee" column anywhere in the schema, so the
     LAST fee the firm earned on that mortgage is used as the proxy, and the
     column says so in its header rather than in a footnote nobody reads. Cases
     with no fee recorded are counted in the case count and contribute nothing
     to the value — the expected figure is a floor, and the row says how many
     cases are behind it.
   -------------------------------------------------------------------------- */
const RATE_BUCKETS = [
  { key: "0-3", label: "0–3 months", lo: 0, hi: 3 },
  { key: "3-6", label: "3–6 months", lo: 3, hi: 6 },
  { key: "6-12", label: "6–12 months", lo: 6, hi: 12 },
  { key: "12-24", label: "12–24 months", lo: 12, hi: 24 },
];
/* Calendar-month arithmetic on a plain YYYY-MM-DD, at local midday so no
   timezone can move a maturity into the previous day (and so into the previous
   bucket). Month overflow follows the platform (31 Jan + 1 month = 3 Mar);
   that is deterministic, which is what the buckets need. */
function dateAddMonths(dateStr, n) {
  const s = String(dateStr || "");
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)) - 1, d = Number(s.slice(8, 10));
  if (!y) return s;
  return localDateStr(new Date(y, m + n, d, 12, 0, 0));
}
const caseLastFee = (c) => Number((c && c.proc_fee) || 0) + Number((c && c.broker_fee) || 0) + Number((c && c.sols_fee) || 0);
/* The collapse key: one building, one maturity date. Empty when the case has no
   usable address — those never merge with anything. */
function rateEndDedupeKey(c) {
  const k = propKey(c);
  return k ? k + "|" + (c.rate_end_date || "") : "";
}
function dedupeRateEndRows(rows) {
  const byKey = new Map();
  const out = [];
  (rows || []).forEach((c) => {
    const k = rateEndDedupeKey(c);
    if (!k) { out.push({ c, dupes: 1, others: [] }); return; }
    if (!byKey.has(k)) { const e = { c, dupes: 1, others: [] }; byKey.set(k, e); out.push(e); return; }
    const e = byKey.get(k);
    e.dupes++;
    // Keep the most recently completed row — that is the mortgage actually in force.
    const newer = String(c.completed_at || "") > String(e.c.completed_at || "")
      || (String(c.completed_at || "") === String(e.c.completed_at || "") && String(c.id) > String(e.c.id));
    if (newer) { e.others.push(e.c); e.c = c; } else e.others.push(c);
  });
  return out;
}
function rateEndBookModel(all) {
  const today = localDateStr();
  const edges = [0, 3, 6, 12, 24].map((n) => dateAddMonths(today, n));
  const inWindow = (all || []).filter((c) => c.stage === "completed" && c.rate_end_date
    && c.rate_end_date >= edges[0] && c.rate_end_date < edges[4]);
  const entries = dedupeRateEndRows(inWindow);
  const buckets = RATE_BUCKETS.map((b, i) => ({ key: b.key, label: b.label, from: edges[i], to: edges[i + 1], entries: [] }));
  entries.forEach((e) => {
    const d = e.c.rate_end_date;
    const b = buckets.find((x) => d >= x.from && d < x.to) || buckets[buckets.length - 1];
    b.entries.push(e);
  });
  buckets.forEach((b) => {
    b.entries.sort((x, y) => (x.c.rate_end_date < y.c.rate_end_date ? -1 : x.c.rate_end_date > y.c.rate_end_date ? 1 : 0));
    b.n = b.entries.length;
    b.loan = b.entries.reduce((s, e) => s + Number(e.c.loan_amount || 0), 0);
    b.fee = b.entries.reduce((s, e) => s + caseLastFee(e.c), 0);
    b.noFee = b.entries.filter((e) => !caseLastFee(e.c)).length;
    b.merged = b.entries.filter((e) => e.dupes > 1).length;
  });
  return {
    buckets, edges,
    n: buckets.reduce((s, b) => s + b.n, 0),
    loan: buckets.reduce((s, b) => s + b.loan, 0),
    fee: buckets.reduce((s, b) => s + b.fee, 0),
    noFee: buckets.reduce((s, b) => s + b.noFee, 0),
    rawN: inWindow.length,
  };
}
/* The RECOVER lane. A completed case whose rate has ALREADY ended and which has
   no successor case is money that has walked out of the door unnoticed — the
   nightly queue only ever looks FORWARD into the reminder window, so nothing
   automatic will ever pick it up again. The backend's recovery sweep now
   creates successors for these; the lane deliberately shows BOTH sides, because
   "the sweep handled 4" and "3 are still uncovered" are different sentences and
   only one of them is work. */
function rateEndRecoverModel(all) {
  const today = localDateStr();
  const successorOf = new Set((all || []).filter((c) => c.retention_source_case_id).map((c) => c.retention_source_case_id));
  const past = (all || []).filter((c) => c.stage === "completed" && c.rate_end_date && c.rate_end_date < today);
  const covered = past.filter((c) => successorOf.has(c.id));
  const uncovered = past.filter((c) => !successorOf.has(c.id));
  const value = (rows) => rows.reduce((s, c) => s + caseLastFee(c), 0);
  return { past, covered, uncovered, coveredValue: value(covered), uncoveredValue: value(uncovered),
           uncoveredLoan: uncovered.reduce((s, c) => s + Number(c.loan_amount || 0), 0) };
}
let rateEndOpen = new Set();
let rateEndState = { all: null };
function renderRateEndBook(all) {
  const panel = $("#report-rateend-panel");
  if (!panel) return;
  rateEndState.all = all || [];
  if (!showMoney()) {
    panel.classList.add("hidden");
    $("#report-rateend-table").innerHTML = "";
    $("#report-rateend-recover").innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  const m = rateEndBookModel(all);
  const merged = m.buckets.reduce((s, b) => s + b.merged, 0);
  $("#report-rateend-basis").innerHTML =
    `Completed cases carrying a rate end date, bucketed by how far off that date is. `
    + `<strong>Loan balance</strong> is the loan recorded on the case (not a redemption figure). `
    + `<strong>Expected fee</strong> uses the <em>last fee earned on that mortgage</em> (proc + broker + sols) as a proxy — it is not a forecast and nothing weights it for whether the client stays. `
    + (merged ? `${merged} maturit${merged === 1 ? "y is" : "ies are"} held by more than one case on the same property and the same date; each is counted <strong>once</strong> (${m.rawN} case rows → ${m.n} maturities). ` : "")
    + (m.noFee ? `${m.noFee} of ${m.n} have no fee recorded and add nothing to the value, so the expected figure is a floor. ` : "")
    + `<span class="money-basis">(book value · completed cases · last fee as proxy · next 24 months)</span>`;

  const rows = m.buckets.map((b) => {
    const open = rateEndOpen.has(b.key);
    const head = `<tr class="rb-bucket-row${open ? " is-open" : ""}" onclick="toggleRateBucket('${b.key}')" title="${b.n ? "Show the cases behind this bucket" : "No maturities in this bucket"}">
      <td><span class="rb-caret">${b.n ? (open ? "▾" : "▸") : "·"}</span> <strong>${esc(b.label)}</strong> <span class="cs-muted">${esc(fmtD(b.from))} – ${esc(fmtD(b.to))}</span></td>
      <td>${b.n}</td>
      <td class="num">${fmtM(b.loan)}</td>
      <td class="num">${fmtM(b.fee)}</td>
      <td class="num">${fmtM(b.fee)} <span class="cs-muted rb-proxy" title="Last fee earned on the same mortgage, used as a proxy — not a forecast.">proxy</span>${b.noFee ? `<div class="s">${b.noFee} with no fee recorded</div>` : ""}</td>
    </tr>`;
    if (!open || !b.n) return head;
    return head + b.entries.map((e) => {
      const c = e.c;
      return `<tr class="rb-case-row" onclick="openCase('${c.id}')" title="Open this case">
        <td class="rb-case-cell">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ")) || "(no name)"}
          ${propChip(c, { cls: "row-prop" }) || '<span class="cs-muted">no property recorded</span>'}
          ${e.dupes > 1 ? `<span class="badge grey" title="${e.dupes} cases share this property and this rate end date — counted once. The most recently completed one is shown.">${e.dupes} cases</span>` : ""}
          <div class="s">${lenderIcon(c.lender)}${esc(c.lender || "no lender")} · rate ends ${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""}</div></td>
        <td></td>
        <td class="num">${c.loan_amount ? fmtM(c.loan_amount) : '<span class="cs-muted">—</span>'}</td>
        <td class="num">${caseLastFee(c) ? fmtM(caseLastFee(c)) : '<span class="cs-muted">none recorded</span>'}</td>
        <td></td>
      </tr>`;
    }).join("");
  }).join("");
  $("#report-rateend-table").innerHTML = `<div style="overflow-x:auto;"><table class="imp-table rb-table" id="rateend-table">
    <tr><th>Maturing in</th><th>Cases</th><th>Loan balance</th><th>Last fee earned</th><th title="The last fee earned on the same mortgage, used as a proxy for what a renewal would earn.">Expected fee (proxy)</th></tr>
    ${rows}
    <tr class="rb-total-row"><td><strong>Next 24 months</strong></td><td><strong>${m.n}</strong></td><td class="num"><strong>${fmtM(m.loan)}</strong></td><td class="num"><strong>${fmtM(m.fee)}</strong></td><td class="num"><strong>${fmtM(m.fee)}</strong></td></tr>
  </table></div>`;

  const rec = rateEndRecoverModel(all);
  $("#report-rateend-recover").innerHTML = `
    <div class="panel-head-row"><h3 style="margin:0;">Recover — rates that already ended</h3>
      <span class="badge ${rec.uncovered.length ? "red" : "green"}">${rec.uncovered.length} uncovered</span></div>
    <p class="panel-sub">Completed cases whose rate end date has already passed. ${rec.covered.length} of ${rec.past.length} already have a follow-on case — created by the retention flow, by hand, or by the overnight recovery sweep; this panel does not distinguish between those and does not claim to. ${rec.uncovered.length ? `<strong>${rec.uncovered.length}</strong> still have none, worth ${fmtM(rec.uncoveredValue)} at last-fee rates on ${fmtM(rec.uncoveredLoan)} of lending.` : "Nothing is uncovered."} <span class="money-basis">(completed · rate end in the past · successor = a case whose retention_source_case_id points here)</span></p>
    ${rec.uncovered.length ? `<div id="rateend-recover-list">${rec.uncovered
      .slice()
      .sort((a, b) => (a.rate_end_date < b.rate_end_date ? -1 : 1))
      .slice(0, 20)
      .map((c) => `<div class="row-item rb-recover-row">
        <div class="row-main">
          <div class="t" onclick="openCase('${c.id}')">${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ")) || "(no name)"} ${propChip(c, { cls: "row-prop" }) || ""}</div>
          <div class="s">${lenderIcon(c.lender)}${esc(c.lender || "no lender")} — rate ended ${fmtD(c.rate_end_date)} (${daysSince(c.rate_end_date)} ${daysSince(c.rate_end_date) === 1 ? "day" : "days"} ago) · last fee ${caseLastFee(c) ? fmtM(caseLastFee(c)) : "none recorded"}</div>
          ${/* R12b · W-15c — the reason to ring them today, on the row that lists the ones nobody
               has rung. Rendered only when the balance, the reversion rate and the ended rate are
               all on the case; a missing input shows nothing at all rather than a £0 that would be
               read as "no difference". */ ""}
          ${upliftLineHtml(c)}
        </div>
        ${retentionToMeHtml(c.id, c)}
        <button class="btn btn-sm btn-retention" onclick="event.stopPropagation();startRetentionCase('${c.id}', event)" title="Create the follow-on remortgage case, the call task and a queued reminder">🔁 Start retention case</button>
      </div>`).join("")}${rec.uncovered.length > 20 ? `<div class="empty">…and ${rec.uncovered.length - 20} more.</div>` : ""}</div>`
      : '<div class="empty">Every completed case whose rate has ended already has a follow-on case. Nothing to recover. 👍</div>'}`;
}
window.toggleRateBucket = function (key) {
  if (rateEndOpen.has(key)) rateEndOpen.delete(key); else rateEndOpen.add(key);
  if (rateEndState.all) renderRateEndBook(rateEndState.all);
};

/* --------------------------------------------------------------------------
   R7-3a — the protection quote clock's shared arithmetic.
   -------------------------------------------------------------------------- */
const QUOTE_AGE_AMBER = 7, QUOTE_AGE_RED = 14;
function quoteAgeBadge(quotedAt) {
  if (!quotedAt) return `<span class="badge grey q-age" title="This case is quoted but carries no quote date — it was set before the quote clock existed, or the database has not taken the migration that stores it.">quote age unknown</span>`;
  const d = daysSince(quotedAt);
  const cls = d > QUOTE_AGE_RED ? "red" : d >= QUOTE_AGE_AMBER ? "amber" : "green";
  const word = d > QUOTE_AGE_RED ? "cold" : d >= QUOTE_AGE_AMBER ? "ageing" : "fresh";
  return `<span class="badge ${cls} q-age" title="Quoted ${fmtD(quotedAt)} — ${d} day${d === 1 ? "" : "s"} ago. Green under ${QUOTE_AGE_AMBER} days, amber ${QUOTE_AGE_AMBER}–${QUOTE_AGE_RED}, red over ${QUOTE_AGE_RED}.">${d}d · ${word}</span>`;
}
/* M8 feature detection, by absence and then by refusal — the same discipline as
   M1/M2/M7 elsewhere in this file. Null means "not asked yet"; false means the
   database answered 42703 and the stamp is silently dropped from every write
   from then on, rather than failing the status change the adviser asked for. */
let PROT_QUOTE_SUPPORTED = null;
async function protQuoteSupported() {
  if (PROT_QUOTE_SUPPORTED !== null) return PROT_QUOTE_SUPPORTED;
  try {
    const { error } = await db.from("cases").select("id,protection_quoted_at,protection_quoted_by").limit(1);
    PROT_QUOTE_SUPPORTED = !error;
  } catch (_) { PROT_QUOTE_SUPPORTED = false; }
  return PROT_QUOTE_SUPPORTED;
}
/* One batched read of the quote stamps for the rows on screen. Returns {} when
   the column isn't there, so every consumer degrades to "quote age unknown"
   rather than throwing. */
async function loadQuoteStamps(caseIds) {
  const ids = [...new Set((caseIds || []).filter(Boolean))];
  if (!ids.length) return {};
  if (!(await protQuoteSupported())) return {};
  try {
    const { data, error } = await inChunks(ids, (sl) => db.from("cases").select("id,protection_quoted_at,protection_quoted_by").in("id", sl));
    if (error) return {};
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) map[r.id] = r; });
    return map;
  } catch (_) { return {}; }
}

/* ==========================================================================
   R7-5 — LEAD RESPONSE (Reports, Owner-only).

   The one number nobody could produce: how long this firm takes to answer a
   website enquiry. It is measured from `created_at` (the enquiry landing) to
   `first_contact_at` (a human taking it on — see acceptLead / discardLead),
   and it is measured on nothing else. In particular it does NOT use
   `acknowledged_at`: the automatic "we've got it" email goes out inside a
   minute of every enquiry with an email address, so a report built on it would
   show a sixty-second response time for a lead nobody has rung in two days.

   MEDIAN AND p90 TOGETHER, always. A median answers "what normally happens";
   it is also the statistic that hides a tail, and the tail is the whole
   problem — five leads answered in four minutes and one left for thirty hours
   is a median of four minutes and a lost client. p90 is nearest-rank (the
   value at position ceil(0.9n) of the sorted list), so it is always a real
   response time that really happened, never an interpolation between two.

   AND THE HONEST EMPTY STATE. Production has zero stamps today: the columns
   landed this round and nothing has written one yet. So the panel says that,
   in words, and shows what it CAN see — how many enquiries are past the
   promise right this minute — rather than drawing an empty chart and letting
   it read as "nobody waits long".
   ========================================================================== */
const LEAD_RESP_WINDOW_DAYS = 90;
const LEAD_RESP_ROW_CAP = 2000;
function leadRespMedian(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function leadRespP90(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}
/* Minutes, read out the way a person says them. Deliberately not the compact
   fmtWaitMins used on the inbox chip: a table of response times wants "1h 47m",
   a badge on a row wants "1h". */
function fmtRespMins(m) {
  if (m == null) return "—";
  if (m < 60) return `${m}min`;
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h}h ${r}m` : `${h}h`; }
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? `${d}d ${h}h` : `${d}d`;
}
/* A lead is "won" when it carries the case it became, or when its status says
   somebody took it on. Both are checked because the two are written by
   different things: converted_case_id by acceptLead, the status by the website
   integration and by anything that accepted a lead before that link existed. */
const leadIsWon = (l) => !!(l && (l.converted_case_id || ["converted", "accepted"].includes(String(l.status || "").toLowerCase())));
/* Source: the same expression Monday money's lead table uses, so the two
   panels group the same enquiries the same way. */
const leadRespSourceOf = (l) => String((l && (l.source || l.lead_source || l.enquiry_type)) || "").trim() || "(not recorded)";
function leadRespModel(leads, cases) {
  const rows = Array.isArray(leads) ? leads : [];
  const cutoff = Date.now() - LEAD_RESP_WINDOW_DAYS * 86400000;
  const caseAdviser = {};
  (cases || []).forEach((c) => { if (c && c.id) caseAdviser[c.id] = c.assigned_to || null; });
  const inWindow = rows.filter((l) => {
    const t = l && l.created_at ? new Date(l.created_at).getTime() : NaN;
    return !isNaN(t) && t >= cutoff;
  });
  const withMins = inWindow.map((l) => ({
    lead: l,
    mins: leadResponseMins(l.created_at, l.first_contact_at),
    source: leadRespSourceOf(l),
    adviser: (l.converted_case_id && caseAdviser[l.converted_case_id]) || null,
    won: leadIsWon(l),
  }));
  const responded = withMins.filter((r) => r.mins != null);
  /* Breaching NOW, and deliberately counted over every lead still sitting in
     the inbox rather than only those inside the 90-day window: a lead that has
     been ignored since the spring is the worst row on the screen, and dropping
     it out of the count because it is old is exactly backwards. */
  const breaching = rows.filter((l) => l && l.status === "new" && !l.first_contact_at
    && (leadAgeMins(l.created_at) ?? -1) >= LEAD_SLA_MIN);
  const group = (keyOf, labelOf) => {
    const map = new Map();
    withMins.forEach((r) => {
      const k = keyOf(r);
      if (!map.has(k)) map.set(k, { key: k, label: labelOf(k, r), leads: 0, won: 0, mins: [] });
      const g = map.get(k);
      g.leads++;
      if (r.won) g.won++;
      if (r.mins != null) g.mins.push(r.mins);
    });
    return [...map.values()].map((g) => ({
      ...g,
      n: g.mins.length,
      median: leadRespMedian(g.mins),
      p90: leadRespP90(g.mins),
      conv: g.leads ? Math.round((g.won / g.leads) * 100) : null,
    })).sort((a, b) => b.leads - a.leads || String(a.label).localeCompare(String(b.label)));
  };
  return {
    windowDays: LEAD_RESP_WINDOW_DAYS,
    all: withMins,
    responded,
    nLeads: withMins.length,
    nResponded: responded.length,
    won: withMins.filter((r) => r.won).length,
    conv: withMins.length ? Math.round((withMins.filter((r) => r.won).length / withMins.length) * 100) : null,
    median: leadRespMedian(responded.map((r) => r.mins)),
    p90: leadRespP90(responded.map((r) => r.mins)),
    bySource: group((r) => r.source, (k) => k),
    byAdviser: group((r) => r.adviser || "", (k) => (k ? (profileName(k) || staffName(k)) : "(no adviser recorded)")),
    breaching,
  };
}
let leadRespState = { model: null };
function renderLeadResponse(leads, cases) {
  const panel = $("#report-leadresp-panel");
  if (!panel) return;
  if (!showMoney()) {
    panel.classList.add("hidden");
    leadRespState.model = null;
    ["#report-leadresp-headline", "#report-leadresp-source", "#report-leadresp-adviser", "#leadresp-tools"].forEach((s) => { const el = $(s); if (el) el.innerHTML = ""; });
    return;
  }
  panel.classList.remove("hidden");
  const m = leadRespModel(leads, cases);
  leadRespState.model = m;
  const slaOff = LEAD_SLA_SUPPORTED === false;
  $("#report-leadresp-basis").innerHTML =
    `Website enquiries created in the last <strong>${m.windowDays} days</strong> (${m.nLeads} of them). Response time is <code>first_contact_at − created_at</code> — the moment a person accepted the lead, or discarded it having made contact — and is counted only where BOTH exist. `
    + `The automatic acknowledgement is <strong>not</strong> a response and is not measured here. `
    + `<strong>p90</strong> is nearest-rank: the value at position ceil(0.9 × n), so it is always a wait somebody really had. `
    + `<strong>Conversion</strong> is the share of enquiries in the window that became a case, answered or not. `
    + `Source is the enquiry type the website form recorded; adviser is whoever the accepted lead's case was created for. `
    + (slaOff ? `<strong style="color:var(--red);">This database has no first_contact_at column yet, so nothing can be measured — run the lead-SLA migration.</strong> ` : "")
    + ((leads || []).length >= LEAD_RESP_ROW_CAP ? `<strong style="color:var(--red);">Only the newest ${LEAD_RESP_ROW_CAP.toLocaleString("en-GB")} enquiries were read — these figures describe that subset, not the whole book.</strong> ` : "")
    + `<span class="money-basis">(leads · first_contact_at − created_at · last ${m.windowDays} days)</span>`;

  const nBreach = m.breaching.length;
  $("#leadresp-tools").innerHTML = `<button type="button" class="btn btn-sm${nBreach ? " btn-danger" : ""}" id="leadresp-breach-btn" onclick="gotoLeadInbox()" title="${nBreach ? `${nBreach} enquir${nBreach === 1 ? "y is" : "ies are"} past the ${LEAD_SLA_MIN}-minute promise right now — open My Day on Today.` : "Nothing is past the promise right now. Open My Day on Today."}">${nBreach ? `⏱ ${nBreach} breaching now` : "⏱ none breaching"} →</button>`;

  $("#report-leadresp-headline").innerHTML = [
    `<div class="kpi kpi-headline"><div class="num">${m.nResponded ? esc(fmtRespMins(m.median)) : "—"}</div><div class="lbl">Median response</div><div class="s">${m.nResponded} of ${m.nLeads} enquir${m.nLeads === 1 ? "y" : "ies"} answered</div></div>`,
    `<div class="kpi${m.p90 != null && m.p90 > LEAD_SLA_RED_MIN ? " bad" : ""}"><div class="num">${m.nResponded ? esc(fmtRespMins(m.p90)) : "—"}</div><div class="lbl">p90 response</div><div class="s">${m.nResponded ? `9 in 10 answered inside this` : "no answered enquiries yet"}</div></div>`,
    `<div class="kpi"><div class="num">${m.conv == null ? "—" : m.conv + "%"}</div><div class="lbl">Conversion</div><div class="s">${m.won} of ${m.nLeads} became a case</div></div>`,
    `<div class="kpi dq-clickable${nBreach ? " bad" : ""}" onclick="gotoLeadInbox()" title="Open the waiting enquiries in My Day on Today"><div class="num" id="leadresp-breach-n">${nBreach}</div><div class="lbl">Breaching now</div><div class="s">waiting over ${LEAD_SLA_MIN} min, nobody yet</div></div>`,
  ].join("");

  const tableFor = (groups, headWord, emptyWord) => {
    if (!groups.length) return `<div class="empty">${esc(emptyWord)}</div>`;
    return `<div style="overflow-x:auto;"><table class="imp-table leadresp-table">
      <tr><th>${esc(headWord)}</th><th>Enquiries</th><th>Answered</th><th>Median</th><th>p90</th><th>Became a case</th></tr>
      ${groups.map((g) => `<tr data-lr-key="${esc(g.key)}">
        <td><strong>${esc(g.label)}</strong></td>
        <td>${g.leads}</td>
        <td>${g.n ? g.n : '<span class="cs-muted">none</span>'}</td>
        <td>${g.n ? esc(fmtRespMins(g.median)) : '<span class="cs-muted">—</span>'}</td>
        <td>${g.n ? esc(fmtRespMins(g.p90)) : '<span class="cs-muted">—</span>'}</td>
        <td>${g.conv == null ? '<span class="cs-muted">—</span>' : `${g.conv}% <span class="cs-muted">(${g.won}/${g.leads})</span>`}</td>
      </tr>`).join("")}
      <tr class="owed-total-row"><td><strong>All ${esc(headWord.toLowerCase())}s</strong></td><td><strong>${m.nLeads}</strong></td><td><strong>${m.nResponded}</strong></td>
        <td><strong>${m.nResponded ? esc(fmtRespMins(m.median)) : "—"}</strong></td>
        <td><strong>${m.nResponded ? esc(fmtRespMins(m.p90)) : "—"}</strong></td>
        <td><strong>${m.conv == null ? "—" : m.conv + "%"}</strong></td></tr>
    </table></div>`;
  };
  /* THE EMPTY STATE. Not "0min" and not a blank table: the reason there is
     nothing, what will fill it, and the one figure that is real today. */
  if (!m.nLeads) {
    const none = `<div class="empty">No website enquiry has arrived in the last ${m.windowDays} days, so there is nothing to measure.</div>`;
    $("#report-leadresp-source").innerHTML = none;
    $("#report-leadresp-adviser").innerHTML = "";
    return;
  }
  if (!m.nResponded) {
    $("#report-leadresp-source").innerHTML = `<div class="empty leadresp-empty">No data yet — none of the ${m.nLeads} enquir${m.nLeads === 1 ? "y" : "ies"} in the last ${m.windowDays} days carries a first-contact time.
      ${slaOff ? "This database has no <code>first_contact_at</code> column yet." : `The stamp is written the first time somebody Accepts one from My Day on Today, or discards one having made contact. Nothing here is estimated in the meantime.`}
      ${nBreach ? `<br><strong>${nBreach} of them ${nBreach === 1 ? "is" : "are"} past the ${LEAD_SLA_MIN}-minute promise right now.</strong>` : ""}</div>`;
    $("#report-leadresp-adviser").innerHTML = "";
    return;
  }
  $("#report-leadresp-source").innerHTML = `<h4 class="leadresp-h">By source</h4>` + tableFor(m.bySource, "Source", "No enquiries in the window.");
  $("#report-leadresp-adviser").innerHTML = `<h4 class="leadresp-h">By adviser</h4>` + tableFor(m.byAdviser, "Adviser", "No enquiries in the window.")
    + `<p class="panel-sub" style="margin:10px 0 0;">An enquiry with no case behind it has no adviser — it was never accepted, or it was accepted before the lead-to-case link existed — and it is counted in the “no adviser recorded” row rather than dropped. It is still an enquiry the firm received, and leaving it out would flatter every column beside it.</p>`;
}

/* --------------------------------------------------------------------------
   R7-4 — MONDAY MONEY.
   -------------------------------------------------------------------------- */
/* The completed week before the current one, Monday to Sunday inclusive. "Last
   week" on a Monday morning means the week that just finished, and every figure
   on the page shares this one definition so they can be added together. */
function lastWeekRange() {
  const t = new Date(localDateStr() + "T12:00:00");
  const dow = (t.getDay() + 6) % 7;                       // 0 = Monday
  const thisMon = new Date(t.getTime() - dow * R7_DAY);
  return {
    start: localDateStr(new Date(thisMon.getTime() - 7 * R7_DAY)),
    end: localDateStr(new Date(thisMon.getTime() - R7_DAY)),
  };
}
/* Cash actually collected between two YYYY-MM-DD dates inclusive, per fee type
   on its own paid date — the same walk cashInMonth() does, with a date range
   instead of a month, and the identical future-date clamp. */
function cashInRange(rows, from, to, types) {
  const today = localDateStr();
  const wanted = FEE_TYPES.filter((f) => (types || ["proc", "sols", "broker"]).indexOf(f.key) >= 0);
  let total = 0, n = 0, futureN = 0;
  (rows || []).forEach((c) => {
    wanted.forEach((f) => {
      const amt = Number(c[f.amountCol] || 0);
      if (!amt) return;
      const d = feeCashDate(c, f.dateCol);
      if (!d) return;
      const ds = localDateStr(d);
      if (ds < from || ds > to) return;
      if (ds > today) { futureN++; return; }
      total += amt; n++;
    });
  });
  return { total, n, futureN };
}
const MONEY_EMPTY = (what) => `<div class="empty">${esc(what)}</div>`;
/* R81 · A2 — the Money page's seq-guard token (the R78 idiom: newest load wins; a stale
   load returns silently after every await instead of painting over the newer one). */
let moneyLoadSeq = 0;
/* R81 · A2 — ONE read of the quote stamps for every case sitting at Quoted, so the stamps no
   longer wait for the main cases read to hand over ids (that dependency alone cost a wave).
   Filtering server-side on protection_status returns exactly the rows the cold-quotes panel
   consults (`stamps[c.id]` is only ever read for quoted cases). The feature-detect is FOLDED
   into the read itself: a database without the M-columns answers 42703 here just as it did on
   protQuoteSupported()'s probe, and the same {} degrade applies — with PROT_QUOTE_SUPPORTED
   stamped either way so the Protection page's own probe is answered for free. */
async function moneyQuoteStampsAll() {
  if (PROT_QUOTE_SUPPORTED === false) return {};
  try {
    const { data, error } = await readAll(db.from("cases")
      .select("id,protection_quoted_at,protection_quoted_by")
      .eq("protection_status", "quoted").order("id"), { cap: REPORTS_ROW_CAP });
    if (error) { if (isMissingColumnError(error)) PROT_QUOTE_SUPPORTED = false; return {}; }
    PROT_QUOTE_SUPPORTED = true;
    const map = {};
    (data || []).forEach((r) => { if (r && r.id) map[r.id] = r; });
    return map;
  } catch (_) { return {}; }
}
async function loadMoneyPage() {
  const seq = ++moneyLoadSeq;   // R81 · A2 — seq-guard
  const denied = $("#money-denied"), body = $("#money-body"), scope = $("#money-scope");
  if (!showMoney()) {
    /* Belt and braces behind nav()'s redirect: if this ever renders for anyone
       but the Owner it renders nothing but the reason. */
    if (body) body.classList.add("hidden");
    if (scope) scope.textContent = "";
    if (denied) {
      denied.classList.remove("hidden");
      denied.textContent = "Monday money is the firm's whole book — fees banked, fees owed, book value and per-adviser figures — so it is shown to the Owner only. Your own numbers are on the Reports page, in the My numbers card.";
    }
    /* R44 — belt and braces on top of #money-body's own .hidden: the two
       reconciliation panels are emptied AND hidden for a non-owner, and the
       cached rate card is dropped, so nothing about the firm's commission
       statements is left in the page for anybody who should not have it. */
    procRatesCache = null;
    await renderProcRatesPanel();
    await renderReconPanel();
    return;
  }
  if (denied) { denied.classList.add("hidden"); denied.textContent = ""; }
  if (body) body.classList.remove("hidden");
  const wk = lastWeekRange();
  if (scope) scope.textContent = `Last week means ${fmtD(wk.start)} to ${fmtD(wk.end)} (Monday to Sunday, Europe/London). Every figure below is computed in this browser from the same rows the rest of the app reads — nothing here is a separate report. ${ATTRIB_NOTE}`;

  /* R81 · A2 — TWO WAVES, down from six. WAVE 1 fires every read that does not need the cases
     rows: the three side tables, the M2 fee-date columns, the quoted-case stamps (see
     moneyQuoteStampsAll above), the R44 rate card, the R44 statements list — plus the
     property-address feature probe, which is the ONE answer the big cases select's column list
     depends on (usually cached from an earlier page; joins wave 1 when it is not). WAVE 2 is
     the cases read itself, fired together with renderReconPanel(pre) so the panel's per-line
     counter read shares the wave. The R44 panels then render from data already in hand.
     Merge order below is unchanged from R80 — only WHEN each read starts moved. */
  const [propOnRaw, tasksRes, leadsRes, eventsRes, extra, stamps, ratesPre, stmtsPre] = await Promise.all([
    propAddrSupported(),
    readAll(db.from("case_tasks").select("id,assigned_to,due_date,done_at").is("done_at", null).order("id"), { cap: REPORTS_ROW_CAP }),
    readAll(db.from("leads").select("*").order("id"), { cap: REPORTS_ROW_CAP }),
    readAll(db.from("case_events").select("case_id,event,created_at").eq("event", "stage_changed").order("created_at").order("id"), { cap: REPORTS_ROW_CAP }),
    // The per-fee-type paid dates live behind M2 and are read in their own small
    // query for exactly the reason loadCaseExtraColumns exists: an un-migrated
    // database must cost the itemised dates, not the whole page.
    loadCaseExtraColumns(),
    moneyQuoteStampsAll(),
    loadProcRates(true),   // forces a fresh rate card exactly as the old `procRatesCache = null` + re-read did
    db.from("commission_statements")
      .select("id,ref,statement_label,statement_date,filename,gross_total,net_total,line_count,created_at")
      .order("id", { ascending: false }).limit(R44_STMT_LIST),
  ]);
  if (seq !== moneyLoadSeq) return;   // R81 · A2 — a newer load owns the page
  const propOn = propOnRaw !== false;
  const [casesRes] = await Promise.all([
    readAll(db.from("cases").select("id,client_id,stage,case_kind,lender,loan_amount,proc_fee,broker_fee,sols_fee,fee_status,fee_paid_at,completed_at,created_at,updated_at,rate_end_date,rate_end_estimated,protection_status,retention_source_case_id,assigned_to,lead_source" + (propOn ? ",property_address" : "") + ",clients!client_id(first_name,last_name)")
      .order("id"), { cap: REPORTS_ROW_CAP }),
    renderReconPanel(stmtsPre),   // R81 · A2 — statements already in hand; its lines read shares this wave
  ]);
  if (seq !== moneyLoadSeq) return;   // R81 · A2
  if (casesRes.error) { renderLoadError("#money-owed", casesRes.error, loadMoneyPage); return; }
  const all = casesRes.data || [];
  if (extra) all.forEach((c) => { const x = extra[c.id]; if (x) Object.assign(c, x); });

  /* ---- banked last week vs the weekly slice of the monthly target ---- */
  const banked = cashInRange(all, wk.start, wk.end, ["proc", "sols", "broker"]);
  const monthTarget = Number(settings.monthly_fee_target || 0);
  const weekTarget = monthTarget > 0 ? (monthTarget * 12) / 52 : 0;
  const pct = weekTarget > 0 ? Math.round((banked.total / weekTarget) * 100) : null;
  const prevWkStart = localDateStr(new Date(new Date(wk.start + "T12:00:00").getTime() - 7 * R7_DAY));
  const prevWkEnd = localDateStr(new Date(new Date(wk.start + "T12:00:00").getTime() - R7_DAY));
  const prevBanked = cashInRange(all, prevWkStart, prevWkEnd, ["proc", "sols", "broker"]);
  $("#money-banked").innerHTML = `
    <div class="kpi kpi-headline"><div class="num" title="${esc(fmtM(banked.total))}">${fmtM(banked.total)}</div><div class="lbl">Banked ${fmtD(wk.start)} – ${fmtD(wk.end)}</div><div class="s">(cash · proc+broker+sols · by paid date · ${banked.n} payment${banked.n === 1 ? "" : "s"})</div></div>
    ${weekTarget > 0
      ? `<div class="kpi ${pct >= 100 ? "" : pct >= 60 ? "warn" : "bad"}"><div class="num">${pct}%</div><div class="lbl">of the weekly slice — ${fmtM(weekTarget)}</div><div class="s">(monthly fee target ${fmtM(monthTarget)} × 12 ÷ 52 — a flat slice, not a working-day weighting)</div></div>`
      : `<div class="kpi"><div class="num">—</div><div class="lbl">No weekly target</div><div class="s">Set a monthly fee target in Settings and this becomes target × 12 ÷ 52.</div></div>`}
    <div class="kpi kpi-secondary"><div class="num" title="${esc(fmtM(prevBanked.total))}">${fmtM(prevBanked.total)}</div><div class="lbl">Week before (${fmtD(prevWkStart)} – ${fmtD(prevWkEnd)})</div><div class="s">(same basis — shown so last week can be read as a direction, not just a number)</div></div>`;

  /* ---- owed, by age (the same model the Reports panel renders) ---- */
  const owed = moneyOwedModel(all);
  $("#money-owed-basis").innerHTML = `Unpaid proc, solicitor and broker fees on completed cases, aged from the completion date. Identical arithmetic to the Money owed panel on Reports — same rows, same total. <span class="money-basis">${esc(BASIS_OWED)}</span>`;
  $("#money-owed").innerHTML = owed.n ? `<table class="imp-table">
    <tr><th>Age</th><th>Cases</th><th>Owed</th></tr>
    ${/* R74 · A2 — was "—" for an empty band while the SAME band on Reports read "£0", and the
          case count beside it read "0" either way. One convention: a real zero reads £0. */ ""}
    ${owed.bucketList.map((b) => `<tr${b.key === "90+" && b.total ? ' class="owed-hot"' : ""}><td>${esc(OWED_BUCKET_LABEL[b.key])}</td><td class="num">${b.n}</td><td class="num">${zeroMoney(b.total)}</td></tr>`).join("")}
    <tr class="owed-total-row"><td><strong>Total</strong></td><td class="num"><strong>${owed.n}</strong></td><td class="num"><strong>${fmtM(owed.grand)}</strong></td></tr>
  </table>` : MONEY_EMPTY("Nothing outstanding — every completed case with a fee on it has a date against the money.");

  /* ---- top 5 rate-ends by value in the next 60 days ---- */
  const today = localDateStr();
  const in60 = localDateStr(new Date(new Date(today + "T12:00:00").getTime() + 60 * R7_DAY));
  const soonRaw = all.filter((c) => c.stage === "completed" && c.rate_end_date && c.rate_end_date >= today && c.rate_end_date <= in60);
  const soon = dedupeRateEndRows(soonRaw).sort((a, b) => Number(b.c.loan_amount || 0) - Number(a.c.loan_amount || 0));
  const top5 = soon.slice(0, 5);
  const soonValue = soon.reduce((s, e) => s + caseLastFee(e.c), 0);
  $("#money-rateends-basis").innerHTML = `Completed cases whose rate ends between ${fmtD(today)} and ${fmtD(in60)}, ranked by <strong>loan size</strong> — the value at risk. ${soon.length} maturit${soon.length === 1 ? "y" : "ies"} in the window${soonRaw.length !== soon.length ? ` (${soonRaw.length} case rows, de-duplicated to one per property + rate end date)` : ""}, ${fmtM(soonValue)} of last-fee value in total. <span class="money-basis">(value at risk · loan amount · last fee as proxy)</span>`;
  $("#money-rateends").innerHTML = top5.length ? `<table class="imp-table">
    <tr><th>Client</th><th>Lender</th><th>Rate ends</th><th>Loan</th><th>Last fee</th></tr>
    ${top5.map((e) => {
      const c = e.c;
      return `<tr onclick="openCase('${c.id}')" style="cursor:pointer;">
        <td><strong>${esc([c.clients?.first_name, c.clients?.last_name].filter(Boolean).join(" ")) || "(no name)"}</strong> ${propChip(c, { cls: "row-prop" }) || ""}${e.dupes > 1 ? ` <span class="badge grey">${e.dupes} cases</span>` : ""}</td>
        <td>${lenderIcon(c.lender)}${esc(c.lender || "")}</td>
        <td>${fmtD(c.rate_end_date)}${c.rate_end_estimated ? " " + APPROX : ""} <span class="cs-muted">(${Math.max(0, Math.round((new Date(c.rate_end_date + "T12:00:00") - new Date(today + "T12:00:00")) / R7_DAY))}d)</span></td>
        <td class="num">${c.loan_amount ? fmtM(c.loan_amount) : '<span class="cs-muted">—</span>'}</td>
        <td class="num">${caseLastFee(c) ? fmtM(caseLastFee(c)) : '<span class="cs-muted">none recorded</span>'}</td>
      </tr>`;
    }).join("")}
  </table>` : MONEY_EMPTY("No completed rate ends in the next 60 days.");

  /* ---- protection quotes gone cold ---- */
  const quoted = all.filter((c) => c.protection_status === "quoted");
  /* R81 · A2 — `stamps` arrived in wave 1 (moneyQuoteStampsAll — every quoted case's stamps,
     the exact superset the old loadQuoteStamps(quoted ids) call produced for this page). */
  const withAge = quoted.map((c) => {
    const at = (stamps[c.id] || {}).protection_quoted_at || null;
    return { c, at, days: at ? daysSince(at) : null };
  });
  const cold = withAge.filter((x) => x.days != null && x.days > QUOTE_AGE_RED).sort((a, b) => b.days - a.days);
  const undatedQuotes = withAge.filter((x) => x.days == null);
  $("#money-cold-basis").innerHTML = `Cases sitting at <strong>Quoted</strong> whose quote is more than ${QUOTE_AGE_RED} days old, measured from the date the status was set to quoted. ${quoted.length} quoted in total${undatedQuotes.length ? `, ${undatedQuotes.length} of which carry no quote date and cannot be aged` : ""}. <span class="money-basis">(protection_status = quoted · aged from protection_quoted_at)</span>`;
  $("#money-cold").innerHTML = cold.length ? cold.slice(0, 10).map((x) => `
    <div class="row-item">
      <div class="row-main">
        <div class="t" onclick="openCase('${x.c.id}')">${esc([x.c.clients?.first_name, x.c.clients?.last_name].filter(Boolean).join(" ")) || "(no name)"} ${propChip(x.c, { cls: "row-prop" }) || ""}</div>
        <div class="s">Quoted ${fmtD(x.at)} · ${lenderIcon(x.c.lender)}${esc(x.c.lender || "no lender")}</div>
      </div>
      ${quoteAgeBadge(x.at)}
    </div>`).join("") + (cold.length > 10 ? `<div class="empty">…and ${cold.length - 10} more on the Protection page.</div>` : "")
    : MONEY_EMPTY(undatedQuotes.length
        ? `No quote is more than ${QUOTE_AGE_RED} days old. ${undatedQuotes.length} quoted case${undatedQuotes.length === 1 ? " carries" : "s carry"} no quote date, so ${undatedQuotes.length === 1 ? "it is" : "they are"} not counted here.`
        : `No quote is more than ${QUOTE_AGE_RED} days old.`);

  /* ---- movement: what moved last week vs what is stuck ---- */
  const movedIds = new Set();
  (eventsRes.data || []).forEach((e) => {
    if (!e || !e.case_id || !e.created_at) return;
    const d = localDateStr(e.created_at);
    if (d >= wk.start && d <= wk.end) movedIds.add(e.case_id);
  });
  const ACTIVE_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
  const activeCases = all.filter((c) => ACTIVE_STAGES.includes(c.stage));
  const entryMap = {};
  (eventsRes.data || []).forEach((e) => {
    if (!e || !e.case_id || !e.created_at) return;
    if (!entryMap[e.case_id] || e.created_at > entryMap[e.case_id]) entryMap[e.case_id] = e.created_at;
  });
  const stuck = activeCases.filter((c) => {
    const d = daysSince(entryMap[c.id] || c.created_at);
    return d != null && d > 30;
  });
  const movedActive = activeCases.filter((c) => movedIds.has(c.id));
  $("#money-movement-basis").innerHTML = `<strong>Moved</strong> counts live cases with at least one recorded stage change between ${fmtD(wk.start)} and ${fmtD(wk.end)}. <strong>Stuck</strong> counts live cases whose last recorded stage change (or, where there is none, their creation date) is more than 30 days ago. <span class="money-basis">(case_events · stage_changed · live stages only)</span>`;
  $("#money-movement").innerHTML = `<table class="imp-table">
    <tr><th>&nbsp;</th><th>Cases</th><th>Loan value</th></tr>
    <tr><td>Moved last week</td><td class="num"><strong id="money-moved-n">${movedActive.length}</strong></td><td class="num">${fmtM(movedActive.reduce((s, c) => s + Number(c.loan_amount || 0), 0))}</td></tr>
    <tr${stuck.length ? ' class="owed-hot"' : ""}><td>Stuck more than 30 days</td><td class="num"><strong id="money-stuck-n">${stuck.length}</strong></td><td class="num">${fmtM(stuck.reduce((s, c) => s + Number(c.loan_amount || 0), 0))}</td></tr>
    <tr><td class="cs-muted">Live cases in total</td><td class="cs-muted">${activeCases.length}</td><td class="cs-muted">${fmtM(activeCases.reduce((s, c) => s + Number(c.loan_amount || 0), 0))}</td></tr>
  </table>${stuck.length ? `<p class="panel-sub" style="margin:10px 0 0;">A case can be both — moved last week and still older than 30 days in its stage.</p>` : ""}`;

  /* ---- new leads last week, by source ---- */
  const leads = leadsRes.error ? [] : (leadsRes.data || []);
  const wkLeads = leads.filter((l) => {
    const d = l && l.created_at ? localDateStr(l.created_at) : null;
    return d && d >= wk.start && d <= wk.end;
  });
  const leadSourceOf = (l) => String((l && (l.source || l.lead_source || l.enquiry_type)) || "").trim() || "(not recorded)";
  const bySource = new Map();
  wkLeads.forEach((l) => { const k = leadSourceOf(l); bySource.set(k, (bySource.get(k) || 0) + 1); });
  $("#money-leads-basis").innerHTML = `Website enquiries created between ${fmtD(wk.start)} and ${fmtD(wk.end)}, whatever has since happened to them. Source is the enquiry type the website form recorded. <span class="money-basis">(leads · created_at · last week)</span>`;
  $("#money-leads").innerHTML = wkLeads.length ? `<table class="imp-table">
    <tr><th>Source</th><th>Leads</th><th>Accepted</th></tr>
    ${[...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => {
      const acc = wkLeads.filter((l) => leadSourceOf(l) === k && l.status === "converted").length;
      return `<tr><td>${esc(k)}</td><td>${n}</td><td>${acc}</td></tr>`;
    }).join("")}
    <tr class="owed-total-row"><td><strong>Total</strong></td><td><strong>${wkLeads.length}</strong></td><td><strong>${wkLeads.filter((l) => l.status === "converted").length}</strong></td></tr>
  </table>` : MONEY_EMPTY(leadsRes.error ? "Leads could not be read — the figure is missing, not zero." : "No website enquiries arrived last week.");

  /* ---- per-adviser strip ---- */
  const tasks = tasksRes.error ? [] : (tasksRes.data || []);
  const yr = String(new Date(localDateStr()).getFullYear());
  const advRows = (TEAM.length ? TEAM : PROFILES).map((p) => {
    const mine = all.filter((c) => c.assigned_to === p.id);
    const doneYr = mine.filter((c) => c.completed_at && localDateStr(c.completed_at).slice(0, 4) === yr);
    const taken = doneYr.filter((c) => c.protection_status === "policy_taken").length;
    const rets = mine.filter((c) => c.retention_source_case_id);
    const rWon = rets.filter((c) => c.stage === "completed").length;
    const rLost = rets.filter((c) => c.stage === "not_proceeding").length;
    const unpaidProc = mine.filter((c) => c.stage === "completed")
      .reduce((s, c) => s + Number((feeOwedLines(c).find((l) => l.key === "proc") || {}).amount || 0), 0);
    const overdue = tasks.filter((t) => t.assigned_to === p.id && t.due_date && t.due_date < today).length;
    return { id: p.id, name: profileName(p.id) || staffName(p.id), nDone: doneYr.length, taken,
             attach: doneYr.length ? Math.round((taken / doneYr.length) * 100) : null,
             rWon, rLost, conv: rWon + rLost ? Math.round((rWon / (rWon + rLost)) * 100) : null,
             unpaidProc, overdue };
  }).filter((r) => r.nDone || r.rWon || r.rLost || r.unpaidProc || r.overdue);
  $("#money-advisers-basis").innerHTML = `<strong>Attach rate</strong> is policy_taken ÷ completions, over ${yr} completions only — a whole-year sample, because a week of completions is too few to rank anybody on. <strong>Retention conversion</strong> is won ÷ (won + lost) over that adviser's retention cases, all time. <strong>Unpaid proc</strong> is the procuration fee owed on their completed cases. <strong>Overdue</strong> is open tasks due before today. ${ATTRIB_NOTE} <span class="money-basis">(per adviser · mixed bases, each named above)</span>`;
  $("#money-advisers").innerHTML = advRows.length ? `<div style="overflow-x:auto;"><table class="imp-table" id="money-adviser-table">
    ${/* R74 · A2 (panel D#4) — the period goes IN the header. The same adviser read 0% on Reports
          and 43% here, because that one is the selected MONTH's completions and this one is the
          whole calendar year — true of both, said by neither. "Attach (2026)" against Reports'
          "Attach (Aug)" makes the difference visible without opening a tooltip. */ ""}
    <tr><th>Adviser</th><th title="Completed cases in ${yr} that ended with a protection policy — the whole calendar year, because a week of completions is too few to rank anybody on. The Reports scoreboard measures the same thing over the selected MONTH only, which is why the two pages can differ.">Attach (${yr})</th><th title="Retention cases won as a share of those decided.">Retention conversion</th><th>Unpaid proc</th><th>Overdue tasks</th></tr>
    ${advRows.map((r) => `<tr data-adv="${esc(r.id)}">
      <td><strong>${esc(r.name)}</strong></td>
      <td>${r.attach == null ? '<span class="cs-muted">no completions</span>' : `${r.attach}% <span class="cs-muted">(${r.taken}/${r.nDone})</span>`}</td>
      <td>${r.conv == null ? '<span class="cs-muted">none decided</span>' : `${r.conv}% <span class="cs-muted">(${r.rWon}/${r.rWon + r.rLost})</span>`}</td>
      <td class="num">${zeroMoney(r.unpaidProc)}</td>   ${/* R74 · A2 — nothing unpaid is £0, not a blank */ ""}
      ${/* R73 · B2 — one colour, not a threshold. "Amber under six, red at six" was a
           severity rule stated nowhere on the page, and it made Luke's 5 and Wayne's 6
           look like different KINDS of problem. */ ""}
      <td class="num">${r.overdue ? `<span class="badge amber">${r.overdue}</span>` : '<span class="cs-muted">—</span>'}</td>
    </tr>`).join("")}
  </table></div>` : MONEY_EMPTY("No adviser has completions, retention cases, unpaid proc fees or overdue tasks.");

  /* R44 — the two reconciliation panels. R81 · A2: both already READ in waves 1–2 above
     (loadProcRates(true) refreshed the rate card; renderReconPanel(stmtsPre) painted beside
     the cases read), so what remains here is the rate-card panel's render from data in hand —
     zero further network. Each still carries its own owner gate. */
  await renderProcRatesPanel(ratesPre);
  syncNumHeaders("#page-money");        // R73 · B4
}

/* R7 — wiring for the controls added to Reports, Monday money and Protection.
   Bound once at load, imperatively, exactly like the pipeline's bulk bar: these
   nodes are in the shipped markup and are never re-created by a render, so a
   listener here can never be attached twice or lost to an innerHTML rewrite. */
(() => {
  const on = (sel, fn) => { const el = $(sel); if (el) el.addEventListener("click", fn); };
  on("#owed-group-lender", () => setOwedGroup("lender"));
  on("#owed-group-adviser", () => setOwedGroup("adviser"));
  on("#owed-csv-btn", () => exportOwedCsv());
  on("#money-refresh", () => loadMoneyPage());
  on("#money-owed-open", () => gotoMoneyOwed());
})();

/* ==========================================================================
   R44 · STONEBRIDGE PAYMENT RECONCILIATION
   Two panels at the foot of Monday money, both OWNER-ONLY (they live inside
   #money-body, which loadMoneyPage() hides for anyone else, and both are
   emptied and hidden explicitly in that branch as well — belt and braces, the
   same shape renderLeadResponse() uses on Reports).

   What it is for: every week the network sends a commission statement and,
   separately, a proc-rate card. Until now the statement was reconciled by eye
   against the board and the paid dates were typed in from memory, which is how
   a completed case sat six weeks unpaid on the Money-owed list while the money
   had in fact arrived — and how a CLAWBACK went unnoticed entirely.

   Daniel's three binding decisions are the whole shape of this code:
     · REVIEW THEN CONFIRM. The importer never writes to a case. It parses,
       matches, and shows its work; a human ticks. Nothing on the case moves
       until somebody presses Confirm.
     · OWNER ONLY. Fee-level money for the whole firm, so the same gate the
       rest of this page uses, and no adviser-facing surface at all.
     · A REAL CLAWBACK FLAGS AND CREATES A TASK. It never silently un-pays a
       case: the history of what was banked stays true, and the ACTION becomes
       a task on the owner's list.

   Spreadsheet content is UNTRUSTED INPUT — an addressee, a provider, a note, a
   filename all arrive from a third party's workbook — so every one of them goes
   through esc() on the way into HTML, attributes included.
   ====================================================================== */

/* ---------- shared: header normalisation, cells, numbers, dates ---------- */

/* Both workbooks are mapped BY HEADER NAME, never by position. The statement in
   particular interleaves EMPTY spacer columns between the ones that carry data
   (there are 21 columns for 16 headings), and several headings contain a
   literal newline mid-phrase — "Tran Type \nDesc", "Account \nnumber",
   "Banked\n(Gross)", "Policy \nType". Collapsing every run of whitespace to a
   single space and lowercasing turns all of those into one stable key, so a
   column moving (or a spacer being added) costs nothing. */
const r44Head = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();

/* A money cell. SheetJS hands back a number for a numeric cell, but a hand-typed
   one can arrive as "£1,011.50" or "(914.54)" — accounting negatives — and an
   empty cell as "" or null. Anything that is not a number is null, never 0:
   "we could not read this" and "this was zero" are different facts. */
function r44Num(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[£$,\s]/g, "");
  if (s === "" || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

/* A date cell, STRICTLY. This is also the row classifier — "the first cell
   parses as a date" is what separates a data row from an adviser group header —
   so it must never say yes to a person's name. `new Date("Some Name")` is
   Invalid Date in every engine we support, but `new Date("May 5")` is NOT, which
   is exactly the kind of surname-shaped string a lenient parser would swallow.
   Hence: JS Date (what {cellDates:true} gives us), Excel serial, ISO, or UK
   d/m/y. Nothing else. */
function r44CellDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") {
    // Excel serial. Bounded to 1954-2119 so a stray Opp ID or an amount can
    // never be read as a date.
    if (v < 20000 || v > 80000) return null;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) { const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`); return isNaN(d.getTime()) ? null : d; }
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);   // UK day-first
  if (m) {
    let y = Number(m[3]); if (y < 100) y += 2000;
    const d = new Date(y, Number(m[2]) - 1, Number(m[1]), 12);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}
/* The calendar day a parsed cell means, read with LOCAL getters. SheetJS builds
   its Date at local midnight; a serial we build lands at UTC midnight. In
   Europe/London (UTC+0 or +1) both read back as the same calendar day through
   local getters, which is the only timezone this firm operates in — and it is
   the same reason feeDateToTs() stamps local midday rather than midnight. */
function r44DateStr(d) {
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const r44Str = (v) => (v == null ? "" : String(v).trim());
/* A sheet as an array of arrays, blank rows kept — the walk below is
   positional within the sheet and a dropped blank row would shift it. */
const r44Aoa = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });

/* ---------- T1 · the proc-rate card ---------- */

/* Header → column. Each entry is a list of accepted names in preference order;
   the first that appears in the sheet wins. `rate` accepts the network's own
   column heading first ("Stonebridge") and a generic "Rate" as a fallback,
   because the day the card is re-badged is not the day expected-fee checks
   should silently switch off. */
const R44_RATE_HEADERS = {
  lender: ["lender"],
  product: ["product description", "product"],
  lg_code: ["l&g code", "l & g code", "lg code", "l and g code"],
  rate: ["stonebridge", "stonebridge rate", "rate", "proc fee"],
  notes: ["notes", "note", "comments"],
};
/* Returns { rows, skipped, usable, headerRow, missing } — `rows` shaped for
   proc_rates. A row with a blank or non-numeric rate is SKIPPED and counted:
   the card saying nothing about a product is not the same claim as the card
   saying nought, and storing the second when we were handed the first would
   invent an expected fee of £0.
   An EXPLICIT nought is a different matter and is kept — the card really does
   carry 0 against some further-advance products, and dropping that would make
   the card look as though it had never mentioned them. It cannot leak into an
   expected fee either way: r44ExpectedFee() only counts rates above nought.
   The rate is a DECIMAL FRACTION here (0.004 = 0.40%), which is what the
   column's 0-1 check constraint enforces, so anything outside [0,1] is a
   misread column rather than a rate and is skipped.
   `usable` counts the rows that could actually drive an expected-fee check —
   rate strictly inside (0,1] — and is what the upload gate tests. */
function parseProcRatesSheet(aoa) {
  const out = { rows: [], skipped: 0, usable: 0, headerRow: -1, missing: [] };
  const rows = aoa || [];
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const heads = (rows[i] || []).map(r44Head);
    if (heads.indexOf("lender") >= 0) { out.headerRow = i; break; }
  }
  if (out.headerRow < 0) { out.missing = ["lender"]; return out; }
  const heads = (rows[out.headerRow] || []).map(r44Head);
  const col = {};
  Object.keys(R44_RATE_HEADERS).forEach((k) => {
    col[k] = -1;
    R44_RATE_HEADERS[k].some((name) => { const at = heads.indexOf(name); if (at >= 0) { col[k] = at; return true; } return false; });
  });
  if (col.lender < 0) out.missing.push("Lender");
  if (col.rate < 0) out.missing.push("Stonebridge");
  if (out.missing.length) return out;
  for (let i = out.headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const lender = r44Str(r[col.lender]);
    const rateRaw = col.rate >= 0 ? r[col.rate] : null;
    if (!lender && (rateRaw == null || rateRaw === "")) continue;   // a spacer row, not a fault
    const rate = r44Num(rateRaw);
    if (!lender || rate == null || rate < 0 || rate > 1) { out.skipped++; continue; }
    if (rate > 0) out.usable++;
    out.rows.push({
      lender,
      product: col.product >= 0 ? r44Str(r[col.product]) : "",
      lg_code: col.lg_code >= 0 ? r44Str(r[col.lg_code]) : "",
      rate,
      notes: col.notes >= 0 ? r44Str(r[col.notes]) : "",
    });
  }
  return out;
}

/* ---------- T2 · the weekly commission statement ---------- */

const R44_LINE_HEADERS = {
  line_date: ["date"],
  tran_type: ["tran type desc", "tran type", "tran type description"],
  addressee: ["addressee"],
  provider: ["provider"],
  account_number: ["account number", "account no", "account"],
  opp_id: ["opp id", "opportunity id"],
  reason: ["reason"],
  policy_type: ["policy type"],
  policy_group: ["policy group"],
  premium: ["premium"],
  banked_gross: ["banked (gross)", "banked gross"],
  banked_net: ["banked (net)", "banked net"],
};
/* "File Review Client Name", "Deduction(Introducer)", "Deduction (Referrer)" and
   "Clawback Reserve" are deliberately NOT mapped: there is no column on
   commission_lines for any of them and we do not invent schema to hold a figure
   nothing reads. */

/* The statement walk. Everything about it is derived from the sheet rather than
   assumed:
     · REF — a free cell somewhere in the top five rows reading "Ref:BP1048".
       Scanned across every cell of those rows because which column it lands in
       is a spreadsheet layout accident.
     · HEADER ROW — the first row whose FIRST cell is exactly "Date".
     · GROUP HEADERS — below the header the sheet is a firm row, then one group
       per adviser. A group header is a row whose first cell is text that does
       not parse as a date and is not a subtotal or a total. Telling the FIRM
       row apart from an ADVISER row is done from the sheet's own totals: the
       trailer carries "Total for <firm>" (and "Total for this statement"), so
       any group header whose text is one of those named firms is the firm row
       and sets no adviser. Guessing "the first one is the firm" would put every
       line under the wrong name the day a statement arrives without a firm row.
     · SUBTOTALS — Policy Group reads "N item(s)".
     · TOTALS — first cell starts "Total for"; "Total for this statement" is
       where the statement's own gross/net come from when it is present.
     · DATA — the first cell parses as a date. */
function parseStatementSheet(aoa, sheetName) {
  const rows = aoa || [];
  const out = {
    ref: "", label: r44Str(sheetName), statementDate: null, gross: null, net: null,
    lines: [], advisers: [], headerRow: -1, missing: [], totalsFromRow: false,
  };
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    (rows[i] || []).forEach((cell) => {
      if (out.ref) return;
      const m = /^Ref:\s*(.+)$/i.exec(r44Str(cell));
      if (m) out.ref = m[1].trim();
    });
    if (out.ref) break;
  }
  for (let i = 0; i < rows.length; i++) {
    if (r44Str((rows[i] || [])[0]).toLowerCase() === "date") { out.headerRow = i; break; }
  }
  if (out.headerRow < 0) { out.missing = ["Date"]; return out; }
  const heads = (rows[out.headerRow] || []).map(r44Head);
  const col = {};
  Object.keys(R44_LINE_HEADERS).forEach((k) => {
    col[k] = -1;
    R44_LINE_HEADERS[k].some((name) => { const at = heads.indexOf(name); if (at >= 0) { col[k] = at; return true; } return false; });
  });
  ["line_date", "tran_type", "banked_gross", "policy_group"].forEach((k) => { if (col[k] < 0) out.missing.push(k); });
  if (out.missing.length) return out;
  const cell = (r, k) => (col[k] >= 0 ? r[col[k]] : null);

  /* Pre-scan for the firm names the trailer totals name (see the comment above). */
  const firmNames = {};
  rows.forEach((r) => {
    const m = /^Total for\s+(.+)$/i.exec(r44Str((r || [])[0]));
    if (m && !/^this statement$/i.test(m[1].trim())) firmNames[m[1].trim().toLowerCase()] = true;
  });

  let adviser = "";
  for (let i = out.headerRow + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const first = r44Str(r[0]);
    const grp = r44Str(cell(r, "policy_group"));
    if (/^Total for/i.test(first)) {
      if (/^Total for\s+this statement$/i.test(first)) {
        out.gross = r44Num(cell(r, "banked_gross"));
        out.net = r44Num(cell(r, "banked_net"));
        out.totalsFromRow = out.gross != null;
      }
      continue;
    }
    if (/^\d+ item\(s\)$/i.test(grp)) continue;                    // subtotal
    const d = r44CellDate(cell(r, "line_date"));
    if (!d) {
      if (first) {
        if (firmNames[first.toLowerCase()]) adviser = "";          // the firm row
        else { adviser = first; if (out.advisers.indexOf(first) < 0) out.advisers.push(first); }
      }
      continue;                                                    // blank/spacer/group header
    }
    const ds = r44DateStr(d);
    out.lines.push({
      line_date: feeDateToTs(ds),
      date_str: ds,
      tran_type: r44Str(cell(r, "tran_type")),
      addressee: r44Str(cell(r, "addressee")),
      provider: r44Str(cell(r, "provider")),
      account_number: r44Str(cell(r, "account_number")),
      opp_id: r44Str(cell(r, "opp_id")),
      reason: r44Str(cell(r, "reason")),
      policy_type: r44Str(cell(r, "policy_type")),
      policy_group: r44Str(cell(r, "policy_group")),
      adviser_name: adviser,
      premium: r44Num(cell(r, "premium")),
      banked_gross: r44Num(cell(r, "banked_gross")),
      banked_net: r44Num(cell(r, "banked_net")),
    });
  }
  out.lines.forEach((l) => { if (!out.statementDate || l.date_str > out.statementDate) out.statementDate = l.date_str; });
  if (!out.totalsFromRow) {
    out.gross = out.lines.reduce((s, l) => s + Number(l.banked_gross || 0), 0);
    out.net = out.lines.reduce((s, l) => s + Number(l.banked_net || 0), 0);
  }
  return out;
}
/* Whole-workbook entry points, using the SAME XLSX.read(arrayBuffer, {type:"array"})
   pattern the client importer uses — the SheetJS bundle index.html already loads,
   nothing added. {cellDates:true} on top, because the statement's row classifier
   depends on a date cell arriving as a Date rather than a serial. */
function parseProcRatesWorkbook(wb) {
  const sn = (wb.SheetNames || [])[0];
  const res = parseProcRatesSheet(sn ? r44Aoa(wb.Sheets[sn]) : []);
  res.sheet = sn || "";
  return res;
}
function parseStatementWorkbook(wb) {
  const sn = (wb.SheetNames || [])[0];
  return parseStatementSheet(sn ? r44Aoa(wb.Sheets[sn]) : [], sn || "");
}

/* ---------- T3 · matcher, lender normalisation, expected fee ---------- */

/* One lender vocabulary, used for provider↔case.lender AND provider↔rate-card
   lender. "Barclays Bank PLC", "Barclays for Intermediaries" and "Barclays" are
   the same lender; "Skipton Building Society" and "Skipton BS" are the same
   lender; and none of the words doing the differing carry any information. */
const R44_LENDER_NOISE = /\b(building society|for intermediaries|home ?loans|solutions|mortgages|mortgage|bank|bs|plc|ltd|limited|the|uk)\b/g;
function r44LenderKey(s) {
  return String(s == null ? "" : s).toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(R44_LENDER_NOISE, " ")
    .replace(/\s+/g, " ").trim();
}
/* Prefix or containment, both ways round. Guarded on length: once the noise
   words are gone a key can be two characters ("bm" for BM Solutions), and a
   two-character containment test matches almost everything, so anything under
   three characters has to be an exact match. */
function r44LenderMatch(a, b) {
  const x = r44LenderKey(a), y = r44LenderKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 3 || y.length < 3) return false;
  return x.indexOf(y) === 0 || y.indexOf(x) === 0 || x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
}

/* Surnames out of an addressee. "Mr Hawkins & Miss Haynes-Flood" is two people
   and two surnames, and the hyphenated one is ONE surname — splitting it would
   match "Haynes" against a different family. Titles are stripped, the last
   remaining token of each person is the surname, lowercased. */
const R44_TITLE_WORD = /^(mr|mrs|miss|ms|mx|dr|prof|professor|sir|lady|rev|revd)$/i;
const R44_TITLE = /^(mr|mrs|miss|ms|mx|dr|prof|professor|sir|lady|rev|revd)\s+/i;
function r44Surnames(addressee) {
  const s = String(addressee == null ? "" : addressee).trim();
  if (!s) return [];
  const out = [];
  s.split(/\s*(?:&|\band\b|,|\+)\s*/i).forEach((part) => {
    let t = String(part).replace(/\./g, " ").replace(/\s+/g, " ").trim();
    while (R44_TITLE.test(t)) t = t.replace(R44_TITLE, "").trim();
    /* "Mr & Mrs Ashdown-Pryce" splits into "Mr" and "Mrs Ashdown-Pryce": the
       first fragment is a bare title with no name behind it and must NOT become
       the surname "mr", which would then match every case whose client happens
       to be called Mr-anything. */
    if (R44_TITLE_WORD.test(t)) return;
    if (!t) return;
    const toks = t.split(" ").filter(Boolean);
    if (!toks.length) return;
    const last = toks[toks.length - 1].toLowerCase();
    if (last.length < 2) return;
    if (out.indexOf(last) < 0) out.push(last);
  });
  return out;
}

/* What KIND of line this is — the four groups the review screen shows, in the
   order they are tested. A takeback is a takeback whatever policy group it sits
   in (the money has gone back either way). A renewal is the "VARIOUS" trailer
   the network appends: no addressee, nothing to match to, imported as `na`
   rather than left looking unreconciled forever. */
function r44LineKind(l) {
  const tt = String((l || {}).tran_type || "").toLowerCase();
  const grp = String((l || {}).policy_group || "").toLowerCase();
  const hasAddressee = !!String((l || {}).addressee || "").trim();
  if (/takeback|claw ?back/.test(tt)) return "takeback";
  if (/renewal/.test(tt) || (!hasAddressee && /^various$/i.test(String((l || {}).reason || "").trim()))) return "renewal";
  if (grp === "mortgage") return "mortgage";
  if (/life|protection/.test(grp) && hasAddressee) return "protection";
  return "other";
}
const R44_MATCHABLE = { mortgage: true, takeback: true, protection: true };

/* ---------- R48 · commission attribution ----------
   Who each line's money belongs to on the reconciliation screen. PURE and
   testable, same discipline as suggestStatementMatches: no I/O, no DOM. */

/* A person's name normalised the way the matcher already normalises text: trim,
   collapse internal whitespace, lowercase. Used to map a sheet's adviser_name
   onto a current profile — an ex-broker (Hannah/Nathan/Ciaran/Elizabeth) has no
   profile, so their name never keys anything and the line falls through to the
   owner, which is exactly Daniel's rule. */
function r44NameKey(s) {
  return String(s == null ? "" : s).trim().replace(/\s+/g, " ").toLowerCase();
}

/* "Misc insurance" for attribution/tally purposes: all protection / GI /
   renewal / trail — anything that is not a Mortgage-group receipt or its
   takeback. This is the half of the money that ALWAYS sits under the owner
   whatever name it carries on the sheet. */
function r44IsMiscInsurance(l, kind) {
  kind = kind || r44LineKind(l);
  if (kind === "protection" || kind === "renewal" || kind === "other") return true;
  return String((l || {}).policy_group || "").trim().toLowerCase() !== "mortgage";
}

/* R48 — a line "needs you" when EITHER it is a matchable (mortgage/takeback)
   line still awaiting a case decision (unmatched/suggested — not confirmed,
   dismissed, or parked at na), OR its attribution is null. Renewals/misc that
   were attributed to the owner at import are placed and never in the queue. */
function r44NeedsYou(l) {
  if (!l || l.match_status === "dismissed") return false;
  const k = r44LineKind(l);
  const matchablePending = !!R44_MATCHABLE[k] && (l.match_status === "unmatched" || l.match_status === "suggested");
  return matchablePending || !l.attributed_to;
}

/* r44AttributeLine(line, kind, matchedCase, nameToId, ownerId) → profile id (or
   ownerId fallback). Daniel's decision, encoded:
     · misc insurance (protection / renewal / other, OR any non-Mortgage group) →
       the OWNER, whoever's name it sits under. This wins regardless of
       adviser_name — it is the "all misc insurance → me" rule.
     · mortgage / takeback → the matched case's adviser if we have a case (which
       is the owner for the ex-broker cases the import already re-assigned to the
       owner); else the sheet's named adviser IF they are a current profile; else
       the owner. Never returns null — the tally is never blank at import. */
function r44AttributeLine(line, kind, matchedCase, nameToId, ownerId) {
  if (r44IsMiscInsurance(line, kind)) return ownerId || null;
  if (matchedCase && matchedCase.assigned_to) return matchedCase.assigned_to;
  const named = nameToId ? nameToId[r44NameKey(line && line.adviser_name)] : null;
  return named || ownerId || null;
}

/* ownerId + a normalised-name → profile-id map, built from the staff list
   already loaded at sign-in (TEAM = the STAFF_ROLES subset of PROFILES). No
   extra DB read: R44 is owner-gated and TEAM is populated before the Money page
   can be reached. Owner falls back to ME.id — in R44 the current user always is
   the owner. nameToId is current staff only, so ex-broker names miss. */
function r44StaffMaps() {
  const staff = (typeof TEAM !== "undefined" && TEAM) ? TEAM : [];
  const ownerRow = staff.filter((p) => p && p.role === "owner")[0];
  const ownerId = (ownerRow && ownerRow.id) || (ME && ME.id) || null;
  const nameToId = {};
  staff.forEach((p) => { const k = r44NameKey(p && p.full_name); if (k) nameToId[k] = p.id; });
  return { ownerId, nameToId, staff };
}

/* Expected proc fee from the rate card: every card row whose lender normalises
   onto this provider gives a rate, and the range is [min, max] × the loan. Null
   when there is no card, no matching lender, or no loan — an expected fee we
   cannot compute is shown as nothing, never as zero. */
function r44ExpectedFee(provider, loanAmount, procRates) {
  const loan = Number(loanAmount || 0);
  if (!loan || !(procRates || []).length) return null;
  const rates = (procRates || [])
    .filter((r) => r44LenderMatch(provider, r && r.lender))
    .map((r) => Number(r && r.rate))
    .filter((n) => isFinite(n) && n > 0 && n <= 1);
  if (!rates.length) return null;
  return { expectedLo: Math.min.apply(null, rates) * loan, expectedHi: Math.max.apply(null, rates) * loan, rateCount: rates.length };
}
/* ±10% on the NEAREST bound — a range that already spans several products
   should not also be widened at both ends before anything counts as "over". */
const R44_FEE_TOL = 0.1;
function r44FeeVerdict(gross, exp) {
  if (!exp) return null;
  const g = Math.abs(Number(gross || 0));
  const lo = exp.expectedLo * (1 - R44_FEE_TOL), hi = exp.expectedHi * (1 + R44_FEE_TOL);
  if (g >= lo && g <= hi) return { expectedLo: exp.expectedLo, expectedHi: exp.expectedHi, verdict: "within", delta: 0, rateCount: exp.rateCount };
  if (g > hi) return { expectedLo: exp.expectedLo, expectedHi: exp.expectedHi, verdict: "over", delta: g - exp.expectedHi, rateCount: exp.rateCount };
  return { expectedLo: exp.expectedLo, expectedHi: exp.expectedHi, verdict: "under", delta: exp.expectedLo - g, rateCount: exp.rateCount };
}

/* An in-statement reversal: a takeback and a receipt on the SAME account number,
   inside the SAME statement, equal and opposite. The network does this when it
   re-books a case — the money never actually left. Both halves are flagged so
   the review screen can say "reversed in-statement · net £0" instead of raising
   a clawback task for a clawback that did not happen. Returns a map of index →
   the index it pairs with. */
const R44_PAIR_TOL = 0.02;
function r44ReversalPairs(lines) {
  const pairs = {};
  const used = {};
  const ls = lines || [];
  for (let i = 0; i < ls.length; i++) {
    if (used[i] || r44LineKind(ls[i]) !== "takeback") continue;
    const acct = String(ls[i].account_number || "").trim();
    const g = Number(ls[i].banked_gross || 0);
    if (!acct || !(g < 0)) continue;
    for (let j = 0; j < ls.length; j++) {
      if (i === j || used[j] || pairs[j] != null) continue;
      if (r44LineKind(ls[j]) === "takeback") continue;
      if (String(ls[j].account_number || "").trim() !== acct) continue;
      const h = Number(ls[j].banked_gross || 0);
      if (!(h > 0)) continue;
      if (Math.abs(h + g) > Math.max(R44_PAIR_TOL, Math.abs(g) * 0.001)) continue;
      pairs[i] = j; pairs[j] = i; used[i] = used[j] = true;
      break;
    }
  }
  return pairs;
}

/* --------------------------------------------------------------------------
   suggestStatementMatches(lines, cases, priorLines, procRates)
   PURE. No I/O, no DOM — the whole point, because "which case is this payment"
   is the one judgement in this feature that has to be testable without a
   spreadsheet, a database and a browser.

   ADMISSION. A case is a candidate only if the addressee's surname is one of
   its client's, OR the account number has been confirmed against that case
   before. The surname rule is what stops a £1,011 receipt landing on whichever
   Halifax case happens to be worth £1,011; the account-history rule is the
   exception it must have, because a TAKEBACK carries the same account number as
   the receipt it reverses and nothing else reliable, and finding that original
   is the entire reason priorLines is read.

   SCORING (mortgage/takeback/protection lines; renewals are never scored):
     +10  account history — this account number was confirmed onto this case
     +2   lender: provider normalises onto case.lender
     +2   amount: gross within 15% of case.proc_fee, or inside the expected-fee
          range widened by 15%
     +1   the case's proc fee is not yet dated (an unpaid case is a likelier
          home for a payment than one already settled)
   Highest score wins, one suggestion per line. CONFIDENT (pre-ticks the row) =
   account history, or surname AND lender AND amount all three. A TIE on the top
   score is never confident: two cases that score identically is precisely the
   situation a human has to look at.
   ------------------------------------------------------------------------ */
const R44_AMOUNT_TOL = 0.15;
function suggestStatementMatches(lines, cases, priorLines, procRates) {
  const priorByAcct = {};
  (priorLines || []).forEach((p) => {
    const a = String((p && p.account_number) || "").trim();
    if (a && p.matched_case_id) priorByAcct[a] = p.matched_case_id;
  });
  const pairs = r44ReversalPairs(lines);
  return (lines || []).map((l, i) => {
    const kind = r44LineKind(l);
    const res = {
      index: i, kind, suggested: null, confidence: null, score: 0, why: [],
      candidates: [], expected: null, pairedWith: pairs[i] == null ? null : pairs[i],
      note: "",
    };
    if (!R44_MATCHABLE[kind]) return res;
    const acct = String(l.account_number || "").trim();
    const priorId = acct ? priorByAcct[acct] || null : null;
    const surnames = r44Surnames(l.addressee);
    const gross = Math.abs(Number(l.banked_gross || 0));
    const scored = [];
    (cases || []).forEach((c) => {
      if (!c || !c.id) return;
      const cs = String(((c.clients || {}).last_name) || "").trim().toLowerCase();
      const acctHit = !!priorId && priorId === c.id;
      const surnameHit = !!cs && surnames.indexOf(cs) >= 0;
      if (!surnameHit && !acctHit) return;
      const exp = r44ExpectedFee(l.provider, c.loan_amount, procRates);
      const near = (t) => Number(t) > 0 && Math.abs(gross - Number(t)) <= Number(t) * R44_AMOUNT_TOL;
      const inExpected = !!exp && gross >= exp.expectedLo * (1 - R44_AMOUNT_TOL) && gross <= exp.expectedHi * (1 + R44_AMOUNT_TOL);
      const lenderHit = r44LenderMatch(l.provider, c.lender);
      const amountHit = near(c.proc_fee) || inExpected;
      let score = 0; const why = [];
      if (acctHit) { score += 10; why.push("account history"); }
      if (surnameHit) why.push("surname");
      if (lenderHit) { score += 2; why.push("lender"); }
      if (amountHit) { score += 2; why.push("amount"); }
      if (!c.proc_fee_paid_at) { score += 1; why.push("unpaid"); }
      scored.push({ id: c.id, case: c, score, why, surnameHit, lenderHit, amountHit, acctHit, expected: exp });
    });
    scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    res.candidates = scored.slice(0, 10);
    const top = scored[0] || null;
    if (top) {
      const tie = scored.length > 1 && scored[1].score === top.score;
      res.suggested = top.id;
      res.score = top.score;
      res.why = top.why.slice();
      res.confidence = (!tie && (top.acctHit || (top.surnameHit && top.lenderHit && top.amountHit))) ? "high" : "low";
      res.note = top.why.join(" + ") + (tie ? " (tied)" : "");
      res.expected = r44FeeVerdict(gross, top.expected);
    }
    return res;
  });
}

/* ---------- state ---------- */

/* Cached for the life of one Money-page load: the rate card is read once and
   used by every expected-fee badge on the review screen. */
let procRatesCache = null;
let reconState = null;   // { statement, lines, cases, byLine, sugg, pairs, picks, ticks, feeFix }
const R44_CHUNK = 200;
const R44_STMT_LIST = 10;
/* R24 — a NEW named select, not a widening of BOARD_CASE_COLS. The board's
   columns are the board's; this read wants proc_fee/proc_fee_paid_at/
   completed_at, which the board has no use for, and coupling them would make
   every future change to one a change to the other. */
const R44_CASE_COLS = "id,lender,stage,loan_amount,proc_fee,proc_fee_paid_at,completed_at,assigned_to,clients!client_id(first_name,last_name)";
const R44_CANDIDATE_MONTHS = 18;

async function loadProcRates(force) {
  if (!showMoney()) return [];
  if (procRatesCache && !force) return procRatesCache;
  const { data, error } = await readAll(db.from("proc_rates")
    .select("id,lender,product,lg_code,rate,notes,effective_label,uploaded_at")
    .order("id"));
  if (error) { procRatesCache = null; return []; }
  procRatesCache = data || [];
  return procRatesCache;
}
/* ONE bounded read. Live cases at offer/exchange plus completions that could
   still be waiting on money: completed inside ~18 months, or completed at any
   time with no proc-fee date on them yet (an old case nobody was ever paid for
   is exactly the case a statement might finally settle). The stage narrowing is
   server-side; the completed-window narrowing is applied to the returned rows
   rather than as an .or() with an ISO timestamp inside it, which PostgREST's
   filter grammar makes fragile to quote. */
async function r44LoadCandidateCases() {
  const { data, error } = await readAll(db.from("cases").select(R44_CASE_COLS)
    .in("stage", ["offer", "exchange", "completed"])
    .order("id"));
  if (error) return [];
  const cutoff = new Date(Date.now() - R44_CANDIDATE_MONTHS * 30.5 * 86400000).toISOString();
  return (data || []).filter((c) => c.stage !== "completed" || !c.proc_fee_paid_at || !c.completed_at || c.completed_at >= cutoff);
}
async function r44LoadPriorLines() {
  const { data, error } = await readAll(db.from("commission_lines")
    .select("account_number,matched_case_id")
    .eq("match_status", "confirmed").neq("account_number", "").order("id"));
  if (error) return [];
  return (data || []).filter((r) => r && r.matched_case_id);
}

/* ---------- T1 · panel render + upload ---------- */

function r44CaseLabel(c) {
  if (!c) return "(unknown case)";
  const nm = [((c.clients || {}).first_name), ((c.clients || {}).last_name)].filter(Boolean).join(" ");
  return nm || "(no name)";
}
/* R81 · A2 — `pre`: loadMoneyPage hands the rates it already read in wave 1 (the R80
   renderClawbackWindow(pre) pattern). Every other caller passes nothing and keeps the
   exact old force-re-read behaviour. */
async function renderProcRatesPanel(pre) {
  const panel = $("#money-procrates-panel"), status = $("#procrates-status");
  if (!panel || !status) return;
  if (!showMoney()) { panel.classList.add("hidden"); status.textContent = ""; return; }
  panel.classList.remove("hidden");
  const rates = pre || await loadProcRates(true);
  if (!rates.length) {
    status.innerHTML = `<strong>No rates uploaded yet — expected-fee checks are off.</strong> Upload the network's proc-rate card and every mortgage receipt on a statement gains an expected-fee badge.`;
    return;
  }
  const at = rates.reduce((a, r) => (r.uploaded_at && (!a || r.uploaded_at > a) ? r.uploaded_at : a), null);
  const label = (rates.find((r) => r.effective_label) || {}).effective_label || "";
  status.innerHTML = `<strong>${rates.length} rate${rates.length === 1 ? "" : "s"}</strong> · uploaded ${at ? fmtD(at) : "—"} · ${esc(label) || '<span class="cs-muted">no file label</span>'}`;
}
async function r44UploadProcRates(file) {
  if (!showMoney()) return toast("Proc rates are Owner-only.");
  const status = $("#procrates-status");
  try { await ensureXlsx(); } catch (e) { return toast(e.message); } // R55 · F7 — lazy-loaded
  let parsed;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    parsed = parseProcRatesWorkbook(wb);
  } catch (e) { return toast("Could not read the rate card: " + e.message); }
  if (parsed.missing && parsed.missing.length) {
    return toast(`That workbook has no ${parsed.missing.join(" / ")} column — nothing was changed.`);
  }
  if (!parsed.rows.length || !parsed.usable) {
    return toast(`No usable rates in that file${parsed.skipped ? ` — ${parsed.skipped} row(s) had a blank or out-of-range rate` : ""}. Nothing was changed.`);
  }
  const current = await loadProcRates(true);
  if (!confirm(`Replace the ${current.length} stored rate${current.length === 1 ? "" : "s"} with ${parsed.rows.length} from this file?`
    + (parsed.skipped ? `\n\n${parsed.skipped} row${parsed.skipped === 1 ? "" : "s"} had a blank or non-numeric rate and will be skipped.` : "")
    + `\n\nThe stored card is replaced wholesale — anything not in this file stops being used for expected-fee checks.`)) return;
  if (status) status.textContent = "Replacing the rate card…";
  const { error: delErr } = await db.from("proc_rates").delete().gt("id", 0);
  if (delErr) { procRatesCache = null; await renderProcRatesPanel(); return dbFail("r44UploadProcRates", delErr, "Could not clear the old rates: " + delErr.message); }   // R81 · A4
  const label = String(file.name || "").slice(0, 200);
  const stamp = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < parsed.rows.length; i += R44_CHUNK) {
    const chunk = parsed.rows.slice(i, i + R44_CHUNK).map((r) => Object.assign({}, r, { effective_label: label, uploaded_at: stamp }));
    const { error } = await db.from("proc_rates").insert(chunk);
    if (error) { procRatesCache = null; await renderProcRatesPanel(); return dbFail("r44UploadProcRates", error, `Rate upload failed after ${written} row(s): ${error.message}`); }   // R81 · A4
    written += chunk.length;
  }
  procRatesCache = null;
  await renderProcRatesPanel();
  toast(`${written} proc rate${written === 1 ? "" : "s"} stored${parsed.skipped ? ` · ${parsed.skipped} skipped` : ""}`);
}

/* ---------- T2 · statements list ---------- */

/* R81 · A2 — `pre`: loadMoneyPage hands the already-resolved {data, error} of the statements
   read it fired in wave 1, so this panel's only remaining read (the per-line counters) shares
   wave 2 with the big cases select. Every other caller passes nothing and keeps the exact old
   read-here behaviour, error shape included. */
async function renderReconPanel(pre) {
  const panel = $("#money-recon-panel"), list = $("#recon-statements"), review = $("#recon-review");
  if (!panel || !list) return;
  if (!showMoney()) {
    panel.classList.add("hidden");
    list.innerHTML = "";
    if (review) { review.innerHTML = ""; review.classList.add("hidden"); }
    reconState = null;
    return;
  }
  panel.classList.remove("hidden");
  const { data: stmts, error } = pre || await db.from("commission_statements")
    .select("id,ref,statement_label,statement_date,filename,gross_total,net_total,line_count,created_at")
    .order("id", { ascending: false }).limit(R44_STMT_LIST);
  if (error) {
    list.innerHTML = `<div class="empty">The statements table could not be read — ${esc(error.message)}</div>`;
    return;
  }
  const rows = stmts || [];
  if (!rows.length) {
    list.innerHTML = MONEY_EMPTY("No commission statement imported yet. Choose the weekly workbook above — nothing is written to a case until you review and confirm it.");
    return;
  }
  /* The per-statement counters come from the lines themselves rather than being
     denormalised onto the statement row: a confirm changes them, and a count
     that only refreshes on import would be wrong the moment anybody worked. */
  const ids = rows.map((s) => s.id);
  const { data: lineRows } = await readAll(db.from("commission_lines")
    .select("id,statement_id,tran_type,policy_group,addressee,reason,match_status,banked_gross")
    .in("statement_id", ids).order("id"));
  const byStmt = {};
  (lineRows || []).forEach((l) => { (byStmt[l.statement_id] = byStmt[l.statement_id] || []).push(l); });
  list.innerHTML = rows.map((s) => {
    const ls = byStmt[s.id] || [];
    const mort = ls.filter((l) => r44LineKind(l) === "mortgage").length;
    const conf = ls.filter((l) => l.match_status === "confirmed").length;
    const tb = ls.filter((l) => r44LineKind(l) === "takeback").length;
    return `<div class="recon-stmt row-item" data-stmt="${esc(s.id)}">
      <div class="row-main">
        <div class="t">${esc(s.ref) || '<span class="cs-muted">(no ref)</span>'} <span class="cs-muted">· ${s.statement_date ? fmtD(s.statement_date) : "no date"}</span></div>
        <div class="s">${fmtM2(s.gross_total)} gross / ${fmtM2(s.net_total)} net · ${mort} mortgage receipt${mort === 1 ? "" : "s"} · ${conf} confirmed${tb ? ` · <span class="badge red">${tb} takeback${tb === 1 ? "" : "s"}</span>` : ""} · <span class="cs-muted">${esc(s.filename || s.statement_label || "")}</span></div>
      </div>
      <button type="button" class="btn btn-sm recon-review-btn" id="recon-review-btn-${esc(s.id)}" data-stmt="${esc(s.id)}">Review</button>
    </div>`;
  }).join("");
}

/* ---------- T2 · import ---------- */

const R44_LINE_DB_COLS = ["line_date", "tran_type", "addressee", "provider", "account_number", "opp_id",
  "reason", "policy_type", "policy_group", "adviser_name", "premium", "banked_gross", "banked_net"];
function r44LineDbRow(l) {
  const o = {};
  R44_LINE_DB_COLS.forEach((k) => { o[k] = l[k] == null ? (k === "premium" || k === "banked_gross" || k === "banked_net" || k === "line_date" ? null : "") : l[k]; });
  return o;
}
async function r44ImportStatement(file) {
  if (!showMoney()) return toast("Statement import is Owner-only.");
  try { await ensureXlsx(); } catch (e) { return toast(e.message); } // R55 · F7 — lazy-loaded
  const status = $("#recon-status");
  if (status) status.textContent = `Reading ${file.name}…`;
  let parsed;
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    parsed = parseStatementWorkbook(wb);
  } catch (e) { if (status) status.textContent = ""; return toast("Could not read the statement: " + e.message); }
  if (status) status.textContent = "";
  if (parsed.missing && parsed.missing.length) {
    return toast("That workbook has no commission-statement header row (no “Date” column) — nothing was imported.");
  }
  if (!parsed.lines.length) return toast("No commission lines found in that workbook — nothing was imported.");

  const { data: st, error: sErr } = await db.from("commission_statements").insert({
    ref: parsed.ref || "",
    statement_label: parsed.label || "",
    statement_date: parsed.statementDate || null,
    filename: String(file.name || "").slice(0, 300),
    gross_total: parsed.gross,
    net_total: parsed.net,
    line_count: parsed.lines.length,
  }).select("id,ref,statement_label,statement_date,filename,gross_total,net_total,line_count").single();
  if (sErr) {
    /* The unique index on ref is the double-upload guard, and it is the reason
       the statement row goes in FIRST: nothing else is written until it lands. */
    if (String(sErr.code) === "23505") return toast(`Statement ${parsed.ref || "(no ref)"} is already imported`);
    return dbFail("r44ImportStatement", sErr, "Could not save the statement: " + sErr.message);   // R81 · A4
  }
  const [cases, priors, rates] = await Promise.all([r44LoadCandidateCases(), r44LoadPriorLines(), loadProcRates()]);
  const sugg = suggestStatementMatches(parsed.lines, cases, priors, rates);
  /* R48 — every line is attributed at import so the per-person tally is never
     blank. The suggested case (when there is one) is the matchedCase, looked up
     in the already-loaded candidate cases; a confirm later re-homes it (T3). */
  const { ownerId, nameToId } = r44StaffMaps();
  const caseById = {};
  cases.forEach((c) => { if (c && c.id) caseById[c.id] = c; });
  const payload = parsed.lines.map((l, i) => {
    const s = sugg[i];
    const row = r44LineDbRow(l);
    row.statement_id = st.id;
    row.matched_case_id = R44_MATCHABLE[s.kind] ? (s.suggested || null) : null;
    row.match_status = !R44_MATCHABLE[s.kind] ? "na" : (s.suggested ? "suggested" : "unmatched");
    row.match_note = s.suggested ? `${s.confidence === "high" ? "high" : "low"} · ${s.note}`.slice(0, 200) : "";
    row.attributed_to = r44AttributeLine(l, s.kind, s.suggested ? caseById[s.suggested] : null, nameToId, ownerId);
    return row;
  });
  let ok = true, msg = "";
  for (let i = 0; i < payload.length; i += R44_CHUNK) {
    const { error } = await db.from("commission_lines").insert(payload.slice(i, i + R44_CHUNK));
    if (error) { ok = false; msg = error.message; break; }
  }
  if (!ok) {
    /* No half-import. The statement row goes, and the FK cascade takes whatever
       lines did land with it. */
    /* R81 · A4 — the clean-up delete's result was IGNORED: if it fails, the orphaned statement
       row keeps its unique ref and silently blocks every re-import of the same file. Logged
       (quietly — the lines toast below is the one the user must read; two toasts would race). */
    const { error: cleanErr } = await db.from("commission_statements").delete().eq("id", st.id);
    if (cleanErr) { try { logClientError("caught", cleanErr.message || "(no message)", { where: "r44ImportStatement cleanup", quiet: true }); } catch (_) { /* logging must never block the toast */ } }
    return dbFail("r44ImportStatement", { message: msg }, "The statement lines could not be saved, so nothing was imported: " + msg);   // R81 · A4
  }
  await renderReconPanel();
  await openReconReview(st.id);
  const high = sugg.filter((s) => s.confidence === "high").length;
  toast(`Imported ${payload.length} line${payload.length === 1 ? "" : "s"} · ${high} confident match${high === 1 ? "" : "es"} — nothing is written to a case until you confirm.`);
}

/* ---------- T2 · the review screen ---------- */

const R44_GROUPS = [
  { key: "mortgage", title: "Mortgage receipts", sub: "Confirming one stamps the proc fee paid on the case, dated the day the money arrived." },
  { key: "takeback", title: "Takebacks", sub: "Money the network has taken back. A real clawback raises a task for you; one reversed inside this same statement does not." },
  { key: "protection", title: "Protection receipts", sub: "Confirming one writes a case note only — there is no protection fee column to date, and we do not invent schema." },
  { key: "renewal", title: "Renewal commissions", sub: "The “VARIOUS” trailer: no addressee, nothing to match. Imported as not-applicable and shown as one total." },
  { key: "other", title: "Other lines", sub: "Imported, counted, and not matchable — shown so nothing on the statement is silently invisible." },
];
async function openReconReview(stmtId) {
  const review = $("#recon-review");
  if (!review) return;
  if (!showMoney()) return;
  review.classList.remove("hidden");
  review.innerHTML = `<div class="empty">Loading the statement…</div>`;
  const [{ data: st, error: sErr }, { data: lines, error: lErr }] = await Promise.all([
    db.from("commission_statements").select("id,ref,statement_label,statement_date,filename,gross_total,net_total,line_count").eq("id", stmtId).maybeSingle(),
    readAll(db.from("commission_lines").select("*").eq("statement_id", stmtId).order("id")),
  ]);
  if (sErr || lErr || !st) {
    review.innerHTML = `<div class="empty">That statement could not be read${sErr || lErr ? " — " + esc((sErr || lErr).message) : ""}.</div>`;
    return;
  }
  const [cases, priors, rates] = await Promise.all([r44LoadCandidateCases(), r44LoadPriorLines(), loadProcRates()]);
  const ls = lines || [];
  /* The suggestions are recomputed from the stored lines on every open rather
     than being read back off the row: the review has to survive a reload, and
     the board moves between one import and the next. What IS read back off the
     row is the human's decision — matched_case_id, match_status — which is the
     only part a recompute must never overwrite. */
  const sugg = suggestStatementMatches(ls, cases, priors, rates);
  /* R48 — staff maps for the per-person tally, the "attribute to …" select, and
     the ownerId fallback the confirm/attribute paths need. */
  const { ownerId, staff } = r44StaffMaps();
  reconState = {
    statement: st, lines: ls, cases, rates,
    sugg, byIndex: {}, byLine: {},
    picks: {}, ticks: {}, feeFix: {},
    ownerId, staff,
  };
  ls.forEach((l, i) => {
    reconState.byIndex[l.id] = i;
    reconState.byLine[l.id] = l;
    const s = sugg[i];
    reconState.picks[l.id] = l.matched_case_id || (l.match_status === "dismissed" ? "" : (s.suggested || ""));
    reconState.ticks[l.id] = l.match_status !== "confirmed" && l.match_status !== "dismissed" && s.confidence === "high" && !!reconState.picks[l.id];
    reconState.feeFix[l.id] = false;
  });
  renderReconReview();
}
function r44Chip(text, cls) { return `<span class="badge ${cls || "grey"}">${esc(text)}</span>`; }
/* Only on a mortgage RECEIPT. A takeback measured against an expected proc fee
   would read "£375 over" on money that has gone the other way, which is a
   sentence nobody should have to decode at speed. */
function r44ExpectedBadge(line, caseRow, rates) {
  if (!caseRow || r44LineKind(line) !== "mortgage") return "";
  const v = r44FeeVerdict(line.banked_gross, r44ExpectedFee(line.provider, caseRow.loan_amount, rates));
  if (!v) return "";
  if (v.verdict === "within") return r44Chip("≈ expected", "green");
  return r44Chip(`${fmtM2(v.delta)} ${v.verdict}`, "amber");
}
/* R48 — the "attribute to a person" control: sets attributed_to directly,
   WITHOUT requiring a case (income with no case in the system, or correcting the
   import guess). The select defaults to the line's current attribution, or the
   owner when it is null. "no case — just income" also parks match_status at `na`
   so the line stops asking for a case decision. Only on non-locked matchable
   lines; a confirmed line is already placed. */
function r44AttrControl(l) {
  const st = reconState;
  if (l.match_status === "confirmed") return "";
  const staff = st.staff || [];
  if (!staff.length) return "";
  const cur = l.attributed_to || st.ownerId || "";
  const optsHtml = staff.map((p) => `<option value="${esc(p.id)}"${p.id === cur ? " selected" : ""}>${esc(p.full_name || p.email || p.id)}${p.role === "owner" ? " (owner)" : ""}</option>`).join("");
  return `<div class="recon-attr" data-line="${esc(l.id)}">
      <span class="recon-attr-lbl">Attribute to</span>
      <select class="recon-attr-pick" id="recon-attr-${esc(l.id)}" data-line="${esc(l.id)}" aria-label="Attribute this income to a person">${optsHtml}</select>
      <label class="recon-attr-nocase-wrap"><input type="checkbox" class="recon-attr-nocase" id="recon-attr-nocase-${esc(l.id)}" data-line="${esc(l.id)}"> <span>no case — just income</span></label>
      <button type="button" class="btn btn-sm recon-attr-set" id="recon-attr-set-${esc(l.id)}" data-line="${esc(l.id)}">Set person</button>
    </div>`;
}
function r44MatchCell(l) {
  const st = reconState;
  const i = st.byIndex[l.id];
  const s = st.sugg[i] || { candidates: [], confidence: null };
  const locked = l.match_status === "confirmed";
  const picked = st.picks[l.id] || "";
  const caseById = {};
  st.cases.forEach((c) => { caseById[c.id] = c; });
  /* The short-list is the scored candidates. When scoring found nobody the
     select still has to be usable, so it falls back to the nearest cases by
     unpaid proc fee — the operator can always pick, and "— none —" stays the
     honest default. */
  let opts = s.candidates.map((c) => c.case);
  if (!opts.length) {
    opts = st.cases.filter((c) => !c.proc_fee_paid_at)
      .map((c) => ({ c, d: Math.abs(Math.abs(Number(l.banked_gross || 0)) - Number(c.proc_fee || 0)) }))
      .sort((a, b) => a.d - b.d).slice(0, 10).map((x) => x.c);
  }
  if (picked && !opts.some((c) => c.id === picked) && caseById[picked]) opts.unshift(caseById[picked]);
  const sel = caseById[picked] || null;
  const conf = s.confidence === "high" ? r44Chip("confident", "green") : (s.suggested ? r44Chip("check this", "amber") : "");
  const head = sel
    ? `<div class="recon-suggest">→ <strong>${esc(r44CaseLabel(sel))}</strong> · ${esc(sel.lender || "no lender")} · ${esc(STAGE_LABEL[sel.stage] || sel.stage || "")} ${conf} ${r44ExpectedBadge(l, sel, st.rates)}</div>`
    : `<div class="recon-suggest cs-muted">no case suggested — pick one, or leave it</div>`;
  if (locked) {
    return `${head}<div class="s cs-muted">Confirmed ${l.confirmed_at ? fmtD(l.confirmed_at) : ""}${l.match_note ? ` · ${esc(l.match_note)}` : ""}</div>`;
  }
  return `${head}
    <div class="recon-controls">
      <label class="recon-tick-wrap"><input type="checkbox" class="recon-tick" id="recon-tick-${esc(l.id)}" data-line="${esc(l.id)}" ${st.ticks[l.id] ? "checked" : ""} ${picked ? "" : "disabled"}> <span>tick</span></label>
      <select class="recon-pick" id="recon-pick-${esc(l.id)}" data-line="${esc(l.id)}" aria-label="Case for this line">
        <option value="">— none —</option>
        ${opts.map((c) => `<option value="${esc(c.id)}"${c.id === picked ? " selected" : ""}>${esc(r44CaseLabel(c))} · ${esc(c.lender || "no lender")} · ${esc(fmtM(c.proc_fee))}${c.proc_fee_paid_at ? " · paid" : ""}</option>`).join("")}
      </select>
      <button type="button" class="btn btn-sm recon-confirm" id="recon-confirm-${esc(l.id)}" data-line="${esc(l.id)}">Confirm</button>
      <button type="button" class="btn btn-sm recon-dismiss" id="recon-dismiss-${esc(l.id)}" data-line="${esc(l.id)}">${l.match_status === "dismissed" ? "Un-dismiss" : "Dismiss"}</button>
    </div>
    ${r44AttrControl(l)}
    ${r44FeeDeltaHtml(l, sel)}
    ${l.match_note ? `<div class="s cs-muted">${esc(l.match_note)}</div>` : ""}`;
}
/* The proc fee on the case and the gross actually banked disagreeing by more
   than a pound is not a thing to fix silently — it is a thing to show. The
   checkbox is OFF by default: the number on the case may well be the right one
   and the network's the mistake. */
const R44_FEE_DELTA_MIN = 1;
function r44FeeDeltaHtml(l, sel) {
  if (!sel || r44LineKind(l) !== "mortgage") return "";
  const gross = Math.abs(Number(l.banked_gross || 0));
  const have = Number(sel.proc_fee || 0);
  if (!have) return `<div class="s recon-note">The case has no proc fee recorded — confirming sets it to ${fmtM2(gross)}.</div>`;
  if (Math.abs(have - gross) <= R44_FEE_DELTA_MIN) return "";
  return `<label class="recon-feefix"><input type="checkbox" class="recon-feefix-chk" id="recon-feefix-${esc(l.id)}" data-line="${esc(l.id)}" ${reconState.feeFix[l.id] ? "checked" : ""}>
    <span>Case says ${fmtM2(have)}, statement banked ${fmtM2(gross)} — update case proc fee to ${fmtM2(gross)}</span></label>`;
}
function r44LineRow(l, kind) {
  const paired = (() => { const s = reconState.sugg[reconState.byIndex[l.id]]; return s && s.pairedWith != null; })();
  const cls = ["recon-line"];
  if (kind === "takeback") cls.push("recon-takeback");
  if (l.match_status === "confirmed") cls.push("is-confirmed");
  if (l.match_status === "dismissed") cls.push("is-dismissed");
  if (r44NeedsYou(l)) cls.push("recon-needs-line");   // R48 — a queue line, styled + testable
  return `<div class="${cls.join(" ")}" data-line="${esc(l.id)}" data-kind="${esc(kind)}" data-status="${esc(l.match_status || "")}" data-needs="${r44NeedsYou(l) ? "1" : "0"}" data-attr="${esc(l.attributed_to || "")}">
    <div class="recon-facts">
      <div class="t">${l.line_date ? fmtD(l.line_date) : "—"} · <strong>${esc(l.addressee) || '<span class="cs-muted">(no addressee)</span>'}</strong></div>
      <div class="s">${esc(l.provider || "no provider")} · ${esc(l.account_number || "no account")} · ${fmtM2(l.banked_gross)} gross / ${fmtM2(l.banked_net)} net${l.adviser_name ? ` · ${esc(l.adviser_name)}` : ""}</div>
      ${paired ? `<div class="s">${r44Chip("reversed in-statement · net £0", "grey")}</div>` : ""}
    </div>
    <div class="recon-match">${r44MatchCell(l)}</div>
  </div>`;
}
/* R48 — the per-person "received this statement" tally: net banked grouped by
   attributed_to, dismissed lines excluded. The owner's row is annotated with the
   insurance slice (all the misc-insurance net that sits under them). A null
   attribution rolls up into an "Unassigned — needs you" row. */
function r44TallyHtml() {
  const st = reconState;
  const byPerson = {};
  const ownerInsurance = {};
  let unassignedNet = 0, unassignedCount = 0;
  st.lines.forEach((l) => {
    if (l.match_status === "dismissed") return;
    const net = Number(l.banked_net || 0);
    const att = l.attributed_to || null;
    if (!att) { unassignedNet += net; unassignedCount++; return; }
    byPerson[att] = (byPerson[att] || 0) + net;
    if (att === st.ownerId && r44IsMiscInsurance(l)) ownerInsurance[att] = (ownerInsurance[att] || 0) + net;
  });
  const staff = st.staff || [];
  const seen = {};
  const order = [];
  staff.forEach((p) => { if (p && byPerson[p.id] != null && !seen[p.id]) { order.push(p.id); seen[p.id] = true; } });
  Object.keys(byPerson).forEach((id) => { if (!seen[id]) { order.push(id); seen[id] = true; } });
  const rows = order.map((id) => {
    const ins = (id === st.ownerId && ownerInsurance[id]) ? ` <span class="cs-muted">(incl. ${fmtM2(ownerInsurance[id])} insurance)</span>` : "";
    return `<div class="recon-tally-row${id === st.ownerId ? " recon-tally-owner" : ""}" data-person="${esc(id)}"><span class="recon-tally-name">${esc(staffName(id))}</span><span class="recon-tally-net num">${fmtM2(byPerson[id])}</span>${ins}</div>`;
  });
  if (unassignedCount) {
    rows.push(`<div class="recon-tally-row recon-tally-unassigned" data-person=""><span class="recon-tally-name">Unassigned — needs you (${unassignedCount})</span><span class="recon-tally-net num">${fmtM2(unassignedNet)}</span></div>`);
  }
  if (!rows.length) return "";
  return `<div class="recon-tally" id="recon-tally">
    <h5>Received this statement <span class="cs-muted">(net, by person)</span></h5>
    ${rows.join("")}
  </div>`;
}
function renderReconReview() {
  const review = $("#recon-review");
  const st = reconState;
  if (!review || !st) return;
  const s = st.statement;
  const advisers = [];
  st.lines.forEach((l) => { const a = String(l.adviser_name || "").trim(); if (a && advisers.indexOf(a) < 0) advisers.push(a); });
  const byKind = {};
  st.lines.forEach((l) => { const k = r44LineKind(l); (byKind[k] = byKind[k] || []).push(l); });
  const pending = st.lines.filter((l) => R44_MATCHABLE[r44LineKind(l)] && l.match_status !== "confirmed").length;
  const needs = st.lines.filter(r44NeedsYou).length;   // R48 — the "needs you" queue count
  let html = `<div class="recon-review-head" id="recon-review-head">
    <div>
      <h4>Statement ${esc(s.ref) || "(no ref)"} · ${s.statement_date ? fmtD(s.statement_date) : "no date"}</h4>
      <p class="panel-sub">${st.lines.length} line${st.lines.length === 1 ? "" : "s"} · ${advisers.length} adviser${advisers.length === 1 ? "" : "s"} · ${fmtM2(s.gross_total)} gross / ${fmtM2(s.net_total)} net · <span class="cs-muted">${esc(s.filename || s.statement_label || "")}</span></p>
    </div>
    <div class="recon-review-tools">
      <span class="recon-needs${needs ? " is-live" : ""}" id="recon-needs">Needs you (<span id="recon-needs-count">${needs}</span>)</span>
      <button type="button" class="btn btn-sm btn-primary" id="recon-confirm-ticked"${pending ? "" : " disabled"}>Confirm ticked</button>
      <button type="button" class="btn btn-sm" id="recon-close">Close review</button>
    </div>
  </div>
  ${r44TallyHtml()}`;
  R44_GROUPS.forEach((g) => {
    const ls = byKind[g.key] || [];
    if (!ls.length) return;
    html += `<div class="recon-group" id="recon-group-${g.key}" data-count="${ls.length}">
      <h5>${esc(g.title)} <span class="cs-muted">(${ls.length})</span></h5>
      <p class="panel-sub">${g.sub}</p>`;
    if (g.key === "renewal") {
      /* One aggregate line per group, not 12 rows of nothing to decide. */
      const groups = {};
      ls.forEach((l) => { const k = String(l.adviser_name || "").trim() || "(no adviser)"; (groups[k] = groups[k] || []).push(l); });
      html += Object.keys(groups).map((k) => {
        const rows = groups[k];
        const gr = rows.reduce((a, x) => a + Number(x.banked_gross || 0), 0);
        const nt = rows.reduce((a, x) => a + Number(x.banked_net || 0), 0);
        return `<div class="recon-line recon-agg" data-adviser="${esc(k)}"><div class="recon-facts"><div class="t">${esc(k)}</div><div class="s">Renewals: ${rows.length} line${rows.length === 1 ? "" : "s"} · ${fmtM2(gr)} gross / ${fmtM2(nt)} net</div></div></div>`;
      }).join("");
    } else if (g.key === "other") {
      html += ls.map((l) => `<div class="recon-line recon-agg" data-line="${esc(l.id)}"><div class="recon-facts"><div class="t">${l.line_date ? fmtD(l.line_date) : "—"} · ${esc(l.tran_type || "")}</div><div class="s">${esc(l.provider || "")} · ${esc(l.account_number || "")} · ${fmtM2(l.banked_gross)} gross</div></div></div>`).join("");
    } else {
      html += ls.map((l) => r44LineRow(l, g.key)).join("");
    }
    html += `</div>`;
  });
  review.innerHTML = html;
}

/* ---------- T2 · confirm / dismiss ---------- */

function r44NoteDate(l) { return String(l.line_date || "").slice(0, 10); }
/* One line's confirm. Returns a short outcome string for the bulk runner, or
   throws nothing — every failure is reported and the line is left alone. */
async function r44ConfirmLine(lineId, opts) {
  const st = reconState;
  if (!st) return "no statement open";
  const l = st.byLine[lineId];
  if (!l) return "line not found";
  if (l.match_status === "confirmed") return "already confirmed";
  const kind = r44LineKind(l);
  if (!R44_MATCHABLE[kind]) return "nothing to confirm on this line";
  const caseId = st.picks[lineId] || "";
  if (!caseId) return "pick a case first";
  const sug = st.sugg[st.byIndex[lineId]] || {};
  const ref = st.statement.ref || "(no ref)";
  const gross = Math.abs(Number(l.banked_gross || 0));
  const where = `${l.provider || "no provider"} ${l.account_number || "no account"}`.trim();

  /* Read the case FRESH — the review may have been open for a while, and the
     legacy-column rule has to be computed against what is stored now. */
  const { data: c, error: cErr } = await db.from("cases")
    .select("id,proc_fee,proc_fee_paid_at,sols_fee,sols_fee_paid_at,broker_fee,broker_fee_paid_at,fee_status,fee_paid_at,lender,assigned_to,clients!client_id(first_name,last_name)")
    .eq("id", caseId).maybeSingle();
  if (cErr || !c) return "the case could not be read" + (cErr ? ": " + cErr.message : "");
  const who = r44CaseLabel(c);
  const paired = sug.pairedWith != null;
  const linePatch = { match_status: "confirmed", matched_case_id: caseId, confirmed_at: new Date().toISOString() };

  if (kind === "takeback" && !paired) {
    /* A REAL clawback. The paid date stays exactly where it is — what was
       banked was banked, and rewriting that history would take the case off
       the cash figures for a month it really did earn. The action is a task. */
    const body = `CLAWBACK ${fmtM2(gross)} — ${where}, statement ${ref}`;
    const { error: nErr } = await db.from("case_notes").insert({ case_id: caseId, body, created_by: (ME && ME.id) || null });
    if (nErr) return "the clawback note could not be written: " + nErr.message;
    const { error: tErr } = await db.from("case_tasks").insert({
      case_id: caseId,
      title: `Clawback: ${fmtM2(gross)} — ${who} (${l.provider || "no provider"})`,
      due_date: localDateStr(),
      created_by: (ME && ME.id) || null,
      assigned_to: (ME && ME.id) || null,
    });
    linePatch.match_note = tErr ? `clawback flagged · task failed: ${tErr.message}`.slice(0, 200) : "clawback flagged · owner task raised";
    const { error: lErr } = await db.from("commission_lines").update(linePatch).eq("id", lineId);
    if (lErr) return "the line could not be marked confirmed: " + lErr.message;
    Object.assign(l, linePatch);
    return tErr ? `clawback noted, but the task failed: ${tErr.message}` : `clawback flagged on ${who} — task raised for today`;
  }

  if (kind === "takeback" && paired) {
    /* Reversed inside this same statement: ONE note, no paid date, no task. */
    const other = st.lines[sug.pairedWith];
    const body = `Commission ${fmtM2(gross)} taken back and re-banked within the same statement ${ref} — net £0 (${where})`;
    const { error: nErr } = await db.from("case_notes").insert({ case_id: caseId, body, created_by: (ME && ME.id) || null });
    if (nErr) return "the reversal note could not be written: " + nErr.message;
    linePatch.match_note = "reversed in-statement · net £0";
    const { error: lErr } = await db.from("commission_lines").update(linePatch).eq("id", lineId);
    if (lErr) return "the line could not be marked confirmed: " + lErr.message;
    Object.assign(l, linePatch);
    if (other && other.match_status !== "confirmed") {
      const p2 = { match_status: "confirmed", matched_case_id: caseId, confirmed_at: linePatch.confirmed_at, match_note: "reversed in-statement · net £0" };
      const { error: oErr } = await db.from("commission_lines").update(p2).eq("id", other.id);
      if (!oErr) { Object.assign(other, p2); st.picks[other.id] = caseId; }
    }
    return `reversal pair confirmed on ${who} — one note, no paid date`;
  }

  if (kind === "protection") {
    const body = `Protection commission ${fmtM2(gross)} banked ${fmtD(r44NoteDate(l))} — ${where}`;
    const { error: nErr } = await db.from("case_notes").insert({ case_id: caseId, body, created_by: (ME && ME.id) || null });
    if (nErr) return "the note could not be written: " + nErr.message;
    linePatch.match_note = "protection commission — note only";
    const { error: lErr } = await db.from("commission_lines").update(linePatch).eq("id", lineId);
    if (lErr) return "the line could not be marked confirmed: " + lErr.message;
    Object.assign(l, linePatch);
    return `${who} — protection commission noted`;
  }

  /* MORTGAGE RECEIPT — the one path that writes money onto a case. */
  const procType = FEE_TYPES.filter((t) => t.key === "proc")[0];
  const wantFeeFix = !!(opts && opts.feeFix) || !!st.feeFix[lineId];
  const have = Number(c.proc_fee || 0);
  const setProcFee = !have || (wantFeeFix && Math.abs(have - gross) > R44_FEE_DELTA_MIN);
  // The case AS IT WILL BE, so feePaidPatch judges "every fee that has an
  // amount now has a date" against the amount this write is about to store.
  const cAfter = Object.assign({}, c, setProcFee ? { proc_fee: gross } : {});
  const { patch, complete } = feePaidPatch(cAfter, [{ t: procType, date: r44NoteDate(l) }]);
  if (setProcFee) patch.proc_fee = gross;
  let { error: uErr } = await db.from("cases").update(patch).eq("id", caseId);
  let legacyOnly = false;
  if (uErr && isMissingColumnError(uErr)) {
    /* Pre-M2 database: no per-fee-type dates to write. Same fallback markFeePaid
       takes, for the same reason — one date for the lot rather than nothing. */
    const legacy = { fee_status: "paid", fee_paid_at: feeDateToTs(r44NoteDate(l)) };
    if (setProcFee) legacy.proc_fee = gross;
    ({ error: uErr } = await db.from("cases").update(legacy).eq("id", caseId));
    legacyOnly = !uErr;
  }
  if (uErr) return "the case could not be updated: " + uErr.message;
  const body = `Proc fee ${fmtM2(gross)} banked ${fmtD(r44NoteDate(l))} — Stonebridge statement ${ref} (${where})`;
  const { error: nErr } = await db.from("case_notes").insert({ case_id: caseId, body, created_by: (ME && ME.id) || null });
  /* R48 — confirming a mortgage receipt against a case re-homes the income onto
     the case's TRUE adviser (the owner for the ex-broker cases the import
     assigned to the owner), overriding any import-time name guess. Written in
     the SAME line update as match_status/matched_case_id/confirmed_at. Misc
     insurance never reaches here — its note-only confirm keeps owner attribution. */
  linePatch.attributed_to = c.assigned_to || null;
  linePatch.match_note = [
    "proc fee dated " + r44NoteDate(l),
    setProcFee ? (have ? "case proc fee updated" : "case proc fee set") : "",
    complete ? "case now reads paid" : "",
    legacyOnly ? "legacy fee columns only (pre-M2)" : "",
    nErr ? "note failed" : "",
  ].filter(Boolean).join(" · ").slice(0, 200);
  const { error: lErr } = await db.from("commission_lines").update(linePatch).eq("id", lineId);
  if (lErr) return "the case was updated but the line could not be marked confirmed: " + lErr.message;
  Object.assign(l, linePatch);
  Object.assign(c, patch);
  const cached = st.cases.filter((x) => x.id === caseId)[0];
  if (cached) { cached.proc_fee_paid_at = patch.proc_fee_paid_at || cached.proc_fee_paid_at; if (setProcFee) cached.proc_fee = gross; }
  return `${who} — proc fee ${fmtM2(gross)} dated ${fmtD(r44NoteDate(l))}${complete ? ", case now reads paid" : ""}`;
}
async function r44DismissLine(lineId) {
  const st = reconState;
  if (!st) return;
  const l = st.byLine[lineId];
  if (!l) return;
  if (l.match_status === "confirmed") return toast("That line is confirmed — it cannot be dismissed.");
  const next = l.match_status === "dismissed"
    ? { match_status: st.picks[lineId] ? "suggested" : "unmatched", match_note: "" }
    : { match_status: "dismissed", match_note: "dismissed by hand" };
  const { error } = await db.from("commission_lines").update(next).eq("id", lineId);
  if (error) return dbFail("r44DismissLine", error);
  Object.assign(l, next);
  if (next.match_status === "dismissed") st.ticks[lineId] = false;
  renderReconReview();
  toast(next.match_status === "dismissed" ? "Line dismissed" : "Line back in the queue");
}
/* R48 — set a line's attributed_to directly, no case required. This is the
   manual half of the "needs you" queue: a receipt that is just income with no
   case in the system, or a correction to the import's name guess. It writes
   ONLY attribution (leaving match_status as-is), unless the owner ticks "no case
   — just income", which also parks the line at `na` so it stops asking to be
   matched. A later deliberate case-confirm is the only thing that overrides it. */
async function r44AttributeLineTo(lineId, profileId, noCase) {
  const st = reconState;
  if (!st) return;
  const l = st.byLine[lineId];
  if (!l) return;
  if (l.match_status === "confirmed") return toast("That line is confirmed — its attribution follows the case.");
  const patch = { attributed_to: profileId || null };
  if (noCase && l.match_status !== "na") patch.match_status = "na";
  const { error } = await db.from("commission_lines").update(patch).eq("id", lineId);
  if (error) return dbFail("r44AttributeLineTo", error);
  Object.assign(l, patch);
  if (patch.match_status === "na") st.ticks[lineId] = false;
  renderReconReview();
  toast(`Attributed to ${staffName(profileId)}${patch.match_status === "na" ? " · no case, just income" : ""}`);
}
async function r44ConfirmTicked() {
  const st = reconState;
  if (!st) return;
  const ids = Object.keys(st.ticks).filter((k) => st.ticks[k] && st.byLine[k] && st.byLine[k].match_status !== "confirmed");
  if (!ids.length) return toast("Nothing is ticked.");
  if (!confirm(`Confirm ${ids.length} line${ids.length === 1 ? "" : "s"}?\n\nThis writes the payment onto each matched case — proc fees get a paid date, clawbacks raise a task for you, and every case gets a note. It cannot be undone from here.`)) return;
  const results = [];
  for (const id of ids) results.push(await r44ConfirmLine(id));
  renderReconReview();
  await renderReconPanel();
  toast(`Confirmed ${ids.length} line${ids.length === 1 ? "" : "s"} — ${results[results.length - 1]}`);
}

/* ---------- wiring ----------
   Bound ONCE, imperatively, on nodes that live in the shipped markup and are
   never re-created by a render — the same rule the Monday-money controls above
   follow. Everything inside #recon-review / #recon-statements is rewritten by
   innerHTML on every render, so those two are delegated rather than bound. */
/* R81 · A1 — LOAD-ORDER ACCOMMODATION (the one the carve's call-graph audit could not see,
   because it is a DOM dependency, not an identifier): #procrates-file and #recon-file are NOT
   in the shipped markup — app.js's eval-time mountDropZone() CREATES them inside their
   *-file-slot divs, and app.js now evaluates AFTER this file. So this block runs at
   DOMContentLoaded — which fires only after every classic script has evaluated — instead of at
   this script's own eval. Same bind-once semantics, a few milliseconds later; nothing can be
   clicked before DCL. The body is byte-identical to the old IIFE's. */
(() => {
  const wireR44MoneyPanels = () => {
  const pf = $("#procrates-file");
  if (pf) pf.addEventListener("change", async () => {
    const f = pf.files && pf.files[0];
    pf.value = "";
    if (f) await r44UploadProcRates(f);
  });
  const rf = $("#recon-file");
  if (rf) rf.addEventListener("change", async () => {
    const f = rf.files && rf.files[0];
    rf.value = "";
    if (f) await r44ImportStatement(f);
  });
  const list = $("#recon-statements");
  if (list) list.addEventListener("click", (e) => {
    const btn = e.target.closest(".recon-review-btn");
    if (btn) openReconReview(btn.dataset.stmt);
  });
  const review = $("#recon-review");
  if (review) {
    review.addEventListener("click", async (e) => {
      if (e.target.closest("#recon-close")) {
        review.classList.add("hidden"); review.innerHTML = ""; reconState = null; return;
      }
      if (e.target.closest("#recon-confirm-ticked")) return r44ConfirmTicked();
      const conf = e.target.closest(".recon-confirm");
      if (conf) {
        const id = conf.dataset.line;
        conf.disabled = true;
        const msg = await r44ConfirmLine(id);
        renderReconReview();
        await renderReconPanel();
        return toast(msg);
      }
      const dis = e.target.closest(".recon-dismiss");
      if (dis) return r44DismissLine(dis.dataset.line);
      /* R48 — "attribute to a person": read the select + the no-case checkbox
         from the same control block and write attribution directly. */
      const attrSet = e.target.closest(".recon-attr-set");
      if (attrSet) {
        const wrap = attrSet.closest(".recon-attr");
        const sel = wrap && wrap.querySelector(".recon-attr-pick");
        const noCaseChk = wrap && wrap.querySelector(".recon-attr-nocase");
        attrSet.disabled = true;
        return r44AttributeLineTo(attrSet.dataset.line, sel ? sel.value : "", !!(noCaseChk && noCaseChk.checked));
      }
    });
    review.addEventListener("change", (e) => {
      const st = reconState;
      if (!st) return;
      const sel = e.target.closest(".recon-pick");
      if (sel) {
        st.picks[sel.dataset.line] = sel.value || "";
        if (!sel.value) st.ticks[sel.dataset.line] = false;
        renderReconReview();
        return;
      }
      const tick = e.target.closest(".recon-tick");
      if (tick) { st.ticks[tick.dataset.line] = tick.checked; return; }
      const fix = e.target.closest(".recon-feefix-chk");
      if (fix) { st.feeFix[fix.dataset.line] = fix.checked; return; }
    });
  }
  };   // R81 · A1 — end wireR44MoneyPanels
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireR44MoneyPanels);
  else wireR44MoneyPanels();
})();

/* R81 · A3 — deploy handshake stamp. Every round that edits ANY of index.html / core.js /
   reports-money.js / app.js bumps the tag IN ALL FOUR PLACES (see nxCheckBuildTags in app.js). */
window.__nxTag_reportsmoney = "r82";   // R82 · B2
