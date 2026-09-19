#!/usr/bin/env node
/**
 * 覆盖网络 · **观测最小集**探针
 *
 * ## 为什么是"一条命令 + 一个退出码"
 * `设计说明` 的教训原文是「**静默失效靠判别器定位**」。要让判别器能被**脚本**
 * （而不是人读日志）用，就必须有「一条命令出 PASS/FAIL」的入口 —— 本文件就是那个入口：
 *
 *   cd <repo> && node scripts/overlay-probe.cjs
 *
 * - **退出码**：全绿 `0` / 任一红 `1` / 用法或取数失败 `2`（可直接被 automation 消费）
 * - **输出**：≤ 12 行（每行 = 一条指标）；红的条目**另外**写到 stderr，并**指名**是哪个 ID
 * - **阈值**：⛔ **一个都不许硬编码** —— 全部从 `参数表_覆盖网络` 的 `` | `KEY` | 值 | `` 行读出来。
 *   缺键 ⇒ **报错退出**（⛔ 绝不用默认值静默兜底 —— 那正是"观测形同虚设"的成因）。
 *
 * ## 🔴 本文件的**零数字纪律**（判据 = 设计说明 §6 E5）
 * `grep -nE "[0-9]{3,}" scripts/overlay-probe.cjs` 必须**零命中** —— 连标识符名与注释里
 * 都不许出现"看起来像阈值"的数字（端口、节点名、日期一律走参数表或从取回的数据里取）。
 * 这样就不存在"脚本里藏着一个没人知道出处的常量"的可能。
 *
 * ## 🆕 `OBS-11` 的**集合判据**（序⑪ 规划 / 序⑫ 执行）
 * 旧口径 = 「**两个计数相等**」，有两处**结构性**缺陷：
 *   ⓐ 对实例/端点落点**在线态敏感** ⇒ 合法态被判红（**假红**）；
 *   ⓑ 对「**一进一出**」替换式变化**不敏感** ⇒ 真变化被放过（**假绿**）。
 * 新口径 = **三集包含式**（差集逐条点名）：
 *
 *   required ⊆ actual                              // 缺 ⇒ FAIL（点名缺项）
 *   actual ⊆ required ∪ allowed ∪ ranges ∪ derived // 多 ⇒ FAIL（点名多出项）
 *   derived = { <RELAY_BIND>:<p> | p ∈ /status.endpoints[].localPort }   // 唯一来源 = relay 自身 /status
 *
 * ⇒ `required` 抓"**消失**"、包含式抓"**新增**"、`derived` 让**合法动态落点**有名字
 * ⇒ 替换式变化（一进一出）**必然**被两条断言之一命中。
 * `LISTEN_COUNT` / `NFT_RULES` **已退役**（仅在参数表里留作对账），⛔ 本文件不得再引用它们。
 *
 * ## 🆕 `OBS-09` 的**在册判据**（序 ㊲ 口径修正：⛔ **不再依赖表内固定端口**）
 * 旧口径（序 ⑳ 起）= 「`/status.endpoints[]` 中存在**表内那个固定实例端口**且 `online = true` ⇒ 判可达」。
 * 🔴 结构性缺陷（序㊱ 收口复核棒连踩两次）：实例端口**会漂移** —— `spawn.ts#findFreePortInRange`
 * 从 `DSH_AI1NET_INSTANCE_PORT_BASE` **上扫取第一个空闲口**，而「访问时自然替换」在旧 scope 尚未释放端口时
 * 发起 ⇒ 落点顺延（实测 `21000 → 21001`）⇒ 表值一旦过期就**读不到实际在册的实例** ⇒ **假 SKIP**。
 * 新口径 = **在册判据从事实派生，表值只作对账**：
 *
 *   派生子 = { e ∈ `/status.endpoints[]` | `e.online === true` 且 `e.port ∉ {W47_AGENT_PORT, PEER_AGENT_PORT}` }
 *   · 派生为空 ⇒ **SKIP ＋ 留痕**（⛔ 不是 PASS：那会掩盖"该在册却掉出端点表"，那一类由
 *                 `OBS-01`/`OBS-04`/`OBS-08` 守；⛔ 也不是 FAIL：那是**合法态**）
 *   · 派生非空 ⇒ **每一个**都必须可达（走**它自己那条** `localPort` 回环落点，码 ∈ `PROBE_CODE_SET`）
 *                ⇒ 否则 **FAIL 并点名**（注册了却打不开 = 真红）
 *
 * ⚠️ 47 本机实例面（`:20000`）**结构性**地不在 `endpoints[]` 里（47 的 worker 不是 relay 客户端）
 * ⇒ 它不再是本项的取样点（⚠️ 旧口径下它也**从未**真正参与判定：永远落在"不在册"那一侧）。
 * ⚠️ 夹具模式：`--instance-fixture <实例端口=HTTP码>,…`（**按端口映射**）。⛔ **旧的位置式
 * `<本机码>,<对端码>` 已退役**（它本身就是"表内固定端口"的化身）⇒ 给了旧形态**直接报错退出**，
 * ⛔ 不静默按新口径解释（那会造出一个没人看得懂的 FAIL）。
 *
 * ## 🆕 `OBS-08` 的**空表可分**（序 ㊲：⛔ 不许把两种情形合成一个 FAIL）
 * 「47 中继视角端点表为空」有两个**完全不同**的成因，旧口径一律判 FAIL ⇒ 其中一个是**假红**：
 *
 *   ⓐ 该客户端**挂在另一台中继上**（实测：`--scene all` 演练把 106 worker 逼到 **106 自己的中继**
 *      ⇒ 47 视角 `ep=[] / used=1 / idOk=1`）⇒ **不是故障**（拓扑态）⇒ **SKIP ＋ 留痕**（点名对端中继原文）
 *   ⓑ **两台**中继都看不到它的客户端会话 ⇒ **确实没挂客户端** ⇒ **FAIL 并点名**
 *   ⓒ 对端中继**读不回来**（ssh / JSON 解析失败）⇒ **不可判** ⇒ FAIL 并点名（⛔ 不许静默当绿）
 *
 * 判别源 = **对端中继的 `/status`**（`ssh <SSH_TARGET_106> curl <RELAY_STATUS_URL>` —— **只读回环**、
 * ⛔ 零新增暴露面、⛔ 零新增参数键）。⚠️ **只在 47 视角为空时**才去读（正常态**零额外 ssh**）。
 * 夹具模式用 `--peer-status-fixture <对端 /status 原文>`；⛔ 不给 ⇒ 记"不可判（夹具模式）"。
 *
 * ## 🆕 观测面**并集**（序㊾：⛔ 单看 47 会把"合法拓扑态"判成红）
 * `OBS-01` / `OBS-08` / `OBS-09` 的绿**取决于 106 worker 挂在哪台中继** —— worker 通道按**抖动**换址
 * （`[relay-switch]`）⇒ 一旦落到 **106 自家中继**，47 视角就是
 * `used=1 / endpoints=[<host-b>:<PEER_AGENT_PORT> offline, <host-b>:<实例口> offline]` ⇒ `OBS-01` FAIL、`OBS-08` FAIL、
 * `OBS-09` SKIP —— 三条**全是假红 / 假 SKIP**（客户端好好的，只是"不在我这一台"）。
 *
 * 口径 = **按 `hostId`（含 `network`）合并两台中继的视图**：
 *
 *   eps  = merge(47.endpoints[], 106.endpoints[])   // 键 = `network:hostId:port`；`online` 取**或**；
 *                                                     `localPort` 取**在线那一侧**的（离线条目的落点已失效）
 *   used = |{ network/hostId | s ∈ 47.sessions[] ∪ 106.sessions[] }|  // ⛔ **不是求和** —— 同一节点在
 *          两台都残留会话/条目时求和会**重复计数**（那是另一方向的假绿）
 *   reg  = deriveInstanceEndpoints(eps, agentPorts)  // `OBS-09` 的派生改用并集（⛔ 判据本身一字不改）
 *
 * 🔴 **实例探活必须回到"那一台"上做**：`localPort` 是**中继机回环**落点 ⇒ 并集里来自 106 的端点
 * 得 ssh 到 106 探（47 上那个口**根本不存在**）⇒ 否则必然 `000` ⇒ **假红**。
 * 🔴 **只并这三项的数据源**：`OBS-11` 的 `derived`（= 47 自己的监听面）／`OBS-02`（47 自身容量自洽）／
 * `OBS-13`·`OBS-16`（47 的 `counters`）**一律保持 47 视角** —— 并集只消除"看不见"，
 * ⛔ 不放宽判据、⛔ 不改任何阈值（**真 FAIL 不许被糊成 PASS**）。
 * 🔴 **`OBS-16` 的 Δ 不受影响**：对端那份是**另算的一次独立采样**（读的是 106 的 `counters`）⇒
 * ⛔ 不进 `ΔstatusHits` 算式；且对 47 `/status` 的读取次数**一次都没变**（仍是三次，复用已采到的那份）。
 * ⚠️ 真机模式**无条件**读一次对端（⇒ 并集是**完整**的）；⛔ 不做"缺什么补什么"的按需读 ——
 * 那会留下一个**假绿**口子（106 上多一台 47 不知道的节点时，47 视角照样绿）。
 * ⚠️ 对端读不回来 ⇒ **不硬失败**，回落 47 视角并**强制留痕**「并集不可取证（…）⇒ 仅 47 视角」。
 *
 * ## 🆕 `OBS-16` 的**门窗口判据**（序㉑ · 在册缺陷 P-1 的验收）
 * `OBS-13` 的 `ΔstatusHits ≥ 1` 只证明"计数器没卡死"——它由**探针自己两次读**即满足，⛔ 证明不了
 * "订阅生效期间轮询停了"（旧判据下门 95% 时间开着、轮询照旧在跑，而 `OBS-13` **仍然全绿** ⇒
 * 实测降幅只有 1.10× 却长时间没人发现）。本项用**第三次采样**把窗口拉长到
 * `PRESENCE_GATE_WINDOW_MS`（≥ 若干倍 `RELAY_STATUS_POLL_MS`）：
 *
 *   窗口内命中增量 ≥ 1（探针自身那一次 = 活性证明）**且** ≤ `PRESENCE_GATE_HITS_MAX`（默认 1
 *   = 除探针外**零**命中）**且** `subs ≥ 1`（"没人拉"不是因为"没人订阅"）
 *
 * ⇒ 轮询还在跑（每周期一次）时窗口内会多出十余次命中 ⇒ **必红**；真停了 ⇒ 恒等 1 ⇒ 绿。
 * ⚠️ 这一项要求观察窗内**通道健康**（建立期/换址期会读 `/status` 的路径如 `waitUpOnStatus`）——
 * 窗口内真抖动导致它红，那是**真实信号**，⛔ 不许当噪声压掉。
 * ⚠️ 夹具模式**必须**显式给 `--status-fixture-3`：缺省 = 与第二份同一份 ⇒ Δ=0 ⇒ 活性证明不成立
 * ⇒ FAIL 并点名（**契约面**，⛔ 故意如此 —— 与 `OBS-09` 的 `--instance-fixture` 同规则）。
 *
 * ## 🧪 夹具模式（`--listen-fixture` / `--nft-fixture` / `--status-fixture` / `--instance-fixture` /
 *              `--peer-status-fixture`）
 * 判据改造**必须自带"旧判据会放过、新判据能抓住"的实证**。夹具就是那个实证手段：
 * 把远端原文喂进来 ⇒ **不 ssh**、零生产副作用；输出行首加 `⚠️ FIXTURE`（stderr 另标一次，
 * ⛔ 防止被下游当成生产结论）；此时非集合类指标记 `SKIP`（不参与退出码）。
 * ⛔ 夹具模式**必须**配 `--table <副本>`（避免误改生产参数表）。
 *
 * 🔴 **封闭性（序㊳ 起 · 硬约束）**：夹具模式下**任何**取数必须来自夹具；**缺该夹具的参数**
 * ⇒ 记 `SKIP ＋ 留痕（夹具模式未给 …）`，⛔ **绝不回落去 ssh 读生产**。
 * —— 起因：`OBS-24` / `OBS-25` 当初写成 `if (<夹具> !== undefined) { 读夹具 } else { ssh }`
 * （无 `fixture` 守卫）⇒ **只给 `--status-fixture`** 的一次夹具跑里，这两行其实是**生产读数**
 * （本线"夹具结论混生产数据"的静默污染面）。⇒ 两条路径的取数**不再共用同一个 else**：
 * `else if (fixture) { SKIP }` 必须排在 `else { ssh }` **之前**。
 * ⚠️ **新增任何"可 ssh 取数"的 OBS 时，必须照此顺序写**（否则就是同一个坑再踩一次）。
 * 🔑 **自检口径**：夹具跑里只要**出现任何一次 ssh**，就是本条约被破坏 —— 判据 = 夹具跑 stderr
 * **不含**远端读取痕迹（本线实测法：`ssh` 调用数 = 0；⛔ 别只看"输出有没有 ⚠️ FIXTURE"）。
 *
 * ## 运行前置
 * - **参数表从哪来**（🆕 序㊸：**与 cwd 解耦**）—— 未必非要在工作区根跑：
 *   候选目录链 = `--table`（显式文件）＞ `--dir` ＞ `DSH_AI1NET_OVERLAY_TABLE_DIR` ＞
 *   **机器本地注册文件**（`DSH_AI1NET_OVERLAY_TABLE_REGISTRY`，缺省 `~/.dsh_ai1net/overlay-table-dir`，一行一个目录）
 *   ＞ `cwd` ＞ 脚本自身目录及上两级。🔴 **"恰好 1 个才合法"保留且更严**：任一候选目录里 ≥2 份 ⇒ 报错；
 *   跨目录合计 ≥2 份 ⇒ 也报错（列出全部）。⛔ 一份都没找到 ⇒ 报错并列出**搜过的目录**，⛔ 不取缺省。
 * - 本机能 `ssh` 到中继机（走 `~/.ssh/config` 别名；⚠️ 别名里配的端口可能陈旧 ⇒ 一律用表里的 `SSH_PORT`）
 *
 * ## ⛔ 它不做什么
 * 不做 dashboard、不引外部监控依赖、不开新端口、不写任何远端文件。**纯只读**。
 *
 * @module scripts/overlay-probe
 */

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 参数表文件名（⛔ 不写死日期数字：用正则匹配，避免脚本里出现像阈值的常量）。 */
const TABLE_RE = /^参数表_覆盖网络_.+\.md$/
/** 参数行：`` | `KEY` | 值 | … ``（只取前两列）。 */
const KEY_RE = /^\|\s*`([A-Z0-9_]+)`\s*\|\s*([^|]*)\|/
/** 观测阈值行：`` | `OBS-NN` | 指标 | 阈值 | 判据 | ``（阈值一律按 KEY 解析）。 */
const OBS_RE = /^\|\s*`(OBS-[0-9]+)`\s*\|\s*([^|]*)\|/
/** 阈值里允许出现的"键引用"形态（`` `KEY` ``）。 */
const KEY_ONLY_RE = /^`([A-Z0-9_]+)`$/
/** 区间形态：`host:lo-hi`（也容错只给端口段的形态，以及 `~` / en-dash 作分隔符）。 */
const RANGE_HOST_RE = /^(.+):(\d+)\s*[-–~]\s*(\d+)$/
/** 区间形态（只给端口段，主机由 `RELAY_BIND` 补）。 */
const RANGE_BARE_RE = /^(\d+)\s*[-–~]\s*(\d+)$/
/** `ss` 数据行的首列（`-l` ⇒ 全部是它；据此跳过表头与噪声行）。 */
const SS_STATE = 'LISTEN'

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

/* ─────────── 参数表装载 ─────────── */

function argOf(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
}

/**
 * 🆕 **序㊸：参数表定位与 cwd 解耦**（与 `overlay-failover-drill.cjs` **同款**）。
 *
 * **起因（实测）**：原先只在 **cwd** 下按 `TABLE_RE` 找 ⇒ **从代码仓根跑就 `rc=2`**：
 * `❌ 参数表装载失败 … 找到 0 个参数表`。而参数表**不在仓内**
 * （本机实测 `git ls-files | grep -c 参数表` = **0**）—— 它在**工作区根**，与代码仓**不在同一路径树**
 * （本机甚至是两个盘：仓在 `D:`、工作区在 `E:`）⇒ 纯路径推算**永远到不了**。
 *
 * **处置 = 候选目录链**（⛔ 仓内**零机器路径**：机器差异全部落在 `$HOME` 的注册文件 / env 里）：
 * 1. `--table <file>`（**显式文件，最高优先，直接返回、不参与搜索**）
 * 2. `--dir <dir>`（显式目录）
 * 3. `DSH_AI1NET_OVERLAY_TABLE_DIR`（env 显式目录）
 * 4. **注册文件**的每一行（`DSH_AI1NET_OVERLAY_TABLE_REGISTRY`，缺省 `~/.dsh_ai1net/overlay-table-dir`；
 *    `#` 起注释；**机器本地、⛔ 不入库**）
 * 5. `cwd`（保持既有默认，⛔ 不破坏老用法）
 * 6. 脚本自身目录、其上一级、上两级（仓根 / `<install-dir>` 这类部署形态都覆盖）
 *
 * 🔴 **"恰好 1 个才算合法"这条防错保留、且更严**：
 * 任一候选目录里 ≥2 份 ⇒ **立即报错**；跨候选目录合计 ≥2 份 ⇒ **也报错**（列出全部命中）。
 * ⛔ **绝不放宽成"找不到就用缺省"** —— 一份都没找到 ⇒ 报错并列出**所有搜过的目录** ＋ 三条处置办法。
 */
function tableCandidateDirs(argv) {
  const registry = readTableRegistry()
  const out = []
  const push = (d) => {
    if (typeof d === 'string' && d.trim() !== '') out.push(path.resolve(d.trim()))
  }
  push(argOf(argv, '--dir'))
  push(process.env.DSH_AI1NET_OVERLAY_TABLE_DIR)
  for (const d of registry.dirs) push(d)
  push(process.cwd())
  push(__dirname)
  push(path.join(__dirname, '..'))
  push(path.join(__dirname, '..', '..'))
  const seen = new Set()
  const dirs = []
  for (const d of out) {
    if (seen.has(d)) continue
    seen.add(d)
    dirs.push(d)
  }
  return { dirs, registry }
}

/** 读**注册文件**（一行一个目录）。⛔ 读不到就返回**读取失败原因**（⛔ 不冒充"没有"）。 */
function readTableRegistry() {
  const envFile = process.env.DSH_AI1NET_OVERLAY_TABLE_REGISTRY
  const file =
    typeof envFile === 'string' && envFile.trim() !== ''
      ? envFile.trim()
      : path.join(os.homedir(), '.dsh_ai1net', 'overlay-table-dir')
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return { file, dirs: [], readError: (err && err.code) || String(err) }
  }
  const dirs = text
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l !== '')
  return { file, dirs, readError: null }
}

function resolveTablePath(argv) {
  const explicit = argOf(argv, '--table')
  if (explicit !== undefined) return explicit
  const { dirs, registry } = tableCandidateDirs(argv)
  const hits = []
  const scanned = []
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue
    let names
    try {
      names = fs.readdirSync(dir).filter((n) => TABLE_RE.test(n))
    } catch (err) {
      continue // 目录存在但读不了（权限等）⇒ 不算"扫过"，也不冒充"没有"
    }
    scanned.push(dir)
    if (names.length > 1) {
      throw new Error(
        `在 ${dir} 下按 /${TABLE_RE.source}/ 找到 ${names.length} 个参数表（要求恰好 1 个）：${names.join(' , ')}`,
      )
    }
    if (names.length === 1) hits.push(path.join(dir, names[0]))
  }
  if (hits.length === 0) {
    throw new Error(
      `在 ${scanned.length} 个候选目录下按 /${TABLE_RE.source}/ **一份都没找到**（要求恰好 1 个）\n` +
        `  搜过的目录：\n${scanned.map((d) => `    · ${d}`).join('\n')}\n` +
        `  注册文件：${registry.file}${registry.readError === null ? `（${registry.dirs.length} 条）` : `（读取失败：${registry.readError}）`}\n` +
        `  ⇒ 处置（三选一）：① \`--table <file>\` 直接指定 ② 把参数表所在目录（一行一个）写进上面的注册文件 ③ 在参数表所在目录下运行`,
    )
  }
  if (hits.length > 1) {
    throw new Error(
      `跨候选目录共找到 ${hits.length} 个参数表（要求恰好 1 个，⛔ 不猜哪一份是对的）：\n` +
        `${hits.map((h) => `    · ${h}`).join('\n')}`,
    )
  }
  return hits[0]
}

/** 值 → 去掉 markdown 的 `**` 与反引号。 */
function cleanValue(raw) {
  return String(raw).replace(/[*`]/g, '').trim()
}

function loadTable(file) {
  const text = fs.readFileSync(file, 'utf8')
  const params = new Map()
  const obs = new Map()
  for (const line of text.split(/\r?\n/)) {
    const o = OBS_RE.exec(line)
    if (o !== null) {
      obs.set(o[1], cleanValue(o[2]))
      continue
    }
    const k = KEY_RE.exec(line)
    if (k !== null && !params.has(k[1])) {
      // ⚠️ 先到先得：同一键在多处出现时以**第一处**（正表）为准，避免被"示例行"覆盖。
      params.set(k[1], cleanValue(k[2]))
    }
  }
  return { file, params, obs }
}

function makeReaders(table) {
  const bad = []
  /** 取**字符串**参数；缺失/空 ⇒ 记账（最后统一报错退出，⛔ 不静默兜底）。 */
  const need = (key) => {
    if (!table.params.has(key) || table.params.get(key) === '') {
      bad.push(key)
      return ''
    }
    return table.params.get(key)
  }
  /** 取**数值**参数：参数表里有的键名优先；否则按**字面量**（阈值表里可以直接写数）。 */
  const num = (keyOrRef) => {
    const m = KEY_ONLY_RE.exec(keyOrRef)
    let v
    if (m !== null) v = need(m[1])
    else if (table.params.has(keyOrRef)) v = need(keyOrRef)
    else v = String(keyOrRef).trim()
    const n = Number(v)
    if (v === '' || !Number.isFinite(n)) {
      bad.push(`${keyOrRef}=${JSON.stringify(v)} 不是数`)
      return Number.NaN
    }
    return n
  }
  return { need, num, bad }
}

/* ─────────── 集合判据的取值/解析 ─────────── */

/** 逗号分隔 → Set（去空、去首尾空白；⛔ 保持原文，报错要点名）。 */
function parseList(value) {
  return new Set(
    String(value)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
}

/**
 * 解析区间集合。`fallbackHost` 用于**只给端口段**的形态（如拨号池那个 `DIAL_POOL_BOUND`）。
 * 非法项**记账**而不是静默丢弃（丢项 = 白名单悄悄变窄 = 假红）。
 */
function parseRanges(value, fallbackHost, bad) {
  const out = []
  for (const item of String(value).split(',')) {
    const t = item.trim()
    if (t === '') continue
    const withHost = RANGE_HOST_RE.exec(t)
    if (withHost !== null) {
      out.push({ host: withHost[1], lo: Number(withHost[2]), hi: Number(withHost[3]) })
      continue
    }
    const bare = RANGE_BARE_RE.exec(t)
    if (bare !== null && fallbackHost !== undefined) {
      out.push({ host: fallbackHost, lo: Number(bare[1]), hi: Number(bare[2]) })
      continue
    }
    bad.push(`区间 ${JSON.stringify(t)} 形态不合法`)
  }
  return out
}

/** 单个 `host:port` 是否落在某个区间内。 */
function inRanges(addr, ranges) {
  const i = addr.lastIndexOf(':')
  if (i <= 0) return false
  const host = addr.slice(0, i)
  const port = Number(addr.slice(i + 1))
  if (!Number.isFinite(port)) return false
  return ranges.some((r) => r.host === host && port >= r.lo && port <= r.hi)
}

function decodeB64(raw) {
  if (raw === undefined || raw === '') return ''
  return Buffer.from(String(raw), 'base64').toString('utf8')
}

/**
 * `ss -lntp` 原文 → 监听集合（`host:port` 字符串，**逐条保留原文** ⇒ 报错能点名）。
 * ⚠️ 从**右侧**第一个 `:` 拆 host/port —— `[::]:22` 必须拆对（左侧 `indexOf` 会拆成 `[`）。
 */
function parseListenRaw(text) {
  const set = new Set()
  for (const line of String(text).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 4 || f[0] !== SS_STATE) continue
    const local = f[3]
    const i = local.lastIndexOf(':')
    if (i <= 0) continue
    set.add(`${local.slice(0, i)}:${local.slice(i + 1)}`)
  }
  return set
}

/** 从 `input` hook 可达的链（`family/table/chain`，含 `jump` 传递闭包）。 */
function inputReachableChains(items) {
  const keyOf = (o) => `${o.family}/${o.table}/${o.chain ?? o.name}`
  const reached = new Set()
  for (const it of items) {
    if (it.chain !== undefined && it.chain.hook === 'input') reached.add(keyOf(it.chain))
  }
  const rules = items.filter((it) => it.rule !== undefined).map((it) => it.rule)
  let grew = true
  while (grew) {
    grew = false
    for (const r of rules) {
      if (!reached.has(keyOf(r))) continue
      for (const e of r.expr ?? []) {
        const target = e.jump !== undefined ? e.jump.target : undefined
        if (typeof target !== 'string') continue
        const k = `${r.family}/${r.table}/${target}`
        if (!reached.has(k)) {
          reached.add(k)
          grew = true
        }
      }
    }
  }
  return reached
}

/** 把一条规则的表达式归一成 `<proto>:<dport>`（无端口匹配 ⇒ `<proto>:any`）。 */
function ruleToToken(expr) {
  let proto
  let port
  for (const e of expr ?? []) {
    const m = e.match
    if (m === undefined) continue
    const pl = m.left !== undefined ? m.left.payload : undefined
    if (pl === undefined || pl.field !== 'dport' || m.op !== '==') continue
    if (typeof pl.protocol === 'string') proto = pl.protocol
    const right = m.right
    if (typeof right === 'number') port = String(right)
    else if (right !== null && typeof right === 'object') {
      if (Array.isArray(right.range)) port = `${right.range[0]}-${right.range[1]}`
      else if (Array.isArray(right.set)) port = right.set.map((x) => `${x}`).join('+')
      else if (typeof right.prefix === 'object' && right.prefix !== null) port = String(right.prefix.addr)
    }
  }
  return `${proto ?? 'any'}:${port ?? 'any'}`
}

/** `nft -j` 原文 → 入站 accept 集合。失败返回 `null`（⛔ 由调用方显式标 `text-fallback`，不许静默改判据）。 */
function parseNftJsonRaw(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch {
    return null
  }
  const items = Array.isArray(doc.nftables) ? doc.nftables : null
  if (items === null) return null
  const reached = inputReachableChains(items)
  const out = new Set()
  for (const it of items) {
    const r = it.rule
    if (r === undefined) continue
    if (!reached.has(`${r.family}/${r.table}/${r.chain}`)) continue
    if (!(r.expr ?? []).some((e) => e.accept !== undefined)) continue
    out.add(ruleToToken(r.expr))
  }
  return out
}

/**
 * 退化路径：`nft list ruleset` 文本里抽 accept 行。
 * ⚠️ 必须**链感知** —— 否则 `FORWARD` 链上的 `accept`（docker 那几条）会被当成入站规则 ⇒ **假红**。
 * 做法：先按 `chain X {` / `}` 切出每链的规则行与是否 `hook input`，再沿 `jump` 取传递闭包
 * （⛔ 与 `-j` 路径同一判据，只是取数方式不同）。
 */
function parseNftTextRaw(text) {
  const chains = new Map()
  let cur
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    const open = /^chain\s+(\S+)\s*\{$/.exec(t)
    if (open !== null) {
      cur = open[1]
      if (!chains.has(cur)) chains.set(cur, { hooked: false, rules: [] })
      continue
    }
    if (t === '}' || t === '};') {
      cur = undefined
      continue
    }
    if (cur === undefined) continue
    const c = chains.get(cur)
    if (/\bhook\s+input\b/.test(t)) c.hooked = true
    // ⚠️ `policy accept;` **不算规则**（`accept` 后紧跟 `;` ⇒ 不构成"独立 token"）。
    if (/(^|\s)accept(\s|$)/.test(t)) c.rules.push(t)
  }
  const reached = new Set()
  for (const [name, c] of chains) if (c.hooked) reached.add(name)
  let grew = true
  while (grew) {
    grew = false
    for (const name of [...reached]) {
      for (const rule of chains.get(name).rules) {
        const j = /\bjump\s+(\S+)/.exec(rule)
        if (j !== null && !reached.has(j[1])) {
          reached.add(j[1])
          grew = true
        }
      }
    }
  }
  const protoRe = /\b(tcp|udp|icmp|icmpv6|ip|ip6)\b/
  const dportRe = /dport\s+(\d+)/
  const out = new Set()
  for (const name of reached) {
    for (const rule of chains.get(name).rules) {
      const head = rule.slice(0, rule.search(/(^|\s)accept(\s|$)/))
      const proto = protoRe.exec(head)
      const dport = dportRe.exec(head)
      out.add(`${proto === null ? 'any' : proto[1]}:${dport === null ? 'any' : dport[1]}`)
    }
  }
  return out
}

/* ─────────── 只读取数 ─────────── */

/**
 * 同步小睡 —— `main()` 是同步流程（不能 `await`），而 `OBS-13` 的"增量"判据必须**真的等一段**。
 * `Atomics.wait` 精确阻塞且不烧 CPU（⛔ 不用 busy-loop，也不另起子进程 `sleep`）。
 */
function sleepSync(ms) {
  if (!(ms > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** 一次 ssh：命令**作为单个 argv 元素**下发 ⇒ 远端 shell 解析引号，本地不过 shell。 */
function ssh(port, target, command, timeoutMs) {
  return execFileSync('ssh', ['-p', String(port), '-o', 'BatchMode=yes', target, command], {
    encoding: 'utf8',
    timeout: timeoutMs,
  }).trim()
}

/**
 * 一次 ssh 取回全部远端只读事实（⛔ 压 ssh 次数 = 压成本）。
 * 🆕 序⑫：`ss` / `nft` **回传原文**（`base64 -w0`），归一化在本地做 ——
 * 旧版只回 `wc -l` 的计数 ⇒ 判据只能比数字（假红/假绿的根源）。
 * ⚠️ `base64` 字母表无 `=`（除末尾填充）⇒ 与下面 `key=value` 的行解析兼容。
 *
 * 🆕 序㊲：**实例面码改为按"派生出来的端口"逐个取** —— 入参 `probePairs` 的每一项是
 * `{ port, localPort }`（`port` = 实例在 `/status.endpoints[]` 里声明的端口，`localPort` = 中继回环落点）。
 * 旧版写死两个面（`LOCAL_INSTANCE_PORT` 直连 ＋ `PEER_INSTANCE_PORT` 经 relay）⇒ **表值一漂就取错面**。
 * ⛔ 键名用 `port`（= 端点身份），⛔ 不用 `localPort`（那才是每次替换都在变的值）。
 * @param {{port:number, localPort:number}[]} probePairs 派生出来的实例端点（可能为空）
 */
function remoteFacts(r, sshPort, target, probePairs) {
  const host = r.need('RELAY_BIND')
  const codeLines = probePairs.map(
    (p) =>
      `echo "instcode_${p.port}=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 http://${host}:${p.localPort}/)"`,
  )
  const cmd = [
    `echo "listenRaw=$(ss -lntp 2>/dev/null | base64 -w0)"`,
    `echo "nftJsonRaw=$(nft -j list ruleset 2>/dev/null | base64 -w0)"`,
    `echo "nftTextRaw=$(nft list ruleset 2>/dev/null | base64 -w0)"`,
    ...codeLines,
    `echo "portal=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H 'Host: ${r.need('PORTAL_HOST_HEADER')}' ${r.need('PORTAL_URL')})"`,
    `echo "relayRss=$(ps -o rss= -p $(systemctl show -p MainPID --value dsh_ai1net-relay))"`,
  ].join('; ')
  const out = new Map()
  for (const line of ssh(sshPort, target, cmd, r.num('SSH_TIMEOUT_MS')).split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  return out
}

/**
 * 只取「实例面 HTTP 码」的一次 ssh（序㊾）。
 *
 * 为什么不能复用 `remoteFacts()`：并集里**属于对端中继**的端点，其回环落点**只在对端那台机上存在**
 * ⇒ 必须 ssh 到**那一台**探；而 `remoteFacts()` 顺带取的 `ss` / `nft` / 门户码 / relay RSS
 * **只对 47 有意义**（拉到 106 上会造出另一套"看起来有数据、其实判错对象"的读数）。
 * 键名与 `remoteFacts()` 一致（`instcode_<port>`）⇒ 调用方把两次结果并进同一个 map 即可。
 * ⛔ 返回值里**没有**该端口 = 取数失败 ⇒ 由判据 FAIL 并点名（⛔ 此处不兜底成 `000`）。
 * @param {{port:number, localPort:number}[]} pairs 归属**该中继**的在册实例端点
 */
function remoteInstanceCodes(r, sshPort, target, pairs) {
  const host = r.need('RELAY_BIND')
  const cmd = pairs
    .map(
      (p) =>
        `echo "instcode_${p.port}=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 http://${host}:${p.localPort}/)"`,
    )
    .join('; ')
  const out = new Map()
  for (const line of ssh(sshPort, target, cmd, r.num('SSH_TIMEOUT_MS')).split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i > 0) out.set(line.slice(0, i), line.slice(i + 1).trim())
  }
  return out
}

/**
 * 派生「在册实例端点」——**唯一来源 = relay 自身 `/status.endpoints[]`**。
 *
 * ⛔ **不许**拿表内固定端口去匹配（那些值会漂移：`findFreePortInRange` 上扫 ⇒ 替换时顺延）。
 * ⛔ 排除 `agentPorts`（agent 面是 worker 的隧道口，⛔ 不是"实例端点"）。
 * @param {any[]} eps `/status.endpoints[]`
 * @param {Set<number>} agentPorts agent 面端口集（配置常量）
 */
function deriveInstanceEndpoints(eps, agentPorts) {
  return (Array.isArray(eps) ? eps : []).filter(
    (e) => e !== null && typeof e === 'object' && e.online === true && !agentPorts.has(Number(e.port)),
  )
}

/**
 * 解析 `--instance-fixture`：**按端口的映射** `"21001=401,20000=200"`。
 * 🔴 旧的位置式 `<本机码>,<对端码>`（序 ⑳–㊱ 口径）**已退役** ⇒ 命中即**报错退出**：
 * 静默按新口径解释会造出一个"看不懂的 FAIL"，而静默按旧口径解释又会**只治输入不治判据**。
 * @returns {{map: Map<number, number>, error: string}}
 */
function parseInstanceFixture(value) {
  const map = new Map()
  for (const rawItem of String(value).split(',')) {
    const item = rawItem.trim()
    if (item === '') continue
    const m = /^(\d+)\s*=\s*(\d+)$/.exec(item)
    if (m === null) {
      return {
        map,
        error:
          `--instance-fixture 项 ${JSON.stringify(item)} 形态不合法。` +
          `序㊲ 起口径 = **按实例端口映射**（如 "--instance-fixture 21001=401"）；` +
          `⛔ 旧的位置式 "<本机码>,<对端码>" 已退役（判据不再依赖表内固定端口）`,
      }
    }
    map.set(Number(m[1]), Number(m[2]))
  }
  return { map, error: '' }
}

/**
 * 端点表**并集**（序㊾）—— 两台 relay **各自只看得见挂在自己身上的客户端** ⇒ 单看一台必然假红。
 *
 * 口径（三件事，缺一件就会造出另一类误判）：
 *   ① 键 = **`network:hostId:port`** —— 同一 `hostId` 在不同网络下是两条（relay 自己就按
 *      `network/hostId` 索引会话）；只按 `hostId:port` 去重会把两个网络**并成一条**。
 *   ② `online` 取**或** —— "在任何一台看来在线"就是在线（离线那侧只是**没挂在我这儿**）。
 *   ③ `localPort` 取**在线那一侧**的 —— 离线条目里的回环口是**已失效**的落点（拿它探活必得 `000`）。
 * `from` 记「这条最终采信谁的 `localPort`」⇒ 实例探活**必须回到那一台机器**上做（见调用点）。
 * ⛔ 本函数**只做合并**，⛔ 不判任何东西：判据仍由调用方按原阈值出 PASS/FAIL。
 * @param {any[]} list47 47 视角 `/status.endpoints[]`
 * @param {any[]} list106 对端中继 `/status.endpoints[]`（读不回来时传 `undefined`）
 * @returns {{ep:any, from:'47'|'106'}[]} 合并后的端点表（顺序：先 47 侧、后仅 106 有的）
 */
function mergeEndpoints(list47, list106) {
  const keyOf = (e) => `${e.network}:${e.hostId}:${e.port}`
  const byKey = new Map()
  const put = (e, from) => {
    if (e === null || typeof e !== 'object') return
    const key = keyOf(e)
    const cur = byKey.get(key)
    if (cur === undefined) {
      byKey.set(key, { ep: { ...e }, from })
      return
    }
    // 只在「新的一侧在线、已记的离线」时替换 ⇒ `localPort` 取自**在线那一侧**；同态时保留先来的（47 优先）。
    if (cur.ep.online !== true && e.online === true) byKey.set(key, { ep: { ...e }, from })
  }
  for (const e of Array.isArray(list47) ? list47 : []) put(e, '47')
  for (const e of Array.isArray(list106) ? list106 : []) put(e, '106')
  return [...byKey.values()]
}

/**
 * 在册节点数的**并集**（序㊾）：relay 的 `capacity.used` = **本机** `sessions.size`
 * ⇒ 单看一台会把挂在另一台上的节点**漏算**（`OBS-01` 假红）。
 *
 * 口径 = 按 **`network/hostId`** 去重后的**并集基数**。🔴 ⛔ **不是 `a.used + b.used`** ——
 * 同一节点在两台都残留会话时求和会**重复计数**（那是另一方向的**假绿**）。
 * ⚠️ 任一侧 `sessions[]` 不可用（对端读不回来 / 结构异常）⇒ 记 `exact=false` 并**回落**
 * 到 `max(各侧 capacity.used)`（= 退化成单侧口径，⛔ 不假装是并集）。
 * @returns {{used:number, exact:boolean}}
 */
function unionUsed(status47, status106) {
  const sides = [status47, status106]
  const keys = new Set()
  let complete = true
  for (const s of sides) {
    const ses = (s ?? {}).sessions
    if (!Array.isArray(ses)) {
      complete = false
      continue
    }
    for (const x of ses) if (x !== null && typeof x === 'object') keys.add(`${x.network}/${x.hostId}`)
  }
  if (complete) return { used: keys.size, exact: true }
  const nums = sides
    .map((s) => Number(((s ?? {}).capacity ?? {}).used))
    .filter((n) => Number.isFinite(n))
  return { used: nums.length === 0 ? Number.NaN : Math.max(...nums), exact: false }
}

function readFixture(file) {
  if (!fs.existsSync(file)) throw new Error(`夹具不存在：${file}`)
  return fs.readFileSync(file, 'utf8')
}

/* ─────────── 主流程 ─────────── */

function usage() {
  return (
    '用法：node scripts/overlay-probe.cjs [--table <参数表.md>] [--dir <目录>]\n' +
    '      🧪 夹具模式（⛔ 必须同时给 --table；不 ssh）：\n' +
    '         --listen-fixture <ss 原文> --nft-fixture <nft -j 原文> --status-fixture </status 原文>\n' +
    '         --status-fixture-2 <第二次 /status 原文>  ⬅️ 只有"增量"类判据（OBS-13）需要；缺省 = 与第一次同一份\n' +
    '         --status-fixture-3 <第三次 /status 原文>  ⬅️ 只有 OBS-16（门窗口）需要；缺省 = 与第二份同一份 ⇒ 会 FAIL 并点名\n' +
    '         --instance-fixture <实例端口=HTTP码>,…  ⬅️ 只有 OBS-09 需要（实例面 HTTP 码）\n' +
    '                              🔴 序㊲ 起口径 = **按端口映射**（如 "--instance-fixture 21001=401"）；\n' +
    '                              ⛔ 旧的位置式 "<本机码>,<对端码>" 已退役 ⇒ 给了**直接报错退出**；\n' +
    '                              ⛔ 派生端口缺码 ⇒ 在册仍判 ⇒ FAIL 并点名（契约面，⛔ 不静默放行）\n' +
    '         --peer-status-fixture <对端中继 /status 原文>  ⬅️ 🆕 序㊾：**观测面并集的对端那一半**\n' +
    '                              （OBS-01 / OBS-08 / OBS-09 的并集数据源 ＋ OBS-08「空表可分」的判别源；\n' +
    '                               缺省 ⇒ 记"并集不可取证（夹具模式未给 …）"＋ 仅按 47 视角判）\n' +
    '         --content-fixture <content 块 JSON>  ⬅️ 只有 OBS-17 需要（内容面判别器）；缺省 ⇒ 无 content 块 ⇒ FAIL 并点名\n' +
    // 序㉖：OBS-19（抖动块）/ OBS-20（容量余量）**不需要新参数** —— 数据源就是 `--status-fixture`／真机 `/status`。
    '      🆕 序㉖：OBS-19（`status.jitter` 结构＋口径）/ OBS-20（`capacity.utilPct < utilMaxPct`）复用上面的 /status 源\n' +
    // 序㉗：OBS-21（每连接候选数 ≥ 2）**每侧一个夹具** —— 两侧数据来自**不同主机**的 journalctl。
    '      🆕 序㉗：OBS-21（每连接候选数 ≥ 2）--candidates-fixture-47 <journalctl 原文> --candidates-fixture-106 <journalctl 原文>\n' +
    '                             （某侧缺夹具文件 ⇒ 该侧 SKIP；全缺 ⇒ OBS-21 整体 SKIP ⇒ ⛔ 夹具模式绝不去 ssh）\n' +
    // 序㉘→单A：OBS-22（退出路径不杀实例）**每侧一个夹具** —— 内容 = 该机部署产物里三处 teardown 的原文段。
    '      🆕 序㉘单A：OBS-22（退出路径不杀实例）--teardown-fixture-47 <grep 原文> --teardown-fixture-106 <grep 原文>\n' +
    '                             （某侧缺夹具文件 ⇒ 该侧 SKIP；全缺 ⇒ OBS-22 整体 SKIP ⇒ ⛔ 夹具模式绝不去 ssh）\n' +
    // 序㉘→单B：OBS-23（组密钥加密）—— 数据源 = `content.crypto` 块（真机从 /status 取；夹具用 --content-crypto-fixture）。
    '      🆕 序㉘单B：OBS-23（组密钥加密）--content-crypto-fixture <crypto 块 JSON>\n' +
    '                             （缺省 ⇒ 从 `--content-fixture` / 真机 `content.crypto` 取；两处都没有 ⇒ **SKIP ＋ 留痕**\n' +
    '                              = "缺省不启用"这一**合法状态**，⛔ 但绝不是"静默绿"）\n' +
    // 序㊱：OBS-24（网注册表＋派生自洽＋跨网零共享）—— 数据源 = 控制面的注册表 JSON。
    '      🆕 序㊱：OBS-24（网注册表与节点清单）--nodes-fixture <注册表 JSON>\n' +
    '                             （真机 = `cat <NODES_REGISTRY_FILE>`；**文件不存在 ⇒ SKIP ＋ 留痕**\n' +
    '                              = "还没开始用这套准入"这一**合法状态**，⛔ 但绝不是"静默绿"；\n' +
    '                              🔴 序㊳起：**夹具模式缺本夹具 ⇒ SKIP ＋ 留痕，⛔ 不去 ssh**）\n' +
    // 序㊱：OBS-25（join 入口＋具名失败＋一次性）—— 数据源 = admit CLI 的 selfcheck 读数。
    '      🆕 序㊱：OBS-25（一键加入自检）--join-fixture <selfcheck 读数 JSON>\n' +
    '                             （真机 = `cat <NODES_SELFCHECK_FILE>`；**文件不存在 ⇒ SKIP ＋ 留痕**；\n' +
    '                              🔴 序㊳起：**夹具模式缺本夹具 ⇒ SKIP ＋ 留痕，⛔ 不去 ssh**）\n' +
    // 序㊵（P2/S5）：OBS-26/27/28（直连开关 / 候选准入 / 打洞）—— 数据源 = 直连自检读数（**一份喂三条**）。
    '      🆕 序㊵：OBS-26（开关＋默认值＋提示）/ OBS-27（候选准入）/ OBS-28（打洞＋判死＋冷却）\n' +
    '              --direct-fixture <直连自检读数 JSON>\n' +
    '                             （producer = `node scripts/overlay-direct-probe.cjs selfcheck --json`；\n' +
    '                              真机 = `cat <DIRECT_SELFCHECK_FILE>`；**文件不存在 ⇒ 三条一起 SKIP ＋ 留痕**；\n' +
    '                              🔴 夹具模式缺本夹具 ⇒ SKIP ＋ 留痕，⛔ 不去 ssh（序㊳ 的封闭性纪律））\n' +
    // 序㊻：OBS-29（块 id 域分离 C）—— 数据源 = **本机进程内自检**（直取 lib）⇒ 无新参数、⛔ 零 ssh。
    '      🆕 序㊻：OBS-29（块 id per-network 域分离 C 真生效）**不需要新参数** —— 数据源 = 本机进程内自检\n' +
    '                             （正腿：跨网必不同且都非裸哈希 / 同网必相同；负腿：去 network 维度必红、取空必红）\n' +
    '                             ⚠️ 它判的是**实现与装配**；真机腿（content.blockIdKeyed ＋ 两机指纹一致）待部署后补\n'
  )
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(usage())
    return EXIT_OK
  }

  const listenFx = argOf(argv, '--listen-fixture')
  const nftFx = argOf(argv, '--nft-fixture')
  const statusFx = argOf(argv, '--status-fixture')
  const statusFx2 = argOf(argv, '--status-fixture-2')
  const statusFx3 = argOf(argv, '--status-fixture-3')
  const instFx = argOf(argv, '--instance-fixture')
  // 序㊲：对端中继 `/status` 原文（**只在 47 视角为空**时用得上 ⇒ 用于"空表可分"）。
  const peerStatusFx = argOf(argv, '--peer-status-fixture')
  const contentFx = argOf(argv, '--content-fixture')
  const candFx47 = argOf(argv, '--candidates-fixture-47')
  const candFx106 = argOf(argv, '--candidates-fixture-106')
  // 序㉘→单A（OBS-22）：每侧一份「该机部署产物里三处 teardown 的 grep 原文」。
  const teardownFx47 = argOf(argv, '--teardown-fixture-47')
  const teardownFx106 = argOf(argv, '--teardown-fixture-106')
  // 序㉘→单B（OBS-23）：`content.crypto` 块（十个判别器键）。
  const cryptoFx = argOf(argv, '--content-crypto-fixture')
  // 序㊱（OBS-24）：控制面**注册表** JSON（网 / 节点 / 状态）。
  const nodesFx = argOf(argv, '--nodes-fixture')
  // 序㊱（OBS-25）：`overlay-node-admit.cjs selfcheck` 的**机器可读读数**。
  const joinFx = argOf(argv, '--join-fixture')
  // 序㊵（OBS-26/27/28）：`overlay-direct-probe.cjs selfcheck` 的**机器可读读数**（一份喂三条判据）。
  const directFx = argOf(argv, '--direct-fixture')
  const fixture =
    listenFx !== undefined ||
    nftFx !== undefined ||
    statusFx !== undefined ||
    statusFx2 !== undefined ||
    statusFx3 !== undefined ||
    instFx !== undefined ||
    peerStatusFx !== undefined ||
    contentFx !== undefined ||
    candFx47 !== undefined ||
    candFx106 !== undefined ||
    teardownFx47 !== undefined ||
    teardownFx106 !== undefined ||
    cryptoFx !== undefined ||
    nodesFx !== undefined ||
    joinFx !== undefined ||
    directFx !== undefined
  if (fixture && argOf(argv, '--table') === undefined) {
    process.stderr.write('❌ 夹具模式必须配 --table <参数表副本>（避免误改生产参数表）\n')
    return EXIT_USAGE
  }

  let table
  try {
    table = loadTable(resolveTablePath(argv))
  } catch (err) {
    process.stderr.write(`❌ 参数表装载失败：${err.message}\n`)
    return EXIT_USAGE
  }
  const r = makeReaders(table)

  /**
   * agent 面端口集（序㊲）：⛔ **这是配置常量** —— 由两端 worker 单元固定，**不随「访问时自然替换」漂移**
   * （与实例端口不同：后者由 `findFreePortInRange` 上扫取口）。用于把 `/status.endpoints[]` 切成
   * 「agent 面」与「实例面」。
   * ⚠️ 在 `r.bad` 统一检查**之前**取（`need()`/`num()` 是惰性的：调用才记账 ⇒ 留到判据里再取会漏报缺键）。
   */
  const agentPorts = new Set([r.num('W47_AGENT_PORT'), r.num('PEER_AGENT_PORT')])
  /** 实例端口 → 实例面 HTTP 码（**按端口映射**）。夹具模式由 `--instance-fixture` 给；真机由 ssh 取。 */
  let codeByPort = new Map()

  let status
  /**
   * **第二次** `/status` 采样 —— 只有"增量"类判据要它（`OBS-13` 的稳态帧率 = 两次读数之差）。
   *
   * 为什么必须真的**隔一段时间再取一次**：「稳态 0 帧」在单快照里**不可判**（累计量只增不减），
   * 而"因为读不到所以看起来是 0"正是本线反复踩的那类**假绿** ⇒ 故配 `ΔstatusHits ≥ 1` 作活性证明。
   * ⛔ 夹具模式下不允许用"同一份读两次"冒充增量：那会让 `OBS-13` 恒绿 ⇒ 用 `--status-fixture-2` 显式给第二份。
   */
  let status2
  /**
   * **第三次** `/status` 采样 —— 只有 `OBS-16`（**门窗口**）要它，见文件头同名小节。
   * 窗口必须真的够长（≥ 若干倍轮询周期），否则"轮询还在跑"与"轮询停了"在计数上分不开。
   */
  let status3
  /**
   * ── 对端（106）中继 `/status` 的**唯一取数入口**（序㊾）──
   *
   * 两台中继**各自只看得见挂在自己身上的客户端** ⇒ `OBS-01` / `OBS-08` / `OBS-09` 必须看**并集**。
   * 这里取一次、缓存一次 ⇒ 下面的"并集"与 `OBS-08` 的"空表可分"**共用同一份**（⛔ 零重复 ssh）。
   *
   * - 真机：**一次 ssh** 取回 `/status` 原文 ＋ relay 单元活性（`__RELAY_ACTIVE__` 哨兵 —— 它把
   *   "中继未运行"与"读取失败"分开）。
   * - 夹具：`--peer-status-fixture`；⛔ 缺省 ⇒ **不 ssh**，记"并集不可取证"（⚠️ 秩序不可颠倒：
   *   `else if (fixture)` 必须排在 `else { ssh }` **之前**，否则夹具结论里会混进生产读数）。
   * @returns {{ok:boolean, status?:any, active?:string, why?:string}}
   */
  let peerView
  const readPeerView = () => {
    if (peerView !== undefined) return peerView
    const target106 = r.need('SSH_TARGET_106')
    const fail = (why) => {
      peerView = { ok: false, why }
      return peerView
    }
    let raw
    if (peerStatusFx !== undefined) {
      try {
        raw = readFixture(peerStatusFx)
      } catch (err) {
        return fail(`夹具读取失败（⛔ 与"确实没挂"可分）：${err.message}`)
      }
    } else if (fixture) {
      // ⛔ 夹具模式**绝不 ssh**（否则"夹具结论"里混进生产读数）。
      return fail('夹具模式未给 `--peer-status-fixture`（⛔ 不去 ssh）')
    } else {
      // 一次 ssh 取回**两件事**：`/status` 原文 ＋ relay 单元活性（后者用于把"未运行"与"读取失败"分开）。
      try {
        raw = ssh(
          r.num('SSH_PORT'),
          target106,
          `curl -s ${r.need('RELAY_STATUS_URL')}; echo "__RELAY_ACTIVE__=$(systemctl is-active ${r.need('RELAY_UNIT_NAME')} 2>/dev/null || true)"`,
          r.num('SSH_TIMEOUT_MS'),
        )
      } catch (err) {
        return fail(`对端中继（${target106}）ssh 读取失败（⛔ 与"确实没挂"可分）：${err.message}`)
      }
    }
    const marker = raw.lastIndexOf('__RELAY_ACTIVE__=')
    const active = marker >= 0 ? raw.slice(marker + '__RELAY_ACTIVE__='.length).trim() : 'unknown'
    const body = marker >= 0 ? raw.slice(0, marker) : raw
    try {
      peerView = { ok: true, status: JSON.parse(body), active }
      return peerView
    } catch (err) {
      return fail(
        active === 'active'
          ? `对端中继（${target106}）在运行但 /status 解析失败（⛔ 读取失败，与"确实没挂"可分）：${err.message}`
          : `对端中继（${target106}）未给出可解析的 /status 且单元 is-active=${active}：${err.message}`,
      )
    }
  }
  let facts
  if (fixture) {
    process.stderr.write('⚠️ FIXTURE 本次为**夹具模式**：未连接任何远端，结论不得当生产判据\n')
    const primaryFx = statusFx ?? statusFx2
    try {
      status = primaryFx === undefined ? { endpoints: [] } : JSON.parse(readFixture(primaryFx))
      // 第二份：缺省 = 与第一份同一份 ⇒ Δ=0；要造 FAIL 就显式给 `--status-fixture-2`。
      status2 = statusFx2 === undefined ? status : JSON.parse(readFixture(statusFx2))
      // 第三份（`OBS-16` 门窗口）：同规则 —— 缺省 = 与第二份同一份 ⇒ Δ=0 ⇒ 会 FAIL 并点名。
      status3 = statusFx3 === undefined ? status2 : JSON.parse(readFixture(statusFx3))
    } catch (err) {
      process.stderr.write(`❌ 夹具装载失败（/status）：${err.message}\n`)
      return EXIT_USAGE
    }
    facts = new Map()
    if (listenFx !== undefined) facts.set('listenRaw', Buffer.from(readFixture(listenFx), 'utf8').toString('base64'))
    if (nftFx !== undefined) facts.set('nftJsonRaw', Buffer.from(readFixture(nftFx), 'utf8').toString('base64'))
    // OBS-09：实例面码 —— **按端口映射**（`21001=401,…`）。夹具模式取不到远端 ⇒ 由调用方显式给。
    // 🔴 序㊲：旧的位置式 `<本机码>,<对端码>` 已退役 ⇒ 命中即报错退出（⛔ 不静默解释）。
    if (instFx !== undefined) {
      const parsed = parseInstanceFixture(instFx)
      if (parsed.error !== '') {
        process.stderr.write(`❌ ${parsed.error}\n`)
        return EXIT_USAGE
      }
      codeByPort = parsed.map
    }
  } else {
    const sshPort = r.num('SSH_PORT')
    const target = r.need('SSH_TARGET_47')
    // 取 `/status`（观测的**主数据源**）。独立一次 ssh：对端实例面在中继机上的回环落点口号**要靠它**。
    try {
      status = JSON.parse(ssh(sshPort, target, `curl -s ${r.need('RELAY_STATUS_URL')}`, r.num('SSH_TIMEOUT_MS')))
    } catch (err) {
      process.stderr.write(`❌ 取 /status 失败：${err.message}\n`)
      return EXIT_USAGE
    }
    // 第二次采样（间隔取自参数表 ⇒ ⛔ 脚本内无魔数）：只为 `OBS-13` 的"增量"判据。
    sleepSync(r.num('PRESENCE_SAMPLE_GAP_MS'))
    try {
      status2 = JSON.parse(ssh(sshPort, target, `curl -s ${r.need('RELAY_STATUS_URL')}`, r.num('SSH_TIMEOUT_MS')))
    } catch (err) {
      process.stderr.write(`❌ 第二次取 /status 失败：${err.message}\n`)
      return EXIT_USAGE
    }
    /**
     * 第三次采样（`OBS-16` 的**门窗口**，窗口长度取自参数表）：再读一次 `/status`，用
     * "窗口内**除本探针之外**没人读过它"判「订阅生效期间 `/status` 轮询真的停了」。
     * ⚠️ 这一睡是有意为之（窗口必须 ≥ 若干倍轮询周期，否则判据无分辨力）；它只加在**真机**路径上。
     */
    sleepSync(r.num('PRESENCE_GATE_WINDOW_MS'))
    try {
      status3 = JSON.parse(ssh(sshPort, target, `curl -s ${r.need('RELAY_STATUS_URL')}`, r.num('SSH_TIMEOUT_MS')))
    } catch (err) {
      process.stderr.write(`❌ 第三次取 /status 失败：${err.message}\n`)
      return EXIT_USAGE
    }
    /**
     * 🆕 序㊾：对端中继视图 —— **放在第三次采样之后**。
     * ⚠️ 位置的三个理由：① 它读的是 **106 的 `counters`**，⛔ 不进 `OBS-16` 的 `ΔstatusHits` 算式；
     * ② `OBS-16` 的门窗口 = `(status2, status3]`，这段里**只有 `sleepSync`** ⇒ ⛔ 不进窗口；
     * ③ 对 47 `/status` 的读取次数**一次都没变**（仍是三次，复用已采到的那份）。
     */
    const peerPre = readPeerView()
    // 序㊲ 的派生口径不变（仍在**并集**上做）：⛔ 不读表内固定端口 ⇒ 端口漂移不致假 SKIP。
    const merged = mergeEndpoints(status.endpoints, peerPre.ok ? peerPre.status.endpoints : undefined)
    /**
     * 🔴 实例探活**必须回到"那一台"上做**：`localPort` 是**中继机回环**落点 ⇒ 并集里归属 106 的端点，
     * 其落点**只存在于 106**（在 47 上探必然 `000` = **假红**）⇒ 按 `from` 分机。
     */
    const pairsOf = (from) =>
      deriveInstanceEndpoints(
        merged.filter((m) => m.from === from).map((m) => m.ep),
        agentPorts,
      ).map((e) => ({ port: Number(e.port), localPort: Number(e.localPort) }))
    const pairs47 = pairsOf('47')
    const pairs106 = pairsOf('106')
    try {
      facts = remoteFacts(r, sshPort, target, pairs47)
    } catch (err) {
      process.stderr.write(`❌ 远端只读取数失败：${err.message}\n`)
      return EXIT_USAGE
    }
    // ⚠️ 只在并集里**真有** 106 侧在册实例时才发这次 ssh（正常态 = 零额外取数）。
    // 取不回来 ⇒ **不硬失败**：该端口的码缺席 ⇒ `OBS-09` 判 FAIL 并点名（与 curl 得 `000` 同款）。
    if (pairs106.length > 0) {
      try {
        for (const [k, v] of remoteInstanceCodes(r, sshPort, r.need('SSH_TARGET_106'), pairs106)) facts.set(k, v)
      } catch (err) {
        process.stderr.write(`⚠️ 对端（106）实例面取数失败（码缺席 ⇒ OBS-09 会 FAIL 并点名）：${err.message}\n`)
      }
    }
    // 端口的码读不回来（curl 失败 ⇒ `000`）**不在这里兜底**：留给判据判 FAIL 并点名。
    codeByPort = new Map()
    for (const p of [...pairs47, ...pairs106]) {
      const v = Number(facts.get(`instcode_${p.port}`))
      if (Number.isFinite(v)) codeByPort.set(p.port, v)
    }
  }

  const counters = status.counters ?? {}
  const cap = status.capacity ?? {}
  /**
   * **47 视角**端点表 —— 🔴 它**仍然是** `OBS-11` 的 `derived`（= **47 自己的**监听面）与
   * `OBS-02`（47 自身容量的自洽性）的数据源 ⇒ ⛔ **不许**被下面的并集替换（并集只消除"看不见"）。
   */
  const eps = Array.isArray(status.endpoints) ? status.endpoints : []
  /**
   * 🆕 序㊾：`OBS-01` / `OBS-08` / `OBS-09` 的**并集**数据源（口径见文件头同名小节）。
   * ⛔ 只换数据源 —— 阈值、派生规则、判据形态**一字未动**（真 FAIL 不许被糊成 PASS）。
   */
  const peerViewNow = readPeerView()
  const epsUnion = mergeEndpoints(eps, peerViewNow.ok ? peerViewNow.status.endpoints : undefined).map((m) => m.ep)
  const usedUnion = unionUsed(status, peerViewNow.ok ? peerViewNow.status : undefined)
  /**
   * 并集不完整时**强制留痕**（⛔ 不静默降级）：对端读不回来 ⇒ 这三项退化成 47 视角（**可能假红**）。
   * ⚠️ 与之对照：`OBS-08` 的"空表可分"仍会按 §文件头把它判成 FAIL 并点名（⛔ 不静默当绿）。
   */
  const unionNote = peerViewNow.ok ? '' : ` ｜⚠️ 并集不可取证（${peerViewNow.why}）⇒ 本项仅按 47 视角判`

  const relayBind = r.need('RELAY_BIND')
  const required = parseList(r.need('LISTEN_REQUIRED'))
  const allowed = parseList(r.need('LISTEN_ALLOWED'))
  const ranges = parseRanges(r.need('LISTEN_ALLOWED_RANGES'), relayBind, r.bad)
  // 拨号池**不另立键**（⛔ 避免两处漂移）：复用既有 `DIAL_POOL_BOUND`，主机取 `RELAY_BIND`。
  ranges.push(...parseRanges(r.need('DIAL_POOL_BOUND'), relayBind, r.bad))
  const nftAllowed = parseList(r.need('NFT_ALLOW_INBOUND'))
  /**
   * `derived` 的**唯一来源** = relay 自身 `/status` 的端点回环落点（动态值 ⇒ ⛔ 不许写死进参数表）。
   * 🔴 序㊾：这里是 **47 视角**的 `eps`、⛔ **不是**并集 —— 它要回答的是「**47 这台机上**有哪些监听
   * 是合法派生出来的」；把 106 的落点并进来等于**凭空放宽** `OBS-11` 的"多出"判据。
   */
  const derived = new Set(eps.map((e) => `${relayBind}:${e.localPort}`))

  // 🆕 序㊱：两个新键**必须在 `r.bad` 检查之前**取出 —— `need()` 是**惰性**的（调用才记账），
  //    留到 `OBS-24`/`OBS-25` 里再取 ⇒ "参数表里没这个键"会被漏过（本线"静默放行"的同族病）。
  const nodesRegistryFile = r.need('NODES_REGISTRY_FILE')
  const nodesSelfcheckFile = r.need('NODES_SELFCHECK_FILE')
  // 🆕 序㊵（OBS-26/27/28）：直连自检读数落点 ＋ 五个阈值 —— 同样**必须在 `r.bad` 之前**取出。
  const directSelfcheckFile = r.need('DIRECT_SELFCHECK_FILE')
  const directHintMinParts = r.num('DIRECT_HINT_MIN_PARTS')
  const directCandAcceptMin = r.num('DIRECT_CAND_ACCEPT_MIN')
  const directCandRejectMin = r.num('DIRECT_CAND_REJECT_MIN')
  const directPunchMinOk = r.num('DIRECT_PUNCH_MIN_OK')
  const directCooldownMs = r.num('DIRECT_COOLDOWN_MS')

  if (r.bad.length > 0) {
    process.stderr.write(`❌ 参数表缺键／坏值：${r.bad.join(' , ')}\n`)
    return EXIT_USAGE
  }

  const codeSet = r.need('PROBE_CODE_SET').split(',').map((s) => Number(s.trim()))
  const rows = []
  /**
   * 夹具模式下非集合类指标无法取证 ⇒ 记 SKIP（⛔ 不参与退出码，否则"先红后绿"表达不出来）。
   * ⚠️ `judged = true` 的行**仍按真实判据出 PASS/FAIL** —— `OBS-11` 就是它，
   * 否则夹具模式恒绿 ⇒ 整个"假绿实证"就假了。
   */
  const add = (id, ok, text, judged = false, skip = false) =>
    rows.push(skip || (fixture && judged !== true) ? { id, ok: true, skip: true, text } : { id, ok, text })

  /**
   * ── 「**两台中继都**看不到该客户端」的**可分**（序㊲；详见文件头 `OBS-08` 同名小节）──
   *
   * 两个成因**必须分开**（旧口径一律 FAIL ⇒ 其中一个是**假红**）：
   *   ⓐ 客户端挂在**另一台中继**上（拓扑态，⛔ 非故障）⇒ `elsewhere`
   *   ⓑ 两台都看不到它的会话 ⇒ 确实没挂客户端 ⇒ `nowhere`
   *   ⓒ 对端中继读不回来 ⇒ 不可判 ⇒ `unknown`（⛔ 不许静默当绿）
   *
   * 🔴 判别源 = **对端中继自身 `/status`**（回环、只读）⇒ ⛔ 零新增暴露面、⛔ 零新增参数键。
   * 🆕 序㊾：这份取数已收敛到 `readPeerView()` **一处**（与并集共用同一份 ⇒ ⛔ 零重复 ssh）；
   * ⇒ 本分支现在只在「**并集也为空**」时才走到（单看 47 为空、其实挂在对端 ⇒ 已由并集直接判绿）。
   */
  let emptyView
  const classifyEmptyView = () => {
    if (emptyView !== undefined) return emptyView
    const target106 = r.need('SSH_TARGET_106')
    const unknown = (why) => {
      emptyView = { kind: 'unknown', trace: `对端中继（${target106}）**不可判**：${why}` }
      return emptyView
    }
    const pv = readPeerView()
    if (!pv.ok) return unknown(pv.why)
    const active = pv.active
    const peerStatus = pv.status
    const peerSessions = Array.isArray(peerStatus.sessions) ? peerStatus.sessions : []
    // 「有会话在声明端口」= 该客户端**确实挂在**对端中继上（agent 面也算 —— 它只说明"实例面还没声明"）。
    const attached = peerSessions.filter((s) => Array.isArray(s.ports) && s.ports.length > 0)
    if (attached.length > 0) {
      const detail = attached.map((s) => `${s.hostId} ports=${s.ports.join('/')}`).join(' ')
      emptyView = {
        kind: 'elsewhere',
        trace: `47 视角端点表为空，但**对端中继**（${target106}）声明了端口：${detail} ⇒ 客户端挂在**另一台中继**上（⛔ 非故障、⛔ 不判红）`,
      }
      return emptyView
    }
    if (active !== 'active') {
      emptyView = {
        kind: 'nowhere',
        trace: `对端中继（${target106}）单元 is-active=${active} ⇒ 客户端**不可能**挂在它上面，而 47 视角也没有它 ⇒ **该主机确实没挂客户端**`,
      }
      return emptyView
    }
    emptyView = {
      kind: 'nowhere',
      trace: `对端中继（${target106}）在运行但**没有任何会话在声明端口**，而 47 视角端点表也为空 ⇒ **该主机确实没挂客户端**`,
    }
    return emptyView
  }

  /**
   * ── `OBS-09`：**在册 ⇒ 必须可达**（序 ㊲ 口径修正 / 🆕 序㊾ 数据源换并集）──
   *
   * 两种模式**都要判** ⇒ 单独成函数，⛔ 不塞进 `!fixture` 分支（否则夹具模式证不了
   * "既能判 PASS 也能判 FAIL"）。`epsUnion` / `codeSet` / `add` 均已就绪。
   * 🔴 序㊾：派生改在**并集**上做（单看 47 ⇒ worker 挂到 106 自家中继时派生为空 ⇒ **假 SKIP**）；
   * ⛔ 判据本身（在线 + 非 agent 口 ⇒ 必须可达且码 ∈ 集合）**一字未动**。
   */
  const judgeObs09 = () => {
    // 「在册」= `/status.endpoints[]` 里 `online === true` 且 **非 agent 端口**的实例端点（⛔ 表值不参与）。
    const reg = deriveInstanceEndpoints(epsUnion, agentPorts)
    const agentOnly = epsUnion.filter((e) => e.online === true && agentPorts.has(Number(e.port))).length
    const offline = epsUnion.filter((e) => e.online !== true).length
    if (reg.length === 0) {
      add(
        'OBS-09',
        true,
        `在册实例面 无（从并集端点表派生为空：并集 ${epsUnion.length} 条 = agent ${agentOnly} 条 ＋ 离线 ${offline} 条）` +
          ` ⇒ SKIP ＋ 留痕｜${classifyEmptyView().trace}${unionNote}`,
        true,
        true,
      )
      return
    }
    const probes = reg.map((e) => {
      const port = Number(e.port)
      const code = codeByPort.get(port)
      return { hostId: e.hostId ?? '?', port, localPort: Number(e.localPort), code }
    })
    // ⛔ 派生端口**缺码**不许静默放行（夹具没给 ⇒ 契约面 FAIL 并点名；真机 curl 失败 ⇒ 码为 `000` ⇒ 也不在集合里）。
    const unknown = probes.filter((p) => !Number.isFinite(p.code))
    const bad = probes.filter((p) => Number.isFinite(p.code) && !codeSet.includes(p.code))
    const show = (p) => `${p.hostId}:${p.localPort}=${Number.isFinite(p.code) ? p.code : '?'}`
    add(
      'OBS-09',
      unknown.length === 0 && bad.length === 0,
      `在册实例面（并集派生 ${reg.length} 条）：${probes.map(show).join(' ')}` +
        ` (阈值 ∈ {${codeSet.join(',')}})` +
        `${bad.length > 0 ? ` ｜❌ ${bad.map(show).join(' ')}` : ''}` +
        `${unknown.length > 0 ? ` ｜❌ 缺码 ${unknown.map((p) => p.port).join(',')}（夹具未给该端口的码 / 真机取不到）` : ''}` +
        `${unionNote}`,
      true,
    )
  }

  /**
   * ── `OBS-08`：端点表全在线（序㊲ 加「**空表可分**」）──
   *
   * 🔴 序㊲：**空表不再一律判红** —— 旧口径会把「客户端挂在另一台中继」这个**合法拓扑态**判成
   * FAIL（假红）。分三种：挂在别处 ⇒ SKIP ＋ 留痕；确实没挂 ⇒ FAIL 并点名；不可判（对端中继读不回来）
   * ⇒ FAIL 并点名（⛔ 不许静默当绿）。分类逻辑见 `classifyEmptyView()`。
   * ⚠️ 数据源就是 `/status` ⇒ **两种模式都要判**（与 `OBS-09` 同规则：夹具模式也要能证"既可 PASS 也可 FAIL"）。
   */
  const judgeObs08 = () => {
    if (epsUnion.length === 0) {
      const cls = classifyEmptyView()
      if (cls.kind === 'elsewhere') {
        add('OBS-08', true, `并集端点表 0 条 ⇒ SKIP ＋ 留痕｜${cls.trace}`, true, true)
      } else {
        add(
          'OBS-08',
          false,
          `并集端点表 0 条 ⇒ FAIL（${cls.kind === 'nowhere' ? '两台中继都无该客户端会话' : '不可判'}）｜${cls.trace}`,
          true,
        )
      }
      return
    }
    add(
      'OBS-08',
      epsUnion.every((e) => e.online === true),
      `端点表(并集) ${epsUnion.length} 条 / 离线 ${epsUnion.filter((e) => e.online !== true).length} 条` +
        ` ｜并集: 47 视角 ${eps.length} 条 ＋ 对端 ${peerViewNow.ok ? (Array.isArray(peerViewNow.status.endpoints) ? peerViewNow.status.endpoints.length : 0) : '?'} 条 去重后 ${epsUnion.length} 条` +
        `${unionNote}`,
      true,
    )
  }

  if (!fixture) {
    add(
      'OBS-01',
      usedUnion.used >= r.num('MIN_HOSTS'),
      `在册节点 used=${usedUnion.used} (阈值 ≥ ${r.num('MIN_HOSTS')})` +
        ` ｜并集: 47 视角 used=${cap.used} ＋ 对端 used=${peerViewNow.ok ? ((peerViewNow.status.capacity ?? {}).used ?? '?') : '?'}` +
        `${usedUnion.exact ? ' ⇒ 按 network/hostId 去重后计' : ' ⇒ ⚠️ sessions[] 不全、回落 max(各侧 used)（⛔ 不假装是并集）'}` +
        `${unionNote}`,
    )
    add(
      'OBS-02',
      Number(cap.max) === r.num('RELAY_MAX_HOSTS') && Number(cap.free) === Number(cap.max) - Number(cap.used),
      `capacity max=${cap.max} used=${cap.used} free=${cap.free} (阈值 max=${r.num('RELAY_MAX_HOSTS')}, free=max-used)`,
    )
    add(
      'OBS-03',
      counters.identityRequired === true && Number(counters.trustedSigners) >= r.num('MIN_TRUSTED_SIGNERS'),
      `identityRequired=${counters.identityRequired} trustedSigners=${counters.trustedSigners} (阈值 ≥ ${r.num('MIN_TRUSTED_SIGNERS')})`,
    )
    add(
      'OBS-04',
      Number(counters.identityOk) >= r.num('MIN_IDENTITY_OK'),
      `identityOk=${counters.identityOk} (阈值 ≥ ${r.num('MIN_IDENTITY_OK')})`,
    )
    add(
      'OBS-05',
      Number(counters.revokedHosts) <= r.num('MAX_REVOKED_HOSTS'),
      `revokedHosts=${counters.revokedHosts} (阈值 ≤ ${r.num('MAX_REVOKED_HOSTS')})`,
    )
    const dialKeys = ['dial', 'dialDenied', 'dialFailed']
    add(
      'OBS-06',
      dialKeys.every((k) => typeof counters[k] === 'number'),
      `判别器 ${dialKeys.map((k) => `${k}=${counters[k]}`).join(' ')} (必须都是 number)`,
    )
    add(
      'OBS-07',
      Number(counters.authFailed) <= r.num('MAX_AUTH_FAILED'),
      `authFailed=${counters.authFailed} authed=${counters.authed} (阈值 ≤ ${r.num('MAX_AUTH_FAILED')})`,
    )
    judgeObs08()
    judgeObs09()
    add('OBS-10', Number(facts.get('portal')) === r.num('PORTAL_CODE'), `门户=${facts.get('portal')} (阈值 = ${r.num('PORTAL_CODE')})`)
  } else {
    for (const id of ['OBS-01', 'OBS-02', 'OBS-03', 'OBS-04', 'OBS-05', 'OBS-06', 'OBS-07']) {
      add(id, true, '夹具模式未取证')
    }
    // 🆕 序㊲：`OBS-08` 移出"夹具模式未取证"名单 —— 它的数据源就是 `/status`（夹具已提供）
    // ⇒ 两种模式都能按真实判据出 PASS/FAIL（否则「空表可分」这条**没法用夹具先红后绿**）。
    judgeObs08()
    judgeObs09()
    add('OBS-10', true, '夹具模式未取证')
  }

  /* ── OBS-11：**集合判据**（三集包含式 + nft 入站 accept 白名单） ── */
  // 夹具模式下 `facts.listenRaw` 亦由夹具文件编码而来 ⇒ 两条路径同一份解析逻辑（⛔ 不写两套）。
  const actual = parseListenRaw(decodeB64(facts.get('listenRaw')))
  const missing = [...required].filter((a) => !actual.has(a)).sort()
  // ⛔ 顺序：required → allowed → ranges → derived；只在**全不命中**时才进 `extra`。
  const extra = [...actual]
    .filter((a) => !required.has(a) && !allowed.has(a) && !inRanges(a, ranges) && !derived.has(a))
    .sort()

  let acceptSet = new Set()
  let nftNote = ' nft=none'
  const nftJsonText = nftFx !== undefined ? readFixture(nftFx) : decodeB64(facts.get('nftJsonRaw'))
  if (nftJsonText !== '') {
    acceptSet = parseNftJsonRaw(nftJsonText)
    nftNote = ''
    if (acceptSet === null) {
      // ⛔ 退化路径**必须显式标记**（不许静默改判据）：`-j` 不可用时才走文本解析。
      acceptSet = parseNftTextRaw(nftFx !== undefined ? nftJsonText : decodeB64(facts.get('nftTextRaw')))
      nftNote = ' nft=text-fallback'
    }
  } else if (!fixture) {
    process.stderr.write('❌ OBS-11 取不到 nft 规则集（`-j` 与文本两路都为空）\n')
    return EXIT_USAGE
  }
  const nftExtra = [...acceptSet].filter((t) => !nftAllowed.has(t)).sort()

  // relay 的"只绑回环"不变量 —— 🆕 序⑫ 改为**本地从监听集合算**（旧版是远端 `grep -c`：
  //  ① 它按"整行含该口号"计数 ⇒ 连 peer 列都算进去，会**高估**；② 夹具模式下取不到 ⇒ NaN ⇒ 假红。
  // 现在：按 Local 列**精确**取端口 ⇒ 顺带把"`RELAY_PORT` 只出现在 `RELAY_BIND` 上"这条判据变成严格版。
  const relayPort = r.need('RELAY_PORT')
  const portOf = (a) => a.slice(a.lastIndexOf(':') + 1)
  const relayListenTotal = [...actual].filter((a) => portOf(a) === relayPort).length
  const relayListenLoopback = [...actual].filter((a) => a === `${relayBind}:${relayPort}`).length
  const ok11 =
    missing.length === 0 &&
    extra.length === 0 &&
    nftExtra.length === 0 &&
    relayListenTotal === relayListenLoopback &&
    relayListenTotal > 0
  add(
    'OBS-11',
    ok11,
    `集合 必在 ${required.size} 允许 ${allowed.size} 区间 ${ranges.length} 派生 ${derived.size} 实际 ${actual.size} ` +
      `多出 ${extra.length} 缺失 ${missing.length} ｜nft accept ${acceptSet.size} 多出 ${nftExtra.length}` +
      `${nftNote} ｜relay 口绑定回环=${relayListenLoopback}/${relayListenTotal} 条`,
    true,
  )
  for (const a of missing) process.stderr.write(`OBS-11 缺失 ${a}\n`)
  for (const a of extra) process.stderr.write(`OBS-11 多出 ${a}\n`)
  for (const t of nftExtra) process.stderr.write(`OBS-11 nft 多出 ${t}\n`)

  if (!fixture) {
    add(
      'OBS-12',
      Number(facts.get('relayRss')) <= r.num('RELAY_RSS_MAX_KB'),
      `relay RSS=${facts.get('relayRss')}KB (阈值 ≤ ${r.num('RELAY_RSS_MAX_KB')}KB)`,
    )
  } else {
    add('OBS-12', true, '夹具模式未取证')
  }

  /* ── OBS-13/14/15：presence（序⑲）—— 判据**全在 `/status` 上** ⇒ 夹具模式也按真判据出 PASS/FAIL ── */
  // （⛔ 不是"夹具模式一律 SKIP"：那样"假绿实证"就假了，与本线纪律相悖。）

  const presence = Array.isArray(status.presence) ? status.presence : []
  const timing = status.presenceTiming ?? {}
  const sessions = Array.isArray(status.sessions) ? status.sessions : []
  const counters2 = (status2 ?? {}).counters ?? {}

  /**
   * 陈旧度 p95 —— **只统计 `devices > 0` 的条目**：处于 grace 窗口（`devices = 0` 但仍判在线）
   * 的条目**本来就允许陈旧**（D3 最终一致，5–15 s 陈旧是设计值，⛔ 不是缺陷）⇒ 计进来就是假红。
   */
  const staleAges = presence
    .filter((p) => Number(p.devices) > 0)
    .map((p) => Number(p.lastSeenAgoMs))
    .sort((a, b) => a - b)
  const p95 = staleAges.length === 0 ? 0 : staleAges[Math.max(0, Math.ceil(staleAges.length * 0.95) - 1)]

  const timingOk =
    Number(timing.graceMs) === r.num('PRESENCE_GRACE_MS') &&
    Number(timing.offlineDebounceMs) === r.num('PRESENCE_OFFLINE_DEBOUNCE_MS') &&
    Number(timing.batchMs) === r.num('PRESENCE_BATCH_MS') &&
    Number(timing.ttlMs) === r.num('PRESENCE_TTL_MS') &&
    Number(timing.subMax) === r.num('PRESENCE_SUB_MAX')
  const presenceCounters = ['subs', 'pushed', 'snaps', 'rejected', 'statusHits']
  const countersOk = presenceCounters.every((k) => typeof counters[k] === 'number')
  const dPushed = Number(counters2.pushed) - Number(counters.pushed)
  const dHits = Number(counters2.statusHits) - Number(counters.statusHits)
  add(
    'OBS-13',
    timingOk &&
      countersOk &&
      Number(counters.snaps) <= Number(counters.pushed) &&
      dPushed <= r.num('PRESENCE_STEADY_FRAMES_MAX') &&
      dHits >= r.num('PRESENCE_SAMPLE_HITS_MIN'),
    `稳态帧率 Δpushed=${dPushed} (阈值 ≤ ${r.num('PRESENCE_STEADY_FRAMES_MAX')})，` +
      `活性 ΔstatusHits=${dHits} (阈值 ≥ ${r.num('PRESENCE_SAMPLE_HITS_MIN')}) ｜口径=${timingOk ? '一致' : '❌漂移'} ` +
      `判别器=${countersOk ? '齐' : '❌缺'} subs=${counters.subs} pushed=${counters.pushed} snaps=${counters.snaps} ` +
      `rejected=${counters.rejected} statusHits=${counters.statusHits}`,
    true,
  )

  // E4：**有订阅者却一帧 `SNAP` 都没发过** ⇒ 首帧走的是"逐台拉"（N+1）那条老路。
  add(
    'OBS-14',
    countersOk && Number(counters.snaps) <= Number(counters.pushed) && (Number(counters.subs) === 0 || Number(counters.snaps) >= 1),
    `首帧即全量：snaps=${counters.snaps} pushed=${counters.pushed} subs=${counters.subs}（有订阅者 ⇒ snaps ≥ 1；⛔ N+1 会留 0）`,
    true,
  )

  /**
   * 在线态**表不撒谎**：仍在活跃的会话必须能被 `presence[]` 覆盖到（`online = true`）。
   * ⚠️ 只判 `lastSeenAgoMs ≤ PRESENCE_TTL_MS` 的那些 —— 超过 TTL 的半开会话正处于
   * 「TTL 安全网 vs 会话 idle 超时」的灰区（两者都按 45 s），⛔ 计进来就是假红。
   */
  const uncovered = sessions
    .filter((s) => Number(s.lastSeenAgoMs) <= r.num('PRESENCE_TTL_MS'))
    .filter((s) => {
      const p = presence.find((x) => x.name === s.name)
      return p === undefined || p.online !== true
    })
    .map((s) => s.name)
  add(
    'OBS-15',
    uncovered.length === 0 && (staleAges.length === 0 || p95 <= r.num('PRESENCE_STALE_P95_MAX_MS')),
    `在线态陈旧 p95=${p95}ms (阈值 ≤ ${r.num('PRESENCE_STALE_P95_MAX_MS')}ms，样本 ${staleAges.length} 条 devices>0)，` +
      `活跃会话未覆盖 ${uncovered.length} 条${uncovered.length > 0 ? `：${uncovered.join(',')}` : ''}`,
    true,
  )

  /**
   * ── `OBS-16`：**订阅生效期间 `/status` 轮询真的停了**（序㉑ · 在册缺陷 P-1 的验收）──
   *
   * 判据三件套（口径见文件头同名小节）：① 窗口内命中增量 ≥ 1（探针自身那一次 = **活性证明**，
   * 把"读不到"与"确实为 0"分开）② ≤ `PRESENCE_GATE_HITS_MAX`（多出来的每一次都算"别人还在拉"）
   * ③ `subs ≥ 1`（"没人拉"不得是因为"没人订阅"）。
   */
  const counters3 = (status3 ?? {}).counters ?? {}
  const counters3Ok = presenceCounters.every((k) => typeof counters3[k] === 'number')
  const dHitsGate = Number(counters3.statusHits) - Number(counters2.statusHits)
  add(
    'OBS-16',
    timingOk &&
      counters3Ok &&
      Number(counters3.subs) >= 1 &&
      dHitsGate >= 1 &&
      dHitsGate <= r.num('PRESENCE_GATE_HITS_MAX'),
    `门窗口 ΔstatusHits=${dHitsGate}（≥ 1 = 探针自身读数｜≤ ${r.num('PRESENCE_GATE_HITS_MAX')} = 除探针外**零**命中）` +
      `，窗口 ${r.num('PRESENCE_GATE_WINDOW_MS')}ms，期间 subs=${counters3.subs}` +
      // 🆕 序㊾：对端那份是**另算的独立采样**（读 106 的 counters），⛔ 不进本算式 —— 显式留痕，防日后误并。
      ` ｜Δ 口径 = **仅 47** 的 counters（对端 106 的采样另算一次、⛔ 不入 Δ；对 47 的读数次数仍为三次）` +
      `${counters3Ok ? '' : ' ❌ 判别器缺'}`,
    true,
  )

  /**
   * ── `OBS-17`：**内容寻址判别器齐全 ＋ 命中可断言**（序㉔ · 内容分发的验收）──
   *
   * 判据三件套（口径见参数表 §6 `OBS-17`）：
   * ① **判别器存在性**：`content.source` 五档、`content.peer` 五键、`content.store` 七键
   *    **全部**是 `number`。⛔ 缺一即 FAIL —— 这正是"静默放行"回头条件的机器判据
   *    （本线反复踩：「只写日志」的实现让脚本无法断言，判据却显示全绿）。
   * ② **口径一致**：`content.blockSize == CONTENT_BLOCK_SIZE` 且
   *    `content.storeMaxBytes == CONTENT_STORE_MAX_BYTES`（防"装配了但用的是另一套默认值"）。
   * ③ **活性**：`local + peer` 的**命中计数**（第一份读）`≥ CONTENT_TIER_HITS_MIN`。
   *    🔴 为什么必须有 ③：只判 ①（判别器存在）会让"装了但一次都没命中"**全绿** ——
   *    而那正好是 E1 失败（全是回源）的样子。
   *
   * ⚠️ 夹具模式：`--content-fixture <content 块 JSON>`；缺省（真机模式读不到 `content` 块）⇒ FAIL 并点名。
   */
  const contentBlock = (() => {
    if (contentFx !== undefined) {
      try {
        return JSON.parse(fs.readFileSync(contentFx, 'utf8'))
      } catch (err) {
        r.bad.push(`--content-fixture 解析失败：${err.message}`)
        return undefined
      }
    }
    // 真机模式：从第一份 `/status` 里取 `content` 块（缺 ⇒ FAIL 并点名）
    return (status ?? {}).content
  })()
  const SRC_TIERS_3 = ['local', 'peer', 'edge', 'region', 'origin']
  const PEER_KEYS_3 = ['peerHits', 'peerMisses', 'crossGroupDenied', 'declarations', 'withdrawn']
  const STORE_KEYS_3 = [
    'puts',
    'putRejected',
    'hits',
    'misses',
    'corruptReads',
    'evicted',
    'oversizeRejected',
  ]
  {
    const c = contentBlock
    const missing = []
    if (c === undefined || typeof c !== 'object') {
      missing.push('content 块缺失')
    } else {
      const src = c.source ?? {}
      const pr = c.peer ?? {}
      const st = c.store ?? {}
      for (const k of SRC_TIERS_3) if (typeof src[k] !== 'number') missing.push(`source.${k}`)
      for (const k of PEER_KEYS_3) if (typeof pr[k] !== 'number') missing.push(`peer.${k}`)
      for (const k of STORE_KEYS_3) if (typeof st[k] !== 'number') missing.push(`store.${k}`)
    }
    const shapeOk = missing.length === 0
    // ② 口径一致
    const blockSizeOk = shapeOk && Number(c.blockSize) === r.num('CONTENT_BLOCK_SIZE')
    const storeMaxOk = shapeOk && Number(c.storeMaxBytes) === r.num('CONTENT_STORE_MAX_BYTES')
    // ③ 活性：local + peer 命中
    const tierHits = shapeOk ? Number(c.source.local) + Number(c.source.peer) : 0
    const activeOk = tierHits >= r.num('CONTENT_TIER_HITS_MIN')
    add(
      'OBS-17',
      shapeOk && blockSizeOk && storeMaxOk && activeOk,
      `内容面判别器 ${shapeOk ? '齐全' : `❌ 缺 ${missing.join(',')}`}` +
        `｜口径 blockSize=${c?.blockSize}(阈值 ${r.num('CONTENT_BLOCK_SIZE')})` +
        ` storeMax=${c?.storeMaxBytes}(阈值 ${r.num('CONTENT_STORE_MAX_BYTES')})` +
        `｜活性 local+peer 命中=${tierHits}（阈值 ≥ ${r.num('CONTENT_TIER_HITS_MIN')}）`,
      true,
    )
  }

  /**
   * ── `OBS-18`：**「逐步拉起」的认领逻辑在册 ＋ 计数自洽**（序㉕ · 实例逐步拉起的验收）──
   *
   * 判据两件套（口径见参数表 §6 `OBS-18`）：
   * ① 🔴 **在册（强判据）**：`dsh_ai1net-worker` 的 journald 里存在 `[rehydrate]` 行。
   *    **换回旧行为（启动即 `cleanAllStaleScopes()`）⇒ 永远不打这行 ⇒ 必红。**
   *    这正是本序"把清空换成认领"的可机器断言面 —— ⛔ 只写代码不留计数/日志的改法在这里过不去。
   * ② **计数自洽**：最近一条 `[rehydrate] summary {...}` 的键齐全，且
   *    **`adopted + stopped === scanned`**（每条被扫到的 scope 都必须有处置结论 ——
   *    ⛔ 不许"扫到了但既不认领也不停"，那会让实例悬在两者之间）。
   *
   * ⚠️ **诚实标注**：本项**故意不**把"扫到几条"当判据 —— 认领发生在**进程启动时刻**，
   * 而探针是**事后**读 ⇒ 拿"当前 scope 数"去比一定假红（启动后才起的实例必然对不上）。
   * 故 `scanned/adopted/stopped` 只作**信息输出**，真机活性由 S6 的 E1/E3/E4 断言。
   *
   * ⚠️ 夹具模式：`--rehydrate-fixture <journalctl 原文>`；缺省 ⇒ **SKIP**（本项真机数据只能 ssh 取）。
   */
  {
    const rehydrateFx = argOf(argv, '--rehydrate-fixture')
    let text
    if (rehydrateFx !== undefined) {
      try {
        text = fs.readFileSync(rehydrateFx, 'utf8')
      } catch (err) {
        r.bad.push(`--rehydrate-fixture 读取失败：${err.message}`)
        text = ''
      }
    } else if (fixture) {
      text = undefined
    } else {
      try {
        text = ssh(
          // ⚠️ 必须**在块内重取**：`sshPort` 在外层块的词法作用域里，本块取不到
          r.num('SSH_PORT'),
          r.need('SSH_TARGET_106'),
          `journalctl -u dsh_ai1net-worker --no-pager -n 3000 2>/dev/null | grep -F "[rehydrate]" | tail -20`,
          r.num('SSH_TIMEOUT_MS'),
        )
      } catch (err) {
        r.bad.push(`106 journalctl 读取失败：${err.message}`)
        text = ''
      }
    }
    if (text === undefined) {
      add('OBS-18', true, '夹具模式未给 --rehydrate-fixture ⇒ SKIP（本项只能 ssh 取证）', false, true)
    } else {
      const lines = text.split(/\r?\n/).filter((l) => l.includes('[rehydrate]'))
      const summaryLine = [...lines].reverse().find((l) => l.includes('summary '))
      let sm
      if (summaryLine !== undefined) {
        const m = /\{[^\n]*\}\s*$/.exec(summaryLine.trim())
        if (m !== null) {
          try {
            sm = JSON.parse(m[0])
          } catch {
            sm = undefined
          }
        }
      }
      const keys = ['scanned', 'adopted', 'stopped', 'probeOk', 'probeFail', 'retained', 'notes']
      const missing = sm === undefined || typeof sm !== 'object' ? keys.slice() : keys.filter((k) => !(k in sm))
      const sumOk =
        sm !== undefined &&
        typeof sm === 'object' &&
        missing.length === 0 &&
        Number.isInteger(sm.scanned) &&
        Number.isInteger(sm.adopted) &&
        Number.isInteger(sm.stopped) &&
        sm.adopted + sm.stopped === sm.scanned
      add(
        'OBS-18',
        lines.length > 0 && sumOk,
        `认领日志行数=${lines.length}` +
          // 🔑 「读不到」与「确无该行」必须**可区分**（本线"静默放行"教训的机器判据）：
          //    0 行时把 journalctl 原文字节数一并打出 —— 0 字节 = 读取失败，>0 字节 = 真没有该行。
          (lines.length === 0 ? `（journalctl 原文 ${text.length} 字节）` : '') +
          (sm === undefined || typeof sm !== 'object'
            ? `｜❌ 无 summary（缺 ${missing.join(',')}）`
            : `｜summary scanned=${sm.scanned} adopted=${sm.adopted} stopped=${sm.stopped}` +
              ` probeOk=${sm.probeOk} probeFail=${sm.probeFail}` +
              (sumOk ? '' : `｜❌ 自洽不成立（缺 ${missing.join(',') || 'adopted+stopped=scanned'}）`)),
        true,
      )
    }
  }

  /**
   * ── `OBS-19`：**抖动观测块在册 ＋ 口径一致**（序㉖ · 骨干稳定选路的验收）──
   *
   * 判据三件套（口径见参数表 §6 `OBS-19`）：
   * ① **判别器齐全**：`/status.jitter` 的 `p95AbsDeltaMs` / `meanAbsDeltaMs` / `maxAbsDeltaMs` /
   *    `samples` / `deltas` / `sessions` / `thresholdMs` / `alerts` 必须**都是 `number`**，
   *    `overThreshold` 必须是 `boolean`，`hist` 必须是**数组**。
   *    ⛔ 缺一即 FAIL —— "没样本就少一个键"会让探针分不清「**没装**」与「**装了但还没采到**」
   *    （本线两处静默失效就是这么漏过去的）。
   * ② **口径一致**：`jitter.hist.length === JITTER_HIST_BUCKETS` 且
   *    `jitter.thresholdMs === JITTER_LIMIT_MS`（防"装了但用的是另一套默认值 / 另一个键"）。
   * ③ ① 本身即覆盖"**无样本也必须结构完整**"（`sessions === 0` 时上述键依然全在）。
   *
   * ⚠️ 夹具模式：数据源 = `--status-fixture` 里的 `jitter` 块（`judged=true` ⇒ 夹具模式照判）。
   */
  {
    const j = (status ?? {}).jitter
    const NUM_KEYS_19 = [
      'p95AbsDeltaMs',
      'meanAbsDeltaMs',
      'maxAbsDeltaMs',
      'samples',
      'deltas',
      'sessions',
      'thresholdMs',
      'alerts',
    ]
    const missing19 = []
    if (j === undefined || typeof j !== 'object') missing19.push('jitter 块缺失')
    else {
      for (const k of NUM_KEYS_19) if (typeof j[k] !== 'number') missing19.push(k)
      if (typeof j.overThreshold !== 'boolean') missing19.push('overThreshold')
      if (!Array.isArray(j.hist)) missing19.push('hist')
    }
    const shape19 = missing19.length === 0
    const buckets19 = shape19 && j.hist.length === r.num('JITTER_HIST_BUCKETS')
    const thr19 = shape19 && Number(j.thresholdMs) === r.num('JITTER_LIMIT_MS')
    add(
      'OBS-19',
      shape19 && buckets19 && thr19,
      `抖动块 ${shape19 ? '齐全' : `❌ 缺 ${missing19.join(',')}`}` +
        `｜p95|ΔRTT|=${j?.p95AbsDeltaMs} sessions=${j?.sessions} overThreshold=${j?.overThreshold} alerts=${j?.alerts}` +
        `｜口径 hist=${Array.isArray(j?.hist) ? j.hist.length : 'n/a'}(阈值 ${r.num('JITTER_HIST_BUCKETS')})` +
        ` thresholdMs=${j?.thresholdMs}(阈值 ${r.num('JITTER_LIMIT_MS')})`,
      true,
    )
  }

  /**
   * ── `OBS-20`：**容量余量仍在（⛔ 没打满）**（序㉖ · `E4` 的验收）──
   *
   * 判据两件套（口径见参数表 §6 `OBS-20`）：
   * ① `capacity.utilPct` / `capacity.utilMaxPct` 必须**都是 `number`**（⛔ 不许少键）；
   * ② **`utilPct < utilMaxPct`** ⇒ 新接入仍被接受（**余量 > 0**）。
   *    ⚠️ 方向是"**小于**"：`utilPct ≥ utilMaxPct` 说明**软门已在拦新节点** ⇒ 对"骨干应留
   *    30%+ 余量"的口径就是**不合格**（要扩容，⛔ 不是改判据凑绿）。
   */
  {
    const c20 = (status ?? {}).capacity
    const shape20 =
      c20 !== undefined && typeof c20 === 'object' && typeof c20.utilPct === 'number' && typeof c20.utilMaxPct === 'number'
    const utilPct20 = shape20 ? Number(c20.utilPct) : NaN
    const utilMax20 = shape20 ? Number(c20.utilMaxPct) : NaN
    const ok20 = shape20 && (utilMax20 <= 0 || utilPct20 < utilMax20)
    add(
      'OBS-20',
      ok20,
      shape20
        ? `容量 used=${c20.used} max=${c20.max}｜利用率 ${utilPct20}% < 软门 ${utilMax20}%` +
          `（余量 ${utilMax20 > 0 ? Math.round((utilMax20 - utilPct20) * 100) / 100 : '不限'} 个百分点）` +
          `｜软门拒接计数 utilRefused=${(status ?? {}).counters?.utilRefused ?? 'n/a'}` +
          (ok20 ? '' : '｜❌ 已打满软门（新接入被拒 ⇒ 余量不足）')
        : '❌ capacity.utilPct / utilMaxPct 缺失（⛔ 不许少键）',
      true,
    )
  }

  /**
   * ── `OBS-21`：**每连接候选数 ≥ 2**（序㉗ · E3「路径多样性」的验收）──
   *
   * 数据源 = **各连接路径自己的观测行**（`CAND_OBS_PREFIX`，由 `relay-tunnel.ts#RelayCandidateObservation`
   * 在**每次真实解析**时写、并按 `RELAY_CAND_OBS_MS` 周期重发上次快照）：
   * `[overlay-candidates] scope=… resolves=… count=… hosts=… source=… detail=… urls=…`
   *
   * 判据两件套（口径见参数表 §6 `OBS-21`）：
   * ① **该路径有观测行**（⛔ 缺行即 FAIL —— 并把 journalctl **原文字节数**一并打出：
   *    `0 字节` = 读取失败，`>0 字节` = 真没有该行。本线的"静默放行"教训要求两者**可区分**）；
   * ② **`count ≥ CAND_MIN`**（每连接候选数 ≥ 2）。
   *
   * 🔑 **`hosts`（主机名个数）只作信息输出、⛔ 不作判据** —— 且它**不是「独立物理路径数」**：
   * 观测器**不解析 DNS**（零网络），而生产目录前两条候选 `<base-domain>` 与 `relay-direct.<base-domain>`
   * **摘名不同、同落 47** ⇒ **真机实测 `count=3` 时 `hosts` 也报 3**，而机器级独立路径只有 **2**（47 ＋ 106）。
   * 故本项**照实判「条数」**，把 `hosts` 打出来供人判「冗余建成」，⛔ **不放宽判据凑绿**；
   * 真机首轮读数（2026-09-18 00:0x）已实证 **worker 侧 `count=1`**（根因见回报）。
   *
   * ⚠️ 夹具模式：`--candidates-fixture-47` / `--candidates-fixture-106`（journalctl 原文）；
   * 某侧缺夹具文件 ⇒ **该侧 SKIP**，全侧都缺 ⇒ 本项 SKIP（⛔ 不在夹具模式下去 ssh）。
   */
  {
    /** ⛔ 前缀**不在脚本里硬编码** —— 与阈值同一条纪律：参数表 = 探针的唯一取数来源。 */
    const CAND_OBS_PREFIX = r.need('CAND_OBS_PREFIX')
    const cmin = r.num('CAND_MIN')
    /** 每条连接路径 = 一个 relay 客户端单元；`CAND_OBS_UNITS_*` 的值格是 `unit=scope,unit=scope`。 */
    const targets = [
      { host: '47', units: r.need('CAND_OBS_UNITS_47'), fx: candFx47 },
      { host: '106', units: r.need('CAND_OBS_UNITS_106'), fx: candFx106 },
    ]
    const paths = []
    for (const t of targets) {
      for (const spec of t.units.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
        const eq = spec.indexOf('=')
        const unit = (eq < 0 ? spec : spec.slice(0, eq)).trim()
        const scope = (eq < 0 ? '' : spec.slice(eq + 1)).trim()
        paths.push({ label: `${unit}@${t.host}`, unit, scope, host: t.host, fx: t.fx })
      }
    }
    const seen = []
    let anyJudged = false
    let allOk = true
    for (const p of paths) {
      let text
      if (p.fx !== undefined) {
        try {
          text = fs.readFileSync(p.fx, 'utf8')
        } catch (err) {
          r.bad.push(`--candidates-fixture-${p.host} 读取失败：${err.message}`)
          text = ''
        }
      } else if (fixture) {
        seen.push(`${p.label} SKIP（夹具模式未给 --candidates-fixture-${p.host}）`)
        continue
      } else {
        try {
          text = ssh(
            r.num('SSH_PORT'),
            r.need(p.host === '47' ? 'SSH_TARGET_47' : 'SSH_TARGET_106'),
            `journalctl -u ${p.unit} --no-pager -n 3000 2>/dev/null | grep -F "${CAND_OBS_PREFIX}" | tail -5`,
            r.num('SSH_TIMEOUT_MS'),
          )
        } catch (err) {
          r.bad.push(`${p.label} journalctl 读取失败：${err.message}`)
          text = ''
        }
      }
      anyJudged = true
      const lines = text.split(/\r?\n/).filter((l) => l.includes(CAND_OBS_PREFIX))
      /**
       * ⚠️ **夹具模式下一份文件可能含多台/多个单元的混合行**（47 上就有 `manager` ＋ `worker` 两个
       * scope）⇒ 必须按 `scope=` 过滤；真机路径已用 `journalctl -u <unit>` 天然分单元，
       * 这里再过一遍 `scope` 是为了**核对接线**（⛔ 不一致即 FAIL —— 那是接线错，不是观测错）。
       */
      const mine = lines.filter((l) => {
        const m = /(?:^|\s)scope=([^\s]*)/.exec(l)
        return m !== null && m[1] === p.scope
      })
      const line = mine.length > 0 ? mine[mine.length - 1] : undefined
      if (line === undefined) {
        allOk = false
        // 🔑 「读不到」与「确无该行」必须可区分：0 字节 = 读取失败，>0 字节 = 真没有该行。
        seen.push(
          `${p.label} ❌ 无 scope=${p.scope} 的观测行（journalctl 原文 ${text.length} 字节` +
            `／含前缀的行 ${lines.length} 条）`,
        )
        continue
      }
      const grab = (k) => {
        const m = new RegExp(`(?:^|\\s)${k}=([^\\s]*)`).exec(line)
        return m === null ? undefined : m[1]
      }
      const count = Number(grab('count'))
      const hosts = Number(grab('hosts'))
      const shapeOk = Number.isInteger(count) && Number.isInteger(hosts) && count >= 0
      const ok = shapeOk && count >= cmin
      if (!ok) allOk = false
      seen.push(
        `${p.label} ` +
          (shapeOk
            ? `count=${count} hosts=${hosts}${ok ? ' ✓' : ` ❌（判据 ≥ ${cmin}）`}` +
              ` source=${grab('source')} urls=${grab('urls')}`
            : `❌ 观测行解析失败（${line.trim().slice(0, 160)}）`),
      )
    }
    add(
      'OBS-21',
      anyJudged && allOk,
      `每连接候选数（判据 ≥ ${cmin}）：${seen.join('｜')}` +
        (anyJudged ? '' : '｜❌ 全部路径 SKIP（未取到任何观测行）'),
      anyJudged,
      !anyJudged,
    )
  }

  /**
   * ── `OBS-22`：**退出路径不杀实例**（序㉘ → 单 A · 候选 `B` 的验收）──
   *
   * 序㉕ 查明：「Manager 重启后逐步拉起既有实例」的真凶 = `LocalSpawner.teardown()` 在 SIGTERM
   * 退出路径上**逐个停掉在册实例** ⇒ 启动认领 `rehydrateAdoptedScopes()` 永远扫不到存量。
   * 候选 `B` = 三处 `teardown()` 一起改：**退出进程不再停实例**。
   *
   * 判据两件套（口径见参数表 §6 `OBS-22`）：
   * ① **静态守卫（强判据 · 判别力在此）**：读**部署中的** `lib/supervisor/{orchestrator,
   *    remote-spawner,leased-spawner}.js` 里三处 `teardown()` 的函数体窗口，要求
   *    ⓐ 带守卫标记 `TEARDOWN_GUARD_MARKER`；ⓑ 窗口内**不出现** `TEARDOWN_FORBIDDEN_TOKENS` 任何一项。
   *    **旧产物 ⇒ 无标记 ＋ `orchestrator` 体里含 `stop(` ⇒ 必红**（= S4「真机先红」的可机器断言面）。
   *    🔑 判**部署产物**而不是 `src/`：`lib/` 才是真正在跑的那一份（本线已有"src 改了但没 build/没铺"的实证）。
   * ② **认领面（信息输出为主）**：该机 `TEARDOWN_UNIT_*` 的最近一条 `[rehydrate] summary` 若存在，
   *    要求键齐全且 **`adopted + stopped === scanned`**，且 **`scanned > 0 ⇒ adopted > 0`**
   *    （扫到存量却一条都没认领 ⇒ 被杀了）；**`scanned === 0` 只作信息输出、⛔ 不判红**。
   *
   * 🔴 **为什么 ② 里 `scanned > 0` 不能无条件当判据（本单的诚实口径，可推翻）**：
   *    `scanned === 0` 在日志上**有两种不可区分的成因** —— ⓐ 实例被退出路径杀了（旧行为的现场）
   *    ⓑ 启动时本来就没有存量实例（平台**正常空闲态**，两机实测 `0/0`）。
   *    把 `scanned > 0` 设成无条件判据 ⇒ 空闲态**永久红** ⇒ 判据灵敏度被磨掉（本线已明文反对
   *    "长期挂一条红项"）。⇒ 真正的判别交给 ①（不依赖有没有实例）；② 只在"确有 summary"时收紧。
   *    ⚠️ 故「重启前后 scope 数守恒」这条**在本探针里无法只读完成**（要守恒就得先重启生产）——
   *    它由执行棒 S5/S6 的**真机演练**举证（原文见设计说明 §8.7），⛔ 探针不冒充。
   *
   * ⚠️ 夹具模式：`--teardown-fixture-47` / `--teardown-fixture-106`（**grep 原文**）；
   * 某侧缺夹具文件 ⇒ **该侧 SKIP**，两侧都缺 ⇒ 本项 SKIP（⛔ 不在夹具模式下去 ssh）。
   * ② 在夹具模式复用 `--rehydrate-fixture`（与 `OBS-18` 同一个参数）。
   */
  {
    const MARKER = r.need('TEARDOWN_GUARD_MARKER')
    const TOKENS = r
      .need('TEARDOWN_FORBIDDEN_TOKENS')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    const FILES = ['orchestrator', 'remote-spawner', 'leased-spawner']
    const rehydrateFx = argOf(argv, '--rehydrate-fixture')
    const targets = [
      {
        host: '47',
        lib: r.need('TEARDOWN_LIB_47'),
        unit: r.need('TEARDOWN_UNIT_47'),
        fx: teardownFx47,
      },
      {
        host: '106',
        lib: r.need('TEARDOWN_LIB_106'),
        unit: r.need('TEARDOWN_UNIT_106'),
        fx: teardownFx106,
      },
    ]
    const seen = []
    let anyJudged = false
    let allOk = true
    for (const t of targets) {
      let lib
      if (t.fx !== undefined) {
        try {
          lib = fs.readFileSync(t.fx, 'utf8')
        } catch (err) {
          r.bad.push(`--teardown-fixture-${t.host} 读取失败：${err.message}`)
          lib = ''
        }
      } else if (fixture) {
        seen.push(`${t.host} SKIP（夹具模式未给 --teardown-fixture-${t.host}）`)
        continue
      } else {
        try {
          lib = ssh(
            r.num('SSH_PORT'),
            r.need(t.host === '47' ? 'SSH_TARGET_47' : 'SSH_TARGET_106'),
            FILES.map(
              (f) => `echo "## ${f}"; grep -A7 "async teardown" ${t.lib}/${f}.js 2>/dev/null | head -8`,
            ).join('; '),
            r.num('SSH_TIMEOUT_MS'),
          )
        } catch (err) {
          r.bad.push(`${t.host} 部署产物读取失败：${err.message}`)
          lib = ''
        }
      }
      anyJudged = true

      /* ① 静态守卫：逐文件取 `## <name>` 段，核对标记 ＋ 禁词 */
      const segments = new Map()
      {
        let cur
        for (const line of lib.split(/\r?\n/)) {
          const h = /^## (.+)$/.exec(line.trim())
          if (h !== null) {
            cur = h[1]
            segments.set(cur, [])
            continue
          }
          if (cur !== undefined) segments.get(cur).push(line)
        }
      }
      const offenders = []
      const noMarker = []
      for (const f of FILES) {
        const body = segments.get(f)
        if (body === undefined || body.join('').trim() === '') {
          offenders.push(`${f}:取不到 teardown 段`)
          continue
        }
        if (!body.join('\n').includes(MARKER)) noMarker.push(f)
        for (const line of body) {
          for (const tok of TOKENS) if (line.includes(tok)) offenders.push(`${f}「${line.trim().slice(0, 90)}」`)
        }
      }
      const staticOk = offenders.length === 0 && noMarker.length === 0
      if (!staticOk) allOk = false

      /* ② 认领面：有 summary 才收紧（`scanned === 0` 只作信息 —— 见上方 🔴 口径说明） */
      let text
      if (t.fx !== undefined) {
        if (rehydrateFx !== undefined) {
          try {
            text = fs.readFileSync(rehydrateFx, 'utf8')
          } catch (err) {
            r.bad.push(`--rehydrate-fixture 读取失败：${err.message}`)
            text = ''
          }
        }
      } else {
        try {
          text = ssh(
            r.num('SSH_PORT'),
            r.need(t.host === '47' ? 'SSH_TARGET_47' : 'SSH_TARGET_106'),
            `journalctl -u ${t.unit} --no-pager -n 3000 2>/dev/null | grep -F "[rehydrate]" | tail -20`,
            r.num('SSH_TIMEOUT_MS'),
          )
        } catch (err) {
          r.bad.push(`${t.host} rehydrate 日志读取失败：${err.message}`)
          text = ''
        }
      }
      let claim
      if (text === undefined) {
        claim = '认领面：未取到（夹具模式未给 --rehydrate-fixture）'
      } else {
        const lines = text.split(/\r?\n/).filter((l) => l.includes('[rehydrate]'))
        const summaryLine = [...lines].reverse().find((l) => l.includes('summary '))
        let sm
        if (summaryLine !== undefined) {
          const m = /\{[^\n]*\}\s*$/.exec(summaryLine.trim())
          if (m !== null) {
            try {
              sm = JSON.parse(m[0])
            } catch {
              sm = undefined
            }
          }
        }
        if (sm === undefined || typeof sm !== 'object') {
          // 🔑 「读不到」与「确无该行」可分：0 字节 = 读取失败，>0 字节 = 真没有该行。
          claim = `认领面：无 summary（journalctl 原文 ${text.length} 字节）⇒ 无存量可比、只报信息`
        } else {
          const keys = ['scanned', 'adopted', 'stopped', 'probeOk', 'probeFail', 'retained', 'notes']
          const missing = keys.filter((k) => !(k in sm))
          const selfOk =
            missing.length === 0 &&
            Number.isInteger(sm.scanned) &&
            Number.isInteger(sm.adopted) &&
            Number.isInteger(sm.stopped) &&
            sm.adopted + sm.stopped === sm.scanned
          const noKillOk = !(sm.scanned > 0 && sm.adopted === 0)
          const claimOk = selfOk && noKillOk
          if (!claimOk) allOk = false
          claim =
            `认领面：scanned=${sm.scanned} adopted=${sm.adopted} stopped=${sm.stopped}` +
            ` probeOk=${sm.probeOk}` +
            (sm.scanned === 0
              ? `（scanned=0 ⇒ 无存量可比、不判红）`
              : claimOk
                ? ' ✓'
                : `❌${selfOk ? '' : ` 自洽不成立（缺 ${missing.join(',') || 'adopted+stopped=scanned'}）`}` +
                  `${noKillOk ? '' : ' 扫到存量但一条未认领 ⇒ 疑似被退出路径杀掉'}`)
        }
      }

      seen.push(
        `${t.host} ` +
          (staticOk ? '静态守卫 ✓' : `❌${noMarker.length > 0 ? ` 缺标记(${noMarker.join(',')})` : ''}` +
            `${offenders.length > 0 ? ` 停实例命中 ${offenders.join(' / ')}` : ''}`) +
          `｜${claim}`,
      )
    }
    add(
      'OBS-22',
      anyJudged && allOk,
      `退出路径不杀实例（三处 teardown 静态守卫 ＋ 认领面自洽）：${seen.join('｜')}` +
        (anyJudged ? '' : '｜❌ 两侧全 SKIP（未取到任何 teardown 段）'),
      anyJudged,
      !anyJudged,
    )
  }

  /**
   * ── `OBS-23`：**组密钥加密已启用且"共享不退化、明文不出现"自证成立**（序㉘ · 单 B）──
   *
   * 判据三件套（口径见参数表 §6 `OBS-23` / §3.9）：
   * ① **判别器齐全**：`content.crypto` 的十个键**全部**是 `number`（⛔ 缺一即 FAIL ——
   *    这正是"静默放行"的机器判据）；🔴 **且**（真机）两台机上的密钥文件 `stat -c %a`
   *    必须 = `CONTENT_KEY_FILE_MODE`（**启用了加密却拿不到 `0600` 的密钥文件 ⇒ 判据面不自洽**）。
   * ② **F1 ＋ F2**：F1 = `detChecks ≥ CONTENT_CRYPTO_DET_MIN` 且 `detMismatches = 0`
   *    （同明文两次 ⇒ 密文逐字节相同）；F2 = `decrypts ≥ CONTENT_CRYPTO_DECRYPT_MIN` 且
   *    `decryptRejected = 0` 且 `source.local + source.peer ≥ CONTENT_TIER_HITS_MIN`
   *    （共享**没有**退化成"次次回源" —— 阈值与 `OBS-17` ③ **同源**，⛔ 不另立一套）。
   * ③ **F4①：明文不出现**：`plainScans ≥ CONTENT_CRYPTO_SCAN_MIN` 且 `plainLeaks = 0`
   *    （对**自己刚加密出的字节**做字节级扫描 —— 命中即 FAIL）。
   *
   * 🔴 **`decryptRejected` 的方向**：稳态必须 **= 0**。它一旦增长，说明有节点密钥 / epoch 不一致
   * （单 B §9-6 的回头条件）⇒ ⛔ 不许"重启一次看看"、⛔ 不许放宽判据。
   *
   * ⚠️ **"缺省不启用" = SKIP ＋ 留痕**（合法状态），⛔ 但**不许**既不是 SKIP 也不是 FAIL 的"静默绿"。
   * ⚠️ 夹具模式：`--content-crypto-fixture <crypto 块 JSON>`；缺省 ⇒ 从 `--content-fixture` 里的
   * `crypto` 子块取；再没有 ⇒ SKIP。⛔ **夹具模式绝不去 ssh**（与 `OBS-21` / `OBS-22` 同纪律）。
   */
  {
    const CRYPTO_NUM_KEYS = [
      'encrypts',
      'decrypts',
      'decryptRejected',
      'epochs',
      'epoch',
      'epochExpired',
      'detChecks',
      'detMismatches',
      'plainScans',
      'plainLeaks',
    ]
    let cryptoBlock
    if (cryptoFx !== undefined) {
      try {
        cryptoBlock = JSON.parse(fs.readFileSync(cryptoFx, 'utf8'))
      } catch (err) {
        r.bad.push(`--content-crypto-fixture 解析失败：${err.message}`)
        cryptoBlock = undefined
      }
    } else if (contentBlock !== undefined && typeof contentBlock === 'object') {
      cryptoBlock = contentBlock.crypto
    }
    if (cryptoBlock === undefined || typeof cryptoBlock !== 'object') {
      add('OBS-23', false, '⛔ 未启用组密钥加密（content.crypto 块缺席）⇒ SKIP ＋ 留痕（缺省不启用是合法状态，⛔ 非静默绿）', false, true)
    } else {
      const missing = CRYPTO_NUM_KEYS.filter((k) => typeof cryptoBlock[k] !== 'number')
      const shapeOk = missing.length === 0
      // ①-b（真机）：密钥文件必须存在且权限 = 期望值
      // 🔴 门 = `!fixture`（⛔ **不是** `cryptoFx === undefined`）—— 夹具模式**绝不去 ssh**，
      //    这是 `OBS-21` / `OBS-22` 同款纪律；用 `cryptoFx` 当门会让"给了 `--content-fixture`
      //    但没给 `--content-crypto-fixture`"这条路径**偷偷 ssh** 到生产机（契约面不一致）。
      let modeClaim = '密钥文件权限：夹具模式不查'
      let modeOk = true
      if (!fixture) {
        const want = r.num('CONTENT_KEY_FILE_MODE')
        const file = r.need('CONTENT_KEY_FILE')
        const seenMode = []
        for (const host of ['47', '106']) {
          try {
            const out = ssh(
              r.num('SSH_PORT'),
              r.need(host === '47' ? 'SSH_TARGET_47' : 'SSH_TARGET_106'),
              `stat -c %a ${file} 2>/dev/null`,
              r.num('SSH_TIMEOUT_MS'),
            )
            const mode = String(out ?? '').trim()
            seenMode.push(`${host}=${mode === '' ? '（原文字节 0 ⇒ 读不到 / 无该文件）' : mode}`)
            if (mode !== String(want)) modeOk = false
          } catch (err) {
            seenMode.push(`${host}=❌读取失败(${err.message})`)
            modeOk = false
          }
        }
        modeClaim = `密钥文件 ${file} 权限须=${want}：${seenMode.join(' ')}`
      }
      const detMin = r.num('CONTENT_CRYPTO_DET_MIN')
      const decMin = r.num('CONTENT_CRYPTO_DECRYPT_MIN')
      const scanMin = r.num('CONTENT_CRYPTO_SCAN_MIN')
      // ② F1 ＋ F2（F2 的阈值与 OBS-17 ③ 同源）
      const detOk = Number(cryptoBlock.detChecks) >= detMin && Number(cryptoBlock.detMismatches) === 0
      const tierHits = Number(contentBlock?.source?.local ?? 0) + Number(contentBlock?.source?.peer ?? 0)
      const shareOk =
        Number(cryptoBlock.decrypts) >= decMin &&
        Number(cryptoBlock.decryptRejected) === 0 &&
        tierHits >= r.num('CONTENT_TIER_HITS_MIN')
      // ③ F4①（明文不出现）
      const plainOk = Number(cryptoBlock.plainScans) >= scanMin && Number(cryptoBlock.plainLeaks) === 0
      const ok = shapeOk && modeOk && detOk && shareOk && plainOk
      add(
        'OBS-23',
        ok,
        `组密钥加密（GCM 确定性）判别器 ${shapeOk ? '齐全' : `❌ 缺 ${missing.join(',')}`}` +
          `｜F1 确定性 detChecks=${cryptoBlock.detChecks}(阈值 ≥ ${detMin}) detMismatches=${cryptoBlock.detMismatches}（须 0）` +
          `｜F2 共享 decrypts=${cryptoBlock.decrypts}(阈值 ≥ ${decMin}) decryptRejected=${cryptoBlock.decryptRejected}（须 0）` +
          ` local+peer 命中=${tierHits}（阈值 ≥ ${r.num('CONTENT_TIER_HITS_MIN')}）` +
          `｜F4① 明文扫描 plainScans=${cryptoBlock.plainScans}(阈值 ≥ ${scanMin}) plainLeaks=${cryptoBlock.plainLeaks}（须 0）` +
          `｜epoch=${cryptoBlock.epoch}/${cryptoBlock.epochs} epochExpired=${cryptoBlock.epochExpired}` +
          `｜${modeClaim}`,
        true,
      )
    }
  }

  /**
   * ── `OBS-24`：**网注册表与节点清单在册 ＋ 白名单派生自洽 ＋ 跨网零共享**（序㊱ · S1/S4）──
   *
   * 判据五件套（口径见参数表 §6 `OBS-24`）：
   * ① **结构完整**：`version` = `NODES_REGISTRY_VERSION`、`nodes` 是对象、每条记录的
   *    `status ∈ {pending,approved}`、`nodeKey` 是 64 hex（⛔ 缺一即 FAIL —— "没装"与
   *    "装了但字段少了"必须可分）。
   * ② **派生自洽**：对**每张网**，`approved` 集合 ≡ 派生出的白名单集合（差集**逐条点名**）。
   * ③ **`pending` 不进派生**：待批节点出现在派生里 ⇒ FAIL（"**收单 ≠ 批准**"的可断言面）。
   * ④ **结构性错桶 = 0**：`auditDerivation.misfiled` 空 —— 派生桶里的 `hostId` 必须**属于该桶那张网**。
   *    🔑 这是 **`J5`（独立网零共享）** 的真正机器判据：条目带网络 ⇒ 不可能跨网共享；
   *    一旦有人"扁平化 / 合并成一张网"，就会以**错桶**或 ⑤ 的形态被抓到。
   * ⑤ **桶数 ≡ 有 `approved` 的网数**（⛔ 不许把多张网**合并成一张网** —— 合并 = `independent`
   *    这张网从此与 `ops` 共享拨号面，正是"独立覆盖网络"要排除的形态）。
   *
   * ⚠️ **刻意不判的一条（写在这里防下一棒再吵）**：**同一个 `hostId` 出现在两张网**是
   * **合法状态**（用户设备名由客户端取 ⇒ 跨用户撞名是常态；the regression suite 的
   * `D1` 已把它钉成"两张网各自独立、互不影响"）。⇒ 探针只把它当**信息**打印，⛔ **不作判据**
   * —— 拿它当红项就是把一个正当状态判成故障（"判据打在自己的正确行为上"）。
   *
   * ⚠️ **数据源缺省 ⇒ SKIP ＋ 留痕**（不是 FAIL）：注册表**不存在** = "这套准入还没开始用"
   * 这一**合法状态**（与 `OBS-23` 的"缺省不启用"同纪律）。但**读取失败**（ssh 报错 /
   * 文件存在却解析不了）⇒ **FAIL 并点名** —— 两者必须可分。
   */
  {
    let raw24
    let absent24 = false
    let skip24 = ''
    let err24 = ''
    if (nodesFx !== undefined) {
      try {
        raw24 = readFixture(nodesFx)
      } catch (err) {
        err24 = err.message
      }
    } else if (fixture) {
      // 🔴 **序㊳：夹具模式一律 SKIP**（⛔ 绝不 ssh）—— 见文件头「夹具模式」小节。
      skip24 = '夹具模式未给 `--nodes-fixture` ⇒ SKIP ＋ 留痕（⛔ 不去 ssh 读生产）'
    } else {
      try {
        const out = ssh(
          r.num('SSH_PORT'),
          r.need('SSH_TARGET_47'),
          `if [ -f ${nodesRegistryFile} ]; then cat ${nodesRegistryFile}; else echo __NOFILE__; fi`,
          r.num('SSH_TIMEOUT_MS'),
        )
        if (out.trim() === '__NOFILE__') absent24 = true
        else raw24 = out
      } catch (err) {
        err24 = err.message
      }
    }
    if (err24 !== '') {
      add('OBS-24', false, `❌ 注册表**读取失败**（⛔ 与"不存在"可分）：${err24}`, true)
    } else if (skip24 !== '') {
      add('OBS-24', false, skip24, false, true)
    } else if (absent24) {
      add('OBS-24', false, `注册表 ${nodesRegistryFile} 不存在 ⇒ SKIP ＋ 留痕（"这套准入还没开始用"是合法状态，⛔ 不是静默绿）`, false, true)
    } else {
      let reg
      try {
        reg = JSON.parse(raw24)
      } catch (err) {
        reg = undefined
        err24 = err.message
      }
      let reglib
      let libErr = ''
      try {
        // 🔴 **判据复用真实实现**（⛔ 不许在探针里另写一份派生逻辑 —— 那是"同一事实两处写"的病根）。
        reglib = require('../lib/net/relay/registry.js')
      } catch (err) {
        libErr = err.message
      }
      if (reg === undefined || libErr !== '') {
        add('OBS-24', false, `❌ 注册表不可判：${err24 || `产物缺失 ${libErr}`}`, true)
      } else {
        const parsed = reglib.parseRegistry(reg)
        const shapeOk = parsed !== undefined
        const audit = parsed === undefined ? { ok: false, mismatches: ['注册表形状非法'], misfiled: [] } : reglib.auditDerivation(parsed)
        const derivedMap = parsed === undefined ? new Map() : reglib.deriveDialers(parsed)
        // ③ `pending` 不进派生
        const pendingInDerived = []
        if (parsed !== undefined) {
          for (const rec of Object.values(parsed.nodes)) {
            if (rec.status === 'pending' && (derivedMap.get(rec.network) ?? new Set()).has(rec.hostId)) {
              pendingInDerived.push(`${rec.network}/${rec.hostId}`)
            }
          }
        }
        // ④ 结构性错桶（`misfiled`）＋ ⑤ 桶数 ≡ 有 approved 的网数
        const netsWithApproved =
          parsed === undefined
            ? 0
            : new Set(Object.values(parsed.nodes).filter((r2) => r2.status === 'approved').map((r2) => r2.network)).size
        const bucketMismatch = derivedMap.size !== netsWithApproved
        // ⚠️ **信息项**（⛔ 非判据）：同名跨网 —— 同一 hostId 落在 ≥2 张网的 approved 集合里。
        //    这是**合法**状态（客户端自取设备名会撞名；the regression suite` 已钉死）。
        const approvedByNetwork = new Map()
        if (parsed !== undefined) {
          for (const rec of Object.values(parsed.nodes)) {
            if (rec.status !== 'approved') continue
            const set = approvedByNetwork.get(rec.network) ?? new Set()
            set.add(rec.hostId)
            approvedByNetwork.set(rec.network, set)
          }
        }
        const nameSeen = new Map()
        const sharedNames = []
        for (const net of [...approvedByNetwork.keys()].sort()) {
          for (const host of approvedByNetwork.get(net)) {
            if (nameSeen.has(host)) sharedNames.push(`${host}（${nameSeen.get(host)} ∩ ${net}）`)
            nameSeen.set(host, net)
          }
        }
        const nets = parsed === undefined ? [] : reglib.summarizeNetworks(parsed)
        const approvedTotal = nets.reduce((n, x) => n + x.approved, 0)
        const pendingTotal = nets.reduce((n, x) => n + x.pending, 0)
        const ok24 = shapeOk && audit.ok && pendingInDerived.length === 0 && !bucketMismatch
        add(
          'OBS-24',
          ok24,
          `注册表 ${shapeOk ? '形状合法' : '❌ 形状非法（⛔ 不静默修复）'}` +
            `｜网 ${nets.length} 张（approved ${approvedTotal} / pending ${pendingTotal}）` +
            `｜派生自审 ${audit.ok ? '一致 ✅' : `❌ 集合不配：${audit.mismatches.join(' ; ')}`}` +
            (audit.misfiled.length > 0 ? `｜❌ 结构性错桶：${audit.misfiled.join(' ; ')}` : '｜错桶 0 ✅') +
            (pendingInDerived.length > 0 ? `｜❌ pending 混进派生：${pendingInDerived.join(',')}` : '｜pending 未进派生 ✅') +
            `｜派生桶数=${derivedMap.size} ≡ 有 approved 的网数=${netsWithApproved}${bucketMismatch ? ' ⇒ ❌ 多张网被合并成一张' : ' ✅'}` +
            `｜同名跨网=${sharedNames.length}（**信息项 ⛔ 非判据**${sharedNames.length > 0 ? `：${sharedNames.join(' ; ')}` : ''}）`,
          true,
        )
      }
    }
  }

  /**
   * ── `OBS-25`：**一键加入在册 ＋ 失败具名 ＋ 凭据一次性**（序㊱ · S2/S3）──
   *
   * 数据源 = `overlay-node-admit.cjs selfcheck` 的**机器可读读数**（那个命令会**真跑**一遍
   * 四步编排 ＋ 四条负腿 ＋ 一次性 ＋ 派生自审，⛔ 不是手写出来的夹具）。
   *
   * 判据五件套（口径见参数表 §6 `OBS-25`）：
   * ① **入口在册**：`artifacts.join` / `artifacts.registry` 都为真 **且** 四步齐（`joinSteps` 长度 = `JOIN_STEPS_MIN` 且全 ok）。
   * ② **私钥不出机**：`application.hasPrivateKey === 0` 且申请单**非空**（字节数 > 0）。
   * ③ **一次性**：`ledger.second === 'invite-already-used'`。
   * ④ **⛔ 不许静默拒绝**：`silentRejections === 0` **且** 具名失败条数 ≥ `JOIN_NAMED_FAILURES_MIN`。
   * ⑤ **派生自审一致 ＋ 跨网零共享**：`registry.auditOk === true` 且 `derivation.crossNetworkShared === 0`。
   *
   * ⚠️ **私钥权限**（`nodeKeyModeOk`）：`true` ⇒ 计入；`false` ⇒ **FAIL 并点名**；
   * `null` ⇒ **本平台不可判**（Windows 的 `stat.mode` 不支持 Unix 权限）⇒ **留痕但不计绿**
   * —— 真机腿由部署后在 **Linux** 上跑 selfcheck 承载。⛔ 不许把 `null` 当 PASS。
   *
   * ⚠️ **数据源缺省 ⇒ SKIP ＋ 留痕**（读数文件不存在 = 还没在真机跑过自检）。
   */
  {
    let raw25
    let absent25 = false
    let skip25 = ''
    let err25 = ''
    if (joinFx !== undefined) {
      try {
        raw25 = readFixture(joinFx)
      } catch (err) {
        err25 = err.message
      }
    } else if (fixture) {
      // 🔴 **序㊳：夹具模式一律 SKIP**（⛔ 绝不 ssh）—— 见文件头「夹具模式」小节。
      skip25 = '夹具模式未给 `--join-fixture` ⇒ SKIP ＋ 留痕（⛔ 不去 ssh 读生产）'
    } else {
      try {
        const out = ssh(
          r.num('SSH_PORT'),
          r.need('SSH_TARGET_47'),
          `if [ -f ${nodesSelfcheckFile} ]; then cat ${nodesSelfcheckFile}; else echo __NOFILE__; fi`,
          r.num('SSH_TIMEOUT_MS'),
        )
        if (out.trim() === '__NOFILE__') absent25 = true
        else raw25 = out
      } catch (err) {
        err25 = err.message
      }
    }
    if (err25 !== '') {
      add('OBS-25', false, `❌ 自检读数**读取失败**（⛔ 与"不存在"可分）：${err25}`, true)
    } else if (skip25 !== '') {
      add('OBS-25', false, skip25, false, true)
    } else if (absent25) {
      add('OBS-25', false, `自检读数 ${nodesSelfcheckFile} 不存在 ⇒ SKIP ＋ 留痕（真机还没跑过 selfcheck）`, false, true)
    } else {
      let sc
      try {
        sc = JSON.parse(raw25)
      } catch (err) {
        sc = undefined
        err25 = err.message
      }
      if (sc === undefined || typeof sc !== 'object') {
        add('OBS-25', false, `❌ 自检读数不可判（JSON 解析失败：${err25}）`, true)
      } else {
        const stepsMin = r.num('JOIN_STEPS_MIN')
        const namedMin = r.num('JOIN_NAMED_FAILURES_MIN')
        const steps = Array.isArray(sc.joinSteps) ? sc.joinSteps : []
        const entryOk =
          sc.artifacts?.join === true &&
          sc.artifacts?.registry === true &&
          steps.length >= stepsMin &&
          steps.every((x) => x.ok === true)
        const leakOk = sc.application?.hasPrivateKey === 0 && Number(sc.application?.bytes) > 0
        // 🔴 **CLI 回环**：`join` 产出的申请单必须能被控制面 `apply` 的解析读回
        //    （真机首轮实测：两者形状不一致 ⇒ 收单恒失败；⛔ 这条不加，缺陷会再从单测缝里溜过去）。
        const roundTripOk = sc.application?.shapeOk === true && sc.application?.hostMatches === true
        const onceOk = sc.ledger?.second === 'invite-already-used'
        const named = Array.isArray(sc.namedFailures) ? sc.namedFailures : []
        const namedOk = sc.silentRejections === 0 && named.length >= namedMin
        const deriveOk = sc.registry?.auditOk === true && sc.derivation?.crossNetworkShared === 0
        const mode = sc.nodeKeyModeOk
        const modeOk = mode === true
        const ok25 = entryOk && leakOk && roundTripOk && onceOk && namedOk && deriveOk && mode !== false
        add(
          'OBS-25',
          ok25,
          `${entryOk ? '入口在册 ✅' : '❌ 入口/四步不全'}` +
            `（${steps.filter((x) => x.ok === true).length}/${steps.length} 步，阈值 ≥ ${stepsMin}）` +
            `｜私钥泄露=${sc.application?.hasPrivateKey}（须 0）申请单 ${sc.application?.bytes} B` +
            `｜CLI 回环 shapeOk=${sc.application?.shapeOk} hostMatches=${sc.application?.hostMatches}${
              roundTripOk ? ' ✅' : ` ❌ ${sc.application?.shapeError || ''}`
            }` +
            `｜一次性 second=${sc.ledger?.second}（须 invite-already-used）` +
            `｜具名失败 ${named.length}（阈值 ≥ ${namedMin}）静默拒绝=${sc.silentRejections}（须 0）` +
            `｜自审 auditOk=${sc.registry?.auditOk} 跨网共享=${sc.derivation?.crossNetworkShared}（须 0）` +
            `｜私钥权限=${sc.nodeKeyMode}${
              mode === null
                ? `（platform=${sc.platform ?? '?'} ⇒ **本平台不可判**，⛔ 不计绿；真机腿另取）`
                : mode === true
                  ? ' ✅'
                  : ' ❌ 不成立'
            }`,
          true,
        )
      }
    }
  }

  /**
   * ── `OBS-26` / `OBS-27` / `OBS-28`：**直连（打洞）**（序㊵ · P2/S5）──
   *
   * 数据源 = **一份**读数（`overlay-direct-probe.cjs selfcheck --json` 真跑产出）⇒ 三条判据共用一次取数。
   * 口径（逐条见参数表 §6）：
   * - `OBS-26` 开关「用户可设置 ＋ 默认开 ＋ 有提示」＋ join 回读 ⇒ **D2 / D3 / D4**
   * - `OBS-27` 候选准入「同网＋白名单，且拒绝必须显式」⇒ **D1**
   * - `OBS-28` 打洞「成功路径 ＋ 失败判死 ＋ 冷却非零」⇒ **D5 / D6**；顺带断言**只用内建 `dgram`**
   *
   * ⚠️ **三条都没有 SKIP 档**（直连缺省即开 ⇒ "缺省不启用"不适用）—— 只有
   * ① 读数文件不存在 ② 夹具模式没给夹具 这两种**留痕 SKIP**，以及"读不回来/解析不了"的 FAIL。
   */
  {
    let rawD
    let absentD = false
    let skipD = ''
    let errD = ''
    if (directFx !== undefined) {
      try {
        rawD = readFixture(directFx)
      } catch (err) {
        errD = err.message
      }
    } else if (fixture) {
      // 🔴 序㊳ 的封闭性纪律：夹具模式一律 SKIP，⛔ 绝不 ssh。
      skipD = '夹具模式未给 `--direct-fixture` ⇒ SKIP ＋ 留痕（⛔ 不去 ssh 读生产）'
    } else {
      try {
        const out = ssh(
          r.num('SSH_PORT'),
          r.need('SSH_TARGET_47'),
          `if [ -f ${directSelfcheckFile} ]; then cat ${directSelfcheckFile}; else echo __NOFILE__; fi`,
          r.num('SSH_TIMEOUT_MS'),
        )
        if (out.trim() === '__NOFILE__') absentD = true
        else rawD = out
      } catch (err) {
        errD = err.message
      }
    }

    if (errD !== '') {
      for (const id of ['OBS-26', 'OBS-27', 'OBS-28']) {
        add(id, false, `❌ 直连自检读数**读取失败**（⛔ 与"不存在"可分）：${errD}`, true)
      }
    } else if (skipD !== '') {
      for (const id of ['OBS-26', 'OBS-27', 'OBS-28']) add(id, false, skipD, false, true)
    } else if (absentD) {
      for (const id of ['OBS-26', 'OBS-27', 'OBS-28']) {
        add(id, false, `直连自检读数 ${directSelfcheckFile} 不存在 ⇒ SKIP ＋ 留痕（真机还没跑过直连自检）`, false, true)
      }
    } else {
      let d
      try {
        d = JSON.parse(rawD)
      } catch (err) {
        d = undefined
        errD = err.message
      }
      if (d === undefined || typeof d !== 'object') {
        for (const id of ['OBS-26', 'OBS-27', 'OBS-28']) add(id, false, `❌ 直连自检读数不可判（JSON 解析失败：${errD}）`, true)
      } else {
        // ── OBS-26：开关 ＋ 默认值 ＋ 提示 ＋ join 回读（D2 / D3 / D4）─────────────
        const s = d.switch ?? {}
        const h = d.hint ?? {}
        const j = d.joinConf ?? {}
        const defaultOk = s.defaultCase?.enabled === true && s.defaultCase?.source === 'default'
        const offOk = s.offCase?.enabled === false && s.offCase?.udpSocketsOpened === 0 && s.offCase?.candidatesEmitted === 0
        const badOk = s.badCase?.enabled === null
        const hintOk = Number(h.parts) >= directHintMinParts && h.mentionsOff === true && h.mentionsScope === true && h.mentionsImpact === true
        /**
         * 🆕 序㊸：读数**生产方**（`overlay-direct-probe.cjs`）在**节点形态**上会**具名降级**
         * `join 回读`（该腿要 `lib/net/relay/registry.js` —— **控制面注册表**模块，
         * 106 这类 worker/relay 节点不落它；原文 `Cannot find module '…/registry.js'`）。
         * ⇒ 此时该**子判据**按本线口径取 **SKIP ＋ 留痕**（⛔ 缺依赖 ≠ 故障，⛔ 不判红；
         * 但**必须**在 detail 里点名缺哪个模块）—— ⛔ 不许把它当成"读到了 false"。
         * ⚠️ 仅当生产方**显式**给出 `available:false` 时才降级；形状缺省（老读数 / 47 读数）照旧判。
         */
        const joinDegraded = j.available === false
        const joinOk = joinDegraded ? null : j.direct === true && j.readback === true
        const ok26 = defaultOk && offOk && badOk && hintOk && joinOk !== false
        add(
          'OBS-26',
          ok26,
          `默认=${s.defaultCase?.enabled}（来源 ${s.defaultCase?.source}）${defaultOk ? ' ✅' : ' ❌ 缺省必须 = 开'}` +
            `｜关闭 ⇒ UDP socket ${s.offCase?.udpSocketsOpened} 个 / 候选 ${s.offCase?.candidatesEmitted} 条${offOk ? ' ✅' : ' ❌ 必须双零'}` +
            `｜非法值=${s.badCase?.enabled}${badOk ? ' ✅' : ' ❌ 必须 = null（⛔ 不静默取缺省）'}` +
            `｜提示 ${h.parts} 段（阈值 ≥ ${directHintMinParts}）怎么关=${h.mentionsOff} 谁能连=${h.mentionsScope} 关掉影响=${h.mentionsImpact}${hintOk ? ' ✅' : ' ❌'}` +
            `｜join 回读 ${joinDegraded ? `⛔ 具名降级（缺 ${(Array.isArray(j.missing) ? j.missing : []).map((m) => m.spec).join(' , ') || '(未具名)'}）⇒ 该子判据 SKIP ＋ 留痕` : `direct=${j.direct} 一致=${j.readback}${joinOk ? ' ✅' : ' ❌'}`}`,
          true,
        )

        // ── OBS-27：候选准入「同网 ＋ 白名单 ＋ 显式拒绝」（D1）──────────────────
        const c = d.candidate ?? {}
        const rejected = Array.isArray(c.rejected) ? c.rejected : []
        const namedOk = rejected.length >= directCandRejectMin && rejected.every((x) => typeof x.reason === 'string' && x.reason !== '')
        const acceptOk = Number(c.accepted) >= directCandAcceptMin
        const silentOk = Number(c.silentRejections) === 0
        const bucketOk = c.bucketsPerNetwork === true
        const ok27 = acceptOk && namedOk && silentOk && bucketOk
        add(
          'OBS-27',
          ok27,
          `接受 ${c.accepted}（阈值 ≥ ${directCandAcceptMin}）${acceptOk ? ' ✅' : ' ❌'}` +
            `｜具名拒绝 ${rejected.length} 条（阈值 ≥ ${directCandRejectMin}）${namedOk ? ' ✅' : ' ❌ 有拒绝没带原因'}` +
            `｜静默拒绝=${c.silentRejections}${silentOk ? ' ✅' : ' ❌ 静默返空 = 本线老病根'}` +
            `｜按网分桶（同名跨网互不可见）=${c.bucketsPerNetwork}${bucketOk ? ' ✅' : ' ❌'}` +
            `｜准入实现=${c.matcher ?? '?'}`,
          true,
        )

        // ── OBS-28：打洞「成功 ＋ 判死 ＋ 冷却」（D5 / D6）＋ 依赖面 ────────────────
        const p = d.punch ?? {}
        const cd = p.cooldown ?? {}
        const dep = d.deps ?? {}
        const succOk = p.success?.bidirectional === true && Number(p.attemptsOk) >= directPunchMinOk
        const oneWayOk = p.oneWay?.bidirectional === false && p.oneWay?.a?.reason === 'one-way'
        const dead = Array.isArray(p.dead) ? p.dead : []
        const deadOk = dead.length >= 1 && dead[0]?.bounded === true && dead[0]?.reason === 'deadline'
        const coolOk = Number(cd.ms) === directCooldownMs && Number(cd.ms) > 0 && cd.secondAttemptBlocked === true && Number(cd.blocked) >= 1 && cd.zeroRejected === 'throws'
        const depOk = dep.ok === true
        const ok28 = succOk && oneWayOk && deadOk && coolOk && depOk
        add(
          'OBS-28',
          ok28,
          `成功路径：双向=${p.success?.bidirectional} 成立次数=${p.attemptsOk}（阈值 ≥ ${directPunchMinOk}）${succOk ? ' ✅' : ' ❌'}` +
            `｜单向负腿=${p.oneWay?.a?.reason}/${p.oneWay?.b?.reason}${oneWayOk ? ' ✅（⛔ 不许把单向当成功）' : ' ❌'}` +
            `｜判死=${dead[0]?.reason} 耗时 ${dead[0]?.elapsedMs}ms 有界=${dead[0]?.bounded}${deadOk ? ' ✅' : ' ❌'}` +
            `｜冷却 ${cd.ms}ms（阈值 = ${directCooldownMs}，🔴 必须 > 0）二次被挡=${cd.secondAttemptBlocked} 命中 ${cd.blocked} 次 0 值=${cd.zeroRejected}${coolOk ? ' ✅' : ' ❌'}` +
            `｜依赖面=${depOk ? `只有内建 ✅（${(dep.found ?? []).join(' ')}）` : `❌ 引入新依赖 ${(dep.bad ?? []).join(',')}`}`,
          true,
        )
      }
    }
  }

  /**
   * ── `OBS-29`：**块 id 的 per-network 域分离（C）真生效**（序㊻ · `04-133 §3`）──
   *
   * 🔴 本行是**判据重裁**的产物：原设计的负腿（"稀释源换成确定性派生量 ⇒ 必红"）随 **D 被实测
   * 判为"作用面为空"**（序㊺）而**失去对象** ⇒ 重裁为 **C 自己的判据面**（编号仍自 `OBS-29` 起）。
   *
   * 判据（⛔ **正腿与负腿缺一不可**）：
   * ① **正腿 P1**：同字节 ＋ **不同 network** ⇒ 块 id **不同**，**且两侧都 ≠ 裸哈希**
   *    （⚠️ 只判"不同"不够：两侧**都**回落裸哈希时也会"不同"以外的形态漏判 —— 所以必须同时钉住
   *    "都不等于裸哈希"，这才是"域分离真的生效"而不是"两边走了两条不同的错路"）。
   * ② **正腿 P2**：同 network ＋ 同字节 ⇒ 块 id **相同**（⛔ 只测 P1 会漏掉"**去重被干掉**"）。
   * ③ **正腿 P3**：`store` 写侧复算（`putRejected = 0`）＋ 读侧复算（`corruptReads = 0`）
   *    ＋ `chunker#reassemble` 用同一把域密钥能重组回原内容 ⇒ **证调用点无漏改**
   *    （🔴 漏一处 ⇒ 写侧复算必抛 ⇒ 本腿必红）。
   * ④ 🔴 **负腿 N1（必须真跑、必须具名 `flat-key-collapses`）**：把 `network` 维度**去掉**
   *    （两侧取同一 network ⇒ 同一把域密钥）⇒ ①的谓词**必须转假**。
   * ⑤ 🔴 **负腿 N2（具名 `empty-key-falls-back-to-bare-hash`）**：`netKey` **取空**
   *    ⇒ 谓词**必须转假**，且**取空与生效必须可分**（`keyed ≠ bare`）。
   *
   * 数据源 = **本机进程内自检**（直取 `lib/net/relay/content/*`）⇒ ⛔ **零 ssh、零生产依赖、
   * 夹具模式照跑**（故 `judged = true`）。⚠️ 它判的是"**实现与装配**"，不判"生产已生效"。
   *
   * ⏳ **真机腿（登记为回头条件 · 部署那一棒必须补）**：`/status.content` 断言
   * `blockIdKeyed === true`，且 **47 与 106 的 `content.blockIdKeyId` 逐字相同** ——
   * 跨机口径不一致 ⇒ 跨机取块**全部**判校验失败（块本身是好的，最难定位的形态）。
   */
  {
    const LEG_NAMES = [
      'P1-跨网必不同且都非裸哈希',
      'P2-同网必相同（去重未丢）',
      'P3-装配面无漏改',
      'N1-flat-key-collapses',
      'N2-empty-key-falls-back-to-bare-hash',
    ]
    const leg = {}
    let hardFail
    let detail = ''
    try {
      const chunker = require('../lib/net/relay/content/chunker.js')
      const cmod = require('../lib/net/relay/content/crypto.js')
      const rtmod = require('../lib/net/relay/content/runtime.js')
      // 🔴 产物必须**已换代**：旧 `lib` 里没有这两个导出 ⇒ FAIL 点名（这正是"装了没生效"的机器判据）。
      if (
        typeof cmod.deriveBlockIdKey !== 'function' ||
        typeof cmod.ContentCipher !== 'function' ||
        typeof rtmod.ContentRuntime !== 'function'
      ) {
        hardFail = '❌ `lib` 产物未换代（缺 `deriveBlockIdKey` / `ContentCipher` / `ContentRuntime`）⇒ 先 `npm run build`'
      } else {
        const key = Buffer.alloc(cmod.KEY_LEN, 0x5a)
        const bytes = Buffer.alloc(1024 * 1024 + 3, 0)
        for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31 + 7) & 0xff // 确定性、逐块不同
        const cipher = new cmod.ContentCipher({ groupKey: 'ops|content', epoch: 1, key })
        const rtOf = (network) => new rtmod.ContentRuntime({ network, group: 'content', cipher })
        const idsOf = (network) => rtOf(network).planContent(bytes).ids
        const bare = chunker.planOf(bytes).ids
        const a = idsOf('ops')
        const b = idsOf('u:1')
        const same = idsOf('ops')
        // ① P1 —— 跨网必不同，且两侧都不是裸哈希（**逐块同位比对**，⛔ 不做跨位比对）
        const crossDiff = a.length === b.length && a.every((x, i) => x !== b[i])
        leg['P1-跨网必不同且都非裸哈希'] =
          crossDiff && a.every((x, i) => x !== bare[i]) && b.every((x, i) => x !== bare[i])
        // ② P2 —— 同网必相同（去重还在）
        leg['P2-同网必相同（去重未丢）'] = same.length === a.length && same.every((x, i) => x === a[i])
        // ③ P3 —— 装配面：写侧复算 ＋ 读侧复算 ＋ 重组位，三处都要过
        const rt = rtOf('ops')
        const put = rt.putContent(bytes)
        const snap = rt.snapshot()
        const readBack = rt.store.get(put.plan[0])
        const parts = new Map()
        for (const id of put.plan) parts.set(id, rt.store.get(id))
        let reOk = false
        try {
          const back = chunker.reassemble(put.plan, parts, {
            netKey: rt.netKey,
            decode: (x) => cipher.decodeBlock(x),
          })
          reOk = back.equals(bytes)
        } catch {
          reOk = false
        }
        leg['P3-装配面无漏改'] =
          snap.store.putRejected === 0 && snap.store.corruptReads === 0 && readBack !== undefined && reOk
        detail =
          `写侧 putRejected=${snap.store.putRejected}（须 0）｜读侧 corruptReads=${snap.store.corruptReads}（须 0）` +
          `｜重组位=${reOk ? '逐字节相同 ✓' : '❌'}`
        // ④ N1 —— 去掉 network 维度（两侧同一 network ⇒ 同一把域密钥）⇒ 谓词必须转假
        const flatA = idsOf('ops')
        const flatB = idsOf('ops')
        leg['N1-flat-key-collapses'] = flatA[0] === flatB[0] && flatA[0] !== bare[0]
        // ⑤ N2 —— netKey 取空 ⇒ 谓词必须转假，且取空与生效可分
        const kOn = cmod.deriveBlockIdKey(key, 'ops')
        leg['N2-empty-key-falls-back-to-bare-hash'] =
          chunker.blockIdOf(bytes.subarray(0, 64)) === chunker.blockIdOf(bytes.subarray(0, 64)) &&
          chunker.blockIdOf(bytes.subarray(0, 64), kOn) !== chunker.blockIdOf(bytes.subarray(0, 64))
      }
    } catch (err) {
      hardFail = `❌ 自检抛错：${err.message}`
    }
    if (hardFail !== undefined) {
      add('OBS-29', false, `块 id 域分离（C）真生效：${hardFail}`, true)
    } else {
      const missing = LEG_NAMES.filter((n) => leg[n] !== true)
      const ok = missing.length === 0
      add(
        'OBS-29',
        ok,
        `块 id 域分离（C · per-network keyed hash）腿数 ${LEG_NAMES.length - missing.length}/${LEG_NAMES.length}` +
          `${ok ? ' 全绿 ✅' : ` ❌ 缺 ${missing.join(',')}`}｜${leg['P1-跨网必不同且都非裸哈希'] ? 'P1 ✅' : 'P1 ❌'}` +
          ` ${leg['P2-同网必相同（去重未丢）'] ? 'P2 ✅' : 'P2 ❌'} ${leg['P3-装配面无漏改'] ? 'P3 ✅' : 'P3 ❌'}` +
          ` ${leg['N1-flat-key-collapses'] ? 'N1 ✅（⛔ 判据有牙）' : 'N1 ❌'}` +
          ` ${leg['N2-empty-key-falls-back-to-bare-hash'] ? 'N2 ✅' : 'N2 ❌'}｜${detail}` +
          `｜⏳ 真机腿（content.blockIdKeyed ＋ 两机 blockIdKeyId 逐字相同）待部署后补`,
        true,
      )
    }
  }

  const prefix = fixture ? '⚠️ FIXTURE ' : ''
  for (const row of rows) {    process.stdout.write(`${prefix}${row.skip === true ? 'SKIP' : row.ok ? 'PASS' : 'FAIL'} ${row.id} ${row.text}\n`)
  }
  const red = rows.filter((x) => x.skip !== true && !x.ok)
  if (red.length > 0) {
    process.stderr.write(`❌ ${red.length} 项红：${red.map((x) => x.id).join(' , ')}\n`)
    return EXIT_FAIL
  }
  return EXIT_OK
}

process.exit(main())
