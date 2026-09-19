#!/bin/bash
. "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
# 安装「dsh 实例共享运行时」—— 可移植 Python（python-build-standalone / install_only）
#
# 目的：
#   1. 系统 python3.6.8 太老（技能脚本常用特性不可用），且它是 dnf 的兄弟解释器，**不能动**；
#   2. 实例内 `/usr` 只读、无 sudo → 用户/AI 自己装不上系统级；
#   3. `/usr` 已 ro-bind → **装到 /usr/local 即对全部实例可见，零代码、新用户自动生效**。
#
# 为什么用 python-build-standalone 而不是 `dnf install python3.11`：
#   它是**自包含单目录发行版**（自带 libssl/libffi/sqlite 等，不依赖系统 rpm），
#   解压即用 → **服务器迁移时把 /usr/local/dsh-runtime 整个打包带走即可**，
#   不会因为目标机缺包/版本不同而出问题（用户的明确要求）。
#
# 迁移打包：
#   tar czf dsh-python-runtime.tar.gz -C /usr/local dsh-runtime
#   目标机：解压回 /usr/local/ 后，跑本脚本（不加 --tarball 也可，会只重建软链）
#
# 用法：
#   bash scripts/install-python-runtime.sh                    # 用默认 tarball 路径/版本
#   bash scripts/install-python-runtime.sh --tarball /path/x.tar.gz
#   PY_VER=3.13.7 bash scripts/install-python-runtime.sh
set -euo pipefail

PY_VER="${PY_VER:-3.12.14}"
PY_BUILD="${PY_BUILD:-20260901}"
RT="/usr/local/dsh-runtime"
LINK_DIR="/usr/local/bin"
TARBALL=""
URL_DEFAULT="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_BUILD}/cpython-${PY_VER}%2B${PY_BUILD}-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"

while [ $# -gt 0 ]; do
  case "$1" in
    --tarball) TARBALL="$2"; shift 2 ;;
    --version) PY_VER="$2"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" != "0" ]; then echo "需要 root" >&2; exit 1; fi

PYDIR="$RT/python-$PY_VER"
mkdir -p "$RT"

# ── 1. 解压（已存在则跳过 —— 幂等，也是迁移后的"重连"路径）──────────────
if [ -x "$PYDIR/bin/python3" ]; then
  echo "==> 已存在 $PYDIR，跳过解压"
else
  if [ -z "$TARBALL" ]; then
    for c in ""$DSH_ARTIFACT_DIR"/cpython-$PY_VER.tar.gz" "$RT/cpython-$PY_VER.tar.gz"; do
      [ -f "$c" ] && TARBALL="$c" && break
    done
  fi
  if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
    echo "==> 本地无 tarball，联网下载（$PY_VER）"
    mkdir -p "$DSH_ARTIFACT_DIR"
    TARBALL=""$DSH_ARTIFACT_DIR"/cpython-$PY_VER.tar.gz"
    curl -fL --max-time 900 -o "$TARBALL" "$URL_DEFAULT"
  fi
  echo "==> 解压 $TARBALL"
  tar xzf "$TARBALL" -C "$RT"          # install_only 解出顶层 python/
  rm -rf "$PYDIR"
  mv "$RT/python" "$PYDIR"
fi

# ── 2. 运行时内 bin（相对软链，便于整体搬迁）────────────────────────────
mkdir -p "$RT/bin"
for n in python3 python3.12 python pip3 pip; do
  [ -e "$PYDIR/bin/$n" ] || continue
  ln -sfn "../python-$PY_VER/bin/$n" "$RT/bin/$n"
done

# ── 3. /usr/local/bin 接线（已在实例 PATH 首位；`/usr` ro-bind → 实例立即可见）──
for n in python3 python pip3; do
  [ -e "$RT/bin/$n" ] || continue
  ln -sfn "$RT/bin/$n" "$LINK_DIR/$n"
done

# ── 4. 版本记录（迁移核对用）────────────────────────────────────────────
cat > "$RT/VERSION" <<EOF
python_version=$PY_VER
python_build=$PY_BUILD
source=$URL_DEFAULT
installed_at=$(date -Is)
note=python-build-standalone install_only_stripped（自包含，可整体打包迁移）
EOF

# ── 5. 自检 ─────────────────────────────────────────────────────────────
echo "==> 自检"
"$LINK_DIR/python3" -c 'import sys,ssl,sqlite3,lzma,zlib,ctypes,urllib.request;print("  python3 =",sys.version.split()[0],"exe =",sys.executable);print("  模块 ssl/sqlite3/lzma/zlib/ctypes 全可用");print("  ssl =",ssl.OPENSSL_VERSION)'
"$LINK_DIR/pip3" --version | sed 's/^/  /'
echo "  目录体积: $(du -sh "$PYDIR" | cut -f1)"
echo "  软链:"; ls -la "$LINK_DIR/python3" "$LINK_DIR/python" "$LINK_DIR/pip3" | sed 's/^/    /'
echo
echo "OK —— 实例内 PATH=/usr/local/bin:/usr/bin:/bin，且 /usr ro-bind → 立即可用，无需重启实例"
echo "注意：dnf/yum 的 shebang 是 /usr/libexec/platform-python（绝对路径），不受影响。"
