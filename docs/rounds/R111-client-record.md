# R111 — A client opens as a full-width record with tabs (B3)

Daniel, 16 Nov 2026: full-width record pages; "proceed with this and the remaining updates".

## What changed
- An existing client no longer opens in the 640px pop-up. `recordLayout()` now handles two kinds of
  record (`#modal[data-record="case"|"client"]`). For a client: the name across the top; contact line,
  last contact, advocacy line, duplicate hint and the portfolio strip down the left; three tabs on the
  right — **Cases**, **Timeline**, **Details**.
- Timeline is a tab, so the "Folded by default…" sentence and the fold's tooltip are removed in the record.
- Details is the client form in three columns.
- Each kind of record remembers its own last tab (`recordTabOf`). A client opened to fix one field (failed
  send, missing date of birth) lands on Details with the cursor in the field, and that visit does not
  change the remembered tab.
- **B3 remainder:** the four-line explanation under the portfolio totals is an "i" tooltip on the strip
  (R103's `.kpi-i`), kept as screen-reader text.
- **B4:** "Delete client" is no longer in the footer beside Save; it sits at the foot of the Details tab.
- **B5:** focus starts on the client's name, not on the phone number.
- The cases block gained an id, `#client-cases-block`. Nothing is re-rendered and no handler moves.

## Unchanged
- **Save and Cancel stay on a client.** Save-as-you-go was asked for on case fields only.
- A new client keeps the small panel. So does everything under the harness seam.

## Harness
`tests/r111_client_record.js` (20). `r109_record` C2 re-based (it asserted the client record was still
the pop-up). No CSS added; admin.css 3,949 lines. Tags → r111.
