# R105 — One main button per row, the rest behind ⋯ (review items T2, B6, X8)

Daniel ticked T2/B6/X8 in the UI/UX review on 14 Nov 2026 ("Proceed", 15 Nov).

## What changed
- **Today (T2).** A My Day row shows the verb that completes it and a ⋯ handle; the other verbs sit in the
  menu. Task rows: ✓ Done, with Snooze and Open in the menu. A started appointment: ✓ Attended, with
  No-show and Open in the menu. Email rows: Handled. Rows with a `.btn-primary` (Accept, Fix contact,
  Add next step, Open case) keep that one. `rowOneHtml()` re-seats the finished action HTML, attributes
  untouched, so every handler is the one it was.
- **Retention (B6).** 📞 Log call is the row button; Start retention case, Book review and the rate-end
  outcomes are in the ⋯ menu (`rowItemHtml({ one: true })`).
- **Operations (X8).** Email and SMS rows: Use current address / Fix contact leads; Retry and Cancel are
  in the menu when there are three verbs.
- **Rules.** A menu is never built for a single leftover (two buttons are shown instead). The menu folds
  up when a verb in it is pressed, on Escape, and when another menu opens.

## Not changed, on purpose
- Phone number and 💬 Text stay on the row's text line (they are the contact, not a verb).
- Sub-line verbs (Clear; Snooze… / Dismiss on a critical check folded under a row) stay on their sub-line.
- Lead rows keep Accept, ✕ and the assignee picker (two verbs).
- **Vault is untouched.** Its cards already carry one Edit and one copy per field (R87); turning them
  into rows is review item O9, which was not ticked.
- Protection and Clients rows keep the three-verb kit (B12 not ticked).
- Bulk bars keep "More ▾".

## Harness
The seam from R102 (`__NEX_TODAY_SCOPE === "all"`, off with `?scope=default`) also keeps every verb on the
row, so the pre-R105 suites click what they always clicked. `tests/r105_rows.js` (24) reads the real layout.
Tags → r105.
