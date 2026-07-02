#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONSOLE_DIR="$ROOT_DIR/apps/delivery-console"
CONSOLE_PORT="${DELIVERY_CONSOLE_PORT:-5174}"
RUNNER_PORT="${DELIVERY_RUNNER_PORT:-5176}"

print_line() {
  printf "%-18s %s\n" "$1" "$2"
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    print_line "$1" "OK ($(command -v "$1"))"
    return 0
  fi
  print_line "$1" "缺失"
  return 1
}

check_port() {
  local port="$1"
  local label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    print_line "$label" "端口 $port 使用中"
  else
    print_line "$label" "端口 $port 空闲"
  fi
}

print_line "知识库根目录" "$ROOT_DIR"
print_line "控制台目录" "$CONSOLE_DIR"

echo
check_command node || true
check_command pnpm || true
check_command curl || true

echo
if [ -f "$CONSOLE_DIR/package.json" ]; then
  print_line "package.json" "OK"
else
  print_line "package.json" "缺失：$CONSOLE_DIR/package.json"
fi

if [ -d "$CONSOLE_DIR/node_modules" ]; then
  print_line "node_modules" "OK"
else
  print_line "node_modules" "缺失，请在控制台目录执行 pnpm install，或运行 scripts/start-console.sh"
fi

echo
check_port "$CONSOLE_PORT" "前端"
check_port "$RUNNER_PORT" "runner"

echo
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://localhost:$RUNNER_PORT/api/health" >/dev/null 2>&1; then
    print_line "runner health" "OK：http://localhost:$RUNNER_PORT/api/health"
  else
    print_line "runner health" "未响应"
  fi

  if curl -fsS "http://localhost:$CONSOLE_PORT" >/dev/null 2>&1; then
    print_line "前端页面" "OK：http://localhost:$CONSOLE_PORT"
  else
    print_line "前端页面" "未响应"
  fi
else
  print_line "HTTP 检查" "跳过，curl 未安装"
fi

echo
echo "启动命令：bash scripts/start-console.sh"
echo "停止命令：bash scripts/stop-console.sh"
