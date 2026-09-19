> **English (primary): [installation.md](installation.md)** ｜ **[中文文档](installation.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 安装

> 精简版（要求 + 一条命令 + 验证）见 [README → 安装](../README.zh-CN.md#安装)。
> 要让 **AI agent** 自己装，把 [install.zh-CN.md](../install.zh-CN.md) 交给它执行。

## 前置条件

| 项 | 要求 |
|---|---|
| 系统 | Linux（Debian/Ubuntu 或 RHEL 系）+ systemd + **root** |
| Node.js | **^22.19 或 ≥24**（缺失时加 `--install-node` 自动安装） |
| 域名 | **走「方式一」需要**（每用户子域与 HTTPS 依赖它）；没有也能装 ⇒ 见「方式二」 |
| 端口 | 80 / 443（脚本写 nginx 反代并 reload；被面板 nginx 占用也能自适应） |

## 方式一：有域名（正式部署 · 推荐）

> 只有这条路径具备**完整能力**：每用户子域 + HTTPS + 手机端可用。
>
> **现成例子**：本项目自己的部署用的主域是 **`ai1net.com`**（每用户子域为 `*.ai1net.com`）。下文一律用 `dsh.example.com` 作占位 —— 请替换成你自己的域名。

**第 1 步 · 配 DNS**（两条 A 记录，都指向本机公网 IP）

| 记录 | 值 | 作用 |
|---|---|---|
| `A  dsh.example.com` | 服务器公网 IP | 主域：登录 / 管理台 / 网页桌面 |
| `A  *.dsh.example.com` | 同一 IP | 每用户子域：`<用户名>.dsh.example.com` |

```sh
dig +short dsh.example.com        # 应回你的公网 IP
dig +short test.dsh.example.com   # 通配，也应回同一个 IP
```

**第 2 步 · 准备通配证书**

脚本用 certbot 的 **DNS-01（Cloudflare）** 签发 `dsh.example.com` + `*.dsh.example.com` 的**通配证书**，
所以需要一个 Cloudflare API Token（权限 `Zone → DNS → Edit`，且**只限该 zone**）：

```sh
apt-get install -y certbot python3-certbot-dns-cloudflare     # Debian / Ubuntu
dnf install -y certbot python3-certbot-dns-cloudflare         # RHEL 系
```

> 不用 Cloudflare：跳过自动签发，自行准备 `/etc/letsencrypt/live/dsh.example.com/{fullchain.pem,privkey.pem}` 即可，脚本会直接引用。

**第 3 步 · 执行部署**

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git
cd dsh_ai1net
sudo CF_API_TOKEN=xxx bash install.sh --domain dsh.example.com --email you@example.com
```

**第 4 步 · 脚本做了什么**

环境预检 → 装依赖并构建 → 装 DSH CLI → 写 `/etc/dsh_ai1net.env`（0600）→ 建数据根（0700）→
签发通配证书 → 写 nginx 反代（`dsh.example.com` + `*.dsh.example.com`）→ 写 systemd 服务并启动 →
创建首个管理员 → 健康检查。

**第 5 步 · 验证**

| 检查 | 命令 | 期望 |
|---|---|---|
| 服务 | `systemctl is-active dsh_ai1net` | `active` |
| 主域 | `curl -I http://dsh.example.com/` | `200`（或 301 跳 https） |
| HTTPS | `curl -I https://dsh.example.com/` | 证书有效、`200` |
| 未登录子域 | `curl -I https://test.dsh.example.com/` | `401`（子域要登录后才有会话） |

**第 6 步 · 开第一个用户**

`https://dsh.example.com/` 用 admin 登录管理台 → 另开浏览器注册普通用户 → 管理台「通过」→
该用户登录进桌面 → 上传文件 / 建文件夹 → 「在此文件夹启动 DSH」。

## 方式二：无域名（先跑通链路 / 本地评估）

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git
cd dsh_ai1net
sudo bash install.sh                      # 不配域名：仅本机 3080 端口
```

打开 `http://127.0.0.1:3080/` 即可完成登录 / 审核 / 桌面 / 启动 DSH 的完整闭环（2026-09-14 真机实测：这些路径全部 `200`），但**聊天界面打不开**。

| 能力 | 方式二：不配域名（`BASE_DOMAIN` 为空） | 方式一：主域 + 通配证书 |
|---|---|---|
| 控制面 / 管理台 / 登录与审核 | ✅ 可用（`http://127.0.0.1:3080/`） | ✅ |
| 网页桌面 / 文件 / 密钥 / 插件与技能管理 | ✅ 可用 | ✅ |
| 「启动 DSH」动作本身 | ✅ 会返回子路径 URL | ✅ 返回子域 URL |
| **DSH 聊天界面** | ❌ **打不开** | ✅ 每用户子域可用 |
| HTTPS（含手机端） | ❌ | ✅ 需通配证书 |

⇒ **只想先跑通链路**（登录 / 审核 / 桌面 / 启动）就**不必配域名**；要用聊天界面，走**方式一**。

<details>
<summary>常用变体（点击展开）</summary>

```sh
sudo bash install.sh                      # 不配域名：仅本机 3080 端口，先跑通链路
sudo bash install.sh --dry-run            # 只打印将执行的命令，不落地
sudo bash install.sh --isolation soft     # 不做 OS 账号级硬隔离（缺 useradd/setpriv 时自动降级）
sudo bash install.sh --port-guard         # 额外开启端口守卫
sudo bash install.sh --admin-user admin --admin-pass '强密码'
sudo bash install.sh --uninstall          # 卸载服务（默认保留数据）
sudo bash install.sh --uninstall --purge --yes   # 连数据一起删（不可逆）

# 用 Cloudflare DNS 挑战签发通配证书（推荐：每用户子域必需）
CF_API_TOKEN=xxx sudo bash install.sh --domain dsh.example.com --email you@example.com
```

完整参数见 `bash install.sh --help`。
</details>

## 不用真实域名，也能把「方式一」走完一遍

想演练完整部署流程、又不想买域名 —— 用**通配解析服务** `nip.io`（`<任意>.<IP>.nip.io` 解析到该 IP，免费）：

```sh
sudo bash install.sh --domain <本机公网IP>.nip.io --email you@example.com
# 之后每个用户就是  <用户名>.<本机公网IP>.nip.io
```

这样**第 1～5 步与「方式一」完全相同**（含每用户子域），唯一拿不到的是**通配 HTTPS 证书** ——
`nip.io` 不提供 DNS API ⇒ 签不了 DNS-01 ⇒ 全程走 HTTP。

真机实测（2026-09-14，OpenCloudOS + 宝塔面板）：主域 `200` 返回平台工作台页 ｜ 未登录子域 `401` ｜
登录 / 审核 / 网页桌面 / 控制面 API 全通。

> ⚠️ HTTP 模式下「启动 DSH」返回的地址**写死 `https://`** ⇒ 需手动把地址栏的 `https` 改成 `http`。

## 手动部署（开发用）

```sh
npm ci && npm run build                       # tsc → lib/

node lib/cli.js bootstrap-admin --username admin --password '<强密码>' --db ./dev.local.db
node lib/cli.js --port 3080 --db ./dev.local.db
```

打开 `http://127.0.0.1:3080/` → admin 登录管理台 → 另开浏览器注册普通用户 → 回管理台「通过」→ 该用户登录进桌面，上传文件 / 建文件夹 → 「在此文件夹启动 DSH」。

## 关于域名：什么时候必须要、没有怎么办

**平台本体不需要域名**；**DSH 聊天界面需要「每个用户独占一个 host」**。原因有两个，都来自 DSH 前端与浏览器 cookie 的工作方式：

| 原因 | 说明 |
|---|---|
| **DSH 的 SPA 用绝对路径** | 它的 `/assets/*`、`/api/*` 请求打到 **host 根**。放在子路径（`/u/<userId>/dsh/`）下必然 404 ⇒ 所以「每个 DSH 要独占一个 host」 |
| **同一个 host 下 cookie 分不清用户** | 会话 cookie（`sid`）是 **host 级**的；不分子域时所有用户共享同一 host ⇒ **同一浏览器里多用户会互相顶掉会话**。每用户一个子域 ⇒ cookie 天然隔离 |

> 注意：平台本身**分得清用户**（子路径按 `userId`、子域按用户名），是**浏览器 cookie 分不清**。

**没有自有域名怎么办** —— 上文的 `nip.io` 讲的是**演练流程**；
它会因签发不了通配证书而**只有 HTTP**。**要有 HTTPS**，仍需自有域名 + DNS API（脚本已内置 Cloudflare）。

⇒ 结论：本地 / 内网 / 演示用 HTTP 足够；**公网正式对外建议走「方式一」**（自有域名 + 通配证书）。

> ⚠️ **HTTP 模式的一个已知限制**：「启动 DSH」返回的聊天地址目前**写死 `https://`**（`https://<用户名>.<主域>/`）⇒ 只跑 HTTP 时该链接**点不开**。
> 临时办法：把地址栏的 `https` 改成 `http`；正式使用请配好通配证书走 HTTPS。
