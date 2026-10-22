/* R95 · C — boot.js: the FIRST script on the back-office page (before the supabase CDN tag, core.js and the
   rest). It holds the three things that used to be inline in index.html, so the admin CSP can drop
   'unsafe-inline' from script-src: the deploy build tag, the Inter webfont swap, the service-worker registration.
   It declares no globals other scripts read at definition time; NX_BUILD_TAG is read by app.js's boot.
   R81 · A3 — NX_BUILD_TAG is the deploy handshake: each admin script stamps its own window.__nxTag_*, and app.js
   compares all eight (this one + the seven __nxTag_*). EVERY round that edits ANY back-office script bumps all eight. */
window.NX_BUILD_TAG = "r94";

/* The Inter stylesheet is fetched as media="print" (non-blocking) and switched to all media once it has
   loaded — what the old inline onload="this.media='all'" did. boot.js runs at the end of <body>, so the
   sheet may already be in: switch now if so, else on its load event. */
(function () {
  var l = document.querySelector("link[data-swap]");
  if (!l) return;
  var swap = function () { l.media = "all"; };
  if (l.sheet) swap(); else l.addEventListener("load", swap);
})();

// PWA install support. Register only over https (never file:// or the sandbox http harness).
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  try {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(function () {});
    });
  } catch (e) { /* non-blocking */ }
}
