#!/usr/bin/env bash
# ask3d launcher: web app (Next.js, :3000) + statue sidecar (FastAPI, :8765).
#
#   ./start.sh          start anything not already running, then open the app
#   ./start.sh stop     stop what start.sh started
#   ./start.sh status   show what's running
#   ./start.sh logs     tail both logs
set -euo pipefail
cd "$(dirname "$0")"

LOG_DIR=.logs
PID_DIR=.logs
mkdir -p "$LOG_DIR"

port_alive() { curl -s -m 1 -o /dev/null "http://127.0.0.1:$1$2" 2>/dev/null; }

start_one() { # name, pidfile, logfile, healthport, healthpath, cmd...
  local name=$1 pidfile=$2 logfile=$3 port=$4 path=$5
  shift 5
  if port_alive "$port" "$path"; then
    echo "✓ $name already running on :$port"
    return
  fi
  echo "… starting $name (log: $logfile)"
  nohup "$@" >>"$logfile" 2>&1 &
  echo $! >"$pidfile"
  for _ in $(seq 1 60); do
    if port_alive "$port" "$path"; then
      echo "✓ $name up on :$port"
      return
    fi
    sleep 1
  done
  echo "✗ $name did not come up within 60s — check $logfile" >&2
  exit 1
}

stop_one() { # name, pidfile, port, healthpath
  local name=$1 pidfile=$2 port=$3 path=$4
  if [[ -f $pidfile ]]; then
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      # Kill the whole process group when possible (uv/npm spawn children).
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      echo "✓ stopped $name (pid $pid)"
    else
      echo "- $name not running (stale pidfile)"
    fi
    rm -f "$pidfile"
  else
    echo "- $name has no pidfile (started by hand?)"
  fi
  # Wait for the port to actually free — an immediate re-start would see
  # the dying process still listening and wrongly skip its own launch.
  for _ in $(seq 1 20); do
    port_alive "$port" "$path" || return 0
    sleep 0.5
  done
}

case "${1:-start}" in
  start)
    start_one "statue sidecar" "$PID_DIR/sidecar.pid" "$LOG_DIR/sidecar.log" 8765 /health \
      uv run "$PWD/statue-service/server.py"
    start_one "web app" "$PID_DIR/web.pid" "$LOG_DIR/web.log" 3000 / \
      npm run dev
    echo
    echo "ask3d ready → http://localhost:3000"
    command -v open >/dev/null && open http://localhost:3000
    ;;
  stop)
    stop_one "web app" "$PID_DIR/web.pid" 3000 /
    stop_one "statue sidecar" "$PID_DIR/sidecar.pid" 8765 /health
    ;;
  status)
    port_alive 3000 / && echo "✓ web app on :3000" || echo "✗ web app not running"
    port_alive 8765 /health && echo "✓ statue sidecar on :8765" || echo "✗ statue sidecar not running"
    ;;
  logs)
    tail -n 40 -f "$LOG_DIR/web.log" "$LOG_DIR/sidecar.log"
    ;;
  *)
    echo "usage: ./start.sh [start|stop|status|logs]" >&2
    exit 2
    ;;
esac
