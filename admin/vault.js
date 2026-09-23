/* ==========================================================================
   NexMoney Back Office — admin/vault.js  (R90 · F)
   R14's VAULT (the company password safe) and the shared copy/reveal plumbing (window.nexCopy + the
   one delegated click handler the case modal's security card also uses), carved from app.js.
   SCRIPT ORDER: core.js → reports-money.js → diary.js → import.js → vault.js →
   app.js. THE DEFINITION-TIME RULE (HARNESS.md "R78 · A" / "R81 · A"): a declaration here may
   reference nothing from a LATER script at its own definition time (call-time references are fine);
   app.js stays LAST because init()'s awaits run between classic scripts (see reports-money.js).
   The two document click listeners register before app.js's; they are independent, so order is unobservable.
   ========================================================================== */

/* R14: THE VAULT (company password safe) + shared copy/reveal Two Daniel features share the clipboard
   plumbing below: this page and the case modal's security-check card. */

/* Clipboard, robustly: the async API where it exists, a hidden-textarea execCommand fallback where it
   doesn't. Both paths toast honestly; a failure says "copy it by hand" rather than lying that it worked. */
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) { toast("Couldn't copy — select the value and copy it by hand."); }
}
window.nexCopy = function (text, label) {
  const t = text == null ? "" : String(text);
  if (!t) { toast("Nothing to copy."); return; }
  const done = () => toast((label ? label + " " : "") + "copied");
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => fallbackCopy(t, done));
    else fallbackCopy(t, done);
  } catch (e) { fallbackCopy(t, done); }
};
/* One delegated handler for every copy/reveal affordance the two features paint, so cards re-rendered on each
   search keystroke never need re-wiring: · .vf-copy / .vf-reveal — a vault field; · [data-nexcopy]… */
document.addEventListener("click", (e) => {
  const cp = e.target.closest(".vf-copy");
  if (cp) {
    e.preventDefault();
    const field = cp.closest(".vault-field");
    const valEl = field && field.querySelector(".vf-value");
    const lbl = field && field.querySelector(".vf-label");
    nexCopy(valEl ? valEl.getAttribute("data-val") : "", lbl ? lbl.textContent : "");
    return;
  }
  const rev = e.target.closest(".vf-reveal");
  if (rev) {
    e.preventDefault();
    const field = rev.closest(".vault-field");
    const valEl = field && field.querySelector(".vf-value");
    if (!valEl) return;
    const shown = valEl.getAttribute("data-shown") === "1";
    valEl.setAttribute("data-shown", shown ? "0" : "1");
    valEl.textContent = shown ? "••••••••" : (valEl.getAttribute("data-val") || "");
    rev.textContent = shown ? "👁" : "🙈";
    rev.title = shown ? "Show" : "Hide";
    return;
  }
  const nx = e.target.closest("[data-nexcopy]");
  if (nx) { e.preventDefault(); nexCopy(nx.getAttribute("data-nexcopy"), nx.getAttribute("data-copylabel") || ""); }
});

// Friendly headings, in display order. The chip row and the grouping both read this.
const VAULT_CATS = [
  ["lender", "Lenders"],
  ["protection", "Protection"],
  ["gi", "GI"],
  ["admin", "Admin & systems"],
  ["contact", "Contacts"],
  ["other", "Other"],
];
const VAULT_CAT_LABEL = Object.fromEntries(VAULT_CATS.map(([k, l]) => [k, l]));
const VAULT_CAT_INDEX = Object.fromEntries(VAULT_CATS.map(([k], i) => [k, i]));
// owner_label is a fixed short set; colour-coded, with Shared deliberately its own hue.
const VAULT_OWNERS = [
  { v: "", l: "— none —" },
  { v: "Daniel", l: "Daniel" },
  { v: "Luke", l: "Luke" },
  { v: "Wayne", l: "Wayne" },
  { v: "Shared", l: "Shared" },
];
const VAULT_OWNER_CLASS = { Daniel: "vault-owner-daniel", Luke: "vault-owner-luke", Wayne: "vault-owner-wayne", Shared: "vault-owner-shared" };
let VAULT_ROWS = [];
let vaultCategory = "all";
let vaultSearch = "";
// R73 · B5 — the vault's empty state names the term and offers to drop it.
function vaultSearchTerm() { return String(vaultSearch || "").trim(); }
window.clearVaultSearch = function () {
  vaultSearch = "";
  const box = $("#vault-search"); if (box) box.value = "";
  renderVault();
};
let vaultLoaded = false;

function vaultMatch(r, q) {
  if (!q) return true;
  /* R83: a SECRET field's value is never searched. It was: the haystack carried every field's value
     regardless of the secret tick, so typing a password filtered the list to its card… */
  const hay = [r.name, r.owner_label, r.note]
    .concat(Array.isArray(r.fields) ? r.fields.reduce((a, f) => a.concat(f && f.secret ? [f.label] : [f && f.label, f && f.value]), []) : [])   // R83
    .filter(Boolean).join(" ").toLowerCase();
  return hay.indexOf(q) >= 0;
}
async function loadVault() {
  const list = $("#vault-list");
  if (!list) return;
  if (!vaultLoaded) list.innerHTML = '<div class="empty">Loading the vault…</div>';
  let res;
  try { res = await db.from("vault_entries").select("*"); }
  catch (e) { res = { error: (e && { message: String(e.message || e) }) || { message: "unknown" } }; }
  if (res && res.error) {
    renderLoadError("#vault-list", res.error, loadVault);
    return;
  }
  VAULT_ROWS = (res && res.data) || [];
  vaultLoaded = true;
  renderVault();
}
function renderVaultSegments() {
  const wrap = $("#vault-segment");
  if (!wrap) return;
  const q = (vaultSearch || "").trim().toLowerCase();
  const searched = VAULT_ROWS.filter((r) => vaultMatch(r, q));
  const count = (k) => k === "all" ? searched.length : searched.filter((r) => (r.category || "other") === k).length;
  const chips = [["all", "All"]].concat(VAULT_CATS);
  wrap.innerHTML = chips.map(([k, l]) =>
    `<button class="seg-btn${vaultCategory === k ? " active" : ""}" aria-pressed="${vaultCategory === k}" data-seg="${esc(k)}">${esc(l)} <span class="seg-count">${count(k)}</span></button>`
  ).join("");
  wrap.querySelectorAll(".seg-btn").forEach((b) => (b.onclick = () => {
    if (b.dataset.seg === vaultCategory) return;
    vaultCategory = b.dataset.seg;
    renderVault();
  }));
}
function vaultOwnerChip(label) {
  if (!label) return "";
  const cls = VAULT_OWNER_CLASS[label] || "vault-owner-other";
  return `<span class="vault-owner ${cls}">${esc(label)}</span>`;
}
function vaultVisChip(r) {
  const vt = Array.isArray(r.visible_to) ? r.visible_to.filter(Boolean) : [];
  if (vt.length) {
    const roles = vt.map((x) => String(x).charAt(0).toUpperCase() + String(x).slice(1)).join(", ");
    return `<span class="vault-vis vault-vis-restricted" title="Restricted: only these roles can see this entry — ${esc(roles)}. Set under ‘Who can see this’.">🔒 Restricted · ${esc(roles)}</span>`;
  }
  /* R87 · owner-admin (05 #13) — the default is not a badge. "Everyone" on 11 of 12 cards said
     nothing; only a RESTRICTED entry earns a chip. */
  return "";
}
function vaultFieldHtml(f) {
  if (!f || (f.label == null && f.value == null)) return "";
  const label = f.label || "";
  const val = f.value == null ? "" : String(f.value);
  const secret = !!f.secret;
  const has = val !== "";
  const display = !has ? "—" : (secret ? "••••••••" : val);
  const reveal = `<button type="button" class="btn btn-sm vf-reveal" title="Show" aria-label="Show ${esc(label)}">👁</button>`;
  const copy = `<button type="button" class="btn btn-sm vf-copy" title="Copy ${esc(label)}" aria-label="Copy ${esc(label)}">⧉</button>`;
  const btns = !has ? "" : (secret ? reveal + copy : copy);
  return `<div class="vault-field${secret ? " is-secret" : ""}">
    <span class="vf-label">${esc(label)}</span>
    <span class="vf-value" data-val="${esc(val)}" data-shown="0">${esc(display)}</span>
    ${btns}
  </div>`;
}
/* R37 · K4: WHICH "Test Bank A" IS THIS? Three entries share a name and differ only by a small owner pill, and the
   one fact that actually tells them apart — the login they are FOR — was four lines further down inside the fields
   block, below the fold on a grouped list. Two rules, both non-negotiable: · NEVER A SECRET. … */
const VAULT_USER_LABEL_RE = /user\s*name|username|user\b|login|log-?in|e-?mail|account|agency|member(ship)?|client\s*id|broker\s*(id|no|number|ref)/i;
function vaultUserToken(r) {
  const fields = Array.isArray(r.fields) ? r.fields : [];
  const f = fields.find((x) => x && !x.secret && x.value != null && String(x.value).trim() !== ""
    && VAULT_USER_LABEL_RE.test(String(x.label || "")));
  if (!f) return "";
  const val = String(f.value).trim();
  return `<span class="vault-user" title="${esc(String(f.label || "Login"))} on this entry — the field that tells two entries with the same name apart. Never a password.">${esc(val)}</span>`;
}
function vaultCardHtml(r) {
  const fields = Array.isArray(r.fields) ? r.fields : [];
  /* R87 · owner-admin (05 #13): ONE COPY AFFORDANCE PER SECRET. The head's "🔑 Copy password" duplicated the
     ⧉ on the password row; the row keeps Reveal + Copy, the head keeps Edit. */
  return `<div class="vault-card" data-id="${esc(r.id)}">
    <div class="vault-card-head">
      <div class="vault-card-title">
        <span class="vault-name">${esc(r.name || "(no name)")}</span>
        ${vaultUserToken(r)}
        ${vaultOwnerChip(r.owner_label)}
        ${vaultVisChip(r)}
      </div>
      <div class="vault-card-actions">
        <button type="button" class="btn btn-sm vault-edit" data-id="${esc(r.id)}">Edit</button>
        ${isAdminOrOwner() ? `<details class="vault-more" data-id="${esc(r.id)}"><summary class="btn btn-sm vault-more-btn" role="button" aria-label="More actions for ${esc(r.name || "this entry")}" title="More actions">⋯</summary><div class="vault-more-menu"><button type="button" class="btn btn-sm btn-danger vault-del" data-id="${esc(r.id)}">Delete</button></div></details>` : ""}
      </div>
    </div>
    <div class="vault-fields">${fields.map(vaultFieldHtml).join("") || '<span class="empty">No fields recorded.</span>'}</div>
    ${r.note ? `<div class="vault-note">${esc(r.note)}</div>` : ""}
  </div>`;
}
function renderVault() {
  const list = $("#vault-list");
  if (!list) return;
  renderVaultSegments();
  const q = (vaultSearch || "").trim().toLowerCase();
  let rows = VAULT_ROWS.filter((r) => vaultMatch(r, q));
  if (vaultCategory !== "all") rows = rows.filter((r) => (r.category || "other") === vaultCategory);
  rows.sort((a, b) => {
    const ca = VAULT_CAT_INDEX[a.category] == null ? 99 : VAULT_CAT_INDEX[a.category];
    const cb = VAULT_CAT_INDEX[b.category] == null ? 99 : VAULT_CAT_INDEX[b.category];
    if (ca !== cb) return ca - cb;
    const sa = a.sort_order == null ? 0 : a.sort_order, sb = b.sort_order == null ? 0 : b.sort_order;
    if (sa !== sb) return sa - sb;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
  if (!rows.length) {
    // R73 · B5 — was a bare grey sentence for the searched case and a different card
    // shape for the truly-empty one. One component, both cases.
    list.innerHTML = VAULT_ROWS.length
      ? emptyState({
          headline: "No entries match your search",
          sub: `Nothing in the vault matches “${vaultSearchTerm()}”. It searches the name, the owner and the username — not the secrets themselves.`,
          action: { label: "Clear the search", id: "vault-empty-clear", onclick: "clearVaultSearch()" },
        })
      : emptyState({
          headline: "The vault is empty",
          sub: "Add the first company login with the “+ New entry” button above.",
        });
    return;
  }
  const byCat = {};
  rows.forEach((r) => { const k = r.category || "other"; (byCat[k] = byCat[k] || []).push(r); });
  const groups = [];
  VAULT_CATS.forEach(([k, l]) => { if (byCat[k]) groups.push([k, l, byCat[k]]); });
  Object.keys(byCat).forEach((k) => { if (VAULT_CAT_INDEX[k] == null) groups.push([k, VAULT_CAT_LABEL[k] || k, byCat[k]]); });
  /* R87 · owner-admin (05 #13) — with a category chip selected the chip already says the group's
     name, so the heading over the (single) group would print it twice. */
  const oneCat = vaultCategory !== "all";
  list.innerHTML = groups.map(([k, l, items]) =>
    `<div class="vault-group" data-cat="${esc(k)}">${oneCat ? "" : `<h3 class="vault-group-head">${esc(l)} <span class="seg-count">${items.length}</span></h3>`}${items.map(vaultCardHtml).join("")}</div>`
  ).join("");
  // Close any open ⋯ menu when the pointer leaves the list or another card's menu opens.
  list.querySelectorAll("details.vault-more").forEach((d) => { d.addEventListener("toggle", () => { if (d.open) list.querySelectorAll("details.vault-more[open]").forEach((o) => { if (o !== d) o.open = false; }); }); });
}
function vaultEditorFieldRowHtml(f) {
  f = f || { label: "", value: "", secret: false };
  return `<div class="ve-field-row">
    <input class="ve-f-label" placeholder="Label (e.g. Username)" value="${esc(f.label || "")}" aria-label="Field label">
    <input class="ve-f-value" placeholder="Value" value="${esc(f.value == null ? "" : f.value)}" aria-label="Field value">
    <label class="ve-f-secret" title="Hide this value behind a Reveal toggle on the card"><input type="checkbox" ${f.secret ? "checked" : ""}> secret</label>
    <button type="button" class="btn btn-sm ve-f-up" title="Move up" aria-label="Move field up">↑</button>
    <button type="button" class="btn btn-sm ve-f-down" title="Move down" aria-label="Move field down">↓</button>
    <button type="button" class="btn btn-sm ve-f-del" title="Remove this field" aria-label="Remove field">✕</button>
  </div>`;
}
/* The editor — add (entry=null) or edit. An overlay rather than the record modal: it is fully
   self-contained (no history deep-link, no dirty-guard fields to register) and openOverlay already
   handles Escape / backdrop / focus / browser-Back. */
function openVaultEditor(entry) {
  const isNew = !entry;
  const e = entry || { name: "", category: (vaultCategory !== "all" ? vaultCategory : "lender"), owner_label: "", fields: [{ label: "", value: "", secret: false }], note: "", visible_to: null };
  const fields = Array.isArray(e.fields) && e.fields.length ? e.fields : [{ label: "", value: "", secret: false }];
  const canGate = isAdminOrOwner();   // mirrors is_admin_or_owner(): advisers never see the gate control
  const vt = Array.isArray(e.visible_to) ? e.visible_to : [];
  const html = `<div class="vault-editor">
    <h3>${isNew ? "New vault entry" : "Edit vault entry"}</h3>
    <label class="ve-full">Name<input id="ve-name" value="${esc(e.name || "")}" placeholder="e.g. Halifax Intermediaries portal"></label>
    <div class="ve-row2">
      <label>Category<select id="ve-cat">${VAULT_CATS.map(([k, l]) => `<option value="${k}" ${k === (e.category || "lender") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label>Owner<select id="ve-owner">${VAULT_OWNERS.map((o) => `<option value="${esc(o.v)}" ${o.v === (e.owner_label || "") ? "selected" : ""}>${esc(o.l)}</option>`).join("")}</select></label>
    </div>
    <div class="ve-fields-head">Fields <span class="panel-sub">label, value, and whether it's a secret (hidden until revealed)</span></div>
    <div id="ve-fields">${fields.map(vaultEditorFieldRowHtml).join("")}</div>
    <button type="button" class="btn btn-sm" id="ve-add-field">+ Add field</button>
    <label class="ve-full u-mt-12">Note<textarea id="ve-note" rows="2" placeholder="Anything else worth recording">${esc(e.note || "")}</textarea></label>
    ${canGate ? `<div class="ve-gate">
      <div class="ve-gate-head">Who can see this <span class="panel-sub">the future-gating switch. Leave all unticked and every staff member can see this entry (today's behaviour). Tick roles to restrict it to only those roles — the database enforces it.</span></div>
      <label class="ve-gate-opt"><input type="checkbox" class="ve-vt" value="owner" ${vt.indexOf("owner") >= 0 ? "checked" : ""}> Owner</label>
      <label class="ve-gate-opt"><input type="checkbox" class="ve-vt" value="admin" ${vt.indexOf("admin") >= 0 ? "checked" : ""}> Admin</label>
      <label class="ve-gate-opt"><input type="checkbox" class="ve-vt" value="adviser" ${vt.indexOf("adviser") >= 0 ? "checked" : ""}> Adviser</label>
    </div>` : ""}
    <div class="ve-actions">
      <button type="button" class="btn" id="ve-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="ve-save">${isNew ? "Add entry" : "Save"}</button>
    </div>
  </div>`;
  openOverlay(html, (finish, box) => {
    const fieldsWrap = box.querySelector("#ve-fields");
    box.querySelector("#ve-add-field").onclick = () => {
      fieldsWrap.insertAdjacentHTML("beforeend", vaultEditorFieldRowHtml());
      const rows = fieldsWrap.querySelectorAll(".ve-field-row");
      const last = rows[rows.length - 1];
      if (last) last.querySelector(".ve-f-label").focus();
    };
    // add / remove / reorder, delegated so new rows need no wiring
    fieldsWrap.addEventListener("click", (ev) => {
      const row = ev.target.closest(".ve-field-row");
      if (!row) return;
      if (ev.target.closest(".ve-f-del")) {
        row.remove();
        if (!fieldsWrap.querySelector(".ve-field-row")) fieldsWrap.insertAdjacentHTML("beforeend", vaultEditorFieldRowHtml());
      } else if (ev.target.closest(".ve-f-up")) {
        const p = row.previousElementSibling; if (p) fieldsWrap.insertBefore(row, p);
      } else if (ev.target.closest(".ve-f-down")) {
        const n = row.nextElementSibling; if (n) fieldsWrap.insertBefore(n, row);
      }
    });
    box.querySelector("#ve-cancel").onclick = () => finish(null);
    box.querySelector("#ve-save").onclick = async () => {
      const nameEl = box.querySelector("#ve-name");
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); toast("Give the entry a name."); return; }
      const fieldRows = [...fieldsWrap.querySelectorAll(".ve-field-row")].map((row) => ({
        label: row.querySelector(".ve-f-label").value.trim(),
        value: row.querySelector(".ve-f-value").value,
        secret: row.querySelector(".ve-f-secret input").checked,
      })).filter((f) => f.label !== "" || f.value !== "");
      let visible_to = null;
      if (canGate) {
        const vts = [...box.querySelectorAll(".ve-vt:checked")].map((c) => c.value);
        visible_to = vts.length ? vts : null;
      } else if (!isNew && Array.isArray(entry.visible_to)) {
        visible_to = entry.visible_to;   // adviser can't see the control — never silently widen it
      }
      const payload = {
        name,
        category: box.querySelector("#ve-cat").value,
        owner_label: box.querySelector("#ve-owner").value || null,
        fields: fieldRows,
        note: box.querySelector("#ve-note").value.trim() || null,
        visible_to,
      };
      if (ME && ME.id) payload.updated_by = ME.id;
      const saveBtn = box.querySelector("#ve-save");
      saveBtn.disabled = true; saveBtn.textContent = "Saving…";
      try {
        const res = isNew
          ? await db.from("vault_entries").insert([payload]).select()
          : await db.from("vault_entries").update(payload).eq("id", entry.id).select();
        if (res && res.error) { saveBtn.disabled = false; saveBtn.textContent = isNew ? "Add entry" : "Save"; dbFail("vaultSave", res.error, "Couldn't save: " + res.error.message); return; }   // R81 · A4
        finish(true);
        toast(isNew ? "Entry added." : "Entry saved.");
        loadVault();
      } catch (err) {
        saveBtn.disabled = false; saveBtn.textContent = isNew ? "Add entry" : "Save";
        dbFail("vaultSave", err, "Couldn't save: " + ((err && err.message) || String(err)));   // R81 · A4
      }
    };
  });
}
async function deleteVaultEntry(id) {
  const row = VAULT_ROWS.find((r) => String(r.id) === String(id));
  // Delete is Owner/Admin only and RLS enforces it; advisers are never shown the button, and this
  // is the belt to that braces in case one is reached another way.
  if (!isAdminOrOwner()) return toast("Only an Owner or Administrator can delete a vault entry.");
  // R74 · B3 — house overlay, same question, same words.
  if (!(await confirmDestructive({
    title: "Delete this vault entry?",
    body: `<strong>${esc((row && row.name) || "this entry")}</strong> — the login and its password come off the record for everybody. This can't be undone.`,
    okLabel: "Delete entry", cancelLabel: "Keep it",
  }))) return;
  try {
    const res = await db.from("vault_entries").delete().eq("id", id);
    if (res && res.error) return dbFail("vaultDelete", res.error, "Couldn't delete: " + res.error.message);   // R81 · A4
    toast("Entry deleted.");
    loadVault();
  } catch (e) { dbFail("vaultDelete", e, "Couldn't delete: " + ((e && e.message) || String(e))); }   // R81 · A4
}
// Page-level wiring (the containers exist in the shell markup from load; the list is delegated so
// re-renders never orphan a handler).
(function wireVaultPage() {
  const nb = $("#new-vault-btn");
  if (nb) nb.onclick = () => openVaultEditor(null);
  const search = $("#vault-search");
  if (search) search.addEventListener("input", () => { vaultSearch = search.value; if (vaultLoaded) renderVault(); });
  const list = $("#vault-list");
  if (list) list.addEventListener("click", (ev) => {
    const edit = ev.target.closest(".vault-edit");
    if (edit) { const r = VAULT_ROWS.find((x) => String(x.id) === String(edit.dataset.id)); if (r) openVaultEditor(r); return; }
    const del = ev.target.closest(".vault-del");
    if (del) { const m = del.closest("details.vault-more"); if (m) m.open = false; deleteVaultEntry(del.dataset.id); return; }
  });
  // R87 — a click anywhere else on the page closes an open ⋯ menu.
  document.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest("details.vault-more")) return;
    document.querySelectorAll("#vault-list details.vault-more[open]").forEach((d) => { d.open = false; });
  });
})();

/* R90 · F: deploy handshake stamp. Every round that edits ANY of index.html / core.js / reports-money.js /
   diary.js / import.js / vault.js / app.js bumps the tag IN ALL SEVEN PLACES. */
window.__nxTag_vault = "r90";   // R89 — the CTO bumps all seven to r90 at the gate
