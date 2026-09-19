# config/ — 平台部署配置

本目录集中存放**部署相关的值**。源码里不再写任何真实部署值，一律从这里（或同名环境变量）读取。

## 文件

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `platform.env.example` | ✅ 入库 | 模板，只有占位符。复制成 `platform.env` 后填写 |
| `platform.env` | ⛔ **不入库** | 本机真实值，已被 `.gitignore` 排除 |
| `load.sh` | ✅ 入库 | shell 加载器，供 `scripts/` 下的脚本 `source` |

## 怎么用

**首次配置**

```sh
cp config/platform.env.example config/platform.env
${EDITOR:-vi} config/platform.env
```

**shell 脚本里引用**

```sh
. "$(dirname "$0")/../config/load.sh"
echo "$DSH_PLATFORM_DIR/state"      # → 平台状态目录
```

`load.sh` 找不到文件时不报错，脚本继续用系统 env 或自身默认值。

**TypeScript 里引用**

`src/config.ts` 负责解析，业务代码只读 `ServerConfig` 上的字段，不直接读 `process.env`：

```ts
const cfg = resolveConfig()
cfg.platformDir     // <platform-dir>
cfg.stateDir        // <platform-dir>/state
cfg.backupDir       // <platform-dir>/backups
cfg.installDir      // 代码安装根
```

## 优先级

**系统环境变量 > `config/platform.env` > 代码内中性默认值**

- systemd drop-in（`/etc/systemd/system/dsh_ai1net.service.d/*.conf`）与 `/etc/dsh_ai1net.env` 属"系统环境变量"，优先级最高；
- `load.sh` 逐键判断，**已由系统 env 提供的键不会被文件覆盖**；
- 代码内默认值一律是**中性值**（不含任何真实域名、地址、路径），只保证"不配也能起"。

> ⚠️ 注意：dsh_ai1net 的 systemd drop-in 里同名键会**压掉** `/etc/dsh_ai1net.env` —— 两个地方都写同一个键时，以 drop-in 为准。

## 键一览

| 键 | 含义 | 中性默认（代码内） |
|---|---|---|
| `DSH_AI1NET_DATA_ROOT` | 数据根（每用户 home/ws、平台库） | `~/.dsh_ai1net` |
| `DSH_PLATFORM_DIR` | 平台私有目录的父目录 | `<dataRoot>/platform` |
| `DSH_INSTALL_DIR` | 代码安装根（`lib/`、`scripts/`） | 模块相对路径推导 |
| `DSH_AI1NET_BASE_DOMAIN` | 对外域名 | 空（子域功能关闭） |
| `DSH_AI1NET_COOKIE_DOMAIN` | 会话 cookie 域 | 空（host-only） |
| `DSH_AI1NET_OVERLAY_BOOTSTRAP_SEEDS` | 覆盖网络引导种子，逗号分隔 | 空（功能关闭） |
| `DSH_AI1NET_CLUSTER_HOST_ID` | 本机在 `dsh_hosts.id` 里的标识 | 空 |
| `DSH_AI1NET_CLUSTER_AGENT_TOKEN` | Worker 注册凭据 | 空 |
| `DSH_AI1NET_TUNNEL_TARGET` | 反向隧道目标 | 空（隧道关闭） |
| `DSH_HOST_PUBLIC_IP` / `DSH_HOST_LAN_IP` | 出网护栏要封的本机地址 | 空（只封回环） |

派生字段（不用单独配）：`stateDir` = `$DSH_PLATFORM_DIR/state`、`backupDir` = `$DSH_PLATFORM_DIR/backups`、`artifactDir` = `$DSH_PLATFORM_DIR/artifacts`。
