#!/usr/bin/env bash
set -euo pipefail

CONSOLE_PORT="${DELIVERY_CONSOLE_PORT:-5174}"
RUNNER_PORT="${DELIVERY_RUNNER_PORT:-5176}"
DRY_RUN=0
FORCE=0

usage() {
  cat <<USAGE
用法：
  bash scripts/stop-console.sh [--dry-run] [--force]

选项：
  --dry-run  只展示将要停止的进程，不真正停止。
  --force    普通 kill 后端口仍未释放时，继续执行 kill -9。
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --force)
      FORCE=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1"
      usage
      exit 1
      ;;
  esac
  shift
done

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    echo "请先安装 $1 后再运行。"
    exit 1
  fi
}

port_pids() {
  local pids
  pids="$(lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "$pids" | sort -u
  fi
}

print_processes() {
  local label="$1"
  local port="$2"
  local pids="$3"

  if [ -z "$pids" ]; then
    printf "%-10s 端口 %-5s 未运行\n" "$label" "$port"
    return
  fi

  printf "%-10s 端口 %-5s 将停止 PID：%s\n" "$label" "$port" "$(echo "$pids" | tr '\n' ' ')"
  ps -o pid=,command= -p "$(echo "$pids" | paste -sd, -)" 2>/dev/null || true
}

stop_pids() {
  local label="$1"
  local port="$2"
  local pids="$3"

  if [ -z "$pids" ]; then
    return
  fi

  if [ "$DRY_RUN" = "1" ]; then
    return
  fi

  echo "正在停止 $label..."
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill "$pid" >/dev/null 2>&1 || true
  done <<< "$pids"

  sleep 1

  local remaining
  remaining="$(port_pids "$port")"
  if [ -n "$remaining" ] && [ "$FORCE" = "1" ]; then
    echo "$label 普通停止后仍在运行，执行强制停止..."
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      kill -9 "$pid" >/dev/null 2>&1 || true
    done <<< "$remaining"
    sleep 1
  fi
}

report_port() {
  local label="$1"
  local port="$2"
  local pids
  pids="$(port_pids "$port")"
  if [ -z "$pids" ]; then
    printf "%-10s 端口 %-5s 已释放\n" "$label" "$port"
  else
    printf "%-10s 端口 %-5s 仍被占用，PID：%s\n" "$label" "$port" "$(echo "$pids" | tr '\n' ' ')"
  fi
}

require_command lsof
require_command ps

CONSOLE_PIDS="$(port_pids "$CONSOLE_PORT")"
RUNNER_PIDS="$(port_pids "$RUNNER_PORT")"

echo "准备停止模块项目交付控制台："
print_processes "前端" "$CONSOLE_PORT" "$CONSOLE_PIDS"
print_processes "runner" "$RUNNER_PORT" "$RUNNER_PIDS"

if [ "$DRY_RUN" = "1" ]; then
  echo
  echo "dry-run 模式，不会停止任何进程。"
  exit 0
fi

stop_pids "前端" "$CONSOLE_PORT" "$CONSOLE_PIDS"
stop_pids "runner" "$RUNNER_PORT" "$RUNNER_PIDS"

echo
echo "停止结果："
report_port "前端" "$CONSOLE_PORT"
report_port "runner" "$RUNNER_PORT"
