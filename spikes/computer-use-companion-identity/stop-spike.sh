#!/usr/bin/env bash
# stop-spike.sh — kill CindyComputerUseSpike.app and its daemon child, clean up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE="$SCRIPT_DIR/engine/cua-driver"
LOGS_DIR="$SCRIPT_DIR/logs"
DAEMON_PID_FILE="$LOGS_DIR/daemon.pid"
SOCKET="$HOME/Library/Caches/cua-driver/cua-driver.sock"

log() { echo "[stop-spike] $*"; }

# Stop daemon gracefully via its own stop command
if [[ -S "$SOCKET" ]]; then
  log "Stopping daemon via cua-driver stop..."
  "$ENGINE" stop 2>/dev/null || true
  sleep 1
fi

# Kill by pid file
if [[ -f "$DAEMON_PID_FILE" ]]; then
  DAEMON_PID=$(cat "$DAEMON_PID_FILE")
  if kill -0 "$DAEMON_PID" 2>/dev/null; then
    log "Killing daemon pid=$DAEMON_PID"
    kill "$DAEMON_PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -f "$DAEMON_PID_FILE"
fi

# Kill any stray cua-driver processes from this spike
pkill -f "cua-driver serve" 2>/dev/null && log "Killed stray cua-driver serve" || true

# Kill the companion app
pkill -f "CindyComputerUseSpike" 2>/dev/null && log "Killed CindyComputerUseSpike" || true

# Cleanup socket
rm -f "$SOCKET"
log "Socket cleaned up."

# Verify
sleep 0.5
if pgrep -f "CindyComputerUseSpike" >/dev/null 2>&1; then
  log "WARNING: CindyComputerUseSpike still running"
elif pgrep -f "cua-driver serve" >/dev/null 2>&1; then
  log "WARNING: cua-driver serve still running"
else
  log "✅ All spike processes terminated."
fi
