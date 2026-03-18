#!/bin/bash
# ═══════════════════════════════════════════════
#  SUR Protocol — Start All Services
# ═══════════════════════════════════════════════
#
# Starts all 6 services in the correct order with health checks.
# Logs go to deploy/logs/*.log
#
# Usage:
#   ./deploy/start-all.sh          # Start all
#   ./deploy/start-all.sh stop     # Stop all
#   ./deploy/start-all.sh status   # Check status

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/deploy/logs"
PID_DIR="$ROOT_DIR/deploy/pids"
mkdir -p "$LOG_DIR" "$PID_DIR"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${BLUE}[SUR]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[⚠]${NC} $1"; }

# Services in start order (oracle-keeper MUST be first)
SERVICES=(oracle-keeper api agent-api funding-bot risk-engine keeper web monitoring mcp-server)
SERVICE_CMDS=(
  "npm run dev"     # oracle-keeper
  "npm run dev"     # api
  "npm run dev"     # agent-api
  "npm run dev"     # funding-bot
  "npm run dev"     # risk-engine
  "npm run dev"     # keeper
  "npm run dev"     # web
  "npm run dev"     # monitoring
  "npm run dev"     # mcp-server
)

start_service() {
  local name=$1
  local cmd=$2
  local dir="$ROOT_DIR/$name"
  local pidfile="$PID_DIR/$name.pid"
  local logfile="$LOG_DIR/$name.log"

  if [ ! -d "$dir" ] || [ ! -f "$dir/package.json" ]; then
    warn "Skipping $name (not found)"
    return
  fi

  # Check if already running
  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    warn "$name already running (PID $(cat "$pidfile"))"
    return
  fi

  # Start in background
  cd "$dir"
  nohup $cmd > "$logfile" 2>&1 &
  local pid=$!
  echo $pid > "$pidfile"

  # Wait a moment and check
  sleep 1
  if kill -0 $pid 2>/dev/null; then
    ok "$name started (PID $pid) → $logfile"
  else
    warn "$name failed to start. Check $logfile"
  fi
}

stop_service() {
  local name=$1
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ]; then
    local pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      sleep 1
      kill -9 "$pid" 2>/dev/null 2>&1 || true
      ok "Stopped $name (PID $pid)"
    else
      warn "$name not running"
    fi
    rm -f "$pidfile"
  else
    warn "$name has no PID file"
  fi
}

check_status() {
  local name=$1
  local pidfile="$PID_DIR/$name.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    echo -e "  ${GREEN}●${NC} $name (PID $(cat "$pidfile"))"
  else
    echo -e "  ${RED}○${NC} $name (stopped)"
  fi
}

case "${1:-start}" in
  start)
    echo "╔═══════════════════════════════════════════╗"
    echo "║   SUR Protocol — Starting All Services    ║"
    echo "╚═══════════════════════════════════════════╝"
    echo ""

    for i in "${!SERVICES[@]}"; do
      start_service "${SERVICES[$i]}" "${SERVICE_CMDS[$i]}"
    done

    echo ""
    echo "All services started. Logs in $LOG_DIR/"
    echo "Check status: ./deploy/start-all.sh status"
    echo "Stop all:     ./deploy/start-all.sh stop"
    ;;

  stop)
    log "Stopping all services..."
    for name in "${SERVICES[@]}"; do
      stop_service "$name"
    done
    ok "All services stopped"
    ;;

  status)
    echo ""
    echo "SUR Protocol Service Status:"
    echo ""
    for name in "${SERVICES[@]}"; do
      check_status "$name"
    done
    echo ""
    ;;

  restart)
    $0 stop
    sleep 2
    $0 start
    ;;

  logs)
    # Tail all logs
    tail -f "$LOG_DIR"/*.log
    ;;

  *)
    echo "Usage: $0 {start|stop|status|restart|logs}"
    ;;
esac
