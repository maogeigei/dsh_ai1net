#!/usr/bin/env bash
# ============================================================================
# dsh_ai1net —— 单机一键部署（模式 A：裸机 + systemd + nginx）
#
# 用法（在仓库根目录，需 root）：
#   sudo bash install.sh --domain dsh.example.com --email you@example.com
#   sudo bash install.sh                       # 不配域名，仅本机 3080 端口
#   sudo bash install.sh --dry-run             # 只打印将要执行的命令，不落地
#   sudo bash install.sh --uninstall           # 卸载服务（保留数据）
#   sudo bash install.sh --uninstall --purge --yes   # 连数据一起删（危险）
#
# 设计原则：
#   · 幂等：重复执行只补齐缺失项，不覆盖已有 env / 不重建已有数据；
#   · 不破坏：默认不动 nginx 的其它配置；`--uninstall` 不带 `--purge` 时不动数据；
#   · 可预演：`--dry-run` 打印所有会执行的命令。
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DOMAIN=""
EMAIL=""
PORT="${DSH_AI1NET_PORT:-3080}"
ADMIN_USER="admin"
ADMIN_PASS=""
DATA_ROOT="${DSH_AI1NET_DATA_ROOT:-/var/lib/dsh_ai1net}"
ENV_FILE="/etc/dsh_ai1net.env"
UNIT_FILE="/etc/systemd/system/dsh_ai1net.service"
# nginx 配置目录：**自适应**，不写死 Debian 路径。
# 2026-09-14 真机实测（宝塔机器）：没有 /etc/nginx，配置在 /www/server/nginx/conf +
# /www/server/panel/vhost/nginx（主配置 `include /www/server/panel/vhost/nginx/*.conf`），
# 且 systemd 的 nginx.service 为 inactive（由宝塔自己拉起）⇒ 写死路径 + systemctl reload 都会失败。
detect_nginx_conf_dir() {
  [ -d /etc/nginx/conf.d ] && { echo /etc/nginx/conf.d; return; }
  [ -d /www/server/panel/vhost/nginx ] && { echo /www/server/panel/vhost/nginx; return; }   # 宝塔面板
  local cp
  cp="$(nginx -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p' | head -1)"
  [ -n "$cp" ] && { echo "$(dirname "$cp")/conf.d"; return; }
  echo /etc/nginx/conf.d
}
NGINX_CONF="$(detect_nginx_conf_dir)/dsh_ai1net.conf"

# reload nginx：自适应 systemd / init 脚本 / nginx -s（宝塔机器上 nginx.service 常为 inactive）
reload_nginx() {
  if systemctl is-active nginx >/dev/null 2>&1; then run systemctl reload nginx; return; fi
  if [ -x /etc/init.d/nginx ]; then run /etc/init.d/nginx reload; return; fi
  run nginx -s reload
}
SERVICE="dsh_ai1net"
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=19
DRY_RUN=0
ASSUME_YES=0
INSTALL_NODE=0
SKIP_BUILD=0
NO_NGINX=0
UNINSTALL=0
PURGE=0
ISOLATION_MODE="account"
PORT_GUARD="false"
DSH_BIN="dsh"

# ── 输出 ────────────────────────────────────────────────────────────────────
c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_info() { printf '\033[36m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
step()   { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()    { c_err "✗ $*"; exit 1; }

run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] %s\n' "$*"
    return 0
  fi
  "$@"
}

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

参数：
  --domain <域名>      平台主域（如 dsh.example.com）。给了就同时配 nginx 反代 + 每用户子域。
  --email <邮箱>       Let's Encrypt 账号邮箱；配合 $CF_API_TOKEN 可签发通配证书（推荐）。
  --port <端口>        控制面监听端口（默认 3080）。
  --admin-user <名>    首个管理员用户名（默认 admin）。
  --admin-pass <密码>  首个管理员密码（不填则随机生成并打印一次）。
  --data-root <路径>   每用户数据根（默认 /var/lib/dsh_ai1net）。
  --isolation <模式>   account（默认，每用户独立 OS 账号 + setpriv 降权）| soft。
                       若本机缺 useradd/setpriv，自动降级为 soft。
  --port-guard         开启 iptables owner-match 端口守卫（阻止同机其它账号直连实例回环端口；
                       不支持的环境会拒绝启动，故默认关闭）。
  --install-node       缺 Node 时自动安装（NodeSource）。
  --skip-build         跳过 npm ci / 构建（复用已有 lib/）。
  --no-nginx           不写 nginx 配置。
  --uninstall[--purge] 卸载；--purge 连数据根一起删（需 --yes 或交互确认）。
  --dry-run            只打印命令，不执行。
  --yes                全部确认项自动通过（用于自动化）。
  -h, --help           本帮助。
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)       DOMAIN="${2:-}"; shift 2 ;;
    --email)        EMAIL="${2:-}"; shift 2 ;;
    --port)         PORT="${2:-}"; shift 2 ;;
    --admin-user)   ADMIN_USER="${2:-}"; shift 2 ;;
    --admin-pass)   ADMIN_PASS="${2:-}"; shift 2 ;;
    --data-root)    DATA_ROOT="${2:-}"; shift 2 ;;
    --isolation)    ISOLATION_MODE="${2:-}"; shift 2 ;;
    --port-guard)   PORT_GUARD="true"; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
    --skip-build)   SKIP_BUILD=1; shift ;;
    --no-nginx)     NO_NGINX=1; shift ;;
    --uninstall)    UNINSTALL=1; shift ;;
    --purge)        PURGE=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --yes|-y)       ASSUME_YES=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "未知参数：$1（用 --help 看用法）" ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r a || true
  case "${a:-}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ── 0. 环境预检 ─────────────────────────────────────────────────────────────
preflight() {
  step "环境预检"
  [ "$(id -u)" = "0" ] || die "需要 root：sudo bash install.sh ..."
  [ "$(uname -s)" = "Linux" ] || die "本脚本只支持 Linux 单机部署"
  command -v systemctl >/dev/null 2>&1 || die "未找到 systemd"
  [ -f "$REPO_DIR/package.json" ] || die "请在仓库根目录执行（找不到 package.json）"
  c_ok "  ✓ Linux + root"

  # 隔离模式：account 需要 useradd + setpriv，缺任一则自动降级（避免一键部署失败）
  if [ "$ISOLATION_MODE" = "account" ]; then
    if ! command -v useradd >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
      c_warn "  ⚠ 缺少 useradd / setpriv → 隔离模式自动降级为 soft（如需硬隔离请先装 util-linux）"
      ISOLATION_MODE="soft"
    fi
  fi
  c_ok "  ✓ 隔离模式：$ISOLATION_MODE"

  if [ -n "$DOMAIN" ] && [ -z "$EMAIL" ]; then
    c_warn "  ⚠ 给了 --domain 但没给 --email → 不签发证书（HTTPS 需通配证书，每用户子域依赖它）"
  fi
  if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] && [ "$NO_NGINX" != "1" ] && ! command -v certbot >/dev/null 2>&1; then
    c_warn "  ⚠ 未安装 certbot → 本次跳过 HTTPS；装好后重跑本脚本即可自动切换："
    c_warn "     apt-get install -y certbot python3-certbot-dns-cloudflare"
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v)"; v="${v#v}"
  major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ] && return 0
  return 1
}

install_node() {
  step "安装 Node.js（NodeSource 22.x）"
  if node_ok; then c_ok "  ✓ 已有 Node $(node -v)"; return 0; fi
  if [ "$INSTALL_NODE" != "1" ]; then
    die "Node 版本过低或缺失（需 ^22.19 或 ≥24）。加 --install-node 自动安装，或自行安装后重试"
  fi
  if command -v apt-get >/dev/null 2>&1; then
    run bash -c 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash -'
    run apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    run bash -c 'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -'
    run dnf install -y nodejs
  else
    die "未识别的包管理器，请手动安装 Node ^22.19"
  fi
  DRY_RUN=0 node_ok || c_warn "  ⚠ 请确认 Node 版本满足 ^22.19 或 ≥24"
}

# ── 1. 依赖与构建 ───────────────────────────────────────────────────────────
build() {
  if [ "$SKIP_BUILD" = "1" ] && [ -f "$REPO_DIR/lib/cli.js" ]; then
    step "构建"; c_ok "  ✓ --skip-build：复用已有 lib/"
    return 0
  fi
  step "安装依赖 + 构建（tsc → lib/）"
  if [ -f "$REPO_DIR/package-lock.json" ]; then
    run npm --prefix "$REPO_DIR" ci --no-audit --no-fund
  else
    run npm --prefix "$REPO_DIR" install --no-audit --no-fund
  fi
  run npm --prefix "$REPO_DIR" run build
  # 2026-09-13：原来无论是否 dry-run 都打印「✓ 构建完成」⇒ 预演时是**误导**（根本没构建）。
  if [ "$DRY_RUN" = "1" ]; then
    c_warn "  [dry-run] 未真实构建（上面两行是将会执行的命令）"
  else
    c_ok "  ✓ 构建完成"
  fi
}

ensure_dsh() {
  step "检查 DSH（@deepseek-ai/dsh）"
  if command -v dsh >/dev/null 2>&1; then
    c_ok "  ✓ 已安装：$(command -v dsh)"
  else
    c_info "  未找到 dsh，正在全局安装…"
    run npm i -g @deepseek-ai/dsh
  fi
  # 编排服务必须拿到 dsh 的绝对路径（systemd 的 PATH 很精简）
  DSH_BIN="$(command -v dsh || true)"
  [ -n "$DSH_BIN" ] || DSH_BIN="$(command -v node >/dev/null 2>&1 && echo dsh || echo dsh)"
  c_info "  dsh 路径：$DSH_BIN"
}

# ── 2. 数据根 + 环境文件 ────────────────────────────────────────────────────
want_tls() {
  [ -n "$DOMAIN" ] && [ -n "$EMAIL" ] && [ "$NO_NGINX" != "1" ] && command -v certbot >/dev/null 2>&1
}

write_env() {
  step "写入环境文件 $ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    c_warn "  ⚠ 已存在，保留不动（如需重写先手动备份删除）"
    return 0
  fi
  local secure=false base_domain cookie_domain
  if [ -n "$DOMAIN" ]; then
    base_domain="$DOMAIN"
    cookie_domain=".$DOMAIN"
    want_tls && secure=true
  else
    base_domain=""; cookie_domain=""
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] 写入 %s（DATA_ROOT=%s PORT=%s BASE_DOMAIN=%s SECURE_COOKIES=%s）\n' \
      "$ENV_FILE" "$DATA_ROOT" "$PORT" "$base_domain" "$secure"
    return 0
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  cat > "$ENV_FILE" <<EOF
# dsh_ai1net 环境文件（由 install.sh 生成，0600）
DSH_AI1NET_PORT=$PORT
DSH_AI1NET_DATA_ROOT=$DATA_ROOT
DSH_AI1NET_DSH_BIN=$DSH_BIN
DSH_AI1NET_ISOLATION_MODE=$ISOLATION_MODE
DSH_AI1NET_BASE_UID=100000
DSH_AI1NET_PORT_GUARD=$PORT_GUARD
DSH_AI1NET_SECURE_COOKIES=$secure
DSH_AI1NET_BASE_DOMAIN=$base_domain
DSH_AI1NET_COOKIE_DOMAIN=$cookie_domain
DSH_AI1NET_ENABLE_PATCH=true
DSH_AI1NET_DEPLOY_MODE=local
EOF
  chmod 600 "$ENV_FILE"
  c_ok "  ✓ 已写入（0600）"

  step "创建数据根 $DATA_ROOT"
  run mkdir -p "$DATA_ROOT"
  run chmod 700 "$DATA_ROOT"
  c_ok "  ✓ 就绪"
}

# ── 3. nginx 与证书 ────────────────────────────────────────────────────────
write_nginx() {
  [ -z "$DOMAIN" ] && return 0
  [ "$NO_NGINX" = "1" ] && { c_warn "  ⚠ --no-nginx：跳过 nginx 配置"; return 0; }
  command -v nginx >/dev/null 2>&1 || { c_warn "  ⚠ 未安装 nginx，跳过（装好后重跑本脚本即可）"; return 0; }

  mkdir -p "$(dirname "$NGINX_CONF")" 2>/dev/null || true
  step "写入 nginx 配置 $NGINX_CONF"
  local cert_dir="/etc/letsencrypt/live/$DOMAIN"
  if want_tls && [ -f "$cert_dir/fullchain.pem" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      printf '   [dry-run] 写入 HTTPS 版 %s（443 + 通配 $DOMAIN/*.%s，80 跳转 443）\n' "$NGINX_CONF" "$DOMAIN"
    else
      cat > "$NGINX_CONF" <<EOF
# 平台主域 + 每用户子域（由 install.sh 生成）
map \$http_upgrade \$dsh_conn_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name $DOMAIN *.$DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN *.$DOMAIN;

    ssl_certificate     $cert_dir/fullchain.pem;
    ssl_certificate_key $cert_dir/privkey.pem;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$dsh_conn_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
      c_ok "  ✓ 已写入 HTTPS 版"
    fi
  else
    if [ "$DRY_RUN" = "1" ]; then
      printf '   [dry-run] 写入 HTTP 版 %s（80，server_name %s *.%s）\n' "$NGINX_CONF" "$DOMAIN" "$DOMAIN"
    else
      cat > "$NGINX_CONF" <<EOF
# 平台主域 + 每用户子域（由 install.sh 生成；尚未签发证书 → 仅 HTTP）
map \$http_upgrade \$dsh_conn_upgrade { default upgrade; '' close; }

server {
    listen 80;
    server_name $DOMAIN *.$DOMAIN;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$dsh_conn_upgrade;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
EOF
      c_ok "  ✓ 已写入 HTTP 版（HTTPS 见下方提示）"
    fi
  fi
  run nginx -t
  reload_nginx
}

setup_cert() {
  [ -z "$DOMAIN" ] && return 0
  want_tls || return 0
  local cert_dir="/etc/letsencrypt/live/$DOMAIN"
  [ -f "$cert_dir/fullchain.pem" ] && { c_ok "  ✓ 证书已存在，跳过签发"; return 0; }
  step "签发证书（$DOMAIN + *.$DOMAIN）"
  if [ -n "${CF_API_TOKEN:-}" ]; then
    if ! command -v certbot >/dev/null 2>&1 || [ "$DRY_RUN" = "1" ]; then
      printf '   [dry-run] certbot certonly --dns-cloudflare -d %s -d *.%s\n' "$DOMAIN" "$DOMAIN"
      return 0
    fi
    printf 'dns_cloudflare_api_token = %s\n' "$CF_API_TOKEN" > /etc/cloudflare.ini
    chmod 600 /etc/cloudflare.ini
    certbot certonly --dns-cloudflare --dns-cloudflare-credentials /etc/cloudflare.ini \
      --dns-cloudflare-propagation-seconds 30 \
      -d "$DOMAIN" -d "*.$DOMAIN" --agree-tos -m "$EMAIL" -n
  else
    c_warn "  ⚠ 未设置 CF_API_TOKEN：通配证书需 DNS-01，跳过自动签发。"
    c_warn "     拿到通配证书后重跑本脚本即可自动切到 HTTPS："
    c_warn "       certbot certonly --dns-cloudflare ... -d $DOMAIN -d '*.$DOMAIN'"
    c_warn "     或先用 HTTP 验证主域：certbot --nginx -d $DOMAIN"
  fi
}

# ── 4. systemd 服务 ────────────────────────────────────────────────────────
write_unit() {
  step "写入 systemd 服务 $UNIT_FILE"
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] 写入 %s（WorkingDirectory=%s, EnvironmentFile=%s）\n' "$UNIT_FILE" "$REPO_DIR" "$ENV_FILE"
  else
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=dsh_ai1net — 多租户 DSH 托管平台（控制面）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $REPO_DIR/lib/cli.js
Restart=always
RestartSec=3
LimitNOFILE=1048576
# 账号级硬隔离需要 root（setpriv 降权 + iptables/nft 端口守卫）
User=root

[Install]
WantedBy=multi-user.target
EOF
    c_ok "  ✓ 已写入"
  fi
  run systemctl daemon-reload
  run systemctl enable "$SERVICE"
  run systemctl restart "$SERVICE"
  # 2026-09-13：同上 —— dry-run 下不得宣称"服务已启动"。
  if [ "$DRY_RUN" = "1" ]; then
    c_warn "  [dry-run] 未启动服务"
  else
    c_ok "  ✓ 服务已启动"
  fi
}

bootstrap_admin() {
  step "创建首个管理员"
  if [ -z "$ADMIN_PASS" ]; then
    ADMIN_PASS="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
    GENERATED_PASS=1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '   [dry-run] node lib/cli.js bootstrap-admin --username %s --password ***\n' "$ADMIN_USER"
    return 0
  fi
  local out
  # ⚠️ 必须连 stderr 一起捕获（2>&1）：CLI 的「an admin already exists」是打到 stderr 的，
  #    只抓 stdout 会让幂等判断失效、误判为失败（2026-09-14 实测）
  if out="$(cd "$REPO_DIR" && env -i PATH="$PATH" bash -c "set -a; . '$ENV_FILE'; set +a; exec node lib/cli.js bootstrap-admin --username '$ADMIN_USER' --password '$ADMIN_PASS'" 2>&1)"; then
    c_ok "  ✓ 管理员已创建：$ADMIN_USER"
    ADMIN_OK=1
  elif printf '%s' "$out" | grep -qiE 'exists|已存在|UNIQUE'; then
    c_ok "  ✓ 管理员已存在：$ADMIN_USER（幂等跳过，不覆盖原密码）"
    ADMIN_OK=1
    GENERATED_PASS=0
  else
    # ⚠️ 2026-09-14 实测（真机首装）：本步**必须在「启动服务」之前**执行 ——
    #    服务一旦启动就会持有 SQLite 锁 ⇒ 这里必然 SQLITE_BUSY（database is locked）。
    #    失败即判失败：不再打印"部署完成"+初始密码，否则就是**假成功**（用户拿密码登录只会 401）。
    c_err "  ✗ 创建管理员失败：$out"
    c_err "    （该步骤必须在启动服务之前；若服务已在运行，请先 systemctl stop $SERVICE 再重跑）"
    return 1
  fi
}

health_check() {
  step "健康检查"
  [ "$DRY_RUN" = "1" ] && { printf '   [dry-run] curl -fsS http://127.0.0.1:%s/\n' "$PORT"; return 0; }
  local i ok=0
  for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = "1" ]; then c_ok "  ✓ 控制面响应正常"; else
    c_err "  ✗ 控制面未响应，最近日志："; journalctl -u "$SERVICE" -n 30 --no-pager || true
    return 1
  fi
}

# ── 5. 卸载 ─────────────────────────────────────────────────────────────────
do_uninstall() {
  step "卸载 $SERVICE"
  run systemctl disable --now "$SERVICE" || true
  [ -f "$UNIT_FILE" ] && run rm -f "$UNIT_FILE"
  run systemctl daemon-reload || true
  if [ -f "$ENV_FILE" ]; then confirm "删除环境文件 $ENV_FILE ？" && run rm -f "$ENV_FILE"; fi
  if [ -f "$NGINX_CONF" ]; then
    confirm "删除 nginx 配置 $NGINX_CONF ？" && run rm -f "$NGINX_CONF" && reload_nginx || true
  fi
  if [ "$PURGE" = "1" ]; then
    c_warn "⚠ 将删除全部用户数据：$DATA_ROOT"
    if confirm "确认删除？此操作不可逆。"; then run rm -rf "$DATA_ROOT"; else c_info "  已跳过删除数据"; fi
  else
    c_info "  数据保留在 $DATA_ROOT（如需删除：--purge）"
  fi
  c_ok "✓ 卸载完成（代码目录 $REPO_DIR 未动）"
}

# ── 主流程 ──────────────────────────────────────────────────────────────────
main() {
  preflight
  if [ "$UNINSTALL" = "1" ]; then do_uninstall; return 0; fi

  c_info "部署目标："
  c_info "  仓库目录   $REPO_DIR"
  c_info "  数据根     $DATA_ROOT"
  c_info "  监听端口   $PORT"
  c_info "  平台域名   ${DOMAIN:-（未设置：仅本机端口访问）}"
  [ "$DRY_RUN" = "1" ] && c_warn "  [dry-run 模式：不会做任何实际改动]"

  install_node
  build
  ensure_dsh
  write_env
  setup_cert
  # ⚠️ bootstrap_admin 必须在 write_unit（启动服务）**之前**：
  #    服务启动后会持有 SQLite 锁 ⇒ 后置执行必然 database is locked（2026-09-14 真机首装实测）
  bootstrap_admin
  write_nginx
  write_unit
  health_check || true

  cat <<EOF

$( [ "$DRY_RUN" = "1" ] && printf '[dry-run] 预演完成 —— 以上列出的都是**将会执行**的命令，本次未做任何实际改动\n' || { [ "${ADMIN_OK:-0}" = "1" ] && c_ok "✓ 部署完成" || c_err "✗ 部署未完成（管理员未创建，见上方错误）"; } )

  管理台      http://127.0.0.1:$PORT/
  管理员      $ADMIN_USER
$( [ "${GENERATED_PASS:-0}" = "1" ] && [ "${ADMIN_OK:-0}" = "1" ] && [ "$DRY_RUN" != "1" ] && printf '  初始密码    %s\n  （请登录后立即修改）\n' "$ADMIN_PASS" )
$( [ "$DRY_RUN" = "1" ] && printf '  初始密码    （dry-run 未创建管理员；正式执行时会生成并打印）\n' )
$( [ -n "$DOMAIN" ] && printf '  平台主域    http://%s/\n' "$DOMAIN" )

后续：
  1) 把 ${DOMAIN:-<你的平台域名>} 与 *.${DOMAIN:-<你的平台域名>} 的 DNS A 记录指向本机公网 IP；
  2) 需要 HTTPS（每用户子域必需）→ 用通配证书，然后重跑本脚本；
  3) 每用户子域请确认 $ENV_FILE 里的 BASE_DOMAIN / COOKIE_DOMAIN / SECURE_COOKIES；
  4) 运维：journalctl -u $SERVICE -f ｜ systemctl restart $SERVICE。
EOF
}

main "$@"
