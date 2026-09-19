I want you to install dsh_ai1net for me. Execute all steps autonomously.

> **English (primary): [install.md](install.md)** ｜ **[中文文档](install.zh-CN.md)（当前）**

OBJECTIVE: 在一台 Linux 机器上装好 **能力网络**（把 DeepSeek Harness 托管给多个用户），让控制面服务健康并可访问。

DONE WHEN: `systemctl is-active dsh_ai1net` 输出 `active`，且 `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT:-3080}/` 输出 `200`。

## TODO

- [ ] Step 0：确认环境（**不满足就停手**，不要猜）
- [ ] Step 1：取代码
- [ ] Step 2：确定部署模式（问用户唯一一个问题：有没有域名）
- [ ] Step 3：`--dry-run` 预演
- [ ] Step 4：正式安装
- [ ] Step 5：验证
- [ ] Step 6：把访问信息交给用户

## Step 0: 确认环境

```sh
uname -s; id -u; command -v systemctl; command -v nginx || echo NO_NGINX; node -v || echo NO_NODE
```

**Verify:** 输出必须同时满足 `Linux` · `id -u` 为 `0` · `systemctl` 有路径。

**任一不满足 ⇒ 停下，把上面原样贴给用户，并按下表给出口，不要自行改造环境：**

| 情况 | 给用户的出口 |
|---|---|
| Windows / macOS 个人电脑 | 先在 **WSL2** 里装 Ubuntu（管理员 PowerShell 执行 `wsl --install`；装完在 Ubuntu 里把 `/etc/wsl.conf` 写成 `[boot]` + `systemd=true`，再 `wsl --shutdown` 重进），然后**回到本文件 Step 1** |
| 没有 root | 用 root 重跑，或给命令加 `sudo` |
| 没有 nginx | **不阻塞**：Step 4 加 `--no-nginx`，用 `http://127.0.0.1:<端口>/` 访问 |
| 没有 node | **不阻塞**：Step 4 加 `--install-node` |

## Step 1: 取代码

```sh
git clone https://github.com/maogeigei/dsh_ai1net.git && cd dsh_ai1net
```

**Verify:** `test -f install.sh` 退出码为 0。

## Step 2: 确定部署模式

**先问用户一句**（这是唯一必须问的问题）：**有没有自己的域名？**

- **有** ⇒ 记下 `DOMAIN=<用户给的域名>`。**先确认 DNS 已就位**：两条 A 记录 —— `<域名>` 与 `*.<域名>` 都指向本机公网 IP。
  可选：拿到 Cloudflare API Token（权限 `Zone → DNS → Edit`，只限该 zone）放进 `CF_API_TOKEN`，即可自动签**通配证书**（有 HTTPS）。
- **没有** ⇒ 用 `<本机公网IP>.nip.io` 当域名（免费通配解析，**只有 HTTP**）；连域名都不要也可以（仅本机 3080）。

**Verify:** 有域名时 `dig +short "$DOMAIN"` 与 `dig +short "test.$DOMAIN"` 都返回本机公网 IP。

## Step 3: 预演

```sh
sudo bash install.sh --dry-run ${DOMAIN:+--domain "$DOMAIN"} ${EMAIL:+--email "$EMAIL"} --yes
```

**Verify:** 输出是一串 `[dry-run] …` 且退出码 0；`--dry-run` **只打印、不落盘**，不应出现任何「已完成」式提示。

## Step 4: 正式安装

```sh
sudo ${CF_API_TOKEN:+"CF_API_TOKEN=$CF_API_TOKEN"} bash install.sh \
  ${DOMAIN:+--domain "$DOMAIN"} ${EMAIL:+--email "$EMAIL"} \
  ${NO_NGINX:+--no-nginx} --install-node --yes
```

（把 `${NO_NGINX:+--no-nginx}` 换成 Step 0 判定的实际需要；不需要就不要带。）

**Verify:** 退出码 0。脚本末尾会打印**首个管理员的用户名与密码** —— 未传 `--admin-pass` 时是随机生成的，**只打印这一次**，请立刻记下转交用户。

## Step 5: 验证

```sh
systemctl is-active dsh_ai1net
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${PORT:-3080}/"
```

**Verify:** 分别输出 `active` 与 `200`。有域名时再补两条：

```sh
curl -s -o /dev/null -w '%{http_code}\n' "http://$DOMAIN/"          # 期望 200
curl -s -o /dev/null -w '%{http_code}\n' "http://admin.$DOMAIN/"    # 期望 401（未登录，属正常）
```

## Step 6: 交给用户

报这三条，不要多讲：

1. **访问地址**：有域名 ⇒ `http://$DOMAIN/`；否则 ⇒ `http://127.0.0.1:${PORT:-3080}/`
2. **管理员账号与密码**（Step 4 打印的那一对）
3. **新用户只能「自助注册 → 管理员在管理台审核通过」**（平台没有管理员直接建号的接口）

EXECUTE NOW: Start with Step 0. Mark TODO items complete as you go. Stop when `systemctl is-active dsh_ai1net` prints `active` and `curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT:-3080}/` prints `200`.

---

## Optional: 装完之后能做什么

用 admin 登录 → 管理台审核用户 → 用户进网页桌面上传文件、建文件夹 → 「在此文件夹启动 DSH」。
**DSH 聊天界面必须有每用户子域**（DSH 的 SPA 用绝对路径，子路径加载不了）；不配域名时其余能力正常，只有聊天界面打不开。

## Optional: 卸载

```sh
sudo bash install.sh --uninstall --yes              # 保留数据
sudo bash install.sh --uninstall --purge --yes      # 连数据一起删（不可逆）
```

## Optional: 失败时先看这三处

| 现象 | 先看 |
|---|---|
| 服务起不来 | `journalctl -u dsh_ai1net -n 50` |
| 域名打不开 | `nginx -t`；脚本写的是 `/etc/nginx/conf.d/` 或面板（宝塔）vhost 目录 |
| 装完登录不了 | 管理员必须**先建、服务后启**；已丢失则停服务后跑 `node lib/cli.js bootstrap-admin`（服务在跑会持住 SQLite 锁） |

完整说明见 [README.md](README.md)。
