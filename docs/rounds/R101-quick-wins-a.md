# R101 · Quick wins, batch A (UI/UX review round 1)

From the back-office UI/UX review of 14 Nov 2026 (Claude Doc "NexMoney Back Office — UI/UX & Efficiency Review").

- **X2 / P6 — nothing under 12px.** 97 `font-size` declarations below 12px raised to 12px; 9 uppercase labels
  below 11px raised to 11px (uppercase section labels keep 11–11.5px). The small button rung moves 11.5 → 12
  (`r73_system` C1/C2 re-based: 13.5 / 12.5 / 12).
- **P1 — pipeline card names are never cut off.** The name wraps at word breaks; the dupe chip and the adviser
  badge drop to the next line when there is no room.
- **P4 — the board starts higher.** The desktop "Drag cards between columns…" line is gone (the phone hint
  stays); search and saved-views are capped at 160px so the header is one line at 1366px.
- **B11 — Diary header on one line** (titles no longer wrap; the adviser filter is capped at 160px).
- **O6 — one date-and-time style.** `fmtDT()` in core.js ("12 Nov 2026, 11:10", no seconds), used on the
  Operations email and SMS rows and the change-history rows.

Not built: P3 (already implemented — amber at the stage limit, red at twice it) and N5 (advisers do not see
the Firm group; a fifth group makes the sidebar too tall) — both noted in the review doc. N1 (sidebar counts)
moves to round 2, where the type-scale work frees stylesheet lines under the 3,950 cap.

Eight tags `r101`. Local: smoke 150, r87_shell 56, r73_system 73, r73_visible 88, r37 124, r65_pipeline 127,
r69_today 71, r75_diary 102, r87_pipeline_case 81, r87_today 82, r88_case 69, r88_kit 85, r88_today 67,
r89_operations 64, r90_queues 40, r90_carve 70, r81_platform 69, r94_csp 93, r95_kit 36; lint 0.
