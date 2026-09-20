> **English (primary): [faq.md](faq.md)** ｜ **[中文文档](faq.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 常见问题

<details>
<summary><b>部署后打不开 DSH 聊天界面（管理台正常）</b></summary>

**这是正常的 —— 聊天界面必须「每用户一个 host」。** 不配域名时平台本体（登录 / 审核 / 管理台 / 桌面 / API）可用，但 DSH 的 SPA 用绝对路径 ⇒ 纯子路径打不开。

三种走法：① 自有域名 + 通配证书（推荐，也是唯一能上 HTTPS 的）；② 临时用通配解析服务（`--domain <IP>.nip.io`，仅 HTTP）；③ 先不配，只跑通登录 / 审核 / 桌面。详见[「关于域名」](installation.zh-CN.md#关于域名什么时候必须要没有怎么办)。
</details>

<details>
<summary><b>服务起不来，日志报 <code>spawn dsh ENOENT</code></b></summary>

`DSH_AI1NET_DSH_BIN` 要写**绝对路径**（`which dsh` 的结果）—— systemd 的 PATH 很精简，写 `dsh` 通常找不到。
</details>

<details>
<summary><b>实例启动报 <code>no sandbox backend is usable</code> / 工具被拒绝</b></summary>

多为隔离模式与内核能力不匹配。先用 `--isolation soft` 跑通再逐项加固；账号级硬隔离需要 `useradd` + `setpriv` + root。
</details>

<details>
<summary><b>开启 <code>PORT_GUARD</code> 后服务拒绝启动</b></summary>

端口守卫依赖 iptables owner-match，不支持的环境会 **fail loud**（有意设计）。先关掉跑通，确认宿主支持后再开。
</details>

<details>
<summary><b>502 / 实例无响应</b></summary>

按序查：`systemctl status dsh_ai1net` → `journalctl -u dsh_ai1net -n 100` → 管理台「服务管理」里实例是否在跑 → nginx `error_log`。反复重启通常是某插件与当前 DSH 版本不兼容，在「能力管理」里禁用它。
</details>

<details>
<summary><b>改了插件包但实例里看不到变化</b></summary>

实例启动时才加载 client bundle ⇒ **改完必须重启实例**。平台在启用插件后会主动重启；手工改动需自己停一次实例。
</details>
