# R128 — Reports' first screen, and a hint on scrolling filter rows

Daniel's "proceed" on the fresh review's layout items, 22 Nov 2026 (B and D). Real mode only, except the hero's one-line layout (stylesheet, both modes).

- **B — Reports.** At 1366×768 the adviser scoreboard's first row is now on the first screen (it started at 956px). The hero's basis lines, the Proc/Broker/Sols glossary and the scoreboard's scope sentence sit behind an "i" on their headings (`tuckReports`, `tuckUnder`) — same words, shown in place on a click, read as a tooltip on hover. The "Also scoped to the month selected above." divider is hidden. The hero's comparison line and twelve-month line share one row.
- **D — filter rows.** A filter row that scrolls sideways (`.seg-strip`, Today's numbers and ops chips) fades out at its right edge while more is hidden there (`stripHints`, `.more-right`), and clears at the end. Chosen over wrapping: wrapped, Retention's twelve chips take four lines above the list.

Tests: `tests/r128_reports_strips.js` (14).
