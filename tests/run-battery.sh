#!/usr/bin/env bash
# R91 · 1: run one shard of the Playwright battery — every <of>-th tests/*.js (C-sorted) starting at <shard>
# (1-based). Used by .github/workflows/battery.yml; locally: `bash tests/run-battery.sh 1 40`.
# Suites hard-code REPO=/root/nx and PORT=8099, so this runs from /root/nx (CI symlinks the checkout there).
set -u
SHARD="${1:?usage: run-battery.sh <shard> <of>}"
OF="${2:?usage: run-battery.sh <shard> <of>}"
REPO=/root/nx
PORT=8099
LOGDIR="${BATTERY_LOGDIR:-/tmp/battery-$SHARD-of-$OF}"
mkdir -p "$LOGDIR"
: > "$LOGDIR/battery.log"
cd "$REPO" || { echo "no $REPO"; exit 2; }

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
i=0
for f in $(ls tests/*.js | LC_ALL=C sort); do
  i=$((i + 1))
  [ $(( (i - SHARD) % OF )) -eq 0 ] && [ "$i" -ge "$SHARD" ] || continue
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
done
[ "${#FAILED[@]}" -eq 0 ]
