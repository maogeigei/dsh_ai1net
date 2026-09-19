#!/usr/bin/env bash
# 平台侧 CI：类型检查 + 构建
#
# 用法：bash scripts/ci.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/2 typecheck =="
npm run typecheck

echo "== 2/2 build =="
npm run build

echo "CI OK ✅"
