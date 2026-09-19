#!/usr/bin/env bash
# ============================================================================
# DSH 平台 — 配置加载器（供 scripts/ 下的 shell 脚本 source）
# ----------------------------------------------------------------------------
# 用法（脚本开头）:
#   . "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
#
# 加载后可用（全部已 export）:
#   DSH_AI1NET_DATA_ROOT   数据根
#   DSH_PLATFORM_DIR 平台私有目录父目录
#   DSH_INSTALL_DIR  代码安装根
#   DSH_STATE_DIR    = $DSH_PLATFORM_DIR/state      （派生）
#   DSH_BACKUP_DIR   = $DSH_PLATFORM_DIR/backups    （派生）
#   DSH_ARTIFACT_DIR = $DSH_PLATFORM_DIR/artifacts  （派生）
#
# 优先级：系统环境变量 > config/platform.env > 这里的**中性默认值**
# ⛔ 中性默认值不含任何真实部署路径；配置文件缺失时**发告警**而不是静默用错路径。
# ============================================================================

_dsh_load_platform_env() {
  local f="${DSH_CONFIG_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.env}"
  if [ ! -f "$f" ]; then
    echo "[config] 警告：未找到 $f —— 将只用系统环境变量与中性默认值" >&2
    return 0
  fi
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    [ -n "$key" ] || continue
    case "$val" in
      \"*\"|\'*\') val="${val%?}"; val="${val#?}" ;;
      *) val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')" ;;
    esac
    # 系统 env 已有该键 ⇒ 不覆盖（系统 env 优先级更高）
    if [ -n "$(printenv "$key" 2>/dev/null)" ]; then
      continue
    fi
    export "$key=$val"
  done < "$f"
}

_dsh_load_platform_env
unset -f _dsh_load_platform_env 2>/dev/null || true

# --- 中性默认值（仅当仍未设置时才填）--------------------------------------
export DSH_AI1NET_DATA_ROOT="${DSH_AI1NET_DATA_ROOT:-$HOME/.dsh_ai1net}"
export DSH_PLATFORM_DIR="${DSH_PLATFORM_DIR:-$DSH_AI1NET_DATA_ROOT/platform}"
export DSH_INSTALL_DIR="${DSH_INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# --- 派生目录（统一在这里算，⛔ 别在脚本里各写一套）------------------------
export DSH_STATE_DIR="${DSH_PLATFORM_STATE_DIR:-$DSH_PLATFORM_DIR/state}"
export DSH_BACKUP_DIR="${DSH_PLATFORM_BACKUP_DIR:-$DSH_PLATFORM_DIR/backups}"
export DSH_ARTIFACT_DIR="${DSH_PLATFORM_ARTIFACT_DIR:-$DSH_PLATFORM_DIR/artifacts}"

# --- 常用组合 -------------------------------------------------------------
export DSH_DB_FILE="${DSH_AI1NET_DB_FILE:-$DSH_AI1NET_DATA_ROOT/dsh_ai1net.db}"
export DSH_USERS_DIR="${DSH_AI1NET_USERS_DIR:-$DSH_AI1NET_DATA_ROOT/users}"

# --- 本机 / 对端地址（出网护栏、双机脚本用；留空 = 不填该项）---------------
export DSH_HOST_PUBLIC_IP="${DSH_HOST_PUBLIC_IP:-}"
export DSH_HOST_LAN_IP="${DSH_HOST_LAN_IP:-}"
export DSH_PEER_HOST_ID="${DSH_PEER_HOST_ID:-}"
export DSH_PEER_PUBLIC_IP="${DSH_PEER_PUBLIC_IP:-}"
export DSH_PEER_AGENT_TOKEN="${DSH_PEER_AGENT_TOKEN:-}"

# --- 控制面 PG ------------------------------------------------------------
export DSH_AI1NET_PG_HOST="${DSH_AI1NET_PG_HOST:-127.0.0.1}"
export DSH_AI1NET_PG_PORT="${DSH_AI1NET_PG_PORT:-5432}"
export DSH_AI1NET_PG_USER="${DSH_AI1NET_PG_USER:-dsh_ai1net}"
export DSH_AI1NET_PG_DB="${DSH_AI1NET_PG_DB:-dsh_ai1net}"
export DSH_AI1NET_PG_PASSWORD="${DSH_AI1NET_PG_PASSWORD:-}"
export DSH_PG_DATA_DIR="${DSH_PG_DATA_DIR:-$DSH_AI1NET_DATA_ROOT-pg}"
