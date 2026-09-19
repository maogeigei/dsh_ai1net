/**
 * relay 传输层 —— **最小 WebSocket 服务端帧（RFC 6455 子集）** ＋ **多路复用帧**。
 *
 * ## 为什么手写而不是引 `ws`
 * 全仓依赖表里没有 `ws`（`package.json` 只有 fastify / better-sqlite3 / pg / rate-limit / static）；
 * Node 22 内建的 `WebSocket` **只有客户端实现**。为此给整个平台加一个生产依赖，与
 * 「relay 只是一个可选单元」（传输方案 §10.2 第 5 点）的定位不符 ⇒ 服务端手写最小帧层。
 * **不自造密码学**：握手 SHA-1 与上层 MAC 全用 `node:crypto`，这里只做字节搬运。
 *
 * ## 支持的子集（边界写死，超出一律按协议错误关闭 —— 不留"说不清的行为"）
 * | 支持 | 不支持 ⇒ 行为 |
 * |---|---|
 * | binary / text / close / ping / pong | 其它 opcode ⇒ `1003` |
 * | 连续分片重组（上限 `maxMessageBytes`，默认 4 MiB） | RSV 置位（未协商扩展）⇒ `1002` |
 * | 7 / 16 / 64 位负载长度 | 单帧超上限 ⇒ `1009` |
 * | 客户端必须 mask（RFC 6455 §5.1） | 未 mask ⇒ `1002` |
 * | 服务端发出的帧**不 mask**（省一次全量拷贝） | permessage-deflate ⇒ 从不协商 |
 *
 * ## 多路复用帧（relay 内层，跑在 WS 的 binary 帧里）
 * ```text
 *  0        1                5                      N
 * +--------+----------------+----------------------+
 * | type   |  streamId BE32 |  payload (N-5 bytes) |
 * +--------+----------------+----------------------+
 * ```
 * 固定 5 字节头（而非 JSON 每包）是**性能**上的选择：小包场景下省掉 JSON 解析与字符串分配。
 *
 * @module dsh_ai1net/net/relay/wire
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

const EMPTY = Buffer.alloc(0)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/* ═══════════════════ 1. mux 帧 ═══════════════════ */

/** relay 内层帧类型。**新增类型必须同时改 server 与 client 的 switch，未知类型一律关连接**。 */
export const MUX = {
  /** client → server：带 MAC 的注册请求（**未注册前只允许发这一种**）。 */
  HELLO: 0x01,
  /** server → client：注册结果（`sessionId` / `accepted` / 心跳间隔）。 */
  HELLO_ACK: 0x02,
  /** server → client：请求为 `streamId` 打开一条到 client 本地 `port` 的连接。 */
  OPEN: 0x03,
  /** client → server：`OPEN` 的结果（`ok` / `error`）—— **没有它就不算就绪**。 */
  OPEN_ACK: 0x04,
  /** 双向：某个流的原始字节。 */
  DATA: 0x05,
  /** 双向：关闭某个流（`reason`）。 */
  CLOSE: 0x06,
  /** 双向：应用层心跳（内建 WebSocket 不暴露 WS ping，故放在 mux 层）。 */
  PING: 0x07,
  /** 双向：心跳回应。 */
  PONG: 0x08,
  /**
   * server → client：**注册被拒的结构化原因**（`reason` / `detail` / `serverTime` / `fatal`）。
   *
   * 为什么要单独一帧而不是只用 WS close reason：client 必须能区分
   * **「重试就能好」**（`clock-skew` ⇒ 用 `serverTime` 校正后立刻重试）与
   * **「重试一万次也没用」**（`unknown-host` / `bad-mac` ⇒ 密钥配错了，要立刻报障而不是刷日志）。
   * close reason 只有 123 字节且拿不到结构化字段，不够用。**先发此帧，再关连接。**
   */
  HELLO_ERR: 0x09,
  /**
   * 双向：**优雅告别**（`reason`）。
   * 发出方承诺「我按计划下线」⇒ 收到方**立刻回收**（清 endpoints / 标离线），
   * 而不是干等心跳超时（默认 45s）。把「计划内重启」的恢复时间从 45s 压到毫秒级。
   */
  BYE: 0x0a,
  /**
   * client → server：**运行期加一个可被中继的端口**（`{reqId, port}`）—— 覆盖网络 R4。
   *
   * 为什么必须有它：实例端口是**实例起来时才**由 `findFreePort()` 分配的，而 `HELLO` 的端口表
   * 在注册那一刻就定死了。没有这一帧，worker 只能"开局声明一整段"，relay 就要为**那一段的每一个
   * 口**开一条回环监听（1000 端口段 = 1000 个 fd，实测每台机只跑 1–2 个实例）——纯浪费，
   * 而且让"声明即暴露"的安全姿态白白变差。对应 ssh 版的 `ssh -O forward`。
   */
  PORT_ADD: 0x0b,
  /** client → server：**撤销**一个端口（`{reqId, port}`）—— 实例停了就该把口收掉，不留悬挂监听。 */
  PORT_DEL: 0x0c,
  /**
   * server → client：上面两者的结果（`{reqId, port, ok, localPort?, error?}`）。
   *
   * `localPort` = relay 为这个端口开在**它自己回环**上的口号（`0` = 尚未绑定完成）；
   * 用 `reqId` 关联请求（增删可能并发，靠端口号关联会串）。**没有它就等于 ssh 版"静默失败"**。
   */
  PORT_ACK: 0x0d,
  /**
   * client → server：**拨号方**请 relay 给自己开一条到 `(target, port)` 的双向流（覆盖网络 R5）。
   *
   * 为什么需要这一帧：`PORT_ADD` 那条路（relay 开回环监听 → Manager 连回环）把**落点钉在
   * relay 主机的 `127.0.0.1`** 上 ⇒ Manager 必须与 relay **同机**，`会合可换机` 就断在这里。
   * 有了它，Manager 也能像 worker 一样**只拨出**一条 wss，并在自己的会话里请求开流 ⇒
   * **relay 放哪台机器都行**，且 Manager 侧不再需要 `/status` 或任何回环落点。
   *
   * `payload = { target: <hostId>, port: n }`；`streamId` 由**拨号方**自己分配（与 worker 侧
   * 的 id 各属一个命名空间，relay 负责配对）。
   */
  DIAL: 0x0e,
  /** server → client：`DIAL` 的结果（`{ok, error?, localPort?}`）。**没有它就等于静默失败**。 */
  DIAL_ACK: 0x0f,
  /**
   * client → server：**订阅在线态**（覆盖网络 presence，`{network?, hosts?, all?}`）。
   *
   * 为什么要有它：现役在线态的唯一来源是**拉 `/status` 快照**（`server.ts:413` 那条路 + 控制面
   * 每 `RELAY_POLL` 拉一次）—— 那是**轮询**，与"在线态本该由连接生命周期驱动"正相反
   * （`覆盖网络_瓶颈落地方案 §1` 第 1/3 条：绑连接生命周期 + 订阅式扇出，只推给"正在看的人"）。
   *
   * 订阅**只活在连接期间**（Slack 的 `presence_sub` 语义）：连接断了订阅自动消失，
   * ⛔ 不需要、也不许做"持久订阅"。
   */
  SUB: 0x10,
  /** client → server：**退订**（`{network?, hosts?, all?}`）。重复退订是幂等的，不报错。 */
  UNSUB: 0x11,
  /**
   * server → client：**在线态增量**（`{ok:true, entries:[…], at}`）。
   *
   * 🔴 **一帧带数组**（`瓶颈落地方案 §1` 第 4 条：批量事件，⛔ 不是逐个 host 一条），
   * 且由服务端按 **1 s 窗口批合并**后才发（第 2 条）⇒ 稳态**一个帧都不发**（没有变化就不推）。
   *
   * ⛔ **拒绝订阅时也用这一帧**（`{ok:false, error}`）而不是静默返空：本线的头号教训是
   * "静默失败会被当成正常"，所以跨网订阅必须是**显式拒绝 + 计数**（D6）。
   */
  PRESENCE: 0x12,
  /**
   * server → client：**在线态全量快照**（`{ok:true, entries:[…], ttlMs, at}`）。
   *
   * 订阅成功后的**第一帧**就是它（`瓶颈落地方案 §1` 第 6 条：重连后必须重新拉一次全量），
   * 且**一帧拿全、无 N+1**。之后才走 `PRESENCE` 增量。
   */
  SNAP: 0x13,
} as const

export type MuxType = (typeof MUX)[keyof typeof MUX]

/** 解出来的一个完整 mux 帧。 */
export interface MuxFrame {
  type: number
  streamId: number
  payload: Buffer
}

/** 拼一个 mux 帧（一次分配，无中间拷贝）。 */
export function encodeMux(type: number, streamId: number, payload: Buffer = EMPTY): Buffer {
  const out = Buffer.allocUnsafe(5 + payload.length)
  out[0] = type & 0xff
  out.writeUInt32BE(streamId >>> 0, 1)
  if (payload.length > 0) payload.copy(out, 5)
  return out
}

/** 解析一个 mux 帧；长度 < 5 ⇒ `null`（**调用方必须当成协议错误**，不许当空帧吞掉）。 */
export function decodeMux(frame: Buffer): MuxFrame | null {
  if (frame.length < 5) return null
  return { type: frame[0], streamId: frame.readUInt32BE(1), payload: frame.subarray(5) }
}

/** mux 帧 + JSON 负载（控制帧用；数据帧一律走 `encodeMux`，不做 JSON）。 */
export function encodeJsonFrame(type: number, streamId: number, obj: unknown): Buffer {
  return encodeMux(type, streamId, Buffer.from(JSON.stringify(obj), 'utf8'))
}

/** 解析控制帧负载；**非对象或坏 JSON ⇒ `null`**（不抛，由调用方按协议错误处理）。 */
export function parseJsonPayload(payload: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(payload.toString('utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/* ═══════════════════ 2. WebSocket 服务端（最小子集） ═══════════════════ */

/** RFC 6455 关闭码（只列本模块会用到的）。 */
export const WS_CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  /** 1013 = Try Again Later（RFC 6455）：**"现在没位子，过会儿再来"** —— 容量准入用它，语义比 1008 准。 */
  TRY_AGAIN_LATER: 1013,
} as const

export interface WsServerOptions {
  /** 单帧上限（字节），超过 ⇒ `1009` 关闭。默认 1 MiB。 */
  maxFrameBytes?: number
  /** 分片重组后的消息上限。默认 4 MiB。 */
  maxMessageBytes?: number
}

/**
 * 完成握手并把 `req` 对应的 socket 提升为 WebSocket 连接。
 *
 * 失败（缺 `Upgrade` / `Sec-WebSocket-Key` / 版本非 13）⇒ 回 `400` 并 destroy，返回 `null`。
 * ⚠️ 握手**不做任何认证** —— 认证在 mux `HELLO`（见 `server.ts`），因此上层**必须**设
 * 「未认证超时」，否则任何能连到回环口的进程都能白占一个 socket。
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  opts: WsServerOptions = {},
): WsConnection | null {
  const key = req.headers['sec-websocket-key']
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  const version = String(req.headers['sec-websocket-version'] ?? '')
  if (upgrade !== 'websocket' || typeof key !== 'string' || key === '' || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return null
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  )
  // 性能：relay 是「小包、低延迟」形态，Nagle 会平白加一个 RTT 的排队延迟。
  socket.setNoDelay(true)
  const conn = new WsConnection(socket, opts)
  if (head.length > 0) conn.feed(head)
  return conn
}

/** 服务端侧的 WebSocket 连接。事件：`message(buf, isBinary)` / `drain` / `close` / `error` / `protocolError(why)`。 */
export class WsConnection extends EventEmitter {
  private readonly sock: Socket
  private readonly maxFrame: number
  private readonly maxMessage: number

  private stash: Buffer = EMPTY
  private fragOpcode = 0
  private fragParts: Buffer[] = []
  private fragBytes = 0

  private dead = false
  private closeSent = false
  private closeTimer: NodeJS.Timeout | undefined
  private code = 1006
  private reason = ''

  constructor(socket: Socket, opts: WsServerOptions = {}) {
    super()
    this.sock = socket
    this.maxFrame = opts.maxFrameBytes ?? 1024 * 1024
    this.maxMessage = opts.maxMessageBytes ?? 4 * 1024 * 1024
    socket.on('data', (chunk: Buffer) => this.feed(chunk))
    socket.on('drain', () => this.emit('drain'))
    socket.on('error', (err: Error) => {
      this.teardown()
      this.emit('error', err)
    })
    socket.on('close', () => {
      this.teardown()
      this.emit('close', this.code, this.reason)
    })
  }

  get isClosed(): boolean {
    return this.dead || this.closeSent
  }

  get remote(): string {
    return `${this.sock.remoteAddress ?? '?'}:${this.sock.remotePort ?? 0}`
  }

  /** 出向待发字节（背压判据 —— 上层据此暂停读取源，**不得当成"失败"**）。 */
  get bufferedAmount(): number {
    return this.sock.writableLength
  }

  feed(chunk: Buffer): void {
    if (this.dead) return
    if (chunk.length > 0) this.stash = this.stash.length === 0 ? chunk : Buffer.concat([this.stash, chunk])
    for (;;) {
      const frame = this.parseFrame()
      if (frame === null || this.dead || this.closeSent) return
      if (!this.handleFrame(frame)) return
    }
  }

  /** 发一个 binary 消息。返回 `false` = 触发背压（**已入 socket 缓冲，不是失败**）。 */
  sendBinary(payload: Buffer): boolean {
    return this.writeFrame(0x2, payload)
  }

  /** 发一个 text 消息（只在诊断时用；数据面一律 binary）。 */
  sendText(text: string): boolean {
    return this.writeFrame(0x1, Buffer.from(text, 'utf8'))
  }

  close(code: number = WS_CLOSE.NORMAL, reason = ''): void {
    if (this.closeSent || this.dead) return
    this.closeSent = true
    this.code = code
    this.reason = reason
    const r = Buffer.from(reason, 'utf8').subarray(0, 123)
    const payload = Buffer.allocUnsafe(2 + r.length)
    payload.writeUInt16BE(code, 0)
    r.copy(payload, 2)
    this.writeFrame(0x8, payload)
    // 对端不回 close 也要收尸，否则 fd 泄漏。
    this.closeTimer = setTimeout(() => this.teardown(), 3000)
    this.closeTimer.unref()
  }

  /**
   * **强制**收尾（不等对端回 close 帧）。
   *
   * 停机路径专用：实测（传输方案 §12 T8）等对端回帧会把 `stop()` 从 ~300ms 拖到 **1.8s+**，
   * 而这 1.8s 正好被对端记成"服务中断"。**停机时长本身就是恢复时间的一部分** ⇒
   * 这里宁可主动销毁，也不"礼貌地等"。
   */
  destroy(): void {
    this.teardown()
  }

  /* ── 内部 ── */

  private writeFrame(opcode: number, payload: Buffer): boolean {
    if (this.dead) return false
    const n = payload.length
    let head: Buffer
    if (n < 126) {
      head = Buffer.allocUnsafe(2)
      head[1] = n
    } else if (n < 65536) {
      head = Buffer.allocUnsafe(4)
      head[1] = 126
      head.writeUInt16BE(n, 2)
    } else {
      head = Buffer.allocUnsafe(10)
      head[1] = 127
      head.writeBigUInt64BE(BigInt(n), 2)
    }
    head[0] = 0x80 | opcode // FIN=1，服务端不 mask ⇒ 不拷负载
    if (n < 4096) return this.sock.write(Buffer.concat([head, payload], head.length + n))
    // 大包不 concat（避免一次全量拷贝），两次 write 由内核合并。
    const a = this.sock.write(head)
    const b = this.sock.write(payload)
    return a && b
  }

  private parseFrame(): { fin: boolean; opcode: number; payload: Buffer } | null {
    const b = this.stash
    if (b.length < 2) return null
    const fin = (b[0] & 0x80) !== 0
    const rsv = b[0] & 0x70
    const opcode = b[0] & 0x0f
    const masked = (b[1] & 0x80) !== 0
    let len = b[1] & 0x7f
    let off = 2
    if (len === 126) {
      if (b.length < 4) return null
      len = b.readUInt16BE(2)
      off = 4
    } else if (len === 127) {
      if (b.length < 10) return null
      const big = b.readBigUInt64BE(2)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.fail(WS_CLOSE.TOO_BIG, 'frame length overflow')
        return null
      }
      len = Number(big)
      off = 10
    }
    if (rsv !== 0) {
      this.fail(WS_CLOSE.PROTOCOL_ERROR, 'rsv set without extension')
      return null
    }
    if (len > this.maxFrame) {
      this.fail(WS_CLOSE.TOO_BIG, `frame ${len} > ${this.maxFrame}`)
      return null
    }
    if (!masked) {
      this.fail(WS_CLOSE.PROTOCOL_ERROR, 'client frame must be masked')
      return null
    }
    if (b.length < off + 4 + len) return null
    const mask = b.subarray(off, off + 4)
    const raw = b.subarray(off + 4, off + 4 + len)
    const payload = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) payload[i] = raw[i] ^ mask[i & 3]
    this.stash = b.subarray(off + 4 + len)
    return { fin, opcode, payload }
  }

  private handleFrame(f: { fin: boolean; opcode: number; payload: Buffer }): boolean {
    if (f.opcode === 0x8) {
      this.readClose(f.payload)
      return false
    }
    if (f.opcode === 0x9) {
      this.writeFrame(0xa, f.payload)
      return true
    }
    if (f.opcode === 0xa) {
      this.emit('pong')
      return true
    }
    if (f.opcode === 0x0) {
      if (this.fragOpcode === 0) {
        this.fail(WS_CLOSE.PROTOCOL_ERROR, 'continuation without start')
        return false
      }
      this.fragBytes += f.payload.length
      if (this.fragBytes > this.maxMessage) {
        this.fail(WS_CLOSE.TOO_BIG, 'fragmented message too large')
        return false
      }
      this.fragParts.push(f.payload)
      if (f.fin) {
        const opcode = this.fragOpcode
        const message = Buffer.concat(this.fragParts, this.fragBytes)
        this.resetFrag()
        this.emit('message', message, opcode === 0x2)
      }
      return true
    }
    if (f.opcode !== 0x1 && f.opcode !== 0x2) {
      this.fail(WS_CLOSE.UNSUPPORTED_DATA, `opcode ${f.opcode}`)
      return false
    }
    if (this.fragOpcode !== 0) {
      this.fail(WS_CLOSE.PROTOCOL_ERROR, 'interleaved data frame')
      return false
    }
    if (f.fin) {
      this.emit('message', f.payload, f.opcode === 0x2)
      return true
    }
    this.fragOpcode = f.opcode
    this.fragParts = [f.payload]
    this.fragBytes = f.payload.length
    return true
  }

  private readClose(payload: Buffer): void {
    if (payload.length >= 2) {
      this.code = payload.readUInt16BE(0)
      this.reason = payload.subarray(2).toString('utf8')
    } else {
      this.code = WS_CLOSE.NORMAL
    }
    if (!this.closeSent) {
      this.closeSent = true
      this.writeFrame(0x8, payload.subarray(0, Math.min(payload.length, 125)))
    }
    this.teardown()
  }

  private resetFrag(): void {
    this.fragOpcode = 0
    this.fragParts = []
    this.fragBytes = 0
  }

  private fail(code: number, why: string): void {
    this.emit('protocolError', why)
    this.close(code, why)
    // 协议已错 ⇒ 不等对端回应，立刻收尸。
    const t = setTimeout(() => this.teardown(), 100)
    t.unref()
  }

  private teardown(): void {
    if (this.dead) return
    this.dead = true
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer)
    this.stash = EMPTY
    this.resetFrag()
    this.sock.destroy()
  }
}
