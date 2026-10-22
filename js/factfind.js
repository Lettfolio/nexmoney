/* R95 · D1: factfind.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
(function () {
  var FN = "https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1/fact-find";
  var token = new URLSearchParams(location.search).get("token") || "";
  var form = document.getElementById("form");
  var show = function (id) { ["loading","invalid","done","form"].forEach(function (x) { document.getElementById(x).style.display = (x === id ? (x === "form" ? "block" : "block") : "none"); }); };
  var banner = function (msg, cls) { var b = document.getElementById("banner"); if (!msg) { b.innerHTML = ""; b.className = ""; return; } b.className = "banner " + cls; b.textContent = msg; b.scrollIntoView({ block: "nearest" }); };

  function collect() {
    var data = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === "checkbox") data[el.name] = el.checked ? "yes" : "";
      else data[el.name] = el.value;
    });
    return data;
  }
  function fill(data, prefill) {
    var merged = Object.assign({}, prefill || {}, data || {});
    // map a couple of prefill keys to form field names
    if (prefill) {
      if (prefill.first_name && !merged.a1_first) merged.a1_first = prefill.first_name;
      if (prefill.last_name && !merged.a1_last) merged.a1_last = prefill.last_name;
      if (prefill.email && !merged.email) merged.email = prefill.email;
      if (prefill.phone && !merged.phone) merged.phone = prefill.phone;
      if (prefill.date_of_birth && !merged.a1_dob) merged.a1_dob = prefill.date_of_birth;
      if (prefill.address && !merged.a1_address) merged.a1_address = prefill.address;
    }
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !(el.name in merged)) return;
      if (el.type === "checkbox") el.checked = merged[el.name] === "yes";
      else el.value = merged[el.name] == null ? "" : merged[el.name];
    });
    toggleA2();
  }
  function toggleA2() {
    var on = document.getElementById("hasA2").checked;
    document.getElementById("a2block").style.display = on ? "grid" : "none";
    document.getElementById("a2incwrap").style.display = on ? "block" : "none";
  }
  document.getElementById("hasA2").addEventListener("change", toggleA2);

  async function send(submit) {
    var res = await fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token, data: collect(), submit: !!submit }) });
    // R84 — fact-find v4 answers 429 "too_fast" to a second save within 5 s of the last one. The
    // first save landed, so this is not an error for the person pressing the button twice.
    if (res.status === 429 && !submit) return { ok: true, status: "started", note: "too_fast" };
    if (!res.ok) throw new Error("save failed " + res.status);
    return res.json();
  }
  var saveBtn = document.getElementById("saveBtn"), submitBtn = document.getElementById("submitBtn"), saveNote = document.getElementById("saveNote");
  saveBtn.addEventListener("click", async function () {
    saveBtn.disabled = true; saveNote.textContent = "Saving…";
    try { await send(false); saveNote.textContent = "Saved — you can close this and return via the same link."; }
    catch (e) { saveNote.textContent = ""; banner("Sorry, we couldn't save just now. Please try again.", "err"); }
    finally { saveBtn.disabled = false; }
  });
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (!document.getElementById("consent").checked) { banner("Please tick the confirmation box before submitting.", "err"); return; }
    submitBtn.disabled = true; saveBtn.disabled = true; submitBtn.textContent = "Submitting…"; banner("", "");
    try { await send(true); show("done"); }
    catch (e2) { banner("Sorry, we couldn't submit just now. Your answers are still here — please try again.", "err"); submitBtn.disabled = false; saveBtn.disabled = false; submitBtn.textContent = "Submit to my adviser"; }
  });

  if (!token) { show("invalid"); return; }
  fetch(FN + "?token=" + encodeURIComponent(token)).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (o) {
      if (!o.ok || !o.j || o.j.error) { show("invalid"); return; }
      if (o.j.status === "submitted") { show("done"); return; }
      // R84 — same escape as docs.html: the value is a settings row, but it is the one innerHTML on the page.
      var esc = function (s) { return s == null ? "" : String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
      if (o.j.company) { document.querySelector(".brand").innerHTML = esc(o.j.company).replace(/Money/i, "<span>Money</span>"); }
      fill(o.j.data, o.j.prefill);
      show("form");
    })
    .catch(function () { show("invalid"); });
})();
