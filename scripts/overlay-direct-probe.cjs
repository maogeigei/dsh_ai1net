#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * 覆盖网络 **直连（打洞）观测面**（序㊵ · P2 · S5）—— **只读** ＋ 一个**自检**子命令。
 *
 * ## 三个子命令
 * | 子命令 | 作用 | 副作用 |
 * |---|---|---|
 * | `selfcheck [--json] [--out <f>] [--ss]` | 跑完**全部**直连判据（开关 / 提示 / 候选准入 / 打洞 / 冷却 / join 回读）并出**机器可读读数** | 仅在系统临时目录里建夹具；`--ss` 时短暂绑一个 UDP 口（秒级） |
 * | `punch --peer <ip:port>[,…] [--self-port <p>] [--deadline <ms>] [--bind <host>] [--json]` | **真机腿**：本机单侧打洞探测（读对方是否回包） | 短暂绑一个 UDP 口（秒级） |
 * | `peer-wire [--json] [--out <f>] [--status-url <url>]` | 🆕 序㊶（S6）：`peer` 档**接线**自检（通道顺序 / 具名降级 / **D7 复算闸门** / 候选准入复用 S5 / 块 id 不变性读数） | 纯进程内夹具（⛔ 零监听、零网络；`--status-url` 时只读一个 HTTP GET） |
 * | `status [--json]` | 只读：当前生效的开关（env ＞ 本机配置 ＞ 缺省）＋ 三段提示 | **零** |
 *
 * ## 🔴 它与 `overlay-probe.cjs` 的分工（⛔ 别把两处的判据混起来）
 * - **本脚本产出读数**（`DIRECT_SELFCHECK_FILE` 那份 JSON，形状见下）；
 * - **`overlay-probe.cjs` 的 `OBS-26/27/28` 判读数**（阈值**全部**取自参数表，⛔ 本脚本内无阈值判断）。
 * ⇒ "阈值唯一来源 = 参数表"这条铁律不被绕过：本脚本只负责**量**，不负责**判**。
 *
 * ## 读数形状（`selfcheck --json`）
 * ```jsonc
 * {
 *   "switch":    { "defaultEnabled": true, "offCase": { "enabled": false, "udpSocketsOpened": 0, "candidatesEmitted": 0 }, … },
 *   "hint":      { "parts": 3, "mentionsOff": true, "mentionsScope": true, "mentionsImpact": true },
 *   "candidate": { "accepted": 3, "rejected": [ { "case": "cross-network", "reason": "cross-network" }, … ], "silentRejections": 0 },
 *   "punch":     { "attemptsOk": 1, "success": { "bidirectional": true }, "oneWay": { … }, "dead": [ … ] },
 *   "cooldown":  { "ms": 300000, "blocked": 1, "secondAttemptBlocked": true, "zeroRejected": "throws" },
 *   "degraded":  false,                                    // 🆕 序㊸：是否有"具名降级"的腿
 *   "degradedLegs": [],
 *   "joinConf":  { "available": true, "direct": true, "readback": true },
 *   // ⚠️ 节点形态（无 lib/net/relay/registry.js）下 joinConf **换成**：
 *   //   { "available": false, "reason": "module-missing",
 *   //     "missing": [ { "spec": "../lib/net/relay/registry.js", "code": "MODULE_NOT_FOUND", "message": "…原文…" } ] }
 *   //   ⇒ 形状与"跑了但读数为空"**完全不同** = 「没装」与「没采到」可分。
 *   "deps":      { "ok": true, "found": ["node:dgram", …] },
 *   "udp":       { "ssBefore": null, "ssDuringOffCase": null, "ssDuringOnCase": null }
 * }
 * ```
 *
 * ## ⛔ 它不做什么
 * ⛔ 不写任何远端文件（除 `--out` 指定的那份读数）｜⛔ 不改任何配置｜⛔ 不开长驻监听
 * ｜⛔ 不碰 `nft` / 云安全组（那是 D8 的收口动作，⛔ 不在本脚本职责内）。
 *
 * ## 🆕 序㊸：**可跑性 = "节点形态也能跑"**（106 侧观测面缺口收口）
 *
 * **实测缺口**：106（worker/relay 节点）的 `<install-dir>-cluster/lib` **不含 `registry.js`**
 * —— 那是**控制面注册表**模块，节点不落它。而本脚本原先在**顶层** `require` 了它
 * （外加同样依赖它的 `join.js`）⇒ 在 106 上**任何**子命令都跑不起来：
 * `Error: Cannot find module '../lib/net/relay/registry.js'`。
 * 偏偏 106 正是**真机打洞腿**的取证机 ⇒ 只能临时写最小脚本绕行（那正是"脆"的来源）。
 *
 * **处置 = 惰性 / 可选加载 ＋ 具名降级**（⛔ **不是**"再铺一份 `registry.js`"）：
 * - 只有 `join 回读`（判据 D3）这条腿需要 `registry.js` / `join.js` ⇒ **就只让它依赖**：
 *   `joinConfCases()` 内部惰性加载，**加载不到 ⇒ 具名降级**（读出 `available:false` ＋
 *   缺哪个模块 ＋ **原文** message），其余 `status` / `punch` / `peer-wire` 及其余读数照常。
 * - 🔴 **⛔ 绝不静默返回"没有"** —— 降级必须**点名**缺的是哪个模块
 *   （本线明令：「**没装**」与「**没采到**」必须可分）；读数里另给
 *   `degraded: true` / `degradedLegs: ["joinConf"]` 两个**机器可读**标记。
 * - ⚠️ 只吞 `MODULE_NOT_FOUND`（且**原文 message 原样带出**）；其它异常（语法错、依赖内部崩）
 *   **一律照抛** —— 否则会把真故障伪装成"缺模块"。
 *
 * @module scripts/overlay-direct-probe
 */

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

const net = require('../lib/net/relay/network.js')
const id = require('../lib/net/relay/identity.js')
const direct = require('../lib/net/relay/direct/index.js')
const cand = require('../lib/net/relay/direct/candidate.js')
const punch = require('../lib/net/relay/direct/punch.js')

/**
 * **惰性 / 可选加载**（⛔ 它不是"容错"、更不是"静默兜底"）—— 见文件头「序㊸」段。
 *
 * 判据（**必须同时成立**，缺一即视为"把真故障伪装成缺模块"）：
 * 1. 只把 `MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND` 当"缺模块"；
 * 2. 其余异常（语法错 / 依赖内部崩 / 权限）**原样抛出**；
 * 3. **原文 message 一字不改地带出**给调用方点名（⛔ 不 `catch {}` 吞掉）。
 *
 * @param {string} spec 相对本脚本的模块说明符
 * @returns {{ok:boolean, mod:any, code:string|null, message:string|null}}
 */
function optionalModule(spec) {
  try {
    return { ok: true, mod: require(spec), code: null, message: null }
  } catch (err) {
    const code = (err && err.code) || null
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      return { ok: false, mod: null, code, message: err.message }
    }
    throw err
  }
}

/**
 * 🔴 **启动期硬断言**：本脚本依赖的常量必须在场，缺一个就**具名失败**（`exit 2`）。
 *
 * 为什么必须有这一关（**已实测踩过**）：`direct/index.js` 是**选择性**桶导出 —— 它 import 了
 * `DEFAULT_PUNCH_DEADLINE_MS` / `DEFAULT_DIRECT_COOLDOWN_MS` 供 **内部**使用，但**不向外转发**。
 * 从桶上取这两个值 ⇒ `undefined` ⇒ `Number(undefined)` = `NaN` ⇒ 只在下游出症状
 * （`DirectCooldown` 构造期断言抛 `收到 null`，因为 `JSON.stringify(NaN) === 'null'`）。
 * ⛔ 这属于本线明令禁止的「**静默取缺省**」⇒ 改成**入场即点名**，⛔ 不许靠下游兜底。
 */
const REQUIRED_CONSTS = [
  ['punch', punch, ['PUNCH_PORT_BASE', 'PUNCH_PORT_SPAN', 'PUNCH_PROBE_INTERVAL_MS', 'DEFAULT_PUNCH_DEADLINE_MS', 'DEFAULT_DIRECT_COOLDOWN_MS']],
  ['cand', cand, ['DIRECT_CAND_MAX_ADDRS']],
  ['direct', direct, ['DIRECT_ENV_KEY', 'DIRECT_ON_VALUES', 'DIRECT_OFF_VALUES']],
]
{
  const missing = []
  for (const [mod, obj, keys] of REQUIRED_CONSTS) {
    for (const k of keys) {
      if (obj[k] === undefined) missing.push(`${mod}.${k}`)
    }
  }
  if (missing.length > 0) {
    process.stderr.write(
      `✗ overlay-direct-probe 启动自检失败：缺常量 ${missing.join(' , ')}\n` +
        `  （⛔ 不再静默取缺省；请核对 lib/net/relay/direct/*.js 的导出面与本次部署是否一致）\n`,
    )
    process.exit(2)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const opt = (name) => (typeof args[name] === 'string' && args[name].trim() !== '' ? args[name].trim() : undefined)

/**
 * `ss -lunp` 里**直连口区间**（`[base, base+span)`）的 UDP 行数。
 * ⛔ 取不到 ⇒ `null` —— **绝不**把「没采到」写成 `0`（本线铁律：两者必须可分）。
 *
 * ⚠️ 为什么按**端口区间**计数而不是全量行数：全量行数会被 `chronyd` 之类的常驻 UDP 口污染，
 * 「前 N → 后 N」这种差分在它们抖动时会出现**假绿/假红**。直连口区间是本功能专属，判据干净。
 */
function ssDirectUdpLines(base, span) {
  try {
    const out = execFileSync('ss', ['-lunp'], { encoding: 'utf8', timeout: 5000 })
    const lo = Number(base)
    const hi = lo + Number(span)
    return out
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('State'))
      .filter((l) => {
        const m = /:(\d+)\s/.exec(l)
        if (m === null) return false
        const p = Number(m[1])
        return p >= lo && p < hi
      }).length
  } catch (err) {
    return null
  }
}

/** `--ss` 是**开关**（无值），所以按"出现过"判 —— ⛔ 不是 `opt()`（那要求带值 ⇒ 恒 undefined）。 */
const wantSs = args.ss !== undefined

/** 找一个**没人监听**的本地端口（用于产出 `deadline` 那条负腿）。 */
async function freeDeadPort() {
  const s = new (require('node:dgram').Socket)('udp4')
  await new Promise((res) => s.bind({ port: 0, address: '127.0.0.1' }, res))
  const p = s.address().port
  await new Promise((res) => s.close(res))
  return p
}

/**
 * 依赖面断言：`lib/net/relay/direct/*.js` 里出现的模块说明符**只准**是
 * ① Node 内建 `node:*` ② 本模块内相对路径（`./` `../`）。
 * ⇒ 把硬门「⛔ 不引入新依赖（只用 Node 内建 `dgram`）」变成**机器可断言**的一条。
 *
 * ⚠️ 产物是 **ESM**（`package.json` 里 `"type": "module"`）⇒ 两种写法都要扫：
 * `import … from "x"` 与 `import "x"`（`require(` 一并兼容 —— 编进 CJS 也照样查得到）。
 * （第一版只扫 `require(` ⇒ 一条都没扫到、**判据恒绿** —— 正是本线要防的那种"静默放行"。）
 */
function depsAudit() {
  const dir = path.join(__dirname, '..', 'lib', 'net', 'relay', 'direct')
  const found = new Set()
  const bad = []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'))
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8')
    const specs = []
    for (const m of text.matchAll(/require\(["']([^"']+)["']\)/g)) specs.push(m[1])
    for (const m of text.matchAll(/^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm)) specs.push(m[1])
    for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specs.push(m[1])
    for (const spec of specs) {
      found.add(spec)
      const okBuiltin = spec.startsWith('node:')
      const okLocal = spec.startsWith('./') || spec.startsWith('../')
      if (!okBuiltin && !okLocal) bad.push(`${f}:${spec}`)
    }
  }
  return { ok: bad.length === 0 && found.size > 0, found: [...found].sort(), bad, files: files.length }
}

/** 开关四态（缺省 / 开 / 关 / 非法）——**每个都真跑一次**，⛔ 不靠"读代码推断"。 */
async function switchCases(ctx) {
  const mkPath = (state, deadlineMs) =>
    new direct.DirectPath({ switchState: state, cooldownMs: ctx.cooldownMs, portBase: ctx.portBase, portSpan: ctx.portSpan, deadlineMs, maxAddrs: ctx.maxAddrs })

  const good = cand.encodeDirectMessage({
    hostId: 'node-2',
    network: 'ops',
    addrs: [{ host: '<HOST_LAN_IP>', port: ctx.portBase + 1 }],
  })
  const ctxOf = { dialers: ctx.dialers, from: { network: 'ops', hostId: 'node-2' }, selfHostId: 'manager' }

  const defaultCase = direct.resolveDirectSwitch({})
  const onState = direct.resolveDirectSwitch({ [direct.DIRECT_ENV_KEY]: 'true' })
  const offState = direct.resolveDirectSwitch({ [direct.DIRECT_ENV_KEY]: 'false' })
  const badState = direct.resolveDirectSwitch({ [direct.DIRECT_ENV_KEY]: 'maybe' })

  const onPath = mkPath(onState, 400)
  const onVerdict = onPath.offerCandidate(good, ctxOf)
  const onAttempt = await onPath.attempt('ops/void', [{ host: '127.0.0.1', port: await freeDeadPort() }], { sleep })
  const onStatus = onPath.status()

  const offPath = mkPath(offState, 400)
  const offVerdict = offPath.offerCandidate(good, ctxOf)
  const offAttempt = await offPath.attempt('ops/void', [{ host: '127.0.0.1', port: await freeDeadPort() }], { sleep })
  const offStatus = offPath.status()

  const badPath = mkPath(badState, 400)
  const badVerdict = badPath.offerCandidate(good, ctxOf)

  return {
    envKey: direct.DIRECT_ENV_KEY,
    defaultEnabled: direct.DEFAULT_DIRECT_ENABLED,
    defaultCase: { enabled: defaultCase.enabled, source: defaultCase.source },
    onCase: {
      raw: onState.raw,
      enabled: onState.enabled,
      candidateOk: onVerdict.ok === true,
      candidatesEmitted: onStatus.counters.candidatesEmitted,
      udpSocketsOpened: onStatus.counters.udpSocketsOpened,
      attemptReason: onAttempt.reason,
    },
    offCase: {
      raw: offState.raw,
      enabled: offState.enabled,
      candidateReason: offVerdict.ok ? '' : onVerdict_reason(offVerdict),
      candidatesEmitted: offStatus.counters.candidatesEmitted,
      udpSocketsOpened: offStatus.counters.udpSocketsOpened,
      attemptReason: offAttempt.reason,
    },
    badCase: {
      raw: badState.raw,
      enabled: badState.enabled,
      invalid: badState.invalid,
      candidateReason: badVerdict.ok ? '' : onVerdict_reason(badVerdict),
      openedSockets: badPath.status().counters.udpSocketsOpened,
    },
  }
}

function onVerdict_reason(v) {
  return v.ok ? '' : v.reason
}

/** 提示文案（三段）是否**可行动**：提没提"怎么关"、提没提"谁能连进来"、提没提"关掉影响什么"。 */
function hintAudit() {
  const lines = direct.directHintLines()
  const text = direct.directHintText()
  return {
    parts: lines.length,
    mentionsOff: text.includes(direct.DIRECT_ENV_KEY) && direct.DIRECT_OFF_VALUES.some((v) => text.includes(v)),
    mentionsScope: text.includes('白名单') && text.includes('同一张覆盖网'),
    mentionsImpact: text.includes('不影响') && text.includes('中继'),
    text,
  }
}

/**
 * 候选准入矩阵（**判据 D1**）——每一条都走 `CandidateLedger.judge`（⇒ 记账与判定同一入口）。
 *
 * ⚠️ 白名单形状**真的走** `network.ts#normalizeDialers`（= `server.ts` 构造期用的那一个）
 * ⇒ 这里量的是"**同一份策略**"的行为，⛔ 不是复刻一个判据。
 */
function candidateMatrix(ctx) {
  const dialers = net.normalizeDialers(
    new Map([
      ['ops', new Set(['manager', 'node-2'])],
      ['u:5', new Set(['node-2'])],
    ]),
  )
  const led = new cand.CandidateLedger()
  const accepted = []
  const rejected = []
  const run = (name, raw, c) => {
    const v = led.judge(raw, c)
    if (v.ok) accepted.push(name)
    else rejected.push({ case: name, reason: v.reason, detail: v.detail })
    return v
  }

  const msg = (over = {}) =>
    cand.encodeDirectMessage({
      hostId: 'node-2',
      network: 'ops',
      addrs: [{ host: '<HOST_LAN_IP>', port: ctx.portBase + 1 }],
      ts: Date.now(),
      ...over,
    })
  const inOps = { dialers, from: { network: 'ops', hostId: 'node-2' }, selfHostId: 'manager', maxAddrs: ctx.maxAddrs }

  run('ops-单地址', msg(), inOps)
  run('ops-双地址', msg({ addrs: [{ host: '<HOST_LAN_IP>', port: ctx.portBase + 1 }, { host: '2001:db8::1', port: ctx.portBase + 2 }] }), inOps)
  const u5 = { dialers, from: { network: 'u:5', hostId: 'node-2' }, selfHostId: 'node-2', maxAddrs: ctx.maxAddrs }
  run('u:5-同名跨网可拨', msg({ network: 'u:5' }), u5)

  run('跨网', msg({ network: 'u:5' }), inOps)
  run('替第三人申报', msg({ hostId: 'node-999' }), inOps)
  const noDialer = net.normalizeDialers(new Map([['ops', new Set(['manager'])]]))
  run('白名单外', msg(), { ...inOps, dialers: noDialer })
  run('本机不在白名单', msg(), { ...inOps, selfHostId: 'w-nobody' })
  run('形状非法', '{"kind":"DIRECT_CANDIDATE"}', inOps)
  run(
    '夹带密钥字段',
    JSON.stringify({ kind: 'DIRECT_CANDIDATE', hostId: 'node-2', network: 'ops', addrs: [{ host: '<HOST_LAN_IP>', port: 21101 }], nodeKey: 'x' }),
    inOps,
  )
  run('主机名当地址', msg({ addrs: [{ host: 'example.com', port: 80 }] }), inOps)
  run('地址超限', msg({ addrs: Array.from({ length: ctx.maxAddrs + 1 }, (_, i) => ({ host: '<HOST_LAN_IP>', port: 21100 + i })) }), inOps)
  run('过期候选', msg({ ts: Date.now() - 10 * 60 * 1000 }), inOps)

  const snap = led.snapshot()
  // 同名跨网**互不可见**：u:5 里申报 ops 的候选必须被拒（= 桶隔离真的在起作用）
  const crossInside = led.judge(msg(), u5)
  return {
    matcher: 'network.ts#isAllowedDialer',
    accepted: snap.accepted,
    acceptedCases: accepted,
    rejected: snap.rejected.map((r, i) => ({ case: rejected[i]?.case ?? '', reason: r.reason })),
    rejectedCases: rejected,
    received: snap.received,
    silentRejections: snap.silentRejections,
    byReason: snap.byReason,
    bucketsPerNetwork: crossInside.ok === false && crossInside.reason === 'cross-network',
  }
}

/** 打洞（**判据 D5 / D6**）—— 成功路径走 NAT 模拟器（真 `dgram` ＋ 同一份打洞代码）。 */
async function punchCases(ctx) {
  const deadlineMs = 2500
  const ok = await punch.runPunchPair({ aPeer: 'ops/node-1', bPeer: 'ops/node-2', deadlineMs }, { sleep })
  const oneWay = await punch.runPunchPair({ aPeer: 'ops/node-1', bPeer: 'ops/node-2', deadlineMs: 1200, oneWay: 'a' }, { sleep })

  const cd = new punch.DirectCooldown(ctx.cooldownMs)
  let openedSockets = 0
  const deadPort = await freeDeadPort()
  const dead = await punch.runPunchAttempt(
    {
      peer: 'ops/void',
      selfPort: 0,
      targets: [{ host: '127.0.0.1', port: deadPort }],
      deadlineMs: 600,
      cooldown: cd,
      bindHost: '127.0.0.1',
      onSocketOpen: () => {
        openedSockets += 1
      },
    },
    { sleep },
  )
  const openedAfterFirst = openedSockets
  const second = await punch.runPunchAttempt(
    {
      peer: 'ops/void',
      selfPort: 0,
      targets: [{ host: '127.0.0.1', port: deadPort }],
      deadlineMs: 600,
      cooldown: cd,
      bindHost: '127.0.0.1',
      onSocketOpen: () => {
        openedSockets += 1
      },
    },
    { sleep },
  )
  let zeroRejected = 'not-thrown'
  try {
    new punch.DirectCooldown(0)
  } catch (err) {
    zeroRejected = 'throws'
  }
  const bound = 600 + 3 * punch.PUNCH_PROBE_INTERVAL_MS

  return {
    deadlineMs,
    success: {
      bidirectional: ok.bidirectional,
      a: { reason: ok.a.reason, recvLocal: ok.a.recvLocal, peerSeen: ok.a.peerSeen, sent: ok.a.sent },
      b: { reason: ok.b.reason, recvLocal: ok.b.recvLocal, peerSeen: ok.b.peerSeen, sent: ok.b.sent },
      nat: ok.nat,
    },
    attemptsOk: (ok.a.ok ? 1 : 0) + (ok.b.ok ? 1 : 0),
    oneWay: {
      bidirectional: oneWay.bidirectional,
      a: { reason: oneWay.a.reason, recvLocal: oneWay.a.recvLocal, peerSeen: oneWay.a.peerSeen },
      b: { reason: oneWay.b.reason, recvLocal: oneWay.b.recvLocal, peerSeen: oneWay.b.peerSeen },
    },
    dead: [
      {
        reason: dead.reason,
        elapsedMs: dead.elapsedMs,
        deadlineMs: 600,
        bounded: dead.elapsedMs <= bound,
        sent: dead.sent,
        recvLocal: dead.recvLocal,
      },
    ],
    cooldown: {
      ms: cd.ms,
      blocked: cd.snapshot().blocked,
      secondAttemptReason: second.reason,
      secondAttemptBlocked: second.reason === 'cooldown' && openedSockets === openedAfterFirst,
      zeroRejected,
    },
    portBase: ctx.portBase,
    portSpan: ctx.portSpan,
    probeIntervalMs: punch.PUNCH_PROBE_INTERVAL_MS,
  }
}

/**
 * join 回读（**判据 D3**）：真的跑一遍四步编排（夹具目录），再看本机配置读回什么。
 *
 * 🆕 **序㊸：本条腿的依赖是"可选"的** —— 它要 `lib/net/relay/join.js` 与它 import 的
 * `lib/net/relay/registry.js`（**控制面注册表**模块）。**节点形态**（如 106 的
 * `<install-dir>-cluster/lib`）**不落 `registry.js`** ⇒ 这里**具名降级**：
 * `{ available:false, reason:'module-missing', missing:[…原文 message…] }`。
 * 🔴 ⛔ **不许静默返"没有"**（不填 `direct` / `readback` —— 那会让"没装"看起来像"读到了 null"）。
 * 判据 = 「该腿不可用」与「该腿跑了但读数为空」在读数里**形状完全不同** ⇒ 可分。
 */
async function joinConfCases() {
  const regL = optionalModule('../lib/net/relay/registry.js')
  const joinL = optionalModule('../lib/net/relay/join.js')
  const missing = []
  if (!regL.ok) missing.push({ spec: '../lib/net/relay/registry.js', code: regL.code, message: regL.message })
  if (!joinL.ok) missing.push({ spec: '../lib/net/relay/join.js', code: joinL.code, message: joinL.message })
  if (missing.length > 0) {
    return {
      available: false,
      reason: 'module-missing',
      missing,
      hint:
        '该腿需要 lib/net/relay/{registry,join}.js；registry.js 是**控制面注册表**模块，' +
        '节点形态（如 106 worker / relay 节点）不落它 ⇒ 属「节点形态」而非故障',
    }
  }
  const reg = regL.mod
  const joinx = joinL.mod
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh_ai1net-direct-selfcheck-'))
  const signer = id.generateAuthorityKey()
  const issue = (network) => {
    const doc = {
      version: reg.NODES_REGISTRY_VERSION,
      network,
      nonce: reg.newInviteNonce(randomBytes),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    }
    return { doc, sig: id.signPayloadWith(signer.privateKeyPem, reg.networkInvitePayload(doc)) }
  }
  const io = joinx.nodeJoinIo({
    fss: { existsSync: fs.existsSync, readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, mkdirSync: fs.mkdirSync },
    crypto: id,
    os,
    fetchImpl: async () => ({ status: 599, body: 'selfcheck 不走 HTTP 通道' }),
  })
  const base = (name, extra = {}) => ({
    network: 'selfcheck-net',
    hostId: name,
    invite: issue('selfcheck-net'),
    trustedSigners: [signer.publicKey],
    nodeKeyFile: path.join(tmp, `${name}.key`),
    localConfigFile: path.join(tmp, `${name}.json`),
    outFile: path.join(tmp, `${name}-app.json`),
    ...extra,
  })
  const dflt = await joinx.runJoin(base('node-a'), io)
  const off = await joinx.runJoin(base('node-b', { direct: false }), io)
  const readBack = (file) => {
    try {
      return direct.directFromNodeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
    } catch (err) {
      return undefined
    }
  }
  const cfgA = readBack(path.join(tmp, 'node-a.json'))
  const cfgB = readBack(path.join(tmp, 'node-b.json'))
  return {
    available: true,
    joinOk: dflt.ok === true,
    direct: cfgA,
    readback: cfgA === direct.DEFAULT_DIRECT_ENABLED,
    respectsArg: cfgB === false,
    stepDetail: dflt.ok ? (dflt.steps.find((s) => s.step === 'local-config')?.detail ?? '') : '',
    file: path.join(tmp, 'node-a.json'),
  }
}

async function selfcheck() {
  const ctx = {
    cooldownMs: punch.DEFAULT_DIRECT_COOLDOWN_MS,
    portBase: punch.PUNCH_PORT_BASE,
    portSpan: punch.PUNCH_PORT_SPAN,
    maxAddrs: cand.DIRECT_CAND_MAX_ADDRS,
    dialers: net.normalizeDialers(new Map([['ops', new Set(['manager', 'node-2'])], ['u:5', new Set(['node-2'])]])),
  }
  /** `--ss` 腿（真实机取证）：① 基线 ② **关闭态应为 0** ③ **正对照**（绑一个真口 ⇒ 应为 ≥1）。 */
  const ssProbe = () => ssDirectUdpLines(ctx.portBase, ctx.portSpan)
  const ssBefore = wantSs ? ssProbe() : null
  const sw = await switchCases(ctx)
  const ssDuringOffCase = wantSs ? ssProbe() : null
  /**
   * 🔴 **正对照**：不给这一腿的话，「关闭态 = 0 行」在**测量本身坏了**（例如 `ss` 取不到、
   * 正则不匹配本机 `ss` 输出格式）时**也是 0** ⇒ 假绿。所以这里真绑一个直连口，
   * 要求它**必须被 `ss` 看见**；只有"正对照 = ≥1 且关闭态 = 0"才是真证据。
   */
  let ssDuringOnCase = null
  if (wantSs) {
    const ctrl = new punch.PunchSocket()
    try {
      await ctrl.open(ctx.portBase)
      ssDuringOnCase = ssProbe()
    } catch (err) {
      ssDuringOnCase = null
    } finally {
      try {
        ctrl.close()
      } catch (err) {
        // 已经关掉了 ⇒ 无事可做（⛔ 但不吞：上面已经把读数置 null）
      }
    }
  }
  const hud = hintAudit()
  const cm = candidateMatrix(ctx)
  const ph = await punchCases(ctx)
  const jc = await joinConfCases()
  /** 🆕 序㊸：**具名降级**的腿（机器可读）—— 目前只有 `joinConf`（缺控制面模块的节点形态）。 */
  const degradedLegs = jc.available === false ? ['joinConf'] : []
  return {
    version: 1,
    at: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    degraded: degradedLegs.length > 0,
    degradedLegs,
    switch: sw,
    hint: hud,
    candidate: cm,
    punch: ph,
    joinConf: jc,
    deps: depsAudit(),
    udp: {
      ssBefore,
      ssDuringOffCase,
      ssDuringOnCase,
      ssAvailable: ssBefore !== null,
      directRange: [ctx.portBase, ctx.portBase + ctx.portSpan - 1],
    },
  }
}

/** 真机单侧打洞（**判据 D5/D8 的真机腿**）：给对端地址，看回包与来源。 */
async function realPunch() {
  const peers = (opt('peer') ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  if (peers.length === 0) {
    process.stderr.write('✗ punch 需要 --peer <ip:port>[,…]\n')
    process.exit(2)
  }
  const targets = peers.map((p) => {
    const i = p.lastIndexOf(':')
    return { host: p.slice(0, i), port: Number(p.slice(i + 1)) }
  })
  for (const t of targets) {
    if (!cand.isValidAddress(t)) {
      process.stderr.write(`✗ punch：非法地址 ${JSON.stringify(t)}\n`)
      process.exit(2)
    }
  }
  const selfPort = Number(opt('self-port') ?? punch.PUNCH_PORT_BASE)
  const deadlineMs = Number(opt('deadline') ?? punch.DEFAULT_PUNCH_DEADLINE_MS)
  const bindHost = opt('bind') ?? '0.0.0.0'
  // 🔴 常量必须取自 `punch.js`（**真身**所在）：`direct/index.js` 是选择性桶导出，
  //    它**不**转发 `DEFAULT_PUNCH_DEADLINE_MS` / `DEFAULT_DIRECT_COOLDOWN_MS`
  //    ⇒ 从桶上取 = `undefined` ⇒ `Number(undefined)` = `NaN` ⇒ 冷却构造期断言直接抛（已实测踩过）。
  const cd = new punch.DirectCooldown(Number(opt('cooldown-ms') ?? punch.DEFAULT_DIRECT_COOLDOWN_MS))
  const r = await punch.runPunchAttempt(
    { peer: `real/${targets.map((t) => `${t.host}:${t.port}`).join('+')}`, selfPort, targets, deadlineMs, cooldown: cd, bindHost },
    { sleep },
  )
  const readings = {
    at: new Date().toISOString(),
    bindHost,
    selfPort,
    targets,
    deadlineMs,
    reason: r.reason,
    ok: r.ok,
    recvLocal: r.recvLocal,
    peerSeen: r.peerSeen,
    bidirectional: r.bidirectional,
    sent: r.sent,
    elapsedMs: r.elapsedMs,
    sources: r.sources,
    detail: r.detail,
    // ⚠️ 单侧跑不出"双向"（对端确认要靠 relay 通道回报，那是 S6）⇒ 两侧的 `recvLocal` 合起来才是判据
    note: '单侧读数：两侧都 recvLocal > 0 ⇒ 打洞成立；一侧 0 ⇒ 该方向被挡（云安全组 / NAT）',
  }
  if (args.json) process.stdout.write(`${JSON.stringify(readings, null, 2)}\n`)
  else {
    process.stdout.write(
      `打洞探测（${readings.selfPort} → ${targets.map((t) => `${t.host}:${t.port}`).join(',')}）：reason=${r.reason} 收包=${r.recvLocal} 发出=${r.sent} 耗时=${r.elapsedMs}ms\n`,
    )
    process.stdout.write(`  回包来源：${r.sources.join(',') || '（无）'}\n`)
    process.stdout.write(`${r.detail}\n`)
  }
  if (opt('out') !== undefined) fs.writeFileSync(opt('out'), `${JSON.stringify(readings, null, 2)}\n`, { mode: 0o644 })
  return readings.ok ? 0 : 1
}

/**
 * ── 🆕 序㊶ · S6：`peer` 档**接线**自检（`peer-wire`）─────────────────────────────────
 *
 * 判据（对齐设计说明 §5 **D7**）：
 * ① **通道顺序固定** = `direct` → `wss`；`direct` 可用时**不碰** `wss`（"优先直连"不是口号）。
 * ② **具名降级**：不可用必须**点名原因**（`disabled` / `invalid-switch` / `cooldown` /
 *    `no-address` / `data-plane-pending` / `not-wired`），⛔ 不许"没有原因地走了另一条通道"。
 * ③ 🔴 **D7 复算闸门**：取回的**落库字节**必须复算出同一个块 id ——
 *    篡改块 ⇒ **丢弃且不算命中**（`idMismatches +1`、`peer` 命中 **0**）。
 * ④ **接入判定复用 S5**：直连候选只从 `noteDirectCandidate(CandidateLedger#judge 的结果)` 进来；
 *    被拒的 verdict ⇒ **不进候选**。
 * ⑤ **块 id 不变性读数**（与接线前逐字比对的那一份）。
 */
async function peerWire() {
  const rtmod = require('../lib/net/relay/content/runtime.js')
  const chunker = require('../lib/net/relay/content/chunker.js')

  const net = 'ops'
  const group = 's6-wire'

  // ── 夹具块（小，便于逐字节比对）─────────────────────────────────────────────
  const blockBytes = Buffer.from('序㊶ · S6 · peer 接线夹具块（tamper fixture）', 'utf8')
  const blockId = chunker.blockIdOf(blockBytes)

  /** 夹具通道：`good` 给真字节／`tamper` 改 1 字节／`miss` 说没有／`down:<reason>` 具名不可用。 */
  const mkChannel = (name, mode) => ({
    name,
    available: () =>
      typeof mode === 'string' && mode.startsWith('down:')
        ? { ok: false, reason: mode.slice(5), detail: `夹具具名降级 ${mode.slice(5)}` }
        : { ok: true },
    fetch: async () => {
      if (mode === 'good') return blockBytes
      if (mode === 'tamper') {
        const b = Buffer.from(blockBytes)
        b[0] ^= 0xff
        return b
      }
      if (mode === 'miss') return undefined
      throw new Error(`夹具通道 ${name} 故障（故意：验证"抛错 ≠ 未命中"）`)
    },
  })

  /** 造一个 runtime ＋ 一个同组 peer（声明持有该块）。 */
  const build = (opts) => {
    const r = new rtmod.ContentRuntime({ network: net, group, ...opts })
    r.peers.addPeer({ name: `${net}/peerA`, network: net, group, holds: [blockId] })
    return r
  }
  /** 跑一次取块并抓读数。 */
  const leg = async (opts) => {
    const r = build(opts)
    const outcome = await r.source.fetch(blockId)
    const w = r.peerWireSnapshot()
    const snap = r.snapshot()
    return {
      tier: outcome === undefined ? null : outcome.tier,
      bytesMatch: outcome === undefined ? false : outcome.bytes.equals(blockBytes),
      attempts: w.attempts,
      hits: w.hits,
      misses: w.misses,
      errors: w.errors,
      unavailable: w.unavailable,
      downReasons: w.downReasons,
      idChecks: w.idChecks,
      idMismatches: w.idMismatches,
      peerHitsTotal: snap.source.peer,
      peerMissesTotal: snap.source.peerMiss,
      sourceErrors: snap.sourceErrors,
      wireWired: w.wired,
      wireOrder: w.order,
      directCandidates: w.directCandidates,
    }
  }

  const directOn = { env: { [direct.DIRECT_ENV_KEY]: 'true' } }
  const legs = {}

  // ① direct 可用（夹具）⇒ 命中直连，**不碰 wss**
  legs.directPreferred = await leg({
    direct: false,
    peerChannels: { direct: mkChannel('direct', 'good'), wss: mkChannel('wss', 'good') },
  })
  // ② direct 具名不可用（no-address：开关开、无准入候选）⇒ 回落 wss 并命中
  legs.fallbackNoAddress = await leg({ direct: directOn, peerChannels: { wss: mkChannel('wss', 'good') } })
  // ③ 开关关 ⇒ `disabled` ⇒ 回落
  legs.switchOff = await leg({
    direct: { env: { [direct.DIRECT_ENV_KEY]: '0' } },
    peerChannels: { wss: mkChannel('wss', 'good') },
  })
  // ④ 开关取值非法 ⇒ `invalid-switch`（⛔ 不静默当开/当关）⇒ 回落
  legs.switchInvalid = await leg({
    direct: { env: { [direct.DIRECT_ENV_KEY]: 'maybe' } },
    peerChannels: { wss: mkChannel('wss', 'good') },
  })
  // ⑤ 通道自己报具名降级（cooldown）⇒ 记账可断言 ＋ 回落
  legs.namedDowngradeCooldown = await leg({
    direct: false,
    peerChannels: { direct: mkChannel('direct', 'down:cooldown'), wss: mkChannel('wss', 'good') },
  })
  // ⑥ 两条通道都没装 ⇒ 全是 `not-wired`，诚实回"没有"（⛔ 不是假绿）
  legs.noChannelWired = await leg({ direct: false })
  // ⑦ 🔴 D7：篡改块 ⇒ **丢弃**（不算命中、错误计数 +1）
  legs.tamperedBlockRejected = await leg({
    direct: false,
    peerChannels: { wss: mkChannel('wss', 'tamper') },
  })
  // ⑧ 好块 ⇒ 命中（证明接线真的能取到，不是"永远回没有"）
  legs.goodBlockAccepted = await leg({ direct: false, peerChannels: { wss: mkChannel('wss', 'good') } })
  // ⑨ 通道说"没有" ⇒ 记 miss（与不可用/抛错互相可区分）
  legs.channelMiss = await leg({ direct: false, peerChannels: { wss: mkChannel('wss', 'miss') } })
  // ⑩ 通道抛错 ⇒ 记 errors（⛔ 不许整体失败、⛔ 不许吞）
  legs.channelError = await leg({ direct: false, peerChannels: { wss: mkChannel('wss', 'error') } })

  // ⑪ 候选接入：**复用 S5 准入**（`CandidateLedger#judge`）＋ 数据面未建成 ⇒ 具名 `data-plane-pending`
  const dialers = new Map([[net, new Set(['peerA', 'self'])]])
  const judgeOk = cand
    .admitCandidate(cand.encodeDirectMessage({ hostId: 'peerA', network: net, addrs: [{ host: '127.0.0.1', port: 21100 }] }), {
      dialers,
      from: { network: net, hostId: 'peerA' },
      selfHostId: 'self',
    })
  const judgeRejected = cand.admitCandidate(
    cand.encodeDirectMessage({ hostId: 'peerA', network: net, addrs: [{ host: '127.0.0.1', port: 21100 }] }),
    { dialers, from: { network: net, hostId: 'peerA' }, selfHostId: 'stranger-outside-whitelist' },
  )
  const rCand = build({ direct: directOn, peerChannels: { wss: mkChannel('wss', 'good') } })
  const accepted = rCand.noteDirectCandidate(judgeOk)
  const afterAccept = await rCand.source.fetch(blockId)
  const acceptedLeg = {
    judgeOk: judgeOk.ok,
    judgeReason: judgeOk.ok ? null : judgeOk.reason,
    noteOk: accepted.ok,
    directCandidates: rCand.peerWireSnapshot().directCandidates,
    tier: afterAccept === undefined ? null : afterAccept.tier,
    downReasons: rCand.peerWireSnapshot().downReasons,
    idChecks: rCand.peerWireSnapshot().idChecks,
    idMismatches: rCand.peerWireSnapshot().idMismatches,
  }
  const rCand2 = build({ direct: directOn })
  const rejectedNote = rCand2.noteDirectCandidate(judgeRejected)
  const rejectedLeg = {
    judgeOk: judgeRejected.ok,
    judgeReason: judgeRejected.ok ? null : judgeRejected.reason,
    noteOk: rejectedNote.ok,
    noteReason: rejectedNote.ok ? null : rejectedNote.reason,
    // ⛔ 被拒 ⇒ 候选集**必须仍为空**（白名单判定**不在 content 侧**另写一份）
    directCandidates: rCand2.peerWireSnapshot().directCandidates,
  }

  // ⑫ 块 id 不变性读数（与"接线前"逐字比对的那一份；同 §8.2 的 5,255,225 B 夹具口径）
  const big = Buffer.allocUnsafe(5_255_225)
  let x = 0x12345678
  for (let i = 0; i < big.length; i += 1) {
    x = (x * 1103515245 + 12345) >>> 0
    big[i] = (x >>> 16) & 0xff
  }
  const rIds = build({ direct: false })
  const put = rIds.putContent(big)
  const idsDigest = require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(put.plan))
    .digest('hex')

  // ⑬ 真机腿（可选）：读 relay `/status.content.peerWire`（`--status-url`）
  let realmachine = null
  if (opt('status-url') !== undefined) {
    try {
      const body = execFileSync('curl', ['-s', '--max-time', '10', opt('status-url')], { encoding: 'utf8' })
      const j = JSON.parse(body)
      const pw = (j.content ?? {}).peerWire
      realmachine = {
        url: opt('status-url'),
        contentPresent: j.content !== undefined,
        peerWirePresent: pw !== undefined,
        order: pw?.order ?? null,
        wired: pw?.wired ?? null,
        idChecks: pw?.idChecks ?? null,
        idMismatches: pw?.idMismatches ?? null,
        downReasons: pw?.downReasons ?? null,
      }
    } catch (err) {
      realmachine = { url: opt('status-url'), error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── 判定（每条腿一个布尔；⛔ 不写"大概对"）──────────────────────────────────
  const checks = {
    '① direct 优先（不碰 wss）':
      legs.directPreferred.tier === 'peer' &&
      legs.directPreferred.bytesMatch === true &&
      legs.directPreferred.hits.direct === 1 &&
      legs.directPreferred.attempts.wss === 0 &&
      legs.directPreferred.idChecks === 1 &&
      legs.directPreferred.idMismatches === 0,
    '② no-address ⇒ 具名回落 wss':
      legs.fallbackNoAddress.downReasons['direct:no-address'] === 1 &&
      legs.fallbackNoAddress.hits.wss === 1 &&
      legs.fallbackNoAddress.tier === 'peer',
    '③ 开关关 ⇒ disabled':
      legs.switchOff.downReasons['direct:disabled'] === 1 && legs.switchOff.hits.wss === 1,
    '④ 开关非法 ⇒ invalid-switch':
      legs.switchInvalid.downReasons['direct:invalid-switch'] === 1 && legs.switchInvalid.hits.wss === 1,
    '⑤ 通道具名降级（cooldown）':
      legs.namedDowngradeCooldown.downReasons['direct:cooldown'] === 1 &&
      legs.namedDowngradeCooldown.hits.wss === 1,
    '⑥ 未装通道 ⇒ not-wired ×2 且诚实回没有':
      legs.noChannelWired.downReasons['direct:not-wired'] === 1 &&
      legs.noChannelWired.downReasons['wss:not-wired'] === 1 &&
      legs.noChannelWired.tier === null &&
      legs.noChannelWired.hits.direct === 0 &&
      legs.noChannelWired.hits.wss === 0,
    '⑦ 🔴 D7 篡改块被丢弃（不算命中）':
      legs.tamperedBlockRejected.idChecks === 1 &&
      legs.tamperedBlockRejected.idMismatches === 1 &&
      legs.tamperedBlockRejected.tier === null &&
      legs.tamperedBlockRejected.peerHitsTotal === 0 &&
      legs.tamperedBlockRejected.hits.wss === 0 &&
      legs.tamperedBlockRejected.errors.wss === 1,
    '⑧ 好块被接受（接线真能取到）':
      legs.goodBlockAccepted.tier === 'peer' &&
      legs.goodBlockAccepted.bytesMatch === true &&
      legs.goodBlockAccepted.hits.wss === 1 &&
      legs.goodBlockAccepted.idChecks === 1 &&
      legs.goodBlockAccepted.idMismatches === 0,
    '⑨ 通道说没有 ⇒ miss（≠ 不可用 / ≠ 抛错）':
      legs.channelMiss.misses.wss === 1 && legs.channelMiss.tier === null && legs.channelMiss.errors.wss === 0,
    '⑩ 通道抛错 ⇒ errors（≠ 未命中）':
      legs.channelError.errors.wss === 1 && legs.channelError.misses.wss === 0 && legs.channelError.tier === null,
    '⑪ 直连候选只收 S5 准入 ok 的结果 ⇒ data-plane-pending':
      acceptedLeg.judgeOk === true &&
      acceptedLeg.noteOk === true &&
      acceptedLeg.directCandidates === 1 &&
      acceptedLeg.downReasons['direct:data-plane-pending'] === 1 &&
      acceptedLeg.tier === 'peer',
    '⑫ 被拒 verdict 不进候选（⛔ 白名单不另写一份）':
      rejectedLeg.judgeOk === false &&
      rejectedLeg.noteOk === false &&
      rejectedLeg.directCandidates === 0,
    '⑬ 块 id 不变性读数产出':
      idsDigest.length === 64 && put.plan.length === 6 && rIds.snapshot().source.local === 0,
  }

  const readings = {
    at: new Date().toISOString(),
    group,
    fixture: { blockBytes: blockBytes.length, blockId, idsFixtureBytes: big.length, idsDigest, idsPlan: put.plan },
    channelOrder: legs.directPreferred.wireOrder,
    legs,
    candidateAdmission: { accepted: acceptedLeg, rejected: rejectedLeg },
    realmachine,
    checks,
    ok: Object.values(checks).every(Boolean),
  }

  if (args.json) process.stdout.write(`${JSON.stringify(readings, null, 2)}\n`)
  else {
    process.stdout.write(`peer 接线自检（通道顺序 ${readings.channelOrder.join(' → ')}）\n`)
    for (const [k, v] of Object.entries(checks)) process.stdout.write(`  ${v ? '✅' : '❌'} ${k}\n`)
    process.stdout.write(
      `  夹具块 id=${blockId}｜不改性读数 idsDigest=${idsDigest}（与接线前逐字比对用）\n`,
    )
    process.stdout.write(`  篡改腿读数：${JSON.stringify(legs.tamperedBlockRejected.downReasons)} idChecks=${legs.tamperedBlockRejected.idChecks} idMismatches=${legs.tamperedBlockRejected.idMismatches}\n`)
    if (realmachine !== null) process.stdout.write(`  真机腿：${JSON.stringify(realmachine)}\n`)
  }
  if (opt('out') !== undefined) fs.writeFileSync(opt('out'), `${JSON.stringify(readings, null, 2)}\n`, { mode: 0o644 })
  return readings.ok ? 0 : 1
}

/** 只读现状（开关 ＋ 提示）。 */
function status() {
  const file = process.env.DSH_AI1NET_OVERLAY_NODE_CONFIG || direct.NODE_CONFIG_FILE_DEFAULT
  let localDirect
  let present = false
  try {
    if (fs.existsSync(file)) {
      present = true
      localDirect = direct.directFromNodeConfig(JSON.parse(fs.readFileSync(file, 'utf8')))
    }
  } catch (err) {
    process.stderr.write(`⚠️ 本机配置 ${file} 读不出来（⛔ 与"没配置"可分）：${err.message}\n`)
  }
  const state = direct.resolveDirectSwitch(process.env, { localDirect })
  const out = {
    envKey: direct.DIRECT_ENV_KEY,
    defaultEnabled: direct.DEFAULT_DIRECT_ENABLED,
    effective: state.enabled,
    source: state.source,
    raw: state.raw,
    invalid: state.invalid,
    nodeConfig: { file, present, direct: localDirect ?? null },
    hint: direct.directHintLines(),
  }
  if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(
      `直连(打洞)：${state.enabled === null ? `❌ 取值非法（${state.invalid}）` : state.enabled ? '开' : '关'}` +
        `｜来源 ${state.source}${state.raw === null ? '' : `（${direct.DIRECT_ENV_KEY}=${state.raw}）`}` +
        `｜缺省 ${direct.DEFAULT_DIRECT_ENABLED}\n`,
    )
    process.stdout.write(`本机配置 ${file}：${present ? `存在（direct=${localDirect ?? '未设'}）` : '不存在'}\n`)
    for (const l of out.hint) process.stdout.write(`  ${l}\n`)
  }
  return 0
}

/**
 * `join 回读` 那一行的**可读文本** —— 🆕 序㊸：**两种形态必须长得不一样**。
 *
 * - `available:true` ⇒ 读数行（`direct=… 回读一致=… 尊重 --direct=…`）
 * - `available:false` ⇒ **具名降级行**：`⛔ 不可用（module-missing）` ＋ **缺哪个模块** ＋
 *   原文 message。🔴 这是"**没装**"；⛔ 与"**没采到**"（跑了但读数为空）必须可分。
 */
function joinConfLine(jc) {
  if (jc === undefined || jc === null) return '⚠️ 无读数（⛔ 与"不可用"必须可分）'
  if (jc.available === false) {
    const miss = Array.isArray(jc.missing) ? jc.missing : []
    return (
      `⛔ 不可用（${jc.reason ?? 'unknown'}）—— 缺 ${miss.map((m) => m.spec).join(' , ') || '(未具名)'}` +
      `｜⚠️ 这是「没装」不是「没采到」` +
      (miss[0]?.message === undefined ? '' : `｜原文 message：${miss.map((m) => m.message).join(' ｜ ')}`)
    )
  }
  return `direct=${jc.direct}（回读一致=${jc.readback} / 尊重 --direct=${jc.respectsArg}）`
}

async function main() {
  const sub = args._[0] ?? 'status'
  if (sub === 'selfcheck') {
    const readings = await selfcheck()
    if (opt('out') !== undefined) {
      fs.writeFileSync(opt('out'), `${JSON.stringify(readings, null, 2)}\n`, { mode: 0o644 })
      if (!args.json) process.stdout.write(`✓ 读数已落盘 ${opt('out')}\n`)
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(readings, null, 2)}\n`)
    } else {
      const s = readings.switch
      process.stdout.write(
        `开关：缺省=${s.defaultCase.enabled}（来源 ${s.defaultCase.source}）｜关=${s.offCase.enabled} ⇒ UDP socket ${s.offCase.udpSocketsOpened} 个 / 候选 ${s.offCase.candidatesEmitted} 条｜非法值=${s.badCase.enabled}\n`,
      )
      process.stdout.write(`提示：${readings.hint.parts} 段｜怎么关=${readings.hint.mentionsOff}｜谁能连=${readings.hint.mentionsScope}｜关掉影响=${readings.hint.mentionsImpact}\n`)
      process.stdout.write(`候选：接受 ${readings.candidate.accepted}｜拒绝 ${readings.candidate.rejected.length}｜静默拒绝 ${readings.candidate.silentRejections}\n`)
      process.stdout.write(
        `打洞：成功 ${readings.punch.success.bidirectional ? '双向 ✅' : '❌'}｜单向负腿 ${readings.punch.oneWay.a.reason}/${readings.punch.oneWay.b.reason}｜判死 ${readings.punch.dead[0].reason}（${readings.punch.dead[0].elapsedMs}ms ≤ 有界 ${readings.punch.dead[0].bounded}）\n`,
      )
      process.stdout.write(`冷却：${readings.punch.cooldown.ms}ms｜二次被挡=${readings.punch.cooldown.secondAttemptBlocked}｜0 值=${readings.punch.cooldown.zeroRejected}\n`)
      process.stdout.write(`join 回读：${joinConfLine(readings.joinConf)}\n`)
      process.stdout.write(`依赖面：${readings.deps.ok ? '✅ 只有内建' : `❌ ${readings.deps.bad.join(',')}`}｜${readings.deps.found.join(' ')}\n`)
      if (readings.udp.ssAvailable)
        process.stdout.write(
          `UDP 直连口 (${readings.udp.directRange?.[0]}–${readings.udp.directRange?.[1]}) 行数：` +
            `基线 ${readings.udp.ssBefore}｜正对照（绑真口）${readings.udp.ssDuringOnCase}｜关闭态 ${readings.udp.ssDuringOffCase}\n`,
        )
    }
    return 0
  }
  if (sub === 'punch') return realPunch()
  if (sub === 'peer-wire') return peerWire()
  if (sub === 'status') return status()
  process.stderr.write(`✗ 未知子命令 ${sub}（可用：selfcheck | punch | peer-wire | status）\n`)
  return 2
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`✗ 直连自检异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  },
)
