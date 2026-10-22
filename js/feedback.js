/* R95 · D1: feedback.html's inline <script> moved here verbatim — script-src no longer allows 'unsafe-inline'. */
(function () {
  "use strict";
  /* Same override as the document page — the harness points this at the
     sandbox stub without the page needing to know it is being tested. */
  var FN_BASE = String(window.__NEX_FN_BASE || "https://sclghkmvzpwtmnzbkaoe.supabase.co/functions/v1").replace(/\/+$/, "");
  var FN = FN_BASE + "/nps-capture";

  var q = new URLSearchParams(location.search);
  var caseId = q.get("case") || "";
  var token = q.get("token") || "";
  var scoreRaw = q.get("score");
  var score = scoreRaw == null || scoreRaw === "" ? null : Number(scoreRaw);

  var $ = function (id) { return document.getElementById(id); };
  var show = function (id) {
    ["loading", "invalid", "done", "page"].forEach(function (x) { $(x).style.display = (x === id ? "block" : "none"); });
  };
  var banner = function (msg) {
    var b = $("banner");
    if (!msg) { b.innerHTML = ""; b.className = ""; return; }
    b.className = "banner err";
    b.textContent = msg;
  };

  /* The wording, by band. Written to be read by somebody who is annoyed:
     no apology theatre, no exclamation marks, and no attempt to talk them
     out of the score they have already given. */
  function words(n) {
    if (n == null || isNaN(n)) return { cls: "", head: "Thank you for answering.", sub: "", lead: "Tell us what happened and your adviser will pick it up." };
    if (n <= 3) return {
      cls: "low",
      head: "A " + n + " out of 10. We got this badly wrong.",
      sub: "Thank you for saying so rather than saying nothing.",
      lead: "Your adviser will ring you about this. Before they do, it helps to have your side of it in your own words — take as much space as you need.",
    };
    if (n <= 6) return {
      cls: "low",
      head: "A " + n + " out of 10. That is not the job we set out to do.",
      sub: "Thank you for telling us.",
      lead: "Your adviser will ring you about this. Before they do, it helps to have your side of it in your own words — take as much space as you need.",
    };
    if (n <= 8) return {
      cls: "",
      head: "A " + n + " out of 10. Thank you.",
      sub: "There is clearly something we could have done better.",
      lead: "If you tell us what it was, we would like to know.",
    };
    return {
      cls: "high",
      head: "A " + n + " out of 10. Thank you.",
      sub: "",
      lead: "If there is anything you would change, we would still like to hear it.",
    };
  }
  /* WHAT THIS PAGE IS ALLOWED TO PROMISE, BY BAND. The capture function files
     the client's own words on the case and raises a call-back for a score of
     6 or below; above that it records the score and keeps nothing else. So the
     line under the box says what will actually happen to what they type rather
     than making one promise to everybody — "your adviser sees exactly what you
     type" is a specific claim, and it has to be true of the person reading it. */
  function boxNote(n) {
    return (n != null && !isNaN(n) && n <= 6)
      ? "Nothing is edited or summarised — your adviser sees exactly what you type."
      : "Only your score is recorded automatically. If you would like your adviser to read this and ring you, reply to the email we sent you — that reaches them directly.";
  }

  function paint() {
    var w = words(score);
    $("score-block").className = "score " + w.cls;
    $("score-num").textContent = (score == null || isNaN(score)) ? "—" : score + "/10";
    $("score-txt").innerHTML = "<strong></strong>";
    $("score-txt").firstChild.textContent = w.head;
    if (w.sub) {
      var s = document.createElement("small");
      s.textContent = w.sub;
      $("score-txt").appendChild(s);
    }
    $("lead").textContent = w.lead;
    $("count").textContent = boxNote(score);
  }

  /* WHAT MAKES A LINK REAL: the TOKEN, and only the token. The capture function
     resolves a submission by it and refuses anything it cannot resolve —
     no token is a 400, an unknown one is a 404, and a `case` naming a different
     case from the token's is a 404 with nothing written. `case` is sent because
     the function verifies it, not because it looks anything up with it, so a
     client who edits it in the address bar gets a refusal rather than somebody
     else's file.

     AND THE SCORE IS WRITE-ONCE SERVER-SIDE. What is shown below comes from the
     URL, but what is RECORDED is the score the firm already holds where there is
     one; the number in the address bar can only ever fill a blank. So editing it
     changes what this page says, not what goes on the file, and not whether an
     adviser is asked to ring — which is why every claim this page makes after a
     submission is keyed off the response rather than off `score`. */
  if (!caseId && !token) { show("invalid"); return; }

  paint();
  show("page");

  /* R84 — THE SCORE IS RECORDED FROM HERE, NOT FROM THE EMAIL LINK. The link in the
     email is a plain GET, and every link in a delivered email is fetched by the
     recipient's mail security (Safe Links, Defender, Proofpoint) before a person
     sees it — so nps-capture v4 makes that GET a redirect to this page and only
     writes the score on a POST, which those scanners never make because they do
     not run scripts. Write-once server-side still holds: the response carries the
     score the firm actually recorded, and that is what this page then shows.
     Promoters (9–10) are sent on to the review link the server names; nobody else
     leaves this page. */
  function applyContext(j) {
    if (!j || j.error) return;
    if (typeof j.score === "number" && !isNaN(j.score)) { score = j.score; paint(); }
    if (j.first_name) {
      $("lead").textContent = j.first_name + " — " + $("lead").textContent.charAt(0).toLowerCase() + $("lead").textContent.slice(1);
    }
  }
  if (score != null && !isNaN(score) && caseId && token) {
    fetch(FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ case_id: caseId, token: token, score: score }),
    })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (o) {
        /* A 404 here is NOT shown as "invalid" — this call is best-effort context (the R9 contract:
           the page must work without it); the submit below is the one that decides validity. */
        if (!o.j || o.j.error) return;
        applyContext(o.j);
        if (o.j.redirect && typeof o.j.score === "number" && o.j.score >= 9) { location.replace(o.j.redirect); return; }
      })
      .catch(function () { /* the page still works; the comment POST below carries the score again */ });
  } else {
    /* No score on the link (trimmed, or a return visit): best effort only — the JSON
       view gives us a first name and the score the firm holds, which is better than
       nothing. This call can never be the reason somebody cannot complain. */
    fetch(FN + "?format=json&case=" + encodeURIComponent(caseId) + "&token=" + encodeURIComponent(token), { method: "GET" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(applyContext)
      .catch(function () { /* no context available — the page already works */ });
  }

  $("form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var btn = $("submitBtn");
    if (btn.disabled) return;
    var reason = ($("reason").value || "").trim();
    banner("");
    btn.disabled = true;
    btn.textContent = "Sending…";
    try {
      /* The score is only sent when we actually have one. A link that arrived
         without it must not be turned into a recorded 0 — the server holds the
         score it captured and can use that; inventing one here would put a
         number on somebody's file that they never gave. */
      var payload = { case_id: caseId, token: token, reason: reason };
      if (score != null && !isNaN(score)) payload.score = score;
      var res = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      var j = null;
      try { j = await res.json(); } catch (e2) { j = null; }
      if (res.status === 404) { show("invalid"); return; }
      /* A 400 IS NOT A CONNECTION PROBLEM, and must not be dressed as one. The
         capture function refuses a submission it cannot attach a score to — a
         link that reached the client without its score on it, or with one that
         is not 0-10 — and pressing Send again will refuse it again, for ever.
         Saying "check your connection" to somebody in that position sends them
         round a loop that cannot end; the reply-to-the-email route can. */
      if (res.status === 400) {
        banner("We could not record this from the link you followed — it may have been cut short when it was forwarded. Please reply to the email we sent you and what you have written here will reach your adviser directly.");
        btn.disabled = false;
        btn.textContent = "Send this to my adviser";
        return;
      }
      if (!res.ok || !j || j.error) throw new Error((j && j.error) || "failed");
      /* WHAT WE MAY SAY WE DID WITH THEIR WORDS. `note_created` is the server
         telling us whether it kept them. Above a 6 it does not, so a client who
         typed something has to be told where to send it instead — the old copy
         here said their comments were on their file, which for that client was
         not true. Nothing is claimed that the response does not report. */
      if (j.note_created === false && j.detractor === false) {
        $("done-sub").textContent = reason
          ? "Your score has been recorded — thank you for taking the time. If you would like your adviser to read what you have written and ring you, reply to the email we sent you and it reaches them directly. You can close this page."
          : "Your score has been recorded. Thank you for taking the time. You can close this page.";
      }
      show("done");
    } catch (e3) {
      banner("Sorry, that didn't send. Please check your connection and try again — what you have written is still here.");
      btn.disabled = false;
      btn.textContent = "Send this to my adviser";
    }
  });
})();
