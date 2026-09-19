#!/usr/bin/env node
/**
 * 覆盖网络 序⑥ · S4 打洞可行性探测（⛔ 一次性脚本、不进产品路径）。
 *
 * ## 口径（🔴 本单最重要的一条已定项）
 * 本脚本测的是**「该网络能不能打洞」**（NAT 映射/过滤行为），
 * ⛔ **不是**"本系统打洞成功率" —— 仓库全仓零 UDP/穿透代码（`src/` 无 dgram/STUN），
 * 后者需要先有实现（见设计说明 §4.1-1）。
 *
 * ## 两个角色
 * - `--observer`（**跑在 47**，唯一具备公网直连观察面的一端）：绑两个 UDP 口
 *   （两个口是**故意的** —— 同一个 socket 发向两个不同目的口，若两次看到的源口相同 ⇒
 *   该 NAT 是**端点无关映射**（cone 型），这正是可打洞的主判据），登记 `name → ip:port`；
 * - `--probe`（跑在每个节点）：同一个 socket 依次 `REG` 到两个观察口 → 拿到**自己的两次映射**
 *   → 向观察口要 `PEERS` 表 → 向每个对端的映射每 `--gap` ms 发 1 包共 `--rounds` 包，
 *   全程收包 ⇒ 记录"收到了谁"。
 *
 * ## 判据
 * - 任一方收到对方 ≥ 1 包 ⇒ 该**方向**可打洞；逐对两方向分别记；
 * - `mappingX === mappingY` ⇒ 端点无关映射（cone）；不等 ⇒ 对称型（打洞概率低）；
 * - **包到达但被本机防火墙拦掉**与"对端没发出来"在数据上同形 ⇒ 因此每次实验都带
 *   **同机回环控制对**（47 的观察面自身既是 sender 也是 receiver，见 §8 的对照说明）。
 *
 * 用法：
 *   node overlay-holepunch.cjs --observer --port-x 21100 --port-y 21101 --token <t> --secs 90
 *   node overlay-holepunch.cjs --probe --obs <server-public-ip> --port-x 21100 --port-y 21101 \
 *        --token <t> --name w-dev --peers <host-a>u,<host-b>u
 *
 * @module scripts/overlay-holepunch
 */

'use strict'

const dgram = require('node:dgram')

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
const log = (s) => process.stderr.write(`[hp] ${s}\n`)
const out = (o) => require('node:fs').writeSync(1, `### RESULT ### ${JSON.stringify(o)}\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────── observer ───────────────────────────
function observer(portX, portY, token, secs) {
  /** name → { X: 'ip:port', Y: 'ip:port' } */
  const reg = {}
  const seen = []
  const socks = []
  const mk = (tag, port) => {
    const s = dgram.createSocket('udp4')
    s.on('error', (e) => log(`obs ${tag} error ${e.message}`))
    s.on('message', (msg, rinfo) => {
      const src = `${rinfo.address}:${rinfo.port}`
      const text = msg.toString('utf8')
      if (!text.startsWith(token)) {
        seen.push({ tag, src, text: text.slice(0, 40), at: Date.now() })
        return
      }
      const parts = text.split(' ')
      const cmd = parts[1]
      if (cmd === 'REG') {
        const name = parts[2]
        reg[name] = reg[name] || {}
        reg[name][tag] = src
        s.send(`${token} ACK ${tag} ${src}`, rinfo.port, rinfo.address)
      } else if (cmd === 'PEERS') {
        s.send(`${token} PEERS ${JSON.stringify(reg)}`, rinfo.port, rinfo.address)
      }
    })
    s.bind(port, '0.0.0.0', () => log(`observer ${tag} 绑 0.0.0.0:${port}`))
    socks.push(s)
  }
  mk('X', portX)
  mk('Y', portY)
  setTimeout(() => {
    out({ role: 'observer', reg, unauthenticated: seen.slice(0, 20), unauthenticatedCount: seen.length })
    process.exit(0)
  }, secs * 1000)
}

// ─────────────────────────── probe ───────────────────────────
async function probe(o) {
  const token = o.token
  const name = o.name
  const peers = String(o.peers || '').split(',').filter((s) => s !== '')
  const sock = dgram.createSocket('udp4')
  const receipts = {}
  const acks = {}
  let peersTable = null
  sock.on('error', (e) => log(`probe error ${e.message}`))
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf8')
    if (!text.startsWith(token)) return
    const parts = text.split(' ')
    const src = `${rinfo.address}:${rinfo.port}`
    if (parts[1] === 'ACK') acks[parts[2]] = parts[3]
    else if (parts[1] === 'PEERS') {
      try {
        peersTable = JSON.parse(text.slice(token.length + 7))
      } catch (e) {
        log(`PEERS 解析失败：${e.message}`)
      }
    } else if (parts[1] === 'PUNCH') {
      receipts[src] = (receipts[src] || 0) + 1
    }
  })
  await new Promise((r) => sock.bind(0, '0.0.0.0', r))
  const localPort = sock.address().port
  const to = (port) => new Promise((r) => sock.send(`${token} REG ${name}`, port, o.obs, r))

  for (let i = 0; i < 5; i++) {
    await to(o['port-x'])
    await sleep(200)
  }
  for (let i = 0; i < 5; i++) {
    await to(o['port-y'])
    await sleep(200)
  }
  for (let i = 0; i < 10 && peersTable === null; i++) {
    sock.send(`${token} PEERS ${name}`, o['port-x'], o.obs)
    await sleep(300)
  }
  if (peersTable === null) {
    out({ role: 'probe', name, localPort, error: 'no-peers-table', acks })
    process.exit(0)
  }
  const myX = (peersTable[name] || {}).X
  const myY = (peersTable[name] || {}).Y
  const targets = {}
  for (const p of peers) {
    const m = (peersTable[p] || {}).X
    if (m === undefined) continue
    targets[p] = m
  }
  const rounds = o.rounds || 10
  const gap = o.gap || 200
  const sent = {}
  for (const [p, addr] of Object.entries(targets)) {
    sent[p] = 0
    const [ip, port] = addr.split(':')
    for (let i = 0; i < rounds; i++) {
      sock.send(`${token} PUNCH ${name}`, Number(port), ip)
      sent[p]++
      await sleep(gap)
    }
  }
  await sleep(1500)
  const byPeer = {}
  for (const [p, addr] of Object.entries(targets)) {
    byPeer[p] = { target: addr, sent: sent[p], received: receipts[addr] || 0 }
  }
  const other = Object.entries(receipts).filter(([a]) => !Object.values(targets).includes(a))
  out({
    role: 'probe',
    name,
    localPort,
    mappingX: myX,
    mappingY: myY,
    mappingEndpointIndependent: myX !== undefined && myX === myY,
    peers: byPeer,
    receiptsFromUnexpected: other,
    acks,
  })
  process.exit(0)
}

// ─────────────────────────── STUN（降级路径） ───────────────────────────
/**
 * 🔴 **为什么需要降级**：首选路径（47 上一次性 UDP 观察器）**实测不可用** ——
 * 观察器零收包（连同机发出的包都收不到）⇒ 47 的**云安全组拦掉了 UDP 入站**
 * （⛔ 不是 nft：`nft` 的 `input policy` = `accept`）。改走公网 STUN 做映射/过滤判定。
 * ⛔ 按 S4 要求，用本模式得到的一切结论**必须在 §8 标注"经第三方"**。
 */
const MAGIC = 0x2112a442
function stunRequest(sock, host, port, cb) {
  const buf = Buffer.alloc(20)
  buf.writeUInt16BE(0x0001, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt32BE(MAGIC, 4)
  require('node:crypto').randomBytes(12).copy(buf, 8)
  let done = false
  const onMsg = (msg) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101) return
    let off = 20
    const end = 20 + msg.readUInt16BE(2)
    while (off + 4 <= end && off + 4 <= msg.length) {
      const type = msg.readUInt16BE(off)
      const len = msg.readUInt16BE(off + 2)
      const val = msg.subarray(off + 4, off + 4 + len)
      if ((type === 0x0020 || type === 0x0001) && val.length >= 8) {
        const family = val[1]
        const rawPort = val.readUInt16BE(2)
        const p = type === 0x0020 ? rawPort ^ (MAGIC >>> 16) : rawPort
        let ip
        if (family === 1) {
          ip = [...val.subarray(4, 8)].join('.')
          if (type === 0x0020) {
            const b = val.subarray(4, 8)
            const m = Buffer.alloc(4)
            m.writeUInt32BE(MAGIC, 0)
            ip = [...b].map((x, i) => x ^ m[i]).join('.')
          }
        }
        if (!done && ip !== undefined) {
          done = true
          sock.off('message', onMsg)
          cb({ server: `${host}:${port}`, mapping: `${ip}:${p}`, attr: type === 0x0020 ? 'XOR-MAPPED' : 'MAPPED' })
        }
        return
      }
      off += 4 + len + ((4 - (len % 4)) % 4)
    }
  }
  sock.on('message', onMsg)
  sock.send(buf, port, host)
  setTimeout(() => {
    if (!done) {
      done = true
      sock.off('message', onMsg)
      cb({ server: `${host}:${port}`, error: 'no-response' })
    }
  }, 4000)
}

const writeLine = (s) => require('node:fs').writeSync(1, `${s}\n`)

async function stun(o) {
  const sock = dgram.createSocket('udp4')
  await new Promise((r) => sock.bind(Number(o.bind || 0), '0.0.0.0', r))
  const localPort = sock.address().port
  const receipts = {}
  sock.on('message', (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`
    receipts[key] = (receipts[key] || 0) + 1
    writeLine(`RECV ${key} ${msg.length}B`)
  })
  const servers = String(o.stun || '')
    .split(',')
    .filter((s) => s !== '')
    .map((s) => {
      const [h, p] = s.split(':')
      return { h, p: Number(p) }
    })
  const mappings = []
  for (const s of servers) {
    // eslint-disable-next-line no-await-in-loop
    const r = await new Promise((res) => stunRequest(sock, s.h, s.p, res))
    mappings.push(r)
    writeLine(`MAPPING ${JSON.stringify(r)}`)
  }
  const nodes = [...new Set(mappings.filter((m) => m.mapping).map((m) => m.mapping))]
  writeLine(`### MAPPING ### ${JSON.stringify({ name: o.name, localPort, mappings, distinctMappings: nodes })}`)

  const to = typeof o.to === 'string' ? o.to.split(',').filter((s) => s !== '') : []
  let sent = 0
  for (const target of to) {
    const [ip, port] = target.split(':')
    for (let i = 0; i < (o.rounds || 10); i++) {
      sock.send(`${o.name || 'probe'} PUNCH`, Number(port), ip)
      sent++
      // eslint-disable-next-line no-await-in-loop
      await sleep(o.gap || 200)
    }
    writeLine(`SENT ${(o.rounds || 10)} -> ${target}`)
  }
  await sleep((o.listen || 20) * 1000)
  out({
    role: 'stun',
    name: o.name,
    localPort,
    mappings,
    endpointIndependentMapping: nodes.length === 1,
    distinctMappings: nodes,
    punchedTo: to,
    punchesSent: sent,
    receipts,
    via: 'third-party STUN（降级路径）',
  })
  process.exit(0)
}

if (args.observer) observer(args['port-x'], args['port-y'], args.token, args.secs || 90)
else if (args.probe) probe(args)
else if (args.stun) stun(args)
else {
  process.stderr.write('usage: --observer --port-x N --port-y N --token T --secs S | --probe --obs H --port-x N --port-y N --token T --name N --peers a,b | --stun --name N [--bind P] --stun s1:p1,s2:p2 [--to ip:port] [--listen S]\n')
  process.exit(2)
}
