#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSOLE_DIR="$ROOT_DIR/apps/delivery-console"
CONSOLE_PORT="${DELIVERY_CONSOLE_PORT:-5174}"
RUNNER_PORT="${DELIVERY_RUNNER_PORT:-5176}"

print_step() {
  printf "\n==> %s\n" "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少命令：$1"
    echo "请先安装 $1 后再运行。"
    exit 1
  fi
}

is_port_in_use() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

if [ ! -f "$CONSOLE_DIR/package.json" ]; then
  echo "未找到前端控制台 package.json：$CONSOLE_DIR/package.json"
  echo "请确认你在完整的 delivery-knowledge-system 项目中运行。"
  exit 1
fi

require_command node
require_command pnpm

print_step "进入前端控制台目录"
cd "$CONSOLE_DIR"
echo "$CONSOLE_DIR"

if [ ! -d "$CONSOLE_DIR/node_modules" ]; then
  print_step "安装前端依赖"
  pnpm install
fi

RUNNER_STARTED=0
DEV_STARTED=0

cleanup() {
  echo
  echo "正在停止本脚本启动的进程..."
  if [ "$RUNNER_STARTED" = "1" ] && [ "${RUNNER_PID:-}" ]; then
    kill "$RUNNER_PID" >/dev/null 2>&1 || true
  fi
  if [ "$DEV_STARTED" = "1" ] && [ "${DEV_PID:-}" ]; then
    kill "$DEV_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if is_port_in_use "$RUNNER_PORT"; then
  print_step "复用已运行的本地 runner"
  echo "runner 地址：http://localhost:$RUNNER_PORT"
else
  print_step "启动本地 runner"
  DELIVERY_RUNNER_PORT="$RUNNER_PORT" pnpm run runner &
  RUNNER_PID=$!
  RUNNER_STARTED=1
  sleep 1
fi

if is_port_in_use "$CONSOLE_PORT"; then
  print_step "复用已运行的前端控制台"
  echo "前端地址：http://localhost:$CONSOLE_PORT"
else
  print_step "启动前端控制台"
  pnpm run dev &
  DEV_PID=$!
  DEV_STARTED=1
fi

cat <<INFO

前端控制台：http://localhost:$CONSOLE_PORT
本地 runner：http://localhost:$RUNNER_PORT

按 Ctrl+C 可停止本脚本启动的进程；已存在的服务不会被停止。
INFO

if [ "$DEV_STARTED" = "1" ]; then
  wait "$DEV_PID"
elif [ "$RUNNER_STARTED" = "1" ]; then
  wait "$RUNNER_PID"
else
  echo "前端和 runner 都已在运行。"
fi
