#!/usr/bin/env bash
# R91 · 1: run one shard of the Playwright battery — every <of>-th tests/*.js (C-sorted) starting at <shard>
# (1-based). Used by .github/workflows/battery.yml; locally: `bash tests/run-battery.sh 1 40`.
# Suites hard-code REPO=/root/nx and PORT=8099, so this runs from /root/nx (CI symlinks the checkout there).
set -u
SHARD="${1:?usage: run-battery.sh <shard> <of>}"
OF="${2:?usage: run-battery.sh <shard> <of>}"
REPO="${BATTERY_REPO:-/root/nx}"   # R135: overridable so the shard list can be printed from another checkout
PORT=8099
LOGDIR="${BATTERY_LOGDIR:-/tmp/battery-$SHARD-of-$OF}"
mkdir -p "$LOGDIR"
: > "$LOGDIR/battery.log"
cd "$REPO" || { echo "no $REPO"; exit 2; }

# R135: which suites this shard runs. Every tests/*.js goes to exactly one shard. With tests/battery-weights.tsv
# (suite <tab> seconds, from a CI run) the suites are dealt longest-first to whichever shard is lightest so far,
# so the shards finish together; a suite the file does not know counts as 50 s. Without the file: every
# <of>-th suite, as before. `BATTERY_LIST=1` prints the list and stops.
shard_suites() {
  if [ -f tests/battery-weights.tsv ]; then
    ls tests/*.js | LC_ALL=C sort | awk -v shard="$SHARD" -v of="$OF" '
      FNR == NR { w[$1] = $2 + 0; next }
      { n = $0; sub(/^tests\//, "", n); sub(/\.js$/, "", n); name[++k] = n; wt[k] = (n in w) ? w[n] : 50 }
      END {
        for (a = 1; a <= k; a++) ord[a] = a
        for (a = 2; a <= k; a++) { v = ord[a]; for (b = a - 1; b >= 1 && wt[ord[b]] < wt[v]; b--) ord[b + 1] = ord[b]; ord[b + 1] = v }
        for (a = 1; a <= k; a++) { best = 1; for (c = 2; c <= of; c++) if (load[c] + 0 < load[best] + 0) best = c
          load[best] += wt[ord[a]]; if (best == shard) print "tests/" name[ord[a]] ".js" }
      }' tests/battery-weights.tsv - | LC_ALL=C sort
  else
    ls tests/*.js | LC_ALL=C sort | awk -v shard="$SHARD" -v of="$OF" '(NR - shard) % of == 0 && NR >= shard'
  fi
}
if [ -n "${BATTERY_LIST:-}" ]; then shard_suites; exit 0; fi


# smoke.js regenerates admin/mock.html — every shard needs it.
if ! node smoke.js > "$LOGDIR/smoke.out" 2>&1; then
  echo "smoke.js FAILED"; tail -40 "$LOGDIR/smoke.out"; exit 1
fi
tail -1 "$LOGDIR/smoke.out"

# Start the server BEFORE the battery (HARNESS: a suite's self-spawned server racing another is the known flake).
SERVER_PID=""
if ! curl -s -o /dev/null "http://localhost:$PORT/admin/mock.html" 2>/dev/null; then
  if command -v python3 >/dev/null 2>&1; then
    python3 -m http.server "$PORT" >/dev/null 2>&1 &
  else
    node -e '
      const http = require("http"), fs = require("fs"), path = require("path");
      const T = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
                  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
                  ".woff2": "font/woff2", ".pdf": "application/pdf", ".csv": "text/csv", ".txt": "text/plain" };
      http.createServer((q, r) => {
        let p = decodeURIComponent(q.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
        const f = path.join(process.cwd(), path.normalize(p));
        fs.readFile(f, (e, b) => { if (e) { r.writeHead(404); return r.end(); }
          r.writeHead(200, { "Content-Type": T[path.extname(f)] || "application/octet-stream" }); r.end(b); });
      }).listen(+process.argv[1]);' "$PORT" &
  fi
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://localhost:$PORT/admin/mock.html" && break; sleep 0.2; done
fi
trap '[ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

FAILED=()
for f in $(shard_suites); do
  n=$(basename "$f" .js)
  s=$(date +%s)
  if timeout 900 node "$f" > "$LOGDIR/$n.out" 2>&1; then rc=0; else rc=$?; fi
  e=$(date +%s)
  sum=$(grep -E "checks|failures|passed" "$LOGDIR/$n.out" | tail -1)
  line="$n rc=$rc $((e - s))s :: $sum"
  echo "$line" | tee -a "$LOGDIR/battery.log"
  [ "$rc" -ne 0 ] && FAILED+=("$n")
done

echo "shard $SHARD/$OF: ${#FAILED[@]} failing suite(s); logs in $LOGDIR"
for n in "${FAILED[@]}"; do
  echo "===== $n (last 40 lines) ====="
  tail -40 "$LOGDIR/$n.out"
  # R94: on GitHub the job log needs a sign-in but annotations don't — name the suite and its
  # failing lines there (workflow command; a no-op when run locally).
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    msg=$(grep -aE "✗|✘|FAIL|Error|failed" "$LOGDIR/$n.out" | grep -v " 0 failed" | tail -6 | tr -d '\r' | sed 's/%/%25/g; s/\r/%0D/g' | paste -sd '|' -)
    echo "::error title=battery $SHARD/$OF: $n failed::${msg:-see job log}"
  fi
done
[ "${#FAILED[@]}" -eq 0 ]
