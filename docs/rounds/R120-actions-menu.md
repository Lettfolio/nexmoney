# R120 — the case record's Actions menu stays on the screen

Reported by Daniel from his iPhone on 18 Nov with a screenshot: pressing Actions on a case opened the menu mostly off the left edge.

**Cause.** `.more-actions-menu` hangs from its button's right edge (`right: 0`). In the full-width record (R109) on a phone the Actions button sits near the left, so a 240px menu started 96px before the screen (measured: left −96 at 390px). R116's `overflow-x: hidden` on the record then clipped it instead of letting the page slide.

**Fix.** `menuFit(menu)` (app.js) runs each time the menu opens: it slides the menu sideways until both edges are at least 8px inside the viewport and caps its height at the visible bottom so its own scroll takes over. `#case-more-actions` also gets `max-width: calc(100vw - 16px)`. Applies in both harness modes; on tablet and desktop the menu already fits and is left where the stylesheet puts it.

`tests/r120_actions_menu.js` (10): 390×844, 390×560, 320×640, seam, tablet, desktop.
