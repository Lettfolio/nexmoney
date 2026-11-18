# R119 — explaining sentences behind an "i" on Operations and Settings (review X6)

## What changed
`tuckProse(root)` (app.js, real mode only, run from the same MutationObserver as `iconize`): a `p.panel-sub` on Operations or Settings that sits directly under a heading, has ten or more words and no control inside it is hidden, and its heading gains a small `i` button (`.info-i`, `aria-expanded`, `aria-controls`). Pressing the button shows the sentence where it always was; pressing again hides it; hovering puts the sentence in the tooltip. Works from the keyboard and on touch.

Moved: Import's two door explainers; Settings › Firm & rules (before go-live, rules that block work), Team & security (sign-off, two-step sign-in, introducers), Data (change history, error log ×2).

## Deliberately left on show
- Anything that reports a state or warns: `#em-morning-sub`, `#sms-summary`, `#email-sending-sub`, `#set-doc-chase-pointer`, `#firm-export-sub` ("Not encrypted…"), the second-owner notice, the financial-promotions warning (`data-keep`), and any line under ten words ("2 of 4 logins have one.").
- `#emails-intro`: R42 · F4 chose it as one of the two facts an operator needs on arriving at Emails. Tucking it would reverse that decision.
- **Today:** measured — it has no explaining sentence of twelve words or more outside its rows, so nothing moved.

## Harness
Seam mode: no `i` buttons, every sentence on show. `tests/r119_prose_info.js` (17).
