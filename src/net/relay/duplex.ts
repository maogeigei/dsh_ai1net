/**
 * 一条 mux 流的**应用侧端口**（覆盖网络 R5 —— 拨号方用）。
 *
 * ## 语义
 * 与 `net.Socket` 同形，可直接 `a.pipe(b)`：
 * - **写** ⇒ `onOut(chunk)`（由调用方决定往哪送，这里就是打进 mux）；
 * - **读** ⇒ `feed(chunk)`（对端来的字节）、`eof()`（对端关闭）。
 *
 * ## 为什么不做成 `net.Socket`
 * 拨号方的"落点"不在本机任何 TCP 端口上 —— 它就是一条多路复用的逻辑流。用一个 `Duplex`
 * 表示，调用方既能直接 `pipe()`，也不需要为它准备 fd（**零新增监听口**）。
 *
 * @module dsh_ai1net/net/relay/duplex
 */

import { Duplex, type DuplexOptions } from 'node:stream'

export interface MuxDuplexOptions extends DuplexOptions {
  /** 应用写下来的字节往哪去（返回 `false` = 触发背压，调用方稍后应 `resumeOut()`）。 */
  onOut: (chunk: Buffer) => boolean
  /** 流出向关闭 / 被销毁时只调一次（用于给对端补 `CLOSE`）。 */
  onClosed?: () => void
}

export class MuxDuplex extends Duplex {
  private readonly onOut: (chunk: Buffer) => boolean
  private readonly onClosed: () => void
  private ended = false

  constructor(opts: MuxDuplexOptions) {
    // `allowHalfOpen`：对端先关一半不代表本侧不能再写（HTTP/1.1 里很常见），保持半开。
    super({ ...opts, allowHalfOpen: true })
    this.onOut = opts.onOut
    this.onClosed = opts.onClosed ?? ((): void => undefined)
  }

  /** 读侧由 `feed()` 驱动；这里无事可做（**不能**返回错误，否则会误报"流坏了"）。 */
  override _read(): void {}

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.onOut(buf)
    cb()
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.closeOnce()
    cb()
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    this.closeOnce()
    cb(err)
  }

  /** 对端来的字节 ⇒ 交给读侧。返回 `false` = 读侧水位满（**不是错误**）。 */
  feed(chunk: Buffer): boolean {
    if (this.destroyed || this.ended) return false
    return this.push(chunk)
  }

  /** 对端关闭 ⇒ 结束读侧（读方会收到 `end`），但**写侧仍可写**（半开）。 */
  eof(): void {
    if (this.ended || this.destroyed) return
    this.ended = true
    this.push(null)
  }

  private closeOnce(): void {
    const first = !this.ended
    this.ended = true
    if (first) this.onClosed()
  }
}
