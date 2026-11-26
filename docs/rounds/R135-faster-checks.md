# R135 — checks in about 18 minutes (26 Nov 2026)

From the performance review (project doc `claude/performance-review-2026-11.md`); Daniel said "go".

**Before:** four shards of 30, 33, 34 and 40 minutes — every PR waited 41 minutes. The suites were dealt every fourth by name, so one shard happened to hold the long ones.

**Now:**
- Eight shards (`suites (1)` … `suites (8)`).
- `tests/battery-weights.tsv` holds each suite's seconds from run 45450920695 (main, 24 Nov; 157 suites, 7,826 s). `tests/run-battery.sh` deals suites longest-first to the lightest shard: eight shards of 976–981 s by those figures. A suite not in the file counts as 50 s; without the file the old every-nth rule applies.
- Every suite is in exactly one shard (checked: 157 listed, 157 distinct, none twice; four-shard and forty-shard splits likewise).
- The ruleset on main requires checks called `battery (1)` … `battery (4)`. Four small jobs with those names now report the combined result of all eight shards, so the rule protects main exactly as before and needs no change. If build-check fails or a run is cancelled they fail too.
- Each shard uploads its `battery.log` (suite timings) on every run, so the weights can be refreshed.
- `BATTERY_LIST=1 bash tests/run-battery.sh <n> <of>` prints a shard's suites and stops.

**Not changed:** which suites run, how each runs, the post-merge run on main.

**To confirm on this PR's own run:** wall time, and that a red shard turns the four `battery` checks red (not exercised here — it would need a deliberately failing commit).
