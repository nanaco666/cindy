#!/usr/bin/env bash
# run-spike.sh — launch CindyComputerUseSpike.app, run validation probes, summarize.
#
# Validation probes (all read-only, no TCC prompts):
#   ① Process tree: confirm daemon's responsible process is CindyComputerUseSpike.app
#   ② Client discovery: cua-driver status + permissions status --json (read-only)
#   ③ Stability: observe for 30 seconds, confirm pid/responsible unchanged
#
# Usage: ./run-spike.sh
# Prerequisites: ./build-spike.sh must have been run first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_BUNDLE="$SCRIPT_DIR/CindyComputerUseSpike.app"
ENGINE="$SCRIPT_DIR/engine/cua-driver"
LOGS_DIR="$SCRIPT_DIR/logs"
DAEMON_PID_FILE="$LOGS_DIR/daemon.pid"
SOCKET="$HOME/Library/Caches/cua-driver/cua-driver.sock"

mkdir -p "$LOGS_DIR"

# ── helpers ──────────────────────────────────────────────────────────────────

log() { echo "[run-spike] $*"; }
err() { echo "[run-spike] ERROR: $*" >&2; }

require_app() {
  if [[ ! -d "$APP_BUNDLE" ]]; then
    err "App bundle not found: $APP_BUNDLE"
    err "Run ./build-spike.sh first."
    exit 1
  fi
}

wait_for_daemon() {
  local deadline=$((SECONDS + 20))
  log "Waiting for daemon to create socket..."
  while [[ $SECONDS -lt $deadline ]]; do
    if [[ -S "$SOCKET" ]]; then
      log "Socket found: $SOCKET"
      return 0
    fi
    sleep 0.5
  done
  err "Daemon socket did not appear after 20s."
  return 1
}

read_daemon_pid() {
  local deadline=$((SECONDS + 10))
  while [[ $SECONDS -lt $deadline ]]; do
    if [[ -f "$DAEMON_PID_FILE" ]]; then
      cat "$DAEMON_PID_FILE"
      return 0
    fi
    sleep 0.3
  done
  err "daemon.pid not written after 10s"
  return 1
}

# ── pre-flight ────────────────────────────────────────────────────────────────

require_app
log "App bundle: $APP_BUNDLE"
log "Engine: $ENGINE"

# Kill any stale daemon
if [[ -S "$SOCKET" ]]; then
  log "Stale socket detected — cleaning up..."
  "$ENGINE" stop 2>/dev/null || true
  sleep 1
  rm -f "$SOCKET"
fi

# ── Step 1: Launch the spike app via LaunchServices ──────────────────────────

log ""
log "=== Step 1: Launching CindyComputerUseSpike.app via LaunchServices ==="
log "This makes it the responsible process for all child processes."

# -n = new instance, -g = do not bring to foreground (background launch)
open -n -g "$APP_BUNDLE"
COMPANION_LAUNCH_TIME=$SECONDS

log "Companion launched. Waiting for daemon..."
wait_for_daemon

DAEMON_PID=$(read_daemon_pid)
log "Companion app PID (via pgrep): $(pgrep -f 'CindyComputerUseSpike' | head -1)"
log "Daemon PID: $DAEMON_PID"

# ── Step 2: ① Process tree / responsible process check ───────────────────────

log ""
log "=== Step 2: ① Process tree — responsible process verification ==="

# Get the companion's PID
COMPANION_PID=$(pgrep -f "CindyComputerUseSpike" | head -1)
log "CindyComputerUseSpike PID: $COMPANION_PID"

log ""
log "--- ps process tree ---"
ps -o pid,ppid,comm -p "$DAEMON_PID" "$COMPANION_PID" 2>/dev/null || ps -ef | grep -E "cua-driver|CindyComputerUseSpike" | grep -v grep

log ""
log "--- launchctl procinfo for daemon pid=$DAEMON_PID ---"
PROCINFO_OUTPUT=$(launchctl procinfo "$DAEMON_PID" 2>&1)
echo "$PROCINFO_OUTPUT"

# Extract responsible pid/path
RESPONSIBLE_LINE=$(echo "$PROCINFO_OUTPUT" | grep -i "responsible" | head -5)
log ""
log "--- Responsible fields ---"
echo "$RESPONSIBLE_LINE"

# Check if responsible PID matches companion PID
if echo "$PROCINFO_OUTPUT" | grep -q "responsible unique pid.*$COMPANION_PID\|responsible pid.*$COMPANION_PID"; then
  log "✅ PASS ①: Daemon's responsible PID = $COMPANION_PID (CindyComputerUseSpike)"
else
  log "⚠️  Responsible PID check: see raw procinfo above. Companion PID=$COMPANION_PID"
fi

# ── Step 3: ② Client discovery ───────────────────────────────────────────────

log ""
log "=== Step 3: ② Client discovery — connecting to daemon via CLI ==="

log "--- cua-driver status ---"
"$ENGINE" status 2>&1 || true

log ""
log "--- cua-driver permissions status --json (read-only, no prompts) ---"
PERM_STATUS=$("$ENGINE" permissions status --json 2>&1)
echo "$PERM_STATUS"

# Parse and summarize
log ""
log "--- Permissions summary ---"
if command -v python3 >/dev/null 2>&1; then
  echo "$PERM_STATUS" | python3 -c "
import json, sys
try:
  data = json.loads(sys.stdin.read())
  print('  accessibility:     ', data.get('accessibility'))
  print('  screen_recording:  ', data.get('screen_recording'))
  src = data.get('source', {})
  print('  source.attribution:', src.get('attribution'))
  print('  source.host_bundle:', src.get('host_bundle_id'))
  print('  source.embedded:   ', src.get('embedded'))
  print('  source.pid:        ', src.get('pid'))
  print('  note:', src.get('note','')[:120])
except Exception as e:
  print('  (parse error:', e, ')')
" 2>&1 || true
fi

# ── Step 4: ③ Stability check ────────────────────────────────────────────────

log ""
log "=== Step 4: ③ Stability check (30 seconds) ==="
log "Watching pid=$DAEMON_PID for 30 seconds..."

INITIAL_PID=$DAEMON_PID
STABLE=true
for i in $(seq 1 6); do
  sleep 5
  if ! kill -0 "$INITIAL_PID" 2>/dev/null; then
    log "❌ FAIL ③: Daemon pid=$INITIAL_PID died at t=${i}×5s"
    STABLE=false
    break
  fi
  # Verify no re-exec (pid unchanged)
  CURRENT_PID=$(cat "$DAEMON_PID_FILE" 2>/dev/null || echo "$INITIAL_PID")
  if [[ "$CURRENT_PID" != "$INITIAL_PID" ]]; then
    log "❌ FAIL ③: Daemon re-exec'd! Old pid=$INITIAL_PID, new pid=$CURRENT_PID"
    STABLE=false
    break
  fi
  log "  t=${i}×5s: pid=$DAEMON_PID alive ✓"
done

if $STABLE; then
  log "✅ PASS ③: Daemon stable for 30s, pid=$DAEMON_PID unchanged"

  # Final responsible process check after stability window
  log ""
  log "--- Final responsible process check after 30s ---"
  PROCINFO_FINAL=$(launchctl procinfo "$DAEMON_PID" 2>&1)
  echo "$PROCINFO_FINAL" | grep -i "responsible" | head -5
fi

# ── Summary ───────────────────────────────────────────────────────────────────

log ""
log "=== SPIKE SUMMARY ==="
log "Companion PID:   $COMPANION_PID"
log "Daemon PID:      $DAEMON_PID"
log "Socket:          $SOCKET"
log ""
log "Evidence files:"
log "  Companion log: $LOGS_DIR/companion.log"
log "  Daemon log:    $LOGS_DIR/daemon.log"
log "  Daemon PID:    $DAEMON_PID_FILE"
log ""
log "Run ./stop-spike.sh to clean up."
