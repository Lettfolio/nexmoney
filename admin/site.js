// @ts-check
/* ==========================================================================
   NexMoney Back Office — admin/site.js  (R93 · F)
   The WEBSITE page: the public site's content (page titles/descriptions, guides) and its search
   performance (nightly audit, Search Console). Two tabs, two fenced regions below — B owns CONTENT,
   C owns SEO; the foundation owns this header and the tag at the foot.
   SCRIPT ORDER: core.js → reports-money.js → diary.js → import.js → vault.js → site.js →
   app.js. THE DEFINITION-TIME RULE (HARNESS.md "R78 · A" / "R81 · A"): a declaration here may
   reference nothing from a LATER script at its own definition time (call-time references are fine —
   `db`, `settings`, `isOwner()`, `toast()`, `esc()`, `openOverlay()` are all called from inside functions
   that app.js's PAGE_TAB_LOADERS.site invokes after init()). app.js stays LAST.
   ========================================================================== */

/* ===== R93 · B CONTENT ===== */
/* R93 · B: the 14 public pages = sitemap.xml's <loc>s. A page not listed here has no editor row. */
const sitePagesConst = [
  { slug: "", label: "Home" },
  { slug: "mortgages", label: "Mortgages" },
  { slug: "first-time-buyer-mortgages-bournemouth", label: "First-time buyers" },
  { slug: "remortgage-bournemouth", label: "Remortgage" },
  { slug: "buy-to-let-mortgages-dorset", label: "Buy-to-let" },
  { slug: "services", label: "Services" },
  { slug: "calculators", label: "Calculators" },
  { slug: "contact", label: "Contact" },
  { slug: "about", label: "About" },
  { slug: "faq", label: "FAQ" },
  { slug: "testimonials", label: "Testimonials" },
  { slug: "privacy", label: "Privacy" },
  { slug: "cookies", label: "Cookies" },
  { slug: "share-the-love-terms", label: "Share the Love T&Cs" },
];
const siteCtState = { pages: [], posts: [], pub: null, hook: false, loaded: false };
let siteCtLoadSeq = 0;
const siteCtStatusCls = { draft: "amber", approved: "blue", published: "green", archived: "grey" };
const sitePubCls = { sent: "green", failed: "red", requested: "amber" };
const siteSlugRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const siteCtPath = (slug) => "/" + (slug || "");
const siteCtTrimOrNull = (v) => { const t = String(v == null ? "" : v).trim(); return t === "" ? null : t; };
const siteCtIsUrl = (v) => !v || /^https:\/\/[^\s]+$/i.test(v) || /^\/[^\s]*$/.test(v);
function siteSlugify(t) {
  return String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}
/* R93 · B: green 70–160 is the audit's own band (meta_short <70, meta_long >160); amber is "near", red is missing or far off. */
function siteCtDescTone(n) {
  if (!n) return "red";
  if (n >= 70 && n <= 160) return "green";
  return n >= 50 && n <= 180 ? "amber" : "red";
}
function siteCtTitleTone(n) {
  if (!n) return "grey";
  if (n >= 30 && n <= 60) return "green";
  return n >= 20 && n <= 70 ? "amber" : "red";
}

/* R93 · B: the preview must never run what an author pastes — escape first, then only the listed shapes become tags. */
function siteMdHref(url) {
  const u = String(url || "").trim();
  if (/^(https:\/\/|mailto:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || /^\/\//.test(u)) return null;   // any other scheme, or protocol-relative
  return u;
}
function siteMdInline(s) {
  let out = esc(s);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const href = siteMdHref(url.replace(/&amp;/g, "&"));
    return href == null ? text : `<a href="${esc(href)}" rel="noopener">${text}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return out;
}
function siteMdToHtml(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${siteMdInline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${siteMdInline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote><p>${siteMdInline(quote.join(" "))}</p></blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  lines.forEach((raw) => {
    const line = raw.trim();
    let m;
    if (!line) { flushAll(); return; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flushAll(); out.push(`<h${m[1].length}>${siteMdInline(m[2])}</h${m[1].length}>`); return; }
    if ((m = /^[-*]\s+(.*)$/.exec(line)) || (m = /^\d+\.\s+(.*)$/.exec(line))) {
      const tag = /^\d/.test(line) ? "ol" : "ul";
      flushPara(); flushQuote();
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push(m[1]);
      return;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); return; }
    flushList(); flushQuote();
    para.push(line);
  });
  flushAll();
  return out.join("\n");
}

async function loadSiteContent(o) {
  const root = document.getElementById("page-site-content");
  if (!root) return;
  siteCtWire(root);
  if (!siteCtState.loaded) root.innerHTML = `<p class="panel-sub">Loading…</p>`;
  const seq = ++siteCtLoadSeq;
  let res;
  try {
    res = await Promise.all([
      db.from("site_pages").select("*"),
      db.from("site_posts").select("*").order("updated_at", { ascending: false }),
      db.from("site_publishes").select("*").order("requested_at", { ascending: false }).limit(1),
      siteHookRead(),
    ]);
  } catch (e) { res = [{ error: { message: String((e && e.message) || e) } }]; }
  if (seq !== siteCtLoadSeq) return;
  const bad = res.find((r) => !r || r.error);
  if (bad) { renderLoadError("#page-site-content", (bad && bad.error) || { message: "no answer" }, () => loadSiteContent({ refresh: true })); return; }
  siteCtState.pages = res[0].data || [];
  siteCtState.posts = res[1].data || [];
  siteCtState.pub = (res[2].data || [])[0] || null;
  siteCtState.hook = res[3].data === true;
  siteCtState.loaded = true;
  siteCtRender();
}
/* R93 · fixer: the hook URL is owner-only (a bearer capability); admins ask the server whether it is set.
   A missing function (before db/r93/01) reads as "not set" rather than failing the tab. */
async function siteHookRead() {
  try { const r = await db.rpc("site_hook_is_set"); return { data: !!(r && !r.error && r.data === true) }; }
  catch (_) { return { data: false }; }
}
function siteHookSet() { return siteCtState.hook === true; }
function siteCtStripHtml() {
  const p = siteCtState.pub;
  const last = p
    ? `Last publish <strong>${esc(fmtAgo(p.requested_at))}</strong> · ${esc(staffName(p.requested_by))} · <span class="badge ${sitePubCls[p.status] || "grey"}" title="${esc(p.detail || "")}">${esc(p.status)}</span>`
    : `Never published`;
  const hook = siteHookSet();
  const btn = isAdminOrOwner()
    ? `<button type="button" class="btn btn-primary btn-sm" id="site-publish-btn"${hook ? "" : ` disabled title="Set the Vercel deploy hook in Settings › Integrations"`}>Publish site</button>`
    : "";
  return `<span class="site-pub-last" id="site-pub-last">${last}</span>${btn}`;
}
function sitePageRowHtml(meta) {
  const r = siteCtState.pages.find((x) => x.slug === meta.slug) || null;
  const desc = r && r.meta_description ? String(r.meta_description).trim() : "";
  const chips = [{ label: desc ? `Desc ${desc.length}` : "Desc —", cls: `${siteCtDescTone(desc.length)} site-desc-chip`, title: desc ? "" : "From HTML" }];
  if (r) chips.push({ label: "Edited", cls: "blue site-edited", title: r.updated_at ? "Edited " + fmtAgo(r.updated_at) : "" });
  return rowItemHtml({
    id: "sitepg-" + (meta.slug || "home"),
    cls: "site-row",
    attrs: { slug: meta.slug === "" ? "/" : meta.slug },
    name: { text: siteCtPath(meta.slug) },
    chips,
    fact: r && r.title ? esc(r.title) : `<span class="u-muted">— from HTML</span>`,
    verbs: [{ label: "Edit", cls: "site-edit", onclick: `siteOpenPageEditor(${JSON.stringify(meta.slug)})` }],
  });
}
function siteGuideRowHtml(g) {
  return rowItemHtml({
    id: "sitegd-" + g.id,
    cls: "site-row",
    attrs: { guide: g.id },
    name: { text: g.title || "(untitled)" },
    chips: [{ label: g.status, cls: `${siteCtStatusCls[g.status] || "grey"} site-status` }],
    fact: `/guides/${esc(g.slug)} · ${esc(fmtAgo(g.updated_at))}`,
    verbs: [{ label: "Edit", cls: "site-edit", onclick: `siteOpenGuideEditor(${JSON.stringify(String(g.id))})` }],
  });
}
const siteCtStatusOrder = { draft: 0, approved: 1, published: 2, archived: 3 };
function siteCtRender() {
  const root = document.getElementById("page-site-content");
  if (!root) return;
  const posts = siteCtState.posts.slice().sort((a, b) =>
    (siteCtStatusOrder[a.status] - siteCtStatusOrder[b.status]) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
  root.innerHTML = `
    <div class="site-strip" id="site-pub-strip">${siteCtStripHtml()}</div>
    <h3 class="site-h">Pages <span class="seg-count">${sitePagesConst.length}</span></h3>
    <div class="panel site-list" id="site-pages-list">${sitePagesConst.map(sitePageRowHtml).join("")}</div>
    <div class="site-h-row">
      <h3 class="site-h">Guides <span class="seg-count">${posts.length}</span></h3>
      <button type="button" class="btn btn-sm btn-primary" id="site-new-guide">+ New guide</button>
    </div>
    <div class="panel site-list" id="site-guides-list">${posts.length ? posts.map(siteGuideRowHtml).join("") : emptyState({ headline: "No guides yet" })}</div>`;
}
function siteCtWire(root) {
  if (root.dataset.siteWired) return;
  root.dataset.siteWired = "1";
  root.addEventListener("click", (e) => {
    const t = e.target;
    if (t.closest("#site-publish-btn")) { sitePublish(); return; }
    if (t.closest("#site-new-guide")) { siteOpenGuideEditor(null); return; }
    if (t.closest("button, a, input, details")) return;
    const row = t.closest(".site-row");
    if (!row) return;
    if (row.dataset.slug != null) siteOpenPageEditor(row.dataset.slug === "/" ? "" : row.dataset.slug);
    else if (row.dataset.guide) siteOpenGuideEditor(row.dataset.guide);
  });
}
async function siteCtRefreshStrip() {
  const r = await db.from("site_publishes").select("*").order("requested_at", { ascending: false }).limit(1);
  if (r && !r.error) siteCtState.pub = (r.data || [])[0] || null;
  const strip = document.getElementById("site-pub-strip");
  if (strip) strip.innerHTML = siteCtStripHtml();
}
async function sitePublish() {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("site-publish-btn"));
  if (!btn || btn.disabled || !siteHookSet()) return;
  btn.disabled = true; btn.textContent = "Publishing…";
  let data = null, error = null;
  try { ({ data, error } = await db.functions.invoke("site-publish")); }
  catch (e) { error = e; }
  let detail = data && (data.detail || data.error);
  if (error && error.context && typeof error.context.json === "function") {
    try { const j = await error.context.json(); detail = (j && (j.error || j.detail)) || detail; } catch (_) { /* body not JSON */ }
  }
  const ok = !error && data && data.ok;
  if (ok) toast("Publish sent" + (detail ? " — " + detail : ""));
  else dbFail("sitePublish", error || { message: detail }, "Publish failed — " + (detail || (error && error.message) || "no answer"));
  await siteCtRefreshStrip();
}

function siteCtCountsPaint(box) {
  box.querySelectorAll("[data-count]").forEach((c) => {
    const f = box.querySelector("#" + c.dataset.count);
    if (!f) return;
    const n = f.value.trim().length;
    const tone = c.dataset.tone === "title" ? siteCtTitleTone(n) : c.dataset.tone === "desc" ? siteCtDescTone(n) : (n > Number(c.dataset.max || 1e9) ? "red" : "grey");
    c.textContent = c.dataset.max ? `${n}/${c.dataset.max}` : String(n);
    c.className = `badge ${n ? tone : "grey"} site-count`;
  });
}
const siteCtCountHtml = (forId, tone, max) => `<span class="badge grey site-count" data-count="${forId}"${tone ? ` data-tone="${tone}"` : ""}${max ? ` data-max="${max}"` : ""}></span>`;
const siteCtSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function sitePageForm(r) {
  r = r || {};
  const s = (v) => (v == null ? "" : String(v));
  return {
    title: s(r.title), meta_description: s(r.meta_description), h1: s(r.h1),
    og_title: s(r.og_title), og_description: s(r.og_description), og_image: s(r.og_image),
    notes: s(r.notes),
  };
}
function sitePageFormRead(box) {
  const v = (id) => box.querySelector("#" + id).value;
  return {
    title: v("sp-title"), meta_description: v("sp-meta"), h1: v("sp-h1"),
    og_title: v("sp-og-title"), og_description: v("sp-og-desc"), og_image: v("sp-og-image"),
    notes: v("sp-notes"),
  };
}
async function siteOpenPageEditor(slug, draft) {
  const meta = sitePagesConst.find((p) => p.slug === slug);
  if (!meta) return;
  const row = siteCtState.pages.find((x) => x.slug === slug) || null;
  const base = sitePageForm(row);
  const f = draft || base;
  let live = f;
  const faqN = row && Array.isArray(row.faq) ? row.faq.length : 0;   // R93 · fixer: FAQ editing parked; existing entries stay visible
  const html = `<div class="site-editor" id="site-page-editor">
    <h3>${esc(meta.label)} <span class="site-path">${esc(siteCtPath(slug))}</span>${faqN ? ` <span class="badge grey" id="sp-faq-chip">FAQ ×${faqN}</span>` : ""}</h3>
    <label>Title ${siteCtCountHtml("sp-title", "title")}<input id="sp-title" value="${esc(f.title)}" placeholder="— from HTML"></label>
    <label>Meta description ${siteCtCountHtml("sp-meta", "desc")}<textarea id="sp-meta" rows="3" placeholder="— from HTML">${esc(f.meta_description)}</textarea></label>
    <label>H1<input id="sp-h1" value="${esc(f.h1)}" placeholder="— from HTML"></label>
    <div class="site-row2">
      <label>OG title ${siteCtCountHtml("sp-og-title", "title")}<input id="sp-og-title" value="${esc(f.og_title)}"></label>
      <label>OG image URL<input id="sp-og-image" type="url" value="${esc(f.og_image)}" placeholder="https://"></label>
    </div>
    <label>OG description ${siteCtCountHtml("sp-og-desc", "desc")}<textarea id="sp-og-desc" rows="2">${esc(f.og_description)}</textarea></label>
    <label class="site-gap">Internal notes<textarea id="sp-notes" rows="2">${esc(f.notes)}</textarea></label>
    <div class="modal-actions"><div></div><div class="right">
      <button type="button" class="btn" id="sp-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="sp-save">Save</button>
    </div></div>
  </div>`;
  const res = await openOverlay(html, (finish, box) => {
    const read = () => { live = sitePageFormRead(box); siteCtCountsPaint(box); };
    siteCtCountsPaint(box);
    box.querySelector("#site-page-editor").addEventListener("input", read);   // R93 · B: the editor node, not #overlay-modal, which outlives this overlay
    box.querySelector("#sp-cancel").onclick = () => finish(null);
    box.querySelector("#sp-save").onclick = async () => {
      read();
      const img = live.og_image.trim();
      if (!siteCtIsUrl(img)) { const el = box.querySelector("#sp-og-image"); el.classList.add("field-invalid"); el.focus(); toast("OG image: a full https:// URL or a /path."); return; }
      const payload = {
        slug,
        title: siteCtTrimOrNull(live.title), meta_description: siteCtTrimOrNull(live.meta_description), h1: siteCtTrimOrNull(live.h1),
        og_title: siteCtTrimOrNull(live.og_title), og_description: siteCtTrimOrNull(live.og_description), og_image: siteCtTrimOrNull(img),
        notes: siteCtTrimOrNull(live.notes),
      };
      const btn = box.querySelector("#sp-save");
      btn.disabled = true; btn.textContent = "Saving…";
      let r;
      try { r = await db.from("site_pages").upsert([payload]); } catch (e) { r = { error: e }; }
      if (r && r.error) { btn.disabled = false; btn.textContent = "Save"; dbFail("sitePageSave", r.error, "Couldn't save: " + (r.error.message || r.error)); return; }
      finish(true);
      toast("Saved.");
      loadSiteContent({ refresh: true });
    };
  });
  if (res === true || siteCtSame(live, base)) return;
  if (await confirmDiscard(siteCtPath(slug))) return;
  siteOpenPageEditor(slug, live);
}

function siteGuideForm(g) {
  g = g || {};
  const s = (v) => (v == null ? "" : String(v));
  return { title: s(g.title), slug: s(g.slug), excerpt: s(g.excerpt), cover_image: s(g.cover_image), body_md: s(g.body_md) };
}
function siteGuideFormRead(box) {
  const v = (id) => box.querySelector("#" + id).value;
  return { title: v("sg-title"), slug: v("sg-slug"), excerpt: v("sg-excerpt"), cover_image: v("sg-cover"), body_md: v("sg-body") };
}
/* R93 · B: owner gating here is presentation only — site_posts_status_guard enforces it, and its message is what a refused write toasts. */
function siteGuideStatusBtns(g) {
  const st = g ? g.status : "draft";
  const out = [];
  if (g && st !== "archived") out.push(`<button type="button" class="btn btn-sm" id="sg-archive" data-status="archived">Archive</button>`);
  if (isOwner() && st === "draft") out.push(`<button type="button" class="btn btn-sm" id="sg-approve" data-status="approved">Approve</button>`);
  if (isOwner() && st !== "published") out.push(`<button type="button" class="btn btn-sm btn-primary" id="sg-publish" data-status="published">Publish</button>`);
  return out.join("");
}
/* R93 · B: one write path for Save and the status verbs, so a status change also saves the open edits. */
async function siteSaveGuide(g, form, status) {
  const payload = {};
  if (form) {
    payload.title = form.title.trim();
    payload.slug = form.slug.trim();
    payload.excerpt = siteCtTrimOrNull(form.excerpt);
    payload.cover_image = siteCtTrimOrNull(form.cover_image);
    payload.body_md = form.body_md;
  }
  if (status) payload.status = status;
  let r;
  try {
    if (g) r = await db.from("site_posts").update(payload).eq("id", g.id).select();
    else r = await db.from("site_posts").insert([payload]).select();
  } catch (e) { r = { error: e }; }
  if (r && r.error) { dbFail("siteSaveGuide", r.error, String(r.error.message || r.error)); return false; }
  return true;
}
// eslint-disable-next-line no-unused-vars -- R94 · B3: test hook, called by tests/r93_content.js via page.evaluate.
async function siteGuideSetStatus(id, status) {
  const g = siteCtState.posts.find((x) => String(x.id) === String(id));
  if (!g) return false;
  const done = await siteSaveGuide(g, null, status);
  if (done) { toast(`Guide ${status}.`); loadSiteContent({ refresh: true }); }
  return done;
}
async function siteOpenGuideEditor(id, draft) {
  const g = id == null ? null : siteCtState.posts.find((x) => String(x.id) === String(id)) || null;
  if (id != null && !g) return;
  const base = siteGuideForm(g);
  const f = draft || base;
  let live = f;
  let slugTouched = !!(g && g.slug) || (draft && draft.slug !== siteSlugify(draft.title));
  const st = g ? g.status : "draft";
  const saveLabel = st === "draft" && !isOwner() ? "Submit for approval" : "Save";
  const html = `<div class="site-editor site-editor-wide" id="site-guide-editor">
    <h3>${g ? "Edit guide" : "New guide"} <span class="badge ${siteCtStatusCls[st] || "grey"}" id="sg-status">${esc(st)}</span></h3>
    <label>Title<input id="sg-title" value="${esc(f.title)}"></label>
    <label>Slug <span class="site-path">/guides/<span id="sg-slug-path">${esc(f.slug)}</span></span><input id="sg-slug" value="${esc(f.slug)}" spellcheck="false" autocomplete="off"></label>
    <div class="site-row2">
      <label>Excerpt ${siteCtCountHtml("sg-excerpt", "", 200)}<textarea id="sg-excerpt" rows="2" maxlength="200">${esc(f.excerpt)}</textarea></label>
      <label>Cover image URL<input id="sg-cover" type="url" value="${esc(f.cover_image)}" placeholder="https://"></label>
    </div>
    <div class="site-md-head"><span class="site-sub-h">Body</span><button type="button" class="btn btn-sm" id="sg-preview-toggle" aria-pressed="false">Preview</button></div>
    <textarea id="sg-body" class="site-md" rows="14" aria-label="Body (Markdown)">${esc(f.body_md)}</textarea>
    <div id="sg-preview" class="site-md-preview" hidden></div>
    <div class="modal-actions">
      <div class="site-status-acts">${siteGuideStatusBtns(g)}</div>
      <div class="right">
        <button type="button" class="btn" id="sg-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" id="sg-save">${saveLabel}</button>
      </div>
    </div>
  </div>`;
  const res = await openOverlay(html, (finish, box) => {
    const $b = (s) => box.querySelector(s);
    const slugEl = $b("#sg-slug");
    const read = () => { live = siteGuideFormRead(box); siteCtCountsPaint(box); $b("#sg-slug-path").textContent = live.slug; };
    siteCtCountsPaint(box);
    $b("#sg-title").addEventListener("input", () => { if (!slugTouched) slugEl.value = siteSlugify($b("#sg-title").value); });
    slugEl.addEventListener("input", () => { slugTouched = true; slugEl.classList.toggle("field-invalid", !!slugEl.value && !siteSlugRe.test(slugEl.value)); });
    box.querySelector("#site-guide-editor").addEventListener("input", read);
    const pv = $b("#sg-preview"), body = $b("#sg-body"), tg = $b("#sg-preview-toggle");
    tg.onclick = () => {
      const on = tg.getAttribute("aria-pressed") !== "true";
      tg.setAttribute("aria-pressed", String(on));
      tg.textContent = on ? "Write" : "Preview";
      if (on) pv.innerHTML = siteMdToHtml(body.value) || `<p class="u-muted">Nothing yet.</p>`;
      pv.hidden = !on; body.hidden = on;
    };
    const valid = () => {
      read();
      if (!live.title.trim()) { $b("#sg-title").classList.add("field-invalid"); $b("#sg-title").focus(); toast("Give the guide a title."); return false; }
      if (!siteSlugRe.test(live.slug.trim())) { slugEl.classList.add("field-invalid"); slugEl.focus(); toast("Slug: lowercase letters, numbers and hyphens."); return false; }
      if (live.excerpt.trim().length > 200) { toast("Excerpt: 200 characters at most."); return false; }
      if (!siteCtIsUrl(live.cover_image.trim())) { $b("#sg-cover").classList.add("field-invalid"); toast("Cover: a full https:// URL or a /path."); return false; }
      return true;
    };
    const go = async (status, btn) => {
      if (!valid()) return;
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = "Saving…";
      const done = await siteSaveGuide(g, live, status);
      if (!done) { btn.disabled = false; btn.textContent = label; return; }
      finish(true);
      toast(status ? `Guide ${status}.` : "Saved.");
      loadSiteContent({ refresh: true });
    };
    $b("#sg-cancel").onclick = () => finish(null);
    $b("#sg-save").onclick = (e) => go(null, e.currentTarget);
    box.querySelectorAll(".site-status-acts [data-status]").forEach((b) => { b.onclick = (e) => go(b.dataset.status, e.currentTarget); });
  });
  if (res === true || siteCtSame(live, base)) return;
  if (await confirmDiscard(g ? "this guide" : "the new guide")) return;
  siteOpenGuideEditor(id, live);
}
/* ===== END R93 · B CONTENT ===== */

/* ===== R93 · C SEO ===== */
/* loadSiteSeo({ refresh }) paints #page-site-seo from the LATEST seo_snapshots day (two reads: the day, then
   its rows). Rows are written nightly by edge seo-snapshot (slice A); "Run audit now" invokes it with force.
   R93 · C: every top-level name here starts with `seo` — eight classic scripts share one global scope. */
let seoRunning = false;
const SEO_ISSUE_LABEL = {
  missing_title: "No title", title_long: "Title long", title_short: "Title short",
  missing_meta: "No description", meta_long: "Description long", meta_short: "Description short",
  no_h1: "No H1", multi_h1: "Several H1", canonical_mismatch: "Canonical", broken_link: "Broken link",
  img_no_alt: "Alt text", thin_content: "Thin", dup_title: "Duplicate title", dup_meta: "Duplicate description",
  http_error: "HTTP error",
};
/* GSC reports full URLs, the audit paths: one key for both. */
function seoPath(p) {
  let s = String(p == null ? "" : p).trim().replace(/^https?:\/\/[^/]+/i, "");
  if (!s.startsWith("/")) s = "/" + s;
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s;
}
function seoNum(n) { return n == null || isNaN(Number(n)) ? null : Number(n); }
function seoFmtInt(n) { const v = seoNum(n); return v == null ? "—" : Math.round(v).toLocaleString("en-GB"); }
function seoBadge(cls, text, title) {
  return `<span class="badge ${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
}
/* Length chip: green inside [lo, hi], red when absent, amber otherwise — the audit's own thresholds. */
function seoLenChip(len, lo, hi) {
  const v = seoNum(len);
  if (!v) return seoBadge("red", "0");
  return seoBadge(v >= lo && v <= hi ? "green" : "amber", String(v));
}
function seoPsiChip(score) {
  const v = seoNum(score);
  if (v == null) return `<span class="u-muted">—</span>`;
  return seoBadge(v >= 90 ? "green" : v >= 50 ? "amber" : "red", String(Math.round(v)));
}
/* One chip per issue CODE (three broken links = one chip ×3); the messages ride in the title. */
function seoIssueChips(issues) {
  const by = {};
  (issues || []).forEach((i) => {
    if (!i || !i.code) return;
    const g = by[i.code] || (by[i.code] = { code: i.code, level: "warn", msgs: [] });
    if (i.level === "error") g.level = "error";
    if (i.msg) g.msgs.push(String(i.msg));
  });
  return Object.values(by)
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
    .map((g) => `<span class="badge seo-chip ${g.level === "error" ? "red" : "amber"}" data-code="${esc(g.code)}" data-level="${esc(g.level)}" title="${esc(g.msgs.join("\n"))}">${esc(SEO_ISSUE_LABEL[g.code] || g.code)}${g.msgs.length > 1 ? " ×" + g.msgs.length : ""}</span>`)
    .join(" ");
}
function seoIssueCount(issues, level) { return (issues || []).filter((i) => i && i.level === level).length; }
async function seoLoadLatest() {
  const d = await db.from("seo_snapshots").select("day").order("day", { ascending: false }).limit(1);
  if (d.error) return { error: d.error };
  const day = d.data && d.data[0] && d.data[0].day;
  if (!day) return { day: null, rows: [] };
  const r = await db.from("seo_snapshots").select("*").eq("day", day).limit(1000);
  if (r.error) return { error: r.error };
  return { day, rows: r.data || [] };
}
function seoModel(rows) {
  const m = { summary: null, audits: [], psi: {}, gsc: {}, queries: [] };
  rows.forEach((r) => {
    const d = r.data || {};
    if (r.kind === "summary") m.summary = Object.assign({ created_at: r.created_at }, d);
    else if (r.kind === "audit") m.audits.push({ page: seoPath(r.page), d });
    else if (r.kind === "psi") m.psi[seoPath(r.page)] = d;
    else if (r.kind === "gsc") m.gsc[seoPath(r.page)] = d;
    else if (r.kind === "gsc_query") m.queries.push(Object.assign({ query: r.page }, d));
  });
  return m;
}
function seoRunBtnHtml() {
  return seoRunning
    ? `<button type="button" class="btn btn-sm btn-primary" id="seo-run" disabled aria-busy="true"><span class="seo-spin" aria-hidden="true"></span> Running…</button>`
    : `<button type="button" class="btn btn-sm btn-primary" id="seo-run">Run audit now</button>`;
}
function seoTilesHtml(m) {
  const s = m.summary || {};
  const errors = s.errors != null ? s.errors : m.audits.reduce((n, a) => n + seoIssueCount(a.d.issues, "error"), 0);
  const warns = s.warnings != null ? s.warnings : m.audits.reduce((n, a) => n + seoIssueCount(a.d.issues, "warn"), 0);
  const pages = s.pages != null ? s.pages : m.audits.length;
  const psiOn = s.psi_connected !== false && seoNum(s.psi_avg) != null;
  const psi = psiOn ? Math.round(seoNum(s.psi_avg)) : null;
  const gscOn = !!s.gsc_connected;
  const clicks = gscOn && s.gsc ? s.gsc.clicks : null;
  const tile = (id, cls, num, lbl, extra) => `<div class="kpi${cls ? " " + cls : ""}" id="${id}"${extra || ""}><div class="num">${esc(num)}</div><div class="lbl">${esc(lbl)}</div></div>`;
  return `<div class="kpi-row seo-tiles" id="seo-tiles">`
    + tile("seo-tile-pages", "", seoFmtInt(pages), "Pages audited")
    + tile("seo-tile-issues", errors ? "bad" : warns ? "warn" : "", `${seoFmtInt(errors)} · ${seoFmtInt(warns)}`, "Errors · warnings")
    + tile("seo-tile-psi", psi == null ? "" : psi < 50 ? "bad" : psi < 90 ? "warn" : "", psi == null ? "—" : String(psi), "Performance · mobile")
    + (gscOn
      ? tile("seo-tile-gsc", "", seoFmtInt(clicks), "Search clicks · 28d")
      : tile("seo-tile-gsc", "dq-clickable", "Connect", "Search clicks · 28d", ` data-seo-jump="seo-connect" role="button" tabindex="0"`))
    + `</div>`;
}
function seoRowHtml(a, m) {
  const d = a.d || {};
  const psi = m.psi[a.page];
  const gsc = m.gsc[a.page];
  const broken = Array.isArray(d.broken_links) ? d.broken_links : [];
  const issues = Array.isArray(d.issues) ? d.issues : [];
  const h1n = seoNum(d.h1_count);
  const h1 = h1n == null ? `<span class="u-muted">—</span>` : seoBadge(h1n === 1 ? "green" : h1n === 0 ? "red" : "amber", String(h1n));
  const status = seoNum(d.status);
  const statusChip = status && status !== 200 ? " " + seoBadge("red", String(status)) : "";
  const body = issues.length || broken.length
    ? `<div class="seo-iss-body">`
      + (issues.length ? `<ul class="seo-iss-list">${issues.map((i) => `<li>${seoBadge(i.level === "error" ? "red" : "amber", SEO_ISSUE_LABEL[i.code] || i.code || "")} ${esc(i.msg || "")}</li>`).join("")}</ul>` : "")
      + (broken.length ? `<ul class="seo-broken">${broken.map((b) => `<li><code>${esc(b && b.href)}</code> ${seoBadge("red", String((b && b.status) || "?"))}</li>`).join("")}</ul>` : "")
      + `</div>`
    : "";
  const cell = body
    ? `<details class="seo-iss"><summary>${seoIssueChips(issues) || seoBadge("red", "Broken links")}</summary>${body}</details>`
    : seoBadge("green", "✓");
  return `<tr class="seo-row" data-page="${esc(a.page)}" data-errors="${seoIssueCount(issues, "error")}" data-warns="${seoIssueCount(issues, "warn")}">`
    + `<td data-lbl="Page" class="seo-page" title="${esc(d.title || "")}">${esc(a.page)}${statusChip}</td>`
    + `<td data-lbl="Title" class="num">${seoLenChip(d.title_len, 30, 60)}</td>`
    + `<td data-lbl="Description" class="num">${seoLenChip(d.meta_len, 70, 160)}</td>`
    + `<td data-lbl="H1" class="num">${h1}</td>`
    + `<td data-lbl="Words" class="num">${seoFmtInt(d.words)}</td>`
    + `<td data-lbl="PSI" class="num">${seoPsiChip(psi && psi.performance)}</td>`
    + `<td data-lbl="Clicks" class="num">${gsc ? seoFmtInt(gsc.clicks) : "—"}</td>`
    + `<td data-lbl="Position" class="num">${gsc && seoNum(gsc.position) != null ? esc(seoNum(gsc.position).toFixed(1)) : "—"}</td>`
    + `<td data-lbl="Issues" class="seo-iss-cell">${cell}</td>`
    + `</tr>`;
}
function seoTableHtml(m) {
  const rows = m.audits.slice().sort((a, b) =>
    seoIssueCount(b.d.issues, "error") - seoIssueCount(a.d.issues, "error")
    || seoIssueCount(b.d.issues, "warn") - seoIssueCount(a.d.issues, "warn")
    || a.page.localeCompare(b.page));
  if (!rows.length) return "";
  return `<div class="u-ox-auto"><table class="imp-table mob-cards seo-table" id="seo-table">`
    + `<tr><th>Page</th><th>Title</th><th>Description</th><th>H1</th><th>Words</th><th>PSI</th><th>Clicks</th><th>Position</th><th>Issues</th></tr>`
    + rows.map((a) => seoRowHtml(a, m)).join("")
    + `</table></div>`;
}
function seoQueriesHtml(m) {
  const s = m.summary || {};
  if (!s.gsc_connected) {
    return `<div class="panel seo-connect" id="seo-connect"><h3>Connect Search Console</h3><ol class="seo-steps">`
      + `<li>Create a Google Cloud service account.</li>`
      + `<li>Add it to Search Console as a user.</li>`
      + `<li>Give Daniel the JSON — he adds it as the GSC_SERVICE_ACCOUNT secret.</li>`
      + `</ol></div>`;
  }
  const qs = m.queries.slice().sort((a, b) => (seoNum(b.clicks) || 0) - (seoNum(a.clicks) || 0) || (seoNum(b.impressions) || 0) - (seoNum(a.impressions) || 0)).slice(0, 20);
  const pct = (v) => (seoNum(v) == null ? "—" : (seoNum(v) * 100).toFixed(1) + "%");
  return `<div class="panel seo-queries"><h3>Top queries</h3><div id="seo-queries">`
    + (qs.length
      ? qs.map((q) => rowItemHtml({
          name: { text: q.query },
          fact: esc(`${seoFmtInt(q.clicks)} clicks · ${seoFmtInt(q.impressions)} impressions · ${pct(q.ctr)} CTR · position ${seoNum(q.position) == null ? "—" : seoNum(q.position).toFixed(1)}`),
          cls: "seo-q",
        })).join("")
      : `<span class="u-muted">No queries yet.</span>`)
    + `</div></div>`;
}
function seoPaint(root, res) {
  if (!res.day || !res.rows.length) {
    root.innerHTML = `<div class="seo-empty" id="seo-empty">${emptyState({ headline: "No audit yet." })}${seoRunBtnHtml()}</div>`;
    return;
  }
  const m = seoModel(res.rows);
  const s = m.summary || {};
  const when = s.ran_at || s.created_at || res.day;
  const dur = seoNum(s.duration_ms);
  const notes = Array.isArray(s.run_errors) ? s.run_errors.map(String) : [];   // R93 · fixer: the run's step failures, persisted
  const notesChip = notes.length ? seoBadge("amber seo-notes", `${notes.length} note${notes.length === 1 ? "" : "s"}`, notes.join("\n")) : "";
  root.innerHTML = `<div class="seo-head" id="seo-head"><span class="seo-last" title="${esc(String(when))}">Last audit ${esc(fmtAgo(when) || res.day)}${dur == null ? "" : ` · ${esc((dur / 1000).toFixed(1))}s`}</span>${notesChip}${seoRunBtnHtml()}</div>`
    + seoTilesHtml(m)
    + seoTableHtml(m)
    + seoQueriesHtml(m);
  syncNumHeaders(root);
}
function seoWire(root) {
  if (root.__seoWired) return;
  root.__seoWired = true;
  root.addEventListener("click", (e) => {
    if (e.target.closest("#seo-run")) { seoRunAudit(); return; }
    const jump = e.target.closest("[data-seo-jump]");
    if (jump) { const t = document.getElementById(jump.getAttribute("data-seo-jump")); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    const tr = e.target.closest("tr.seo-row");
    if (!tr || e.target.closest("summary, a, button, details .seo-iss-body")) return;
    const det = tr.querySelector("details.seo-iss");
    if (det) det.open = !det.open;
  });
  root.addEventListener("keydown", (e) => {
    const jump = e.target.closest && e.target.closest("[data-seo-jump]");
    if (jump && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); jump.click(); }
  });
}
async function loadSiteSeo(o) {
  const root = document.getElementById("page-site-seo");
  if (!root) return;
  seoWire(root);
  if (!root.querySelector("#seo-head, #seo-empty")) root.innerHTML = `<div class="empty">Loading…</div>`;
  let res;
  try { res = await seoLoadLatest(); } catch (e) { res = { error: { message: String((e && e.message) || e) } }; }
  if (res.error) { renderLoadError("#page-site-seo", res.error, () => loadSiteSeo({ refresh: true })); return; }
  seoPaint(root, res);
}
async function seoRunAudit() {
  if (seoRunning) return;
  seoRunning = true;
  document.querySelectorAll("#seo-run").forEach((b) => { b.outerHTML = seoRunBtnHtml(); });
  let res;
  try { res = await db.functions.invoke("seo-snapshot", { body: { force: true } }); }
  catch (e) { res = { error: { message: String((e && e.message) || e) } }; }
  seoRunning = false;
  const err = (res && res.error) || (res && res.data && res.data.error ? { message: String(res.data.error) } : null);
  let why = err && err.message;
  if (err && err.context && typeof err.context.json === "function") {   // R93 · fixer: the 403 "second factor required" body, as sitePublish reads it
    try { const j = await err.context.json(); why = (j && (j.error || j.detail)) || why; } catch (_) { /* body not JSON */ }
  }
  if (err) toast("Audit failed: " + (why || "unknown error"));
  else {
    const n = res && res.data && Array.isArray(res.data.errors) ? res.data.errors.length : 0;
    toast(n ? `Audit finished · ${n} step${n === 1 ? "" : "s"} failed` : "Audit finished.");
  }
  await loadSiteSeo({ refresh: true });
}
/* ===== END R93 · C SEO ===== */

/* R93 · F: deploy handshake stamp. Every round that edits ANY of index.html / core.js / reports-money.js /
   diary.js / import.js / vault.js / site.js / app.js bumps the tag IN ALL EIGHT PLACES. */
// @ts-ignore -- R94 · B4: window.__nxTag_* is the build-tag handshake; Window has no typing for it.
window.__nxTag_site = "r94";   // bumped to r93 at the gate with the other seven
