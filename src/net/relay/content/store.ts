/**
 * 内容寻址存储 —— **"哈希 → 块"的本地仓库**（覆盖网络线 内容分发）。
 *
 * ## 一句话说清它是什么
 * 进程内的块仓库：`put(bytes) -> id`、`get(id) -> bytes|undefined`、`has(id) -> bool`。
 * 一切以 **id（内容哈希）** 为键 ⇒ 同一份字节无论来自本地生成、peer 取回还是回源，
 * **只会存一份**（天然去重 = E1 的基础）。
 *
 * ## 三条硬约束（每一条都对应本线踩过的病）
 * 1. **落盘前 / 取出后都校验** —— 存进来时算一次 id 对齐；取出去时再算一次
 *    （防"磁盘写坏 / 被进程外改过"）。**任一不符即丢弃并计数**（E4 的另一半）。
 * 2. **必须有上限** —— 块缓存是"能不要就不要"的加速层，⛔ **不许无界增长**。
 *    超限按 **LRU** 淘汰（`maxBytes`）。S0 P5 已确认：47 的 `MEM_BUDGET_MB = 1002`
 *    且 `MEM_PER_HOST_MB = 0.06` 只是**空闲会话**口径 ⇒ 块缓存必须**另立预算、另立上限**。
 * 3. **计数全部可断言** —— 命中 / 未命中 / 淘汰 / 校验失败 / 拒绝超限，
 *    **每一项都落计数器**（⛔ 不许只写日志）：这是 E6 与"静默放行"回头条件的机器判据。
 *
 * ## 🆕 单 B：**本层只处理"落库字节"**（启用组密钥加密时 = 密文）
 * 🔑 本项目**不需要在本模块里加解密**，理由是一条源码事实：**键就是 id，而 id 是由字节算出来的**
 * ⇒ 口径只能有**一个**定义处（`chunker.ts`：`blockIdOf(落库字节)`）。所以：
 * - 调用方给什么口径的字节，本模块就存什么、校验什么 —— 加密启用后它拿到的是**密文**；
 * - 于是"中继进程持有什么"完全由调用方决定 ⇒ **`OBS-23` 的"明文不出现"判据落在装配层**
 *   （`runtime.ts` / `main.ts` 的自证），⛔ 不是这里。
 * - ⚠️ **`decryptRejected` 落在 `crypto.ts` 的计数块**（`content.crypto`），**⛔ 不在此处**：
 *   解密只有一个实现（`ContentCipher.decodeBlock`），把它的失败计数也写进 store 的
 *   7 键里会造成"同一事实两处写"（本线明令禁止）。⇒ 本模块的 7 键口径**一行未动**
 *   （探针 `OBS-17` 对它们逐键断言）。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不做网络（取块走哪条链 = `source.ts`；从谁取 = `peer.ts`）；
 * - 不做持久化格式（本阶段内存 + 可选目录落盘由调用方注入，见 `dir` 选项）；
 * - 不做跨进程共享（那是 relay / peer 层的事）；
 * - ⛔ **不做加解密**（那是 `crypto.ts`；本层只认字节与 id）。
 *
 * @module dsh_ai1net/net/relay/content/store
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blockIdOf, isBlockId, BLOCK_ID_HEX_LEN } from './chunker.js'

/** 块仓库的**可断言**计数（⛔ 不许只写日志 —— 见文件头约束 3）。 */
export interface ContentStoreCounters {
  /** `put` 成功入库的块次数（重复内容会被去重 ⇒ 可能 < 调用次数）。 */
  puts: number
  /** `put` 因**内容与声明 id 不符**被拒的次数（E4 的写侧）。 */
  putRejected: number
  /** `get` 命中次数（本地已有 ⇒ ⛔ 不用回源，这是 E1 的直接来源）。 */
  hits: number
  /** `get` 未命中次数。 */
  misses: number
  /** 取出后**复算校验失败**被丢弃的次数（E4 的读侧）。 */
  corruptReads: number
  /** 因超出 `maxBytes` 被 LRU 淘汰的块数。 */
  evicted: number
  /** 因**单块大于 `maxBytes`**（永远放不下）被拒的次数。 */
  oversizeRejected: number
}

/** `ContentStore` 的构造选项。 */
export interface ContentStoreOptions {
  /** 容量上限（字节）。必须 > 0。缺省 **64 MiB** —— 见 `DEFAULT_MAX_BYTES` 的推算。 */
  maxBytes?: number
  /**
   * 可选的落盘目录。给了就**同时**写盘（重启后仍在），且 `get` 先查内存再查盘。
   * ⚠️ 落盘块**同样在读出时复算校验**（磁盘不是可信来源）。
   */
  dir?: string
  /** 单块上限（字节）。缺省 = `maxBytes`（即"只要装得下就收"）。 */
  maxBlockBytes?: number
  /**
   * 🆕 C（域分离）：块 id 的**域密钥**（per-network keyed hash）。
   *
   * 给了它 ⇒ 本层的两处复算（入库前 / 取出后）走 `HMAC-SHA256(netKey, bytes)`；
   * ⛔ 缺省 ⇒ 回落裸 `sha256`（= 回滚路径）。⚠️ **必须与写侧的 `netKey` 一致** ——
   * 不一致的症状是"每个块都判校验失败"（`putRejected` / `corruptReads` 涨），
   * 而块本身是好的（本线最恨的难定位形态）。
   */
  netKey?: Buffer
}

/**
 * 默认容量上限 —— **64 MiB**。
 *
 * 推算（S0 P5 实测）：47 上 `MEM_BUDGET_MB = 1002 MB`，而 relay 侧
 * `MEM_PER_HOST_MB = 0.06` 只是**空闲会话**斜率、**不含**带流量的 per-stream 缓冲
 * （参数表 §9 在册未测项）⇒ 块缓存**不能**去挤那份预算。
 * 取 64 MiB ≈ 6.4% 的 `MEM_BUDGET_MB`，且能**整份装下 6 份** 10.8 MB 的首屏包
 * （`6 × 10.8 = 64.8`，按 1 MiB 块去重后更宽松）—— 够覆盖"同组内一台 peer 服务另外几台"。
 * ⚠️ 这是**保守初值**，真机验收（S6）后由参数表 `CONTENT_STORE_MAX_BYTES` 固化。
 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

/** 一个块仓库条目（内存态）。 */
interface Entry {
  bytes: Buffer
  /** 最近一次访问的单调序号（LRU 用）。 */
  seq: number
}

/** 内容寻址存储。**非线程安全**（Node 单线程事件循环内使用）。 */
export class ContentStore {
  private readonly map = new Map<string, Entry>()
  private readonly maxBytes: number
  private readonly maxBlockBytes: number
  private readonly dir: string | undefined
  /** 🆕 C：块 id 的域密钥（`undefined` = 裸哈希口径，与逐字一致）。 */
  private readonly netKey: Buffer | undefined
  private usedBytes = 0
  private seq = 0
  private readonly c: ContentStoreCounters = {
    puts: 0,
    putRejected: 0,
    hits: 0,
    misses: 0,
    corruptReads: 0,
    evicted: 0,
    oversizeRejected: 0,
  }

  constructor(opts: ContentStoreOptions = {}) {
    const max = opts.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isFinite(max) || max <= 0) {
      throw new Error(`content-store: maxBytes 必须是正数，收到 ${String(opts.maxBytes)}`)
    }
    this.maxBytes = max
    const mb = opts.maxBlockBytes ?? max
    if (!Number.isFinite(mb) || mb <= 0) {
      throw new Error(`content-store: maxBlockBytes 必须是正数，收到 ${String(opts.maxBlockBytes)}`)
    }
    this.maxBlockBytes = Math.min(mb, max)
    this.dir = opts.dir
    this.netKey = opts.netKey
    if (this.dir !== undefined) mkdirSync(this.dir, { recursive: true })
  }

  /** 当前占用字节数。 */
  get bytes(): number {
    return this.usedBytes
  }

  /** 当前块数。 */
  get size(): number {
    return this.map.size
  }

  /** 计数快照（**拷贝**，调用方拿到的不会被后续写入改动）。 */
  counters(): ContentStoreCounters {
    return { ...this.c }
  }

  /** 是否持有该块（⛔ 不触发校验 —— 只问"在不在"）。 */
  has(id: string): boolean {
    if (!isBlockId(id)) return false
    if (this.map.has(id)) return true
    if (this.dir !== undefined) {
      const p = this.pathOf(id)
      return existsSync(p) && statSync(p).size > 0
    }
    return false
  }

  /**
   * 存入一个块。
   *
   * @param id 调用方声明的块 id（来自 `chunker.blockIdOf` / 计划 / 对端公告）
   * @param bytes 块字节
   * @throws 当 id 形状非法、或**内容复算 id ≠ 声明 id**、或块超过单块上限时抛错
   *         （⛔ 静默丢弃会让"篡改块"看起来像"从没收到"，是本线反复要根治的假绿）
   */
  put(id: string, bytes: Buffer): void {
    if (!isBlockId(id)) {
      this.c.putRejected += 1
      throw new Error(`content-store: 非法块 id（长度须为 ${BLOCK_ID_HEX_LEN} 的小写 hex）：${id}`)
    }
    if (bytes.length > this.maxBlockBytes) {
      this.c.oversizeRejected += 1
      throw new Error(
        `content-store: 块 ${id} 大小 ${bytes.length}B 超过单块上限 ${this.maxBlockBytes}B（永远放不下 ⇒ 拒绝）`,
      )
    }
    // ── E4 写侧：入库前**必须**复算 id ──────────────────────────────────
    const actual = blockIdOf(bytes, this.netKey)
    if (actual !== id) {
      this.c.putRejected += 1
      throw new Error(`content-store: 块校验失败（丢弃）expected=${id} actual=${actual}`)
    }
    // 同内容重复入库 = 去重（不重复计容、不覆盖已有 seq）
    const existed = this.map.get(id)
    if (existed !== undefined) {
      existed.seq = ++this.seq
      return
    }
    const own = Buffer.from(bytes) // 复制，防调用方复用 buffer 导致内容漂移
    this.map.set(id, { bytes: own, seq: ++this.seq })
    this.usedBytes += own.length
    this.c.puts += 1
    if (this.dir !== undefined) {
      try {
        writeFileSync(this.pathOf(id), own)
      } catch {
        /* 落盘失败不影响内存命中（内存才是权威；落盘只是重启后的加速） */
      }
    }
    this.evictIfNeeded()
  }

  /**
   * 取出一个块。**取出后复算校验**（E4 读侧）—— 不符即**删除并返回 `undefined`**。
   *
   * ⚠️ 返回 `undefined` 的两种含义**必须可区分**（这正是"静默"的来源）：
   * 调用方据 `counters().corruptReads` / `misses` 的增量判断是"没有"还是"取出来是坏的"。
   */
  get(id: string): Buffer | undefined {
    if (!isBlockId(id)) {
      this.c.misses += 1
      return undefined
    }
    const hit = this.map.get(id)
    if (hit !== undefined) {
      const verify = blockIdOf(hit.bytes, this.netKey)
      if (verify !== id) {
        // 内存里的块被改过（理论上不该发生）⇒ 丢弃 + 计数
        this.c.corruptReads += 1
        this.map.delete(id)
        this.usedBytes -= hit.bytes.length
        this.removeOnDisk(id)
        return undefined
      }
      hit.seq = ++this.seq
      this.c.hits += 1
      return Buffer.from(hit.bytes)
    }
    // 内存没有 ⇒ 查盘（落盘块**同样校验**）
    if (this.dir !== undefined) {
      const p = this.pathOf(id)
      try {
        const buf = readFileSync(p)
        const verify = blockIdOf(buf, this.netKey)
        if (verify !== id) {
          this.c.corruptReads += 1
          this.removeOnDisk(id)
          return undefined
        }
        // 从盘回填内存（并计容），再按 LRU 裁剪
        const own = Buffer.from(buf)
        this.map.set(id, { bytes: own, seq: ++this.seq })
        this.usedBytes += own.length
        this.evictIfNeeded()
        this.c.hits += 1
        return Buffer.from(own)
      } catch {
        /* 盘上也没有 ⇒ 落进下面的 misses */
      }
    }
    this.c.misses += 1
    return undefined
  }

  /** 某块在落盘目录里的路径（`dir` 未设时无意义）。 */
  private pathOf(id: string): string {
    return join(this.dir as string, id)
  }

  private removeOnDisk(id: string): void {
    if (this.dir === undefined) return
    try {
      const p = this.pathOf(id)
      if (existsSync(p)) writeFileSync(p, Buffer.alloc(0)) // 截断为 0 ⇒ `has()` 视为不存在
    } catch {
      /* 删不掉不影响内存态 */
    }
  }

  /** 超出上限 ⇒ 按 LRU 淘汰，直到 `usedBytes <= maxBytes`。 */
  private evictIfNeeded(): void {
    while (this.usedBytes > this.maxBytes && this.map.size > 0) {
      let victim: string | undefined
      let oldest = Number.POSITIVE_INFINITY
      for (const [id, e] of this.map) {
        if (e.seq < oldest) {
          oldest = e.seq
          victim = id
        }
      }
      if (victim === undefined) break
      const e = this.map.get(victim)
      this.map.delete(victim)
      if (e !== undefined) this.usedBytes -= e.bytes.length
      this.removeOnDisk(victim)
      this.c.evicted += 1
    }
  }
}
