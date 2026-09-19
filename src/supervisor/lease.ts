/**
 * 实例归属租约（T08 S2；设计 §3.1–§3.2）。
 *
 * **为什么必须有它**：local 模式靠"进程内 Map + 单机"天然保证「一个用户同时只有一个活实例」；
 * 多机后这个保证只能落到 **DB 的原子 CAS** 上 —— 否则两个 worker 会同时写同一个 `$DSH_HOME`
 * （会话日志 append 冲突 ⇒ **数据损坏**，本库最贵的一类事故）。
 *
 * 三条不变量（都不许省）：
 *  1. **单写者**：抢占必须原子（`claimInstance` 的 `UPDATE … WHERE 无人持有 OR 租约过期`），
 *     调用方以"是否真正更新到行"判定成败，**不许"先读后写"**。
 *  2. **TTL > 2 × 续租间隔**：留足抖动余量；否则自身网络一抖就会误判自己失权
 *     （或更糟 —— 误判别人已死）。构造时**硬校验**，fail-loud。
 *  3. **fencing**：每次操作带 `epoch`；不匹配 = 已被他人抢占 ⇒ 调用方必须**自杀**
 *     （self-fencing，如停掉自己那个实例），而不是继续写。
 *
 * ⚠️ 与 **R9** 的关系：本模块只提供"判定与递增 epoch"的机械能力，
 * **不提供**"判定对方已死 → 接管"的自动化。没有心跳判据时单方面接管是被明令禁止的；
 * 因此 `expiredAll()` 只用于**巡检/报告/人工确认后的动作**，绝不自动接管。
 *
 * @module dsh_ai1net/supervisor/lease
 */
import type { DbAdapter } from '../db/adapter.js'
import type { ClaimResult, DshInstance } from '../db/types.js'

/** 默认租约存活 30 s（设计 §3.2 的建议时序）。 */
export const DEFAULT_LEASE_TTL_MS = 30_000
/** 默认续租间隔 10 s（不变量：ttl > 2 × renew）。 */
export const DEFAULT_LEASE_RENEW_MS = 10_000

export interface LeaseOptions {
  /** 租约存活时长（ms）。不变量：必须 **> 2 × renewMs**。 */
  ttlMs?: number
  /** 续租间隔（ms）。 */
  renewMs?: number
  /** 注入时钟 —— 仅用于本类自己的判定（**SQL 里的 now 仍是 `Date.now()`**）。 */
  now?: () => number
}

/**
 * 某实例当前是否由「我」合法持有（fencing 判据）。
 *
 * 用在两处：① 收到心跳/指令前自检"我还是不是持有者"② 老 worker 复活后判断
 * 自己**是否已被接管** ⇒ 是则自杀（防双写）。
 */
export function stillHolder(
  instance: DshInstance | undefined,
  hostId: string,
  epoch: number,
): boolean {
  return instance !== undefined && instance.hostId === hostId && instance.epoch === epoch
}

/** 一个用户实例的租约句柄（holding = 我持有 + 我的 epoch）。 */
export class InstanceLease {
  readonly hostId: string
  private readonly db: DbAdapter
  private readonly ttl: number
  private readonly renewInterval: number
  private readonly now: () => number
  /**
   * userId → **我认领到的那把租约**（epoch + 落在哪个 host）。
   *
   * 为什么必须记住 hostId：多 worker 后 `renewInstanceLease(userId, hostId, epoch)` 要能在
   * **正确的那个 host** 上校验；只记 epoch 会在多机下续错对象（2026-09-15 T08 S6）。
   */
  private readonly held = new Map<string, { epoch: number; hostId: string }>()

  constructor(db: DbAdapter, hostId: string, options: LeaseOptions = {}) {
    this.db = db
    this.hostId = hostId
    this.ttl = options.ttlMs ?? DEFAULT_LEASE_TTL_MS
    this.renewInterval = options.renewMs ?? DEFAULT_LEASE_RENEW_MS
    this.now = options.now ?? Date.now
    // 不变量：TTL 必须显著大于续租间隔，否则单次网络抖动就会造成"自己失权"或"误判他人已死"。
    if (this.ttl <= 2 * this.renewInterval) {
      throw new Error(
        `lease: ttlMs(${this.ttl}) must be > 2 × renewMs(${this.renewInterval}) —— ` +
          '否则时钟/网络抖动会破坏单写者保证（设计 §3.2 不变量 2）',
      )
    }
  }

  get ttlMs(): number {
    return this.ttl
  }

  get renewMs(): number {
    return this.renewInterval
  }

  /** 我当前认领的实例（userId → {epoch, hostId}）。 */
  holdings(): ReadonlyMap<string, { epoch: number; hostId: string }> {
    return this.held
  }

  /**
   * 抢占某用户 main 实例的归属。
   *
   * `ok:false` = 有人在管 ⇒ **退让**：不要接管、不要重试到死，交给上层决定
   * （拉长等待 / 报告管理员）。成功时记住 epoch 供续租与 fencing 使用。
   */
  async acquire(
    userId: string,
    hostId?: string,
    meta?: { folder?: string; patch?: string },
  ): Promise<ClaimResult> {
    const target = hostId ?? this.hostId
    // meta（folder/patch）随认领一起落库 ⇒ 迁移才能复现启动参数
    const res = await this.db.claimInstance(userId, target, this.ttl, meta)
    if (res.ok) this.held.set(userId, { epoch: res.epoch, hostId: target })
    return res
  }

  /**
   * 续租。返回 false = **我已失权**（被他人以更高 epoch 抢占，或行被删）⇒ 调用方
   * 必须 self-fence（停掉自己那个实例），并清掉本地记录。
   */
  async renew(userId: string): Promise<boolean> {
    const held = this.held.get(userId)
    if (held === undefined) return false
    const ok = await this.db.renewInstanceLease(userId, held.hostId, held.epoch, this.ttl)
    if (!ok) this.held.delete(userId)
    return ok
  }

  /** 批量续租（心跳 tick 用）。返回失权的 userId 列表（调用方据此 self-fence）。 */
  async renewAll(): Promise<string[]> {
    const lost: string[] = []
    for (const userId of [...this.held.keys()]) {
      if (!(await this.renew(userId))) lost.push(userId)
    }
    return lost
  }

  /** 主动释放（停实例时）。成功后不再持有该用户。 */
  async release(userId: string): Promise<boolean> {
    const held = this.held.get(userId)
    if (held === undefined) return false
    const ok = await this.db.releaseInstanceLease(userId, held.hostId, held.epoch)
    if (ok) this.held.delete(userId)
    return ok
  }

  /** 重新读取 DB 里的真实归属，校正本地记录（对账用）。 */
  async refresh(userId: string): Promise<DshInstance | undefined> {
    const inst = await this.db.findUserInstance(userId, 'main')
    const held = this.held.get(userId)
    if (!stillHolder(inst, held?.hostId ?? this.hostId, held?.epoch ?? -1)) this.held.delete(userId)
    return inst
  }

  /** **我名下**租约已过期的实例（供巡检；**不等于可以接管**，见模块头与 R9）。 */
  async expiredHere(): Promise<DshInstance[]> {
    const all = await this.db.listExpiredInstanceLeases(this.now())
    const mine = new Set([...this.held.values()].map((h) => h.hostId))
    mine.add(this.hostId)
    return all.filter((inst) => inst.hostId !== null && mine.has(inst.hostId))
  }

  /** 全集群租约已过期的实例（管理面/巡检用；**不自动接管**）。 */
  async expiredAll(): Promise<DshInstance[]> {
    return this.db.listExpiredInstanceLeases(this.now())
  }

  /** 对账：**一次拿回本机全部实例**（替代逐用户查询，设计 §11.6）。 */
  async mine(): Promise<DshInstance[]> {
    return this.db.listInstancesByHost(this.hostId)
  }
}
