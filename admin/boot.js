/* R95 · C — boot.js: the FIRST script on the back-office page (before the supabase-js tag, core.js and the
   rest). It holds the three things that used to be inline in index.html, so the admin CSP can drop
   'unsafe-inline' from script-src: the deploy build tag and the service-worker registration (the Inter webfont swap went in R136: the face is served from this site by admin.css).
   It declares no globals other scripts read at definition time; NX_BUILD_TAG is read by app.js's boot.
   R81 · A3 — NX_BUILD_TAG is the deploy handshake: each admin script stamps its own window.__nxTag_*, and app.js
   compares all eight (this one + the seven __nxTag_*). EVERY round that edits ANY back-office script bumps all eight. */
window.NX_BUILD_TAG = "r138";

/* R116: iOS zooms the page when a field with text under 16px takes focus, and leaves it zoomed and sliding
   sideways. maximum-scale=1 stops that zoom on iOS only; pinch-zoom still works there, and other phones keep
   the plain viewport so their pinch-zoom is untouched. */
(function () {
  var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var m = document.querySelector('meta[name="viewport"]');
  if (ios && m) m.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover");
})();

// PWA install support. Register only over https (never file:// or the sandbox http harness).
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  try {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(function () {});
    });
  } catch (e) { /* non-blocking */ }
}
