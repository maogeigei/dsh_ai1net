#!/usr/bin/env bash
. "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
# purge-trash.sh —— 清理各用户 trash/ 下超过 30 天的回收目录
# 回收站是"清理动作的缓冲区"：脚本只做 mv 进来，只有本脚本才真正 rm。
set -uo pipefail
KEEP_DAYS="${1:-30}"
LOG=/var/log/dsh-trash-purge.log
echo "[$(date -Is)] purge trash older than ${KEEP_DAYS}d" >> "$LOG"
for t in "$DSH_USERS_DIR"/*/trash; do
  [ -d "$t" ] || continue
  find "$t" -mindepth 1 -maxdepth 1 -mtime "+${KEEP_DAYS}" -print -exec rm -rf {} + >> "$LOG" 2>&1
done
echo "[$(date -Is)] done" >> "$LOG"
