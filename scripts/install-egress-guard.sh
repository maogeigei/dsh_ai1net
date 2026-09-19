#!/bin/bash
# 一键复现 dsh 实例出网护栏（/etc/nftables-dsh-egress.nft + dsh-egress.service）
#
#   H1 阻断云元数据端点（100.100.100.200）
#   H4 观测实例新建外联（只记录不拦截）
#   H5 封锁实例**主动**访问宿主自身（loopback / eth0 / docker0 / 公网 EIP）
#
# 用法（需 root）：bash scripts/install-egress-guard.sh
# 回滚：systemctl disable --now dsh-egress
#
# ⚠️ 改 H5 前必读「事故/踩坑记录」：**不能只按目的地址匹配** ——
#    实例是「先收后回」的服务端，回包目的地址同样是 127.0.0.1，
#    按 daddr 一刀切会把回包一起拒掉 → nginx 无法回源、实例整体不可用
#    （判定特征：root 连实例端口 **timeout 而非 refused**）。
#    必须只匹配主动发起：TCP 用纯 SYN，UDP 用 ct state new。
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "需要 root" >&2
  exit 1
fi

. "$(cd "$(dirname "$0")/.." && pwd)/config/load.sh"
# ⛔ 本机地址不写死在 nft 规则里：规则体里用占位符，写完文件再注入实际值。
HOST_ADDRS=""
for a in "$DSH_HOST_LAN_IP" "$DSH_HOST_PUBLIC_IP"; do
  [ -n "$a" ] && HOST_ADDRS="${HOST_ADDRS:+$HOST_ADDRS, }$a"
done

echo "==> 写入 /etc/nftables-dsh-egress.nft"
cat > /etc/nftables-dsh-egress.nft <<'NFTEOF'
#!/usr/sbin/nft -f
# dsh 实例出网护栏
#   H1（云元数据端点）+ H4（外联观测）
#   H5（实例不得「主动」访问宿主自身 —— 切断宿主服务面与跨租户互通）
# 只作用于 dsh 实例 uid 段 100000-199999；root / 云监控 / Docker 不受影响。
#
# 坑 1：云厂商内网 DNS 通常是 100.100.2.136 / 100.100.2.138 —— 绝不能封 100.100.0.0/16 整段，
#        本文件只精确封元数据端点 100.100.100.200（/32）。
# 坑 2：Docker 用 iptables-nft，本表独立，不与 docker 链混用。
# 坑 3：观测要排除 53 端口 —— nft 日志不记录查询域名，DNS 行是纯噪音且量最大。
# 坑 4（实测踩到）：H5 **绝不能只按目的地址匹配**。实例是「先收后回」的服务端：
#        nginx(root) → 实例端口的 SYN 合法，但实例回的 SYN-ACK 与后续数据包
#        **目的地址同样是 127.0.0.1**（客户端就是本机）。若按 daddr 一刀切 reject，
#        回包会被一起拒掉 → root 连实例端口 **超时**、nginx 无法回源、实例整体不可用。
#        → 必须只匹配**实例主动发起**的连接：TCP 用纯 SYN（`tcp flags & (fin|syn|rst|ack) == syn`，
#          SYN-ACK 带 ack 位故不匹配），UDP 用 `ct state new`。
table ip dsh_egress {
	chain output {
		type filter hook output priority filter; policy accept;

		# H1 · 阻断云元数据端点（先记录再拒绝）
		meta skuid 100000-199999 ip daddr 100.100.100.200 log prefix "dsh-egress-BLOCK " level warn
		meta skuid 100000-199999 ip daddr 100.100.100.200 counter reject

		# H5 · 实例不得主动访问宿主自身
		# 封 4 类目的地址（仅实例主动发起的连接）：
		#   127.0.0.0/8    → 宿主全部 loopback 服务（sshd、nginx、面板、
		#                    门户 3080）+ 其他实例的 127.0.0.1 监听
		#   <host-lan-ip>  → 宿主内网卡（eth0，同样到达 nginx/面板）
		#   172.17.0.1     → docker0 网桥网关
		#   <server-public-ip>   → 公网 EIP（回环到本机 nginx/sshd）
		# 不影响：公网访问、云厂商内网 DNS、pip/npm 下载、
		#         实例自身监听端口、nginx 回源（root 发包 + 实例回包带 ack）
		meta skuid 100000-199999 ip daddr { 127.0.0.0/8, 172.17.0.1, __HOST_ADDRS__ } \
			meta l4proto tcp tcp flags & (fin|syn|rst|ack) == syn \
			counter log prefix "dsh-egress-HOST " level warn limit rate 20/minute
		meta skuid 100000-199999 ip daddr { 127.0.0.0/8, 172.17.0.1, __HOST_ADDRS__ } \
			meta l4proto tcp tcp flags & (fin|syn|rst|ack) == syn \
			counter reject with tcp reset
		meta skuid 100000-199999 ip daddr { 127.0.0.0/8, 172.17.0.1, __HOST_ADDRS__ } \
			meta l4proto udp ct state new counter reject

		# H4 · 观测实例新建外联（先记录不拦截；排除 loopback 与 DNS 降噪）
		meta skuid 100000-199999 ip daddr != 127.0.0.0/8 tcp dport != 53 ct state new counter log prefix "dsh-egress " level info
		meta skuid 100000-199999 ip daddr != 127.0.0.0/8 udp dport != 53 ct state new counter log prefix "dsh-egress " level info
	}
}
NFTEOF

# 注入本机地址（来自 config/platform.env）；未配 ⇒ 摘掉该占位符，规则只剩回环与 docker 网桥。
if [ -n "$HOST_ADDRS" ]; then
  sed -i "s|__HOST_ADDRS__|$HOST_ADDRS|g" /etc/nftables-dsh-egress.nft
else
  sed -i "s|, __HOST_ADDRS__||g" /etc/nftables-dsh-egress.nft
fi

echo "==> 写入 /etc/systemd/system/dsh-egress.service"
cat > /etc/systemd/system/dsh-egress.service <<'SVCEOF'
[Unit]
Description=DSH instance egress guard (nftables)
Documentation=file:/etc/nftables-dsh-egress.nft
After=network-pre.target
Before=network.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
# 幂等：nft -f 遇到已存在的表会报 File exists，故先删（忽略不存在时的报错）
ExecStartPre=-/usr/sbin/nft delete table ip dsh_egress
ExecStart=/usr/sbin/nft -f /etc/nftables-dsh-egress.nft
ExecStop=-/usr/sbin/nft delete table ip dsh_egress

[Install]
WantedBy=multi-user.target
SVCEOF

echo "==> 语法预检"
nft -c -f /etc/nftables-dsh-egress.nft

echo "==> 启用并重载"
systemctl daemon-reload
systemctl enable dsh-egress
systemctl restart dsh-egress

echo "==> 当前规则"
nft list table ip dsh_egress
echo "OK"
