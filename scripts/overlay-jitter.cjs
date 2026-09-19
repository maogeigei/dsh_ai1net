#!/usr/bin/env node
/**
 * 覆盖网络 序⑥ · S3 链路抖动与 RTT 口径校验（⛔ 一次性脚本、不进产品路径）。
 *
 * ## 为什么需要它
 * 参数表把 `RELAY_RTT_W106 = 336 ms` 标成"实测"，但它其实来自 `server.ts:810` 的
 * **心跳往返**（一次 WS 往返 ＋ 应用层处理 ＋ 验签）⇒ **不一定等于网络 RTT**。
 * 而 336 ms 目前是"跨云链路很差"的**唯一证据** ⇒ 若它是口径问题，后面所有
 * "跨云不可玩"的结论都要重判。本脚本做**三方对比**：ICMP ／ TCP 握手 ／ relay 心跳。
 *
 * ## 序㉖ 增补：`--watch` **持续采样**（点测 → 连续观测）
 *
 * 序㉖ 的选路主序是 **jitter**（`src/net/relay/jitter.ts`）⇒ 运维侧必须能**连续**看每条候选
 * 路径的 jitter，否则"选路按 jitter"这件事在生产上是**不可见证**的。
 *
 * 🔴 **本脚本⛔ 不自带统计实现**：它 `require('../lib/net/relay/jitter.js')` 复用
 * `absDeltas` / `percentile` / `histogram` / `JitterTracker` / `orderByJitter` /
 * `pickJitterTarget` —— 与产品路径**同一份算法、同一份阈值（`JITTER_*` env）**。
 * 本线教训：「另一份实现 = 另一处静默失效」（取址链踩过两次）。
 *
 * 用法：
 *   node overlay-jitter.cjs --icmp <peer-public-ip> --count 300 --interval 0.2
 *   node overlay-jitter.cjs --tcp <peer-public-ip>:22 --tcp-n 30
 *   node overlay-jitter.cjs --icmp H --count 300 --tcp H:22 --tcp-n 30     # 两者一起跑
 *   node overlay-jitter.cjs --watch --targets <peer-public-ip>:22,<server-public-ip>:22 --rounds 40 --gap 400
 *
 * @module scripts/overlay-jitter
 */

'use strict'

const net = require('node:net')
const { spawnSync } = require('node:child_process')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) out[k] = true
    else {
      out[k] = isNaN(Number(v)) || v === '' ? v : Number(v)
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const log = (s) => process.stderr.write(`[jit] ${s}\n`)
const out = (o) => process.stdout.write(`### RESULT ### ${JSON.stringify(o)}\n`)

function pct(arr, p) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 100) / 100
}

function icmp(host, count, interval) {
  const win = process.platform === 'win32'
  const argv = win
    ? ['-n', String(count), '-w', '1000', host]
    : ['-c', String(count), '-i', String(interval || 0.2), '-W', '1', host]
  const r = spawnSync(win ? 'ping' : 'ping', argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const text = `${r.stdout || ''}`
  const rtts = []
  const re = win ? /time[=<]([\d.]+)\s*ms/gi : /time=([\d.]+)\s*ms/gi
  let m
  while ((m = re.exec(text)) !== null) rtts.push(Number(m[1]))
  if (rtts.length < 2) return { host, packets: rtts.length, error: 'no-rtt-samples', raw: text.slice(0, 300) }
  const deltas = []
  for (let i = 1; i < rtts.length; i++) deltas.push(Math.abs(rtts[i] - rtts[i - 1]))
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length
  const mdev = Math.sqrt(rtts.reduce((a, b) => a + (b - avg) ** 2, 0) / rtts.length)
  return {
    host,
    packets: rtts.length,
    sentExpected: count,
    lossPct: Math.round(((count - rtts.length) / count) * 10000) / 100,
    min: pct(rtts, 0),
    avg: Math.round(avg * 100) / 100,
    p50: pct(rtts, 0.5),
    max: pct(rtts, 1),
    mdev: Math.round(mdev * 100) / 100,
    p95AbsDelta: pct(deltas, 0.95),
    p50AbsDelta: pct(deltas, 0.5),
    note_win: win ? 'windows ping：无 -i 间隔参数，实际约 1 包/秒' : undefined,
  }
}

function tcpHandshake(host, port, n) {
  const rtts = []
  let left = n
  return new Promise((resolve) => {
    const one = () => {
      const t = process.hrtime.bigint()
      const s = net.connect(port, host)
      const done = (ok) => {
        if (ok) rtts.push(Number(process.hrtime.bigint() - t) / 1e6)
        s.destroy()
        if (--left <= 0) {
          resolve({
            target: `${host}:${port}`,
            samples: rtts.length,
            min: pct(rtts, 0),
            median: pct(rtts, 0.5),
            p95: pct(rtts, 0.95),
            max: pct(rtts, 1),
          })
          return
        }
        setTimeout(one, 100)
      }
      s.setTimeout(5000)
      s.on('connect', () => done(true))
      s.on('error', () => done(false))
      s.on('timeout', () => done(false))
    }
    one()
  })
}

/**
 * 单次 TCP 握手 RTT（ms）；失败 ⇒ `undefined`（**不记 0** —— 0 会被当成"极稳"污染排序）。
 * ⚠️ 这是 I/O，不是统计；统计一律交给 `lib/net/relay/jitter.js`。
 */
function tcpSampleOnce(host, port) {
  return new Promise((resolve) => {
    const t = process.hrtime.bigint()
    const s = net.connect(port, host)
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      s.destroy()
      resolve(v)
    }
    s.setTimeout(5000)
    s.on('connect', () => done(Number(process.hrtime.bigint() - t) / 1e6))
    s.on('error', () => done(undefined))
    s.on('timeout', () => done(undefined))
  })
}

/**
 * 序㉖ `--watch`：**持续采样 + 按产品同一份算法给出选路序**。
 *
 * 输出里的 `order` 就是 `orderByJitter()` 的结果 ⇒ 与 `directory.ts` 生产选路**同函数**。
 */
async function watch(targetsRaw, rounds, gap) {
  const path = require('node:path')
  const J = require(path.join(__dirname, '..', 'lib', 'net', 'relay', 'jitter.js'))
  const th = J.jitterThresholds()
  const tracker = new J.JitterTracker(th)
  const urls = targetsRaw.map((s) => String(s))
  const counters = new Map(urls.map((u) => [u, { ok: 0, fail: 0, rtts: [] }]))
  const N = Math.max(2, rounds || 40)

  for (let r = 0; r < N; r++) {
    for (const u of urls) {
      const [h, p] = u.split(':')
      const rtt = await tcpSampleOnce(h, Number(p || 22))
      const c = counters.get(u)
      if (rtt === undefined) c.fail += 1
      else {
        c.ok += 1
        c.rtts.push(Math.round(rtt * 100) / 100)
        tracker.record(u, rtt)
      }
    }
    if (gap > 0 && r < N - 1) await new Promise((res) => setTimeout(res, gap))
  }

  const per = {}
  for (const u of urls) {
    const c = counters.get(u)
    const st = tracker.stats(u)
    const sorted = [...c.rtts].sort((a, b) => a - b)
    per[u] = {
      samples: c.ok,
      failed: c.fail,
      rttMedianMs: sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)],
      rttP95Ms: sorted.length === 0 ? undefined : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      /** ⚠️ `undefined` = 差分样本 < `JITTER_MIN_SAMPLES` ⇒ **未知**，⛔ 不当 0 用。 */
      jitterMs: st === undefined ? undefined : st.p95AbsDeltaMs,
      deltas: st === undefined ? 0 : st.deltas,
      hist: st === undefined ? undefined : st.hist,
    }
  }

  const order = J.orderByJitter(urls, tracker)
  const first = order[0]
  const curJ = per[first] && per[first].jitterMs
  const pick =
    curJ === undefined
      ? undefined
      : J.pickJitterTarget({ urls, tracker, curUrl: first, curJitterMs: curJ, switchMs: th.switchMs })

  return {
    probe: 'tcp-handshake',
    thresholds: th,
    rounds: N,
    gapMs: gap,
    targets: per,
    order: [...order],
    /** 主判据 E1 的读法：`order` 首位 = jitter 最低者（**可能与 RTT 最低者不是同一条**）。 */
    e1: {
      curUrl: first,
      curJitterMs: curJ,
      rttLowestUrl: urls.slice().sort((a, b) => (per[a].rttMedianMs ?? 1e9) - (per[b].rttMedianMs ?? 1e9))[0],
      note: 'order 首位由 jitter 决定；若 rttLowestUrl !== order[0] ⇒ 直接印证"看 jitter 不看 RTT"',
      wouldSwitchTo: pick === undefined ? null : pick,
    },
  }
}

async function main() {
  const res = { host: require('node:os').hostname(), platform: process.platform }
  if (args.icmp) res.icmp = icmp(String(args.icmp), args.count || 300, args.interval)
  if (args.tcp) {
    const [h, p] = String(args.tcp).split(':')
    res.tcpHandshake = await tcpHandshake(h, Number(p || 22), args['tcp-n'] || 30)
  }
  if (args.watch) {
    if (typeof args.targets !== 'string') {
      log('--watch 需要 --targets host:port[,host:port...]')
      process.exit(2)
    }
    res.watch = await watch(args.targets.split(','), args.rounds, args.gap === undefined ? 400 : args.gap)
  }
  out(res)
  process.exit(0)
}

main()
