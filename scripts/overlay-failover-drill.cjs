/**
 * 覆盖网络 · **序⑦ 中继失败切流 · 真机演练**（设计说明 §5 S7 / §6 E5–E7 的判据本体）
 *
 * ## 这个脚本要回答的唯一问题
 * 「**杀掉任一台中继 ⇒ 正在使用它的客户端在 `RELAY_FAILOVER_DEADLINE_MS` 内切到另一台**」
 * —— 在**真机**上、由**一条命令**产出 PASS/FAIL/SKIP（⛔ 不把真机取证交给 agent 手工做）。
 *
 * ## 三幕（序⑦）
 * - **幕 1**：杀掉 Manager **当前所在**那台中继（`DRILL_KILLED_MATCH`）⇒ 断言切换在 deadline 内发生，
 *   且**目标 ≠ 被杀入口**、47 的 Manager 自身仍存活（失败域分离）、门户仍 200。
 * - **幕 2**：两台全杀 ⇒ 断言**无新切换**、有 `[relay-skip]` 的"无候选"证据、⛔ 无静默回退（D6 / R11）。
 *   🔴 **序⑩ 修（2026-09-17）**：原实现**只停 106** —— 若此刻活跃通道正好在 47（幕 1 的余波 / 单跑本幕），
 *   停的就是**当前不用**的那台 ⇒ 通道根本没被打断 ⇒ 窗口内 0 行 `[relay-skip]` / 0 行 `[relay-switch]`
 *   ⇒ **幕2-B 假红**（序⑨ 实测：该 120 s 窗口里 Manager 一行 relay 日志都没有）。现在本幕**现场重读一次
 *   权威通道归属**，再把**两台都停掉**（幂等）⇒ 断言不再依赖上一幕留下的通道归属。
 * - **幕 3**：只恢复 47 ⇒ 断言**冷却期内不回跳**；随后复原两台。
 *
 * ## 序⑧ 新增（2026-09-17）：**幕 4 系列** —— "切流冷却语义"的真机判据
 * - **幕 4**（构 A）：停 47 ⇒ 47 的**两条候选**各按原因进冷却 ⇒ 恢复 47、停 106 ⇒ **D6 现场**
 *   ⇒ 断言"一跳豁免"把通道切回 47（日志带 `｜豁免 … 剩 Nms` ⇒ **直接证明 47 当时确在冷却**）。
 * - **幕 4b**（对照）：同上但 `RELAY_FAILOVER_EXEMPT=0` ＋ `RELAY_FAILOVER_COOLDOWN_MS` 缩到
 *   `DRILL_COOLDOWN_MS` ⇒ 断言 ① D6 现场原样复现 ② 冷却未过期前**不切流** ③ 冷却过期后**自然**回归。
 *   ⚠️ 该幕**用的是非生产冷却值**，报告必须标注（D9）。
 * - 🔴 **序⑩ 删（2026-09-17）**：原 `--scene 4c` 与 `--scene ctrl`（**两者都靠** `RELAY_FAILOVER_COOLDOWN_MS` **置 0**）
 *   **已整体移除** —— 该值已判「**看似合法**（`num()` 的 `/^\d+$/` 放行 `'0'`）、**实际自锁**」：归零会让
 *   "失败候选必须被排除"一并失效 ⇒ 候选链卡在第一个失败候选（实测 **121–123 s 无切换**）。
 *   ⇒ ⛔ **演练 / 回滚路径一律不许再出现该值**；要"强制冷却过期"只走 `DRILL_COOLDOWN_MS`（幕 4b 已覆盖）。
 *   ⚠️ 这两个场景名**现在被显式拒绝**（退出码 2）—— ⛔ 不许静默空跑（"0 项判定"会被误读成通过）。
 * - ⚠️ 幕 4 系列**会重启 Manager 单元**（为了确定的前置 + 施加 env 覆盖）；覆盖一律走
 *   `dsh_ai1net.service.d/zz-drill-override.conf` 这一个 drop-in，`finally` 里**删除 + 重启**回到生产值。
 *   🔴 **`RELAY_FAILOVER_COOLDOWN_MS` 的代码默认值恒为 `300000`**（D9）—— 演练期缩短只经
 *   **新键** `DRILL_COOLDOWN_MS`，⛔ 不改生产默认。
 *
 * ## ✳️ 首轮实测逼出来的三条设计修正（**诚实记录**）
 * 1. **前置状态必须归零**：首轮 幕1 判 FAIL，真因是 Manager 的当前通道**遗留在 106**（上一轮演练的余波）
 *    ⇒ 杀 47 对**它**毫无影响，"不切换"其实是**正确行为**。现在脚本先读"当前通道线索"，
 *    若它不在被杀入口上 ⇒ 记 **SKIP**（⛔ 不把"状态没归零"算成产品失败，也不假装 PASS）。
 * 2. **观察窗必须 ≥ 失效检测时延**：经 CF 的**静默失效**下，客户端要等**半开检测**（`2.5 × HB_SEC`）
 *    才进 `backoff`，首轮实测 `unhealthyForMs` 已到 47–63 s ⇒ 幕2 的 30 s 窗口**必然漏判**。
 *    改用 `DRILL_DETECT_BUDGET_MS`（⛔ 仍把"是否 ≤ `RELAY_FAILOVER_DEADLINE_MS`"如实报出来）。
 * 3. **`systemctl is-active` 在 inactive 时退出码 = 3** ⇒ `execFileSync` 会抛 ⇒ 首轮**中断在幕1 半路**
 *    且把 47 的 relay 留在停用态。凡是**读状态**的远端命令一律 `|| true`。
 *
 * ## 运行（🆕 序㊸：**cwd 不再受限**；⛔ 阈值零硬编码）
 * `node "<repo>/scripts/overlay-failover-drill.cjs" [--scene 1|2|3|all]`
 * ⚠️ **参数表定位已与 cwd 解耦**（从代码仓根 / 任意目录都可跑）：候选目录链 = `--table` ＞ `--dir`
 * ＞ `DSH_AI1NET_OVERLAY_TABLE_DIR` ＞ **注册文件**（缺省 `~/.dsh_ai1net/overlay-table-dir`）＞ `cwd` ＞ 脚本目录及上两级。
 * 🔴 `--scene trace` / `--scene sample` 的**明细落盘**仍按 `cwd` 写 `_中间产物_待清理/seq9-trace/`
 * （那两幕是取证子命令，⛔ 不是本条约的范围）。
 *
 * ⚠️ **本脚本会真停生产单元**（`dsh_ai1net-relay`）；`finally` 里**一律复原**（失败也复原）。
 */

'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 参数表文件名（⛔ 不写死日期数字）。 */
const TABLE_RE = /^参数表_覆盖网络_.+\.md$/
const KEY_RE = /^\|\s*`([A-Z0-9_]+)`\s*\|\s*([^|]*)\|/
const OBS_RE = /^\|\s*`(OBS-[0-9]+)`\s*\|\s*([^|]*)\|/
const KEY_ONLY_RE = /^`([A-Z0-9_]+)`$/

/* ─────────── 参数表装载（与 overlay-probe.cjs 同款；⛔ 脚本内无魔数） ─────────── */

/**
 * 🆕 **序㊸：参数表定位与 cwd 解耦**（与 `overlay-probe.cjs` **同款**，改动理由见该文件同名注释）。
 * 候选目录链 = `--table` ＞ `--dir` ＞ `DSH_AI1NET_OVERLAY_TABLE_DIR` ＞ **注册文件**
 * （`DSH_AI1NET_OVERLAY_TABLE_REGISTRY`，缺省 `~/.dsh_ai1net/overlay-table-dir`，一行一个目录、`#` 注释）
 * ＞ `cwd` ＞ 脚本自身目录及上两级。
 * 🔴 **"恰好 1 个才合法"保留且更严**：任一候选目录 ≥2 份 ⇒ 立即报错；跨目录合计 ≥2 份 ⇒ 也报错。
 * ⛔ 一份都没找到 ⇒ 报错并列出**搜过的目录**，⛔ **不取缺省**。
 */
function resolveTablePath(argv) {
  const argOf = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
  }
  const explicit = argOf('--table')
  if (explicit !== undefined) return explicit
  const registry = readTableRegistry()
  const out = []
  const push = (d) => {
    if (typeof d === 'string' && d.trim() !== '') out.push(path.resolve(d.trim()))
  }
  push(argOf('--dir'))
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

const cleanValue = (raw) => String(raw).replace(/[*`]/g, '').trim()

function loadTable(file) {
  const text = fs.readFileSync(file, 'utf8')
  const params = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (OBS_RE.test(line)) continue
    const k = KEY_RE.exec(line)
    if (k !== null && !params.has(k[1])) params.set(k[1], cleanValue(k[2]))
  }
  return { file, params }
}

function makeReaders(table) {
  const bad = []
  const need = (key) => {
    if (!table.params.has(key) || table.params.get(key) === '') {
      bad.push(key)
      return ''
    }
    return table.params.get(key)
  }
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

/* ─────────── 远端动作 ─────────── */

function ssh(port, target, command, timeoutMs) {
  return execFileSync('ssh', ['-p', String(port), '-q', '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', target, command], {
    encoding: 'utf8',
    timeout: timeoutMs,
  }).trim()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write(
      '用法：node scripts/overlay-failover-drill.cjs [--scene 1|2|3|4|4b|all] [--table <参数表.md>] [--dir <目录>]\n' +
        '      node scripts/overlay-failover-drill.cjs --trace [--since -6h|@<epoch>] [--out <json>]\n' +
        '  --trace = 序⑨：**只读**，从 journal 复现「杀中继 ⇒ 切流完成」的四段分解（检测/tick相位/白等/建连），\n' +
        '            ⛔ 不停 relay、不改 env；检测+白等 < 27.0 s ⇒ 分解被证伪（退出码 1）\n' +
        '  all  = 1|2|3|4（不含 4b —— 它会重启 Manager，须单独跑）\n' +
        '  4    = 序⑧ 构 A：D6 现场 ＋ 一跳豁免（2 秒内切回 47）\n' +
        '  4b   = 序⑧ 对照：豁免关 ⇒ D6 现场原样复现 ＋ 冷却过期后**自然**回归（缺陷时限）\n' +
        '  ⛔ 序⑩ 起 `4c` / `ctrl` 已移除（两者都依赖 `RELAY_FAILOVER_COOLDOWN_MS` 置 0 = 自锁值，见文件头）\n',
    )
    return EXIT_USAGE
  }
  const sceneArg = (() => {
    const i = argv.indexOf('--scene')
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : 'all'
  })()
  /**
   * ⛔ **序⑩：已移除的场景显式报错** —— 靠 `RELAY_FAILOVER_COOLDOWN_MS` 置 0 的两个对照场景（`4c` / `ctrl`）
   * 已整体删除。⛔ **不许静默空跑**（那会产出"0 项判定"，被人误读成通过）。
   */
  if (['4c', 'ctrl'].includes(sceneArg)) {
    process.stderr.write(
      `❌ --scene ${sceneArg} 已于序⑩ 移除：它依赖 RELAY_FAILOVER_COOLDOWN_MS 置 0（已判"看似合法、实际自锁"）——\n` +
        `   归零会让「失败候选必须被排除」失效 ⇒ 候选链卡死（实测 121–123 s 无切换）。\n` +
        `   要缩短冷却请用 --scene 4b（走 DRILL_COOLDOWN_MS，属非生产值）。\n`,
    )
    return EXIT_USAGE
  }

  let r
  try {
    r = makeReaders(loadTable(resolveTablePath(argv)))
  } catch (err) {
    process.stderr.write(`❌ 参数表装载失败：${err.message}\n`)
    return EXIT_USAGE
  }

  const sshPort = r.num('SSH_PORT')
  const sshTo = r.num('SSH_TIMEOUT_MS')
  const h47 = r.need('SSH_TARGET_47')
  const h106 = r.need('SSH_TARGET_106')
  // ⚠️ 序㊳ 改名：`DRILL_RELAY_UNIT` → `RELAY_UNIT_NAME`（它记的是"两台机的 relay 单元名"这一
  // **事实**、并非演练专用坐标 —— 探针 `OBS-08` 也读它 ⇒ 原 `DRILL_` 前缀与用途不相称）。
  const relayUnit = r.need('RELAY_UNIT_NAME')
  const managerUnit = r.need('DRILL_MANAGER_UNIT')
  const deadlineMs = r.num('RELAY_FAILOVER_DEADLINE_MS')
  const pollMs = r.num('DRILL_POLL_MS')
  const observeMs = r.num('DRILL_COOLDOWN_OBSERVE_MS')
  const detectBudgetMs = r.num('DRILL_DETECT_BUDGET_MS')
  const killedMatch = r.need('DRILL_KILLED_MATCH')
  const drillCooldownMs = r.num('DRILL_COOLDOWN_MS')
  const noSwitchObserveMs = r.num('DRILL_NO_SWITCH_OBSERVE_MS')
  const portalUrl = r.need('PORTAL_URL')
  const portalHost = r.need('PORTAL_HOST_HEADER')
  if (r.bad.length > 0) {
    process.stderr.write(`❌ 参数表缺键／坏值：${r.bad.join(' , ')}\n`)
    return EXIT_USAGE
  }

  const results = []
  const record = (name, verdict, detail) => {
    results.push({ name, verdict })
    process.stdout.write(`${verdict} ${name} ${detail}\n`)
  }

  /**
   * 窗口起点 = **`@<epoch 秒>`**（journalctl 原生、**与时区无关**）。
   *
   * 🔴 **实测教训（序⑦ 第三轮，一条命令定案）**：`date -Is` 产出的 `2026-09-17T11:56:00+08:00`
   * 喂给 `journalctl --since` 会被判 **`Failed to parse timestamp`** ⇒ stdout 空 ⇒ `grep` 无命中
   * ⇒ 尾部 `|| true` 掩盖 ⇒ **所有窗口判定失真**：幕2-A / 幕3-A 成了**假绿**（空窗口被当"没切换"）、
   * 幕1-A / 幕2-B 成了**假红**（日志里明明有 `[relay-switch]` / `[relay-skip]`）。
   * 对照取证：`--since "2026-09-17T11:56:00+08:00"` → `lines=0 err=Failed to parse timestamp`；
   * `--since @1789617360` → `lines=2`；`--since -6h` → `lines=6170`。
   */
  const sinceNow = async () => `@${await ssh(sshPort, h47, 'date +%s', sshTo)}`

  /**
   * 自某时刻起的某类日志行（原文）。
   * - 尾部 `|| true`：`grep` 无命中退出码 1 不许把流程打断。
   * - 🔴 **`JOURNALCTL-ERR` 哨兵**：查询本身失败（时间戳解析不了 / 单元不存在）时**不再静默返回空**
   *   —— 「查询失败」与「确实没有该行」必须可区分，否则又是一次假绿。
   */
  const logSince = (since, kind) =>
    ssh(
      sshPort,
      h47,
      `o=$(journalctl -u ${managerUnit} --since ${since} --no-pager 2>&1) || { printf 'JOURNALCTL-ERR %s\\n' "$o"; exit 0; }; ` +
        `printf '%s\\n' "$o" | grep -F '${kind}' || true`,
      sshTo,
    )

  /**
   * 把 `JOURNALCTL-ERR` 哨兵剥出来 ⇒ `{ err, lines }`。
   * ⛔ `err !== ''` 时**一律不许**给出 PASS/FAIL —— 判据不可信就如实报"查询失败"。
   */
  const splitErr = (raw) => {
    const i = raw.indexOf('JOURNALCTL-ERR')
    if (i < 0) return { err: '', lines: raw }
    return { err: raw.slice(i).split('\n')[0].replace('JOURNALCTL-ERR', '').trim(), lines: '' }
  }

  /** ⚠️ `|| true` 是**必须的**：`is-active` 在 inactive 时退出码 3。 */
  const relayActive = (target) =>
    ssh(sshPort, target, `systemctl is-active ${relayUnit} || true`, sshTo)

  const stopRelay = (target) => ssh(sshPort, target, `systemctl stop ${relayUnit}`, sshTo)
  const startRelay = (target) => ssh(sshPort, target, `systemctl start ${relayUnit}`, sshTo)
  const portalCode = () =>
    ssh(
      sshPort,
      h47,
      `curl -s -o /dev/null -w '%{http_code}' --http1.1 -H ${JSON.stringify(`Host: ${portalHost}`)} ${portalUrl}`,
      sshTo,
    )

  /**
   * **当前通道线索** = 最近一条 `[relay-switch]` 的 `->` 目标；没有切换过 ⇒ 回落到最近一条
   * `[overlay-dir] 取址 = …：<url>` 的 url。⚠️ 它只是"线索"（用于**判定前置状态是否归零**），
   * 不是权威读数 —— 权威读数在进程内存里，本脚本不碰。
   */
  /**
   * **当前通道线索**（**仅供人读**，不参与判定）= 最近一条 `[relay-switch] -> X`；
   * 无切换过 ⇒ 回落最近一条 `[overlay-dir] 取址 = …：X`。
   *
   * 🔴 **两次踩坑记录（序⑦ 第四/五轮）**：
   * ① 改前实现"switch 与 取址 取较新者"是**语义错误** —— `取址` 是**目录解析结果**（每 2 s 刷一条、
   *    永远等于目录首位），**不是已建立的通道**；一旦发生切换，取址 就把线索带偏。
   * ② 只信 switch 也不够：**进程重启后首连不打 switch 日志**（通道 = 取址）⇒ 单独用 switch 会读到上一轮的旧值。
   * ⇒ **判定不再依赖日志线索**，改用 `lastManagerAuthOn()` 的权威读数；本函数只打印给人看。
   */
  const currentChannelHint = () => {
    const sw = splitErr(logSince('-6h', '[relay-switch]')).lines
    if (sw !== '') {
      const last = sw.split('\n').slice(-1)[0]
      const m = /->\s*(\S+?)（/.exec(last) ?? /->\s*(\S+)\s*$/.exec(last)
      if (m !== null) return m[1].trim()
    }
    const od = splitErr(logSince('-6h', '[overlay-dir] 取址')).lines
    const m2 = od === '' ? null : (/：(\S+?)（/.exec(od.split('\n').slice(-1)[0]) ?? /：(\S+)\s*$/.exec(od.split('\n').slice(-1)[0]))
    return m2 !== null && m2 !== undefined ? m2[1].trim() : ''
  }

  /**
   * **权威读数：Manager 最近一次在**某台**relay 上注册成功**的 epoch 秒（`-1` = 读不到/从未）。
   *
   * 🔑 **为什么必须问 relay 的日志**：Manager 是**拨出方**，它的当前通道在进程内存里，日志无法直接读。
   * 而 relay 侧每接受一次拨号就写一行 `[relay] AUTH OK host=ops/manager …`（带时间戳）⇒
   * **两台 relay 谁的时间戳更新，Manager 就在谁那儿**。
   *
   * ⛔ **不要用 relay `/status` 的 `dialers`**：实测它**会留陈旧条目**（序⑦ 第五轮：Manager 12:05:18
   * 已切走，47 的 `/status` 仍列 `dialers:["manager"]`，而 47 日志里最后一次 manager AUTH 停在 12:04:19）。
   */
  const lastManagerAuthOn = (target) => {
    const raw = splitErr(
      ssh(
        sshPort,
        target,
        `o=$(journalctl -u ${relayUnit} --since -6h -o short-unix --no-pager 2>&1) || { printf 'JOURNALCTL-ERR %s\\n' "$o"; exit 0; }; ` +
          `printf '%s\\n' "$o" | grep -E 'AUTH OK host=ops/manager' | tail -1 || true`,
        sshTo,
      ),
    ).lines
    if (raw === '') return -1
    const t = Number.parseFloat(raw.split(/\s+/)[0])
    return Number.isFinite(t) ? t : -1
  }

  /** 等一条**新的** `[relay-switch]` 行（≤ budget），返回 { ok, ms, lines, err }。 */
  const waitSwitch = async (since, budgetMs) => {
    const t0 = Date.now()
    for (;;) {
      const { err, lines } = splitErr(logSince(since, '[relay-switch]'))
      if (err !== '') return { ok: false, ms: Date.now() - t0, lines: '', err }
      if (lines !== '') return { ok: true, ms: Date.now() - t0, lines, err: '' }
      if (Date.now() - t0 >= budgetMs) return { ok: false, ms: Date.now() - t0, lines: '', err: '' }
      await sleep(pollMs)
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 序⑨ · `--trace`：把「杀中继 ⇒ 切流完成」的墙钟**拆成四段**（**只读**）
   *
   * 判据来源 = **现有日志行的时间戳**（D2）：⛔ 不停 relay / ⛔ 不改 env / ⛔ 不写远端文件。
   * 三行锚点切样本：
   *   ① `[relay-client] down (…(was up)); attempt #0 [graceful, burst window Nms]` = 样本起点 t_bye
   *   ② 其后第一条**不带方括号标签**的 `attempt #M, retry in …`（M ≥ 1）= burst 窗口耗尽 ⇒ 检测段结束
   *   ③ 其后**最后一条不带标签的 `attempt #1`** = **新候选客户端的第一条失败**（窗口内唯一能独立量出的
   *      "白等起点"：新客户端是全新实例 ⇒ 首败必为 `attempt #1` 且无标签；老通道那条 `attempt #1`
   *      正好等于 ② 本身，被排除）
   *   ④ 其后第一条 `[relay-skip] ⛔ 新通道起不来` = 放弃点 t_skip
   *   ⑤ 其后第一条 `[relay-switch]` = 样本终点 t_switch
   *
   * 四段：
   *   **检测**   = ② − ①（graceful burst 窗口地板，实测 15.0–16.6 s）
   *   **首试延迟** = ③ − ②（tick 相位 ＋ 拨号耗时，实测 0.4–3.0 s）
   *   **白等**   = ④ − ③（**实测**；作为对照也已知修前它 ≡ `upTimeoutMs`(12 s)）
   *   **建连**   = ⑤ − ④
   * 自洽校验：检测 ＋ 首试延迟 ＋ 白等 ＋ 建连 ≡ ⑤ − ①（≤ 0.05 s）。
   * 🔴 **两套签名两种判据**（同一个脚本同时认）：
   *   · **修前签名**（白等 ≥ 0.9 × `upTimeoutMs`）：`检测 ＋ 白等 < 27.0 s` ⇒ 分解被证伪（§1.2 可证伪条款）；
   *   · **修后签名**（白等 只剩"首败 → 放弃"）：`白等 ≤ 1.0 s` 且 `总长 ≤ RELAY_FAILOVER_DEADLINE_MS`。
   * ═══════════════════════════════════════════════════════════════════════════ */
  if (argv.includes('--trace')) {
    const argOf = (name) => {
      const i = argv.indexOf(name)
      return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
    }
    const since = argOf('--since') ?? '-6h'
    const upTimeoutMs = r.num('RELAY_FAILOVER_UP_TIMEOUT_MS')
    const raw = ssh(
      sshPort,
      h47,
      `o=$(journalctl -u ${managerUnit} --since ${since} -o short-unix --no-pager 2>&1) || { printf 'JOURNALCTL-ERR %s\\n' "$o"; exit 0; }; ` +
        `printf '%s\\n' "$o" | grep -E 'relay-client. down|relay-skip|relay-switch|relay-failover' || true`,
      sshTo,
    )
    const { err, lines } = splitErr(raw)
    if (err !== '') {
      process.stderr.write(`❌ 窗口查询失败（判据不可信，⛔ 不给出 PASS/FAIL）：${err}\n`)
      return EXIT_FAIL
    }
    const rows = lines
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => {
        const i = l.indexOf(']: ')
        return { t: Number.parseFloat(l.split(/\s+/)[0]), body: i < 0 ? l : l.slice(i + 3) }
      })
      .filter((x) => Number.isFinite(x.t))
    const isBye = (b) => b.includes('[relay-client] down') && b.includes('(was up)') && b.includes('burst window')
    const isBurstEnd = (b) => b.includes('[relay-client] down') && /attempt #\d+, retry in/.test(b)
    const isSkip = (b) => b.includes('[relay-skip]') && b.includes('新通道起不来')
    const isSwitch = (b) => b.includes('[relay-switch]')
    /**
     * **新候选客户端的第一条失败行**。
     *
     * 为什么它是"白等"的可靠起点：`open()` 里的新客户端是**全新**实例（`attempts=0`、无 burst 窗口）
     * ⇒ 它第一次拨号失败就 `attempts=1` 且**不带方括号标签** ⇒ 窗口内"最后一条不带标签的
     * `attempt #1`"就是它。⚠️ 老通道客户端在 burst 窗口耗尽时**也**会打一条 `attempt #1` ——
     * 但那条正好**等于 burst 耗尽行**（在窗口之外，被排除），所以不会混淆。
     * ⇒ 白等 = `t(放弃/早退) − t(新候选首败)`，**修前修后同一口径**（⛔ 不依赖"白等 ≡ upTimeoutMs"这条
     * 只在修前成立的定义式 —— 序⑨ S7 之后它已被修掉）。
     */
    const isFirstTry = (b) => b.includes('[relay-client] down') && /\battempt #1, retry in/.test(b)

    const samples = []
    for (let i = 0; i < rows.length; i += 1) {
      if (!isBye(rows[i].body)) continue
      const tBye = rows[i].t
      const idxOf = (from, pred) => {
        for (let k = from; k < rows.length; k += 1) if (pred(rows[k].body)) return k
        return -1
      }
      const iBurst = idxOf(i + 1, isBurstEnd)
      const iSkip = idxOf(i + 1, isSkip)
      const iSw = idxOf(i + 1, isSwitch)
      if (iBurst < 0 || iSkip < 0 || iSw < 0 || !(iBurst < iSkip && iSkip < iSw)) continue
      let iFirst = -1
      for (let k = iBurst + 1; k < iSkip; k += 1) if (isFirstTry(rows[k].body)) iFirst = k
      const tBurst = rows[iBurst].t
      const tSkip = rows[iSkip].t
      const tSw = rows[iSw].t
      const detect = tBurst - tBye
      const firstTry = iFirst < 0 ? null : rows[iFirst].t - tBurst
      /** 白等：有"新候选首败"行 ⇒ **实测**；没有 ⇒ 回落修前的定义式 `upTimeoutMs`（标注 `waitSrc`）。 */
      const wait = iFirst < 0 ? upTimeoutMs / 1000 : tSkip - rows[iFirst].t
      const waitSrc = iFirst < 0 ? '定义式' : '实测'
      const connect = tSw - tSkip
      const total = tSw - tBye
      const mUn = /unhealthyForMs=(\d+)/.exec(rows[iSw].body)
      const mAt = /attempts=(\d+)/.exec(rows[iSw].body)
      /** 🔴 修前的签名 = 死候选**白等吃满** `upTimeoutMs`（0.9× 余量），此时"检测+白等"的可证伪地板才成立。 */
      const prefixed = waitSrc === '定义式' || wait >= 0.9 * (upTimeoutMs / 1000)
      samples.push({
        tBye,
        tBurstEnd: tBurst,
        tFirstTry: iFirst < 0 ? null : rows[iFirst].t,
        tSkip,
        tSwitch: tSw,
        detect,
        firstTry,
        wait,
        waitSrc,
        connect,
        total,
        identityErr: (iFirst < 0 ? NaN : 0) + detect + (firstTry ?? 0) + wait + connect - total,
        unhealthyForMs: mUn === null ? null : Number.parseInt(mUn[1], 10),
        switchAttempts: mAt === null ? null : Number.parseInt(mAt[1], 10),
        prefixed,
        falsified: prefixed && detect + wait < 27.0,
        raw: [rows[i], rows[iBurst], ...(iFirst < 0 ? [] : [rows[iFirst]]), rows[iSkip], rows[iSw]].map(
          (x) => x.body,
        ),
      })
      i = iSw
    }

    const f = (x) => x.toFixed(3)
    const checkMs = r.num('RELAY_FAILOVER_CHECK_MS')
    /**
     * **只判"单跳样本"**：四段分解描述的是「杀入口 ⇒ 首个候选死 ⇒ 切到第二台」这一跳。
     * 三条同时成立才算：
     * ① **首试延迟** ∈ [0, `checkMs` ＋ 3.2 s]（= tick 相位 ＋ 拨号耗时；实测修前 0.3–1.4 s、
     *    修后 0.3–5.0 s —— 修后多出来的就是"等到新客户端真拨一次失败"的拨号＋重试耗时）；
     * ② 建连 ∈ [0, 10 s]（真跨机建连实测 2.7–5.2 s ⇒ >10 s 一定是"后续候选链推进"）；
     * ③ `unhealthyForMs`（切流行自带）与四段总长之差 ≤ 3 s（同一起点的两个独立读数；
     *    实测系统性偏移 0.7–2.2 s = 「BYE 行落盘」到「状态机记账」的差）。
     * ⛔ 不满足 = 判 `N/A`，**不许**把"候选链推进/回跳"错算成"白等/建连"。
     */
    const applicable = (s) =>
      s.firstTry !== null &&
      s.firstTry >= -0.05 &&
      s.firstTry <= checkMs / 1000 + 3.2 &&
      s.connect >= -0.05 &&
      s.connect <= 10 &&
      (s.unhealthyForMs === null || Math.abs(s.unhealthyForMs / 1000 - s.total) <= 3.0)
    const single = samples.filter(applicable)
    process.stdout.write(
      `\n# 序⑨ --trace｜目标 ${h47} · 单元 ${managerUnit}｜窗口 --since ${since}｜` +
        `样本数 ${samples.length}（单跳 ${single.length}）｜白等 = 新候选首败 → 放弃（实测）` +
        `｜修前签名判定阈值 = 白等 ≥ ${(0.9 * (upTimeoutMs / 1000)).toFixed(1)}s\n`,
    )
    process.stdout.write(
      `# 样本 | 检测 | 首试延迟 | 白等[口径] | 建连 | 总 | 自洽 | unhealthyForMs | 检测+白等\n`,
    )
    for (const s of samples) {
      process.stdout.write(
        `# ${s.tBye} | ${f(s.detect)} | ${f(s.firstTry ?? Number.NaN)} | ${f(s.wait)}[${s.waitSrc}] | ` +
          `${f(s.connect)} | ${f(s.total)} | ` +
          `${Math.abs(s.identityErr) <= 0.05 ? '✅' : `❌${f(s.identityErr)}`} | ${s.unhealthyForMs} | ` +
          `${f(s.detect + s.wait)}${applicable(s) ? (s.falsified ? ' 🔴证伪' : '') : ' ⚪N/A'}\n`,
      )
    }
    for (const s of samples) {
      const bad = []
      if (!applicable(s)) {
        process.stdout.write(
          `# ${s.tBye} N/A ⚪ 非单跳样本（首试延迟 ${f(s.firstTry ?? Number.NaN)} / 建连 ${f(s.connect)} ⇒ ` +
            `归因到后续候选链，⛔ 不计入四段分解）\n`,
        )
        continue
      }
      if (s.detect < 14.5) bad.push(`检测 ${f(s.detect)} < 15.0（burst 地板）`)
      if (s.detect > 17.0) bad.push(`检测 ${f(s.detect)} > 17.0（burst 地板 + 容差）`)
      if (Math.abs(s.identityErr) > 0.05) bad.push(`四段之和 ≠ 墙钟（差 ${f(s.identityErr)}）`)
      if (s.prefixed) {
        /* 修前签名：白等被 `upTimeoutMs` 吃满 ⇒ 用 §1.2 的可证伪地板 */
        if (s.falsified) bad.push(`检测+白等 ${f(s.detect + s.wait)} < 27.0 ⇒ 🔴 分解被证伪`)
      } else {
        /* 修后签名：白等应当只剩"首败 → 放弃"这一小段 ⇒ 判据换成"白等 ≤ 1 s 且总长 ≤ deadline" */
        if (s.wait > 1.0) bad.push(`白等 ${f(s.wait)} > 1.0 s（死候选应提前失败）`)
        if (s.total > deadlineMs / 1000) bad.push(`总长 ${f(s.total)} > deadline ${deadlineMs}ms`)
      }
      process.stdout.write(
        `# ${s.tBye} ${bad.length === 0 ? `PASS ✅ ${s.prefixed ? '修前签名（白等吃满 upTimeoutMs）' : '修后签名（死候选提前失败）'}` : `FAIL ❌ ${bad.join('；')}`}\n` +
          s.raw.map((l) => `#   · ${l}\n`).join(''),
      )
    }
    if (samples.length === 0) {
      process.stderr.write('❌ 窗口内无可切分的完整样本（⛔ 不给出 PASS/FAIL —— 先确认窗口里真有"杀中继 ⇒ 切流"两轮）\n')
      return EXIT_FAIL
    }
    const outDir = path.join(process.cwd(), '_中间产物_待清理', 'seq9-trace')
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = argOf('--out') ?? path.join(outDir, `seq9-trace-${Math.floor(Date.now() / 1000)}.json`)
    fs.writeFileSync(outFile, `${JSON.stringify({ since, h47, upTimeoutMs, samples }, null, 2)}\n`, 'utf8')
    const det = single.map((s) => s.detect).sort((a, b) => a - b)
    const wht = single.map((s) => s.wait).sort((a, b) => a - b)
    const tot = single.map((s) => s.total).sort((a, b) => a - b)
    const med = (xs) => (xs.length === 0 ? Number.NaN : xs[Math.floor(xs.length / 2)])
    const pre = single.filter((s) => s.prefixed).length
    process.stdout.write(
      `# 单跳样本统计（n=${single.length}，其中修前签名 ${pre} / 修后签名 ${single.length - pre}）：\n` +
        `#   检测      中位 ${f(med(det))} / 最小 ${f(det[0] ?? Number.NaN)} / 最大 ${f(det[det.length - 1] ?? Number.NaN)}\n` +
        `#   白等      中位 ${f(med(wht))} / 最小 ${f(wht[0] ?? Number.NaN)} / 最大 ${f(wht[wht.length - 1] ?? Number.NaN)}\n` +
        `#   总长      中位 ${f(med(tot))} / 最小 ${f(tot[0] ?? Number.NaN)} / 最大 ${f(tot[tot.length - 1] ?? Number.NaN)}\n` +
        `# 原始行已落盘：${outFile}\n`,
    )
    const bad = single.filter(
      (s) => Math.abs(s.identityErr) > 0.05 || s.falsified || (!s.prefixed && s.wait > 1.0),
    ).length
    return bad === 0 ? EXIT_OK : EXIT_FAIL
  }

  /* ═══════════════════════════════════════════════════════════════════════════
   * 序⑨ · `--sample N`：**N 次"杀入口 ⇒ 切流"采样**（S2 基线 / S7 复测共用一套动作）
   *
   * 每轮的**归零序列**（缺一即读数不可比）：
   *   ① 两台 relay `systemctl start` ② `systemctl restart dsh_ai1net`（⇒ 通道回到目录首位 = 47）
   *   ③ 等 47 的 **relay 日志**出现新的 `AUTH OK host=ops/manager`（权威就绪读数）
   *   ④ 记 `t0` → `systemctl stop dsh_ai1net-relay`（47）→ 等新的 `[relay-switch]`（≤ `DRILL_DETECT_BUDGET_MS`）
   * 读数口径：**切换耗时 = `waitSwitch` 的墙钟**（含 `DRILL_POLL_MS` 的 0–`pollMs` 量化误差，
   * 所以每轮**必须记录当时 `DRILL_POLL_MS`**；⚠️ 改过 `DRILL_POLL_MS` 前后的读数**不可混比**）。
   * 四段分解另由 `--trace` 从 journal 时间戳复算（⛔ 与这里的读数不互相替代）。
   * ⛔ 不施加任何演练 env 覆盖（尤其**不许把冷却归零** —— 归零连带废掉"失败候选必须被排除"，
   * 上单 §8.8-4 已实测其自锁后果；演练期要缩短冷却**只走 `DRILL_COOLDOWN_MS`**）。
   * ═══════════════════════════════════════════════════════════════════════════ */
  if (argv.includes('--sample')) {
    const argOf = (name) => {
      const i = argv.indexOf(name)
      return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined
    }
    const n = Number.parseInt(argOf('--sample') ?? String(r.num('DRILL_SAMPLE_N')), 10)
    if (!Number.isFinite(n) || n < 1) {
      process.stderr.write('❌ --sample 需要一个正整数（或用参数表 DRILL_SAMPLE_N）\n')
      return EXIT_USAGE
    }
    const authCountSince = (target, epoch) =>
      splitErr(
        ssh(
          sshPort,
          target,
          `o=$(journalctl -u ${relayUnit} --since @${epoch} -o short-unix --no-pager 2>&1) || { printf 'JOURNALCTL-ERR %s\\n' "$o"; exit 0; }; ` +
            `printf '%s\\n' "$o" | grep -c 'AUTH OK host=ops/manager' || true`,
          sshTo,
        ),
      ).lines.trim()

    process.stdout.write(
      `\n# 序⑨ --sample ${n}｜DRILL_POLL_MS=${pollMs}ms（⚠️ 读数含 0–${pollMs}ms 量化误差）｜` +
        `deadline=${deadlineMs}ms｜upTimeoutMs=${r.num('RELAY_FAILOVER_UP_TIMEOUT_MS')}ms\n` +
        `# 轮 | AUTH就绪ms | 切换ms | ≤deadline | 目标 | 行原文\n`,
    )
    const rounds = []
    try {
      for (let i = 1; i <= n; i += 1) {
        /* ① 归零：两台 relay 都起来 */
        await startRelay(h47)
        await startRelay(h106)
        /* ② 归零：重启 Manager ⇒ 通道回到目录首位（47） */
        const tRestart = Number.parseInt(await ssh(sshPort, h47, 'date +%s', sshTo), 10)
        await ssh(sshPort, h47, `systemctl restart ${managerUnit}`, sshTo)
        /* ③ 等"新的" AUTH OK（权威就绪读数） */
        const tAuth0 = Date.now()
        let authed = '0'
        for (;;) {
          authed = await authCountSince(h47, tRestart)
          if (authed !== '0' || Date.now() - tAuth0 >= detectBudgetMs) break
          await sleep(1000)
        }
        const authMs = Date.now() - tAuth0
        /* ④ 杀入口 ⇒ 等切换 */
        const t0 = Number.parseInt(await ssh(sshPort, h47, 'date +%s', sshTo), 10)
        await stopRelay(h47)
        const sw = await waitSwitch(`@${t0}`, detectBudgetMs)
        const last = sw.ok ? sw.lines.split('\n').slice(-1)[0] : ''
        const tgt = sw.ok ? ((/->\s*(\S+?)(（|$)/.exec(last) ?? [])[1] ?? '') : ''
        const row = {
          round: i,
          authed,
          authMs,
          switchMs: sw.ok ? sw.ms : null,
          withinDeadline: sw.ok ? sw.ms <= deadlineMs : false,
          target: tgt,
          err: sw.err,
          line: last,
        }
        rounds.push(row)
        process.stdout.write(
          `# ${i}/${n} | ${authMs} | ${sw.ok ? sw.ms : 'N/A'} | ${sw.ok ? (row.withinDeadline ? '✅' : '❌') : '❌'} | ` +
            `${tgt} | ${sw.err !== '' ? `❌窗口查询失败：${sw.err}` : last}\n`,
        )
        /* 复原（下一轮的 ① 会再 start 一次，幂等） */
        await startRelay(h47)
        await sleep(2_000)
      }
    } finally {
      try {
        await startRelay(h47)
        await startRelay(h106)
      } catch (err) {
        process.stderr.write(`❌ 复原 relay 失败：${err.message}\n`)
      }
    }
    const ok = rounds.filter((x) => x.withinDeadline && x.err === '')
    process.stdout.write(
      `\n# 采样结果：${ok.length}/${rounds.length} 在 deadline(${deadlineMs}ms) 内侧｜` +
        `切换耗时 min/中位/max = ${rounds.map((x) => x.switchMs).filter((x) => x !== null).sort((a, b) => a - b).join(' / ')}\n`,
    )
    const outDir = path.join(process.cwd(), '_中间产物_待清理', 'seq9-trace')
    fs.mkdirSync(outDir, { recursive: true })
    const outFile = argOf('--out') ?? path.join(outDir, `seq9-sample-${Math.floor(Date.now() / 1000)}.json`)
    fs.writeFileSync(outFile, `${JSON.stringify({ pollMs, deadlineMs, rounds }, null, 2)}\n`, 'utf8')
    process.stdout.write(`# 采样明细已落盘：${outFile}\n`)
    return ok.length === rounds.length && rounds.length === n ? EXIT_OK : EXIT_FAIL
  }

  /**
   * ⚠️ **序⑧ 起本脚本会重启 Manager 单元**（1 次/幕 4 变体）—— 目的是给幕 4 一个**确定的前置**
   * （重启 ⇒ 通道回到目录首位 = 47）并施加演练期 env 覆盖（D9）。`finally` 里**一律删覆盖**。
   */
  const DRILL_DROPIN = `/etc/systemd/system/${managerUnit}.service.d/zz-drill-override.conf`
  /** 是否留下过演练 env 覆盖 ⇒ `finally` 据此决定要不要"删文件 + 重启"回到生产值。 */
  let drillEnvApplied = false

  /**
   * 施加演练期 env 覆盖（D9）：**只走 drop-in**。
   *
   * 🔴 **为什么不改 `/etc/dsh_ai1net.env`**：那份文件是**平台自己的配置**（600/root，09-13 起的既有内容），
   * 演练去改它 = 把"演练"与"生产配置"耦合；drop-in 是**可整份删除**的独立单元 ⇒ 回滚 = `rm` 一行。
   * （本线既有规矩：env 改动一律走 drop-in —— cluster 配置就在 `dsh_ai1net.service.d/cluster.conf`。）
   *
   * ⛔ **生产默认值一个都不动**：`RELAY_FAILOVER_COOLDOWN_MS` 在代码里的默认仍是 `300000`；
   * 演练期要缩短只能通过**新键** `DRILL_COOLDOWN_MS`（它在参数表里，本函数只负责把它塞进 drop-in）。
   */
  const applyDrillEnv = (vars) => {
    const keys = Object.keys(vars)
    const body =
      '# 序⑧ 演练期 env 覆盖 —— 由 scripts/overlay-failover-drill.cjs 自动生成\n' +
      '# ⛔ 临时产物：删除本文件 + daemon-reload + restart 即回到生产值\n' +
      '[Service]\n' +
      keys.map((k) => `Environment="${k}=${vars[k]}"\n`).join('')
    /**
     * ⚠️ **heredoc 必须独占一行收尾**（`bodyEOF && cmd` 会让终止符变成 `bodyEOF && cmd` ⇒ 语法错误）
     * ⇒ 这里用**换行分隔**而不是 `&&` 串。
     */
    const remote =
      `mkdir -p "$(dirname ${DRILL_DROPIN})"\n` +
      (keys.length === 0 ? `rm -f ${DRILL_DROPIN}\n` : `cat > ${DRILL_DROPIN} <<"EOF"\n${body}EOF\n`) +
      `systemctl daemon-reload && systemctl restart ${managerUnit}\n`
    ssh(sshPort, h47, remote, sshTo)
    drillEnvApplied = keys.length > 0
  }

  /**
   * 删掉演练覆盖并**重启** ⇒ **回到生产值**（运行中的进程也一起回）。
   * ⚠️ 只删文件不重启 = 进程里仍是旧 env ⇒ "回滚"没生效。
   */
  const clearDrillEnv = () => {
    ssh(
      sshPort,
      h47,
      `rm -f ${DRILL_DROPIN}\nsystemctl daemon-reload && systemctl restart ${managerUnit}\n`,
      sshTo,
    )
    drillEnvApplied = false
  }

  /** 等门户 200（= Manager 起完了）。⚠️ 重启后前几秒必然拿不到 200，不是失败。 */
  const waitManagerReady = async (budgetMs) => {
    const t0 = Date.now()
    for (;;) {
      let pc = ''
      try {
        pc = await portalCode()
      } catch {
        pc = ''
      }
      if (pc === '200') return true
      if (Date.now() - t0 >= budgetMs) return false
      await sleep(pollMs)
    }
  }

  /** 归零：重启 Manager 并等它**确实注册在 47**（重启 ⇒ 通道回到目录首位）。 */
  const normalizeManagerOn47 = async (budgetMs) => {
    if ((await waitManagerReady(budgetMs)) === false) return false
    const t0 = Date.now()
    for (;;) {
      const a47 = await lastManagerAuthOn(h47)
      const a106 = await lastManagerAuthOn(h106)
      if (a47 > a106) return true
      if (Date.now() - t0 >= budgetMs) return false
      await sleep(pollMs)
    }
  }

  process.stdout.write(`# 参数表=${resolveTablePath(argv)}\n`)
  const hint = currentChannelHint()
  /**
   * **杀哪台 = 权威读数比对**（⛔ 原先硬编码只杀 47 ⇒ 单 §5-S7 的"杀 106"方向**从未被实测**；
   * 也⛔ 不再用日志线索猜 —— 见 `currentChannelHint` 的两次踩坑记录）。
   * 两台时间戳相等或都读不到 ⇒ **无法唯一确定** ⇒ SKIP（⛔ 不把"杀错了台"算成产品失败）。
   */
  const match106 = r.need('DRILL_SWITCH_MATCH_106')
  const t47 = await lastManagerAuthOn(h47)
  const t106 = await lastManagerAuthOn(h106)
  const killTarget = t47 > t106 ? h47 : t106 > t47 ? h106 : null
  const killMatch = killTarget === h106 ? match106 : killedMatch
  const otherTarget = killTarget === h47 ? h106 : h47
  process.stdout.write(
    `# 前置：Manager 最近注册 epoch 47=${t47} / 106=${t106} ⇒ 实际被杀 = ` +
      `${killTarget === null ? '(无法唯一确定 ⇒ SKIP)' : killTarget}` +
      `｜线索（仅人读）= ${hint === '' ? '(读不到)' : hint}\n`,
  )

  /**
   * 幕 1 的**场景体**（序⑧ 抽成函数）：断言只写这一份（⛔ 不许再抄第二份）。
   * ⚠️ 序⑩ 起 `--scene ctrl` 对照已被移除 ⇒ 本函数只有**一个**调用点（`all` / `1`）；
   * `suffix` 参数保留仅为结果行可读性（默认空串，不影响任何断言语义）。
   */
  const runScene1 = async (suffix = '') => {
    {
      if (killTarget === null) {
        record(
          `幕1-A 杀当前入口 ⇒ 在 deadline 内切到另一台${suffix}`,
          'SKIP',
          `⚠️ 无法唯一确定 Manager 当前在哪台（47 最近注册=${t47} / 106=${t106}）⇒ 杀任一台都可能是空操作，` +
            `本轮不作判定（归零办法：重启 ${managerUnit} ⇒ 通道回到目录首位，其 relay 会留下新的 AUTH 行）`,
        )
      } else {
        const since = await sinceNow()
        const before = await relayActive(killTarget)
        await stopRelay(killTarget)
        const after = await relayActive(killTarget)
        process.stdout.write(
          `# 幕1 前置：被杀 = ${killTarget}｜relay ${before} ⇒ ${after}｜窗口起 ${since}\n`,
        )
        const hit = await waitSwitch(since, detectBudgetMs)
        const last = hit.ok ? hit.lines.split('\n').slice(-1)[0] : ''
        const to = hit.ok ? (/(->\s*)(\S+?)(（|$)/.exec(last) ?? [])[2] : undefined
        const sameTarget = to !== undefined && to.includes(killMatch)
        const withinDeadline = hit.ok && hit.ms <= deadlineMs
        /**
         * 🔴 **无切换 ≠ 产品失败**：若同一窗口里判别器给出了"链里无其他候选"（D6 的原生证据），
         * 那"不切换"就是**设计预期行为** ⇒ 记 **SKIP**（⛔ 不假装 PASS，也不误报 FAIL）。
         * 实测来源（序⑦ 第五轮）：Manager 刚切到 106 后杀 106，唯一替代 47 **仍在 300 s 冷却窗内**
         * ⇒ `[relay-skip] … 链里无其他候选（候选 3 条，排除 3 条）` 刷了 120 s。
         */
        const noCand =
          !hit.ok && hit.err === ''
            ? (splitErr(logSince(since, '[relay-skip]'))
                .lines.split('\n')
                .find((l) => l.includes('无其他候选')) ?? '')
            : ''
        record(
          `幕1-A 杀当前入口 ⇒ 切到另一台（≠ 被杀入口）${suffix}`,
          hit.err !== ''
            ? 'FAIL'
            : noCand !== ''
              ? 'SKIP'
              : hit.ok && !sameTarget
                ? withinDeadline
                  ? 'PASS'
                  : 'FAIL'
                : 'FAIL',
          hit.err !== ''
            ? `❌ 窗口查询失败（判据不可信，⛔ 非产品结论）：${hit.err}`
            : noCand !== ''
              ? `⚠️ 窗口内无切换，但判别器给出「链里无其他候选」⇒ **D6 预期行为，⛔ 不算产品失败**（归零办法：等冷却期满再复跑）：${noCand}`
              : hit.ok
                ? `被杀 ${killTarget}｜耗时 ${hit.ms}ms（deadline ${deadlineMs}ms）｜目标 ${to}` +
                  (sameTarget ? ' ❌ 目标仍是被杀入口' : '') +
                  (withinDeadline ? '' : ' ⚠️ **超出 deadline**') +
                  `｜${last}`
                : `被杀 ${killTarget}｜❌ ${hit.ms}ms 内无 [relay-switch]、也无「无其他候选」证据`,
        )
        const mgr = await ssh(sshPort, h47, `systemctl is-active ${managerUnit} || true`, sshTo)
        record(`幕1-B Manager 自身仍存活（失败域分离）${suffix}`, mgr === 'active' ? 'PASS' : 'FAIL', `is-active=${mgr}`)
        const pc = await portalCode()
        record(`幕1-C 门户仍 200（业务面无人工干预恢复）${suffix}`, pc === '200' ? 'PASS' : 'FAIL', `http_code=${pc}`)
      }
      const rother = await relayActive(otherTarget)
      record(`幕1-D 另一台（${otherTarget}）的中继未被误动${suffix}`, rother === 'active' ? 'PASS' : 'FAIL', `is-active=${rother}`)
    }
  }

  try {
    /* ═══ 幕 1：杀"当前所在那台"⇒ 必须在 deadline 内切到**另一台** ═══ */
    if (sceneArg === 'all' || sceneArg === '1') await runScene1()

    /* ═══ 幕 2：两台全杀 ⇒ 无切换、无静默回退（D6 / R11） ═══ */
    if (sceneArg === 'all' || sceneArg === '2') {
      /**
       * 🔴 **序⑩：幕 2 不再依赖上一幕的余波** —— 本幕语义是"两台全杀"，但原实现**只停 106**：
       * 幕 1 已把 Manager 的通道切到 47（或单跑本幕时活跃的本就是 47）⇒ 停的是**当前不用**的那台
       * ⇒ 通道没被打断 ⇒ 窗口内 0 行判别器 ⇒ **幕2-B 假红**（序⑨ 实测：Manager 120 s 零 relay 日志）。
       * ⇒ 修法 = **现场重读一次权威通道归属**（与幕 1 同一套 `lastManagerAuthOn` 比对），再把**两台都停掉**
       * （幂等；已 inactive 的 `systemctl stop` 是空操作）⇒ 前置与"上一轮留下谁"彻底解耦。
       */
      const t47b = await lastManagerAuthOn(h47)
      const t106b = await lastManagerAuthOn(h106)
      const activeAtStart = t47b > t106b ? h47 : t106b > t47b ? h106 : null
      const since = await sinceNow()
      await stopRelay(h47)
      await stopRelay(h106)
      const a47 = await relayActive(h47)
      const a106 = await relayActive(h106)
      process.stdout.write(
        `# 幕2 前置：47 relay=${a47} / 106 relay=${a106}（两台全杀）｜` +
          `本幕开始时活跃通道 = ${activeAtStart === null ? '(两读数相同 ⇒ 无法唯一确定)' : activeAtStart}` +
          `（epoch 47=${t47b} / 106=${t106b}）｜窗口起 ${since}\n`,
      )
      // ⚠️ 观察窗必须 ≥ **半开检测**时延（`2.5 × HB_SEC`），否则必然漏判（首轮实测踩到）
      await sleep(detectBudgetMs)
      const sw = splitErr(logSince(since, '[relay-switch]'))
      const sk = splitErr(logSince(since, '[relay-skip]'))
      const qErr = sw.err !== '' ? sw.err : sk.err
      record(
        '幕2-A 两台全挂 ⇒ 无新切换（⛔ 不切到空）',
        qErr !== '' ? 'FAIL' : sw.lines === '' ? 'PASS' : 'FAIL',
        qErr !== ''
          ? `❌ 窗口查询失败（⛔ 空窗口不可当 PASS）：${qErr}`
          : sw.lines === ''
            ? `0 行 [relay-switch]（窗口 ${detectBudgetMs}ms）`
            : `❌ 出现：${sw.lines.slice(0, 300)}`,
      )
      record(
        '幕2-B 留下「无候选 ⇒ 原地退避」的判别器证据（D6）',
        qErr !== '' ? 'FAIL' : sk.lines !== '' ? 'PASS' : 'FAIL',
        qErr !== ''
          ? `❌ 窗口查询失败：${qErr}`
          : sk.lines === ''
            ? '❌ 无 [relay-skip] 行（静默失效没有判别器）'
            : `首个：${sk.lines.split('\n')[0]}`,
      )
      const pc = await portalCode()
      record('幕2-C 门户仍 200（⛔ 不比现状更差 = R11 现场判据）', pc === '200' ? 'PASS' : 'FAIL', `http_code=${pc}`)
    }

    /* ═══ 幕 3：只恢复 47 ⇒ 冷却期内不回跳；随后复原 ═══ */
    if (sceneArg === 'all' || sceneArg === '3') {
      const since = await sinceNow()
      await startRelay(h47)
      await sleep(observeMs)
      const s3 = splitErr(logSince(since, '[relay-switch]'))
      record(
        `幕3-A 恢复 47 后 ${observeMs}ms 内不回跳（冷却期内）`,
        s3.err !== '' ? 'FAIL' : s3.lines === '' ? 'PASS' : 'FAIL',
        s3.err !== ''
          ? `❌ 窗口查询失败（⛔ 空窗口不可当 PASS）：${s3.err}`
          : s3.lines === ''
            ? `0 行 [relay-switch]（窗口 ${observeMs}ms < 冷却 ${r.num('RELAY_FAILOVER_COOLDOWN_MS')}ms）`
            : `❌ 出现：${s3.lines.slice(0, 300)}`,
      )
    }

    /* ═══ 幕 4（序⑧）：**冷却语义拆分**的真机判据（E9 / 构 A） ═══
     *
     * 立项依据（上单 §8.8-4）：生产目录 3 条候选里 **2 条同机**（`<base-domain>` + `relay-direct.<base-domain>`
     * 都在 47）⇒ 一次 47 故障会把它们**同时**耗进冷却 ⇒ 杀另一台时"唯一可能的出路"被自己设的冷却挡住
     * ⇒ 真机读数 `仍在冷却（剩 59201ms / 共 300000ms）` ⇒ **最长 ~300 s 不切流**。
     *
     * 序列：① 归零（重启 Manager ⇒ 通道回目录首位 47）→ ② 停 47 ⇒ 切 106
     *      （manager 的**两条**候选各按自己的原因进冷却：`relay-direct` = open-failed，`<base-domain>` = switched-away）
     *      → ③ 恢复 47 → ④ 停 106 ⇒ 此刻"当前挂了 + 所有候选都在冷却" = **D6 现场**。
     *
     * 🔴 **2026-09-19 域迁 `<base-domain>` 修正**：本幕判定"目标是不是 47 那台"原先**写死** `<legacy-domain>`，
     *    域一切就恒判失败（**假红**：豁免实际已生效并切回 47，仅字面匹配不上）。
     *    ⇒ 现一律改用参数表的 `DRILL_KILLED_MATCH`（= 目录 `relays[]` 首位的 host），
     *    ⛔ 不再在脚本里写死域名 —— 下次换域只改参数表一处。
     *
     * ⚠️ 本幕**会重启 Manager**（为了①的确定性 + 施加演练期覆盖）；`finally` 一律清覆盖并重启回生产值。
     */
    const runScene4 = async (variant) => {
      const isB = variant === '4b'
      const tag = isB ? '幕4b(豁免关+短冷却)' : '幕4'
      /** ⛔ 序⑩ 起只剩两个变体：构 A（**零 env 覆盖**）与 4b（豁免关 ＋ **非生产**短冷却 `DRILL_COOLDOWN_MS`）。 */
      const overlay = isB
        ? { RELAY_FAILOVER_EXEMPT: '0', RELAY_FAILOVER_COOLDOWN_MS: String(drillCooldownMs) }
        : {}
      await applyDrillEnv(overlay)
      /**
       * ⚠️ **必须先确保两台 relay 都 active** —— 幕 4 的 ② 步要求"停 47 ⇒ 切到 **106**"，
       * 而 `--scene all` 里前面的**幕 2 已经把 106 停掉**、幕 3 只恢复 47
       * ⇒ 不补这一步，幕 4 会在"三条候选全死"下走成假失败（首轮实测踩到）。
       */
      const ensureRelay = async (target) => {
        if ((await relayActive(target)) !== 'active') {
          await startRelay(target)
          process.stdout.write(`# ${tag} 前置：${target} ${relayUnit} 原为 inactive ⇒ 已拉起（${await relayActive(target)}）\n`)
        }
      }
      await ensureRelay(h47)
      await ensureRelay(h106)
      const on47 = await normalizeManagerOn47(detectBudgetMs)
      process.stdout.write(
        `# ${tag} 前置：env 覆盖=${JSON.stringify(overlay)}｜Manager 归零到 47 = ${on47}` +
          `（⚠️ 含一次 Manager 重启）\n`,
      )
      if (!on47) {
        record(`${tag}-0 Manager 未在窗口内归零到 47`, 'SKIP', '⛔ 状态未归零 ⇒ 不作产品判定')
        return
      }

      // ② 停 47 ⇒ 期待切到 106；**47 的两条候选分别按 open-failed / switched-away 进冷却**
      const sinceA = await sinceNow()
      await stopRelay(h47)
      const hit1 = await waitSwitch(sinceA, detectBudgetMs)
      record(
        `${tag}-A 停 47 ⇒ 切到 106，且 47 的两条候选都进冷却（造出"候选池被耗干"的结构前提）`,
        hit1.err !== '' ? 'FAIL' : hit1.ok ? 'PASS' : 'FAIL',
        hit1.err !== ''
          ? `❌ 窗口查询失败（判据不可信）：${hit1.err}`
          : hit1.ok
            ? `耗时 ${hit1.ms}ms｜${hit1.lines.split('\n').slice(-1)[0]}`
            : `❌ ${hit1.ms}ms 内无 [relay-switch]（窗口 ${detectBudgetMs}ms）`,
      )

      // ③ 恢复 47（**必须在 ④ 之前**：否则"回跳"会撞上一条真的不可用通道，判据失去意义）
      await startRelay(h47)

      // ④ 停 106 ⇒ D6 现场
      const sinceB = await sinceNow()
      await stopRelay(h106)
      process.stdout.write(`# ${tag} ④ 已停 106（此刻 47 的两条候选仍在冷却）｜窗口起 ${sinceB}\n`)

      if (isB) {
        /* 幕 4b：**缺陷正面复现 + 时限**（豁免关、冷却被缩到 DRILL_COOLDOWN_MS） */
        await sleep(noSwitchObserveMs)
        const sw = splitErr(logSince(sinceB, '[relay-switch]'))
        const sk = splitErr(logSince(sinceB, '[relay-skip]'))
        const qErr = sw.err !== '' ? sw.err : sk.err
        const noCand = sk.lines.split('\n').find((l) => l.includes('无其他候选')) ?? ''
        record(
          `${tag}-A 关掉豁免 ⇒ **D6 现场**原样复现（判别器原文）`,
          qErr !== '' ? 'FAIL' : noCand !== '' ? 'PASS' : 'SKIP',
          qErr !== ''
            ? `❌ 窗口查询失败：${qErr}`
            : noCand !== ''
              ? `判别器原文：${noCand}`
              : '⚠️ 窗口内没拿到「链里无其他候选」行（可能是失效检测还没走完）⇒ 本项不作判定',
        )
        record(
          `${tag}-B 冷却未过期前**不切流**（= §8.8-4 缺陷本身；⛔ 这不是本单的产品失败）`,
          qErr !== '' ? 'FAIL' : sw.lines === '' ? 'PASS' : 'FAIL',
          qErr !== ''
            ? `❌ 窗口查询失败：${qErr}`
            : sw.lines === ''
              ? `0 行 [relay-switch]（观察窗 ${noSwitchObserveMs}ms < 演练冷却 ${drillCooldownMs}ms）`
              : `❌ 出现：${sw.lines.slice(0, 300)}`,
        )
        const hit3 = await waitSwitch(sinceB, drillCooldownMs + detectBudgetMs)
        const last3 = hit3.ok ? hit3.lines.split('\n').slice(-1)[0] : ''
        const m3 = hit3.ok ? (/->\s*(\S+?)(（|$)/.exec(last3) ?? [])[1] : undefined
        record(
          `${tag}-C 冷却过期后**自然**切回 47 ⇒ 归因收敛到"冷却语义"而非方向逻辑（E9-b 归因）`,
          hit3.err !== ''
            ? 'FAIL'
            : hit3.ok && m3 !== undefined && m3.includes(killedMatch)
              ? 'PASS'
              : 'FAIL',
          hit3.err !== ''
            ? `❌ 窗口查询失败：${hit3.err}`
            : hit3.ok
              ? `耗时 ${hit3.ms}ms（演练冷却 ${drillCooldownMs}ms）｜目标 ${m3}｜${last3}`
              : `❌ ${hit3.ms}ms 内仍无切换（预算 ${drillCooldownMs + detectBudgetMs}ms）`,
        )
      } else {
        /* 幕 4（构 A）：**必须在 deadline 内切回 47**，且带 `｜豁免` 标记（= 47 当时确在冷却的直接证据） */
        const hit2 = await waitSwitch(sinceB, detectBudgetMs)
        const last2 = hit2.ok ? hit2.lines.split('\n').slice(-1)[0] : ''
        const m2 = hit2.ok ? (/->\s*(\S+?)(（|$)/.exec(last2) ?? [])[1] : undefined
        const to47 = m2 !== undefined && m2.includes(killedMatch)
        const exemptMark = /｜豁免 kind=(switched-away|open-failed) 剩 \d+ms/.test(last2)
        const healthReason = last2.includes('原因：当前通道不健康')
        if (hit2.ok) process.stdout.write(`# ${tag} ④ 后的切换原文：${last2}\n`)
        record(
          `${tag}-A **一跳豁免**把通道切回 47（｜豁免 标记 = "47 当时确在冷却"的直接证据）`,
          hit2.err !== '' ? 'FAIL' : hit2.ok && to47 && exemptMark ? 'PASS' : 'FAIL',
          hit2.err !== ''
            ? `❌ 窗口查询失败（判据不可信）：${hit2.err}`
            : hit2.ok
              ? `耗时 ${hit2.ms}ms｜目标 ${m2}｜豁免标记=${exemptMark}` +
                (to47 ? '' : ' ❌ 目标不是 47 那台') +
                (exemptMark ? '' : ' ❌ 缺 `｜豁免` 标记')
              : `❌ ${hit2.ms}ms 内无 [relay-switch]`,
        )
        record(
          `${tag}-B 原因必须是 health 路径（E9③）：原文含「原因：当前通道不健康」`,
          hit2.err !== '' ? 'FAIL' : healthReason ? 'PASS' : 'FAIL',
          healthReason ? '✅' : `❌ 原文：${last2.slice(0, 260)}`,
        )
        record(
          `${tag}-C 切换耗时 ≤ RELAY_FAILOVER_DEADLINE_MS`,
          hit2.err !== '' ? 'FAIL' : hit2.ok && hit2.ms <= deadlineMs ? 'PASS' : 'FAIL',
          `实测 ${hit2.ms}ms / deadline ${deadlineMs}ms` +
            `（⚠️ 该口径**含失效检测时延**；§8.8-2 已登记其为临界项）`,
        )
      }
      await startRelay(h106)
    }

    if (sceneArg === 'all' || sceneArg === '4') await runScene4('4')
    if (sceneArg === '4b') await runScene4('4b')
  } finally {
    /* ⛔ 一律复原（失败也复原）—— 首轮踩过"停半路把 relay 留在停用态"。 */
    /**
     * 序⑧：演练期的 env 覆盖**必须一并清掉**（否则 Manager 带着"豁免关 / 短冷却"继续跑 =
     * 静默的配置漂移）。⚠️ 只删文件不够：**进程里仍是旧 env** ⇒ 必须跟着重启一次。
     */
    if (drillEnvApplied) {
      try {
        await clearDrillEnv()
        const envv = await ssh(sshPort, h47, `systemctl show ${managerUnit} -p Environment | tr ' ' '\\n' | grep -c RELAY_FAILOVER || true`, sshTo)
        process.stdout.write(`# 复原：演练 env 覆盖已删 ＋ 已重启；残留 RELAY_FAILOVER_* 计数 = ${envv}（⚙️ 若为 0 说明回到生产值）\n`)
      } catch (err) {
        process.stderr.write(`❌ 清除演练 env 覆盖失败（🔴 请手工检查 ${DRILL_DROPIN}）：${err.message}\n`)
      }
    }
    const restore = async (target) => {
      try {
        if ((await relayActive(target)) !== 'active') {
          await startRelay(target)
          process.stdout.write(`# 复原：${target} ${relayUnit} ⇒ ${await relayActive(target)}\n`)
        }
      } catch (err) {
        process.stderr.write(`❌ 复原 ${target} 失败：${err.message}\n`)
      }
    }
    await restore(h47)
    await restore(h106)
  }

  const fails = results.filter((x) => x.verdict === 'FAIL')
  const skips = results.filter((x) => x.verdict === 'SKIP')
  process.stdout.write(
    `\n# 结果：${results.length - fails.length - skips.length} PASS / ${skips.length} SKIP / ${fails.length} FAIL` +
      (skips.length > 0 ? `；SKIP：${skips.map((f) => f.name).join(' / ')}` : '') +
      (fails.length > 0 ? `；FAIL：${fails.map((f) => f.name).join(' / ')}` : '') +
      '\n',
  )
  return fails.length === 0 ? EXIT_OK : EXIT_FAIL
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`❌ 演练异常：${err.stack ?? err.message}\n`)
    process.exit(EXIT_FAIL)
  })
