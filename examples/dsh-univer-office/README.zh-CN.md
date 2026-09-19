# 插件改造示例：`dsh-univer-office`

> **English (primary): [README.md](README.md)** ｜ **[中文文档](README.zh-CN.md)（当前）**

> ### 🙏 致敬
> 本示例的原插件是 **[dream-num](https://github.com/dream-num) 的 [`dsh-univer-office`](https://github.com/dream-num/dsh-univer-office)（Apache-2.0）** ——
> **感谢作者开源**。能把一个 41 MB 的在线表格/文档插件搬进托管环境，前提是有人先把它写出来。
> 本目录**只放我们做的改造**（补丁 + 新增模块 + 配套技能），**不含上游任何源码副本**；
> 完整叙事见 [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4。

---

## 一、为什么必须改造

`dsh-univer-office` 的静态兼容性预检**全部通过**（依赖范围 ✅、导出符号 ✅），
但在托管平台上**完全不可用**。原因是两条**互相独立**的阻碍 —— **缺一都打不开**：

| # | 阻碍 | 机理 | 实测现象 |
|---|---|---|---|
| **①** | Host → Gateway 走 **TCP 回环** | gateway 由宿主 `spawn`、**继承同一 uid**；平台的出网护栏对实例 uid 段访问 `127.0.0.0/8` 是 `reject with tcp reset` ⇒ **宿主连不上自己拉起的 gateway** | 创建文档恒报 `bundled Gateway did not become ready within 10000ms` |
| **②** | 浏览器 → Viewer 用**绝对 URL** | 源码硬编码 `gateway = http://127.0.0.1:${port}`、`viewerUrl = ${gateway}/?file=…`，并被当作 **iframe src** ⇒ 浏览器去**用户自己电脑**的 `127.0.0.1` 找 Viewer | `grep -o "viewerUrl: [^,]*" lib/index.js` |

⇒ **正解不是"换一个地址"，而是"换成一条路径"**：进程间改走 **unix socket**，浏览器侧改走**同源反代 + 相对路径**。

（"换成服务器 IP"是最容易想到也最错的做法：护栏封禁名单里就含服务器自身 IP；多租户同机绑端口会跨租户泄露；HTTPS 页面嵌 HTTP iframe 会被浏览器硬拦。）

## 二、目录

| 路径 | 内容 |
|---|---|
| `port.patch` | 对**已跟踪文件**的全部改动（**19 个文件，+560 / −58**） |
| `new-files/` | 本次**新增**的 6 个模块（`git diff` 不含未跟踪文件，故单独放） |
| `companion-skill/office-file-generation/` | 配套技能：本机 glibc 2.32 跑不了 Univer 原生绑定，于是用**纯 Python 标准库**直接产出 `.docx / .xlsx / .pptx` |

> **覆盖范围。** 这些改造件在 **`0.2.27`** 这个状态上**自洽** —— `port.patch` 写的版本号就是它，本目录里的东西可以**原样应用**。其后的两轮（`0.2.28` 的自带 glibc 启动器、`0.2.29` 在平台升级前放宽 peer 范围）见 [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4.5–§4.6；**本目录不依赖它们中的任何一项**。

## 三、基线与应用

```sh
git clone https://github.com/dream-num/dsh-univer-office.git
cd dsh-univer-office
git checkout 5c190b6                       # 本改造的上游基线（2026-09-10；该提交的 package.json = 0.2.14）
git apply -p1 < /path/to/port.patch
cp -r /path/to/new-files/src/* src/        # 新增模块（补丁里没有）
```

> ⚠️ 补丁里 `package.json` 的差异包含 `0.2.14 → 0.2.27` —— 那不是单纯的版本号跳变，**就是改造过程的迭代版本**（本地留了 0.2.16…0.2.27 共 12 个构建产物为证）。

## 四、改造要点

### 4.1 新增模块

| 模块 | 作用 |
|---|---|
| `shared/gateway-socket` | 解析 `UNIVER_DSH_GATEWAY_SOCKET`（路径值或 `auto`）+ 定义 `unix:<path>` 端点标识 |
| `shared/unix-http` | **HTTP over unix socket** 的最小客户端（`status`/`headers`/`text`/`json`/`arrayBuffer`/`signal`）—— **零新依赖** |
| `shared/gateway-request` | **统一传输入口** `requestGateway(endpoint, path, init)`：按端点前缀自动选 socket / TCP |
| `host/webServer/viewer-proxy` | **同源反向代理**：HTTP（流式，剥离 hop-by-hop 头）+ **WebSocket upgrade 转发** |
| `shared/viewer-paths` | 浏览器侧路径常量（独立于 webServer，避免反向依赖） |
| `workers/unit-content/rust-formula-engine-host-compat` | 宿主兼容垫片：把 `@univerjs-pro/engine-formula-rust` 换成仓库内实现 |

> ⚠️ **更晚**的一轮（`0.2.28`）新增了第 7 个模块 `host/processes/glibc-runtime.ts` —— 让进程经**自带的 glibc 运行时**启动（于是旧宿主上也能跑原生 Office 导入导出）。它写在 [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4.5–§4.6，但**不在本目录的 `new-files/` 里** —— 本目录与 `port.patch` 的产物保持严格一致。

### 4.2 三条设计决策（都是踩出来的）

1. **socket 是「可选传输」，不是替换 TCP** —— 由 env 开启（设路径，或设 `auto` 取私有临时目录下的进程级路径）；
   **不设则完全保持上游原行为** ⇒ **对上游友好（默认行为不变，可以安心合并）**，回滚只需**删掉这个 env**。
2. **代理规则只有两条** —— 该插件所有数据面请求都在同一前缀下（含 WebSocket）：
   `/uf/**` → 转发 gateway（HTTP + WS upgrade）；`/<plugin>-api/viewer/**` → 转发 gateway 的页面与静态资源。
   ⚠️ Viewer 页面加载后会**用绝对路径**请求 `/uf/*`，所以代理**必须接管 `/uf/*`**。
3. **两个平台侧隐蔽坑** ——
   ① 平台的前缀匹配**没有「最长优先」**：更短的 `/myplugin-api` 会**吃掉** `/myplugin-api/viewer/...` ⇒ viewer 代理必须放进**现有 router 的 dispatch 内**；
   ② WS 路由注册是**精确路径**，而插件的 WS 路径含**动态段** ⇒ 只能**按文件懒注册**（打开文件时种子化 + Map 去重 + 统一 dispose）。

## 五、已知限制（诚实记录）

- **截图 / PDF（`compile_svg` / `lint` / `screenshot` / `print_pdf`）不可用** —— 而且这**不是** glibc 问题：实例内**没有浏览器**，而 headless Chromium 要多占 **+200–400 MB**，撞实例内存配额。这是**环境侧**决策，插件侧修不了；
- **有一个依赖在上游只是 *devDependency*** —— 生产里能解析到，纯粹因为包管理器把它提升到了共享目录。一次干净的安装就可能让它消失；正解是把它正式声明出来；
- worktree 场景的 WS 只注册了**文件级**路径；
- 这是 **fork**：上游更新需要自行合并。
- ✅ *对本文件较早版本的更正*：它曾写「该插件的 **worker 侧仍走 TCP**」。**这已不再成立**。worker 的 IPC 垫片曾**静默失效** —— 那正是 `0.2.24` 那一轮修掉的缺陷（[PLUGIN-PORTING.md](../../PLUGIN-PORTING.md) §4.5–§4.6）。socket 模式下宿主给 worker 一个**合成 origin**（`http://unix`），垫片把指向它的请求改走 unix socket；**其它 URL 一律原样交回原实现**。

## 六、怎么验证（不碰生产）

1. **依赖与构建**：装依赖 → 构建（增量约 5–16 s）；
2. **回归**：跑插件自带的集成冒烟（该插件 **18 项**：新建 / 状态 / 导入 / 导出 / 截图 / 打印 / 资源 / worktree 生命周期…）—— 证明改动**没破坏原功能**；
3. **socket 实测**：构建产物放到**临时隔离目录**（原生依赖用只读符号链接指向已有安装），启动后确认
   `listening on unix:…sock`、`GET /` 返回 **200**、数据路由可达；**同时跑一遍 TCP 对照**；
4. **清理临时产物**。

> ⚠️ **Windows 上验不了 unix socket**（`AF_UNIX` 直接 `EACCES`，用纯 `node:net` 同样复现）—— 这是**平台限制，不是代码问题**，**必须在 Linux 上验**。

---

## 七、再次致谢

- **插件本体**：[`dream-num/dsh-univer-office`](https://github.com/dream-num/dsh-univer-office) · **Apache-2.0** · **感谢作者与 Univer 社区**。
- 本目录的补丁与新增模块同样以 **Apache-2.0** 提供，以便与上游保持一致、方便合并回去。
- 上游若需要，这个补丁可以直接拿去用 —— 它的设计目标就是"**默认行为不变**"。
