# R106 — The one-button row on Protection, Clients and the Vault (B12, O9)

Daniel's answer on 16 Nov 2026: "yes" to Protection, Clients and the Vault following the R105 pattern.
(Kim opens Today on All — already the case since R102; nothing changed.)

## What changed
- **Kit default.** `rowItemHtml()` is one-button for every list built on it (`one` defaults on). Protection rows
  show 📝 Log call; Task, Email and each case's Open sit behind ⋯. Clients rows carried no row verbs, so they
  are unchanged in practice; Retention already followed (R105).
- **Vault (O9).** An entry is one line: name, the login it is for, owner and visibility chips, then
  **Copy username** and **Copy password**. Edit and Delete are in the ⋯ menu (an adviser, who cannot
  delete, gets Edit on the row instead of a one-item menu). Every field, with its own reveal and copy, and
  the note, are under "Details · N fields". Copy password copies without revealing. 72 → 45 controls for
  the 12 sample entries.

## Harness
The R102 seam keeps the open Vault card and the three-verb row for the older suites.
`tests/r106_rows.js` (18) reads the real layout. Tags → r106. admin.css 3,949 lines.
