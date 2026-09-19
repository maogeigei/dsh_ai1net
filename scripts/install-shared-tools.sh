#!/bin/bash
. "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
# 安装「实例共享工具」到 /usr/local/dsh-runtime/bin（+ /usr/local/bin 软链）
#
# 为什么共享而不是每个用户装一份：
#   · 实例内 `/usr` 是 ro-bind，且 `/usr/local/bin` 在实例 PATH **首位** →
#     **宿主装一次，全部实例（含新用户）立即可见，零代码、无需重启**；
#   · 用户侧装不上（`/usr` 只读 + 无 sudo），且每人一份会重复占磁盘、版本还不一致。
#
# 迁移：整个 `/usr/local/dsh-runtime/` 就是一个打包单元 →
#   tar czf dsh-runtime.tar.gz -C /usr/local dsh-runtime
#   目标机解压回原位后跑本脚本（已存在则只重建软链）。
#
# 用法：bash scripts/install-shared-tools.sh [--force]
set -euo pipefail

RT=/usr/local/dsh-runtime
BIN="$RT/bin"
LINK=/usr/local/bin
ART="$DSH_ARTIFACT_DIR"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

JQ_VER=1.8.2
RG_VER=15.2.0
# ffmpeg 用 BtbN 的 master 静态构建（单个二进制、无系统库依赖）
FF_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz"
FF_SUM_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256"

mkdir -p "$BIN" "$ART" "$DSH_STATE_DIR"

say() { printf '==> %s\n' "$*"; }
fail() { printf '!! %s\n' "$*" >&2; exit 1; }

# ── 取官方校验值并核对 ────────────────────────────────────────────────
verify() { # verify <file> <expected-sha256>
  local f="$1" want="$2" got
  got=$(sha256sum "$f" | awk '{print $1}')
  [ "$got" = "$want" ] || fail "校验失败：$f
   期望 $want
   实际 $got"
  say "校验通过 $(basename "$f")"
}

curl_o() { curl -fsSL --retry 3 --retry-delay 3 --max-time 600 -o "$2" "$1"; }

# ── jq（官方静态单文件）────────────────────────────────────────────────
if [ "$FORCE" = 1 ] || ! [ -x "$BIN/jq" ] || [ "$("$BIN/jq" --version 2>/dev/null | sed 's/^jq-//')" != "$JQ_VER" ]; then
  say "安装 jq $JQ_VER"
  curl_o "https://github.com/jqlang/jq/releases/download/jq-$JQ_VER/jq-linux-amd64" "$ART/jq-$JQ_VER"
  curl_o "https://github.com/jqlang/jq/releases/download/jq-$JQ_VER/sha256sum.txt" "$ART/jq-$JQ_VER.sha256"
  WANT=$(grep -E 'jq-linux-amd64$' "$ART/jq-$JQ_VER.sha256" | awk '{print $1}')
  [ -n "$WANT" ] || fail "取不到 jq 官方校验值"
  verify "$ART/jq-$JQ_VER" "$WANT"
  install -m 0755 "$ART/jq-$JQ_VER" "$BIN/jq"
else
  say "jq 已就绪 $("$BIN/jq" --version)"
fi

# ── ripgrep（musl 静态，无 glibc 依赖）─────────────────────────────────
if [ "$FORCE" = 1 ] || ! [ -x "$BIN/rg" ]; then
  say "安装 ripgrep $RG_VER"
  TGZ="ripgrep-$RG_VER-x86_64-unknown-linux-musl.tar.gz"
  curl_o "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VER/$TGZ" "$ART/$TGZ"
  curl_o "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VER/$TGZ.sha256" "$ART/$TGZ.sha256"
  verify "$ART/$TGZ" "$(awk '{print $1}' "$ART/$TGZ.sha256")"
  TMPD=$(mktemp -d); tar xzf "$ART/$TGZ" -C "$TMPD"
  install -m 0755 "$TMPD/ripgrep-$RG_VER-x86_64-unknown-linux-musl/rg" "$BIN/rg"
  rm -rf "$TMPD"
else
  say "rg 已就绪 $("$BIN/rg" --version | head -1)"
fi

# ── ffmpeg / ffprobe（静态单文件，自带全部解码库）─────────────────────
if [ "$FORCE" = 1 ] || ! [ -x "$BIN/ffmpeg" ]; then
  say "安装 ffmpeg（BtbN master 静态构建）"
  curl_o "$FF_URL" "$ART/ffmpeg-static.tar.xz"
  curl_o "$FF_SUM_URL" "$ART/ffmpeg-static.sha256"
  WANT=$(grep -E 'ffmpeg-master-latest-linux64-gpl\.tar\.xz$' "$ART/ffmpeg-static.sha256" | awk '{print $1}')
  [ -n "$WANT" ] || fail "取不到 ffmpeg 官方校验值（checksums.sha256 里没有该资产）"
  verify "$ART/ffmpeg-static.tar.xz" "$WANT"
  TMPD=$(mktemp -d); tar xJf "$ART/ffmpeg-static.tar.xz" -C "$TMPD"
  FFDIR=$(find "$TMPD" -maxdepth 1 -type d -name "ffmpeg-*" | head -1)
  for b in ffmpeg ffprobe; do install -m 0755 "$FFDIR/bin/$b" "$BIN/$b"; done
  rm -rf "$TMPD"
else
  say "ffmpeg 已就绪 $("$BIN/ffmpeg" -version 2>/dev/null | head -1)"
fi

# ── /usr/local/bin 接线（已在实例 PATH 首位）──────────────────────────
for n in jq rg ffmpeg ffprobe; do
  [ -e "$BIN/$n" ] || continue
  ln -sfn "$BIN/$n" "$LINK/$n"
done

# ── 清单（迁移与审计用）──────────────────────────────────────────────
{
  echo "# dsh 实例共享工具（随 /usr/local/dsh-runtime 一起迁移）"
  echo "updated_at=$(date -Is)"
  for n in jq rg ffmpeg ffprobe; do
    [ -x "$BIN/$n" ] || continue
    printf '%s: ' "$n"; ("$BIN/$n" --version 2>&1 | head -1) || true
  done
} > "$RT/SHARED-TOOLS.md"

echo
say "结果"
ls -la "$LINK"/{jq,rg,ffmpeg,ffprobe} 2>/dev/null | sed 's/^/  /'
cat "$RT/SHARED-TOOLS.md" | sed 's/^/  /'
