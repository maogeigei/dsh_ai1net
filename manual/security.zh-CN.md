> **English (primary): [security.md](security.md)** ｜ **[中文文档](security.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 安全模型

| 面 | 措施 |
|---|---|
| 会话 | 不透明随机 token，仅 SHA-256 哈希落库；cookie `HttpOnly` + `SameSite`，HTTPS 下加 `Secure` |
| 密码 | scrypt 加盐哈希，常数时间比较 |
| 密钥 | 每用户 API key 以 AES-256-GCM 加密落库；主密钥来自 env 或 `<dataRoot>/secret.key`（0600） |
| 路径 | 词法包含校验 + 逐段拒绝符号链接分量 |
| 隔离分层 | 软隔离 → 账号级硬隔离（独立 uid + `setpriv`）→ 端口守卫 |
| 同机旁路 | 端口守卫：按客户端 uid 只放行编排器，阻止同机其它账号直连实例回环端口 |
| 出网 | 实例侧护栏：云元数据端点、阻断实例主动访问宿主自身、外联观测 |
| 到实例的请求 | 反代层剥离 `Origin` / `Referer` / `Sec-Fetch-*` / `X-Forwarded-For`，Host 覆写为回环 |
| 实例环境 | 子进程 env 从白名单重建，平台密钥不进实例 |
| 上传 | zip 两阶段替换 + symlink / zip bomb 防护；安全扫描分级（P0 阻断 / P1 留痕） |
| 审计 | 敏感动作写入 `audit_log` |

## 设计说明

- **隔离是内核边界，不是文件权限约定** —— 每个用户一个确定性 uid，实例以该 uid 降权启动。
- **护栏宁可 fail loud 也不静默降级** —— 宿主不支持端口守卫时，开启它会**拒绝启动**，而不是悄悄退回不安全状态。
- **平台不保存可直接使用的明文密钥** —— 密钥静态加密，且上报信息的接口从不回传密钥本身。
