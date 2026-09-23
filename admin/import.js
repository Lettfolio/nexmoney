/* ==========================================================================
   NexMoney Back Office — admin/import.js  (R90 · F)
   The IMPORT tab's two machines, carved from app.js: Bulk import (AI) and R8-REV Revolution sync.
   The shared drop-zone widget stays in app.js (Money's zones use it too).
   SCRIPT ORDER: core.js → reports-money.js → diary.js → import.js → vault.js →
   app.js. THE DEFINITION-TIME RULE (HARNESS.md "R78 · A" / "R81 · A"): a declaration here may
   reference nothing from a LATER script at its own definition time (call-time references are fine);
   app.js stays LAST because init()'s awaits run between classic scripts (see reports-money.js).
   THE ONE ACCOMMODATION: #import-file / #rev-file are created by app.js's eval-time mountDropZone(),
   so their change bindings run at DOMContentLoaded (tagged "R90 · F" below).
   ========================================================================== */

/* ---------- Bulk import (AI) ---------- */
let importRows = [];
/* R75 · B1 (panel finding 10): "Assign new cases to me" no longer defaults ON for everybody. Null = "nobody has
   touched the checkbox this session", so the role rule decides; a click pins it either way for the rest of the
   session. … */
let importAssignToMe = null;
const importAssignToMeOn = () => (importAssignToMe == null ? newCaseSelfAssigns() : importAssignToMe);

/* R90 · F — LOAD-ORDER ACCOMMODATION (the R81 · A1 recipe, repeated): #import-file is NOT in the
   shipped markup — app.js's eval-time mountDropZone() CREATES it inside its *-file-slot div, and
   app.js now evaluates AFTER this file. So this one binding runs at DOMContentLoaded (which fires
   only after every classic script has evaluated) instead of at this script's own eval: same
   bind-once semantics, a few milliseconds later, still AFTER the drop zone's own readout listener;
   nothing can be clicked before DCL. The body is byte-identical to the old top-level statement. */
(() => {
  const wireImportFileInput = () => {
$("#import-file").addEventListener("change", async () => {
  const file = $("#import-file").files[0];
  if (!file) return;
  const name = file.name.toLowerCase();
  try {
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      await ensureXlsx(); // R55 · F7 — lazy-loaded; throws with a readable message on failure
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      let text = "";
      wb.SheetNames.forEach((sn) => {
        text += `=== Sheet: ${sn} ===\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + "\n\n";
      });
      $("#import-text").value = text;
    } else {
      $("#import-text").value = await file.text();
    }
    $("#import-status").textContent = `Loaded ${file.name} — now press Analyse.`;
  } catch (e) {
    toast("Could not read file: " + e.message);
  }
  impSyncAnalyseBtn();   // R75 · B1 — the file just filled the box; the button follows it
});
  };   // R90 · F — end wireImportFileInput
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireImportFileInput);
  else wireImportFileInput();
})();
/* R75 · B1: ✨ Analyse with AI is DISABLED until there is something to analyse, and says why in its own title
   rather than answering a press with a toast at the bottom of the screen. */
function impSyncAnalyseBtn() {
  const btn = $("#analyse-btn");
  if (!btn) return;
  const box = $("#import-text");
  const has = !!(box && box.value.trim());
  btn.disabled = !has;
  btn.title = has
    ? "Send what is in the box to the AI reader. Nothing is saved — every row it finds comes back below for you to check and tick."
    : "Nothing to analyse yet — drop a file into the zone above, or paste rows into the box.";
}
if ($("#import-text")) $("#import-text").addEventListener("input", impSyncAnalyseBtn);
impSyncAnalyseBtn();

/* ==========================================================================
   R6 BATCH 3 · THE IMPORT NO LONGER THROWS THE ADDRESS AWAY
   Bringing a landlord's spreadsheet in is the ONE motion that carries a
   property address for every case at once, and it was the motion that
   guaranteed the address never arrived: the `ai-import` function has no header
   pattern for a property column, so `Client,Address,Lender,Loan,Stage` parsed
   two rows and dropped Address entirely (LR-13, f1).

   The analyser is an edge function this round must not touch, so the app reads
   the property column out of the pasted text ITSELF, aligns it to the rows the
   analyser returned, and treats a `property_address` already present in the
   payload as authoritative — so the day `ai-import` learns the column, this
   code steps out of the way rather than fighting it.
   ====================================================================== */
function impPropHeaderRole(h) {
  const s = String(h == null ? "" : h).trim().toLowerCase().replace(/[_\s]+/g, " ");
  if (!s) return null;
  if (/(value|price|valuation|worth|equity|amount)/.test(s)) return null;
  const security = /(security|mortgag|subject|btl|buy to let|let|rental|investment)/.test(s);
  if (/^(client|customer|home|correspondence|billing|applicant|borrower|owner)\b/.test(s) && !security) return null;
  if (/(post ?code|postal code|zip)/.test(s)) return "postcode";
  if (/(address|addr\b|premises|property|security|site)/.test(s)) return "property_address";
  return null;
}
/* Is this cell plausibly a property address? Guards the loose headers ("Property", "Site") from pulling in a
   number, a date, an email or a stage word… */
function impLooksLikeAddress(v) {
  const s = String(v == null ? "" : v).trim();
  if (s.length < 6) return false;
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) return false;   // an address has a number and a word
  if (/@/.test(s)) return false;
  if (/^[£$]?\s*[\d,.]+\s*%?$/.test(s)) return false;        // money / percentage
  if (/^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(s) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return false;
  return true;
}
/* The pasted text, split the way the analyser splits it: the delimiter that appears on the most lines, quoted
   commas respected — a quoted address is the whole point. */
function impSplitDelimited(line, delim) {
  if (delim !== ",") return line.split(delim).map((s) => s.trim());
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === "," && !q) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function impParsePaste(content) {
  const text = String(content == null ? "" : content).replace(/\r/g, "").trim();
  if (!text) return [];
  const lines = text.split("\n").map((l) => l.trim())
    .filter((l) => l && !/^===\s*Sheet:/i.test(l) && !/^-{3,}$/.test(l));
  if (!lines.length) return [];
  let delim = null, best = 0;
  ["\t", ",", "|", ";"].forEach((d) => {
    const n = lines.filter((l) => l.indexOf(d) >= 0).length;
    if (n > best && n >= Math.max(1, Math.ceil(lines.length / 2))) { best = n; delim = d; }
  });
  const cells = lines.map((l) => {
    const d = (delim && l.indexOf(delim) >= 0) ? delim : ["\t", "|", ";", ","].filter((x) => l.indexOf(x) >= 0)[0];
    return d ? impSplitDelimited(l, d) : [l];
  });
  // Header detection mirrors the analyser's: a first row that names columns and looks nothing like data.
  const first = cells[0] || [];
  const nameRe = /^(client[_ ]?name|full[_ ]?name|name|client|customer|first[_ ]?name|forename|surname|last[_ ]?name)$/i;
  let header = null;
  if (first.length > 1) {
    const roles = first.map((h) => {
      if (/e-?mail/i.test(h)) return "email";
      if (nameRe.test(String(h).trim())) return "name";
      return impPropHeaderRole(h);
    });
    const looksLikeData = first.some((h) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h) || impLooksLikeAddress(h));
    if (roles.filter(Boolean).length && !looksLikeData) header = roles;
  }
  const out = [];
  cells.forEach((cs, i) => {
    if (header && i === 0) return;
    const rec = { cells: cs, name: "", email: "", addr: "", postcode: "", headed: !!header };
    if (header) {
      header.forEach((role, j) => {
        if (!role) return;
        const v = String(cs[j] == null ? "" : cs[j]).trim();
        if (!v) return;
        if (role === "property_address") { if (!rec.addr && impLooksLikeAddress(v)) rec.addr = v; }
        else if (role === "postcode") { if (!rec.postcode) rec.postcode = v; }
        else if (!rec[role]) rec[role] = v;
      });
    } else {
      // No header: only a cell carrying a UK postcode is confident enough to call an address.
      cs.forEach((raw) => {
        const v = String(raw == null ? "" : raw).trim();
        if (!rec.addr && impLooksLikeAddress(v) && POSTCODE_RE.test(v)) rec.addr = v;
        if (!rec.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) rec.email = v;
      });
    }
    // A separate postcode column belongs on the end of the address it goes with, exactly as the
    // fact-find joins address + postcode into one value.
    if (rec.addr && rec.postcode && rec.addr.toUpperCase().replace(/[^A-Z0-9]/g, "").indexOf(rec.postcode.toUpperCase().replace(/[^A-Z0-9]/g, "")) < 0) {
      rec.addr = rec.addr.replace(/[,\s]+$/, "") + " " + rec.postcode;
    }
    out.push(rec);
  });
  return out;
}
/* Attach the recovered addresses to the analyser's rows. Matching is by identity FIRST (email, then name) and
   consumes each parsed line once… */
function impAttachProperties(content, rows) {
  if (!rows || !rows.length) return 0;
  // ONE parse. The positional fallback below needs the index of a line within THIS list, so parsing
  // twice (and comparing objects across the two runs) would never match anything.
  const lines = impParsePaste(content);
  if (!lines.some((p) => p.addr)) return 0;
  const norm = (s) => String(s == null ? "" : s).trim().toLowerCase();
  const used = new Set();
  let n = 0;
  rows.forEach((r, ri) => {
    if (r.property_address) return;                     // the analyser knew — leave it alone
    let hit = -1;
    for (let i = 0; i < lines.length; i++) {
      if (used.has(i) || !lines[i].addr) continue;
      const p = lines[i];
      if (p.email && norm(p.email) === norm(r.email)) { hit = i; break; }
      if (p.name && norm(p.name) === norm(r.client_name)) { hit = i; break; }
    }
    // Positional fallback: as many lines as rows, and this line has an address.
    if (hit < 0 && lines.length === rows.length && lines[ri] && lines[ri].addr && !used.has(ri)) hit = ri;
    if (hit < 0 || used.has(hit)) return;
    used.add(hit);
    r.property_address = lines[hit].addr;
    n++;
    // An unheaded paste's address usually landed in `note` or `lender` by shape — don't print it twice.
    if (norm(r.note) === norm(r.property_address)) r.note = null;
    if (norm(r.lender) === norm(r.property_address)) r.lender = "";
  });
  return n;
}
window.impAttachProperties = impAttachProperties;
window.impPropHeaderRole = impPropHeaderRole;
window.impParsePaste = impParsePaste;

$("#analyse-btn").addEventListener("click", async () => {
  const content = $("#import-text").value.trim();
  if (!content) return toast("Paste some data or choose a file first");
  $("#analyse-btn").disabled = true;
  $("#import-status").textContent = "AI is sorting the data — up to a minute for big files…";
  try {
    const { data: { session } } = await db.auth.getSession();
    const r = await fetch(`${SUPABASE_URL}/functions/v1/ai-import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    const j = await r.json();
    if (!r.ok || j.error) { $("#import-status").textContent = ""; return dbFail("impParsePaste", (j.error || r.status)); }
    importRows = j.rows || [];
    impMemoBump();   // R83
    // R6-33 — recover the property column the analyser has no pattern for (see impAttachProperties).
    const nProp = impAttachProperties(content, importRows);
    // R5-23a — one clients fetch feeds every row's match; runImport re-reads it before writing so a
    // record created since Analyse can't be duplicated.
    importClients = await fetchMatchClients();
    // R6-34 — and the cases those clients already hold, so a row can be judged "another case on a
    // property we already have for this person" vs "a new property" BEFORE it is written.
    importCases = await fetchMatchCases(importClients);
    impMemoBump();   // R83 — fresh reads, fresh answers
    /* R75 · B1: "1 records found." was the app telling somebody who had just pasted one row that it cannot
       count. Every other tally in this file is pluralised; this one now is too. */
    $("#import-status").textContent = `${importRows.length} record${importRows.length === 1 ? "" : "s"} found.`
      + (nProp
        ? ` ${nProp} property address${nProp === 1 ? "" : "es"} read from the file.`
        : "");
    renderImportPreview();
  } catch (e) {
    $("#import-status").textContent = "";
    dbFail("norm", e);
  } finally {
    // R75 · B1 — back to whatever the box justifies, not unconditionally enabled.
    impSyncAnalyseBtn();
  }
});

/* T1-21 — every date field on an import row, resolved once so the preview and the insert can never
   disagree about what "01/02/2026" meant. */
const IMPORT_DATE_FIELDS = [["rate_end_date", "Rate ends"], ["erc_end_date", "ERC ends"], ["completed_date", "Completed"]];
/* ---- "completed but no completion date" (T1-honestfix defect 3, reworked by T1-finalfix finding 1)

   A row that lands at stage "completed" with no readable completion date imports with
   completed_at: null — the exact gap Data Health's "Completed, no completion date" tile exists to
   catch. The first cut of this rule simply unticked EVERY such row with no per-row way back (only
   the all-or-nothing header select-all), and the result message never mentioned what had happened,
   so the silent-bad-data problem just moved one step later. Worse, it fired on rows whose
   "completed" stage was never asserted by the source at all, which made a plain CSV import a no-op.

   Two pieces now:
   1. WHEN TO FLAG. `stage` reaches importRows straight from the ai-import function's reading of the
      pasted text, and the app itself defaults a missing stage ("stage: r.stage || 'enquiry'" in
      runImport). A "completed" that is a default/fill-in rather than something the source said is
      not evidence of completion, and must not untick a row. We treat the analyser as having read
      completion for a row only when it reported the completion-date field for that row at all —
      present but blank/unreadable means "the source has a completion column and this row's cell is
      empty", which IS the source saying "completed, date missing". A row where the field was never
      reported gets the visible amber flag (so nothing is hidden) but stays ticked, and the import
      result counts it either way, so it can never land silently.
   2. HOW TO RESOLVE IT. Exactly like the ambiguous-date flag it was modelled on: a per-row button
      ("Import with no date") that consciously accepts a null completion date, plus the row's own
      Stage select — dropping it off "Completed & closed" clears the flag too. No date is ever
      invented. */
const impSourceStatedCompleted = (r) => !!r && r.stage === "completed" && Object.prototype.hasOwnProperty.call(r, "completed_date");
const impCompletedNoDate = (r) => !!r && r.stage === "completed" && parseUkDate(r.completed_date).empty;
// Needs a human before it can be ticked: the source says completed, no date, nobody has accepted it.
const impNoDateUnresolved = (r) => impCompletedNoDate(r) && impSourceStatedCompleted(r) && !r._no_date_ok;
function impDateFlags(r) {
  const out = {};
  let flagged = false;
  IMPORT_DATE_FIELDS.forEach(([f]) => {
    const p = parseUkDate(r[f]);
    out[f] = p;
    if (!p.empty && (!p.ok || p.ambiguous)) flagged = true;
  });
  if (impNoDateUnresolved(r)) flagged = true;
  out.noDate = impCompletedNoDate(r);
  out.noDateUnresolved = impNoDateUnresolved(r);
  out.flagged = flagged;
  return out;
}
/* R75 · B1 (panel finding 10): THE PERSON CHECK, SHARED WITH THE REVOLUTION PATH. "The AI importer pre-ticks
   gibberish rows the Revolution importer correctly refuses." */
function rowPersonCheck(name, email, phone) {
  const n = String(name == null ? "" : name).trim();
  const e = String(email == null ? "" : email).trim();
  const p = String(phone == null ? "" : phone).trim();
  if (!n && !e && !p) return { ok: false, reason: "the row has no name, email or phone — there is no person in it" };
  if (!n) return { ok: false, reason: "the row has contact details but no name" };
  return { ok: true, reason: "" };
}
const impPersonCheck = (r) => rowPersonCheck(r && r.client_name, r && r.email, r && r.phone);
const impNoPerson = (r) => !impPersonCheck(r).ok;
/* Whether a row starts UNticked. Three independent reasons now: a date nobody has resolved (T1-21 / defect
   3), a likely-duplicate case (R6-34), and (R75) a row with no person in it. */
function impRowFlagged(r) { return impDateFlags(r).flagged || impDupUnresolved(r) || impNoPerson(r); }
// One preview cell for a date: amber with the interpretation + a Confirm button when it needs a human.
function impDateCell(r, i, field, extraHtml) {
  const p = parseUkDate(r[field]);
  if (p.empty) {
    // Completed with nothing to fall back on — flag it rather than let a guessed date reach the
    // cases table and feed Reports' money figures as though it were real (defect 3).
    if (field === "completed_date" && impCompletedNoDate(r)) {
      if (impNoDateUnresolved(r)) {
        return `<td class="imp-date-warn" data-cell="${esc(field)}" title="The source marks this case completed but gives no completion date. It would import with none set and be listed on Data health as &quot;Completed, no completion date&quot;. Accept that, or change the row's Stage.">— <span class="badge amber">no date</span>
          <button type="button" class="btn btn-sm imp-nodate-ok" data-i="${i}" title="Import this case as completed with no completion date — nothing is invented, and Data health will list it until someone fills it in">Import with no date</button></td>`;
      }
      if (r._no_date_ok) {
        return `<td class="imp-date-warn" data-cell="${esc(field)}" title="Accepted: this case will import as completed with completed_at left empty, and will be listed on Data health as &quot;Completed, no completion date&quot; until someone fills it in.">— <span class="badge amber">no date — accepted</span></td>`;
      }
      // Stage is "completed" but the source never reported a completion field for this row, so the
      // stage is a default rather than a statement. Show the flag; don't untick over it.
      return `<td class="imp-date-warn" data-cell="${esc(field)}" title="No completion date came through for this row, and the source never said whether the case was completed — the stage shown is a fallback. It will import with no completion date and be listed on Data health as &quot;Completed, no completion date&quot;. Change the Stage if that is wrong.">— <span class="badge amber">no date</span></td>`;
    }
    return `<td data-cell="${esc(field)}"></td>`;
  }
  if (!p.ok) {
    return `<td class="imp-date-bad" data-cell="${esc(field)}" title="${esc(p.note || "unreadable date")}">${esc(p.raw)} <span class="badge red">can't read</span></td>`;
  }
  if (p.ambiguous) {
    return `<td class="imp-date-warn" title="${esc(p.note || "")}">${esc(p.raw)} → ${esc(fmtD(p.iso))}?
      <button type="button" class="btn btn-sm imp-date-ok" data-i="${i}" data-field="${esc(field)}" data-iso="${esc(p.iso)}" title="Confirm this reading and re-tick the row">Confirm</button></td>`;
  }
  return `<td data-cell="${esc(field)}">${esc(fmtD(p.iso))}${extraHtml || ""}</td>`;
}

/* ---------- R5-23a / R5-23b — the import preview says who each row will land on ----------
   The old preview showed the data and hid the decision: at save time a row silently attached to any
   client with the same email or the same sorted name key, and any incoming email/phone that
   disagreed with what we already held was dropped on the floor (only a BLANK stored field was ever
   filled). Two rows of the same file could therefore mean "new client" and "amend Ruby's record"
   with nothing on screen to tell them apart.

   Now every row resolves to a visible decision before anything is written:
     green  "→ attaches to X"   — an exact match (email / phone / name with nothing contradicting it)
     amber  "possible: X"       — a candidate that needs a human: Attach or New client
     blank                      — no candidate, this creates a client
   The choice lives on the row (`_match_client_id` / `_force_new`) and re-derives whenever the row's
   name, email or phone is edited, so the preview and the insert can never disagree. Where an
   attaching row's email/phone differ from the stored value, the row expands into a merge-modal-style
   per-field picker (existing pre-selected — the import never overwrites a known contact detail
   without being told to) and whatever is NOT kept is named in the result panel. */
let importClients = [];   // one-shot clients fetch, refreshed on Analyse and again at save time
/* R6-34: the cases those clients already hold. The Match column resolved a row to a PERSON and stopped there:
   for a portfolio landlord "→ attaches to Gareth Pollard" is true of a sixth property and equally true of a… */
let importCases = [];
async function fetchMatchCases(clients, opts) {
  const ids = [...new Set((clients || []).map((c) => c.id).filter(Boolean))];
  if (!ids.length) return [];
  /* R85 · D6: TWO CALLERS, TWO FRESHNESS RULES. The Analyse-time call paints a PREVIEW, so it is served from
     the session Book: the same seven columns, the same `property_address is not null` filter… */
  if (!(opts && opts.fresh)) {
    const snap = await bookLoad();
    if (snap.error) return [];
    const cols = ["id", "client_id", "stage", "case_kind", "lender", "property_address", "created_at"];
    return snap.cases.filter((c) => c.property_address != null).map((c) => pickCols(c, cols));
  }
  /* R83: PAGED. This is a firm-wide read and a bare select stops at PostgREST's 1,000-row ceiling with no
     error… */
  const { data, error } = await readAll(db.from("cases")
    .select("id,client_id,stage,case_kind,lender,property_address,created_at")
    .not("property_address", "is", null).order("id"));   // R83
  if (error) return [];
  return data || [];
}
const impLenderKey = (l) => String(l == null ? "" : l).toLowerCase().replace(/[^a-z0-9]/g, "");
/* The row's CASE-level verdict against one client's existing cases. Three states, and only ever
   about a row that carries an address — a row with none says nothing new and gets nothing.
     dup  (amber) same client + same property + same lender → this is very likely a case we already
                  hold. Not a certainty (a product transfer and a remortgage on one house with one
                  lender are two real cases — Duncan Armitage has exactly that pair), so it is a
                  flag and a decision, never a refusal.
     same (grey)  same client + same property, DIFFERENT lender → a new case on a property we hold.
     new  (green) same client + an address none of their cases has → a new property.

   G6-06 — the comparison set now includes THE FILE'S OWN EARLIER ROWS. It only ever looked at the
   database, so the most ordinary spreadsheet accident there is — the same client + property + lender
   pasted twice, a re-exported overlapping range — got a GREEN "new property" on BOTH rows, both
   pre-ticked, no gate, and created two identical cases with two verdict lines that were byte-identical
   on screen. A batch row is judged exactly as a stored one is, and the verdict names the row it
   collides with.
   G6B-01 — and it now looks ACROSS clients. `importCases` is a firm-wide read (no client filter), so
   the data to say "Kwame Boateng and Gareth Pollard already hold cases on 9 Bryanstone Road" was in
   hand at the moment the screen printed a reassuring green badge for a third client on the same
   building. Advisory only, never a refusal — two clients legitimately holding one building (a sale we
   advised on both sides of) is the documented case. */
function impPropVerdict(r) {
  const key = propKey(r && r.property_address);
  if (!key) return null;
  const memo = impMemo(r);   // R83
  if (memo.verdict !== undefined) return memo.verdict;
  return (memo.verdict = impPropVerdictCompute(r, key));   // R83
}
function impPropVerdictCompute(r, key) {   // R83 — the body of impPropVerdict, unchanged
  const d = impResolveMatch(r);
  /* The row's PERSON identity, so two rows in one file can be compared without both having to
     resolve to a stored client: a matched client is its id, an unmatched one is its own name/email. */
  const personKey = (row, dec) => {
    if (dec && dec.mode === "attach" && dec.client) return "c:" + dec.client.id;
    const em = String(row.email || "").trim().toLowerCase();
    if (em) return "e:" + em;
    const nm = String(row.client_name || "").trim().toLowerCase().replace(/\s+/g, " ");
    return nm ? "n:" + nm : null;
  };
  const mePerson = personKey(r, d);
  const idx = importRows.indexOf(r);
  const earlier = [];
  if (mePerson && idx > 0) {
    for (let j = 0; j < idx; j++) {
      const o = importRows[j];
      if (!o || propKey(o.property_address) !== key) continue;
      if (personKey(o, impResolveMatch(o)) !== mePerson) continue;
      earlier.push({ row: o, n: j + 1 });
    }
  }
  const batchDup = earlier.find((e) => impLenderKey(e.row.lender) === impLenderKey(r.lender));
  // Everyone ELSE the firm already holds a case for on this exact building.
  const mineId = d.mode === "attach" && d.client ? d.client.id : null;
  // R6-FIX G63-01 — the cross-client half names other people, so it takes the
  // stricter test (a postcode, or an agreeing town) rather than the bare key.
  const otherClientCases = importCases.filter((c) => propSameBuilding(c, r.property_address) && c.client_id && c.client_id !== mineId);
  const otherClientIds = [...new Set(otherClientCases.map((c) => c.client_id))];
  const otherClientNames = otherClientIds
    .map((id) => clientFullName(importClients.find((c) => c.id === id)) || "another client");
  const cross = { cases: otherClientCases, ids: otherClientIds, names: otherClientNames };
  /* R6-FIX OP-01 (repro C) — the same near-miss question the case form asks, asked here. A file that spells
     an address the firm already holds slightly differently used to come through as a confident green "new… */
  let near = null, fork = null;
  if (mineId) {
    const mineAddrs = importCases.filter((c) => c.client_id === mineId).map((c) => c.property_address);
    const earlierAddrs = earlier.map((e) => e.row.property_address);
    near = propNearMatchIn(r.property_address, mineAddrs.concat(earlierAddrs));
    /* R6-FIX RV-06 — the same address on the same street in a DIFFERENT town. Not a near miss, so it carries
       no button — but a file that abbreviates "Bournemouth" to "Bmth" imports a silent second property… */
    if (!near) fork = propLocForkIn(r.property_address, mineAddrs.concat(earlierAddrs));
  }
  const base = { key, cross, earlier, near, fork };
  if (batchDup) return { ...base, kind: "batchdup", client: d.client || null, batchHit: batchDup };
  if (d.mode !== "attach" || !d.client) {
    return { ...base, kind: "newclient", batchHit: earlier[0] || null };
  }
  const mine = importCases.filter((c) => c.client_id === d.client.id);
  const onProp = mine.filter((c) => propKey(c) === key);
  if (!onProp.length) {
    // No stored case, but possibly an earlier row in this same file on a different lender.
    if (earlier.length) return { ...base, kind: "batchsame", client: d.client, batchHit: earlier[0] };
    return { ...base, kind: "new", client: d.client };
  }
  const dup = onProp.find((c) => impLenderKey(c.lender) && impLenderKey(c.lender) === impLenderKey(r.lender));
  if (dup) return { ...base, kind: "dup", client: d.client, hit: dup, others: onProp };
  return { ...base, kind: "same", client: d.client, others: onProp };
}
/* A likely-duplicate row needs a conscious tick — the same discipline as "completed, no date".
   An in-batch duplicate is the same decision and gets the same gate. */
const impDupUnresolved = (r) => {
  if (!r || r._dup_ok) return false;
  const v = impPropVerdict(r);
  return !!(v && (v.kind === "dup" || v.kind === "batchdup"));
};
/* The cross-client advisory, folded into whatever badge the row already has. Never its own refusal —
   it is a "read this before you commit", which is the only honest thing to say about it. */
function impCrossClientNote(v) {
  if (!v || !v.cross || !v.cross.ids.length) return "";
  const n = v.cross.ids.length;
  const who = v.cross.names.slice(0, 3).join(", ") + (v.cross.names.length > 3 ? ` and ${v.cross.names.length - 3} more` : "");
  return ` Also held by ${n} other client${n === 1 ? "" : "s"} — ${who}. That is legitimate for a sale advised on both sides; check it is not the wrong client on the wrong building.`;
}
function impCrossClientBadge(v) {
  if (!v || !v.cross || !v.cross.ids.length) return "";
  const n = v.cross.ids.length;
  return ` <span class="badge amber" title="${esc(impCrossClientNote(v).trim())}">also held by ${n} other client${n === 1 ? "" : "s"}</span>`;
}
function impPropVerdictHtml(r, i) {
  const v = impPropVerdict(r);
  if (!v) return "";
  const label = propLabel(r.property_address) || propAddress(r.property_address);
  const xNote = impCrossClientNote(v);
  const xBadge = impCrossClientBadge(v);
  const dupBtn = r._dup_ok ? "" : `<button type="button" class="btn btn-sm imp-dup-ok" data-i="${i}" title="Import it anyway — a second case on the same property with the same lender is sometimes right">Import anyway</button>`;
  if (v.kind === "batchdup") {
    /* G6-06 — the collision is with another row in the SAME file, so the fix is to delete a row, not
       to reconcile with the book. Say which row, and gate the tick exactly as a stored duplicate is. */
    return `<div class="imp-prop-verdict"><span class="badge amber" title="${esc(`Row ${v.batchHit.n} of this same file is the same client, the same property (${propAddress(r.property_address)}) and the same lender. Importing both creates two identical cases. Nothing is refused — a product transfer and a remortgage are two real cases — but tick it consciously.` + xNote)}">duplicate of row ${v.batchHit.n} in this file</span> <span class="s">${esc(label)} · ${esc(r.lender || "")}</span>${xBadge}
      ${dupBtn}</div>`;
  }
  if (v.kind === "dup") {
    const hitWhat = [caseTypeLabel(v.hit), v.hit.stage ? (STAGE_LABEL[v.hit.stage] || v.hit.stage) : null].filter(Boolean).join(" · ");
    return `<div class="imp-prop-verdict"><span class="badge amber" title="${esc(`${clientFullName(v.client) || "This client"} already has a case on ${propAddress(r.property_address)} with ${v.hit.lender} (${hitWhat}). Importing this row creates a SECOND case on the same property with the same lender. That can be right — a product transfer and a remortgage are two cases — so nothing is refused; tick it consciously.` + xNote)}">likely duplicate case</span> <span class="s">${esc(label)} · ${esc(r.lender || "")} already on file (${esc(hitWhat)})</span>${xBadge}
      ${dupBtn}</div>`;
  }
  if (v.kind === "same") {
    return `<div class="imp-prop-verdict"><span class="badge grey" title="${esc(`${clientFullName(v.client) || "This client"} already has ${v.others.length} case${v.others.length === 1 ? "" : "s"} on ${propAddress(r.property_address)}, but with a different lender — this imports as another case on that property.` + xNote)}">another case on a property we hold</span> <span class="s">${esc(label)}</span>${xBadge}</div>`;
  }
  if (v.kind === "batchsame") {
    return `<div class="imp-prop-verdict"><span class="badge grey" title="${esc(`Row ${v.batchHit.n} of this same file is the same client on the same property (${propAddress(r.property_address)}) with a different lender — this imports as a second case on that property.` + xNote)}">also on row ${v.batchHit.n} of this file</span> <span class="s">${esc(label)}</span>${xBadge}</div>`;
  }
  if (v.kind === "new") {
    /* R6-FIX OP-01 — "new property" is only honest when it is not a re-typing of one we hold. */
    if (v.near) {
      return `<div class="imp-prop-verdict"><span class="badge amber" title="${esc(`${clientFullName(v.client) || "This client"} already has a case on “${v.near}”. “${propAddress(r.property_address)}” is close enough to be the same building spelled differently — importing it as typed creates a SECOND property with the same short label and nothing matching between them. Adopt the address on file, or leave it if this really is a different building.` + xNote)}">did you mean “${esc(propLabel(v.near) || v.near)}”?</span> <span class="s">${esc(label)} — close to ${esc(v.near)}</span>${xBadge}
        <button type="button" class="btn btn-sm imp-prop-adopt" data-i="${i}" data-addr="${esc(v.near)}" title="Use the address already on file for this client instead of the one in the file">Use the address on file</button></div>`;
    }
    /* R6-FIX RV-06 — still a new property, and still importable as one: the row keeps its green badge and its
       tick. What it gains is a sentence naming the building this client already holds on that same number… */
    if (v.fork) {
      return `<div class="imp-prop-verdict"><span class="badge ${v.cross.ids.length ? "amber" : "green"}" title="${esc(`No case on ${propAddress(r.property_address)} exists for ${clientFullName(v.client) || "this client"} — this imports as a new property.` + xNote)}">new property</span> <span class="s">${esc(label)}</span>${xBadge}
        <div class="imp-prop-hint s cs-muted">ℹ ${esc(propLocForkHint(v.fork, "correct the address in the file before importing"))}</div></div>`;
    }
    return `<div class="imp-prop-verdict"><span class="badge ${v.cross.ids.length ? "amber" : "green"}" title="${esc(`No case on ${propAddress(r.property_address)} exists for ${clientFullName(v.client) || "this client"} — this imports as a new property.` + xNote)}">new property</span> <span class="s">${esc(label)}</span>${xBadge}</div>`;
  }
  /* A row that creates its own client: there is no case of THEIRS to compare it against, but the firm's other
     clients are still a comparison (G6B-01)… */
  return `<div class="imp-prop-verdict">${v.batchHit ? `<span class="badge grey" title="${esc(`Row ${v.batchHit.n} of this same file is the same person on the same property, with a different lender — both rows import.` + xNote)}">also on row ${v.batchHit.n} of this file</span> ` : ""}<span class="s">${esc(label)}</span>${xBadge}</div>`;
}

/* R83: THE PREVIEW STOPS RE-DERIVING EVERY ROW SIX TIMES. One render called impResolveMatch/impPropVerdict ~6 times
   per row (impRowFlagged, the match cell, the verdict, the conflict expander twice), each a full findClientMatches
   pass over the whole client book (1,161 rows) plus three propSameBuilding sweeps over every case (2,015): a
   400-row file was ~7M client comparisons on the main thread. … */
let impMemoGen = 0;
function impMemoBump() { impMemoGen++; }
let impClientIndex = null;   // { src: importClients, byEmail, byPhone, byKey, byLast }
function impClientCandidates(r) {
  if (!impClientIndex || impClientIndex.src !== importClients) {
    const ix = { src: importClients, byEmail: new Map(), byPhone: new Map(), byKey: new Map(), byLast: new Map(), pos: new Map() };
    const add = (m, k, c) => { if (!k) return; const l = m.get(k); if (l) l.push(c); else m.set(k, [c]); };
    (importClients || []).forEach((c, i) => {
      ix.pos.set(c, i);   // R83 — candidates are returned in BOOK order so findClientMatches's [0] picks match the full scan
      add(ix.byEmail, (c.email || "").trim().toLowerCase(), c);
      add(ix.byPhone, normPhone(c.phone), c);
      add(ix.byKey, clientNameKey(clientFullName(c)), c);
      add(ix.byLast, (c.last_name || "").trim().toLowerCase(), c);
    });
    impClientIndex = ix;
  }
  const ix = impClientIndex;
  const name = String(r.client_name || "").trim();
  const parts = name ? splitName(name) : { first_name: "", last_name: "" };
  const out = new Set();
  [ix.byEmail.get((r.email || "").trim().toLowerCase()), ix.byPhone.get(normPhone(r.phone)),
    ix.byKey.get(clientNameKey(name)), ix.byLast.get(String(parts.last_name || "").trim().toLowerCase())]
    .forEach((l) => (l || []).forEach((c) => out.add(c)));
  return [...out].sort((a, b) => ix.pos.get(a) - ix.pos.get(b));   // R83
}
function impMemo(r) {
  if (!r._memo || r._memo.gen !== impMemoGen) r._memo = { gen: impMemoGen };
  return r._memo;
}
// The row's resolved decision: an explicit operator choice first, then the matcher's exact hit.
function impResolveMatch(r) {
  const memo = impMemo(r);   // R83
  if (memo.match) return memo.match;
  const m = findClientMatches({ name: r.client_name, email: r.email, phone: r.phone }, impClientCandidates(r));   // R83
  const out = (() => {
    if (r._force_new) return { mode: "new", forced: true, near: m.near, exact: m.exact };
    if (r._match_client_id) {
      const chosen = importClients.find((c) => c.id === r._match_client_id);
      if (chosen) return { mode: "attach", client: chosen, chosen: true, reason: "you chose this client", near: m.near };
      // The chosen client is gone (merged/deleted since the preview was drawn) — fall through.
    }
    if (m.exact) return { mode: "attach", client: m.exact, reason: m.reason, near: m.near };
    if (m.near.length) return { mode: "undecided", near: m.near };
    return { mode: "new", near: [] };
  })();
  memo.match = out;   // R83
  return out;
}
// Which incoming contact details disagree with what the client record already holds.
function impConflicts(r, client) {
  const out = [];
  [["email", "Email"], ["phone", "Phone"]].forEach(([f, label]) => {
    const incoming = String(r[f] == null ? "" : r[f]).trim();
    const current = String(client[f] == null ? "" : client[f]).trim();
    if (!incoming || !current) return;                       // nothing to choose between
    const same = f === "phone" ? normPhone(current) === normPhone(incoming) : current.toLowerCase() === incoming.toLowerCase();
    if (!same) out.push({ field: f, label, current, incoming });
  });
  return out;
}
function impMatchCellHtml(r, i) {
  /* R75 · B1: the junk row's verdict comes FIRST and on its own: there is no client to match it to, so the
     match cell would otherwise be blank and the row would read as "creates a new client"… */
  const pc = impPersonCheck(r);
  if (!pc.ok) {
    return `<div class="imp-noperson"><span class="badge red" title="${esc("Nothing is refused — but this row starts unticked because " + pc.reason + ". Fill the Client cell in (or leave the row unticked) before importing.")}">no person in this row</span>
      <span class="s">${esc(pc.reason)}</span></div>`;
  }
  return impMatchCellPersonHtml(r, i) + impPropVerdictHtml(r, i);
}
function impMatchCellPersonHtml(r, i) {
  const d = impResolveMatch(r);
  if (d.mode === "attach") {
    const who = clientFullName(d.client) || d.client.email || d.client.phone || "this client";
    const badge = d.chosen ? "blue" : "green";
    return `<span class="badge ${badge}" title="${esc("Matched on " + (d.reason || "an existing record") + " — this row updates that client instead of creating a second one.")}">→ attaches to ${esc(who)}</span>
      <button type="button" class="btn btn-sm imp-match-new" data-i="${i}" title="Not the same person — create a new client record for this row">New client</button>`;
  }
  if (d.mode === "undecided") {
    const opts = d.near.map((n) => `<option value="${esc(n.client.id)}">${esc(clientFullName(n.client) || n.client.email || "(no name)")}${n.client.email ? " — " + esc(n.client.email) : ""} · ${esc(n.reason)}</option>`).join("");
    return `<span class="badge amber" title="${esc("Possible existing client (" + d.near[0].reason + "). Nothing is attached until you choose.")}">possible: ${esc(clientFullName(d.near[0].client) || d.near[0].client.email || "")}</span>
      ${d.near.length > 1 ? `<select class="imp-match-pick" data-i="${i}" title="Which existing client">${opts}</select>` : ""}
      <button type="button" class="btn btn-sm imp-match-attach" data-i="${i}" title="Attach this row's case to that existing client">Attach</button>
      <button type="button" class="btn btn-sm imp-match-new" data-i="${i}" title="Different person — create a new client record">New client</button>`;
  }
  if (d.forced || (d.near && d.near.length)) {
    return `<span class="s">new client</span>
      <button type="button" class="btn btn-sm imp-match-undo" data-i="${i}" title="Undo — look at the possible matches again">undo</button>`;
  }
  return "";
}
// The inline expander: one radio pair per disagreeing field, existing pre-selected.
function impConflictRowHtml(r, i) {
  const d = impResolveMatch(r);
  if (d.mode !== "attach") return "";
  const conflicts = impConflicts(r, d.client);
  if (!conflicts.length) return "";
  const picks = r._conflict_choice || {};
  const who = clientFullName(d.client) || "this client";
  const rows = conflicts.map((c) => {
    const keepIncoming = picks[c.field] === "incoming";
    return `<tr>
      <td>${esc(c.label)}</td>
      <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" class="imp-conf-radio u-w-auto u-mt-3" name="imp-conf-${i}-${c.field}" data-i="${i}" data-field="${esc(c.field)}" value="existing" ${keepIncoming ? "" : "checked"}> ${mergeFieldDisplay(c.field, c.current)} <span class="s">on record</span></label></td>
      <td><label class="row-check" style="display:flex;gap:6px;align-items:flex-start;font-weight:400;"><input type="radio" class="imp-conf-radio u-w-auto u-mt-3" name="imp-conf-${i}-${c.field}" data-i="${i}" data-field="${esc(c.field)}" value="incoming" ${keepIncoming ? "checked" : ""}> ${mergeFieldDisplay(c.field, c.incoming)} <span class="s">in this file</span></label></td>
    </tr>`;
  }).join("");
  return `<details class="imp-conflict" open>
      <summary>⚠ ${conflicts.length} detail${conflicts.length === 1 ? "" : "s"} disagree${conflicts.length === 1 ? "s" : ""} with ${esc(who)}'s record — choose which to keep</summary>
      <table class="imp-table merge-table">
        <tr><th>Field</th><th>Keep what's on record</th><th>Use what's in this file</th></tr>
        ${rows}
      </table>
      <p class="s">Whatever you don't keep is discarded — it's named in the summary after the import so nothing disappears quietly.</p>
    </details>`;
}
// Repaint just this row's match cell and its expander (a full re-render would throw away the
// operator's ticks), then leave the delegated handlers to pick the new controls up.
function impRepaintMatch(i) {
  const r = importRows[i];
  if (!r) return;
  const cell = document.querySelector(`.imp-match[data-i="${i}"]`);
  if (cell) cell.innerHTML = impMatchCellHtml(r, i);
  const conf = document.querySelector(`.imp-conf-cell[data-i="${i}"]`);
  if (conf) {
    const html = impConflictRowHtml(r, i);
    conf.innerHTML = html;
    const tr = conf.closest("tr");
    if (tr) tr.classList.toggle("hidden", !html);
  }
}

function renderImportPreview() {
  if (!importRows.length) { $("#import-preview").innerHTML = ""; return; }
  const nCols = 13;
  /* R33 · K3: THE RULES PARAGRAPH. Four hundred words of load-bearing rules reprinted on every Analyse; weekly
       importers scrolled past it every time. Read once, folded thereafter — and only because the operator SAID so
       by pressing "Got it", never on a guess. Reopening it is one click and does NOT clear the flag: wanting to
       re-read the rules is not wanting them shouted at you again next week. */
  const blurbSeen = lsGet("nx_import_blurb") === "seen";
  /* R75 · B1 — which way the assign checkbox starts, and the sentence saying why.
     Same rule and same argument as R72's new-case form (newCaseSelfAssigns). */
  const assignMeOn = importAssignToMeOn();
  const assignMeWhy = newCaseSelfAssigns()
    ? "You are an adviser, so this starts ticked: an import of your own book should land on you. Untick it to leave the cases unassigned."
    : "This starts UNTICKED for administrators and the owner: an import is usually the firm's book being brought in on somebody else's behalf, and quietly assigning every case to whoever ran the import is how a whole back book ends up on one person's list. Tick it if these really are your cases.";
  $("#import-preview").innerHTML = `
    <div class="panel">
      <h3>Review before saving</h3>
      
      <p class="panel-sub" id="imp-review-lede">Untick anything that shouldn't be imported. Click Client, Email, <strong>Property</strong>, Stage, Lender or Rate to fix a misread field before importing — <strong>nothing is saved until you press Import selected</strong>.</p>
      <button type="button" class="btn btn-sm u-m-0-0-8" id="imp-blurb-toggle" aria-expanded="${blurbSeen ? "false" : "true"}" aria-controls="imp-review-blurb">${blurbSeen ? "Review rules ▸" : "Got it — collapse"}</button>
      <p class="panel-sub${blurbSeen ? " hidden" : ""}" id="imp-review-blurb">Estimated rate-end dates are marked <span class="badge ${EST_BADGE_CLS}" title="${TIP_APPROX}">≈</span> and stay flagged until you confirm them. Dates are read UK-first (dd/mm/yyyy) — anything that could also be read the American way is shown amber with the reading we'll use, and its row starts unticked until you press Confirm. A case marked Completed with no completion date is shown <span class="badge amber" title="The source marks the case completed but gives no completion date. No date is ever invented: where the source itself said the case was completed, the row starts unticked until you press “Import with no date” or change its Stage.">no date</span>: no date is ever invented for it, so where the source itself said the case was completed the row starts unticked until you either press “Import with no date” or change its Stage. Any case that does import without a completion date is counted in the message at the end and listed on Data health. A row with <span class="badge red" title="No name, and no email or phone either — the trailing “TOTAL” line every report tool leaves behind. It starts unticked; type a name into its Client cell and it re-ticks itself. This is the same check the Revolution sync has always applied.">no person in this row</span> starts unticked — the same check the Revolution sync applies. The <strong>Match</strong> column says who each row will land on before anything is written: <span class="badge green" title="An exact match on email, phone, or a name with nothing contradicting it — this row updates that client instead of creating a second one.">→ attaches to</span> a client we already hold, <span class="badge amber" title="A possible existing client. Nothing is attached until you press Attach or New client.">possible</span> needs your Attach / New client decision, and a blank cell creates a new client. Where an attaching row's email or phone disagrees with the record, the row expands so you choose which to keep — what you don't keep is named in the summary afterwards. A <strong>Property address</strong> column in the file (Property, Property address, Security address, Address, with an optional separate Postcode) is read onto the case, and the Match column then also says what the row means for that client: <span class="badge green" title="No case on this address exists for this client — it imports as a new property.">new property</span>, <span class="badge grey" title="This client already has a case on this property, but with a different lender — it imports as another case on that property.">another case on a property we hold</span>, or <span class="badge amber" title="Same client, same property and the same lender. That can be right — a product transfer and a remortgage are two cases — so nothing is refused; the row starts unticked until you press “Import anyway”.">likely duplicate case</span> — same client, same property and the same lender, which starts unticked until you press “Import anyway”.</p>
      <label style="display:flex;gap:6px;align-items:center;font-weight:400;margin:4px 0 10px;" title="${esc(assignMeWhy)}">
        <input type="checkbox" id="imp-assign-me" class="u-w-auto" ${assignMeOn ? "checked" : ""}>
        Assign new cases to me — unticking leaves them unassigned (they'll appear in Data Health's unassigned list)
      </label>
      <p class="panel-sub" id="imp-assign-why">${esc(assignMeWhy)}</p>
      
      <p class="panel-sub" id="imp-scroll-hint">This table scrolls sideways — the tick box and the <strong>Client</strong> column stay put while the rest moves, so you can always see whose row you are reading.</p>
      <div class="board-scroll-wrap board-scroll-wrap--table">
      <div id="imp-scroll" class="u-ox-auto">
      <table class="imp-table has-bulk imp-review-table" id="imp-review-table">
        <tr><th class="bulk-col"><input type="checkbox" id="imp-all" checked aria-label="Tick or untick every row"></th><th class="stick-col">Client</th><th>Email</th><th>Phone</th><th>Property</th><th>Match</th><th>Stage</th><th>Lender</th><th>Rate</th><th>Rate ends</th><th>ERC ends</th><th>Completed</th><th>Fee</th></tr>
        ${importRows.map((r, i) => `
        <tr>
          <td class="bulk-col"><input type="checkbox" class="imp-row" data-i="${i}" ${impRowFlagged(r) ? "" : "checked"}></td>
          <td class="imp-edit stick-col" contenteditable="true" spellcheck="false" data-i="${i}" data-field="client_name" title="Click to edit">${esc(r.client_name || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="email" title="Click to edit">${esc(r.email || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="phone" title="Click to edit">${esc(r.phone || "")}</td>
          
          <td class="imp-edit imp-prop-cell" contenteditable="true" spellcheck="false" data-i="${i}" data-field="property_address" title="The property this case is secured on — click to edit">${esc(r.property_address || "")}</td>
          <td class="imp-match" data-i="${i}">${impMatchCellHtml(r, i)}</td>
          <td><select class="imp-edit-stage" data-i="${i}" title="Click to edit">
            <option value="" ${!r.stage ? "selected" : ""}>contact only</option>
            ${STAGES.map(([k, l]) => `<option value="${k}" ${k === r.stage ? "selected" : ""}>${l}</option>`).join("")}
          </select></td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="lender" title="Click to edit">${esc(r.lender || "")}</td>
          <td class="imp-edit" contenteditable="true" spellcheck="false" data-i="${i}" data-field="rate_percent" title="Click to edit">${r.rate_percent != null ? esc(r.rate_percent) : ""}</td>
          ${impDateCell(r, i, "rate_end_date", r.rate_end_estimated ? ` <span class="badge ${EST_BADGE_CLS}" title="${TIP_APPROX}">≈</span>` : "")}
          ${impDateCell(r, i, "erc_end_date")}
          ${impDateCell(r, i, "completed_date")}
          <td class="num">${r.broker_fee ? fmtM(r.broker_fee) : ""}</td>
        </tr>
        <tr class="imp-conf-tr${impConflictRowHtml(r, i) ? "" : " hidden"}"><td class="imp-conf-cell" colspan="${nCols}" data-i="${i}">${impConflictRowHtml(r, i)}</td></tr>`).join("")}
      </table>
      </div>
      <button type="button" class="board-scroll-arrow" aria-label="Scroll right" title="Scroll right">›</button>
      </div>
      <div class="u-mt-14">
        <button class="btn btn-primary" id="import-save-btn">Import selected</button>
      </div>
    </div>`;
  wireTableHScroll("imp-scroll");
  $("#imp-all").onchange = (e) => document.querySelectorAll(".imp-row").forEach((c) => (c.checked = e.target.checked));
  $("#imp-assign-me").onchange = (e) => { importAssignToMe = e.target.checked; };
  $("#import-save-btn").onclick = runImport;
  /* R33 · K3 — fold/unfold the rules paragraph. The first fold is what records the preference;
     re-opening it afterwards is a session act and deliberately leaves nx_import_blurb alone. */
  const blurbBtn = $("#imp-blurb-toggle");
  if (blurbBtn) blurbBtn.onclick = () => {
    const p = $("#imp-review-blurb");
    if (!p) return;
    const nowOpen = p.classList.contains("hidden");
    p.classList.toggle("hidden", !nowOpen);
    blurbBtn.textContent = nowOpen ? "Got it — collapse" : "Review rules ▸";
    blurbBtn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
    if (!nowOpen) lsSet("nx_import_blurb", "seen");
  };

  /* R5-23a/b — match + conflict controls are wired by delegation on the preview container, because a row's
     match cell and its expander are repainted in place whenever the row's identity fields change and a… */
  const prev = $("#import-preview");
  prev.addEventListener("click", (e) => {
    const btn = e.target.closest(".imp-match-attach, .imp-match-new, .imp-match-undo, .imp-dup-ok, .imp-prop-adopt");
    if (!btn) return;
    const i = Number(btn.dataset.i), r = importRows[i];
    if (!r) return;
    impMemoBump();   // R83 — every branch below changes an answer on this row (and so on later rows)
    /* R6-FIX OP-01 — adopt the spelling already on file. It rewrites the row's property cell, so the verdict
       re-derives to "another case on a property we hold" — or to a duplicate flag if the lender matches too. */
    if (btn.classList.contains("imp-prop-adopt")) {
      r.property_address = btn.dataset.addr || r.property_address;
      const cell = document.querySelector(`.imp-prop-cell[data-i="${i}"][data-field="property_address"]`);
      if (cell) cell.textContent = r.property_address;
      impRepaintMatch(i);
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb) cb.checked = !impRowFlagged(r);
      return;
    }
    /* R6-34: accepting a likely-duplicate case records the decision on the row and re-ticks it; it writes
       nothing else, so the row imports exactly as it reads. */
    if (btn.classList.contains("imp-dup-ok")) {
      r._dup_ok = true;
      impRepaintMatch(i);
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && !impRowFlagged(r)) cb.checked = true;
      return;
    }
    const wasFlagged = impRowFlagged(r);
    if (btn.classList.contains("imp-match-attach")) {
      const sel = document.querySelector(`.imp-match-pick[data-i="${i}"]`);
      const d = impResolveMatch(r);
      const id = (sel && sel.value) || (d.near[0] && d.near[0].client.id);
      if (!id) return;
      r._match_client_id = id; r._force_new = false;
    } else if (btn.classList.contains("imp-match-new")) {
      r._force_new = true; r._match_client_id = null; r._conflict_choice = null;
    } else {
      r._force_new = false; r._match_client_id = null;
    }
    /* R6-34 — the person decision decides which cases the property verdict compares against
       ("New client" means there are none), so the duplicate flag can appear or vanish with it. */
    impMemoBump();   // R83 — the decision fields were just written; the answer read above is stale
    impRepaintMatch(i);
    const nowFlagged = impRowFlagged(r);
    const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
    if (cb && wasFlagged !== nowFlagged) cb.checked = !nowFlagged;
  });
  prev.addEventListener("change", (e) => {
    const radio = e.target.closest(".imp-conf-radio");
    if (!radio) return;
    const i = Number(radio.dataset.i), r = importRows[i];
    if (!r) return;
    r._conflict_choice = r._conflict_choice || {};
    r._conflict_choice[radio.dataset.field] = radio.value;
  });

  // Editable preview cells write straight back into importRows[i], so a corrected value (one misread field)
  // feeds the existing import/insert path unchanged…
  document.querySelectorAll(".imp-edit").forEach((td) => {
    const commit = () => {
      const i = Number(td.dataset.i), field = td.dataset.field;
      if (!importRows[i]) return; // late blur after the preview was cleared post-import
      /* R75 · B1: the row's flagged state BEFORE the edit lands. It used to be read after the write, which
         made the was/now comparison below compare a value with itself and meant an edit could never re-tick… */
      const wasFlagged0 = impRowFlagged(importRows[i]);
      let val = td.textContent.trim();
      impMemoBump();   // R83 — the write below changes what this row (and rows after it) mean
      if (field === "rate_percent") {
        val = val.replace("%", "").trim();
        importRows[i][field] = val === "" ? null : Number(val);
      } else {
        importRows[i][field] = val || (field === "client_name" ? "" : null);
      }
      /* R5-23a — the identity fields decide who this row lands on, so correcting one re-runs the match. Any
         earlier Attach/New-client choice was made about a DIFFERENT set of details and is dropped rather… */
      if (field === "client_name" || field === "email" || field === "phone") {
        /* R75 · B1: these are also the three fields the person check reads, so filling the missing one in is
           the way back off the "no person in this row" flag. */
        importRows[i]._match_client_id = null;
        importRows[i]._force_new = false;
        importRows[i]._conflict_choice = null;
        impRepaintMatch(i);
        const nowId = impRowFlagged(importRows[i]);
        const cbId = document.querySelector(`.imp-row[data-i="${i}"]`);
        if (cbId && wasFlagged0 !== nowId) cbId.checked = !nowId;
      }
      /* R6-34: correcting the property (or the lender) changes what the row MEANS for that client: a typo'd
         address reads as a sixth property when it is really a duplicate of the fifth. */
      if (field === "property_address" || field === "lender") {
        // R75 · B1 — wasFlagged0 is read at the TOP of commit(), before the write.
        importRows[i]._dup_ok = false;
        impRepaintMatch(i);
        const now = impRowFlagged(importRows[i]);
        const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
        if (cb && wasFlagged0 !== now) cb.checked = !now;
      }
    };
    td.addEventListener("blur", commit);
    td.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); td.blur(); } });
  });
  /* T1-finalfix (finding 1): the Stage select is the row's OTHER way out of the "completed with no completion
     date" flag: moving a row off "Completed & closed" means there is nothing left to be missing. */
  document.querySelectorAll(".imp-edit-stage").forEach((sel) => {
    sel.onchange = () => {
      const i = Number(sel.dataset.i), r = importRows[i];
      if (!r) return;
      /* R6-34 — impRowFlagged, not impDateFlags: a row can also be held by an unaccepted
         likely-duplicate flag, and changing the stage must never tick that row for the operator. */
      const was = impRowFlagged(r);
      r.stage = sel.value || null;
      const now = impRowFlagged(r);
      const cell = sel.closest("tr")?.querySelector('td[data-cell="completed_date"]');
      if (cell) { cell.outerHTML = impDateCell(r, i, "completed_date"); wireImportRowButtons(); }
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && was !== now) cb.checked = !now;
    };
  });
  wireImportRowButtons();
}

/* Per-row "this needs a human" buttons. Re-run after any cell is repainted in place, because replacing a <td>
   throws away its listeners. Both buttons resolve ONE flag on ONE row and then re-tick that row only if… */
function wireImportRowButtons() {
  /* T1-21: confirming an ambiguous date writes the ISO reading back into the row and re-ticks the row once
     nothing on it is still flagged. Only this row's cells are rewritten… */
  document.querySelectorAll(".imp-date-ok").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i), field = btn.dataset.field;
      if (!importRows[i]) return;
      importRows[i][field] = btn.dataset.iso;
      const td = btn.closest("td");
      if (td) {
        td.className = ""; td.removeAttribute("title");
        td.innerHTML = esc(fmtD(btn.dataset.iso)) + (field === "rate_end_date" && importRows[i].rate_end_estimated ? ` <span class="badge ${EST_BADGE_CLS}" title="${TIP_APPROX}">≈</span>` : "");
      }
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && !impRowFlagged(importRows[i])) cb.checked = true;   // R6-34: any open flag still holds the row
    };
  });
  /* T1-finalfix (finding 1): accept a completed case that genuinely has no completion date. This records the
     operator's decision on the row only; NOTHING is written into completed_date… */
  document.querySelectorAll(".imp-nodate-ok").forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i), r = importRows[i];
      if (!r) return;
      r._no_date_ok = true;
      const td = btn.closest("td");
      if (td) td.outerHTML = impDateCell(r, i, "completed_date");
      const cb = document.querySelector(`.imp-row[data-i="${i}"]`);
      if (cb && !impRowFlagged(r)) cb.checked = true;   // R6-34: any open flag still holds the row
      wireImportRowButtons();
    };
  });
}

async function runImport() {
  const selectedEls = [...document.querySelectorAll(".imp-row:checked")];
  const selected = selectedEls.map((c) => importRows[Number(c.dataset.i)]);
  if (!selected.length) return toast("Nothing selected");
  $("#import-save-btn").disabled = true;
  $("#import-status").textContent = "Saving…";
  /* R5-23a — re-read the clients table so the decision that gets written is made against the database as it
     is NOW, not as it was when Analyse ran… */
  importClients = await fetchMatchClients();
  /* R6-33/34 — the same discipline for the property side: re-read the cases the verdicts were made
     against. */
  importCases = await fetchMatchCases(importClients, { fresh: true });   // R85 · D6 — gates the inserts below: live read
  impMemoBump();   // R83 — the decisions are re-made against the database as it is NOW
  let nPropSaved = 0;
  /* G6-06: "2 PROPERTY ADDRESSES" for one address, because this counted ROWS. Two identical rows on one
     building are two cases and ONE property; the headline has to be able to tell the operator that… */
  const propKeysSaved = new Set();
  let nPropUnkeyed = 0;
  const nameKey = clientNameKey;
  /* The save-time index is no longer the matcher — it now only dedupes rows against clients CREATED EARLIER
     IN THIS SAME RUN, so one file listing the same brand-new client twice still produces one record. */
  const byName = {}, byEmail = {};
  let nClients = 0, nCases = 0, nUpdated = 0;
  // R5-23a/b reporting: what landed on an existing record, and what the operator chose not to keep.
  const attachedTo = new Map();     // client id -> name, for "N attached to existing"
  let nConflicts = 0;
  const conflictLog = [];           // {client, label, kept, discarded}
  const undecided = [];             // possible matches nobody resolved — they became new clients
  // T1-finalfix (finding 1) — counted from what was actually WRITTEN, not from what the preview
  // predicted, so the closing message can state the true end position.
  let nNoDate = 0;
  // G1I-I6 — cases that landed with no "AI bulk import" provenance note (that insert failing is not
  // worth failing the row over, but it must not be invisible either).
  let nNoProvenance = 0;
  const rowErrors = [];
  const touchedClients = new Map(); // id -> name, for the post-import "view what landed" summary (defect 30)

  for (let i = 0; i < selected.length; i++) {
    const r = selected[i];
    // G1I-I4 — staged until the row's writes have all succeeded (see where they are committed).
    const pendingConflicts = [];
    let pendingAttach = null;
    try {
      const nk = nameKey(r.client_name);
      const email = (r.email || "").trim().toLowerCase();
      if (!nk && !email) continue;
      /* T1-21: normalise every date on the row to YYYY-MM-DD BEFORE anything is written, so a "01/02/2026"
         can never reach the cases table as a raw string. */
      const dates = {};
      for (let d = 0; d < IMPORT_DATE_FIELDS.length; d++) {
        const f = IMPORT_DATE_FIELDS[d][0];
        const p = parseUkDate(r[f]);
        if (!p.ok) throw new Error(`Couldn't read ${IMPORT_DATE_FIELDS[d][1].toLowerCase()} date “${p.raw}” (${p.note}) — fix it in the preview, then import again`);
        dates[f] = p.iso;
      }
      /* R5-23a — the row's own decision, exactly as the preview showed it. An undecided possible-match
         creates a new client and is named in the result panel… */
      const decision = impResolveMatch(r);
      if (decision.mode === "undecided") {
        undecided.push({ row: r.client_name || email || "(no name)", candidate: clientFullName(decision.near[0].client) || decision.near[0].client.email || "an existing client" });
      }
      let client = decision.mode === "attach" ? decision.client : null;
      let attached = !!client;
      if (!client && !r._force_new) client = (email && byEmail[email]) || byName[nk] || null;  // same-run duplicate row
      if (!client) {
        // T1-22 — the shared splitter, so an imported client files exactly like an accepted lead.
        const nm = splitName(r.client_name);
        const { data, error } = await db.from("clients")
          .insert({ first_name: nm.first_name, last_name: nm.last_name, email: r.email || null, phone: r.phone || null })
          .select().single();
        if (error) throw error;
        client = data; nClients++;
        invalidateClientPicker(); // R18-P6 — bulk-imported clients must appear in the case-modal picker
        if (nk) byName[nk] = client;
        if (email) byEmail[email] = client;
        // Deliberately NOT added to importClients: a client created by this run belongs to the same-run index
        // above…
      } else {
        /* R5-23b — an attaching row used to write ONLY into blank stored fields; anything that disagreed was
           dropped without a word. Blank fields still fill silently (nothing is lost)… */
        const picks = r._conflict_choice || {};
        const patch = {};
        if (r.email && !client.email) patch.email = r.email;
        if (r.phone && !client.phone) patch.phone = r.phone;
        if (attached) {
          /* G1I-I4 — these counters used to be incremented HERE, before the update that actually writes the
             operator's choice. When that update threw, the row landed in rowErrors but the headline had… */
          impConflicts(r, client).forEach((c) => {
            const keepIncoming = picks[c.field] === "incoming";
            if (keepIncoming) patch[c.field] = c.incoming;
            pendingConflicts.push({
              client: clientFullName(client) || client.email || "(no name)",
              label: c.label,
              kept: keepIncoming ? c.incoming : c.current,
              discarded: keepIncoming ? c.current : c.incoming,
            });
          });
          pendingAttach = clientFullName(client) || client.email || client.phone || "(no name)";
        }
        if (Object.keys(patch).length) {
          const { error: upErr } = await db.from("clients").update(patch).eq("id", client.id);
          if (upErr) throw upErr;
          Object.assign(client, patch);
          impMemoBump();   // R83 — a client row in importClients just changed
          CLIENT_MATCH_MEMO.delete(client); impClientIndex = null;   // R83 — the row's match fields and its index buckets are stale too
          if (client.email) byEmail[client.email.trim().toLowerCase()] = client;
          nUpdated++;
        }
      }

      /* R6-33: a property address on the row is part of the CASE, so a row that carries nothing but a client
         and an address still creates one… */
      const hasCase = r.stage || r.lender || r.rate_end_date || r.completed_date || r.rate_percent != null
        || propAddress(r.property_address);
      if (hasCase) {
        const caseRow = {
          client_id: client.id,
          case_kind: r.case_kind || "other",
          stage: r.stage || "enquiry",
          lender: r.lender || null,
          product_name: r.product_name || null,
          rate_percent: r.rate_percent ?? null,
          rate_type: r.rate_type || null,
          rate_end_date: dates.rate_end_date,
          rate_end_estimated: !!r.rate_end_estimated,
          erc_end_date: dates.erc_end_date,
          loan_amount: r.loan_amount ?? null,
          property_value: r.property_value ?? null,
          broker_fee: r.broker_fee ?? null,
          completed_at: dates.completed_date ? new Date(dates.completed_date).toISOString() : null,
          assigned_to: importAssignToMeOn() ? ((ME && ME.id) || null) : null,   // R75 · B1 — the role rule until the box is touched
        };
        if (propAddress(r.property_address)) caseRow.property_address = propAddress(r.property_address);
        const { data: nc, error } = await db.from("cases").insert(caseRow).select("id").single();
        if (error) throw error;
        if (caseRow.property_address) {
          const pk = propKey(caseRow.property_address);
          if (pk) propKeysSaved.add(pk); else nPropUnkeyed++;   // stored, but not a property identity
          nPropSaved = propKeysSaved.size + nPropUnkeyed;       // distinct buildings, not rows
        }
        /* G1I-I6 — this note is the only record that a case arrived by bulk import rather than being keyed by
           a person, and it also carries the row's free-text `note` column, which is otherwise discarded. */
        const { error: noteErr } = await db.from("case_notes").insert({ case_id: nc.id, body: "AI bulk import" + (r.note ? " | " + r.note : "") });
        if (noteErr) nNoProvenance++;
        nCases++;
        if ((r.stage || "enquiry") === "completed" && !dates.completed_date) nNoDate++;
      }
      // G1I-I4 — the row is through: only now is the conflict counted as resolved and the client counted as
      // attached. A throw above leaves both untouched, so the headline can no longer claim a write that…
      nConflicts += pendingConflicts.length;
      pendingConflicts.forEach((c) => conflictLog.push(c));
      if (pendingAttach) attachedTo.set(client.id, pendingAttach);
      touchedClients.set(client.id, [client.first_name, client.last_name].filter(Boolean).join(" ") || client.email || client.phone || "(no name)");
      // Row succeeded — uncheck it so a retry after a partial failure doesn't
      // re-import this row and create duplicate cases.
      if (selectedEls[i]) selectedEls[i].checked = false;
    } catch (e) {
      rowErrors.push({ row: i + 1, name: r.client_name || "(no name)", error: e.message || String(e) });
      console.error(e);
    }
  }
  $("#import-status").textContent = "";
  $("#import-save-btn").disabled = false;
  const errs = rowErrors.length;
  /* T1-finalfix (finding 1): the old message stopped at the three counts, so N completed cases could land
     with completed_at empty under a toast that read like a clean success. Name it. */
  const noDateMsg = nNoDate
    ? ` — ${nNoDate} completed case${nNoDate === 1 ? "" : "s"} imported with NO completion date (listed on Data health as “Completed, no completion date” until ${nNoDate === 1 ? "it is" : "they are"} filled in)`
    : "";
  /* R5-23a/b — the headline now states the thing the old one hid: how many rows landed on people we
     already had, and how many contact details had to be chosen between. */
  const nAttached = attachedTo.size;
  const matchMsg = `${nAttached} attached to existing · ${nClients} new${nConflicts ? ` · ${nConflicts} field conflict${nConflicts === 1 ? "" : "s"} resolved` : ""}`;
  // G1I-I6 — the provenance note is the only record that a case arrived by bulk import, and it carries the
  // row's free-text note. Losing it silently made an imported case indistinguishable from a hand-keyed one.
  const noProvMsg = nNoProvenance
    ? ` — ${nNoProvenance} case${nNoProvenance === 1 ? "" : "s"} imported with NO “AI bulk import” note (${nNoProvenance === 1 ? "its" : "their"} import note and any free-text note on the row were not saved)`
    : "";
  /* R6-33 — the address is the thing this file was imported FOR, so the count of addresses that
     landed is stated. */
  const propMsg = nPropSaved ? ` · ${nPropSaved} property address${nPropSaved === 1 ? "" : "es"} saved` : "";
  toast(`Imported: ${matchMsg}, ${nCases} cases, ${nUpdated} contact updates${errs ? `, ${errs} failed` : ""}${propMsg}${noDateMsg}${noProvMsg}`);
  if (errs) {
    // Surface exactly which rows failed and why, so nothing is silently dropped.
    const errHtml = `<div class="panel"><h3>${errs} row${errs === 1 ? "" : "s"} could not be imported</h3>
      <table class="imp-table"><tr><th>Row</th><th>Name</th><th>Error</th></tr>
      ${rowErrors.map((e) => `<tr><td>${e.row}</td><td>${esc(e.name)}</td><td>${esc(e.error)}</td></tr>`).join("")}
      </table></div>`;
    $("#import-preview").insertAdjacentHTML("beforeend", errHtml);
  } else {
    importRows = []; impMemoBump(); $("#import-text").value = "";   // R83
    // Defect 30: don't just clear the preview to blank — leave a compact, clickable summary so
    // verification doesn't require a search (which may itself be broken for multi-word names).
    const names = [...touchedClients.entries()];
    $("#import-preview").innerHTML = names.length ? `
      <div class="panel">
        <h3>Imported: ${matchMsg} / ${nCases} case${nCases === 1 ? "" : "s"}${nPropSaved ? ` / ${nPropSaved} property address${nPropSaved === 1 ? "" : "es"}` : ""}</h3>
        ${nNoDate ? `<p class="panel-sub u-red">⚠ ${nNoDate} of ${nCases === 1 ? "them" : `those ${nCases} cases`} imported as <strong>completed with no completion date</strong> — no date was invented. They are missing from completions reporting and are listed on Data health as “Completed, no completion date” until someone fills ${nNoDate === 1 ? "it" : "them"} in.</p>` : ""}
        ${conflictLog.length ? `<div class="dq-notice" id="import-conflicts"><strong>${conflictLog.length} contact detail${conflictLog.length === 1 ? "" : "s"} had to be chosen between:</strong>
          <ul style="margin:6px 0 0 18px;">${conflictLog.map((c) => `<li>${esc(c.client)} — ${esc(c.label.toLowerCase())} kept as <strong>${esc(c.kept)}</strong>; <span title="This value was in the file and was NOT saved.">discarded ${esc(c.discarded)}</span></li>`).join("")}</ul></div>` : ""}
        ${undecided.length ? `<div class="dq-notice bad" id="import-undecided"><strong>${undecided.length} row${undecided.length === 1 ? "" : "s"} created a NEW client despite a possible match</strong> — nobody chose Attach or New client, so nothing was attached on a guess:
          <ul style="margin:6px 0 0 18px;">${undecided.map((u) => `<li>${esc(u.row)} — looked like ${esc(u.candidate)}</li>`).join("")}</ul>
          Check Data health's duplicate list if that was wrong.</div>` : ""}
        <div class="row-list">${names.map(([id, name]) => `<div class="row-item"><div class="row-main"><a href="#" class="t" onclick="event.preventDefault();openClient('${id}')">${esc(name)}</a></div></div>`).join("")}</div>
      </div>` : "";
  }
}

/* R8-REV: REVOLUTION SYNC (Import tab) THE RULE THIS IS BUILT AROUND: every client, case and product is keyed into
   Revolution FIRST. HEADERS ARE RECOGNISED BY NAME, NEVER BY POSITION. There is no revolution_ref column — that
   schema change was declined — so there is no key to join on and there never will be until there is. A field that
   DISAGREES defaults to KEEP and is highlighted: the export is the book of record for what the lender did, but this
   database is where a human has been putting corrections, and a weekly file must never quietly overwrite one of
   those without being told to. … */

/* 1 · WHAT WE CAN ACTUALLY STORE key, label, scope (client | case | meta), kind. `meta` is a field that is
   read and shown but is never part of the automatic update set… */
const REV_FIELDS = [
  ["first_name", "First name", "client", "text"],
  ["last_name", "Surname", "client", "text"],
  ["date_of_birth", "Date of birth", "client", "date"],
  ["email", "Email", "client", "text"],
  ["phone", "Phone", "client", "phone"],
  ["addr_line1", "Address line 1", "client", "addr"],
  ["addr_line2", "Address line 2", "client", "addr"],
  ["addr_town", "Town", "client", "addr"],
  ["addr_county", "County", "client", "addr"],
  ["addr_postcode", "Postcode", "client", "addr"],
  /* R13 · M-4: THE COLUMN THAT USED TO HAVE NOWHERE TO LAND. Every week this export carried a
     vulnerable-customer flag and this sync's own mapping table said, in as many words… */
  ["is_vulnerable", "Vulnerable client", "client", "yesno"],
  ["vulnerability_note", "Vulnerability note", "client", "text"],
  ["lender", "Lender", "case", "text"],
  ["product_name", "Product", "case", "text"],
  ["rate_type", "Rate type", "case", "rate_type"],
  ["rate_percent", "Rate %", "case", "pct"],
  ["rate_end_date", "Rate end date", "case", "date"],
  ["erc_end_date", "ERC end date", "case", "date"],
  ["loan_amount", "Loan amount", "case", "money_plain"],
  ["property_value", "Property value", "case", "money_plain"],
  ["term_years", "Term (years)", "case", "int"],
  ["case_kind", "Case type", "case", "case_kind"],
  ["lead_source", "Lead source", "case", "text"],
  ["submitted_at", "Submitted date", "case", "date"],
  ["completed_date", "Completion date", "case", "date"],
  ["proc_fee", "Proc fee", "case", "money"],
  ["broker_fee", "Broker fee", "case", "money"],
  ["fee_status", "Fee status", "case", "fee_status"],
  ["protection_status", "Protection", "case", "prot_flag"],
  ["protection_commission", "Protection commission", "case", "money"],
  ["gi_status", "GI / buildings insurance", "case", "gi_flag"],
  ["stage", "Case status", "meta", "stage"],
  ["note", "File note", "meta", "text"],
];
const REV_FIELD = Object.fromEntries(REV_FIELDS.map(([key, label, scope, kind]) => [key, { key, label, scope, kind }]));
/* The case columns a diff is drawn over, in the order a human reads them: the two dates this whole system
   runs on first, then the deal, then the money, then the protection outcome. */
const REV_CASE_DIFF = ["rate_end_date", "erc_end_date", "lender", "product_name", "rate_type", "rate_percent",
  "loan_amount", "property_value", "term_years", "case_kind", "fee_status", "proc_fee", "broker_fee",
  "protection_status", "protection_commission", "gi_status", "lead_source", "submitted_at", "completed_date"];
const REV_CLIENT_DIFF = ["date_of_birth", "email", "phone", "address", "is_vulnerable", "vulnerability_note"];
/* R13 — the care columns this sync can write, and the only place the list is spelled out. */
const REV_CARE_FIELDS = ["is_vulnerable", "vulnerability_note"];
const REV_MONEY_FIELDS = new Set(["proc_fee", "broker_fee", "protection_commission"]);
const REV_ADDR_PARTS = ["addr_line1", "addr_line2", "addr_town", "addr_county", "addr_postcode"];
const REV_CASE_COL = { completed_date: "completed_at" };

/* ---- 2 · HEADER RECOGNITION ---------------------------------------------
   Ordered: FIRST match wins, so every rule below is written knowing what is
   above it. The ordering is load-bearing in five places and each is commented:
   "Initial Term Expiry Date" must reach rate_end_date before /term/ claims it,
   "Reversion Rate %" must be spent before /rate/, "Adviser FCA Ref" before
   /adviser/, "Fee Status" before /fee/, and the whole insurance block before
   the protection block (an "Income Protection" or "GI Premium" column that
   fell through to /protection|premium/ would be read as the life policy).

   A key beginning "__" is RECOGNISED BUT UNSTORABLE: we know exactly what the
   column is and we have nowhere to put it. That is a different thing from a
   column we do not recognise, and the mapping table says which is which. */
const REV_UNSTORED_WHY = {
  __ref: "no reference field on a client or case here — Revolution's own references are not stored (the revolution_ref column was declined, so every run re-matches on identity instead)",
  __title: "no title field — the client record holds first and last name only",
  __middle: "no middle-name field",
  __applicant2: "no second-applicant record — this system holds one client per case, and a joint application's second applicant has nowhere to live",
  __ltv: "not stored — LTV is loan ÷ property value, both of which are stored",
  __reversion: "no reversion/SVR rate field — only the initial rate is held",
  __repayment: "no repayment-method field (repayment vs interest-only)",
  __offer_date: "no offer-date field — this system holds the offer EXPIRY date, which is a different thing and is not in this file",
  __adviser: "not written — advisers are assigned in this system, and a weekly file must not silently reassign a colleague's case",
  __fca: "no FCA-reference field on a profile",
  __introducer: "not written — an introducer here is a linked record, not free text, so a name in a spreadsheet cannot be matched to one safely",
  __network: "no network field — every case here is Stonebridge",
  __prot_type: "no policy-type field — this system records the protection OUTCOME (discussed / quoted / policy taken / declined), not the policy",
  __prot_provider: "no protection-provider field",
  __prot_premium: "no premium field — this system holds the protection COMMISSION (what the firm earns), which is a different number and is mapped separately",
  __income_protection: "no income-protection field — protection is one outcome per case, not a policy list",
  __gi_provider: "no GI-provider field",
  __gi_premium: "no GI-premium field — GI is held as an outcome (quoted / policy taken / declined), not an amount",
  __consent: "not written — contact consent is held here as marketing_opt_out / sms_opt_out, and flipping a client's consent from a spreadsheet is not something a sync should ever do on its own",
  __last_reviewed: "no last-reviewed field — this system derives last contact from notes, sent emails, appointments and completed tasks",
};
const REV_HEADER_RULES = [
  [/^(case|client|customer|lender|account|policy|application)\s*(ref|reference|number|no|id)\b/, "__ref"],
  [/\b(fca)\b/, "__fca"],                                   // before /adviser/
  [/^(title|salutation)$/, "__title"],
  [/^middle/, "__middle"],
  [/^(applicant 2|applicant two|second applicant|joint applicant|app 2|partner)\b/, "__applicant2"],
  [/(income protection|^ip$|ip cover)/, "__income_protection"],   // before every /protection/ rule
  [/^(gi|general insurance|home insurance|buildings insurance|home ins)\b.*(provider|insurer)/, "__gi_provider"],
  [/^(gi|general insurance|home insurance|buildings insurance|home ins)\b.*(premium|cost|monthly|annual)/, "__gi_premium"],
  [/^(gi|general insurance|home insurance|buildings insurance|home ins)\b/, "gi_status"],
  [/protection.*(commission|proc)/, "protection_commission"],
  [/protection.*(premium|monthly|cost)/, "__prot_premium"],
  [/(protection.*(policy )?type|policy type)/, "__prot_type"],
  [/protection.*(provider|insurer)/, "__prot_provider"],
  [/(taken protection|protection (sold|taken|status)|^protection$|life cover|life policy)/, "protection_status"],
  /* R13 · M-4 — the note rule must come first: "Vulnerability Notes" would otherwise be claimed by
     the flag rule below it and a paragraph of care detail would be read as a yes/no. */
  [/(vulnerab|vulnerable customer).*(note|detail|reason|comment|why)/, "vulnerability_note"],
  [/(vulnerab)/, "is_vulnerable"],
  [/(consent|opt in|opt out|marketing preference)/, "__consent"],
  [/(last review|reviewed date|last annual review)/, "__last_reviewed"],
  [/^(first name|forename|given name|christian name|first)$/, "first_name"],
  [/^(surname|last name|family name|last)$/, "last_name"],
  [/(date of birth|^dob$|birth date|d o b)/, "date_of_birth"],
  [/(e ?mail)/, "email"],
  [/(mobile|^phone|telephone|^tel$|contact number|landline|cell)/, "phone"],
  [/^(address line 2|address 2)/, "addr_line2"],
  [/^(address line 1|address 1|address|street|house)/, "addr_line1"],
  [/^(town|city|post town)$/, "addr_town"],
  [/^county$/, "addr_county"],
  [/(post ?code|postal code|^zip)/, "addr_postcode"],
  [/^(ltv|loan to value)/, "__ltv"],
  [/(reversion|svr|standard variable|revert)/, "__reversion"],      // before every /rate/ rule
  [/(initial term expiry|term expiry|rate end|end of rate|deal end|product end|fixed rate end|fix end|maturity|rate expiry|deal expiry)/, "rate_end_date"],
  [/(^erc|early repayment)/, "erc_end_date"],
  [/^(rate type|product type|repayment basis)$/, "rate_type"],
  [/(initial rate|interest rate|rate percent|^rate$|^rate %$|pay rate)/, "rate_percent"],
  [/(^lender|^bank$|^provider$|product provider|lender name)/, "lender"],
  [/^(product name|product|scheme)$/, "product_name"],
  [/(loan amount|^loan$|borrowing|mortgage amount|advance|balance)/, "loan_amount"],
  [/(property value|valuation|purchase price|^value$|security value)/, "property_value"],
  [/(repayment method|repayment type|method of repayment)/, "__repayment"],
  [/(^term|term years|mortgage term|term in years)/, "term_years"],
  [/(mortgage purpose|^purpose$|case type|enquiry type|application type|loan type|business type)/, "case_kind"],
  [/(procuration|^proc fee|proc$)/, "proc_fee"],
  [/(fee status|fee paid|fee state)/, "fee_status"],                 // before /fee/
  [/(broker fee|advice fee|client fee|adviser fee|arrangement fee|^fee$)/, "broker_fee"],
  [/(application date|date of application|submitted|submission date)/, "submitted_at"],
  [/(offer date|offer issued|date of offer)/, "__offer_date"],
  [/(completion date|completed|date completed)/, "completed_date"],
  [/(case status|^status$|^stage$|case stage)/, "stage"],
  [/(^adviser|^advisor|^consultant|^broker$|written by|case owner)/, "__adviser"],
  [/(introducer|referrer|referred by)/, "__introducer"],
  [/(lead source|^source$|origin|marketing source)/, "lead_source"],
  [/^(network|firm|principal)$/, "__network"],
  [/(note|comment|remark|free text)/, "note"],
];
/* Their header text, flattened for comparison: bracketed qualifiers dropped
   ("Protection Premium (Monthly)" → "protection premium"), punctuation and
   case gone. Kept as its own function because the remembered-mapping key in
   localStorage is this normalised form — so a header that gains a stray space
   or changes case between weeks still finds last week's correction. */
const revNormHeader = (h) => String(h == null ? "" : h).toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
function revRecognise(header) {
  const s = revNormHeader(header);
  if (!s) return null;
  for (let i = 0; i < REV_HEADER_RULES.length; i++) if (REV_HEADER_RULES[i][0].test(s)) return REV_HEADER_RULES[i][1];
  return null;
}

/* 3 · VALUES Every incoming cell is normalised to the shape the column actually holds BEFORE anything is
   compared, so a diff can never be a formatting artefact. */
const REV_STAGE_WORDS = [
  [/(not proceed|withdraw|cancel|lapsed|dead|lost|declined by client|npd)/, "not_proceeding"],
  [/(complet|drawn down|funds released)/, "completed"],
  [/(exchange)/, "exchange"],
  [/(offer)/, "offer"],
  [/(application|submitted|with lender|awaiting valuation)/, "application"],
  [/(dip|decision in principle|aip|agreement in principle)/, "decision_in_principle"],
  [/(fact ?find|advice|research|recommend)/, "fact_find"],
  [/(enquiry|inquiry|lead|new case|prospect)/, "enquiry"],
];
const REV_KIND_WORDS = [
  [/(first ?time ?buyer|^ftb)/, "first_time_buyer"],
  [/(product ?transfer|^pt$|retention|switch)/, "product_transfer"],
  [/(buy ?to ?let|^btl|let to buy|investment)/, "buy_to_let"],
  [/(remortgage|refinance)/, "remortgage"],
  [/(purchase|home ?mover|moving|new build)/, "purchase"],
];
const REV_YES = /^(y|yes|true|1|taken|sold|policy taken)$/i;
const REV_NO = /^(n|no|false|0|none|not taken|declined)$/i;
/* One cell → { v, note, bad }. `v` is null when there is nothing to propose — which is NOT the same as "set
   this to blank": the sync never blanks a stored value from an empty cell, because an empty cell in a weekly
   export means "not exported", not "deleted". */
function revValue(key, raw) {
  const f = REV_FIELD[key];
  const s = String(raw == null ? "" : raw).trim();
  if (!f || !s) return { v: null };
  const num = (x) => {
    const n = Number(String(x).replace(/[£$,%\s]/g, ""));
    return isNaN(n) ? null : n;
  };
  switch (f.kind) {
    case "date": {
      const p = parseUkDate(s);
      if (!p.ok) return { v: null, bad: true, note: `couldn't read ${f.label.toLowerCase()} “${s}” (${p.note})` };
      if (p.ambiguous) return { v: p.iso, amb: `${f.label.toLowerCase()} ${s} → ${fmtD(p.iso)}` };
      return { v: p.iso };
    }
    case "money": case "money_plain": case "pct": {
      const n = num(s);
      if (n == null) return { v: null, bad: true, note: `couldn't read ${f.label.toLowerCase()} “${s}” as a number` };
      return { v: n };
    }
    case "int": {
      const n = num(s);
      if (n == null) return { v: null, bad: true, note: `couldn't read ${f.label.toLowerCase()} “${s}” as a number` };
      return { v: Math.round(n) };
    }
    case "stage": {
      const low = s.toLowerCase();
      for (const [re, st] of REV_STAGE_WORDS) if (re.test(low)) return { v: st };
      return { v: null, note: `case status “${s}” doesn't match any stage here` };
    }
    case "case_kind": {
      const low = s.toLowerCase();
      for (const [re, k] of REV_KIND_WORDS) if (re.test(low)) return { v: k };
      return { v: "other" };
    }
    case "rate_type": {
      const low = s.toLowerCase();
      if (/track/.test(low)) return { v: "tracker" };
      if (/discount/.test(low)) return { v: "discount" };
      if (/(variable|svr)/.test(low)) return { v: "variable" };
      if (/fix/.test(low)) return { v: "fixed" };
      return { v: null, note: `rate type “${s}” doesn't match any of fixed / tracker / variable / discount` };
    }
    case "fee_status": {
      const low = s.toLowerCase();
      if (/paid|received|banked/.test(low)) return { v: "paid" };
      if (/(waiv|not charged|no fee|free|nil)/.test(low)) return { v: "waived" };
      if (/(request|invoic|due|outstanding|owed)/.test(low)) return { v: "requested" };
      return { v: "not_requested" };
    }
    /* Y/N flags. "Y" is an outcome we can record. "N" deliberately proposes NOTHING: it says a policy was not
       sold, which is not the same as "declined" and certainly not "not discussed"… */
    case "prot_flag": case "gi_flag": {
      if (REV_YES.test(s)) return { v: "policy_taken" };
      if (REV_NO.test(s)) return { v: null, note: `${f.label}: “${s}” only says no policy was sold — it doesn't say what was discussed, so nothing is proposed here` };
      const low = s.toLowerCase();
      if (/declin/.test(low)) return { v: "declined" };
      if (/quot/.test(low)) return { v: "quoted" };
      if (/discuss/.test(low)) return { v: "discussed" };
      return { v: null, note: `“${s}” isn't a protection outcome this system holds` };
    }
    /* R13 · M-4: the vulnerability flag, on the same discipline as prot_flag above and for a sharper reason.
           "Y" is a care record and is proposed. "N" or a blank proposes NOTHING: a vulnerability recorded HERE by the
           adviser who took the call is the better record, and a weekly spreadsheet quietly clearing it is precisely
           the Consumer Duty failure this column exists to prevent. Un-flagging is a human act, on the client record. */
    case "yesno": {
      if (REV_YES.test(s)) return { v: true };
      if (REV_NO.test(s)) return { v: null, note: `${f.label}: “${s}” means this file does not flag them — a flag recorded here by hand is never cleared from the export, so nothing is proposed` };
      return { v: null, note: `${f.label}: “${s}” isn't a yes or a no, so nothing is proposed` };
    }
    case "phone": return { v: s };
    default: return { v: s };
  }
}
/* How a value PRINTS in the diff. Money uses the app's own formatter so the
   sync can never show a fee in a different shape from the case screen. */
function revShow(key, v) {
  const f0 = REV_FIELD[key] || { kind: "text" };
  if (f0.kind === "yesno") return v == null || v === "" ? "—" : (v === true || v === "true" ? "Yes" : "No");   // R13 — false is a value, not an absence
  if (v == null || v === "") return "—";
  const f = f0;
  if (key === "date_of_birth" || f.kind === "date") return fmtD(v);
  if (f.kind === "money" || f.kind === "money_plain") return fmtM(v);
  if (f.kind === "pct") return v + "%";
  if (key === "stage") return STAGE_LABEL[v] || v;
  if (key === "case_kind") return (KINDS.find((k) => k[0] === v) || [])[1] || v;
  if (key === "protection_status" || key === "gi_status" || key === "fee_status") return String(v).replace(/_/g, " ");
  return String(v);
}
/* Same value? Compared on the NORMALISED value, and numerically where the column is a number, so 4.44 vs
   "4.440" is not a conflict and 186000 vs "186,000" is not either. */
function revSame(key, a, b) {
  const f0 = REV_FIELD[key] || { kind: "text" };
  // R13 — a stored `false` is not an empty value: without this, "held false / incoming true"
  // would compare as "we hold nothing" and be offered as a fill rather than as the change it is.
  if (f0.kind === "yesno") return (a === true) === (b === true);
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  const f = f0;
  if (["money", "money_plain", "pct", "int"].includes(f.kind)) return Number(a) === Number(b);
  if (f.kind === "date" || key === "date_of_birth") return String(a).slice(0, 10) === String(b).slice(0, 10);
  if (key === "phone") return normPhone(a) === normPhone(b);
  if (key === "email") return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/* ---- 4 · STATE ---------------------------------------------------------- */
let revHeaders = [];      // their header row, verbatim
let revCells = [];        // data rows, verbatim cells
let revMapping = [];      // one entry per header — see revBuildMapping()
let revRows = [];         // the decided rows (see revBuildRows)
let revClients = [], revCases = [];
let revFileLabel = "";
const REV_ROW_CAP = 400;  // rows drawn; a bigger file still imports in slices
const REV_CASE_WINDOW_DAYS = 62;
/* The remembered mapping. Per signed-in user and per browser — which is stated on screen, because that is the
   honest description of localStorage. */
const revMapStoreKey = () => `nx_revmap_${authUid || "anon"}`;
function revMapRemembered() {
  try { return JSON.parse(lsGet(revMapStoreKey()) || "{}") || {}; } catch (e) { return {}; }
}
function revRememberMap(norm, key) {
  const m = revMapRemembered();
  m[norm] = key;
  lsSet(revMapStoreKey(), JSON.stringify(m));
}

/* 5 · THE MAPPING TABLE Auto-map, then apply the operator's remembered corrections on top, then resolve
   collisions: two columns cannot write one field… */
function revBuildMapping(headers) {
  const remembered = revMapRemembered();
  const claimed = new Map();
  return headers.map((h, i) => {
    const norm = revNormHeader(h);
    const auto = revRecognise(h);
    const hasMemory = Object.prototype.hasOwnProperty.call(remembered, norm);
    let key = hasMemory ? remembered[norm] : auto;
    if (key && !REV_FIELD[key] && !String(key).startsWith("__")) key = null;   // a field that no longer exists
    const e = { header: String(h == null ? "" : h), norm, key: null, auto, bucket: "ignored", why: "", remembered: hasMemory, i };
    if (!norm) { e.bucket = "ignored"; e.why = "column has no heading"; return e; }
    if (!key) {
      e.bucket = "ignored";
      e.why = hasMemory ? "you told this sync to ignore this column" : "not recognised — nothing here is read from it";
      return e;
    }
    if (String(key).startsWith("__")) {
      e.bucket = "unstored";
      e.why = REV_UNSTORED_WHY[key] || "recognised, but there is no field here to store it in";
      e.key = null; e.recognisedAs = key;
      return e;
    }
    if (claimed.has(key)) {
      e.bucket = "unstored";
      e.why = `duplicate of “${claimed.get(key)}” — only the first column that maps to ${REV_FIELD[key].label} is read`;
      e.recognisedAs = key;
      return e;
    }
    claimed.set(key, e.header);
    e.key = key; e.bucket = "mapped";
    return e;
  });
}

/* ---- 6 · READING THE FILE ----------------------------------------------
   Delimiter by vote, quoted fields respected (a real export has commas inside
   Notes), and the SheetJS path the bulk import already uses for .xlsx —
   converted to CSV text first so there is exactly one parser below it. */
/* A QUOTED CELL MAY CONTAIN A LINE BREAK, so physical lines are folded back into
   records before anything is split. The Notes column of a real export is free text a
   human typed, and one with a newline in it used to become TWO rows: the tail of the
   note arrived as a row of its own, and a row with any text in its name column is a
   client this sync offers to CREATE — a phantom person, sitting next to a real row
   that had silently lost every column after the note. Folding is comma-only (quoting
   is a CSV convention; a tab or semicolon export can carry a bare `"` legitimately)
   and is abandoned wholesale if the file ends mid-quote, because a malformed file
   swallowed into one record is worse than a malformed file read line by line. */
function revFoldQuoted(raw) {
  const out = [];
  let cur = null;
  for (const l of raw) {
    cur = cur == null ? l : cur + "\n" + l;
    if (((cur.match(/"/g) || []).length) % 2 === 0) { out.push(cur); cur = null; }
  }
  return cur == null ? out : null;   // null = unbalanced quoting; the caller keeps the raw lines
}
function revSplitRows(text) {
  const raw = String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
  const keep = (l) => l.trim() !== "" && !/^===\s*Sheet:/i.test(l.trim());
  const first = raw.filter(keep)[0] || "";
  let delim = ",", best = -1;
  [",", "\t", ";", "|"].forEach((d) => {
    const n = impSplitDelimited(first, d).length;
    if (n > best) { best = n; delim = d; }
  });
  const folded = delim === "," ? revFoldQuoted(raw) : null;
  const lines = (folded || raw).filter(keep);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = impSplitDelimited(lines[0], delim).map((h) => h.replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((l) => impSplitDelimited(l, delim));
  return { headers, rows, delim };
}
const revDays = (a, b) => Math.round((new Date(String(a).slice(0, 10) + "T12:00:00") - new Date(String(b).slice(0, 10) + "T12:00:00")) / 86400000);
function revComposeAddress(g) {
  const parts = REV_ADDR_PARTS.map((k) => (g[k] || "").trim()).filter(Boolean);
  return parts.join(", ");
}
/* Whether THIS operator may see and write the money on THIS case. Same rule as the CSV exports (csvShowsFee):
   the Owner always, an adviser/staff member on their own case, an Administrator not at all. */
function revMoneyOk(caseRow) {
  if (showMoney()) return true;
  if (!csvFeeRoles() || !ME) return false;
  return !!caseRow && caseRow.assigned_to === ME.id;
}

/* ---- 7 · WHO IS THIS ROW ABOUT -----------------------------------------
   findClientMatches() does the identity work — the SAME function the bulk
   import and lead accept use, extended here by the one column this export has
   that neither of those doors carries: the date of birth.

     exact    name key matches AND the dates of birth agree. Nothing else is
              strong enough to write to a client record unattended, and this is
              the pairing the network's own export is keyed on.
     exact    name key matches AND email-or-phone matches AND nothing
              contradicts (no DOB clash, no different email, no different
              phone) — the ordinary row for a client whose DOB we never
              captured, which is most of the book.
     review   anything else with a candidate: a DOB that disagrees, a name that
              disagrees, an email that disagrees. It is shown with the candidate
              and the reason, and it writes nothing until a human picks.
     new      no candidate at all.
     quarantine  no person in the row at all — the trailing junk row every
              report tool leaves behind. */
function revMatchClient(r) {
  const name = [r.g.first_name, r.g.last_name].filter(Boolean).join(" ").trim();
  const email = (r.g.email || "").trim();
  const phone = (r.g.phone || "").trim();
  /* R75 · B1: the two quarantine branches moved into rowPersonCheck() so the bulk AI import can ask the
     identical question with the identical words. Same verdicts, same reasons, same order… */
  const pc = rowPersonCheck(name, email, phone);
  if (!pc.ok) return { verdict: "quarantine", reason: pc.reason };
  const q = { name, email, phone, address: r.address, postcode: r.g.addr_postcode || "" };
  const m = findClientMatches(q, revClients);
  const dobIn = r.v.date_of_birth || null;
  const nk = clientNameKey(name);
  const contradicts = (c) =>
    (email && c.email && String(c.email).trim().toLowerCase() !== email.toLowerCase())
    || (phone && c.phone && normPhone(c.phone) !== normPhone(phone));
  if (m.exact) {
    const c = m.exact;
    const sameName = clientNameKey(clientFullName(c)) === nk;
    const dobHeld = c.date_of_birth || null;
    const dobAgree = !!(dobIn && dobHeld && String(dobIn).slice(0, 10) === String(dobHeld).slice(0, 10));
    const dobClash = !!(dobIn && dobHeld && !dobAgree);
    if (sameName && dobAgree) return { verdict: "exact", clientId: c.id, reason: "name and date of birth both match", candidates: [c] };
    if (sameName && !dobClash && !contradicts(c)) {
      return { verdict: "exact", clientId: c.id, reason: `name matches and ${m.reason}${dobIn && !dobHeld ? " — we hold no date of birth for them, so the file's one can fill it" : ""}`, candidates: [c] };
    }
    const why = dobClash
      ? `${m.reason}, but the date of birth in the file (${fmtD(dobIn)}) is not the one we hold (${fmtD(dobHeld)})`
      : !sameName
        ? `${m.reason}, but the name in the file is not the name we hold (“${clientFullName(c)}”)`
        : `${m.reason}, but the contact details in the file disagree with the ones we hold`;
    return { verdict: "review", candidates: [c].concat(m.near.map((n) => n.client)).slice(0, 5), reason: why };
  }
  if (m.near.length) {
    return {
      verdict: "review",
      candidates: m.near.map((n) => n.client),
      reason: m.near.map((n) => `${clientFullName(n.client)} — ${n.reason}`).join(" · "),
    };
  }
  return { verdict: "new", reason: "nobody on the book looks like this person" };
}
/* ---- 8 · WHICH CASE IS THIS THE SAME MORTGAGE AS -----------------------
   Same client + same lender + rate ends within 62 days = the same mortgage.
   62 days because a product's end date is routinely recorded as the last day of
   the month at one end and the completion anniversary at the other, and two
   months is wider than that gap and narrower than any real remortgage cycle.

   Two documented departures from the letter of that rule, both in the same
   direction (they only ever ADD a match, and both say why on screen):
     · our case has no rate end date at all — then there is nothing to be more
       than 62 days from, and filling it in is the single most valuable thing
       this sync does;
     · the file has no rate end date — same reasoning, in reverse.
   Anything else is a CANDIDATE NEW CASE, which is a decision, not a write. */
function revMatchCase(r, clientId) {
  const cases = revCases.filter((c) => c.client_id === clientId);
  if (!cases.length) return { verdict: "new", reason: "this client has no cases here yet" };
  const lk = impLenderKey(r.v.lender);
  if (!lk) return { verdict: "none", reason: "the file gives no lender for this row, so it cannot be tied to one of their cases" };
  const same = cases.filter((c) => impLenderKey(c.lender) === lk);
  if (!same.length) {
    /* NOT esc()'d: every consumer of `reason` escapes it on the way to the screen (the row table, the detail
       panel, the quarantine list and the apply log all wrap it in esc())… */
    return { verdict: "new", reason: `no case with this lender (${r.v.lender}) — their cases here are with ${[...new Set(cases.map((c) => c.lender || "no lender"))].join(", ")}` };
  }
  const inWin = same.filter((c) => c.rate_end_date && r.v.rate_end_date && Math.abs(revDays(c.rate_end_date, r.v.rate_end_date)) <= REV_CASE_WINDOW_DAYS);
  if (inWin.length) {
    inWin.sort((a, b) => Math.abs(revDays(a.rate_end_date, r.v.rate_end_date)) - Math.abs(revDays(b.rate_end_date, r.v.rate_end_date)));
    return {
      verdict: "same", caseId: inWin[0].id,
      reason: `same lender and the rate ends within ${REV_CASE_WINDOW_DAYS} days of ours`
        + (inWin.length > 1 ? ` (${inWin.length} of their cases are with this lender — matched the closest)` : ""),
    };
  }
  const blank = same.filter((c) => !c.rate_end_date || !r.v.rate_end_date);
  if (blank.length === 1) {
    return {
      verdict: "same", caseId: blank[0].id,
      reason: blank[0].rate_end_date ? "same lender, and the file gives no rate end date to compare" : "same lender, and our case has no rate end date to compare — treated as the same mortgage",
    };
  }
  return {
    verdict: "new",
    reason: `same lender, but the rate end dates are more than ${REV_CASE_WINDOW_DAYS} days apart (ours ${same.map((c) => fmtD(c.rate_end_date)).join(", ")}) — this looks like a different deal`,
  };
}

/* 9 · THE DIFF Per field, one of four states: same nothing to do fill we hold nothing → default UPDATE (there
   is nothing to lose) conflict we hold something else → default KEEP, highlighted. */
function revDiffCase(r, caseRow) {
  const out = [];
  /* A case that does not exist yet will be created assigned to ME, so the money rule has to be asked about
     THAT case, not about nothing… */
  const moneyOk = revMoneyOk(caseRow || { assigned_to: (ME && ME.id) || null });
  REV_CASE_DIFF.forEach((key) => {
    const inc = r.v[key];
    if (inc == null || inc === "") return;
    const col = REV_CASE_COL[key] || key;
    let held = caseRow ? caseRow[col] : null;
    if (col === "completed_at" && held) held = String(held).slice(0, 10);
    if (REV_MONEY_FIELDS.has(key) && !moneyOk) {
      out.push({ key, label: REV_FIELD[key].label, incoming: inc, held: null, state: "money", choice: "keep" });
      return;
    }
    if (revSame(key, held, inc)) { out.push({ key, label: REV_FIELD[key].label, incoming: inc, held, state: "same", choice: "keep" }); return; }
    const blank = held == null || held === "" || (key === "protection_status" && held === "not_discussed") || (key === "gi_status" && held === "not_discussed");
    out.push({ key, label: REV_FIELD[key].label, incoming: inc, held, state: blank ? "fill" : "conflict", choice: blank ? "update" : "keep" });
  });
  return out;
}
function revDiffClient(r, clientRow) {
  const out = [];
  const push = (key, label, held, inc) => {
    if (inc == null || inc === "") return;
    if (revSame(key, held, inc)) { out.push({ key, label, incoming: inc, held, state: "same", choice: "keep" }); return; }
    const blank = held == null || held === "";
    out.push({ key, label, incoming: inc, held, state: blank ? "fill" : "conflict", choice: blank ? "update" : "keep" });
  };
  push("date_of_birth", "Date of birth", clientRow.date_of_birth, r.v.date_of_birth);
  push("email", "Email", clientRow.email, r.g.email);
  push("phone", "Phone", clientRow.phone, r.g.phone);
  /* R13 · M-4: the care fields, offered exactly like any other: shown, defaulted, and never written without a
     choice. Only reachable when the mapping actually mapped them… */
  push("is_vulnerable", "Vulnerable client", clientRow.is_vulnerable, r.v.is_vulnerable);
  push("vulnerability_note", "Vulnerability note", clientRow.vulnerability_note, r.v.vulnerability_note);
  /* THE ADDRESS IS NOT A STRING COMPARISON. Every row of this export composes an address out of five columns,
     so the file's version of an address we already hold is routinely the same place written more fully. */
  if (r.address) {
    const held = clientRow.address || "";
    if (!held) out.push({ key: "address", label: "Client address", incoming: r.address, held: null, state: "fill", choice: "update" });
    else if (revAddrTokens(held).size && revAddrSubset(held, r.address)) {
      const same = revAddrSubset(r.address, held);
      out.push({ key: "address", label: "Client address", incoming: r.address, held, state: same ? "same" : "extend", choice: same ? "keep" : "update" });
    } else out.push({ key: "address", label: "Client address", incoming: r.address, held, state: "conflict", choice: "keep" });
  }
  return out;
}
const revAddrTokens = (s) => new Set(String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean));
// Every word of `a` appears in `b` — "b says everything a says, and maybe more".
function revAddrSubset(a, b) {
  const B = revAddrTokens(b);
  return [...revAddrTokens(a)].every((t) => B.has(t));
}
/* Recompute everything downstream of "which client is this row about". Called on build and again every time
   the operator attaches a review row… */
function revResolveRow(r) {
  r.caseMatch = null; r.caseDiff = []; r.clientDiff = []; r.stageMove = null;
  const clientId = r.clientId;
  if (!clientId) {
    // Creating the client: everything mapped is written, nothing is a conflict.
    r.caseMatch = { verdict: "new", reason: "new client — the case comes with them" };
    r.caseDiff = revDiffCase(r, null).filter((d) => d.state !== "same");
    return r;
  }
  const clientRow = revClients.find((c) => c.id === clientId) || {};
  r.clientDiff = revDiffClient(r, clientRow);
  r.caseMatch = revMatchCase(r, clientId);
  const caseRow = r.caseMatch.caseId ? revCases.find((c) => c.id === r.caseMatch.caseId) : null;
  r.caseDiff = revDiffCase(r, caseRow);
  /* THE STAGE IS NEVER PART OF THE UPDATE SET. An incoming "Completed" on a case sitting at Application is a
     real and useful signal — and it is also the thing that fires completion reporting… */
  if (caseRow && r.v.stage && r.v.stage !== caseRow.stage) {
    r.stageMove = { from: caseRow.stage, to: r.v.stage, accepted: !!r.stageAccepted };
  }
  revApplyStageLock(r);
  return r;
}
/* A COMPLETION DATE IS PART OF THE STAGE DECISION, not a field of its own. Writing completed_at onto a case
   still sitting at Application produces a case that is completed for every money report and live for every… */
function revApplyStageLock(r) {
  const d = (r.caseDiff || []).find((x) => x.key === "completed_date");
  if (!d) return;
  if (r.stageMove && !r.stageAccepted && d.state !== "same") { d.choice = "keep"; d.locked = true; }
  else if (d.locked) { d.locked = false; d.choice = d.state === "conflict" ? "keep" : "update"; }
}

/* ---- 10 · BUILDING THE ROWS -------------------------------------------- */
function revBuildRows() {
  revRows = revCells.slice(0, REV_ROW_CAP).map((cells, i) => {
    const g = {}, v = {}, problems = [];
    revMapping.forEach((m) => {
      if (!m.key) return;
      const raw = cells[m.i] == null ? "" : String(cells[m.i]).trim();
      if (raw) g[m.key] = raw;
    });
    const amb = [];
    Object.keys(g).forEach((k) => {
      const res = revValue(k, g[k]);
      v[k] = res.v;
      if (res.amb) amb.push(res.amb);
      else if (res.note && !problems.some((x) => x.text === res.note)) problems.push({ text: res.note, bad: !!res.bad });
    });
    /* Every date in a UK network's export is dd/mm/yyyy, and parseUkDate flags every one whose day is also a
       valid month. Listing all six per row would bury the one that matters… */
    if (amb.length) problems.unshift({ text: `${amb.length} date${amb.length === 1 ? "" : "s"} read in UK day/month order: ${amb.join("; ")}`, bad: false });
    const r = { i, cells, g, v, problems, address: revComposeAddress(g), skipped: false, stageAccepted: false, clientId: null, forceNew: false };
    const mc = revMatchClient(r);
    r.match = mc.verdict;
    r.matchReason = mc.reason;
    r.candidates = mc.candidates || [];
    r.clientId = mc.clientId || null;
    r.forceNew = mc.verdict === "new";
    if (r.match !== "quarantine") revResolveRow(r);
    return r;
  });
  return revRows;
}
const revRowIncluded = (r) => !!(!r.skipped && r.match !== "quarantine"
  && (r.match === "exact" || r.match === "new" || (r.match === "review" && (r.clientId || r.forceNew))));
const revRowName = (r) => [r.g.first_name, r.g.last_name].filter(Boolean).join(" ").trim() || r.g.email || r.g.phone || "(no name)";
/* What this row would WRITE if Apply were pressed now — the number in the
   Changes column, and the thing the apply bar totals. */
function revRowWrites(r) {
  if (!revRowIncluded(r)) return { fields: 0, creates: [] };
  const creates = [];
  if (!r.clientId) creates.push("client");
  const newCase = r.caseMatch && r.caseMatch.verdict === "new";
  if (newCase) creates.push("case");
  let fields = 0;
  if (r.clientId) (r.clientDiff || []).forEach((d) => { if (d.choice === "update" && d.state !== "same") fields++; });
  if (!newCase) (r.caseDiff || []).forEach((d) => { if (d.choice === "update" && d.state !== "same" && d.state !== "money") fields++; });
  if (r.stageMove && r.stageAccepted) fields++;
  return { fields, creates };
}

/* ---- 11 · THE MAPPING SCREEN ------------------------------------------- */
function revFieldOptionsHtml(sel) {
  const grp = (scope, label) => `<optgroup label="${label}">`
    + REV_FIELDS.filter(([, , s]) => s === scope).map(([k, l]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(l)}</option>`).join("")
    + "</optgroup>";
  return `<option value="" ${sel ? "" : "selected"}>— not stored —</option>`
    + grp("client", "Client") + grp("case", "Case") + grp("meta", "Shown, never written automatically");
}
function renderRevMapping() {
  const el = $("#rev-mapping");
  if (!el) return;
  if (!revMapping.length) { el.innerHTML = ""; return; }
  const nMapped = revMapping.filter((m) => m.bucket === "mapped").length;
  const nUnstored = revMapping.filter((m) => m.bucket === "unstored").length;
  const nIgnored = revMapping.filter((m) => m.bucket === "ignored").length;
  const eg = (m) => {
    const first = (revCells.find((c) => (c[m.i] || "").trim()) || [])[m.i];
    return first ? String(first).slice(0, 60) : "";
  };
  el.innerHTML = `<div class="panel" id="rev-map-panel">
    <h3>Their columns → our fields</h3>
    <p class="rev-map-summary" id="rev-map-summary"><strong>${revMapping.length} column${revMapping.length === 1 ? "" : "s"}</strong> in ${esc(revFileLabel || "the file")}:
      ${nMapped} mapped to a field · ${nUnstored} recognised but <strong>not stored (no field here)</strong> · ${nIgnored} ignored.
      Nothing is read from a column until this table is right. Corrections are remembered <em>in this browser</em> for next week.
      
      ${revMapping.some((m) => REV_CARE_FIELDS.includes(m.key))
        ? `<br><strong id="rev-map-vuln-note">The vulnerable-customer column now lands.</strong> It used to be listed here as “not stored (no field here)” — the client record holds a vulnerability flag and a note, and this file writes to both. A “no” in that column is never written: it proposes nothing, so a flag somebody set here by hand is never cleared by a spreadsheet.`
        : ""}</p>
    <div class="rev-map-scroll"><table class="rev-map-table">
      <thead><tr><th>Their header</th><th>Our field</th><th>First value in the file</th></tr></thead>
      <tbody>${revMapping.map((m) => `
        <tr data-h="${m.i}" class="rev-${m.bucket}">
          <td class="rev-h">${esc(m.header || "(no heading)")}${m.remembered ? ' <span class="badge grey" title="You corrected this column before; the choice was remembered in this browser.">remembered</span>' : ""}
            ${m.bucket !== "mapped" ? `<span class="rev-why">${m.bucket === "unstored" ? "Not stored — " : "Ignored — "}${esc(m.why)}</span>` : ""}</td>
          <td><select class="rev-map-sel" data-h="${m.i}" aria-label="Field for ${esc(m.header)}">${revFieldOptionsHtml(m.key)}</select></td>
          <td class="rev-eg" title="${esc(eg(m))}">${esc(eg(m))}</td>
        </tr>`).join("")}</tbody>
    </table></div>
  </div>`;
}

/* ---- 12 · THE PREVIEW -------------------------------------------------- */
const REV_VERDICT_BADGE = {
  exact: ["green", "matched"],
  review: ["amber", "review"],
  new: ["blue", "new client"],
  quarantine: ["red", "needs attention"],
};
function revDiffTableHtml(r, diffs, scope) {
  if (!diffs.length) return "";
  const isNewCase = scope === "case" && r.caseMatch && r.caseMatch.verdict === "new";
  return `<table class="rev-diff-table"><thead><tr>
      <th>${scope === "case" ? "Case field" : "Client field"}</th><th>We hold</th><th>Revolution says</th><th>${isNewCase ? "" : "Do what"}</th>
    </tr></thead><tbody>
    ${diffs.map((d) => {
      const cls = d.state === "conflict" ? "rev-conflict" : d.state === "same" ? "rev-same" : "";
      const extra = d.state === "conflict"
        ? ' <span class="badge amber" title="Both sides hold a value and they disagree. Defaulted to KEEP: this database is where corrections get made by hand, and a weekly file must not overwrite one unasked.">conflict</span>'
        : d.state === "extend" ? ' <span class="badge grey" title="Everything we already hold is still in the incoming value — it is the same address written more fully.">adds detail</span>' : "";
      const held = d.state === "money" ? "—" : revShow(d.key, d.held);
      const control = d.state === "same"
        ? '<span class="badge grey">no change</span>'
        : d.state === "money"
          ? `<span class="badge grey" title="Firm money. The same rule as the CSV exports: the Owner sees every fee, an adviser sees their own case, an Administrator sees neither — so this sync leaves it alone rather than writing a figure it will not show you.">not shown / not written — money</span>`
          : isNewCase
            ? '<span class="badge blue">will be set</span>'
            : d.locked
            ? `<span class="badge grey" title="A completion date on a case that is still live would make it completed for every money report and live for every pipeline at the same time. Tick the stage move below and this unlocks.">tied to the stage decision</span>`
            : `<select class="rev-choice" data-i="${r.i}" data-f="${esc(d.key)}" data-scope="${scope}" aria-label="${esc(d.label)}">
                 <option value="keep" ${d.choice === "keep" ? "selected" : ""}>KEEP ours</option>
                 <option value="update" ${d.choice === "update" ? "selected" : ""}>UPDATE from Revolution</option>
               </select>${extra}${d.stale ? ' <span class="badge red" title="This value changed here between the preview and Apply, so the choice was reset to KEEP.">changed since you looked</span>' : ""}`;
      return `<tr class="${cls}" data-f="${esc(d.key)}"><td>${esc(d.label)}</td><td>${esc(held)}</td><td>${esc(revShow(d.key, d.incoming))}</td><td>${control}</td></tr>`;
    }).join("")}
  </tbody></table>`;
}
function revRowDetailHtml(r) {
  const bits = [];
  if (r.match === "review") {
    bits.push(`<div class="dq-notice"><strong>Which client is this?</strong> ${esc(r.matchReason)}.
      ${r.candidates.map((c) => `<button type="button" class="btn btn-sm rev-attach" data-i="${r.i}" data-cid="${c.id}">Attach to ${esc(clientFullName(c) || c.email || "this client")}</button>`).join(" ")}
      <button type="button" class="btn btn-sm rev-newclient" data-i="${r.i}">It's a new client</button>
      <button type="button" class="btn btn-sm rev-skip" data-i="${r.i}">Skip this row</button>
      ${r.clientId || r.forceNew ? ` <span class="badge green">decided — ${r.clientId ? "attaching to " + esc(clientFullName(revClients.find((c) => c.id === r.clientId) || {})) : "new client"}</span>` : ""}
      ${r.skipped ? ' <span class="badge grey">skipped</span>' : ""}</div>`);
  }
  if (!r.clientId && revRowIncluded(r)) {
    /* R13 · M-4: the care flag is called out on its own, with the same "will be set" badge the new-case diff
       uses, rather than being a fourth item in a dot-separated string. */
    bits.push(`<p class="rev-nostore">Creates a client: <strong>${esc(revRowName(r))}</strong>${r.v.date_of_birth ? ` · DOB ${esc(fmtD(r.v.date_of_birth))}` : ""}${r.g.email ? ` · ${esc(r.g.email)}` : ""}${r.address ? ` · ${esc(r.address)}` : ""}</p>`);
    if (r.v.is_vulnerable === true || r.v.vulnerability_note) {
      bits.push(`<p class="rev-nostore" data-rev-care="new"><strong>Vulnerable client${r.v.is_vulnerable === true ? "" : " note"}:</strong> ${r.v.vulnerability_note ? esc(r.v.vulnerability_note) : "flagged in the export, no reason given"} <span class="badge blue">will be set</span></p>`);
    }
  }
  if (r.clientId && (r.clientDiff || []).some((d) => d.state !== "same")) bits.push(revDiffTableHtml(r, r.clientDiff.filter((d) => d.state !== "same"), "client"));
  if (r.caseMatch) {
    bits.push(`<p class="rev-nostore"><strong>Case:</strong> ${r.caseMatch.verdict === "same" ? "same mortgage" : r.caseMatch.verdict === "new" ? "candidate new case" : "not matched"} — ${esc(r.caseMatch.reason)}</p>`);
    if (r.caseDiff && r.caseDiff.length) bits.push(revDiffTableHtml(r, r.caseDiff, "case"));
  }
  if (r.stageMove) {
    bits.push(`<div class="rev-stage-move">
      <label><input type="checkbox" class="rev-stage-ok" data-i="${r.i}" ${r.stageAccepted ? "checked" : ""}>
        Move this case from <strong>${esc(STAGE_LABEL[r.stageMove.from] || r.stageMove.from)}</strong> to <strong>${esc(STAGE_LABEL[r.stageMove.to] || r.stageMove.to)}</strong>?</label>
      <div>The file says so, but a stage is how this system decides what to chase — completing a case here starts the review, the fee chase and the rate-end clock. The sync never moves one on its own; tick it if it's right.</div>
    </div>`);
  }
  if (r.problems.length) {
    bits.push(`<p class="rev-nostore">${r.problems.map((p) => `<span class="badge ${p.bad ? "red" : "amber"}">${esc(p.text)}</span>`).join(" ")}</p>`);
  }
  /* EVERY ROW CAN BE LEFT OUT, not just the ones asking a question. A review row has always had "Skip this
     row" because it has a decision attached; a matched row could be emptied field by field… */
  if (r.match !== "review") {
    bits.push(`<p class="rev-nostore"><button type="button" class="btn btn-sm rev-toggle" data-i="${r.i}">${r.skipped ? "Put this row back in" : "Leave this row out"}</button>${r.skipped ? ' <span class="badge grey">left out — nothing is written for this row</span>' : ""}</p>`);
  }
  return bits.join("");
}
function renderRevPreview() {
  const el = $("#rev-preview");
  if (!el) return;
  if (!revRows.length) { el.innerHTML = ""; return; }
  const quarantined = revRows.filter((r) => r.match === "quarantine");
  const live = revRows.filter((r) => r.match !== "quarantine");
  const nExact = revRows.filter((r) => r.match === "exact").length;
  const nReview = revRows.filter((r) => r.match === "review").length;
  const nNew = revRows.filter((r) => r.match === "new").length;
  const nConflict = revRows.filter((r) => (r.caseDiff || []).concat(r.clientDiff || []).some((d) => d.state === "conflict")).length;
  const totals = revRows.reduce((a, r) => {
    const w = revRowWrites(r);
    a.fields += w.fields;
    w.creates.forEach((c) => { a[c] = (a[c] || 0) + 1; });
    return a;
  }, { fields: 0 });
  const unstored = revMapping.filter((m) => m.bucket === "unstored");
  el.innerHTML = `<div class="panel" id="rev-preview-panel">
    <h3>${revRows.length} row${revRows.length === 1 ? "" : "s"} — ${nExact} matched · ${nReview} to review · ${nNew} new · ${quarantined.length} needing attention</h3>
    <p class="panel-sub">${nConflict ? `<strong>${nConflict} row${nConflict === 1 ? " has" : "s have"} a field that disagrees with what we hold</strong> — those default to KEEP and are highlighted. ` : ""}Nothing below is written until you press Apply, and nothing here queues an email.</p>
    <div class="rev-rows-scroll"><table class="imp-table rev-rows-table" id="rev-rows">
      <colgroup><col style="width:34px;"><col style="width:20%;"><col style="width:27%;"><col style="width:19%;"><col></colgroup>
      <thead><tr><th>#</th><th>Client (from the file)</th><th>Match</th><th>Case</th><th>Would write</th></tr></thead>
      <tbody>${live.map((r) => {
        const w = revRowWrites(r);
        const b = REV_VERDICT_BADGE[r.match] || ["grey", r.match];
        const bits = [];
        if (w.creates.includes("client")) bits.push("creates client");
        if (w.creates.includes("case")) bits.push("creates case");
        if (w.fields) bits.push(`${w.fields} field${w.fields === 1 ? "" : "s"}`);
        return `<tr class="rev-row" data-i="${r.i}" data-v="${r.match}" data-case="${r.caseMatch ? r.caseMatch.verdict : "none"}" data-conflict="${(r.caseDiff || []).concat(r.clientDiff || []).some((d) => d.state === "conflict") ? "1" : "0"}" data-writes="${w.fields}">
            <td>${r.i + 1}</td>
            <td>${esc(revRowName(r))}${r.v.date_of_birth ? `<span class="rev-why">DOB ${esc(fmtD(r.v.date_of_birth))}</span>` : ""}</td>
            <td class="rev-verdict"><span class="badge ${b[0]}">${b[1]}</span><span class="rev-why">${esc(r.matchReason || "")}</span></td>
            <td>${r.caseMatch ? `<span class="badge ${r.caseMatch.verdict === "same" ? "green" : r.caseMatch.verdict === "new" ? "blue" : "grey"}">${r.caseMatch.verdict === "same" ? "same mortgage" : r.caseMatch.verdict === "new" ? "new case" : "not matched"}</span>` : ""}</td>
            <td>${bits.length ? esc(bits.join(" · ")) : '<span class="badge grey">nothing</span>'}</td>
          </tr>
          <tr class="rev-diff-row" data-i="${r.i}"><td colspan="5">${revRowDetailHtml(r)}</td></tr>`;
      }).join("")}</tbody>
    </table></div>
    ${unstored.length ? `<p class="rev-nostore"><strong>Not stored (no field here):</strong> ${unstored.map((m) => `<code>${esc(m.header)}</code>`).join(", ")}. Nothing in those columns is read — see the mapping table above for why, one by one.</p>` : ""}
    <div class="rev-apply-bar">
      <button class="btn btn-primary" id="rev-apply-btn">Apply the confirmed changes</button>
      <span class="panel-sub u-m0" id="rev-apply-note">${totals.client || 0} client${(totals.client || 0) === 1 ? "" : "s"} created · ${totals.case || 0} case${(totals.case || 0) === 1 ? "" : "s"} created · ${totals.fields} field${totals.fields === 1 ? "" : "s"} updated. No emails are queued.</span>
    </div>
  </div>
  ${quarantined.length ? `<div class="panel" id="rev-quarantine">
    <h3>${quarantined.length} row${quarantined.length === 1 ? "" : "s"} could not be used — unmatched / needs attention</h3>
    <p class="panel-sub">Nothing is written for these and nothing is guessed. They are listed so the file can be fixed at the Revolution end, which is where the data belongs.</p>
    
    <div class="rev-rows-scroll"><table class="imp-table" id="rev-quarantine-rows"><thead><tr><th>Row</th><th>What was in it</th><th>Why it was left</th></tr></thead>
    <tbody>${quarantined.map((r) => `<tr data-i="${r.i}"><td>${r.i + 1}</td>
      <td>${esc(r.cells.filter((c) => String(c || "").trim()).join(" · ").slice(0, 120) || "(every cell empty)")}</td>
      <td>${esc(r.matchReason)}${r.problems.map((p) => ` · ${esc(p.text)}`).join("")}</td></tr>`).join("")}</tbody></table></div>
  </div>` : ""}`;
}

/* 13 · READING THE BOOK Two reads, both firm-wide, both re-run at Apply time so the decision that gets
   written is made against the database as it is NOW… */
async function revFetchClients() {
  const { data, error } = await readAll(db.from("clients").select("id,first_name,last_name,email,phone,address,date_of_birth,is_vulnerable,vulnerability_note").order("id"));
  if (error) { console.error(error); return []; }
  return data || [];
}
async function revFetchCases() {
  const { data, error } = await readAll(db.from("cases")
    .select("id,client_id,stage,case_kind,lender,product_name,rate_type,rate_percent,rate_end_date,rate_end_estimated,erc_end_date,loan_amount,property_value,term_years,proc_fee,broker_fee,fee_status,protection_status,protection_commission,gi_status,lead_source,submitted_at,completed_at,assigned_to,updated_at").order("id"));
  if (error) { console.error(error); return []; }
  return data || [];
}
/* ---- 14 · "LAST IMPORT" Asked for as a weekly cadence stamp, and the honest answer is that this app has nowhere
   shared to put one: `settings` is Owner-only on write and the sync is admin work, and no schema change was
   available. … */
const revStampKey = () => `nx_revsync_${authUid || "anon"}`;
async function revLastSync() {
  const { data, error } = await db.from("case_notes").select("created_at,body")
    .ilike("body", "Revolution sync%").order("created_at", { ascending: false }).limit(1);
  if (!error && data && data.length) return { at: data[0].created_at, shared: true };
  const local = lsGet(revStampKey());
  return local ? { at: local, shared: false } : null;
}
async function renderRevLastSync() {
  const el = $("#rev-lastsync");
  if (!el) return;
  const s = await revLastSync();
  if (!s) { el.innerHTML = "No Revolution sync has been run from this system yet."; return; }
  const when = `${fmtD(String(s.at).slice(0, 10))}`;
  el.innerHTML = s.shared
    ? `Last import: <strong>${esc(when)}</strong> — taken from the sync notes this tool writes on the cases it touches, so everyone sees the same date.`
    : `Last import: <strong>${esc(when)}</strong> <span class="rev-caveat">— from this browser only (nothing was written last time, so there is no shared note to read). On another machine this line will be blank.</span>`;
}

/* ---- 15 · WIRING ------------------------------------------------------- */
function revReset(keepText) {
  revHeaders = []; revCells = []; revMapping = []; revRows = [];
  if (!keepText && $("#rev-text")) $("#rev-text").value = "";
  renderRevMapping(); renderRevPreview();
  const res = $("#rev-result"); if (res) res.innerHTML = "";
  const rb = $("#rev-reset-btn"); if (rb) rb.hidden = true;
  revSyncReadBtn();   // R75 · B1 — "Start again" empties the box, so the button follows it back
}
async function revRead() {
  const text = ($("#rev-text") && $("#rev-text").value || "").trim();
  if (!text) return toast("Choose the export file, or paste it in first");
  const parsed = revSplitRows(text);
  if (!parsed.headers.length || !parsed.rows.length) { $("#rev-status").textContent = ""; return toast("That doesn't look like an export — the first row must be the column headings, with the data under it"); }
  revHeaders = parsed.headers;
  revCells = parsed.rows;
  revMapping = revBuildMapping(revHeaders);
  $("#rev-status").textContent = "Matching against the book…";
  revClients = await revFetchClients();
  revCases = await revFetchCases();
  revBuildRows();
  const over = parsed.rows.length - revRows.length;
  $("#rev-status").textContent = `${revRows.length} row${revRows.length === 1 ? "" : "s"} read`
    + (over > 0 ? ` — only the first ${REV_ROW_CAP} are shown; run the rest as a second file` : "")
    + ". Check the column mapping, then the rows.";
  const rb = $("#rev-reset-btn"); if (rb) rb.hidden = false;
  renderRevMapping();
  renderRevPreview();
  // R75 · B1 — the box was filled programmatically (a file, or window.__rev.read),
  // which fires no `input` event; re-derive the button from what is now in it.
  revSyncReadBtn();
}
/* R90 · F — LOAD-ORDER ACCOMMODATION (the R81 · A1 recipe, repeated): #rev-file is NOT in the
   shipped markup — app.js's eval-time mountDropZone() CREATES it inside its *-file-slot div, and
   app.js now evaluates AFTER this file. So this one binding runs at DOMContentLoaded (which fires
   only after every classic script has evaluated) instead of at this script's own eval: same
   bind-once semantics, a few milliseconds later, still AFTER the drop zone's own readout listener;
   nothing can be clicked before DCL. The body is byte-identical to the old top-level statement. */
(() => {
  const wireRevFileInput = () => {
if ($("#rev-file")) {
  $("#rev-file").addEventListener("change", async () => {
    const file = $("#rev-file").files[0];
    if (!file) return;
    revFileLabel = file.name;
    try {
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        // The same SheetJS path the bulk import uses — one sheet, flattened to CSV.
        await ensureXlsx(); // R55 · F7 — lazy-loaded; the catch below reports a load failure
        const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        const sn = wb.SheetNames[0];
        $("#rev-text").value = XLSX.utils.sheet_to_csv(wb.Sheets[sn]);
      } else {
        $("#rev-text").value = await file.text();
      }
      $("#rev-status").textContent = `Loaded ${file.name} — now press “Read the export”.`;
    } catch (e) {
      toast("Could not read that file: " + e.message);
    }
    revSyncReadBtn();   // R75 · B1 — the file just filled the box; the button follows it
  });
}
  };   // R90 · F — end wireRevFileInput
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireRevFileInput);
  else wireRevFileInput();
})();
/* R75 · B1: "Read the export" is DISABLED until there is an export to read, with the reason in its own title.
   Same rule as ✨ Analyse with AI on the panel above: a primary button whose only answer to a press is a… */
function revSyncReadBtn() {
  const btn = $("#rev-read-btn");
  if (!btn) return;
  const box = $("#rev-text");
  const has = !!(box && box.value.trim());
  btn.disabled = !has;
  btn.title = has
    ? "Read the export and show, field by field, what it would change here. Nothing is written until you tick it."
    : "Nothing to read yet — drop the weekly client_data_export_V2 into the zone above, or paste it into the box.";
}
if ($("#rev-text")) $("#rev-text").addEventListener("input", revSyncReadBtn);
revSyncReadBtn();
if ($("#rev-read-btn")) $("#rev-read-btn").addEventListener("click", async () => {
  const btn = $("#rev-read-btn");
  btn.disabled = true;
  try { await revRead(); } catch (e) { console.error(e); dbFail("revSyncReadBtn", e); $("#rev-status").textContent = ""; }
  finally { btn.disabled = false; }
});
if ($("#rev-reset-btn")) $("#rev-reset-btn").addEventListener("click", () => { revReset(false); $("#rev-status").textContent = ""; });
/* Correcting a column re-reads the whole file through the new mapping — the rows, the matches and the diffs
   all derive from it, so nothing is left showing a verdict that was reached under the old one. */
if ($("#rev-mapping")) $("#rev-mapping").addEventListener("change", async (e) => {
  const sel = e.target.closest(".rev-map-sel");
  if (!sel) return;
  const i = Number(sel.dataset.h);
  const m = revMapping[i];
  if (!m) return;
  revRememberMap(m.norm, sel.value || "");
  revMapping = revBuildMapping(revHeaders);
  revBuildRows();
  renderRevMapping();
  renderRevPreview();
});
if ($("#rev-preview")) {
  $("#rev-preview").addEventListener("change", (e) => {
    const sel = e.target.closest(".rev-choice");
    if (sel) {
      const r = revRows[Number(sel.dataset.i)];
      if (!r) return;
      const list = sel.dataset.scope === "client" ? r.clientDiff : r.caseDiff;
      const d = (list || []).find((x) => x.key === sel.dataset.f);
      if (d) d.choice = sel.value;
      renderRevPreview();
      return;
    }
    const cb = e.target.closest(".rev-stage-ok");
    if (cb) {
      const r = revRows[Number(cb.dataset.i)];
      if (!r) return;
      r.stageAccepted = cb.checked;
      if (r.stageMove) r.stageMove.accepted = cb.checked;
      revApplyStageLock(r);
      renderRevPreview();
    }
  });
  $("#rev-preview").addEventListener("click", (e) => {
    const el = e.target.closest(".rev-attach, .rev-newclient, .rev-skip, .rev-toggle, #rev-apply-btn");
    if (!el) return;
    if (el.id === "rev-apply-btn") { revApply(); return; }
    const r = revRows[Number(el.dataset.i)];
    if (!r) return;
    /* Leave-out / put-back only flips the flag: the row's identity decision (which client,
       which case) is untouched, so putting it back gives exactly the row that was there. */
    if (el.classList.contains("rev-toggle")) { r.skipped = !r.skipped; revResolveRow(r); renderRevPreview(); return; }
    if (el.classList.contains("rev-attach")) { r.clientId = el.dataset.cid; r.forceNew = false; r.skipped = false; }
    else if (el.classList.contains("rev-newclient")) { r.clientId = null; r.forceNew = true; r.skipped = false; }
    else { r.clientId = null; r.forceNew = false; r.skipped = true; }
    revResolveRow(r);
    renderRevPreview();
  });
}

/* 16 · APPLY Writes ONLY what is on screen as confirmed, in this order per row: the client, then the case,
   then the note that records what was done. Three things it deliberately never does… */
const revLbl = (label) => {
  const s = String(label || "");
  const first = s.split(" ")[0] || "";
  return first && first === first.toUpperCase() && /[A-Z]/.test(first) ? s : s.charAt(0).toLowerCase() + s.slice(1);
};
function revNoteBody(parts, prefix) {
  const day = fmtD(localDateStr());
  return `Revolution sync ${day}: ${prefix ? prefix + (parts.length ? " — " : "") : ""}${parts.join(", ")}`.replace(/\s+$/, "");
}
/* Re-derive a row against the book as it is NOW, keeping the operator's choices — except where the held value
   itself moved, which forces KEEP and flags the row. */
function revRefreshRow(r) {
  const prevCase = {}, prevClient = {};
  (r.caseDiff || []).forEach((d) => { prevCase[d.key] = { choice: d.choice, held: d.held }; });
  (r.clientDiff || []).forEach((d) => { prevClient[d.key] = { choice: d.choice, held: d.held }; });
  revResolveRow(r);
  const restore = (list, prev) => (list || []).forEach((d) => {
    const p = prev[d.key];
    if (!p) return;
    if (!revSame(d.key, p.held, d.held)) { d.choice = "keep"; d.stale = true; }
    else d.choice = p.choice;
  });
  restore(r.caseDiff, prevCase);
  restore(r.clientDiff, prevClient);
  revApplyStageLock(r);
  return r;
}
async function revApply() {
  const btn = $("#rev-apply-btn");
  const rows = revRows.filter(revRowIncluded);
  if (!rows.length) return toast("Nothing is confirmed yet — decide the rows that need a decision first");
  if (btn) btn.disabled = true;
  $("#rev-status").textContent = "Writing the confirmed changes…";
  // The same discipline as the bulk import: re-read, then decide.
  revClients = await revFetchClients();
  revCases = await revFetchCases();
  const log = [];
  let nClients = 0, nCases = 0, nFields = 0, nNotes = 0, nNoteFail = 0, nStale = 0, nStageMoved = 0, nMoneySkipped = 0;
  const touched = new Map();
  const sameRunClients = new Map();   // key → client row created earlier in THIS run
  const runKey = (r) => (r.g.email ? r.g.email.trim().toLowerCase() : clientNameKey(revRowName(r)) + "|" + (r.v.date_of_birth || ""));
  for (const r of rows) {
    const name = revRowName(r);
    try {
      // A brand-new client this run already created (the same person twice in one file).
      if (!r.clientId && sameRunClients.has(runKey(r))) r.clientId = sameRunClients.get(runKey(r));
      revRefreshRow(r);
      if ((r.caseDiff || []).concat(r.clientDiff || []).some((d) => d.stale)) nStale++;
      let clientRow = r.clientId ? revClients.find((c) => c.id === r.clientId) : null;
      const noteParts = [];
      let madeClient = false, clientFields = 0;
      /* ---- the client ---- */
      if (!clientRow) {
        let first = (r.g.first_name || "").trim(), last = (r.g.last_name || "").trim();
        if (!last && first) { last = first; first = ""; }   // splitName's rule: a lone name is a surname
        const ins = await db.from("clients").insert({
          first_name: first || null, last_name: last || null,
          email: r.g.email || null, phone: r.g.phone || null,
          date_of_birth: r.v.date_of_birth || null,
          address: r.address || null,
          /* R13 · M-4 — a NEW client created from the export carries the care flag in with them. */
          ...(r.v.is_vulnerable === true ? { is_vulnerable: true } : {}),
          ...(r.v.vulnerability_note ? { vulnerability_note: r.v.vulnerability_note } : {}),
        }).select().single();
        if (ins.error) throw ins.error;
        clientRow = ins.data;
        revClients.push(clientRow);
        sameRunClients.set(runKey(r), clientRow.id);
        r.clientId = clientRow.id;
        nClients++;
        madeClient = true;
        invalidateClientPicker(); // R18-P6 — importer-created clients must appear in the case-modal picker
      } else {
        const patch = {};
        (r.clientDiff || []).forEach((d) => {
          if (d.choice !== "update" || d.state === "same") return;
          patch[d.key === "address" ? "address" : d.key] = d.incoming;
          noteParts.push(d.state === "conflict" ? `updated ${revLbl(d.label)} (${revShow(d.key, d.held)} → ${revShow(d.key, d.incoming)})` : d.state === "extend" ? `extended ${revLbl(d.label)} (${revShow(d.key, d.incoming)})` : `filled ${revLbl(d.label)} (${revShow(d.key, d.incoming)})`);
        });
        if (Object.keys(patch).length) {
          const up = await db.from("clients").update(patch).eq("id", clientRow.id);
          if (up.error) throw up.error;
          Object.assign(clientRow, patch);
          clientFields = Object.keys(patch).length;
          nFields += clientFields;
        }
      }
      touched.set(clientRow.id, [clientRow.first_name, clientRow.last_name].filter(Boolean).join(" ") || name);
      /* ---- the case ---- */
      const cm = r.caseMatch || { verdict: "none", reason: "" };
      let caseId = null, created = false, caseFields = 0;
      if (cm.verdict === "same" && cm.caseId) {
        const caseRow = revCases.find((c) => c.id === cm.caseId);
        const patch = {};
        (r.caseDiff || []).forEach((d) => {
          if (d.choice !== "update" || d.state === "same" || d.state === "money") return;
          patch[REV_CASE_COL[d.key] || d.key] = d.key === "completed_date" ? new Date(d.incoming + "T12:00:00").toISOString() : d.incoming;
          noteParts.push(d.state === "conflict" ? `updated ${revLbl(d.label)} (${revShow(d.key, d.held)} → ${revShow(d.key, d.incoming)})` : d.state === "extend" ? `extended ${revLbl(d.label)} (${revShow(d.key, d.incoming)})` : `filled ${revLbl(d.label)} (${revShow(d.key, d.incoming)})`);
        });
        if ((r.caseDiff || []).some((d) => d.state === "money")) nMoneySkipped++;
        // A rate end that came from the network's own export is not an estimate.
        if (patch.rate_end_date && caseRow && caseRow.rate_end_estimated) { patch.rate_end_estimated = false; noteParts.push("rate end no longer marked estimated"); }
        if (r.stageMove && r.stageAccepted) {
          patch.stage = r.stageMove.to;
          noteParts.push(`stage moved ${STAGE_LABEL[r.stageMove.from] || r.stageMove.from} → ${STAGE_LABEL[r.stageMove.to] || r.stageMove.to} (confirmed on the row)`);
          nStageMoved++;
        }
        caseFields = Object.keys(patch).length;
        if (caseFields) {
          const up = await db.from("cases").update(patch).eq("id", cm.caseId);
          if (up.error) throw up.error;
          Object.assign(caseRow || {}, patch);
          nFields += caseFields;
        }
        caseId = cm.caseId;
      } else if (cm.verdict === "new") {
        const moneyOk = revMoneyOk({ assigned_to: (ME && ME.id) || null });
        const row = { client_id: clientRow.id, case_kind: r.v.case_kind || "other", stage: r.v.stage || "enquiry", assigned_to: (ME && ME.id) || null };
        REV_CASE_DIFF.forEach((k) => {
          const val = r.v[k];
          if (val == null || val === "") return;
          if (REV_MONEY_FIELDS.has(k) && !moneyOk) return;
          if (k === "completed_date") row.completed_at = new Date(val + "T12:00:00").toISOString();
          else row[k] = val;
        });
        if (!moneyOk && REV_CASE_DIFF.some((k) => REV_MONEY_FIELDS.has(k) && r.v[k] != null)) nMoneySkipped++;
        const ins = await db.from("cases").insert(row).select("id").single();
        if (ins.error) throw ins.error;
        caseId = ins.data.id;
        created = true;
        nCases++;
        revCases.push(Object.assign({ id: caseId }, row));
      }
      /* ---- the note: the only record that this case was touched by a sync,
              and the thing the "last import" stamp is read back out of ---- */
      if (caseId && (created || noteParts.length)) {
        const body = created
          ? revNoteBody([], `case created from the Stonebridge export${r.v.lender ? ` — ${r.v.lender}` : ""}${r.v.rate_end_date ? `, rate ends ${fmtD(r.v.rate_end_date)}` : ""}`)
          : revNoteBody(noteParts);
        const full = body + (r.g.note ? ` | File note: ${r.g.note}` : "");
        const ne = await db.from("case_notes").insert({ case_id: caseId, body: full });
        if (ne.error) nNoteFail++; else nNotes++;
      }
      /* The outcome line is computed from what was actually WRITTEN on this row — never from what the preview
         predicted — so a row that half-failed can never be summarised as a success. */
      const rowFields = caseFields + clientFields;
      const outcome = madeClient
        ? (created ? "created client + case" : "created client")
        : created
          ? (rowFields ? `created case, updated ${rowFields} field${rowFields === 1 ? "" : "s"}` : "created case")
          : rowFields ? `updated ${rowFields} field${rowFields === 1 ? "" : "s"}` : "no change";
      log.push({ row: r.i + 1, name, outcome, detail: cm.reason || r.matchReason || "" });
      r.applied = true;
    } catch (e) {
      console.error(e);
      log.push({ row: r.i + 1, name, outcome: "FAILED", detail: e.message || String(e) });
    }
  }
  const skipped = revRows.filter((x) => !revRowIncluded(x));
  skipped.forEach((r) => log.push({ row: r.i + 1, name: revRowName(r), outcome: r.match === "quarantine" ? "quarantined — nothing written" : "skipped — nothing confirmed", detail: r.matchReason || "" }));
  log.sort((a, b) => a.row - b.row);
  lsSet(revStampKey(), new Date().toISOString());
  if (btn) btn.disabled = false;
  $("#rev-status").textContent = "";
  const fails = log.filter((l) => l.outcome === "FAILED").length;
  toast(`Revolution sync: ${nClients} client${nClients === 1 ? "" : "s"} created · ${nCases} case${nCases === 1 ? "" : "s"} created · ${nFields} field${nFields === 1 ? "" : "s"} updated · ${nNotes} note${nNotes === 1 ? "" : "s"} written · 0 emails queued${fails ? ` · ${fails} failed` : ""}`);
  $("#rev-result").innerHTML = `<div class="panel" id="rev-result-panel">
    <h3>Sync complete — ${nClients} client${nClients === 1 ? "" : "s"} created, ${nCases} case${nCases === 1 ? "" : "s"} created, ${nFields} field${nFields === 1 ? "" : "s"} updated</h3>
    <p class="panel-sub" id="rev-no-emails"><strong>0 emails were queued</strong> — this tool never queues one. ${nStageMoved ? `${nStageMoved} case stage${nStageMoved === 1 ? " was" : "s were"} moved, each one ticked by you.` : "No case stage was moved."}
      ${nNoteFail ? ` ⚠ ${nNoteFail} sync note${nNoteFail === 1 ? "" : "s"} could not be written, so ${nNoteFail === 1 ? "that case" : "those cases"} carries no record of what this run changed.` : ""}
      ${nStale ? ` ⚠ ${nStale} row${nStale === 1 ? " had a field that" : "s had fields that"} changed here between the preview and the press — those were left alone.` : ""}
      ${nMoneySkipped ? ` ${nMoneySkipped} row${nMoneySkipped === 1 ? "'s" : "s'"} fee columns were not written (firm money — not yours to see on this screen).` : ""}</p>
    <table class="imp-table rev-outcome-table" id="rev-outcome"><thead><tr><th>Row</th><th>Client</th><th>Outcome</th><th>Why</th></tr></thead>
      <tbody>${log.map((l) => `<tr data-row="${l.row}" data-outcome="${esc(l.outcome)}"><td>${l.row}</td><td>${esc(l.name)}</td>
        <td>${l.outcome === "FAILED" ? `<span class="badge red">failed</span>` : l.outcome === "no change" ? `<span class="badge grey">no change</span>` : `<span class="badge green">${esc(l.outcome)}</span>`}</td>
        <td>${esc(l.detail)}</td></tr>`).join("")}</tbody></table>
    ${touched.size ? `<div class="row-list">${[...touched.entries()].map(([id, n]) => `<div class="row-item"><div class="row-main"><a href="#" class="t" onclick="event.preventDefault();openClient('${id}')">${esc(n)}</a></div></div>`).join("")}</div>` : ""}
  </div>`;
  // Re-derive every row against what is now stored: a second press writes nothing. The "changed since you
  // looked" marks are carried ACROSS that re-derive on purpose…
  revClients = await revFetchClients();
  revCases = await revFetchCases();
  revRows.forEach((r) => {
    if (r.match === "quarantine") return;
    const wasStale = new Set((r.caseDiff || []).concat(r.clientDiff || []).filter((d) => d.stale).map((d) => d.key));
    r.stageAccepted = false; r.stageMove = null;
    revResolveRow(r);
    if (wasStale.size) (r.caseDiff || []).concat(r.clientDiff || []).forEach((d) => { if (wasStale.has(d.key)) d.stale = true; });
  });
  renderRevPreview();
  renderRevLastSync();
}

/* 17 · TEST HOOKS Read-only views of the same objects the screen is drawn from. Nothing here writes, and
   nothing in app.js reads them. */
window.__rev = {
  mapping: () => revMapping.map((m) => ({ header: m.header, norm: m.norm, key: m.key, bucket: m.bucket, why: m.why, remembered: m.remembered, recognisedAs: m.recognisedAs || null })),
  rows: () => revRows.map((r) => ({
    i: r.i, name: revRowName(r), match: r.match, reason: r.matchReason, clientId: r.clientId,
    caseVerdict: r.caseMatch ? r.caseMatch.verdict : null, caseId: r.caseMatch ? r.caseMatch.caseId || null : null,
    caseReason: r.caseMatch ? r.caseMatch.reason : null,
    included: revRowIncluded(r), writes: revRowWrites(r),
    diffs: (r.caseDiff || []).map((d) => ({ key: d.key, state: d.state, choice: d.choice, held: d.held, incoming: d.incoming, locked: !!d.locked })),
    clientDiffs: (r.clientDiff || []).map((d) => ({ key: d.key, state: d.state, choice: d.choice, held: d.held, incoming: d.incoming })),
    stageMove: r.stageMove ? { from: r.stageMove.from, to: r.stageMove.to, accepted: !!r.stageAccepted } : null,
    problems: r.problems.map((p) => p.text),
  })),
  read: () => revRead(),
  apply: () => revApply(),
  setChoice: (i, key, choice, scope) => {
    const r = revRows[i];
    if (!r) return false;
    const d = ((scope === "client" ? r.clientDiff : r.caseDiff) || []).find((x) => x.key === key);
    if (!d) return false;
    d.choice = choice;
    renderRevPreview();
    return true;
  },
  setMap: (headerNorm, key) => { revRememberMap(headerNorm, key); return revMapRemembered(); },
  forgetMap: () => { lsSet(revMapStoreKey(), "{}"); return true; },
  lastSync: () => revLastSync(),
};
/* Drawn when the Import page is opened (see nav()), not at load: this is a
   database read and there is no session yet when this file is evaluated. */

/* R90 · F: deploy handshake stamp. Every round that edits ANY of index.html / core.js / reports-money.js /
   diary.js / import.js / vault.js / app.js bumps the tag IN ALL SEVEN PLACES. */
window.__nxTag_import = "r90";   // R89 — the CTO bumps all seven to r90 at the gate
