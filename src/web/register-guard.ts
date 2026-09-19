/**
 * 注册验证码的**防爆破策略**（纯函数 + 纯数据，便于单测与复用）。
 *
 * 为什么单独成模块：限流一旦和路由耦合，就只能靠"真打一遍接口"验证 —— 而限流恰恰是
 * **最需要精确边界**的东西（差 1 秒就漏一次发送）。这里所有判定都不碰 IO：
 * 输入 = 计数快照 + 当前时间，输出 = 允许/拒绝 + 还需等多久，因此可以逐边界断言。
 *
 * 设计口径（用户 2026-09-19 需求：「增加重复获取验证码的爆破设计」）：
 *   ① **发送侧**是花钱 + 打信誉的动作 ⇒ 收紧（阶梯冷却 + 每小时/每天配额 + IP 维度 + 全局维度）；
 *   ② **校验侧**是猜码 ⇒ 每个码最多试 N 次、超过即作废、成功即作废（单次使用）；
 *   ③ 被拒绝的请求**也要落库计入配额** —— 否则"被拒 → 立刻重试"就成了无限循环，
 *      而且拿不到"有人在猛撞"的证据；
 *   ④ 冷却时间随次数**递增**（阶梯），让脚本化重试的收益递减，而真人重发一次仍只等 60 秒。
 */

import type { EmailCodeCounts, EmailCodeRow } from '../db/types.js'

/** 生效中的策略值（可由配置覆盖；默认值即生产口径）。 */
export interface GuardPolicy {
  /** 验证码有效期。 */
  codeTtlMs: number
  /** 同一个码最多允许试错几次，达上限**立即作废**（必须重新获取）。 */
  maxAttemptsPerCode: number
  /** 同一邮箱每小时最多**发起**几次（含被拒的）。 */
  emailPerHour: number
  /** 同一邮箱每 24 小时最多**真正发出**几封。 */
  emailSentPerDay: number
  /** 同一 IP 每小时最多发起几次（IP 可能 NAT，给得比邮箱宽）。 */
  ipPerHour: number
  /** 保护邮件服务商日配额的全局闸门（每小时）。 */
  globalPerHour: number
  /**
   * 冷却阶梯：索引 = 该邮箱**最近一小时内已发起的次数**（超出则用最后一项）。
   * 于是"第 1、2 次等 60 秒；第 3 次 3 分钟；第 4 次 5 分钟；第 5 次起 15~30 分钟"。
   */
  cooldownLadderMs: readonly number[]
}

export const DEFAULT_GUARD_POLICY: GuardPolicy = {
  codeTtlMs: 10 * 60 * 1000,
  maxAttemptsPerCode: 5,
  /**
   * 6 = **刚好让冷却阶梯的每一级都可达**（阶梯索引 = 一小时内已发起次数，0…5）。
   * 若设成 5，最后一级（30 分钟）永远走不到 —— 那就等于白写一级。
   * 真正拦人的是阶梯（累计 60+60+180+300+900+1800 ≈ 55 分钟），小时配额只是兜底。
   */
  emailPerHour: 6,
  emailSentPerDay: 8,
  ipPerHour: 20,
  globalPerHour: 200,
  cooldownLadderMs: [60_000, 60_000, 180_000, 300_000, 900_000, 1_800_000],
}

export const HOUR_MS = 60 * 60 * 1000
export const DAY_MS = 24 * HOUR_MS

/** 计数快照：两个窗口各查一次（`hour` 供冷却与小时配额，`day` 供日配额）。 */
export interface GuardCounts {
  hour: EmailCodeCounts
  day: EmailCodeCounts
}

export type SendVerdict =
  | { allowed: true; cooldownMs: number }
  | { allowed: false; reason: string; retryAfterSeconds: number }

/**
 * 发送前判定。**顺序有意义**：先判配额（终局性拒绝，无"等一会就好"的错觉），
 * 再判冷却（可以等到具体时刻）。
 */
export function evaluateSendGuard(counts: GuardCounts, now: number, policy: GuardPolicy = DEFAULT_GUARD_POLICY): SendVerdict {
  const { hour, day } = counts

  if (day.emailSent >= policy.emailSentPerDay) {
    // 按"本邮箱当天第一封的时间 + 24h"给出最早可再试的时刻，避免用户面对一个空泛的拒绝。
    return { allowed: false, reason: 'email_daily_quota', retryAfterSeconds: 3600 }
  }
  if (hour.emailTotal >= policy.emailPerHour) {
    return {
      allowed: false,
      reason: 'email_hourly_quota',
      retryAfterSeconds: Math.max(1, Math.ceil((HOUR_MS - (now - hour.emailLastAt)) / 1000)),
    }
  }
  if (counts.hour.ipTotal >= policy.ipPerHour) {
    return { allowed: false, reason: 'ip_hourly_quota', retryAfterSeconds: 600 }
  }
  if (hour.globalTotal >= policy.globalPerHour) {
    return { allowed: false, reason: 'global_hourly_quota', retryAfterSeconds: 300 }
  }

  const ladder = policy.cooldownLadderMs
  const cooldown = ladder[Math.min(hour.emailTotal, ladder.length - 1)] ?? 60_000
  const last = hour.emailLastAt
  if (last > 0 && now - last < cooldown) {
    return {
      allowed: false,
      reason: 'email_cooldown',
      retryAfterSeconds: Math.max(1, Math.ceil((cooldown - (now - last)) / 1000)),
    }
  }
  return { allowed: true, cooldownMs: cooldown }
}

/** 校验前的判定（尚未比较哈希）：码存在性 / 有效期 / 试错余量。 */
export type VerifyPreVerdict = 'ok' | 'missing' | 'expired' | 'too_many_attempts' | 'used'

export function evaluateVerifyGuard(
  row: EmailCodeRow | undefined,
  now: number,
  policy: GuardPolicy = DEFAULT_GUARD_POLICY,
): VerifyPreVerdict {
  if (row === undefined || row.code_hash === null) return 'missing'
  // `consumed_at` 非空 = 已用掉或被判作废（试错超限）。
  if (row.consumed_at !== null) return row.attempts >= policy.maxAttemptsPerCode ? 'too_many_attempts' : 'used'
  if (row.expires_at !== null && now > row.expires_at) return 'expired'
  return 'ok'
}

/** 把剩余等待秒数切成给用户看的粒度（前端只用它做倒计时）。 */
export function formatRetryAfter(seconds: number): string {
  if (seconds <= 90) return `${seconds} 秒`
  const minutes = Math.ceil(seconds / 60)
  return minutes < 60 ? `${minutes} 分钟` : `${Math.ceil(minutes / 60)} 小时`
}
