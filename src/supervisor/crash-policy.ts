/**
 * Crash-restart policy for a resident main DSH (方案 A).
 *
 * Pure decision logic, deliberately separated from `LocalSpawner` so it can be
 * unit-tested without spawning anything: given the recent restart timestamps
 * and the current consecutive-attempt count, decide either "restart after
 * `delayMs` (exponential backoff capped at `maxDelayMs`)" or "circuit open"
 * (too many restarts inside the window — stop auto-restarting so a
 * persistently failing instance cannot spin spawns forever).
 *
 * @module dsh_ai1net/supervisor/crash-policy
 */

/** Tunables (see {@link ServerConfig} — all env-overridable). */
export interface CrashPolicyConfig {
  /** Delay for the first restart (consecutive attempt 0). */
  baseDelayMs: number
  /** Upper bound for the exponential backoff. */
  maxDelayMs: number
  /** Rolling window over which restarts are counted. */
  windowMs: number
  /** Restarts allowed inside the window before the circuit opens. */
  maxRestartsInWindow: number
  /** A main that stays up this long is considered recovered: streak resets. */
  stableResetMs: number
}

/** Outcome of one crash decision. */
export type CrashDecision =
  | { action: 'restart'; delayMs: number; attempt: number; windowRestarts: number }
  | { action: 'circuit-open'; windowRestarts: number }

/** Drop timestamps that fell out of the rolling window. */
export function pruneHistory(history: readonly number[], now: number, windowMs: number): number[] {
  return history.filter((at) => now - at < windowMs)
}

/** Exponential backoff for a given consecutive attempt (0-based), capped. */
export function backoffDelayMs(consecutive: number, cfg: Pick<CrashPolicyConfig, 'baseDelayMs' | 'maxDelayMs'>): number {
  const safe = Math.max(0, Math.min(consecutive, 20)) // guard against overflow
  return Math.min(cfg.baseDelayMs * 2 ** safe, cfg.maxDelayMs)
}

/**
 * Decide what to do after a main crashed.
 * @param history - restart timestamps (ms epoch) already recorded for this user.
 * @param consecutive - consecutive attempts since the last stable run.
 * @param now - current time (ms epoch).
 * @param cfg - policy tunables.
 */
export function decideCrashAction(
  history: readonly number[],
  consecutive: number,
  now: number,
  cfg: CrashPolicyConfig,
): CrashDecision {
  const inWindow = pruneHistory(history, now, cfg.windowMs)
  if (inWindow.length >= cfg.maxRestartsInWindow) {
    return { action: 'circuit-open', windowRestarts: inWindow.length }
  }
  return {
    action: 'restart',
    delayMs: backoffDelayMs(consecutive, cfg),
    attempt: consecutive + 1,
    windowRestarts: inWindow.length + 1,
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 熔断冷却（防「崩溃循环可无限重来」）
 *
 * 原始缺陷：`circuit-open` 分支里 `mains.delete` + `resetCrashState()` 会把窗口
 * 历史一并清空，于是**下一次 enter/launch 又是满额预算** —— 只要有人（用户 F5、
 * 注入脚本自愈、脚本直铺）不断重试，崩溃循环就能无限重复，且只留一行 stderr。
 *
 * 修法：每次熔断记一个**跨轮存活**的冷却窗（`opens` 递增 → 冷却指数加长），
 * 冷却期内拒绝隐式/自动启动；冷却过后只给**一次**干净预算。纯函数，便于单测。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 熔断状态：`opens` = 该用户累计熔断次数（跨轮不清零）。 */
export interface BreakerState {
  openedAt: number
  opens: number
}

/** 冷却策略（见 ServerConfig，均可 env 覆盖）。 */
export interface BreakerPolicy {
  baseCooldownMs: number
  maxCooldownMs: number
}

/** 第 `opens` 次熔断的冷却时长：`base × 2^(opens-1)`，上限 `maxCooldownMs`。 */
export function breakerCooldownMs(opens: number, cfg: BreakerPolicy): number {
  const safe = Math.max(1, Math.min(opens, 20))
  return Math.min(cfg.baseCooldownMs * 2 ** (safe - 1), cfg.maxCooldownMs)
}

/** 冷却是否仍在生效（`now < openedAt + cooldown`）。 */
export function breakerActive(b: BreakerState | undefined, now: number, cfg: BreakerPolicy): boolean {
  if (b === undefined) return false
  return now < b.openedAt + breakerCooldownMs(b.opens, cfg)
}

/** 冷却结束时刻（无熔断时返回 0）。 */
export function breakerUntil(b: BreakerState | undefined, cfg: BreakerPolicy): number {
  return b === undefined ? 0 : b.openedAt + breakerCooldownMs(b.opens, cfg)
}

/** 再次熔断：`opens` 递增，`openedAt` 取本次时刻。 */
export function openBreaker(prev: BreakerState | undefined, now: number): BreakerState {
  return { openedAt: now, opens: (prev?.opens ?? 0) + 1 }
}
