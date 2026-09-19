#!/usr/bin/env node
/**
 * 覆盖网络 序⑥ · S2/S5 一次性载荷与探针（⛔ 不进产品路径、⛔ 不进 package.json 依赖）。
 *
 * 为什么要有它：参数表 §3.5 的 `WAN_STEADY_THROUGHPUT` 与 §3.3 的 `PER_PLAYER_BW_LOCAL`
 * 都是 `待测` —— 两端都拿不到"可读大响应"（无凭据时只回 24–68 B 的 401/404）。
 * 本脚本只做一件事：**造可控载荷 + 量稳态速率**，供人工写回参数表。
 *
 * ## 四种角色
 * | 角色 | 跑在哪 | 干什么 |
 * |---|---|---|
 * | `--serve` | 被压的一端（106） | HTTP：`/blob?sec=N`（连续吐 N 秒）／`/blob?mb=N`／`POST /sink`（吞体） |
 * | `--download` | 挤压的一端（47） | 连 relay 回环端点 → 丢前 `--drop` 秒 → 量 `--secs` 秒 ⇒ **被压端 → 挤压端** |
 * | `--upload` | 挤压的一端（47） | 反向 POST 大流量（**尊重反压**）⇒ **挤压端 → 被压端** |
 * | `--echo-serve` / `--players` | 106 / 47 | S5 合成玩家：长度前缀回显 ＋ 多连接消息率扫描 |
 *
 * ## 口径（⛔ 别丢，写回参数表时要抄）
 * - 速率 = **稳态段字节数 ÷ 稳态段秒数**（前 `--drop` 秒的字节**单独计数、不进分子**）；
 * - `--upload` 的速率**必须**在 `write()` 返回 false 时停下等 `drain` —— 否则量的是 Node 的
 *   内存缓冲，不是链路（这正是"看起来很快、其实全在本地队列里"这个假象的成因）。
 *
 * 用法示例（远端）：
 *   node overlay-wan.cjs --serve --port 19777 --secs 600
 *   node overlay-wan.cjs --download --port <relay回环口号> --secs 30 --drop 3
 *   node overlay-wan.cjs --upload   --port <relay回环口号> --secs 30 --drop 3 --mb 0
 *
 * @module scripts/overlay-wan
 */

'use strict'

const http = require('node:http')
const net = require('node:net')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) out[k] = true
    else {
      out[k] = isNaN(Number(v)) ? v : Number(v)
      i++
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const log = (s) => process.stderr.write(`[wan] ${s}\n`)
const out = (obj) => process.stdout.write(`### RESULT ### ${JSON.stringify(obj)}\n`)

const CHUNK = Buffer.alloc(64 * 1024, 0x41)

// ─────────────────────────── serve ───────────────────────────
function serve(port, secs) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (req.method === 'POST') {
      // 吞体：只数不清
      let n = 0
      req.on('data', (c) => {
        n += c.length
      })
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
        res.end(`sink ${n}\n`)
        log(`POST /sink ${n} B in ${Date.now() - t0} ms`)
      })
      var t0 = Date.now()
      return
    }
    if (u.pathname === '/small') {
      res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' })
      res.end('ok-0123456789-0123456789\n')
      return
    }
    const sec = Number(u.searchParams.get('sec') || 0)
    const mb = Number(u.searchParams.get('mb') || 0)
    if (sec > 0) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' })
      const start = Date.now()
      let sent = 0
      const pump = () => {
        while (Date.now() - start < sec * 1000) {
          if (!res.write(CHUNK)) {
            sent += CHUNK.length
            res.once('drain', pump)
            return
          }
          sent += CHUNK.length
        }
        res.end()
        log(`GET /blob?sec=${sec} 送出 ${sent} B`)
      }
      pump()
      return
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' })
    const total = mb * 1024 * 1024
    let sent = 0
    const pump = () => {
      while (sent < total) {
        if (!res.write(CHUNK)) {
          sent += CHUNK.length
          res.once('drain', pump)
          return
        }
        sent += CHUNK.length
      }
      res.end()
    }
    pump()
  })
  server.listen(port, '127.0.0.1', () => log(`serve 127.0.0.1:${port} secs=${secs}`))
  if (secs > 0) setTimeout(() => process.exit(0), secs * 1000)
}

// ─────────────────────── download / upload ───────────────────────
/** 从 `buf` 里切掉 HTTP 头，返回剩下的体；找不到头返回 null。 */
function splitHeader(buf) {
  const i = buf.indexOf('\r\n\r\n')
  if (i < 0) return null
  return buf.subarray(i + 4)
}

function download(port, secs, drop) {
  const t0 = Date.now()
  const sock = net.connect(port, '127.0.0.1')
  let hdrDone = false
  let tail = Buffer.alloc(0)
  let ramp = 0
  let steady = 0
  sock.on('connect', () => {
    sock.write(
      `GET /blob?sec=${Math.ceil(secs + drop + 6)} HTTP/1.1\r\nHost: wan\r\nConnection: close\r\n\r\n`,
    )
  })
  const finish = () => {
    try {
      sock.destroy()
    } catch {
      /* noop */
    }
    out({
      mode: 'download',
      port,
      dropS: drop,
      steadyS: secs,
      rampBytes: ramp,
      steadyBytes: steady,
      steadyKBps: Math.round((steady / 1024 / secs) * 10) / 10,
      ms: Date.now() - t0,
    })
    process.exit(0)
  }
  sock.on('data', (b) => {
    if (!hdrDone) {
      tail = Buffer.concat([tail, b])
      const body = splitHeader(tail)
      if (body === null) return
      hdrDone = true
      b = body
    }
    const el = Date.now() - t0
    if (el < drop * 1000) ramp += b.length
    else if (el < (drop + secs) * 1000) steady += b.length
    else finish()
  })
  sock.on('error', (e) => {
    log(`sock error ${e.message}`)
    finish()
  })
  setTimeout(finish, (drop + secs + 20) * 1000)
}

function upload(port, secs, drop) {
  const t0 = Date.now()
  const sock = net.connect(port, '127.0.0.1')
  let ramp = 0
  let steady = 0
  let acc = 0
  let started = false
  const head =
    'POST /sink HTTP/1.1\r\nHost: wan\r\nContent-Type: application/octet-stream\r\n' +
    'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n'
  const frame = Buffer.concat([
    Buffer.from((CHUNK.length).toString(16) + '\r\n'),
    CHUNK,
    Buffer.from('\r\n'),
  ])
  const finish = () => {
    try {
      sock.destroy()
    } catch {
      /* noop */
    }
    out({
      mode: 'upload',
      port,
      dropS: drop,
      steadyS: secs,
      rampBytes: ramp,
      steadyBytes: steady,
      steadyKBps: Math.round((steady / 1024 / secs) * 10) / 10,
      ms: Date.now() - t0,
    })
    process.exit(0)
  }
  const pump = () => {
    const el = Date.now() - t0
    if (el >= (drop + secs) * 1000) return finish()
    let ok = true
    while (ok) {
      ok = sock.write(frame)
      if (el < drop * 1000) ramp += CHUNK.length
      else steady += CHUNK.length
      if (Date.now() - t0 >= (drop + secs) * 1000) break
    }
    if (!ok) sock.once('drain', pump)
    else setImmediate(pump)
  }
  sock.on('connect', () => {
    sock.write(head)
    started = true
    pump()
  })
  sock.on('error', (e) => {
    log(`sock error ${e.message}`)
    finish()
  })
  setTimeout(finish, (drop + secs + 30) * 1000)
}

// ─────────────────────── S5：合成玩家 ───────────────────────
function echoServe(port) {
  const server = net.createServer((c) => {
    c.setNoDelay(true)
    let buf = Buffer.alloc(0)
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 4) return
        const n = buf.readUInt32BE(0)
        if (buf.length < 4 + n) return
        const payload = buf.subarray(4, 4 + n)
        buf = buf.subarray(4 + n)
        c.write(payload)
      }
    })
    c.on('error', () => c.destroy())
  })
  server.listen(port, '127.0.0.1', () => log(`echo-serve 127.0.0.1:${port}`))
}

function p95(arr) {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]
}

function playOne(port, rate, secs, msgBytes, done) {
  const sentAt = []
  const rtts = []
  let sent = 0
  let recv = 0
  const sock = net.connect(port, '127.0.0.1')
  const frame = Buffer.alloc(4 + msgBytes, 0x42)
  frame.writeUInt32BE(msgBytes, 0)
  let buf = Buffer.alloc(0)
  let stopped = false
  const t0 = Date.now()
  const report = () => {
    if (stopped) return
    stopped = true
    const s = [...rtts].sort((a, b) => a - b)
    const half = rtts.map((x) => x / 2).sort((a, b) => a - b)
    done({
      sent,
      recv,
      lossPct: sent === 0 ? 0 : Math.round(((sent - recv) / sent) * 10000) / 100,
      rttP50: Math.round((s[Math.floor(s.length * 0.5)] || 0) * 10) / 10,
      rttP95: Math.round(p95(rtts) * 10) / 10,
      oneWayP50: Math.round((half[Math.floor(half.length * 0.5)] || 0) * 10) / 10,
      oneWayP95: Math.round(p95(half) * 10) / 10,
    })
  }
  sock.on('connect', () => {
    sock.setNoDelay(true)
    const timer = setInterval(() => {
      if (Date.now() - t0 > secs * 1000) {
        clearInterval(timer)
        sock.end()
        report()
        return
      }
      sentAt.push(Date.now())
      sock.write(frame)
      sent++
    }, Math.max(1, Math.round(1000 / rate)))
  })
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= msgBytes) {
      buf = buf.subarray(msgBytes)
      const t = sentAt[recv]
      if (t !== undefined) rtts.push(Date.now() - t)
      recv++
    }
  })
  sock.on('error', (e) => log(`player err ${e.message}`))
  sock.on('close', report)
}

function players(port, n, rate, secs, msgBytes) {
  const results = []
  let left = n
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      playOne(port, rate, secs, msgBytes, (r) => {
        results.push(r)
        if (--left === 0) {
          const agg = (k) => {
            const a = results.map((x) => x[k]).sort((x, y) => x - y)
            return a[Math.floor(a.length / 2)]
          }
          out({
            mode: 'players',
            players: n,
            rate,
            msgBytes,
            secs,
            perPlayerKBps: Math.round(((rate * msgBytes) / 1024) * 100) / 100,
            aggThroughputKBps: Math.round(((rate * msgBytes * n) / 1024) * 10) / 10,
            lossPctMax: Math.max(...results.map((r) => r.lossPct)),
            oneWayP50: agg('oneWayP50'),
            oneWayP95: agg('oneWayP95'),
          })
          process.exit(0)
        }
      })
    }, i * 60)
  }
}

// ─────────────────────────── main ───────────────────────────
if (args.serve) serve(args.port, args.secs || 0)
else if (args['echo-serve']) echoServe(args.port)
else if (args.download) download(args.port, args.secs, args.drop)
else if (args.upload) upload(args.port, args.secs, args.drop)
else if (args.players) players(args.port, args.players, args.rate, args.secs, args['msg-bytes'] || 200)
else {
  process.stderr.write('usage: --serve --port P [--secs N] | --download|--upload --port P --secs S --drop D | --echo-serve --port P | --players --port P --players N --rate R --secs S\n')
  process.exit(2)
}
