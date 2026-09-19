/**
 * 网抽象 —— **`network_id` 维度与"节点逻辑名"的唯一入口**（覆盖网络 ②·P0-1）。
 *
 * ## 它解决的确切问题
 * R0–R5 跑通之后，relay 把**平台自己的 Worker 隧道**和**未来的用户设备**塞进**同一个扁平
 * `hostId` 命名空间**（`server.ts` 的 `sessions` / `endpoints` 都只按 `hostId` 索引，全仓
 * `grep -ri networkId|tailnet` = 0 命中）。今天只有 1 个用户、1 张网，问题不显形；一进第二类
 * 节点就会变成「**一张巨网 + 靠 ACL 兜**」—— 而写错一条 ACL 就泄露，这与项目
 * 「**权限只准收窄**」直接冲突。
 *
 * ⇒ 本模块把「**哪张网**」变成**结构性维度**（不是策略性）：判据只有这一处，纯函数、无 IO、可单测。
 *    `server.ts` / `client.ts` / 运维配置**一律从这里取**，⛔ 不许在调用方拼字符串
 *    （散着拼迟早就出现三套不一致的口径 —— 本线复盘里反复出现的那类病）。
 *
 * ## 取值（D2 · 已定项）
 * - **运维网固定 `ops`**：47（Manager）/ 106（Worker）/ 未来的中继与骨干 —— 即"平台自己的机器"。
 * - **用户网 = `u:<userId>`**：该用户名下的全部设备（含桌面客户端）。
 * ⇒ 存量数据天然落在 `ops`（这正是"加列带默认值"能零风险落地的原因）。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不碰虚拟网卡 / L3 地址 / `100.64.0.0/10`（`设计文档 §2 D1`）；
 * - 不解析 DNS、不下发对端清单（D4）：本阶段收敛为「**逻辑名 + 授权**」。
 *
 * @module dsh_ai1net/net/relay/network
 */

/** 运维网（平台自己的机器）。**固定值**，与部署位置无关。 */
export const OPS_NETWORK = 'ops'

/**
 * 网络 id 的合法形状（三条分支，见 `isNetworkId`）。
 *
 * 收在一个入口里，是为了让"配错了"在**装载配置时就炸**，而不是变成
 * 「谁也没匹配上 ⇒ 静默拒绝」（静默拒绝是本线反复要根治的病：它把"配置错"伪装成"网络不通"）。
 */
const TENANT_NET_RE = /^u:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const GENERIC_NET_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/

/** hostId 的合法形状（`<host-a>` / `<host-b>` / `manager` …）。 */
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** 逻辑名的**规范分隔符**。`<network_id>/<hostId>` —— `network_id` 不含 `/`，故**首个** `/` 即分隔点。 */
export const NAME_SEP = '/'

/**
 * 网络 id 是否合法。三条分支：
 * - `ops` —— 运维网（固定值）；
 * - `u:<租户 id>` —— 用户网（租户 id 是数字或字符串都行，故后半段放宽）；
 * - 其它显式命名（小写字母数字与 `_.-`）—— 留给将来的"二级网 / 测试网"，**不新增机制**。
 *
 * ⛔ **裸 `u` 是保留字**，永远不是一个合法的网名：它是"用户网前缀"。放行它会带来一个极隐蔽的坑 ——
 * `DSH_AI1NET_RELAY_DIALERS="u:5:manager"` 里的网络段 `u:5` 一旦被写错成 `u:5` 之外的形式（或有人直接
 * 写 `u:manager`），左/右切点会把网络段切成 `u`，于是"配置写错"**长得像"这张网不存在"**（静默拒绝）。
 */
export function isNetworkId(raw: string): boolean {
  if (raw === OPS_NETWORK) return true
  if (raw === 'u') return false
  return TENANT_NET_RE.test(raw) || GENERIC_NET_RE.test(raw)
}

export function isHostId(raw: string): boolean {
  return HOST_RE.test(raw)
}

/**
 * 校验网络 id；非法 ⇒ **抛**（不返回 `undefined`）。
 *
 * 为什么抛而不"兜个默认值"：`DSH_AI1NET_OVERLAY_NETWORK_ID` 打错一个字，如果静默回落 `ops`，
 * 那台机器会**以正确的样子加入错误的网**（表现是"另一张网里看不见它"，且没有任何一行日志说得出原因）。
 */
export function assertNetworkId(raw: string, what = 'network id'): string {
  const v = raw.trim()
  if (!isNetworkId(v)) throw new Error(`${what} 非法：${JSON.stringify(raw)}（合法形状：ops ｜ u:<租户> ｜ [a-z0-9][a-z0-9_.-]*）`)
  return v
}

/**
 * 网络 id 的**类别**（`isNetworkId` 那三条分支的**具名**形态）。
 *
 * ## 为什么要有它（「节点一键加入与分组准入」S1）
 * 管理面要回答「**有哪些网**、每张是什么性质」—— 只回一个 `true/false` 不够：分组准入的
 * **默认分组**、**能否与 `ops` 共享骨干**、**是否允许显式命名**，三处判据都要这个类别。
 *
 * ⛔ **纯函数、无 IO、不改既有语义** —— `isNetworkId` 仍是唯一的合法性判据，本函数只是
 * 把它的三条分支**具名化**（`kind !== undefined` ⟺ `isNetworkId(raw) === true`）。
 *
 * | 类别 | 形态 | 含义 |
 * |---|---|---|
 * | `ops` | 固定值 | 平台自己的机器（中继 / 骨干 / Worker） |
 * | `tenant` | `u:<租户>` | 该用户名下的全部设备（含桌面客户端） |
 * | `named` | `[a-z0-9][a-z0-9_.-]*` | **二级网 / 测试网 / 独立覆盖网络** —— 新增一张网**零代码** |
 */
export type NetworkKind = 'ops' | 'tenant' | 'named'

export function networkKindOf(raw: string): NetworkKind | undefined {
  const v = raw.trim()
  if (!isNetworkId(v)) return undefined
  if (v === OPS_NETWORK) return 'ops'
  if (v.startsWith('u:')) return 'tenant'
  return 'named'
}

/**
 * 网名的**规范展示名**（管理面 / CLI 输出用）—— `ops` 后面跟着它是什么。
 *
 * ⛔ 只用于**人读的输出**（日志 / `list` 表）。**判据一律用 `networkKindOf`** ——
 * 拿展示名去做字符串匹配 = 把"好看的输出"变成判据（本线反复要根治的那类病）。
 */
export function describeNetwork(raw: string): string {
  const kind = networkKindOf(raw)
  if (kind === undefined) return `${raw}（⛔ 非法网名）`
  if (kind === 'ops') return `${raw}（运维网 · 平台自己的机器）`
  if (kind === 'tenant') return `${raw}（租户网）`
  return `${raw}（显式命名网 · 可作独立覆盖网络）`
}

/** 节点逻辑名 = `<network_id>/<hostId>`。**唯一拼法**（别在调用方拼）。 */
export function logicalName(network: string, hostId: string): string {
  return `${network}${NAME_SEP}${hostId}`
}

/**
 * 反解一个逻辑名 / 配置项。
 *
 * ## 三条分隔规则（顺序即优先级）
 * 1. 含 `/` ⇒ 按**首个** `/` 切（`ops/manager` · `u:5/<host-b>`）—— 规范形态；
 * 2. 否则含 `:` ⇒ 按**最后一个** `:` 切（`ops:manager` · `u:5:manager`）——
 *    为的是兼容运维习惯的 `network:hostId` 写法；⚠️ 必须从**右**切：`u:5` 里的 `:` 属于网络 id；
 * 3. 都不含 ⇒ **旧形态**（R5 时代的扁平 `hostId`）⇒ 落在 `ops`，**旧配置照旧可用**。
 *    （过渡期不破坏现网：`DSH_AI1NET_RELAY_DIALERS="manager"` 与 `"ops:manager"` 等价。）
 *
 * ⚠️ 第 2/3 条里"切出来的网络 id 必须合法"，否则**抛** —— 见 `assertNetworkId` 的理由。
 */
export function parseLogicalName(raw: string): { network: string; hostId: string } {
  const { network, hostId } = parseEntry(raw)
  return { network, hostId }
}

/**
 * 同 `parseLogicalName`，但额外告诉调用方"这条**自己写了网络没有**"（`qualified`）。
 *
 * 为什么需要这个位：白名单的**两种入参**对"裸 hostId"的解释**不同** ——
 * - 扁平列表（`Set`）：裸 hostId = R5 旧写法 ⇒ `ops`；
 * - 按网络分桶（`Map`）：裸 hostId = **本桶那张网**里的 hostId。
 * 少了这个位，"`Map{'u:x' => {'d-user'}}`" 会被当成"把 ops 的 host 塞进 u:x 桶"⇒ 判据永远不命中
 * ⇒ **静默拒绝**（本线反复要根治的那类病：配置写对了，表现却像网络不通）。
 */
function parseEntry(raw: string): { network: string; hostId: string; qualified: boolean } {
  const v = raw.trim()
  if (v === '') throw new Error('逻辑名为空')
  const slash = v.indexOf(NAME_SEP)
  if (slash > 0 && slash < v.length - 1) {
    const network = assertNetworkId(v.slice(0, slash), `逻辑名 ${JSON.stringify(raw)} 里的网络段`)
    return { network, hostId: assertHostId(v.slice(slash + 1), raw), qualified: true }
  }
  const colon = v.lastIndexOf(':')
  if (colon > 0 && colon < v.length - 1) {
    const network = assertNetworkId(v.slice(0, colon), `逻辑名 ${JSON.stringify(raw)} 里的网络段`)
    return { network, hostId: assertHostId(v.slice(colon + 1), raw), qualified: true }
  }
  // 旧形态：扁平 hostId（**不带网络**，由调用方决定它属于哪张网，默认运维网）。
  return { network: OPS_NETWORK, hostId: assertHostId(v, raw), qualified: false }
}

function assertHostId(raw: string, whole: string): string {
  const v = raw.trim()
  if (!isHostId(v)) throw new Error(`逻辑名 ${JSON.stringify(whole)} 里的 hostId 非法：${JSON.stringify(raw)}`)
  return v
}

/** 两个节点是否同网（DIAL 的**结构性**判据：不同网 ⇒ 连"能不能拨"这一步都走不到）。 */
export function sameNetwork(a: string, b: string): boolean {
  return a === b
}

/**
 * 同网**断言**（跨网 ⇒ 抛）—— P0-3 的"控制面侧那道门"。
 *
 * 为什么不是让调用方用 `sameNetwork` 自己判：那样的常见写法是
 * `if (!sameNetwork(a, b)) return undefined` ⇒ **跨网拒绝在日志里什么都不留**，
 * 表现与"节点离线 / 名字打错"完全同形 —— 正是本线反复要根治的静默失效。
 * 凡"跨网就是错"的地方一律用本函数：错误里**带着两边是哪张网**，排障不必猜。
 */
export function assertSameNetwork(expected: string, actual: string, what = '节点'): void {
  if (expected === actual) return
  throw new Error(`${what} 跨网：期望 "${expected}"，实际 "${actual}"（结构性隔离 ⇒ 不允许跨网解析）`)
}

/**
 * 拨号方白名单的**归一化** —— 同时接受两种入参，旧形态照旧可用（过渡期不破坏现网）。
 *
 * | 入参 | 桶里"裸 hostId"的含义 |
 * |---|---|
 * | `Set<string>`（R5 形态，`main.ts` 从 env 读出来的就是它） | 该条目**自带**网络（`ops:manager` / `u:5:d1`）；裸 hostId ⇒ `ops` |
 * | `Map<network, Set<hostId>>`（新形态） | 裸 hostId ⇒ **本桶那张网**里的 hostId |
 *
 * ⚠️ 两种入参对"裸 hostId"的解释不同，是**故意的**：分桶形态下，桶键已经表达了网络，
 * 桶里再写一遍网络只会带来"两处写不一致"的新风险（所以**写了就必须一致，否则抛**）。
 *
 * ⚠️ 返回的 map **永远是新的**（不被调用方后续 `Set` 改动影响）—— 白名单是安全判据，
 * 不能因为某个持有引用的调用方顺手 `add()` 就悄悄放宽。
 */
export function normalizeDialers(
  input: ReadonlySet<string> | ReadonlyMap<string, ReadonlySet<string>> | undefined,
): Map<string, ReadonlySet<string>> {
  const out = new Map<string, ReadonlySet<string>>()
  if (input === undefined) return out
  if (isDialerMap(input)) {
    for (const [networkRaw, hosts] of input.entries()) {
      const network = assertNetworkId(networkRaw, '拨号方白名单的网络段')
      const bucket = new Set<string>(out.get(network) ?? [])
      for (const host of hosts ?? []) {
        const e = parseEntry(host)
        if (e.qualified && e.network !== network) {
          throw new Error(
            `拨号方白名单自相矛盾：桶 "${network}" 里放了属于 "${e.network}" 的条目 ${JSON.stringify(host)}`,
          )
        }
        bucket.add(e.hostId)
      }
      out.set(network, bucket)
    }
    return out
  }
  // 扁平列表（R5 形态）：逐条按自带网络**分发**到各自的桶；裸 hostId ⇒ 运维网。
  for (const host of input) {
    const e = parseEntry(host)
    const bucket = new Set<string>(out.get(e.network) ?? [])
    bucket.add(e.hostId)
    out.set(e.network, bucket)
  }
  return out
}

/**
 * **白名单准入的唯一定义**（P2/S5）—— `true` = 该 `hostId` 在 `network` 这张网里可拨。
 *
 * ## 为什么必须单列成一个函数（⛔ 不是为了好看）
 * 在它之前，「不在白名单就拒」这条策略**只有 `server.ts` 里三处内联写法**：
 * `this.dialers.get(network)?.has(hostId) === true`（注册闸门 `:1182`）、
 * `this.dialers.get(session.network)?.has(session.hostId) !== true`（`DIAL` 闸门 `:1491`）。
 * 直连（P2）要**再判一次同一条策略**（候选交换/打洞都只准发生在"同网 ＋ 白名单内"），
 * 若直连模块**自己再写一份**，就正好撞上本线反复吃过的病根：**同一事实两处写** ⇒
 * 两处有一天会分叉（`server.ts` 那两处是**冻结的只读面**，不许改也不许被复制）。
 *
 * ⇒ 本函数 = **该策略的唯一可复用出口**；`server.ts` 的内联写法与它**逐字等价**
 * （同 map 、同 `=== true` 默认拒绝语义、同"按网络分桶"）。等价性由
 * the regression suite` 做**机器守卫**（读 `server.ts` 源码核对那两处的原文形态）。
 *
 * ⚠️ 语义上 `network` 是**桶键**：拿别的网的桶去查同名 hostId 只会得到 `false`
 * （这正是 P0-1「跨网结构性隔离」—— ⛔ 不是"策略允许/不允许"的区别）。
 */
export function isAllowedDialer(
  map: ReadonlyMap<string, ReadonlySet<string>>,
  network: string,
  hostId: string,
): boolean {
  return map.get(network)?.has(hostId) === true
}

/**
 * 类型判别：`Map` 形态 vs 扁平 `Set` 形态。
 *
 * 为什么要单独一个函数而不是直接 `input instanceof Map`：`ReadonlyMap` / `ReadonlySet` 都是
 * **接口**，`instanceof` 收窄在联合类型上不可靠（TS 会把 else 分支仍当成联合，于是迭代出来的
 * 元素类型变成 `string | [string, …]`）。写成显式类型谓词，编译器与读代码的人都清楚。
 */
function isDialerMap(
  v: ReadonlySet<string> | ReadonlyMap<string, ReadonlySet<string>>,
): v is ReadonlyMap<string, ReadonlySet<string>> {
  return typeof (v as ReadonlyMap<string, ReadonlySet<string>>).get === 'function'
}

/**
 * 一行摘要（**同一条信息只说一次**）—— `main.ts` 启动日志与 `/status` 共用同一格式，
 * 免得"日志说的"与"status 说的"长得不一样（那种差异排查时最费时间）。
 *
 * `ops` 下的条目**省略网络前缀**（与 R5 的日志/配置写法一致，读起来不变）。
 */
export function describeDialers(map: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const out: string[] = []
  for (const network of [...map.keys()].sort()) {
    for (const host of [...(map.get(network) ?? [])].sort()) {
      out.push(network === OPS_NETWORK ? host : logicalName(network, host))
    }
  }
  return out
}
