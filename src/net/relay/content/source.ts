/**
 * 内容源优先级链 —— **"这个块去哪儿取"的唯一裁决处**（覆盖网络线 内容分发）。
 *
 * ## 一句话说清它是什么
 * 照搬 SCCM / Delivery Optimization 的**内容源优先级**（设计文档 §7 要求"照抄三件套"）：
 *
 * ```
 * 本地磁盘 → 同局域网 peer → 同区域边缘缓存 → 区域分发点 → 公网源
 * ```
 *
 * **按顺序问**，第一个给出内容的档位就是本次来源 —— 这叫"**点名**"（E6）。
 * 越靠前的档位 ⇒ 越省带宽（`local` 零网络、`peer` 走内网、`origin` 走公网）。
 *
 * ## 为什么"点名"必须是计数而不是日志
 * 本线复盘里的原话是「**静默失效靠判别器定位**」。一条 `console.log('命中 peer')` 在
 * 脚本里**无法断言** ⇒ 实现退化成"每次都打 origin"时，日志照样在刷、判据照样全绿。
 * 所以：**每次命中/未命中/抛错都落计数器**，⛔ 一个都不许省（E6 的机器判据 = 计数递增）。
 *
 * ## 三条纪律
 * 1. **顺序是硬约束**：⛔ 不许"哪个快用哪个" —— 那会让 peer 永远打不过本地缓存，
 *    于是"同网段共享"这个**本项目的核心收益**静默消失（而日志看起来一切正常）。
 * 2. **抛错 ≠ 没有**：某一档抛错要**单独计数**并**继续下一档**。
 *    ⛔ 不许整体失败（链的鲁棒性是"稳定"那一半），⛔ 也不许吞掉（否则"配置错"伪装成"没有"）。
 * 3. **全档皆无 ⇒ 逐档留痕**：`misses()` 必须等于问过的档数。⛔ 静默返空 = 本线的假绿 source。
 *
 * ## 🆕 单 B：**唯一解密点**（给了 `decode` 才生效；缺省 ⇒ 行为逐字不变）
 * 加密启用后，各档拿回来的都是**落库字节**（密文）。解密**必须只有一处**：
 * - 落在这里的**单一返回点** ⇒ 五档**一律**同一口径（⛔ 杜绝"local 档不解密、peer 档解密"）；
 * - 解密失败**按"抛错"处置**（`errorCounts` ＋ `decodeRejected` **各 +1**，并**具名回调**）
 *   然后**继续下一档** —— 因为"这一档的字节解不开"与"这一档没有这块"在脚本里
 *   必须**可区分**（本线的老病根：两类失败同形）。
 * - ⚠️ 给了 `decode` ⇒ 本链返回的是**明文**；`chunker#reassemble` 的 `decode` 是**另一条**
 *   装配路径（夹具 / 工具），**同一批字节只过其中一处**，⛔ 不叠加。
 *
 * ## ⛔ 本模块**不做**的事（故意）
 * - 不认识 HTTP / WebSocket：每个档位是一个**注入的 fetcher**（便于夹具替身与真机装配）；
 * - 不决定"去哪找 peer 列表"（那是 `peer.ts`）；
 * - 不做缓存写入（那是 `store.ts`；链只负责**取**）；
 * - 🔴 **不做完整性校验**（`E4` 那半边在 `store.get` 的读侧复算里）。⚠️ **如实留档**：
 *   `peer` 档的真实取回通道**尚未接线** ⇒ 接线时**必须**在取回后复算 `blockIdOf`
 *   （否则"篡改块被丢弃"只在 `local` 档成立 —— 已在单 B §8.13 登记）。
 *   ✅ **（S6）已兑现**：复算闸门落在**装配点** `runtime.ts#fetchFromPeers`
 *   （取回的落库字节必须复算出同一个块 id，不符 ⇒ **丢弃且不算命中**，逐条 `idMismatches` 计数）。
 *   ⛔ 刻意**不放在本模块**：链的职责是"按顺序问"，块 id 口径属装配层的接线纪律
 *   —— 放进来会让"五档通用链"认识块格式（分层退化）。
 *
 * @module dsh_ai1net/net/relay/content/source
 */

/** 内容源档位（五档，顺序即优先级）。 */
export type SourceTier = 'local' | 'peer' | 'edge' | 'region' | 'origin'

/**
 * **唯一权威**的档位顺序。
 * ⚠️ 任何地方要遍历档位都从这里取（⛔ 不许在调用方重写一份数组 —— 散着写迟早出现三套口径）。
 */
export const DEFAULT_TIER_ORDER: readonly SourceTier[] = ['local', 'peer', 'edge', 'region', 'origin']

/** 与 `DEFAULT_TIER_ORDER` **同源**的导出别名（供按名引用，语义上强调"这就是全部档位"）。 */
export const SOURCE_TIERS: readonly SourceTier[] = DEFAULT_TIER_ORDER

/** 单档取块结果：给出内容即命中。 */
export interface TierFetchResult {
  /** 该档自报的档位 —— ⚠️ 必须**回显**调用方传入的档位（便于断言"确实是它给的"）。 */
  tier: SourceTier
  bytes: Buffer
}

/** 单档 fetcher：拿到内容就返回；"我这没有"就返回 `undefined`；出错就抛。 */
export type TierFetcher = (id: string) => Promise<TierFetchResult | undefined>

/** 按档位的**命中计数**（E6 的机器判据）。 */
export type SourceHitCounters = Record<SourceTier, number>

/** 所有档位计 0。 */
export function emptySourceCounters(): SourceHitCounters {
  return { local: 0, peer: 0, edge: 0, region: 0, origin: 0 }
}

/** `ContentSourceChain` 构造选项。 */
export interface ContentSourceChainOptions {
  /** 各档的取块实现。缺某一档 ⇒ 该档视为"永远没有"（但仍**参与遍历与计数**）。 */
  fetchers: Partial<Record<SourceTier, TierFetcher>>
  /** 命中回调（观测用）。⚠️ 与计数器**并存**：日志不能替代计数。 */
  onHit?: (tier: SourceTier, id: string) => void
  /** 未命中回调。 */
  onMiss?: (tier: SourceTier, id: string) => void
  /** 抛错回调。 */
  onError?: (tier: SourceTier, id: string, err: unknown) => void
  /**
   * 🆕 单 B：**唯一解密点**（`content/crypto.ts#decodeBlock` 的注入位）。
   * 给了它 ⇒ 链返回**明文**；返回 `undefined` = 认证失败 ⇒ 本档按"抛错"处置并继续下一档。
   */
  decode?: (stored: Buffer) => Buffer | undefined
  /** 🆕 解密被拒回调（**与未命中可区分**：`reason` 恒为 `decode-failed`）。 */
  onDecodeRejected?: (tier: SourceTier, id: string, reason: 'decode-failed') => void
  /** 覆盖档位顺序（⚠️ 只给单测做"顺序敏感"验证用；生产一律用 `DEFAULT_TIER_ORDER`）。 */
  order?: readonly SourceTier[]
}

/** 取块结果（含**点名**的来源档位与"问过几档"）。 */
export interface SourceFetchOutcome {
  /** 拿到内容的档位。 */
  tier: SourceTier
  /** 内容字节。 */
  bytes: Buffer
  /** 本次为找它问过的档位（含命中那一档），按问询顺序。 */
  tried: SourceTier[]
}

/**
 * 内容源优先级链。
 *
 * 用法（生产装配）：
 * ```ts
 * const chain = new ContentSourceChain({ fetchers: { local, peer, edge, region, origin } })
 * const hit = await chain.fetch(blockId)   // undefined = 五档皆无
 * ```
 */
export class ContentSourceChain {
  private readonly fetchers: Partial<Record<SourceTier, TierFetcher>>
  private readonly order: readonly SourceTier[]
  private readonly hits: SourceHitCounters = emptySourceCounters()
  private readonly missCounts: SourceHitCounters = emptySourceCounters()
  private readonly errorCounts: SourceHitCounters = emptySourceCounters()
  /** 🆕 解密被拒计数（逐档 —— 它同时**并入** `errorCounts`，此处是"为什么炸"的细分）。 */
  private readonly decodeRejectCounts: SourceHitCounters = emptySourceCounters()
  private readonly onHit: ((tier: SourceTier, id: string) => void) | undefined
  private readonly onMiss: ((tier: SourceTier, id: string) => void) | undefined
  private readonly onError: ((tier: SourceTier, id: string, err: unknown) => void) | undefined
  private readonly decode: ((stored: Buffer) => Buffer | undefined) | undefined
  private readonly onDecodeRejected: ((tier: SourceTier, id: string, reason: 'decode-failed') => void) | undefined

  constructor(opts: ContentSourceChainOptions) {
    this.fetchers = opts.fetchers
    this.order = opts.order ?? DEFAULT_TIER_ORDER
    this.onHit = opts.onHit
    this.onMiss = opts.onMiss
    this.onError = opts.onError
    this.decode = opts.decode
    this.onDecodeRejected = opts.onDecodeRejected
  }

  /** 命中计数快照（**拷贝**）。 */
  counters(): SourceHitCounters {
    return { ...this.hits }
  }

  /** 未命中计数快照（"这一档我问了、它说没有"）。 */
  missCounters(): SourceHitCounters {
    return { ...this.missCounts }
  }

  /** 抛错计数快照（"这一档我问了、它炸了"）。⚠️ 与未命中**可区分**是纪律 2。 */
  errors(): SourceHitCounters {
    return { ...this.errorCounts }
  }

  /** 🆕 解密被拒计数快照（逐档）。⚠️ 这是 `errors()` 的**子集**（"炸"的一种具体原因）。 */
  decodeRejected(): SourceHitCounters {
    return { ...this.decodeRejectCounts }
  }

  /** 🆕 解密被拒**合计**（判据用：稳态下应当**不增长** —— 见单 B §9-6）。 */
  decodeRejectedTotal(): number {
    return Object.values(this.decodeRejectCounts).reduce((a, b) => a + b, 0)
  }

  /** 是否装配了解密点（判据用：区分"没启用加密"与"启用了但没解过"）。 */
  get decodeEnabled(): boolean {
    return this.decode !== undefined
  }

  /** 未命中合计数（= 问过但没有内容的档位总次数）。 */
  misses(): number {
    return Object.values(this.missCounts).reduce((a, b) => a + b, 0)
  }

  /**
   * 按优先级链取一个块。
   *
   * @returns 命中 ⇒ `SourceFetchOutcome`（含**点名档位**）；五档皆无 ⇒ `undefined`
   */
  async fetch(id: string): Promise<SourceFetchOutcome | undefined> {
    const tried: SourceTier[] = []
    for (const tier of this.order) {
      tried.push(tier)
      const fetcher = this.fetchers[tier]
      if (fetcher === undefined) {
        // 该档没装配 ⇒ 视为"没有"，但**仍然计数**（否则"忘了装配"会静默变成"链路短了"）
        this.missCounts[tier] += 1
        this.onMiss?.(tier, id)
        continue
      }
      let got: TierFetchResult | undefined
      try {
        got = await fetcher(id)
      } catch (err) {
        // 纪律 2：抛错单独计数，且**继续往下一档**（不许整体失败、不许吞）
        this.errorCounts[tier] += 1
        this.onError?.(tier, id, err)
        continue
      }
      if (got === undefined) {
        this.missCounts[tier] += 1
        this.onMiss?.(tier, id)
        continue
      }
      // ── 🆕 单 B：**唯一解密点**（五档一律走这里 ⇒ ⛔ 不存在按档位分叉的双口径）──────
      let bytes = got.bytes
      if (this.decode !== undefined) {
        const plain = this.decode(bytes)
        if (plain === undefined) {
          // 解密失败按"抛错"处置（**可区分**于"没有"），并**继续下一档**
          this.errorCounts[tier] += 1
          this.decodeRejectCounts[tier] += 1
          this.onError?.(tier, id, new Error(`content-source: tier=${tier} 取回的字节解密失败（认证未过）`))
          this.onDecodeRejected?.(tier, id, 'decode-failed')
          continue
        }
        bytes = plain
      }
      this.hits[tier] += 1
      this.onHit?.(tier, id)
      return { tier, bytes, tried }
    }
    return undefined
  }
}
