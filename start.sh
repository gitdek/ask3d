#!/usr/bin/env bash
# ask3d launcher: web app (Next.js, :3000) + statue sidecar (FastAPI, :8765).
#
#   ./start.sh            start anything not already running, then open the app.
#                         Listens on your LAN address too, so your phone and any
#                         other device on the Wi-Fi can use it — statues included.
#   ./start.sh --local    loopback only: nothing off this machine can reach it
#   ./start.sh stop       stop what start.sh started, running generators included
#   ./start.sh status     show what's running
#   ./start.sh logs       tail both logs
set -euo pipefail
cd "$(dirname "$0")"

LOG_DIR=.logs
PID_DIR=.logs
mkdir -p "$LOG_DIR"

MODE=start
LAN=1  # the app is meant to be usable from a phone; --local opts out
for arg in "$@"; do
  case "$arg" in
    --local | --loopback) LAN=0 ;;
    --lan) LAN=1 ;; # now the default; still accepted
    start | stop | status | logs) MODE=$arg ;;
    *)
      echo "usage: ./start.sh [start [--local]|stop|status|logs]" >&2
      exit 2
      ;;
  esac
done

port_alive() { curl -s -m 1 -o /dev/null "http://127.0.0.1:$1$2" 2>/dev/null; }

start_one() { # name, pidfile, logfile, healthport, healthpath, cmd...
  local name=$1 pidfile=$2 logfile=$3 port=$4 path=$5
  shift 5
  if port_alive "$port" "$path"; then
    echo "✓ $name already running on :$port"
    return
  fi
  echo "… starting $name (log: $logfile)"
  # One previous log is kept per service instead of growing forever.
  [[ -f $logfile ]] && mv -f "$logfile" "$logfile.1"
  # Job control (set -m) gives the child its own process group, so stop can
  # take down the whole tree — uv → python → a running generator — at once.
  (
    set -m
    nohup "$@" >"$logfile" 2>&1 &
    echo $! >"$pidfile"
  )
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
    local pid pgid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
      if [[ -n $pgid && $pgid != "$(ps -o pgid= -p $$ | tr -d ' ')" ]]; then
        kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      else
        # Started by an older launcher without its own group.
        kill "$pid" 2>/dev/null || true
        pkill -P "$pid" 2>/dev/null || true
      fi
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
  echo "! $name is still answering on :$port after 10s (started by hand? stop it yourself)" >&2
}

lan_ip() { ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true; }

case "$MODE" in
  start)
    start_one "statue sidecar" "$PID_DIR/sidecar.pid" "$LOG_DIR/sidecar.log" 8765 /health \
      uv run "$PWD/statue-service/server.py"
    if [[ $LAN == 1 ]]; then
      start_one "web app" "$PID_DIR/web.pid" "$LOG_DIR/web.log" 3000 / npm run dev
    else
      start_one "web app" "$PID_DIR/web.pid" "$LOG_DIR/web.log" 3000 / npm run dev:local
    fi
    echo
    echo "ask3d ready → http://localhost:3000"
    if [[ $LAN == 1 ]]; then
      ip=$(lan_ip)
      [[ -n $ip ]] && echo "on your network → http://$ip:3000"
    else
      echo "(this machine only — omit --local to use it from your phone)"
    fi
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
esac
