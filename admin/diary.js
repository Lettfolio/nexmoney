/* ==========================================================================
   NexMoney Back Office — admin/diary.js  (R90 · F)
   The DIARY page family, carved from app.js: the appointment-OUTCOME vocabulary (My Day, the case
   modal and Leads call it as globals) and the Diary itself — views, drag-to-move, clash rules, the
   appointment editor. window.quickApptOutcome stays in app.js.
   SCRIPT ORDER: core.js → reports-money.js → diary.js → import.js → vault.js →
   app.js. THE DEFINITION-TIME RULE (HARNESS.md "R78 · A" / "R81 · A"): a declaration here may
   reference nothing from a LATER script at its own definition time (call-time references are fine);
   app.js stays LAST because init()'s awaits run between classic scripts (see reports-money.js).
   ========================================================================== */

/* ==========================================================================
   R12b · W-17 / K-14 — WHAT ACTUALLY HAPPENED AT THE APPOINTMENT
   A diary that only records intentions is half a diary. Until now the ONLY
   thing that could be done to a booking after the fact was Delete, so the
   client who did not turn up and the client who was never booked left the
   database in exactly the same state — and the one question a broker asks
   about last week ("who wasted my Tuesday?") had no answer anywhere.

   `appointments.outcome` is a nullable text column (attended / no_show /
   rearranged). NULL is a real value here and means "not recorded yet", not
   "did not happen": most appointments are in the future, and a past one
   nobody has judged is honestly unknown.

   Deliberately NOT built this round: no-show ANALYTICS. Counting no-shows per
   adviser or per client is a report, and a report built on three days of
   outcome data says more about when the column shipped than about anybody's
   diary. The recording comes first; the counting is a later round's job.
   R77 · B1 — that later round arrived: renderApptOutcomes() (Reports §5,
   #report-outcomes-panel) now counts the last 90 days per adviser, leads with
   the UNRECORDED share (this comment's own caveat, made the first number),
   and lists clients with 2+ recorded no-shows. The chips here stay the one
   writer; the panel is the one reader.
   ====================================================================== */
/* R37 · W11 — the five appointment titles this back office actually books, offered as chips above
   the (still free-text) Title field. Presentation only: no column, no validation, no reporting
   hangs off this list — it exists so that the same meeting is not filed under five spellings. */
const APPT_TITLE_PICKS = ["Fact find call", "Protection review", "Review meeting", "Document collection", "Completion call"];
const APPT_OUTCOMES = [
  ["attended", "Attended", "✓"],
  ["no_show", "No-show", "✗"],
  ["rearranged", "Rearranged", "↻"],
];
const APPT_OUTCOME_LABEL = Object.fromEntries(APPT_OUTCOMES.map(([v, l]) => [v, l]));
const APPT_OUTCOME_MARK = Object.fromEntries(APPT_OUTCOMES.map(([v, , m]) => [v, m]));
const APPT_OUTCOME_TIP = {
  attended: "Recorded as attended.",
  no_show: "Recorded as a no-show — the client did not turn up.",
  rearranged: "Recorded as rearranged — this slot did not happen; any replacement is booked separately.",
};
const isApptOutcome = (v) => Object.prototype.hasOwnProperty.call(APPT_OUTCOME_LABEL, String(v || ""));
/* The badge every surface wears. Small on purpose — the outcome is a footnote on a booking, not
   the booking — and it carries its own title, because "✗" alone is a rune. */
function apptOutcomeChipHtml(outcome) {
  const v = String(outcome || "");
  if (!isApptOutcome(v)) return "";
  return `<span class="appt-outcome appt-outcome-${v}" title="${esc(APPT_OUTCOME_TIP[v])}">${esc(APPT_OUTCOME_MARK[v])} ${esc(APPT_OUTCOME_LABEL[v])}</span>`;
}
/* "Today 14:30" / "Tomorrow 09:00" / "Tue 12 Aug · 09:00". The date a human would say out loud —
   a case header has room for one line, and "12/08/2026, 09:00" spends it on punctuation. */
function apptWhenLabel(a) {
  if (!a || !a.starts_at) return "";
  const d = new Date(a.starts_at);
  if (isNaN(d)) return "";
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const ymd = localDateStr(d);
  if (ymd === localDateStr()) return `Today ${t}`;
  if (ymd === localDateStr(Date.now() + 86400000)) return `Tomorrow ${t}`;
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · ${t}`;
}
/* A no-show is the one outcome with something left to DO, so it offers the call rather than just filing the fact.
   Offered, never silent: a task appearing on somebody's list unannounced is how an app loses the operator's trust
   in every other task it creates. … */
const NO_SHOW_TASK_TITLE = (who) => `Call ${who || "the client"} — missed appointment`;
async function offerNoShowTask(appt, clientName) {
  if (!appt) return "";
  const who = String(clientName || "").trim();
  const title = NO_SHOW_TASK_TITLE(who);
  if (!appt.case_id) return " · no case is linked to this appointment, so there is nowhere to put a call-back task";
  const staffId = appt.staff_id || null;
  const due = localDateStr();
  const existing = await softRows(db.from("case_tasks").select("id,title,done_at").eq("case_id", appt.case_id));
  if (existing.some((t) => !t.done_at && String(t.title || "").trim() === title)) {
    return " · a call-back task for this is already open on the case";
  }
  const askedOf = staffId ? staffName(staffId) : "nobody in particular (this appointment has no adviser on it)";
  if (!confirm(`Recorded as a no-show.\n\nAdd a task “${title}” on the case, due today (${fmtD(due)}), for ${askedOf}?\n\nNo email or text is sent to anybody either way.`)) {
    return " · no call-back task was created";
  }
  const { error } = await db.from("case_tasks").insert({ case_id: appt.case_id, title, due_date: due, assigned_to: staffId });
  if (error) return " · the call-back task could not be created: " + error.message;
  return ` · call-back task added for ${staffId ? staffName(staffId) : "nobody yet"}, due today`;
}
/* The write itself, shared by the appointment editor's radios and My Day's ✓/✗ pair so the two can never
   disagree about what recording an outcome does. Returns the toast suffix. */
async function writeApptOutcome(appt, outcome, clientName, opts = {}) {
  const next = isApptOutcome(outcome) ? outcome : null;
  const { error } = await db.from("appointments").update({ outcome: next }).eq("id", appt.id);
  if (error) return { ok: false, msg: "Couldn't record that — " + error.message };
  let extra = "";
  if (next === "no_show" && !opts.skipTask) extra = await offerNoShowTask(appt, clientName);
  return { ok: true, msg: (next ? `Recorded: ${APPT_OUTCOME_LABEL[next].toLowerCase()}` : "Outcome cleared — back to not recorded") + extra };
}

/* ---------- Diary ---------- */
let diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
// BUILD 7d (defect 26) — stable per-adviser colour palette for the "Everyone" diary view, so
// overlapping/adjacent appointments across advisers are distinguishable at a glance. Keyed by an
// adviser's fixed index in TEAM (populated once at login, ordered by full_name, not reshuffled
// per render), so the same adviser gets the same colour all session. Single-adviser view is
// unaffected — it keeps the plain uniform CSS look.
const DIARY_PALETTE = [
  { bg: "#e8f0fa", border: "#2f6fed" }, // blue
  { bg: "#e7f6ee", border: "#16794c" }, // green
  { bg: "#faf1dc", border: "#b8860b" }, // amber
  { bg: "#f5e9fb", border: "#8e44ad" }, // purple
  { bg: "#fdecea", border: "#c0392b" }, // red
  { bg: "#e6f6f7", border: "#0e8a8f" }, // teal
];
function adviserColor(staffId) {
  const idx = staffId ? TEAM.findIndex((p) => p.id === staffId) : -1;
  return DIARY_PALETTE[(idx < 0 ? 0 : idx) % DIARY_PALETTE.length];
}

/* G6B-03 — a diary tile is small and was spending a third of itself restating the one thing that cannot
   disambiguate two appointments. The client's name stays UNLESS the title already contains it verbatim… */
function apptClientLine(a, chip) {
  const who = a && a.clients ? [a.clients.first_name, a.clients.last_name].filter(Boolean).join(" ") : "";
  if (!who) return "";
  const titleSaysWho = !!chip && String(a.title || "").toLowerCase().includes(who.toLowerCase());
  return titleSaysWho ? "" : `<div>${esc(who)}</div>`;
}

/* R12b · W-18: DATED TASKS BELONG IN THE DIARY A task with a due date IS a diary entry: "chase the solicitor
   on Thursday" is a commitment to spend part of Thursday on it. */
const DIARY_TASK_CHIP_CAP = 2;   // per month cell, before "+N more" rolls into the Day view
/* R12b · W-26: how many appointment tiles a month cell may draw before the rest roll into "+N more". Three is
   what fits under the ~160px the grid is built around without the row growing; four already pushes it. */
const DIARY_MONTH_APPT_CAP = 3;
async function loadDiaryTasks(fromYmd, toYmd, who) {
  /* `who` is the diary's own person filter, applied to the task's assigned_to. An UNASSIGNED task is nobody's
     Thursday, so it is not drawn into somebody's filtered diary — it still shows in Everyone… */
  const rows = await softRows(db.from("case_tasks")
    .select("id,title,due_date,case_id,assigned_to")
    .is("done_at", null)
    .gte("due_date", fromYmd).lt("due_date", toYmd)
    .order("due_date")
    .limit(400));
  return who && who !== "all" ? rows.filter((t) => t.assigned_to === who) : rows;
}
/* R78 · A3: ONE DATA-FETCH LAYER FOR ALL THREE DIARY VIEWS. loadDiary / loadDiaryDay / loadDiaryWeek each repeated
   the same ~10 lines — the bounded appointments read, the property context, the dated-task read — and paid them as
   FOUR serial waves. loadDiaryRange(start, end, who) is that block, once: the appointments read, then the context
   (client_id rides on every appointment row, so the A2 hint puts its two reads in one wave) and the task read side
   by side. … */
let diaryLoadSeq = 0;   // R78 · A5 — one token across the three views: the newest load wins
async function loadDiaryRange(start, end, who) {
  let q = db.from("appointments")
    .select("*, clients(first_name,last_name)")
    .gte("starts_at", start.toISOString()).lt("starts_at", end.toISOString())
    .order("starts_at");
  if (who !== "all") q = q.eq("staff_id", who);
  const { data: appts, error } = await q;   // R83
  /* R83: a FAILED read used to be indistinguishable from an empty one: the error was dropped and every view
     painted an authoritative "nothing booked" over an RLS refusal or a dead network. */
  if (error) {   // R83
    dbFail("loadDiaryRange", error, "The diary could not be read: " + error.message);
    return { appts: null, ctx: { byId: {}, caseCount: {}, sharedProp: {} }, tasks: [], error };
  }
  const rows = appts || [];
  const [ctx, tasks] = await Promise.all([
    loadPropContext(rows.map((a) => a.case_id), { clientIds: rows.map((a) => a.client_id) }),
    loadDiaryTasks(diaryYmd(start), diaryYmd(end), who),
  ]);
  return { appts: rows, ctx, tasks, error: null };
}
function diaryTasksByDay(rows) {
  const by = {};
  (rows || []).forEach((t) => { if (t.due_date) (by[t.due_date] = by[t.due_date] || []).push(t); });
  return by;
}
/* One chip. Truncated in CSS rather than in JS so the full title stays in the DOM for the title= tooltip — a
   task called "Chase Skipton for the DIP decision on the Bryanstone flat" is useless cut to "Chase Skipton… */
function diaryTaskChipHtml(t, todayStr) {
  const overdue = t.due_date && t.due_date < todayStr;
  const tip = `Task${overdue ? " (overdue)" : ""}: ${t.title || "(untitled)"}${t.assigned_to ? " · " + staffName(t.assigned_to) : " · unassigned"}. Click to open the case.`;
  const click = t.case_id ? ` onclick="event.stopPropagation();openCase('${jsArg(t.case_id)}')"` : "";
  return `<div class="diary-task${overdue ? " overdue" : ""}${t.case_id ? "" : " no-case"}" title="${esc(tip)}"${click}><span class="dt-mark">☑</span><span class="dt-title">${esc(t.title || "(untitled task)")}</span></div>`;
}
/* R13 · M-31: THE DIARY'S HALF OF ABSENCE: the band, and the panel. The all-day band(s) for one date,
   honouring the page's person filter. Deliberately NOT an appointment: it carries no time… */
function diaryAbsenceBandsHtml(ymd, who) {
  if (!ABSENCES.length) return "";
  const d = String(ymd).slice(0, 10);
  const rows = ABSENCES.filter((a) => a && a.profile_id
    && String(a.starts_on || "").slice(0, 10) <= d && String(a.ends_on || "").slice(0, 10) >= d
    && (who === "all" || a.profile_id === who));
  return rows.map((a) => {
    const nm = profileName(a.profile_id) || "A colleague";
    const note = String(a.note || "").trim();
    const tip = `${nm} is away ${fmtD(a.starts_on)} – ${fmtD(a.ends_on)}${note ? ` · ${note}` : ""}. Recorded under Holidays & absence at the foot of this page.`;
    /* "Away" comes FIRST, before the name. A month cell is ~130px wide and truncates with an ellipsis, so
       whatever leads is the only word guaranteed to survive… */
    return `<div class="diary-away" data-absence="${esc(a.id)}" data-who="${esc(a.profile_id)}" title="${esc(tip)}">`
      + `Away${who === "all" ? ` — <span class="diary-away-who">${esc(nm)}</span>` : ""}${note ? (who === "all" ? " · " : " — ") + esc(note) : ""}</div>`;
  }).join("");
}
/* The management panel at the foot of the Diary. Repainted after every write rather than
   re-rendering the whole page: the grid above it has just been drawn and reflows badly. */
async function renderAbsencePanel() {
  const host = $("#diary-absence-panel");
  if (!host) return;
  const today = localDateStr();
  /* CURRENT AND UPCOMING only. A panel that also listed last February's leave would be a history nobody reads
     sitting on top of the rota everybody does… */
  const rows = ABSENCES.filter((a) => a && String(a.ends_on || "").slice(0, 10) >= today)
    .slice().sort((a, b) => String(a.starts_on).localeCompare(String(b.starts_on)));
  /* RULE 2 — the person select mirrors the RLS policy exactly, so the form can never offer a write the
     database will refuse. An adviser sees only themselves; an admin or owner sees the whole team. */
  const canAny = isAdminOrOwner();
  const meId = (ME && ME.id) || "";
  const people = canAny ? TEAM : TEAM.filter((p) => p.id === meId);
  const spanText = (a) => (String(a.starts_on).slice(0, 10) === String(a.ends_on).slice(0, 10)
    ? fmtD(a.starts_on)
    : `${fmtD(a.starts_on)} – ${fmtD(a.ends_on)}`);
  host.innerHTML = `<div class="panel" id="abs-panel">
    <h3>Holidays &amp; absence</h3>
    <div class="panel-sub" id="abs-panel-sub">Who is off, and when — leave shows as an <strong>Away</strong> band and never blocks a booking. ${howFold({ id: "abs-how", title: "What recording leave does", html: `<p>Recording leave here puts an <strong>Away</strong> band on that person's diary days, labels them in every assignee list, and stops new website leads being <em>suggested</em> to them while they are out. It never blocks anything: you can still book a meeting or assign a task to somebody on holiday — you will just see that you are doing it.</p>` })}</div>
    ${people.length ? `<form id="abs-add-form" class="abs-form">
      <label>Who
        <select id="abs-who" ${canAny ? "" : 'title="You can record your own absence. An Administrator or the Owner records anyone else\'s — the database enforces that, so the list here shows only what you may actually save."'}>
          ${people.map((p) => `<option value="${esc(p.id)}"${p.id === meId ? " selected" : ""}>${esc(staffName(p.id))}${p.id === meId ? " (me)" : ""}</option>`).join("")}
        </select>
      </label>
      <label>First day away<input type="date" id="abs-from" value="${esc(today)}"></label>
      <label>Last day away<input type="date" id="abs-to" value="${esc(today)}"></label>
      <label>Note (optional)<input type="text" id="abs-note" placeholder="e.g. Annual leave" maxlength="120"></label>
      <button type="submit" class="btn btn-sm btn-primary" id="abs-add-btn">Add absence</button>
    </form>
    <div class="ovl-err" id="abs-err"></div>` : ""}
    ${!canAny ? '<p class="panel-sub" id="abs-rls-note">You can add and remove <strong>your own</strong> absences; an Administrator or the Owner records anybody else\'s.</p>' : ""}
    <div id="abs-list">${rows.length ? rows.map((a) => {
      const nm = profileName(a.profile_id) || "A colleague no longer in the system";
      const live = String(a.starts_on).slice(0, 10) <= today;
      const mine = canWriteAbsenceFor(a.profile_id);
      return `<div class="row-item abs-row" data-absence="${esc(a.id)}">
        <div class="row-main">
          <div class="t">${esc(nm)}${live ? ' <span class="badge amber" title="Away today">away now</span>' : ""}</div>
          <div class="s">${esc(spanText(a))}${a.note ? " · " + esc(a.note) : ""}</div>
        </div>
        ${mine ? `<button type="button" class="btn btn-sm btn-ghost btn-danger abs-del" data-absence="${esc(a.id)}" aria-label="Remove this absence" title="Remove this absence">🗑</button>`
          : `<span class="cs-muted" title="Only ${esc(nm)}, an Administrator or the Owner can remove this — the database enforces it.">—</span>`}
      </div>`;
    }).join("") : '<div class="empty" id="abs-empty">Nobody is recorded as away today or in the future. That may be right, or it may mean nothing has been entered yet — this list is only as good as what people put in it.</div>'}</div>
  </div>`;
  const form = $("#abs-add-form");
  if (form) form.onsubmit = (e) => { e.preventDefault(); addAbsence(); };
  host.querySelectorAll(".abs-del").forEach((b) => (b.onclick = () => deleteAbsence(b.dataset.absence)));
}
async function addAbsence() {
  const err = $("#abs-err");
  const say = (m) => { if (err) err.textContent = m; };
  say("");
  const who = ($("#abs-who") || {}).value || "";
  const from = ($("#abs-from") || {}).value || "";
  const to = ($("#abs-to") || {}).value || "";
  const note = String((($("#abs-note") || {}).value || "")).trim();
  if (!who) return say("Pick who is away.");
  if (!from || !to) return say("Both dates are needed — a holiday with no end is not something anyone can plan around.");
  if (to < from) return say("The last day away is before the first day away.");
  // RULE 2 again, at the write. The select cannot offer a refused row, but a stale page could.
  if (!canWriteAbsenceFor(who)) return say("You can only record your own absence. An Administrator or the Owner records anybody else's.");
  const { error } = await db.from("staff_absences").insert({
    profile_id: who, starts_on: from, ends_on: to, note: note || null, created_by: (ME && ME.id) || null,
  });
  if (error) return say("It was not saved: " + error.message);
  await loadAbsences();
  await renderAbsencePanel();
  /* The diary above it has to agree with the list below it, and the band is drawn from ABSENCES —
     so the grid is repainted rather than left showing the state before the write. */
  await loadDiaryForMode();   // R75 · A1 — whichever of the three views is live
  toast(`${staffName(who)} is recorded as away ${fmtD(from)}${from === to ? "" : " – " + fmtD(to)}`);
}
async function deleteAbsence(id) {
  const a = ABSENCES.find((x) => x && x.id === id);
  if (!a) return;
  if (!canWriteAbsenceFor(a.profile_id)) return toast("Only that person, an Administrator or the Owner can remove this absence.");
  const nm = profileName(a.profile_id) || "that colleague";
  // R74 · B3 — house overlay, same question, same words.
  if (!(await confirmDestructive({
    title: "Remove this absence?",
    body: `<strong>${esc(nm)}</strong> · ${esc(fmtD(a.starts_on))}${a.starts_on === a.ends_on ? "" : " – " + esc(fmtD(a.ends_on))}${a.note ? ` (${esc(a.note)})` : ""}. The Away band comes off the diary and they go back into the lead-routing suggestion.`,
    okLabel: "Remove absence", cancelLabel: "Keep it",
  }))) return;
  const { error } = await db.from("staff_absences").delete().eq("id", id);
  if (error) return dbFail("removeAbsence", error, "It could not be removed: " + error.message);   // R81 · A4
  await loadAbsences();
  await renderAbsencePanel();
  await loadDiaryForMode();   // R75 · A1 — whichever of the three views is live
  toast("Absence removed");
}

async function loadDiary() {
  const monthStart = diaryMonth;
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7)); // back to Monday
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + ((8 - gridEnd.getDay()) % 7)); // forward to Monday
  const who = $("#diary-staff").value || "all";
  /* R78 · A3: the shared two-wave fetch. G6B-03's property chip and R12b · W-18's dated tasks both still come
     from exactly these reads — they just no longer queue behind each other. */
  const seq = ++diaryLoadSeq;
  const { appts, ctx: apptCtx, tasks: diaryRangeTasks, error: rangeErr } = await loadDiaryRange(gridStart, gridEnd, who);
  if (seq !== diaryLoadSeq) return;   // R78 · A5 — a newer diary load (any view) owns the page
  if (rangeErr) return;   // R83 — the read failed and said so; do not paint an empty month over it
  const tasksByDay = diaryTasksByDay(diaryRangeTasks);
  $("#diary-title").textContent = "Diary — " + monthStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  /* T1-14: compute per-staff clashes in one pass over the appointments already in memory. Keyed by appt id →
     the (first) other same-staff appointment its time range overlaps… */
  const clashPartner = {};
  const byStaff = {};
  (appts || []).forEach((a) => {
    if (!a.staff_id) return;
    const [s, e] = apptInterval(a);
    (byStaff[a.staff_id] = byStaff[a.staff_id] || []).push({ a, s: s.getTime(), e: e.getTime() });
  });
  Object.values(byStaff).forEach((list) => {
    list.sort((x, y) => x.s - y.s);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].s < list[i].e; j++) {
        if (!clashPartner[list[i].a.id]) clashPartner[list[i].a.id] = list[j].a;
        if (!clashPartner[list[j].a.id]) clashPartner[list[j].a.id] = list[i].a;
      }
    }
  });
  const todayStr = new Date().toDateString();
  const todayStrYmd = localDateStr();   // R12b · W-18 — the overdue test for the task chips
  const days = [];
  for (let d = new Date(gridStart); d < gridEnd; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  $("#diary-grid").innerHTML = days.map((day) => {
    const dayAppts = (appts || []).filter((a) => new Date(a.starts_at).toDateString() === day.toDateString());
    const dim = day.getMonth() !== monthStart.getMonth();
    const dstr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const dayHasClash = dayAppts.some((a) => clashPartner[a.id]);
    /* R12b · W-26: THE CELL HAS A CEILING NOW. A six-appointment day grew its cell to ~900px, and because the grid
       rows are as tall as their tallest cell that one busy Wednesday stretched the whole WEEK — six other days of
       empty white, and the rest of the month pushed off the screen. … */
    const shownAppts = dayAppts.slice(0, DIARY_MONTH_APPT_CAP);
    const hiddenAppts = dayAppts.slice(DIARY_MONTH_APPT_CAP);
    const hiddenClash = hiddenAppts.some((a) => clashPartner[a.id]);
    const dayTasks = tasksByDay[dstr] || [];
    const shownTasks = dayTasks.slice(0, DIARY_TASK_CHIP_CAP);
    const hiddenTaskCount = dayTasks.length - shownTasks.length;
    return `<div class="diary-day ${day.toDateString() === todayStr ? "today" : ""}${dayAppts.length ? " has-appts" : ""}${dayHasClash ? " has-clash" : ""}" data-date="${dstr}" title="${esc("Click an empty part of this day to book an appointment. " + DIARY_DRAG_HINT)}" style="${dim ? "opacity:.45;" : ""}min-height:110px;">
      
      <h3 class="diary-day-h">${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}</h3>
      
      ${diaryAbsenceBandsHtml(dstr, who)}
      
      ${shownTasks.map((t) => diaryTaskChipHtml(t, todayStrYmd)).join("")}
      ${hiddenTaskCount > 0 ? `<div class="diary-more diary-more-tasks" data-date="${dstr}" title="${esc(`${hiddenTaskCount} more task${hiddenTaskCount === 1 ? "" : "s"} due this day — open the Day view to read them all`)}">+${hiddenTaskCount} more task${hiddenTaskCount === 1 ? "" : "s"}</div>` : ""}
      ${shownAppts.map((a) => {
        // Defect 26 — colour by adviser only in the "Everyone" view; single-adviser view keeps the
        // plain default .appt styling (colour would add nothing when every card is the same person).
        const colorStyle = who === "all" ? (() => { const c = adviserColor(a.staff_id); return ` style="background:${c.bg};border-left-color:${c.border};"`; })() : "";
        const partner = clashPartner[a.id];
        /* R12a·D11: the ⚠ itself carried NO title: the tooltip was on the card, so hovering the one glyph
           that means "something is wrong here" explained nothing… */
        const clashWords = partner ? `Clashes with ${apptClashPhrase(partner)}` : "";
        const clashTitle = partner ? ` title="${esc(clashWords)}"` : "";
        const chip = propCtxChip(apptCtx, a.case_id, "row-prop");
        /* R12b · W-17: the outcome, where the appointment already is. A no-show or a rearranged slot is
           struck through: the meeting is still on the record but it did not happen… */
        const outcomeSet = isApptOutcome(a.outcome);
        const outcomeStruck = a.outcome === "no_show" || a.outcome === "rearranged";
        return `<div class="appt${partner ? " clash" : ""}${outcomeSet ? " has-outcome outcome-" + a.outcome : ""}${outcomeStruck ? " outcome-struck" : ""}" draggable="true" data-appt="${esc(a.id)}" data-title="${esc(a.title)}" onclick="openAppt('${a.id}')"${colorStyle}${clashTitle}>
        ${partner ? `<span class="clash-tag" title="${esc(clashWords)}" aria-label="${esc(clashWords)}">⚠</span> ` : ""}<span class="at">${new Date(a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}–${new Date(a.ends_at || a.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span> ${esc(a.title)}
        ${outcomeSet ? `<div>${apptOutcomeChipHtml(a.outcome)}</div>` : ""}
        ${chip ? `<div>${chip}</div>` : ""}
        ${apptClientLine(a, chip)}
        ${a.staff_id && who === "all" ? `<div class="u-muted">${esc(staffName(a.staff_id))}</div>` : ""}
      </div>`;
      }).join("")}
      ${hiddenAppts.length ? `<div class="diary-more diary-more-appts${hiddenClash ? " has-clash" : ""}" data-date="${dstr}" title="${esc(`${hiddenAppts.length} more appointment${hiddenAppts.length === 1 ? "" : "s"} on this day${hiddenClash ? " (one of them is double-booked)" : ""} — opens the Day view, which has room for all of them`)}">${hiddenClash ? "⚠ " : ""}+${hiddenAppts.length} more</div>` : ""}
    </div>`;
  }).join("");
  /* R12b · W-26 / W-18: both "+N more" links do the same thing: move to the Day view for that date. The Day
       view is the screen that can hold a busy day, so overflow ROUTES there rather than expanding the cell (which
       wrecked the grid) or opening a popover (a third place to read a day from). stopPropagation because the cell
       itself books a new appointment on click. */
  $("#diary-grid").querySelectorAll(".diary-more").forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    const [y, m, d] = String(el.dataset.date || "").split("-").map(Number);
    if (!y) return;
    diaryDay = new Date(y, m - 1, d);
    // R75 · A3 — no filter hand-off needed any more: the select is never re-pointed by a view
    // change, so the Day view opens under exactly the filter the month grid was read under.
    setDiaryViewMode("day");
  }));
  // Legend row (defect 26) — only meaningful once cards are colour-coded, i.e. the "Everyone" view.
  const legendEl = $("#diary-legend");
  if (legendEl) {
    legendEl.innerHTML = who === "all"
      ? TEAM.map((p) => { const c = adviserColor(p.id); return `<span class="diary-legend-item"><span class="diary-legend-dot" style="background:${c.border};"></span>${esc(staffName(p.id))}</span>`; }).join("")
      : "";
  }
  /* R75 · A2 — the month grid's tiles become drag sources and its day cells drop targets, wired
     after the paint that created them (the board's own pattern). */
  wireDiaryDnD();
  activateDiaryAppts("#diary-grid .appt");   // R78 · B2 — Month view, keyboard-openable
  await renderAbsencePanel();   // R13 · M-31 — the rota lives under the month it describes
}

/* Diary: Day view Additive: a second render path that shares the appointments table, the staff filter and
   openAppt/adviserColor with the month grid above… */
let diaryViewMode = "month"; // "month" | "week" | "day" — overwritten from localStorage by restoreUserPrefs
let diaryDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());
/* R75 · A1: the Monday the Week view is showing. Kept separate from diaryMonth/diaryDay for the same reason
   those two are separate from each other: switching views must never move the OTHER view's position. */
let diaryWeek = mondayOf(new Date());
/* ==========================================================================
   R75 · A3 (panel A#4) — THE STAFF FILTER FOLLOWS YOU.

   There used to be two remembered values here — diaryStaffMonthVal and
   diaryStaffDayVal — and setDiaryViewMode swapped the shared #diary-staff
   select between them on every toggle. The stated intent (R5-31) was "Day
   defaults to the signed-in adviser"; what it actually did was this: read
   Wayne's month, press Day, and you are reading YOUR OWN day. The person you
   deliberately selected was silently replaced, with nothing on screen saying
   so, and pressing Month put them back — so the filter appeared to flicker
   between two people depending on which view you were in. Four of the five
   panel agents raised it independently (finding A#4, and #10's list).

   ONE remembered value now, carried across all three views, because that is
   what a filter is: a question you asked, not a property of a layout.

   The "Day defaults to mine" half is DELETED rather than narrowed. R34's
   staffFilterDefault already opens the whole diary on ME for anybody who
   advises (a stored pick first, then their own id, then "all"), so the only
   people the old Day rule ever changed were the administrator and the owner —
   and for those two "all" is the right default on every view, which is the
   reasoning R34 itself used. Keeping a "only when nothing was picked this
   visit" variant would have left the one behaviour nobody could predict:
   the filter moving on its own, sometimes.

   R34's initial default-to-me contract (tests/r34.js §C) is untouched — that
   is about what the select opens on, and it still runs in loadTeam().
   ========================================================================== */
let diaryStaffVal = "all";
const DIARY_DAY_START_HOUR = 8, DIARY_DAY_END_HOUR = 19; // 08:00–19:00
const DIARY_DAY_PX_PER_HOUR = 60;

// Interval layout: connected (time-overlapping) appointments are grouped into a cluster and each member gets
// its own column within it, so overlaps render side-by-side instead of stacking…
function computeDayLayout(dayAppts) {
  const items = dayAppts.map((a) => ({ appt: a, start: new Date(a.starts_at), end: new Date(a.ends_at || a.starts_at) }));
  items.sort((x, y) => x.start - y.start);
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (items[i].start < items[j].end && items[j].start < items[i].end) union(i, j);
    }
  }
  const clusters = {};
  for (let i = 0; i < n; i++) { const r = find(i); (clusters[r] = clusters[r] || []).push(i); }
  const col = new Array(n).fill(0);
  const cols = new Array(n).fill(1);
  Object.values(clusters).forEach((idxs) => {
    idxs.sort((a, b) => items[a].start - items[b].start);
    const colEnds = []; // end time currently occupying each column
    idxs.forEach((idx) => {
      const it = items[idx];
      let c = colEnds.findIndex((endT) => endT <= it.start);
      if (c === -1) { c = colEnds.length; colEnds.push(it.end); } else colEnds[c] = it.end;
      col[idx] = c;
    });
    idxs.forEach((idx) => { cols[idx] = colEnds.length; });
  });
  /* `cols > 1` means "shares a column cluster", which is a LAYOUT fact, not a diary clash — two different
     advisers booked at the same hour are drawn side by side and are perfectly fine. */
  return items.map((it, i) => ({ ...it, col: col[i], cols: cols[i], sharesColumn: cols[i] > 1 }));
}

async function loadDiaryDay() {
  const day = diaryDay;
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const who = $("#diary-staff").value || "all";
  /* R78 · A3 — the shared fetch; G6B-03's context and R12b · W-18's uncapped day tasks are the
     same reads as ever, now two waves instead of three. */
  const seq = ++diaryLoadSeq;
  const { appts, ctx: apptCtx, tasks: dayTasks, error: rangeErr } = await loadDiaryRange(dayStart, dayEnd, who);
  if (seq !== diaryLoadSeq) return;   // R78 · A5
  if (rangeErr) return;   // R83 — never the "nothing booked" empty state over a failed read
  $("#diary-title").textContent = "Diary — " + dayStart.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  renderDiaryDayTasks(dayTasks, diaryYmd(dayStart), who);
  renderDiaryDay(appts || [], who, apptCtx);
  await renderAbsencePanel();   // R13 · M-31 — the same panel, under either view
}
/* R12b · W-18: dated tasks get their OWN row above the time lanes, not a lane position: they are all-day
   commitments with no start time, and dropping them at 00:00 (or at "now") would be the app inventing a fact. */
function renderDiaryDayTasks(tasks, dayYmd, who) {
  const el = $("#diary-day-tasks");
  if (!el) return;
  const rows = tasks || [];
  const todayStr = localDateStr();
  /* R13 · M-31: the Away band shares this row for the same reason the tasks are in it: it has no time either.
     It comes FIRST, because "he is not in today" changes how you read everything underneath it… */
  const bands = dayYmd ? diaryAbsenceBandsHtml(dayYmd, who || "all") : "";
  el.classList.toggle("hidden", !rows.length && !bands);
  el.innerHTML = bands
    + (rows.length
      ? `<span class="ddt-lbl" title="Tasks due on this day, from the cases. These have no time on them — they are jobs for the day, not slots in it.">Due this day</span>`
        + rows.map((t) => diaryTaskChipHtml(t, todayStr)).join("")
      : "");
}

/* R75 · A1: THE LANE BUILDER, EXTRACTED (not copied). The Week view is seven of the Day view's lanes side by side,
   so it needs the Day view's block renderer — the height-budget line spending, the ⚠, the outcome treatment, the
   property chip, the side-by-side column layout. A second copy of that would be a second set of rules about what an
   appointment looks like, which is exactly the mistake R64 refused to make with the log-call panel. … */
function diaryHourList() {
  const hours = [];
  for (let h = DIARY_DAY_START_HOUR; h <= DIARY_DAY_END_HOUR; h++) hours.push(h);
  return hours;
}
function diaryHourLinesHtml() {
  return diaryHourList().map((h) => `<div class="diary-hour-line" style="top:${(h - DIARY_DAY_START_HOUR) * DIARY_DAY_PX_PER_HOUR}px;"></div>`).join("");
}
function diaryLaneBlocksHtml(appts, who, apptCtx) {
  const ctx = apptCtx || { byId: {}, caseCount: {}, sharedProp: {} };
  const startHour = DIARY_DAY_START_HOUR, endHour = DIARY_DAY_END_HOUR;
  const pxPerHour = DIARY_DAY_PX_PER_HOUR;
  const timeLabel = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const layout = computeDayLayout(appts);
  return layout.map(({ appt: a, start, end, col, cols }) => {
    // Clamp to the visible axis rather than hide — an appointment starting before 08:00 or running
    // past 19:00 still needs to be findable, it just sits pinned to the edge of the lane.
    const minsFromStart = Math.min(Math.max(0, (start.getHours() * 60 + start.getMinutes()) - startHour * 60), (endHour - startHour) * 60);
    const durMins = Math.max(15, (end - start) / 60000);
    const top = (minsFromStart / 60) * pxPerHour;
    /* R6FIX-1 (R6B-03) — a block is as tall as its duration (60px an hour), so a 15- or 30-minute appointment
       has room for about one line. It used to spend that line on the title and leave the property chip… */
    const height = Math.max(22, (durMins / 60) * pxPerHour - 2);
    /* How many 12px/1.35 lines actually fit inside the padding. Everything below is then rendered to that
       budget instead of being emitted and clipped… */
    const lines = Math.max(1, Math.floor((height - 6) / 17));
    const compact = lines < 2;
    const widthPct = 100 / cols;
    const leftPct = col * widthPct;
    // Defect 26's per-adviser palette, reused so the "Everyone" filter reads the same way here as
    // it does on the month grid.
    const colorStyle = who === "all" ? (() => { const c = adviserColor(a.staff_id); return `background:${c.bg};border-left-color:${c.border};`; })() : "";
    /* R12a·D11: `clash` off computeDayLayout means "this block shares a column cluster", which in the
       Everyone view is true of two DIFFERENT advisers booked at the same time: not a clash, just a busy firm. */
    const clashers = layout.filter((o) => o.appt !== a && apptOverlaps(a, o.appt)).map((o) => o.appt);
    const isClash = clashers.length > 0;
    const clashWords = isClash ? `Clashes with ${clashers.map(apptClashPhrase).join(", ")}` : "";
    const clashTitle = isClash ? ` title="${esc(clashWords)}"` : "";
    const chip = propCtxChip(ctx, a.case_id, "row-prop");
    /* R75 · A2: DRAG TO MOVE. `draggable` + the id on the element is the whole contract, exactly as the
       pipeline board's cards carry it (wireBoardDnD): the handlers are delegated and wired per paint… */
    const box = `style="top:${top}px;height:${height}px;left:calc(${leftPct}% + 2px);width:calc(${widthPct}% - 4px);${colorStyle}" draggable="true" data-appt="${esc(a.id)}" data-title="${esc(a.title)}" onclick="openAppt('${a.id}')"`;
    const warn = isClash ? `<span class="clash-tag" title="${esc(clashWords)}" aria-label="${esc(clashWords)}">⚠</span> ` : "";
    const whoName = a.clients ? [a.clients.first_name, a.clients.last_name].filter(Boolean).join(" ") : "";
    const staffLine = a.staff_id && who === "all" ? staffName(a.staff_id) : "";
    const clientLine = apptClientLine(a, chip); // "" when the title already names them
    /* R12b · W-17: the same outcome treatment the month grid wears, so a day read in either view says the
       same thing about what happened. It takes the FIRST line of the budget below… */
    const outcomeSet = isApptOutcome(a.outcome);
    const outCls = (outcomeSet ? " has-outcome outcome-" + a.outcome : "") + (a.outcome === "no_show" || a.outcome === "rearranged" ? " outcome-struck" : "");
    let budget = lines - 1;                     // the time + title line is never optional
    const showOutcome = outcomeSet && !compact && budget >= 1; if (showOutcome) budget--;
    // In the one-line layout the chip shares that line rather than needing one of its own.
    const showChip = !!chip && (compact || budget >= 1); if (showChip && !compact) budget--;
    const showClient = !!clientLine && budget >= 1; if (showClient) budget--;
    const showStaff = !!staffLine && budget >= 1;
    const hidden = [!showChip && chip ? propCtxCase(ctx, a.case_id) && propAddress(propCtxCase(ctx, a.case_id)) : null,
      !showClient && whoName ? whoName : null, !showStaff && staffLine ? staffLine : null,
      outcomeSet && !showOutcome && !compact ? APPT_OUTCOME_LABEL[a.outcome] : null].filter(Boolean);
    const tip = clashTitle || (hidden.length ? ` title="${esc([a.title].concat(hidden).join(" · "))}"` : "");
    if (compact) {
      return `<div class="appt-block appt-block-compact${isClash ? " clash" : ""}${outCls}" ${box}${tip}>${warn}<span class="at">${timeLabel(start)}–${timeLabel(end)}</span><span class="ab-title">${esc(a.title)}</span>${outcomeSet ? apptOutcomeChipHtml(a.outcome) : chip}</div>`;
    }
    return `<div class="appt-block${isClash ? " clash" : ""}${outCls}" ${box}${tip}>${warn}<span class="at">${timeLabel(start)}–${timeLabel(end)}</span> ${esc(a.title)}
      ${showOutcome ? `<div>${apptOutcomeChipHtml(a.outcome)}</div>` : ""}
      ${showChip ? `<div>${chip}</div>` : ""}
      ${showClient ? clientLine : ""}
      ${showStaff ? `<div class="u-muted">${esc(staffLine)}</div>` : ""}</div>`;
  }).join("");
}
/* R78 · B2: THE DIARY GETS A KEYBOARD. Every appointment block in all three views is an onclick <div> — 0 of
   them focusable, so a diary could be READ without a mouse but nothing in it could be OPENED. */
function activateDiaryAppts(scopeSel) {
  document.querySelectorAll(scopeSel).forEach((el) => {
    makeActivatable(el, { label: el.dataset.title ? "Open appointment: " + el.dataset.title : "Open appointment" });
  });
}
function renderDiaryDay(appts, who, apptCtx) {
  const startHour = DIARY_DAY_START_HOUR, endHour = DIARY_DAY_END_HOUR;
  const pxPerHour = DIARY_DAY_PX_PER_HOUR;
  const totalHeight = (endHour - startHour) * pxPerHour;
  const pad2 = (n) => String(n).padStart(2, "0");
  $("#diary-hour-labels").style.height = totalHeight + "px";
  $("#diary-hour-labels").innerHTML = diaryHourList().map((h) => `<div class="diary-hour-label" style="top:${(h - startHour) * pxPerHour}px;">${pad2(h)}:00</div>`).join("");
  const lane = $("#diary-day-lane");
  lane.style.height = totalHeight + "px";
  lane.innerHTML = diaryHourLinesHtml() + diaryLaneBlocksHtml(appts, who, apptCtx);
  /* R75 · A2: the blocks this lane just drew are drag sources, and the lane is a drop target. Re-wired on
     every paint, exactly as the board's wireBoardDnD() is re-wired after every loadPipeline. */
  wireDiaryDnD();
  activateDiaryAppts("#diary-day-lane .appt-block");   // R78 · B2 — Day view, keyboard-openable
  /* R75 · A3: A DAY WITH NOTHING IN IT SHOULD SAY SO, AND SAY WHOSE. An empty lane was eleven hours of ruled
     white space: indistinguishable from a lane that had not loaded… */
  renderDiaryDayEmpty(appts, who);
}

/* R75 · A1 / A2 / A3 — THE WEEK VIEW, CLICK-A-SLOT AND DRAG-TO-MOVE. Owner decision, 28 Aug 2026: "the diary
   gets a Week view and it becomes the desktop default". Everything below serves that one sentence. */

/* The Monday of whatever week a date falls in. Deliberately local-midnight (not a UTC walk):
   every other date in this file is Europe/London by way of localDateStr, and a week that starts
   on the wrong Monday for one hour a night is the sort of bug nobody reproduces. */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function diaryYmd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/* R75 · A2: said on every surface a drag is offered from. Drag-and-drop is pointer-only and this round is not
   inventing a keyboard drag protocol nobody would discover… */
const DIARY_DRAG_HINT = "Drag an appointment to another day or time to move it — or open it and change the date, which is the way to do it from the keyboard.";

async function loadDiaryWeek() {
  const weekStart = mondayOf(diaryWeek);
  diaryWeek = weekStart;                          // normalise, so ‹/› always step whole weeks
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 7);
  const who = $("#diary-staff").value || "all";
  /* R78 · A3 — the shared fetch: the SAME read the month grid makes, bounded to seven days. */
  const seq = ++diaryLoadSeq;
  const { appts, ctx: apptCtx, tasks: weekTasks, error: rangeErr } = await loadDiaryRange(weekStart, weekEnd, who);
  if (seq !== diaryLoadSeq) return;   // R78 · A5
  if (rangeErr) return;   // R83 — see loadDiaryRange
  const tasksByDay = diaryTasksByDay(weekTasks);
  const lastDay = new Date(weekStart); lastDay.setDate(lastDay.getDate() + 6);
  /* "Diary — week of 1 September 2026" reads as a period; "1–7 September" reads as a range and is
     what a person says out loud. Both months are named when the week straddles two. */
  const sameMonth = lastDay.getMonth() === weekStart.getMonth();
  const label = sameMonth
    ? `${weekStart.getDate()}–${lastDay.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
    : `${weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "long" })} – ${lastDay.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
  $("#diary-title").textContent = "Diary — " + label;
  renderDiaryWeek(weekStart, appts || [], who, apptCtx, tasksByDay);
  /* R13 · M-31 — the same rota panel, under whichever view is showing. */
  await renderAbsencePanel();
  // Defect 26's legend means the same thing here as on the month grid: colours only in "Everyone".
  const legendEl = $("#diary-legend");
  if (legendEl) {
    legendEl.innerHTML = who === "all"
      ? TEAM.map((p) => { const c = adviserColor(p.id); return `<span class="diary-legend-item"><span class="diary-legend-dot" style="background:${c.border};"></span>${esc(staffName(p.id))}</span>`; }).join("")
      : "";
  }
}

function renderDiaryWeek(weekStart, appts, who, apptCtx, tasksByDay) {
  const host = $("#diary-week-view");
  if (!host) return;
  const totalHeight = (DIARY_DAY_END_HOUR - DIARY_DAY_START_HOUR) * DIARY_DAY_PX_PER_HOUR;
  const pad2 = (n) => String(n).padStart(2, "0");
  const todayYmd = localDateStr();                // R70 — Europe/London, never a bare Date walk
  const todayStrYmd = todayYmd;                   // the overdue test for the task chips
  const days = [];
  for (let i = 0; i < 7; i++) { const d = new Date(weekStart); d.setDate(d.getDate() + i); days.push(d); }
  const hourCol = diaryHourList()
    .map((h) => `<div class="diary-hour-label" style="top:${(h - DIARY_DAY_START_HOUR) * DIARY_DAY_PX_PER_HOUR}px;">${pad2(h)}:00</div>`).join("");
  /* Two grid rows — heads, then lanes — so every head cell is as tall as the tallest and the seven lanes
     still start on the same pixel. Doing this with separate flex rows is what makes week grids drift by a… */
  const heads = days.map((day) => {
    const dstr = diaryYmd(day);
    const isToday = dstr === todayYmd;
    const dayTasks = (tasksByDay || {})[dstr] || [];
    return `<div class="dw-head${isToday ? " today" : ""}" data-date="${dstr}">
      <h3 class="diary-day-h">${day.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" })}${isToday ? ' <span class="dw-today-tag">today</span>' : ""}</h3>
      ${diaryAbsenceBandsHtml(dstr, who)}
      ${dayTasks.map((t) => diaryTaskChipHtml(t, todayStrYmd)).join("")}
    </div>`;
  }).join("");
  const lanes = days.map((day) => {
    const dstr = diaryYmd(day);
    const isToday = dstr === todayYmd;
    const dayAppts = (appts || []).filter((a) => new Date(a.starts_at).toDateString() === day.toDateString());
    return `<div class="dw-lane${isToday ? " today" : ""}" data-date="${dstr}" style="height:${totalHeight}px;" title="${esc("Click an empty slot to book an appointment at that time. " + DIARY_DRAG_HINT)}">`
      + diaryHourLinesHtml()
      + diaryLaneBlocksHtml(dayAppts, who, apptCtx)
      + `</div>`;
  }).join("");
  host.innerHTML = `<div class="diary-week-grid">
    <div class="dw-corner"></div>
    ${heads}
    <div class="dw-hours" style="height:${totalHeight}px;">${hourCol}</div>
    ${lanes}
  </div>`;
  wireDiaryDnD();
  activateDiaryAppts("#diary-week-view .appt-block");   // R78 · B2 — Week view, keyboard-openable
  syncDiaryWeekScroll(true);                            // R78 · B3 — phone: today in view + chevrons
}
/* R78 · B3: WEEK-ON-A-PHONE: OPEN ON TODAY, AND SAY THERE IS MORE SIDEWAYS. Below 900px the week grid keeps its
   780px min-width and the view scrolls sideways (admin.css) — but it opened at scrollLeft 0, i.e. Monday, so on a
   Thursday "today" sat two screens to the right with no affordance saying so. MEASURE-GUARD (the house rule): every
   number here is measured off the live DOM, and a paint that has not laid out yet measures 0. … */
function syncDiaryWeekScroll(scrollToToday, isRetry) {
  const host = $("#diary-week-view"), wrap = $("#diary-week-wrap");
  if (!host || !wrap) return;
  const retry = () => {
    if (isRetry) return; // one retry only — after that, silence (MEASURE-GUARD)
    requestAnimationFrame(() => requestAnimationFrame(() => syncDiaryWeekScroll(scrollToToday, true)));
  };
  // Hidden (another view is up) or unpainted: clientWidth is 0 — don't write, maybe retry.
  if (!host.clientWidth) { if (scrollToToday) retry(); return; }
  const over = host.scrollWidth > host.clientWidth + 1;
  const syncClasses = () => {
    const max = host.scrollWidth - host.clientWidth;
    wrap.classList.toggle("can-scroll-right", over && host.scrollLeft < max - 4);
    wrap.classList.toggle("can-scroll-left", over && host.scrollLeft > 4);
  };
  if (scrollToToday && over) {
    const lane = host.querySelector(".dw-lane.today");
    if (lane) {
      const hours = host.querySelector(".dw-hours");
      const hostRect = host.getBoundingClientRect(), laneRect = lane.getBoundingClientRect();
      // Content offset of the lane inside the scroller, independent of the current scroll.
      const laneLeft = laneRect.left - hostRect.left + host.scrollLeft;
      const target = laneLeft - ((hours && hours.offsetWidth) || 0);
      if (laneRect.width > 0 && isFinite(target) && target > 0) host.scrollLeft = target; // clamps itself
      else if (laneRect.width <= 0) { retry(); return; }   // measured before layout — try once more
    }
  }
  host.onscroll = syncClasses;
  const aR = wrap.querySelector(".board-scroll-arrow"), aL = wrap.querySelector(".board-scroll-arrow-left");
  const step = () => Math.max(160, Math.round(host.clientWidth * 0.7));
  if (aR) aR.onclick = () => host.scrollBy({ left: step(), behavior: "smooth" });
  if (aL) aL.onclick = () => host.scrollBy({ left: -step(), behavior: "smooth" });
  if (!wrap.__dwResize) { wrap.__dwResize = true; window.addEventListener("resize", () => syncDiaryWeekScroll(false), { passive: true }); }
  syncClasses();
}

/* R75 · A2(b): CLICK A LANE AT A TIME. One delegated handler for the seven week lanes, doing exactly what the
   Day lane's own click handler has always done: round the pointer to the nearest half hour… */
function diaryLaneClickTime(lane, clientY) {
  const rect = lane.getBoundingClientRect();
  const totalMinutes = (DIARY_DAY_END_HOUR - DIARY_DAY_START_HOUR) * 60;
  let mins = ((clientY - rect.top) / DIARY_DAY_PX_PER_HOUR) * 60;
  mins = Math.min(Math.max(0, mins), totalMinutes);
  mins = Math.round(mins / 30) * 30;
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(DIARY_DAY_START_HOUR + Math.floor(mins / 60))}:${pad2(mins % 60)}`;
}
if ($("#diary-week-view")) $("#diary-week-view").addEventListener("click", (e) => {
  if (e.target.closest(".appt-block")) return;    // a block's own onclick opens it
  const lane = e.target.closest(".dw-lane");
  if (!lane || !lane.dataset.date) return;
  openAppt(null, { starts_at: `${lane.dataset.date}T${diaryLaneClickTime(lane, e.clientY)}` });
});

/* R75 · A3 — the Day view's empty state. Whose diary, which date, and the one button that fixes
   it (prefilled with that date, at the hour the month grid's own empty-cell click uses). */
function renderDiaryDayEmpty(appts, who) {
  const lane = $("#diary-day-lane");
  if (!lane) return;
  const existing = $("#diary-day-empty");
  if (existing) existing.remove();
  if ((appts || []).length) return;
  const whose = who && who !== "all" ? `${staffName(who)}’s diary` : "The team’s diary";
  const when = diaryDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const wrap = document.createElement("div");
  wrap.id = "diary-day-empty";
  wrap.className = "diary-day-empty";
  wrap.innerHTML = emptyState({
    headline: `${whose} — nothing booked on ${when}.`,
    sub: "The whole day is free. Click any slot on the left to book at that time, or use the button.",
    action: { label: "+ Appointment", id: "diary-day-empty-add" },
  });
  lane.appendChild(wrap);
  const btn = wrap.querySelector("#diary-day-empty-add");
  if (btn) btn.onclick = (e) => {
    e.stopPropagation();                          // the lane itself books from the click position
    openAppt(null, { starts_at: `${diaryYmd(diaryDay)}T10:00` });
  };
}

/* R75 · A2(c): DRAG TO MOVE, WITH A CLASH THAT ASKS AND AN UNDO THAT WORKS. Same shape as the pipeline board's
   wireBoardDnD (R65): `draggable` elements carry the id, drop targets take dragover/dragleave/drop, and the write
   goes through ONE function so there is never a second set of rules. Re-wired after every paint, because every
   paint replaces the nodes. THREE KINDS OF DROP, one rule each: • a MONTH cell → the day changes, the TIME OF DAY
   IS PRESERVED. … */
let diaryDragId = null;   // the appointment currently being dragged (dataTransfer is unreadable during dragover)

function wireDiaryDnD() {
  document.querySelectorAll("#page-diary [data-appt][draggable='true']").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      diaryDragId = el.dataset.appt;
      try { e.dataTransfer.setData("text/plain", el.dataset.appt); e.dataTransfer.effectAllowed = "move"; } catch (err) { /* older browser */ }
      el.classList.add("dragging");
    });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); diaryDragId = null; });
  });
  document.querySelectorAll("#diary-grid .diary-day, #diary-week-view .dw-lane, #diary-day-lane").forEach((target) => {
    /* R83: the month cells and week lanes are innerHTML-fresh on every paint, but #diary-day-lane is a STATIC
       element whose children are replaced… */
    if (target.__diaryDndWired) return;   // R83
    target.__diaryDndWired = true;        // R83
    target.addEventListener("dragover", (e) => { e.preventDefault(); target.classList.add("dragover"); });
    target.addEventListener("dragleave", () => target.classList.remove("dragover"));
    target.addEventListener("drop", (e) => {
      e.preventDefault();
      target.classList.remove("dragover");
      let id = "";
      try { id = e.dataTransfer.getData("text/plain"); } catch (err) { /* ignore */ }
      id = id || diaryDragId;
      if (!id) return;
      if (target.classList.contains("dw-lane")) {
        diaryMoveAppt(id, { date: target.dataset.date, time: diaryLaneClickTime(target, e.clientY) });
      } else if (target.id === "diary-day-lane") {
        diaryMoveAppt(id, { date: diaryYmd(diaryDay), time: diaryLaneClickTime(target, e.clientY) });
      } else if (target.dataset.date) {
        diaryMoveAppt(id, { date: target.dataset.date });   // day changes, time of day preserved
      }
    });
  });
}

/* The words a person reads for "it was here, it is now there". One phrase, so the toast, the
   Undo toast and the clash question all name a slot the same way. */
function apptSlotPhrase(startIso, endIso) {
  const st = new Date(startIso);
  const en = new Date(endIso || startIso);
  const t = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${fmtD(localDateStr(st))} ${t(st)}–${t(en)}`;
}

async function diaryMoveAppt(id, to) {
  const { data: a, error } = await db.from("appointments").select("id,title,starts_at,ends_at,staff_id").eq("id", id).single();
  if (error || !a) return toast("That appointment could not be moved — it may have been deleted.");
  const oldStart = new Date(a.starts_at);
  const oldEnd = a.ends_at ? new Date(a.ends_at) : new Date(oldStart.getTime() + 60 * 60000);
  const durMs = Math.max(15 * 60000, oldEnd - oldStart);   // the duration always survives the move
  /* The time is either the slot dropped on (week/day lane) or the one it already had (month cell). Parsed the
     same browser-local `date + "T" + time` way openAppt's save parses it… */
  const timeStr = to.time || `${String(oldStart.getHours()).padStart(2, "0")}:${String(oldStart.getMinutes()).padStart(2, "0")}`;
  const newStart = new Date(`${to.date}T${timeStr}`);
  if (isNaN(newStart)) return toast("That slot could not be read — nothing was moved.");
  const newEnd = new Date(newStart.getTime() + durMs);
  if (newStart.getTime() === oldStart.getTime()) return;   // dropped where it already was
  /* Defect 5 / R12a·D11 — the clash rule, asked before the write and never after it. */
  const clash = await apptClashFor(a.staff_id, newStart, newEnd, id);
  if (clash) {
    const okToClash = await confirmDestructive({
      title: "That slot is already booked",
      danger: false,
      okLabel: "Move it anyway",
      cancelLabel: "Leave it where it is",
      body: `<strong>${esc(staffName(a.staff_id))}</strong> already has ${esc(apptClashPhrase(clash))} then. Moving <strong>${esc(a.title || "this appointment")}</strong> to ${esc(apptSlotPhrase(newStart.toISOString(), newEnd.toISOString()))} double-books them — the diary will show both, flagged.`,
    });
    if (!okToClash) return;
  }
  const { error: upErr } = await db.from("appointments")
    .update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() }).eq("id", id);
  if (upErr) return dbFail("diaryDragMove", upErr, "It could not be moved: " + upErr.message);   // R81 · A4
  const wasStart = a.starts_at, wasEnd = a.ends_at;   // captured, so Undo restores exactly
  await loadDiaryForMode();
  /* R76 · A6: a drag onto a day already behind today gets the same clause the booking form shows, on the
     move's existing Undo toast. Warn, never block. */
  const draggedPast = localDateStr(newStart) < localDateStr();
  toast(`Moved “${a.title || "appointment"}” · ${apptSlotPhrase(wasStart, wasEnd)} → ${apptSlotPhrase(newStart.toISOString(), newEnd.toISOString())}`
    + (draggedPast ? " · This books into the past — recording something that already happened?" : ""),
    { label: "Undo", onClick: () => undoDiaryMove(id, wasStart, wasEnd) });
}
async function undoDiaryMove(id, startIso, endIso) {
  const { error } = await db.from("appointments").update({ starts_at: startIso, ends_at: endIso }).eq("id", id);
  if (error) return dbFail("undoDiaryMove", error, "It could not be put back: " + error.message);   // R81 · A4
  await loadDiaryForMode();
  toast(`Put back to ${apptSlotPhrase(startIso, endIso)}`);
}
window.diaryMoveAppt = diaryMoveAppt;   // the drag is pointer-only; tests and the console are not

// Click an empty part of the lane → new appointment prefilled with the clicked time (rounded to
// the nearest half hour); clicks on an appointment block are handled by the block's own onclick.
$("#diary-day-lane").addEventListener("click", (e) => {
  if (e.target.closest(".appt-block")) return;
  const lane = $("#diary-day-lane");
  const rect = lane.getBoundingClientRect();
  const totalMinutes = (DIARY_DAY_END_HOUR - DIARY_DAY_START_HOUR) * 60;
  let minutesFromStart = ((e.clientY - rect.top) / DIARY_DAY_PX_PER_HOUR) * 60;
  minutesFromStart = Math.min(Math.max(0, minutesFromStart), totalMinutes);
  minutesFromStart = Math.round(minutesFromStart / 30) * 30;
  const hour = DIARY_DAY_START_HOUR + Math.floor(minutesFromStart / 60);
  const minute = minutesFromStart % 60;
  const pad2 = (n) => String(n).padStart(2, "0");
  const dstr = `${diaryDay.getFullYear()}-${pad2(diaryDay.getMonth() + 1)}-${pad2(diaryDay.getDate())}`;
  openAppt(null, { starts_at: `${dstr}T${pad2(hour)}:${pad2(minute)}` });
});

/* R75 · A1: ONE ROUTER FOR THREE VIEWS. Every "the diary has to repaint" caller used to carry its own `mode
   === "day" ? … : …` ternary, which is exactly the shape that breaks the moment a third view exists. */
function loadDiaryForMode() {
  if (diaryViewMode === "day") return loadDiaryDay();
  if (diaryViewMode === "week") return loadDiaryWeek();
  return loadDiary();
}
// Flips the three sibling containers, without ever mutating diaryMonth/diaryWeek/diaryDay or re-rendering a
// view it is leaving. `opts.skipLoad`/`skipPersist` are used only by initDiaryViewFromPrefs.
function setDiaryViewMode(mode, opts = {}) {
  diaryViewMode = mode;
  const segs = [["#diary-view-month", "month"], ["#diary-view-week", "week"], ["#diary-view-day", "day"]];
  segs.forEach(([sel, m]) => {
    const b = $(sel);
    if (!b) return;
    b.classList.toggle("scope-active", mode === m);
    b.setAttribute("aria-pressed", mode === m ? "true" : "false");
  });
  $("#diary-grid").classList.toggle("hidden", mode !== "month");
  /* The adviser-colour legend belongs to any view that colours its blocks by adviser, which is both the month
     grid and the week lanes — not the day view… */
  $("#diary-legend").classList.toggle("hidden", mode === "day");
  if ($("#diary-week-view")) $("#diary-week-view").classList.toggle("hidden", mode !== "week");
  /* R78 · B3 — leaving the week view must take its chevrons with it: the wrap's can-scroll-*
     classes are what show the discs, and a stale pair would float over the month grid. */
  if (mode !== "week" && $("#diary-week-wrap")) $("#diary-week-wrap").classList.remove("can-scroll-left", "can-scroll-right");
  $("#diary-day-view").classList.toggle("hidden", mode !== "day");
  /* R75 · A3 — #diary-staff is deliberately NOT touched here. The filter is a question the
     operator asked; a view toggle is not an answer to it. */
  if (!opts.skipPersist && authUid) lsSet(diaryViewStoreKey(authUid), mode);
  if (!opts.skipLoad) loadDiaryForMode();
}
// Called once from loadTeam(), right after #diary-staff is rebuilt from the fresh team list — syncs the
// toggle's classes/hidden state to whatever restoreUserPrefs read from localStorage…
function initDiaryViewFromPrefs() {
  setDiaryViewMode(diaryViewMode, { skipPersist: true, skipLoad: true });
}
$("#diary-view-month").addEventListener("click", () => setDiaryViewMode("month"));
if ($("#diary-view-week")) $("#diary-view-week").addEventListener("click", () => setDiaryViewMode("week"));
$("#diary-view-day").addEventListener("click", () => setDiaryViewMode("day"));

/* R75 · A1 — ‹ / Today / › move by whatever the view is ABOUT: a month, a week, a day. A Week
   view whose arrows stepped a month would be a week view in name only. */
$("#diary-prev").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay.setDate(diaryDay.getDate() - 1); loadDiaryDay(); }
  else if (diaryViewMode === "week") { diaryWeek.setDate(diaryWeek.getDate() - 7); loadDiaryWeek(); }
  else { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() - 1, 1); loadDiary(); }
});
$("#diary-next").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay.setDate(diaryDay.getDate() + 1); loadDiaryDay(); }
  else if (diaryViewMode === "week") { diaryWeek.setDate(diaryWeek.getDate() + 7); loadDiaryWeek(); }
  else { diaryMonth = new Date(diaryMonth.getFullYear(), diaryMonth.getMonth() + 1, 1); loadDiary(); }
});
$("#diary-today").addEventListener("click", () => {
  if (diaryViewMode === "day") { diaryDay = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()); loadDiaryDay(); }
  else if (diaryViewMode === "week") { diaryWeek = mondayOf(new Date()); loadDiaryWeek(); }
  else { diaryMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1); loadDiary(); }
});
$("#diary-staff").addEventListener("change", () => {
  persistStaffFilter("#diary-staff", DIARY_STAFF_KEY); // R34 · W2
  diaryStaffVal = $("#diary-staff").value || "all";    // R75 · A3 — the one value all three views read
  loadDiaryForMode();
});
$("#new-appt-btn").addEventListener("click", () => openAppt(null));
// Click an empty part of a day cell → New appointment pre-filled with that date (QW9).
// Clicks on an appointment inside a cell are handled by the appointment's own onclick.
$("#diary-grid").addEventListener("click", (e) => {
  if (e.target.closest(".appt")) return;
  const cell = e.target.closest(".diary-day");
  if (!cell || !cell.dataset.date) return;
  openAppt(null, { starts_at: cell.dataset.date + "T10:00" });
});
/* R41 · F1: setTasksScope() and the #tasks-scope-mine / -unassigned / -all buttons went with the Tasks-due
   drawer. The replacement is My Day's own Mine | All segment plus the "· unassigned" suffix every ownerless… */

/* G1R-2 — the diary page renders in EITHER of two modes and `#page-diary` is visible in both, so "if the
   diary page is open, reload it" is not enough: after B9 added the Day view… */
function refreshDiaryView() {
  if ($("#page-diary").classList.contains("hidden")) return;
  loadDiaryForMode();   // R75 · A1 — whichever of the three views is live
}
/* R12a·D11: ONE DEFINITION OF "CLASH" Two people cannot be in two places at once; two appointments for
   DIFFERENT people at the same time are not a clash at all, they are a Tuesday. */
function apptInterval(o) {
  const st = new Date(o.starts_at);
  const en = o.ends_at ? new Date(o.ends_at) : new Date(st.getTime() + 60000);
  return [st, en > st ? en : new Date(st.getTime() + 60000)];
}
function apptOverlaps(a, b) {
  if (!a || !b || !a.staff_id || a.staff_id !== b.staff_id) return false;
  const [aS, aE] = apptInterval(a), [bS, bE] = apptInterval(b);
  return aS < bE && bS < aE;
}
/* The words a human reads for the OTHER appointment: what it is and exactly when, e.g. `"Fact find call"
   (09:00–09:45)`. One phrase, so the confirm, the toast, the tile tooltip and the editor's notice all name… */
function apptClashPhrase(o) {
  if (!o) return "another appointment";
  const [st, en] = apptInterval(o);
  const t = (d) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `"${o.title || "an appointment"}" (${t(st)}–${t(en)})`;
}
/* The first appointment this proposed slot would double-book, or null. Narrowed at the database to the day
   before and the day after, rather than reading the adviser's whole diary as this used to… */
async function apptClashFor(staffId, startAt, endAt, excludeId) {
  if (!staffId || !startAt || isNaN(startAt)) return null;
  const from = new Date(startAt.getFullYear(), startAt.getMonth(), startAt.getDate());
  from.setDate(from.getDate() - 1);
  const to = new Date(from); to.setDate(to.getDate() + 3);
  let q = db.from("appointments").select("id,title,starts_at,ends_at,staff_id")
    .eq("staff_id", staffId)
    .gte("starts_at", from.toISOString()).lt("starts_at", to.toISOString());
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q;
  const mine = { staff_id: staffId, starts_at: startAt.toISOString(), ends_at: (endAt || startAt).toISOString() };
  return (data || []).find((o) => apptOverlaps(mine, o)) || null;
}
/* R12b · W-10: "book an appointment" from a case is a DETOUR, not a departure. The appointment form replaces the
   case modal (they share one host), and Save closed the lot, dumping the operator back on whatever page was
   underneath — so booking a fact find while reading a case cost the case, its scroll position and the train of
   thought that started the booking. … */
window.openApptFromCase = function (apptId, caseId) { return window.openAppt(apptId, {}, { returnCaseId: caseId }); };
window.openAppt = async function (id, presets = {}, openOpts = {}) {
  const returnCaseId = openOpts.returnCaseId || null;
  // T1-14 — default to the adviser the diary is filtered to (rather than always "me"), so
  // "+ Appointment" while looking at Tom's diary books it for Tom, not for whoever is signed in.
  const filterStaff = $("#diary-staff") && $("#diary-staff").value;
  const defaultStaffId = (filterStaff && filterStaff !== "all") ? filterStaff : ((ME && ME.id) || null);
  let a = { staff_id: defaultStaffId, ...presets };
  if (id) {
    const { data } = await db.from("appointments").select("*").eq("id", id).single();
    /* G1R-2 — a row that isn't there any more must say so. Falling through to `a` (the empty defaults) opened
       a blank form titled "Appointment"… */
    if (!data) {
      toast("This appointment no longer exists — it may have been deleted.");
      refreshDiaryView();
      // R41 · F1 — was loadTodayAppts(); the appointments drawer is gone and today's bookings are
      // My Day `appt_today` rows, so that is what a deleted-out-from-under-you booking repaints.
      if (!$("#page-dashboard").classList.contains("hidden")) loadBriefing();
      return;
    }
    a = data;
  }
  /* R85 · D7 — the picker's whole-book clients read is the session Book (last_name,id order — the
     order the readAll asked for), picked to the same three columns. */
  const clients = sortRows(await bookClients(), ["last_name", "id"]).map((cl) => pickCols(cl, ["id", "first_name", "last_name"]));
  /* R6: the appointment already carries case_id and the modal showed nothing but an "Open case" button, so
     "which of the six flats is this valuation for?" needed a round trip through the case modal. */
  const apptCtx = await loadPropContext([a.case_id]);
  const apptCase = propCtxCase(apptCtx, a.case_id);
  /* R6FIX-1 (R6B-02 + F2): THE CASE CONTROL. The modal could INHERIT a case_id (from "Book appointment" on a case)
     and could LOSE one (G6B-02 clears a link that no longer matches the client), but it could never SET one: an
     appointment booked from the Diary — the natural place to book from when a landlord rings mid-week — was
     client-only forever, and reopening it offered no repair. … */
  const apptCaseCols = "id,client_id,case_kind,lender,stage,updated_at,created_at,property_address";   // R83
  const loadApptCases = async (clientId) => {
    if (!clientId) return [];
    const { data } = await db.from("cases").select(apptCaseCols).eq("client_id", clientId);
    const rows = data || [];
    const recent = (x, y) => String(y.updated_at || y.created_at || "").localeCompare(String(x.updated_at || x.created_at || ""));   // R83
    return rows.filter((x) => x.stage !== "completed" && x.stage !== "not_proceeding").sort(recent)
      .concat(rows.filter((x) => x.stage === "completed" || x.stage === "not_proceeding").sort(recent));
  };
  const apptCaseOptionsHtml = (rows, selectedId) => {
    const opt = (x) => `<option value="${esc(x.id)}"${x.id === selectedId ? " selected" : ""}>${esc(caseIdentityLabel(x) || "Case")}</option>`;
    const live = rows.filter((x) => x.stage !== "completed" && x.stage !== "not_proceeding");
    const done = rows.filter((x) => x.stage === "completed" || x.stage === "not_proceeding");
    return `<option value=""${selectedId ? "" : " selected"}>— none —</option>`
      + (live.length ? `<optgroup label="Open">${live.map(opt).join("")}</optgroup>` : "")
      + (done.length ? `<optgroup label="Completed / closed">${done.map(opt).join("")}</optgroup>` : "");
  };
  let apptCases = await loadApptCases(a.client_id);
  let apptClientId = a.client_id || "";
  /* A link that points at ANOTHER client's case is not offered here, which is the same judgement G6B-02 made
     at save time — stated up front now instead of as a surprise in the save toast. */
  const apptStaleLink = !!(a.case_id && apptCase && apptCase.client_id && apptCase.client_id !== (a.client_id || null));
  const apptSelCaseId = apptStaleLink ? "" : (apptCases.some((x) => x.id === a.case_id) ? a.case_id : "");
  const findApptCase = (cid) => apptCases.find((x) => x.id === cid) || (apptCase && apptCase.id === cid ? apptCase : null);
  const start = a.starts_at ? new Date(a.starts_at) : null;
  const mins = a.ends_at && start ? Math.round((new Date(a.ends_at) - start) / 60000) : 60;
  // Derive both date and time from LOCAL components so a late-evening appointment
  // doesn't show a day-shifted date (matches the local parse used on save).
  // T1-24 (bug 3) — this helper used to be called localDateStr, shadowing the module-level
  // Europe/London one (see the top of the file) for the whole of openAppt: any code added in here
  // that reached for localDateStr silently got browser-local semantics instead. Renamed so the two
  // can't be confused. It stays browser-local deliberately — the form's time field, the save-side
  // `new Date(date + "T" + time)` parse and the diary grid's day bucketing are all browser-local,
  // so this is the one that round-trips.
  const pad2 = (n) => String(n).padStart(2, "0");
  const formDateStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dateVal = formDateStr(start || new Date());
  const timeVal = start ? `${pad2(start.getHours())}:${pad2(start.getMinutes())}` : "10:00";
  /* R12b · W-17: the outcome controls exist on an EXISTING appointment whose day has arrived: anything
     already started, plus the rest of today. A row that already carries an outcome always shows them… */
  const apptOutcomeOn = !!id && (!start || localDateStr(start) <= localDateStr() || isApptOutcome(a.outcome));
  const apptClientName = (clients || []).filter((cl) => cl.id === a.client_id)
    .map((cl) => [cl.first_name, cl.last_name].filter(Boolean).join(" "))[0] || "";
  $("#modal").innerHTML = `
    <h3>${id ? "Appointment" : "New appointment"}</h3>
    
    <p class="panel-sub appt-case-line${apptSelCaseId ? "" : " hidden"}" id="appt-about" style="margin-top:-8px;">${apptSelCaseId ? `About: ${caseIdentityHtml(findApptCase(apptSelCaseId) || apptCase, { fallback: true, cls: "row-prop", stageChip: true })}` : ""}</p>
    ${apptStaleLink ? `<p class="dq-notice bad" id="appt-stale-case">The case this appointment was linked to (${esc(caseIdentityLabel(apptCase))}) belongs to a different client, so it is not offered below. Pick one of this client's cases, or leave it as none.</p>` : ""}
    
    <p class="dq-notice clash-notice hidden" id="appt-clash-note"></p>
    <form id="appt-form" class="form-grid">
      <label class="full">Title<input name="title" id="appt-title" required value="${esc(a.title || "")}" placeholder="e.g. Fact find call"></label>
      
      <div class="full appt-title-chips" id="appt-title-chips">
        <span class="due-chips-lbl">Common:</span>
        ${APPT_TITLE_PICKS.map((t) => `<button type="button" class="btn btn-sm appt-title-chip" data-appt-title="${esc(t)}" title="Use “${esc(t)}” as the title — you can still edit it">${esc(t)}</button>`).join("")}
      </div>
      <label>Date<input name="date" type="date" required value="${dateVal}"></label>
      <label>Time<input name="time" type="time" required value="${timeVal}"></label>
      <label>Duration (mins)<input name="mins" type="number" value="${mins}"></label>
      
      <p class="dq-notice full hidden" id="appt-past-note">This books into the past — recording something that already happened?</p>
      
      <label>Who<select name="staff_id" id="appt-staff">${a.staff_id ? assigneeOptionsHtml(a.staff_id) : assigneeOptionsHtml(defaultAssignee(null))}</select>
        <span class="appt-case-note" id="appt-whose-note"></span></label>
      <label class="full">Client<select name="client_id" id="appt-client"><option value="">— none —</option>${(clients || []).map((cl) => `<option value="${cl.id}" ${cl.id === a.client_id ? "selected" : ""}>${esc([cl.last_name, cl.first_name].filter(Boolean).join(", "))}</option>`).join("")}</select></label>
      <label class="full${apptClientId ? "" : " hidden"}" id="appt-case-wrap">Case (property)<select name="case_id" id="appt-case">${apptCaseOptionsHtml(apptCases, apptSelCaseId)}</select>
        <span class="appt-case-note" id="appt-case-note">${apptClientId && !apptCases.length ? "This client has no cases yet." : "Optional — attaching one puts the property on this appointment in the diary."}</span></label>
      <label class="full">Location<input name="location" value="${esc(a.location || "")}" placeholder="Office / phone / Teams"></label>
      <label class="full">Notes<textarea name="notes" rows="2">${esc(a.notes || "")}</textarea></label>
      
      ${apptOutcomeOn ? `<div class="full appt-outcome-wrap" id="appt-outcome-wrap">
        <span class="appt-outcome-lbl">What happened?</span>
        <div class="appt-outcome-chips" id="appt-outcome-chips">
          <label class="ao-chip"><input type="radio" name="outcome" value=""${isApptOutcome(a.outcome) ? "" : " checked"}> Not recorded</label>
          ${APPT_OUTCOMES.map(([v, label, mark]) => `<label class="ao-chip ao-${v}"><input type="radio" name="outcome" value="${v}"${a.outcome === v ? " checked" : ""}> ${mark} ${esc(label)}</label>`).join("")}
        </div>
        <span class="appt-case-note">Recording an outcome keeps the booking on the record — the slot was taken whether or not the client came. <strong>Delete</strong> below is for one booked in error, and leaves no trace of it at all.</span>
      </div>` : ""}
    </form>
    <div class="modal-actions">
      <div>
        ${id ? '<button class="btn btn-ghost btn-danger" id="del-appt-btn">Delete</button>' : ""}
        
        ${id && a.client_id ? '<button type="button" class="btn btn-ghost" id="appt-open-client">Open client</button>' : ""}
        ${id && a.case_id ? '<button type="button" class="btn btn-ghost" id="appt-open-case">Open case</button>' : ""}
      </div>
      <div class="right">
        <button class="btn" id="modal-cancel">Cancel</button>
        <button class="btn btn-primary" id="modal-save">Save</button>
      </div>
    </div>`;
  openModal();
  // R74 · B2 — required marks up front, inline errors cleared on the edit that fixes them.
  markRequiredFields("#appt-form");
  const apptFormEl = $("#appt-form");
  /* R76 · A6 — the notice line follows the date field live, so it appears while the wrong year is
     still on screen (and disappears the moment it is fixed) rather than only in the save toast.
     Europe/London date part on both sides (localDateStr), per the house date-walk rule. */
  const syncApptPast = () => {
    const note = $("#appt-past-note");
    const dEl = apptFormEl && apptFormEl.elements.date;
    if (!note || !dEl) return;
    const v = String(dEl.value || "").trim();
    note.classList.toggle("hidden", !(v && v < localDateStr()));
  };
  if (apptFormEl) apptFormEl.addEventListener("input", (e) => { clearOneFieldError(e.target); if (e.target && e.target.name === "date") syncApptPast(); });
  syncApptPast();
  pushModalHistory("appt", id, apptClientName || a.title); // BUILD 7a — Back closes this modal · R87 fixer (09 4e) — the client's name (else the title) in the tab
  $("#modal-cancel").onclick = closeModalGuarded; // defect 2 — Cancel is a "leave" path: it must warn about unsaved edits too
  /* R5-48: leaving via these is still a "leave" path: unsaved edits are guarded exactly as Cancel guards
     them, then the destination record replaces this one in the same modal. */
  const apptGoto = (fn, arg) => async () => { if (!hasUnsavedModalEdits() || (await confirmDiscard("this appointment"))) fn(arg); };
  /* R37 · W11: the title quick-picks. `input` is dispatched so the unsaved-changes guard and the clash notice
     see the change exactly as they would see typing… */
  document.querySelectorAll("#appt-title-chips [data-appt-title]").forEach((b) => (b.onclick = () => {
    const el = $("#appt-title");
    if (!el) return;
    el.value = b.dataset.apptTitle;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.focus();
  }));
  const openClientBtn = $("#appt-open-client");
  /* R6FIX-1 — this is a genuine "arriving from a case context": the appointment we are leaving
     names the case, so the client record's note composer may pre-pick it (see openClient). */
  if (openClientBtn) openClientBtn.onclick = apptGoto((cid) => window.openClient(cid, null, null, a.case_id || null), a.client_id);
  /* R6FIX-1 (R6B-02 / F2) — the case field: shown once a client is picked, rebuilt from scratch when the
     client is repointed… */
  const apptAbout = $("#appt-about");
  const apptCaseSel = $("#appt-case");
  const apptCaseWrap = $("#appt-case-wrap");
  const apptCaseNote = $("#appt-case-note");
  const syncApptAbout = () => {
    if (!apptAbout) return;
    const row = apptCaseSel && apptCaseSel.value ? findApptCase(apptCaseSel.value) : null;
    apptAbout.innerHTML = row ? `About: ${caseIdentityHtml(row, { fallback: true, cls: "row-prop" })}` : "";
    apptAbout.classList.toggle("hidden", !row);
  };
  if (apptCaseSel) apptCaseSel.addEventListener("change", syncApptAbout);
  const apptClientSel = $("#appt-client");
  if (apptClientSel) apptClientSel.addEventListener("change", async () => {
    const cid = apptClientSel.value || "";
    if (cid === apptClientId) return; // same client re-picked: the existing choice still stands
    apptClientId = cid;
    apptCases = await loadApptCases(cid);
    if (apptCaseSel) apptCaseSel.innerHTML = apptCaseOptionsHtml(apptCases, ""); // re-offered, never carried over
    if (apptCaseWrap) apptCaseWrap.classList.toggle("hidden", !cid);
    if (apptCaseNote) apptCaseNote.textContent = cid && !apptCases.length
      ? "This client has no cases yet."
      : "Optional — attaching one puts the property on this appointment in the diary.";
    syncApptAbout();
  });
  /* R36-B · W6 — the diary's client list is the same six hundred names as the case form's, and it gets the
     same type-to-filter treatment. Bound after the change listener above so re-pointing the appointment at… */
  upgradeSelectToCombobox(apptClientSel, { placeholder: "Type a client's name, or leave blank…" });
  const openCaseBtn = $("#appt-open-case");
  if (openCaseBtn) openCaseBtn.onclick = apptGoto(window.openCase, a.case_id);
  /* R12a·D11: LIVE CLASH NOTICE. Reads the form exactly as the save does, asks the same apptClashFor() the
     save-time confirm asks, and says the answer in one sentence above the form. */
  const apptClashEl = $("#appt-clash-note");
  let apptClashSeq = 0;   // R83 — the LoadSeq idiom: only the newest keystroke's answer may paint
  const syncApptClash = async () => {
    if (!apptClashEl) return;
    const f = new FormData($("#appt-form"));
    const st = new Date(f.get("date") + "T" + f.get("time"));
    const staffId = f.get("staff_id") || null;
    const mySeq = ++apptClashSeq;   // R83
    if (!staffId || isNaN(st)) { apptClashEl.classList.add("hidden"); apptClashEl.textContent = ""; return; }
    const en = new Date(st.getTime() + (Number(f.get("mins")) || 60) * 60000);
    const clash = await apptClashFor(staffId, st, en, id);
    /* R83: this fires on every input event with no debounce, so a slow earlier query (14:00) could resolve
       AFTER the one for the time now in the field (15:00) and paint a clash for a slot that is free… */
    if (mySeq !== apptClashSeq) return;   // R83
    if (!clash) { apptClashEl.classList.add("hidden"); apptClashEl.textContent = ""; return; }
    apptClashEl.textContent = `⚠ Clashes with ${apptClashPhrase(clash)} — ${staffName(staffId)} is already booked. You can still save this; the diary will show both, flagged.`;
    apptClashEl.classList.remove("hidden");
  };
  /* R72 · B1 (H4) — "this is not your diary", said while the form is open rather than discovered
     a week later by the adviser who was never told. Silent when the booking is the booker's own. */
  const syncApptWhose = () => {
    const el = $("#appt-whose-note");
    if (!el) return;
    const sel = $("#appt-staff");
    const who = (sel && sel.value) || "";
    if (!who || (ME && who === ME.id)) { el.textContent = ""; return; }
    el.textContent = `This appointment goes in ${staffName(who)}'s diary, not yours.`;
  };
  ["date", "time", "mins", "staff_id"].forEach((n) => {
    const el = $("#appt-form") && $("#appt-form").elements[n];
    if (!el) return;
    el.addEventListener("change", syncApptClash);
    el.addEventListener("input", syncApptClash);
    if (n === "staff_id") el.addEventListener("change", syncApptWhose);
  });
  syncApptClash();
  syncApptWhose();
  $("#modal-save").onclick = async () => {
    const f = new FormData($("#appt-form"));
    const title = String(f.get("title") || "").trim();
    const startAt = new Date(f.get("date") + "T" + f.get("time"));
    /* R74 · B2 — the same field-anchored refusal the client form now gives. Same two rules, same
       two refusals; what is new is that the empty box is marked and scrolled to. */
    const apptErrs = [];
    if (!title) apptErrs.push(['#appt-form [name="title"]', "Give the appointment a title — it is what shows in the diary."]);
    if (isNaN(startAt)) apptErrs.push([$('#appt-form [name="date"]').value ? '#appt-form [name="time"]' : '#appt-form [name="date"]', "A date and a start time are both needed."]);
    if (apptErrs.length) {
      setFormErrors("#appt-form", apptErrs);
      return toast(apptErrs.length === 1
        ? "Not saved — " + apptErrs[0][1] + " It is marked on the form."
        : `Not saved — ${apptErrs.length} fields need fixing. They are marked on the form.`);
    }
    clearFormErrors("#appt-form");
    const dur = Number(f.get("mins") || 60);
    const row = {
      title,
      starts_at: startAt.toISOString(),
      ends_at: new Date(startAt.getTime() + dur * 60000).toISOString(),
      staff_id: f.get("staff_id") || null,
      client_id: f.get("client_id") || null,
      case_id: f.get("case_id") || null,
      location: String(f.get("location") || "").trim() || null,
      notes: String(f.get("notes") || "").trim() || null,
    };
    /* G6B-02, now with a control to correct it with. The case is whatever the operator chose, and the
       selector only ever offers the chosen client's cases — so this is a backstop, not the mechanism… */
    let caseUnlinked = null;   // the case that was REMOVED, never the one just attached
    const chosenCase = row.case_id ? findApptCase(row.case_id) : null;
    if (row.case_id && chosenCase && chosenCase.client_id && chosenCase.client_id !== row.client_id) {
      row.case_id = null;
      caseUnlinked = chosenCase;
    }
    /* R6-FIX G63-07 — the backstop for a link the modal already flagged as stale. It fired whenever the saved
       case_id differed from the stored one, i.e. on the successful REPAIR… */
    if (!caseUnlinked && id && a.case_id && apptStaleLink && !row.case_id) caseUnlinked = apptCase;
    /* Diary double-booking warning (defect 5) — warn, never block. R12a·D11 — the overlap test itself now
       lives in apptClashFor(), shared with the live notice above and stated once: SAME adviser… */
    let savedOverClash = null;
    if (row.staff_id) {
      savedOverClash = await apptClashFor(row.staff_id, startAt, new Date(row.ends_at), id);
      if (savedOverClash && !confirm(`${staffName(row.staff_id)} already has ${apptClashPhrase(savedOverClash)}.\n\nThis appointment overlaps it. Book anyway?`)) return;
    }
    /* R12b · W-17: the outcome rides on the SAME write as everything else on the form, so a Save is one round
       trip and the two can never end up half-applied. */
    let outcomeChanged = false;
    if (apptOutcomeOn) {
      const chosen = String(f.get("outcome") || "");
      row.outcome = isApptOutcome(chosen) ? chosen : null;
      outcomeChanged = (a.outcome || null) !== row.outcome;
    }
    const { error } = await (id ? db.from("appointments").update(row).eq("id", id) : db.from("appointments").insert(row));
    if (error) return dbFail("openAppt", error);
    /* R12b · W-17: the no-show call-back, offered AFTER the write has succeeded and only on a genuine CHANGE
       to no_show, so re-saving an already-recorded no-show does not ask again. */
    let outcomeExtra = "";
    if (outcomeChanged && row.outcome === "no_show") {
      outcomeExtra = await offerNoShowTask({ id, case_id: row.case_id, staff_id: row.staff_id }, apptClientName);
    } else if (outcomeChanged && row.outcome) {
      outcomeExtra = ` · recorded as ${APPT_OUTCOME_LABEL[row.outcome].toLowerCase()}`;
    } else if (outcomeChanged) {
      outcomeExtra = " · outcome cleared";
    }
    /* R72 · B1 (H4): name the diary it landed in whenever it is not the saver's own. An admin doing a morning
       of intake books four appointments for three advisers… */
    const otherDiary = row.staff_id && (!ME || row.staff_id !== ME.id) ? ` · in ${staffName(row.staff_id)}'s diary` : "";
    /* R76 · A6 — a booking whose start date is already behind today (Europe/London date part) is
       almost always somebody RECORDING a meeting that already happened — legitimate, so it is
       never blocked — but occasionally it is a mistyped year, so the save toast carries the same
       clause the form's own notice line showed. Warn, never block. */
    const pastBooked = localDateStr(startAt) < localDateStr();
    const savedMsg = "Appointment saved"
      + otherDiary
      + (savedOverClash ? ` · double-booked over ${apptClashPhrase(savedOverClash)}` : "")
      + outcomeExtra
      + (pastBooked ? " · This books into the past — recording something that already happened?" : "")
      + (caseUnlinked ? ` · the link to ${caseIdentityLabel(caseUnlinked) || "the previous case"} was removed — that case belongs to a different client` : "");
    /* R76 · A4: the editor is the other place an outcome flips to ATTENDED, and the same next step is offered
       on its toast. Case-linked only, and only on a genuine change… */
    const attendedAction = outcomeChanged && row.outcome === "attended" && row.case_id
      ? { label: "Log what was discussed", onClick: () => window.apptLogDiscussed(row.case_id) } : undefined;
    refreshDiaryView();
    if (!$("#page-dashboard").classList.contains("hidden")) loadBriefing();   // R41 · F1 — My Day carries today's bookings now
    /* R12b · W-10 — booked FROM a case: go back to it rather than closing everything. openCase
       replaces this modal (and its history entry) exactly as the "Open case" button above does. */
    if (returnCaseId) {
      toast(savedMsg + " · back on the case", attendedAction);
      await window.openCase(returnCaseId);
      return;
    }
    closeModal();
    toast(savedMsg, attendedAction);
  };
  if (id) $("#del-appt-btn").onclick = async () => {
    /* R12b · W-17: Delete and "record an outcome" are different verbs and the copy now says so. Deleting a
       meeting that HAPPENED to tidy the diary destroys the only evidence the firm has that it was offered… */
    if (!(await confirmDestructive({
      title: "Delete this appointment?",
      body: "Use this only for one <strong>booked in error</strong>: it is removed outright and leaves no trace that the slot was ever held.<br><br>If it happened, or the client did not turn up, record that under <strong>“What happened?”</strong> instead — the booking stays on the record either way.",
      okLabel: "Delete appointment", cancelLabel: "Keep it",
    }))) return;
    const { error } = await db.from("appointments").delete().eq("id", id);
    if (error) return dbFail("deleteAppt", error, "Couldn't delete that appointment — " + error.message);   // R81 · A4
    refreshDiaryView();
    if (!$("#page-dashboard").classList.contains("hidden")) loadBriefing();   // R41 · F1 — My Day carries today's bookings now
    if (returnCaseId) {
      toast("Appointment deleted · back on the case");
      await window.openCase(returnCaseId);
      return;
    }
    closeModal();
    toast("Appointment deleted");
  };
};

/* R90 · F: deploy handshake stamp. Every round that edits ANY of index.html / core.js / reports-money.js /
   diary.js / import.js / vault.js / app.js bumps the tag IN ALL SEVEN PLACES. */
window.__nxTag_diary = "r90";   // R89 — the CTO bumps all seven to r90 at the gate
