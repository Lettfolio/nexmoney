/* R95 · A1: the unsubscribe page's script (a file, not inline: the site CSP is script-src 'self').
   GET ?format=json only checks the link — opening the page changes nothing; the button's POST does
   the opt-out. Supabase serves function HTML as text/plain, hence a site page talking JSON. */
/* global window, document, location, fetch, URLSearchParams */
(function () {
  "use strict";
  // Same override as feedback.html: a harness can point this at a stub.
  var FN = String(window.__NEX_FN_BASE || "https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1").replace(/\/+$/, "") + "/unsubscribe";
  var uuidRe = /^[0-9a-fA-F-]{36}$/;

  var q = new URLSearchParams(location.search);
  var c = (q.get("c") || "").trim();
  var t = (q.get("t") || "").trim();

  var $ = function (id) { return document.getElementById(id); };
  var show = function (id) {
    ["loading", "invalid", "confirm", "done"].forEach(function (x) { $(x).hidden = x !== id; });
  };
  var banner = function (msg) { $("banner").textContent = msg || ""; $("banner").hidden = !msg; };

  if (!uuidRe.test(c) || !uuidRe.test(t)) { show("invalid"); return; }

  // R95 · A2: if the check itself cannot be reached, still offer the button — the POST decides.
  fetch(FN + "?format=json&c=" + encodeURIComponent(c) + "&t=" + encodeURIComponent(t), { method: "GET" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { show(j && j.valid === false ? "invalid" : "confirm"); })
    .catch(function () { show("confirm"); });

  $("unsubBtn").addEventListener("click", function () {
    var btn = $("unsubBtn");
    if (btn.disabled) return;
    banner("");
    btn.disabled = true;
    btn.textContent = "Unsubscribing…";
    fetch(FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ c: c, t: t }) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.valid === false) { show("invalid"); return; }
        if (j && j.ok) { show("done"); return; }
        throw new Error("failed");
      })
      .catch(function () {
        banner("Sorry, that didn't go through. Please check your connection and try again.");
        btn.disabled = false;
        btn.textContent = "Unsubscribe me";
      });
  });
})();
