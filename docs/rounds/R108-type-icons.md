# R108 — One type scale (X1) and one icon set (X9)

Daniel, 16 Nov 2026: "proceed with … the remaining updates".

## What changed
- **X1 — type scale.** Eighteen text sizes (11 → 34px) are now five: **12 / 13 / 14 / 18 / 24**, plus 11px
  for uppercase labels only (the R101 exception). Mapping: 11.5→12 · 12.5, 13.5→13 · 14.5, 15→14 ·
  16, 17, 19, 20, 21→18 · 22, 27, 34 and the two `clamp()` KPI numbers→24. Applied to admin.css and the
  inline sizes in app.js and index.html.
  - Departs from the review's suggested 12 / 13 / **15** / 18 / 24: the body and every form field are 14px,
    so 14 is kept as the base to avoid re-flowing every page.
  - Buttons were three rungs (13.5 / 12.5 / 12); they are now two (13 / 12). `r73_system` C1/C2/D2 re-based.
  - Not done: the five-text-colour half of X1.
- **X9 — icons.** `ICON_PATHS` (41 line icons, 24px grid, stroke = current text colour) and `ICON_OF` (the
  55 emoji mapped onto them). `iconize()` swaps each emoji in visible text for its icon when the page is
  drawn, and a MutationObserver does the same for anything written later. The labels in the code are
  unchanged, so handlers, tests and search text are the same. Left as text: → ✓ ✕ ✗ ↻ ☰ ☑ and the like
  (type, not emoji); anything inside `<option>`, a text box, or `[data-emoji]`; and `title` tooltips.

## Harness
The icon swap is off under the R102 seam (older suites match labels with their emoji). The type scale is
plain CSS and applies everywhere. `tests/r108_type_icons.js` (13): every visible text node on eleven pages
is on the scale; no colour emoji left; icons take the text colour; late-written labels are swapped; text
boxes are not. Tags → r108. admin.css 3,949 lines.
