> **English (primary): [configuration.md](configuration.md)** ｜ **[中文文档](configuration.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 配置

环境变量均可省略；同名 CLI flag（`--port` / `--db` / `--isolation-mode` 等）优先级更高。全部定义见 `src/config.ts` 与 `node lib/cli.js --help`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AI1NET_PORT` | `3080` | 控制面绑定端口（nginx 上游） |
| `DSH_AI1NET_DATA_ROOT` | `~/.dsh_ai1net` | 每用户 home / workspace 根（生产建议 `/var/lib/dsh_ai1net`） |
| `DSH_AI1NET_DSH_BIN` | `dsh` | 子 DSH 可执行文件（**建议绝对路径**） |
| `DSH_AI1NET_ISOLATION_MODE` | `soft` | `soft` 软隔离 / `account` 账号级硬隔离（Linux，需 root） |
| `DSH_AI1NET_BASE_UID` | `100000` | 账号级隔离的 uid 基数 |
| `DSH_AI1NET_PORT_GUARD` | `false` | 端口守卫；不支持的环境下开启会**拒绝启动** |
| `DSH_AI1NET_SECURE_COOKIES` | `false` | HTTPS 部署设为 `true`（cookie 加 `Secure`、`SameSite=None`） |
| `DSH_AI1NET_BASE_DOMAIN` | 空 | 每用户子域基域（如 `dsh.example.com`）；空 = 仅子路径访问 |
| `DSH_AI1NET_COOKIE_DOMAIN` | 空 | 会话 cookie 的 `Domain`（如 `.dsh.example.com`，注意前导点） |
| `DSH_AI1NET_SESSION_TTL` | `604800` | 会话有效期（秒，默认 7 天） |
| `DSH_AI1NET_MAX_UPLOAD` | `25MB` | 上传请求体上限 |
| `DSH_AI1NET_PACKAGE_DIR` | （自动探测） | **平台内置 dsh 的包根**。默认按序探测：由 `DSH_AI1NET_DSH_BIN` 解软链反推 → `/usr/local/lib/node_modules`、`/usr/lib/node_modules` → `npm root -g`。⚠️ `npm i -g` 的落点随发行版而变（发行版包管理器装的 Node 常落 `/usr/lib/node_modules`），**写死会让「模型设置」的厂家目录与「插件兼容性预检」静默失效**（不报错、只剩降级行为）⇒ 仅当探测失败时才需显式设置。同时接受无前缀的 `DSH_PACKAGE_DIR` |
| `DSH_AI1NET_COMPAT_ROOT` | （同左） | 同上（兼容旧名）。同时接受无前缀的 `DSH_COMPAT_ROOT` |
| `DSH_AI1NET_PI_AI_DATA_DIR` | （自动探测） | `@earendil-works/pi-ai` 的**厂家目录**数据位置（`<包根>/node_modules/@earendil-works/pi-ai/dist/providers/data`）；一般无需设置。同时接受无前缀的 `PI_AI_DATA_DIR` |
| `DSH_AI1NET_RESTART_BACKOFF` | `1000` | 崩溃后的自动重启延迟（毫秒） |
| `DSH_AI1NET_RESTART_BACKOFF_MAX` | `30000` | 退避上限（毫秒） |
| `DSH_AI1NET_CRASH_MAX_RESTARTS` | `5` | 熔断统计窗口内允许的自动重启次数 |
| `DSH_AI1NET_CRASH_WINDOW` | `600000` | 熔断统计窗口（毫秒） |
| `DSH_AI1NET_CRASH_STABLE` | `60000` | 连续运行多久视为已恢复（毫秒） |
| `DSH_AI1NET_CRASH_BREAKER_COOLDOWN` | `600000` | 熔断首次冷却（毫秒） |
| `DSH_AI1NET_CRASH_BREAKER_MAX_COOLDOWN` | `21600000` | 冷却上限（毫秒，6 小时） |
| `DSH_AI1NET_MAX_IDLE_INSTANCES` | `4` | 常驻实例上限（超出后按空闲回收） |
| `DSH_AI1NET_INSTANCE_IDLE_TTL` | `604800` | 实例空闲多久可被回收（秒，7 天） |
| `DSH_AI1NET_IDLE_REAP_INTERVAL` | `60` | 空闲回收巡检间隔（秒） |
| `DSH_AI1NET_BUNDLED_SKILL_DIR` | `<dataRoot>/bundled-skills` | 内置共享技能层目录（用户只读） |
| `DSH_AI1NET_ENABLE_PATCH` | `false` | 是否向子 DSH 注入 `--patch`（运行时插件 + 每文件夹插件） |
| `DSH_AI1NET_SECRET` | 自动生成 | 密钥库加密主密钥；未设置时生成并持久化到 `<dataRoot>/secret.key`（0600） |

补充：

- **部署自己的值从哪里来**：`config/platform.env` —— 复制 `config/platform.env.example` 后填写。该文件**已被 git 忽略，不会随仓库分发**；仓库里只有模板与两个加载器。优先级为**系统环境变量 > `config/platform.env` > 上表的默认值**。加载器是 `config/load.sh`（shell）与 `config/index.cjs`（Node 脚本）；控制面自身读进程环境变量，由 `install.sh` 经 systemd 单元提供。文件缺失时**发告警并回退默认值**。
- `install.sh` 写入的取值与上表默认值有出入（脚本按场景选择）：`ISOLATION_MODE=account`（缺 `useradd`/`setpriv` 时降级 `soft`）、`ENABLE_PATCH=true`、`PORT_GUARD=false`（`--port-guard` 开启）。以 `/etc/dsh_ai1net.env` 实际内容为准。
- **由平台注入、不建议手工设置**：`DSH_AI1NET_ROLE`、`DSH_AI1NET_HANDOFF_PATH`、`DSH_AI1NET_USER_ROOT`。
- **CLI 专用**：`DSH_AI1NET_ADMIN_PASSWORD` 等价于 `bootstrap-admin --password`。
- **可选钩子**：`DSH_PICKER_ENSURE_SCRIPT` 指定实例启动后要执行的初始化脚本（留空 = 不执行）。
