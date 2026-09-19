#!/bin/bash
. "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
# DSH 平台一键备份（2026-09-11 加固：可执行位 + SQLite 一致性快照 + 纳入运维资产）
# 用法：<platform-dir>/backup.sh   产物：<platform-dir>/backups/dsh-platform-backup-<TS>.tar.gz
set -euo pipefail
TS=$(date +%Y%m%d_%H%M%S)
OUT="$DSH_BACKUP_DIR"/dsh-platform-backup-${TS}.tar.gz
TMP=$(mktemp -d /tmp/dsh-bk-XXXXXX)
trap 'rm -rf "$TMP"' EXIT

# 1) SQLite 一致性快照（运行中服务用 .backup，避免只拷到 -wal 而数据库不一致）
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DSH_DB_FILE" ]; then
  sqlite3 "$DSH_DB_FILE" ".backup '$TMP/dsh_ai1net.db'"
  DB_SNAP=1
else
  DB_SNAP=0
fi

# 2) 打包：用户数据 + 平台库/配置 + 运维资产（可重建）
cd /
ITEMS="var/lib/dsh_ai1net etc/dsh_ai1net.env etc/systemd/system/dsh_ai1net.service etc/systemd/system/dsh-provision.path etc/systemd/system/dsh-provision.service"
[ -d "$DSH_ARTIFACT_DIR" ] && ITEMS="$ITEMS var/lib/dsh-ai1net/artifacts"
[ -d "$DSH_INSTALL_DIR/scripts" ] && ITEMS="$ITEMS var/lib/dsh-ai1net/scripts"
for f in /etc/cron.d/dsh-maintenance /etc/cron.d/dsh-backup /etc/nftables-dsh-egress.nft; do
  [ -f "$f" ] && ITEMS="$ITEMS ${f#/}"
done
[ -d /www/server/panel/vhost/nginx ] && ITEMS="$ITEMS www/server/panel/vhost/nginx"

tar -czf "$OUT" $ITEMS 2>/dev/null || true
# 3) 把一致性 DB 快照追加进归档（覆盖 tar 里的实时 db 副本，确保恢复时用的是快照）
if [ "$DB_SNAP" = "1" ]; then
  tar -czf "${OUT%.tar.gz}-db-snapshot.tar.gz" -C "$TMP" dsh_ai1net.db
fi
echo "备份完成: $OUT"
ls -lh "$OUT" ${OUT%.tar.gz}-db-snapshot.tar.gz 2>/dev/null || true
