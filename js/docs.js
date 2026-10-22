/* R95 · D1: docs.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
(function () {
  "use strict";
  /* The edge function. Overridable so the headless harness can point this page
     at the sandbox mock without the page knowing it is being tested — the mock
     stubs window.fetch for supabase function URLs, so the base is all that has
     to change. Nothing else on this page is aware of the difference. */
  var FN_BASE = String(window.__NEX_FN_BASE || "https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1").replace(/\/+$/, "");
  var FN = FN_BASE + "/doc-upload";

  var MAX_BYTES = 10 * 1024 * 1024;
  var OK_EXT = ["pdf", "jpg", "jpeg", "png", "heic", "heif"];
  var OK_MIME = /^(application\/pdf|image\/(jpeg|jpg|png|heic|heif))$/i;

  var token = new URLSearchParams(location.search).get("token") || "";
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return s == null ? "" : String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var show = function (id) {
    ["loading", "invalid", "alldone", "page"].forEach(function (x) { $(x).style.display = (x === id ? "block" : "none"); });
  };
  var banner = function (msg, cls) {
    var b = $("banner");
    if (!msg) { b.innerHTML = ""; b.className = ""; return; }
    b.className = "banner " + cls;
    b.textContent = msg;
  };

  /* ---- rendering ------------------------------------------------------
     One row per checklist item. Received items stay on the list, ticked:
     a client who sent their passport last week and finds it missing from
     this page reasonably concludes it never arrived. */
  var STATE = { items: [], name: "" };

  function render() {
    var out = STATE.items.filter(function (d) { return d.status === "requested"; });
    $("greeting").textContent = "Hi " + (STATE.name || "there");
    $("intro").textContent = out.length
      ? "We still need " + out.length + " " + (out.length === 1 ? "document" : "documents") + " from you. Send them one at a time — each one saves as soon as it arrives, so you can come back to this page later and pick up where you left off."
      : "Everything on your list is in. Thank you.";
    $("list").innerHTML = STATE.items.map(function (d, i) {
      var done = d.status !== "requested";
      return '<div class="doc' + (done ? " is-done" : "") + '" id="doc-' + i + '" data-item="' + esc(d.item) + '" data-status="' + esc(d.status) + '">'
        + '<div class="doc-head">'
        + '<div class="doc-tick" aria-hidden="true">' + (done ? "✓" : "") + "</div>"
        + '<div><div class="doc-name">' + esc(d.item) + "</div>"
        + '<div class="doc-state" id="state-' + i + '">' + (done ? "Received — thank you" : "Not sent yet") + "</div></div>"
        + "</div>"
        + (done ? "" :
          '<div class="doc-body">'
          + '<div class="row">'
          + '<label class="pick">📎 <span id="picklbl-' + i + '">Choose a file</span>'
          + '<input type="file" id="file-' + i + '" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/jpeg,image/png,image/heic" aria-label="Choose a file for ' + esc(d.item) + '"></label>'
          + '<button type="button" class="btn" id="send-' + i + '" disabled>Send</button>'
          + '<span class="chosen" id="chosen-' + i + '"></span>'
          + "</div>"
          + '<div class="bar" id="bar-' + i + '" style="display:none"><i id="fill-' + i + '"></i></div>'
          + '<div class="prog" id="prog-' + i + '" style="display:none"></div>'
          + '<div class="err" id="err-' + i + '" style="display:none"></div>'
          + "</div>")
        + "</div>";
    }).join("");
    STATE.items.forEach(function (d, i) { if (d.status === "requested") wireRow(i); });
    if (!out.length) show("alldone");
  }

  function wireRow(i) {
    var input = $("file-" + i), send = $("send-" + i);
    if (!input || !send) return;
    input.addEventListener("change", function () {
      var f = input.files && input.files[0];
      $("err-" + i).style.display = "none";
      if (!f) { send.disabled = true; $("chosen-" + i).textContent = ""; $("picklbl-" + i).textContent = "Choose a file"; return; }
      var bad = validate(f);
      $("chosen-" + i).textContent = f.name + " · " + Math.max(1, Math.round(f.size / 1024)) + "KB";
      $("picklbl-" + i).textContent = "Choose a different file";
      if (bad) { fail(i, bad); send.disabled = true; return; }
      send.disabled = false;
    });
    send.addEventListener("click", function () { upload(i); });
  }

  /* Checked here as well as on the server, because a client who waits for a
     20MB photo to upload and is then told no has been wasted twice. */
  function validate(f) {
    var ext = (f.name.split(".").pop() || "").toLowerCase();
    if (OK_EXT.indexOf(ext) < 0 && !OK_MIME.test(f.type || "")) {
      return "That file type isn't accepted. Please send a PDF, JPG, PNG or HEIC.";
    }
    if (f.size > MAX_BYTES) {
      return "That file is " + (f.size / 1048576).toFixed(1) + "MB, which is over the 10MB limit. Try photographing it again at a lower quality, or send the pages separately.";
    }
    if (!f.size) return "That file appears to be empty.";
    return null;
  }

  function fail(i, msg) {
    var e = $("err-" + i);
    e.style.display = "block";
    e.textContent = msg;
    $("bar-" + i).style.display = "none";
    $("prog-" + i).style.display = "none";
  }

  /* The file goes up as a real multipart part, so nothing has to be encoded
     first. What the browser CAN measure is reading the file off the device,
     which on a phone photographing a bank statement is not instant — so that
     gets a real percentage and the send that follows is shown as a separate,
     honestly indeterminate phase rather than a bar that sits at 99%.
     Purely cosmetic: the upload does not wait on it, and a reader that fails
     is ignored rather than blocking a send that would have worked. */
  function previewRead(f, onProgress) {
    return new Promise(function (resolve) {
      try {
        var r = new FileReader();
        r.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
        r.onerror = function () { resolve(); };
        r.onloadend = function () { resolve(); };
        r.readAsArrayBuffer(f);
      } catch (e) { resolve(); }
    });
  }
  /* WHAT EACH STATUS MEANS TO THE PERSON HOLDING THE PHONE. Matched on the
     NUMBER, never on the message: the deployed function's wording contains
     em-dashes and will change, and a page that greps error text breaks the
     first time somebody rewrites a sentence.
       retry  — worth pressing Send again
       reload — the list this page is holding is out of date; go and re-read it
       dead   — this link is finished; show the invalid page */
  var STATUS_COPY = {
    400: { kind: "retry", msg: "Something about that upload wasn't accepted. Please try again." },
    404: { kind: "reload", msg: "That document isn't on your list any more. Refreshing…" },
    409: { kind: "reload", msg: "We already have that one — thank you." },
    413: { kind: "retry", msg: "That file is over the 10MB limit. Try photographing it again at a lower quality, or send the pages separately." },
    415: { kind: "retry", msg: "That file wasn't accepted. Please send a PDF, JPG, PNG or HEIC — and check the file really is what its name says." },
    429: { kind: "retry", msg: "That's a lot of uploads at once. Please wait a minute and try again." },
    500: { kind: "retry", msg: "That didn't save at our end. Please try again in a moment — nothing has been lost." },
  };
  /* Re-read the checklist from the server. Used when the page's copy of the
     list is provably stale (a 404 or a 409), which is the only honest response
     to "that isn't on your list any more": either the list has moved on, or the
     link has, and the GET is what tells the two apart. */
  async function refreshList() {
    try {
      var res = await fetch(FN + "?token=" + encodeURIComponent(token), { method: "GET" });
      var j = await res.json();
      if (!res.ok || !j || j.error) { show("invalid"); return false; }
      STATE.name = j.first_name || STATE.name;
      STATE.items = (j.items || []).map(function (d) { return { id: d.id, item: d.item, status: d.status }; });
      render();
      if (j.complete || !STATE.items.filter(function (d) { return d.status === "requested"; }).length) show("alldone");
      return true;
    } catch (e) { return false; }
  }

  async function upload(i) {
    var d = STATE.items[i];
    var input = $("file-" + i), send = $("send-" + i);
    var f = input.files && input.files[0];
    if (!f) return;
    var bad = validate(f);
    if (bad) return fail(i, bad);
    /* The server identifies the document by ID, so a row this page somehow
       holds without one cannot be uploaded against. Refuse and re-read the
       list rather than guessing at the name — a guess would either 404 or,
       worse, land on the wrong item. */
    if (!d.id) { fail(i, "This list is out of date. Reloading it now…"); refreshList(); return; }
    send.disabled = true;
    input.disabled = true;
    $("err-" + i).style.display = "none";
    var bar = $("bar-" + i), fill = $("fill-" + i), prog = $("prog-" + i);
    bar.style.display = "block";
    bar.className = "bar";
    prog.style.display = "block";
    prog.textContent = "Preparing…";
    fill.style.width = "0%";
    var restore = function () { input.disabled = false; send.disabled = false; };
    try {
      await previewRead(f, function (p) {
        fill.style.width = Math.round(p * 100) + "%";
        prog.textContent = "Preparing… " + Math.round(p * 100) + "%";
      });
      fill.style.width = "100%";
      bar.className = "bar indet";
      prog.textContent = "Sending…";
      /* THE DEPLOYED CONTRACT, exactly.
         · multipart/form-data, one file per request.
         · `token` goes in the BODY. Query parameters are ignored on POST, and
           putting a bearer token in a URL is how it ends up in a proxy log.
         · `item_id`, not the item's name: an adviser can rename an item while
           this page is open, and matching on the name is a race with a typo.
         · the file part carries its FILENAME, because the extension is what
           the server types the file by.
         · NO Content-Type header is set. Setting it by hand drops the multipart
           boundary the browser generates, and the whole body becomes unparseable.
         · the `website` honeypot is deliberately NOT sent. */
      var fd = new FormData();
      fd.append("token", token);
      fd.append("item_id", d.id);
      fd.append("file", f, f.name);
      var res = await fetch(FN, { method: "POST", body: fd });
      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }

      if (!res.ok) {
        var how = STATUS_COPY[res.status] || { kind: "retry", msg: "That didn't send. Please check your connection and try again — nothing has been lost." };
        if (how.kind === "reload") {
          /* A 409 means the server already has it; a 404 means it is no longer
             on the list. Either way this page's copy is stale, and the GET
             settles whether the LINK is still alive too. */
          banner(how.msg, res.status === 409 ? "ok" : "err");
          restore();
          await refreshList();
          return;
        }
        restore();
        fail(i, how.msg);
        return;
      }
      /* A SUCCESS HAS TO LOOK LIKE ONE. The honeypot answers 200 with a bare
         {ok:true} and writes nothing, so a response with no item and no
         outstanding count is not an upload — treating it as one would show a
         client a tick for a document we do not have. */
      if (!j || !j.ok || typeof j.item !== "string" || typeof j.outstanding !== "number") {
        restore();
        fail(i, "That didn't go through. Please try again — nothing has been lost.");
        return;
      }
      d.status = "received";
      banner(j.item + " received — thank you.", "ok");
      render();
      /* The server's count is the one that decides, not this page's arithmetic:
         it is what saves a second GET, and it is right even if somebody in the
         office ticked an item off by hand a moment ago. */
      if (j.outstanding === 0) show("alldone");
    } catch (e) {
      restore();
      fail(i, "That didn't send. Please check your connection and try again — nothing has been lost.");
    }
  }

  /* ---- start ---------------------------------------------------------- */
  if (!token) { show("invalid"); return; }
  /* The method is stated explicitly rather than left to default: this is the
     one call on the page that must be a GET, and a proxy or a stub that reads
     `init.method` sees the wrong verb if it is omitted. */
  fetch(FN + "?token=" + encodeURIComponent(token), { method: "GET" })
    .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
    .then(function (o) {
      if (!o.ok || !o.j || o.j.error) { show("invalid"); return; }
      STATE.name = o.j.first_name || "";
      /* The firm's own name, where the function returns one — the same courtesy
         the fact-find page does, so a rebrand does not leave this page saying
         something the client has never heard of. ESCAPED FIRST: this is the one
         place on the page that writes innerHTML, the value is a settings row a
         browser somewhere put there, and this page has no login in front of it.
         Escaping cannot touch the word the span is wrapped round, so the
         highlight still works. */
      if (o.j.company) {
        document.querySelector(".brand").innerHTML = esc(o.j.company).replace(/Money/i, "<span>Money</span>");
      }
      STATE.items = (o.j.items || []).map(function (d) { return { id: d.id, item: d.item, status: d.status }; });
      if (!STATE.items.length || o.j.complete) {
        $("alldone-sub").textContent = STATE.items.length
          ? "We have everything we asked for. Your adviser will be in touch if anything else is needed. You can close this page."
          : "There is nothing outstanding on your file at the moment. If you were expecting a list, please contact your adviser.";
        show("alldone");
        return;
      }
      show("page");
      render();
    })
    .catch(function () { show("invalid"); });
})();
