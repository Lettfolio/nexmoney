# R118 — a coloured card edge is backed by an icon and words (review X5)

## What changed
- `ageMarkHtml(age)` (app.js): an amber card's age line starts with a clock, a red one with a warning sign. Each is `role="img"` with the same words in `aria-label` and `title`: "Slow — 12 days in this stage, past the usual 10 days" / "Stuck — 39 days in this stage, more than twice the usual 10 days". `cardAge()` now returns the stage's threshold (`th`).
- The same mark sits in the Table view's "In stage" cell.
- **Legend corrected.** "What the colours mean" said "14+ days" and "30+ days". That was never true: each stage has its own threshold (`AGE_THRESHOLDS`: enquiry 5, fact find 7, DIP 10, application 21, offer 14, exchange 30; red at twice). It now reads "Slow: in this stage longer than usual" and "Stuck: more than twice as long", each with its icon beside the edge swatch. The exact figure is on the mark.

## Harness
Seam mode: no marks; edges unchanged. The legend is static markup, so its wording changes in both modes. `tests/r118_edge_marks.js` (13).
