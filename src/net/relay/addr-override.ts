/**
 * 覆盖网络 · **（443/TCP 兜底）· L1「去 CF」** —— 地址覆盖（直连目标 IP + 保持 SNI = 域名）。
 *
 * ## 它解决的唯一问题
 * 兜底入口 `relay-direct.<base-domain>` 与主入口 `<base-domain>` **同属 `*.{base-domain}`**，
 * 而该泛解析被 Cloudflare 代理 ⇒ **两者都指向 CF**。所以"多了一条入口"并不等于
 * "CF 不可用时还能连"：解析层仍然把客户端送到 CF。本模块把**逐字列出的域名**的解析结果
 * **钉到指定 IP** ⇒ TCP 直连该 IP，而 TLS **SNI 仍等于 URL 里的域名**（证书校验照旧，不降级）。
 *
 * ## 为什么落在 DNS 层（而不是 dispatcher / 换 URL）
 * 本项目**不引入 `undici` / `ws`**（`client.ts` 用的是 Node 22 内建的全局 `WebSocket`）。
 * WHATWG `WebSocket` 不接受自定义 `dispatcher` ⇒「换地址但保留 SNI」在 URL 层没有落点：
 * 把 URL 换成 IP 会**连带**把 SNI 换成 IP ⇒ 证书校验必然失败（除非关校验 = 权限/安全净变差）。
 * 实测（2026-09-17，Node v22.22.2）：全局 `WebSocket` 的建连**走 JS 层 `dns.lookup`**
 * ⇒ 在解析层做定向覆盖，是**零新依赖、不动默认路径**的最小实现。
 *
 * ## 安全边界（为什么它不是"通用 hosts 劫持"）
 * - **白名单语义**：只覆盖 `DSH_AI1NET_OVERLAY_ADDR_OVERRIDES` 里**逐字列出**的域名；其余一律走原始
 *   `dns.lookup`。**未配 ⇒ 本模块完全不生效**，行为与今天逐字一致（零退化）。
 * - **不写 DNS、不改 hosts、不碰 `/etc`**：只改本进程内的解析结果，进程退出即消失。
 * - **失败关闭**：形状非法的条目**不安装**并写一行日志 —— 不静默忽略、更不回落成"通用覆盖"。
 * - **零新增暴露面**：不监听端口、不新增依赖、不新增凭据。
 *
 * ## 配置（**独立配置项**；⛔ 不塞进 URL、⛔ 不进签名目录 —— 设计文档 §4.1-5）
 * ```
 * DSH_AI1NET_OVERLAY_ADDR_OVERRIDES=relay-direct.<base-domain>=<server-public-ip>
 * ```
 * 逗号多值；同一域名**先出现者生效**（后写的静默覆盖会让"为什么不是我以为的 IP"更难排查）。
 *
 * @module dsh_ai1net/net/relay/addr-override
 */

import { createRequire } from 'node:module'
import { isIPv4, isIPv6 } from 'node:net'

/** `dns.lookup` 的回调形状（只用到 `(err, address, family)` 与 `all: true` 两种）。 */
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void

/** `node:dns` 的最小面（用 `createRequire` 取，保证改的是 **net/undici 实际用的那个单例**）。 */
interface DnsModule {
  lookup: (hostname: string, options?: unknown, callback?: LookupCallback) => void
  promises: { lookup: (hostname: string, options?: unknown) => Promise<unknown> }
}

export interface AddrOverride {
  /** 小写域名（**逐字匹配**，不做后缀/通配匹配）。 */
  host: string
  /** 覆盖后的直连地址。 */
  ip: string
  /** 地址族（由 IP 字面量推得）。 */
  family: 4 | 6
}

/** 已安装的覆盖表 —— 模块级唯一状态（`ensureOverlayAddrOverrides` 幂等）。 */
const installed = new Map<string, AddrOverride>()
/** 已经打过一次补丁（**只打一次**；反复打会把自己的包装再包一层）。 */
let patched = false
/** 已经播报过的条目（避免每次建连都刷日志）。 */
const announced = new Set<string>()
/** 原始实现（仅供测试精确还原）。 */
let originalLookup: DnsModule['lookup'] | undefined
let originalPromisesLookup: DnsModule['promises']['lookup'] | undefined

/** 该字符串能不能当"域名"用：非空、含点、无协议/路径/端口/空白、不是 IP 字面量。 */
function isHostnameLike(host: string): boolean {
  if (host === '') return false
  if (!host.includes('.')) return false
  if (isIPv4(host) || isIPv6(host)) return false
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)
}

/** IP 字面量 ⇒ 地址族；不是字面量 ⇒ `undefined`（**不接受主机名**：那会把"覆盖"变成"再解析一次"）。 */
function ipFamily(ip: string): 4 | 6 | undefined {
  if (isIPv4(ip)) return 4
  if (isIPv6(ip)) return 6
  return undefined
}

/**
 * `host=ip`（逗号多值）⇒ 覆盖表。
 *
 * `bad` 装**非法条目的原文** —— 调用方必须把它播出去：静默丢弃会让"我明明配了"看起来像
 * "覆盖没生效"，而这正是本项目反复踩过的"静默失败"形态。
 */
export function parseAddrOverrides(raw: string): { list: AddrOverride[]; bad: string[] } {
  const list: AddrOverride[] = []
  const bad: string[] = []
  const seen = new Set<string>()
  for (const item of raw.split(',')) {
    const spec = item.trim()
    if (spec === '') continue
    const eq = spec.indexOf('=')
    const host = eq < 0 ? '' : spec.slice(0, eq).trim().toLowerCase()
    const ip = eq < 0 ? '' : spec.slice(eq + 1).trim()
    const family = ipFamily(ip)
    if (!isHostnameLike(host) || family === undefined) {
      bad.push(spec)
      continue
    }
    if (seen.has(host)) continue
    seen.add(host)
    list.push({ host, ip, family })
  }
  return { list, bad }
}

/** 按 host 造一个 `lookup` 结果（尊重 `all` / `family` 两个入参形状）。 */
function overriddenLookup(
  hit: AddrOverride,
  options: unknown,
  callback: LookupCallback,
): void {
  const opts = (
    options === null || typeof options !== 'object' ? {} : options
  ) as { all?: boolean; family?: number }
  const family = opts.family === 4 || opts.family === 6 ? opts.family : hit.family
  // 请求的地址族与覆盖项不符 ⇒ 交回调用方语义（给 ENOTFOUND），**不要**回一个错族的地址。
  if (family !== hit.family) {
    process.nextTick(() => {
      // `node:dns` 的 ENOTFOUND 带 `.hostname`（不在 `ErrnoException` 的公开类型里）⇒ 显式补上，
      // 让"配了 IPv4、却按 IPv6 问"这件事在报错里一眼可读。
      const err = new Error(
        `getaddrinfo ENOTFOUND ${hit.host} (addr-override 只提供 IPv${hit.family})`,
      ) as NodeJS.ErrnoException & { hostname?: string }
      err.code = 'ENOTFOUND'
      err.errno = -3008
      err.syscall = 'getaddrinfo'
      err.hostname = hit.host
      callback(err)
    })
    return
  }
  if (opts.all === true) {
    process.nextTick(() => callback(null, [{ address: hit.ip, family: hit.family }]))
    return
  }
  process.nextTick(() => callback(null, hit.ip, hit.family))
}

/** 把回调版 `lookup` 包一层：**只**拦覆盖表里的域名，其余原样转发。 */
function wrapLookup(orig: DnsModule['lookup']): DnsModule['lookup'] {
  return function patchedLookup(hostname: string, options?: unknown, callback?: LookupCallback): void {
    let opts = options
    let cb = callback
    if (typeof opts === 'function') {
      cb = opts as LookupCallback
      opts = {}
    }
    const hit = typeof hostname === 'string' ? installed.get(hostname.toLowerCase()) : undefined
    if (hit === undefined || cb === undefined) {
      orig(hostname, opts, cb as LookupCallback)
      return
    }
    overriddenLookup(hit, opts, cb)
  }
}

/** 打补丁（**只打一次**）。用 `createRequire` 取同一单例，确保 `net` / undici 都走新实现。 */
function installPatch(): void {
  const nodeDns = createRequire(import.meta.url)('node:dns') as DnsModule
  if (originalLookup === undefined) originalLookup = nodeDns.lookup
  if (originalPromisesLookup === undefined) originalPromisesLookup = nodeDns.promises.lookup
  nodeDns.lookup = wrapLookup(originalLookup)
  nodeDns.promises.lookup = async (hostname: string, options?: unknown): Promise<unknown> => {
    const hit = typeof hostname === 'string' ? installed.get(hostname.toLowerCase()) : undefined
    if (hit === undefined) return originalPromisesLookup!(hostname, options)
    const opts = (options === null || typeof options !== 'object' ? {} : options) as { all?: boolean }
    if (opts.all === true) return [{ address: hit.ip, family: hit.family }]
    return { address: hit.ip, family: hit.family }
  }
}

/**
 * **幂等安装**：解析 `raw`（缺省读 `DSH_AI1NET_OVERLAY_ADDR_OVERRIDES`）并装覆盖；返回当前生效的整表。
 *
 * ⚠️ 幂等但**累加**：多次调用可把新域名并进来（重连 / 多个建连点共用），不会重复打补丁。
 */
export function ensureOverlayAddrOverrides(
  raw: string = process.env.DSH_AI1NET_OVERLAY_ADDR_OVERRIDES ?? '',
  log: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): readonly AddrOverride[] {
  const { list, bad } = parseAddrOverrides(raw)
  for (const spec of bad) {
    log(`[addr-override] ⛔ 忽略非法条目 "${spec}"（语法应为 <域名>=<IP>，逗号分隔）`)
  }
  // 未配 ⇒ **完全不生效**（连补丁都不打）⇒ 与今天逐字一致。
  if (installed.size === 0 && list.length === 0) return []
  for (const o of list) {
    const prev = installed.get(o.host)
    if (prev !== undefined && prev.ip !== o.ip) {
      log(`[addr-override] ⚠ ${o.host} 的覆盖地址被改写：${prev.ip} -> ${o.ip}`)
      announced.delete(`${o.host}=${o.ip}`)
    }
    installed.set(o.host, o)
  }
  if (!patched) {
    installPatch()
    patched = true
    log(`[addr-override] 已启用地址覆盖（白名单 ${installed.size} 条；DNS 层定向改写，SNI 仍为域名）`)
  }
  for (const o of installed.values()) {
    const key = `${o.host}=${o.ip}`
    if (announced.has(key)) continue
    announced.add(key)
    log(`[addr-override] 覆盖生效：${o.host} -> ${o.ip}（IPv${o.family}，直连该 IP，TLS SNI 仍为 ${o.host}）`)
  }
  return [...installed.values()]
}

/** 当前生效的覆盖表（只读快照）。 */
export function currentAddrOverrides(): readonly AddrOverride[] {
  return [...installed.values()]
}

/**
 * **仅供测试**：撤掉补丁并清空覆盖表。
 * ⛔ 生产路径不许调用 —— 它会把"已生效"悄悄退化成"没生效"。
 */
export function resetOverlayAddrOverridesForTest(): void {
  if (originalLookup !== undefined && originalPromisesLookup !== undefined) {
    const nodeDns = createRequire(import.meta.url)('node:dns') as DnsModule
    nodeDns.lookup = originalLookup
    nodeDns.promises.lookup = originalPromisesLookup
  }
  originalLookup = undefined
  originalPromisesLookup = undefined
  installed.clear()
  announced.clear()
  patched = false
}
