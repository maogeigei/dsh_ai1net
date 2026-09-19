/**
 * 注册邮箱验证码：发码 / 校验两条链路 + 防爆破。路由层只做参数校验与响应组装。
 *
 * **为什么单独成模块**：这一段同时牵着四样东西 —— DB 事件表（配额与验证码的唯一来源）、
 * 外发邮件、人机验证、以及限流策略。塞进 `routes/auth.ts` 会让"注册"这个路由变成
 * 300 行的混合体，且**没法单测**（策略本身要用真接口才验得到边界）。拆出来后：
 *   · 策略 = `register-guard.ts`（纯函数，可逐边界断言）
 *   · 通道 = `mail.ts` / `turnstile.ts`（只负责一次网络往返）
 *   · 编排 = 本文件（把上面三者按"先判配额 → 再发信 → 落事件"的顺序串起来）
 *
 * 三条不可让步的顺序：
 *   ① **先人机验证再花配额** —— 否则机器人可以靠"打满配额"把真用户挡在门外；
 *   ② **被拒绝也要落库** —— 事件表既是配额来源，也是"有人在撞"的唯一证据；
 *   ③ **发信成功才记 `sent`** —— 记早了会让"上游全挂"看起来像"发出去过"。
 * @module dsh_ai1net/web/email-code
 */

import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DbAdapter } from '../db/adapter.js'
import type { ServerConfig } from '../config.js'
import { sendVerificationCodeMail, type MailSettings } from './mail.js'
import { turnstileEnabled, type TurnstileSettings } from './turnstile.js'
import {
  DAY_MS,
  HOUR_MS,
  evaluateSendGuard,
  evaluateVerifyGuard,
  type GuardPolicy,
} from './register-guard.js'

export const PURPOSE_REGISTER = 'register'

/** 事件表自维护：每小时最多清一次 30 天前的行。 */
const PURGE_OLDER_THAN_MS = 30 * DAY_MS
const PURGE_INTERVAL_MS = HOUR_MS

/** 进程内串行化：同一邮箱同时只允许一个发信在飞（单进程控制面，够用）。 */
const inflight = new Map<string, Promise<unknown>>()

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

export function isValidEmail(email: string): boolean {
  return email.length >= 6 && email.length <= 254 && EMAIL_RE.test(email)
}

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username)
}

/** 邮件里的站点名：取主域名标签大写（`<base-domain>` → `EXAMPLE`）。空 ⇒ 不写站点名。 */
export function mailBrandFromConfig(config: ServerConfig): string {
  const domain = (config.baseDomain ?? '').trim()
  if (domain === '') return ''
  const label = domain.split('.')[0] ?? ''
  return label === '' ? '' : label.toUpperCase()
}

/** 6 位数字（含前导 0）。用 `randomInt` 而非 `Math.random` —— 后者可预测。 */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** 验证码**不存明文**：sha256(email | purpose | code | pepper)，pepper = 平台密钥。 */
export function hashCode(email: string, purpose: string, code: string, pepper: string): string {
  return createHash('sha256').update(`${email}|${purpose}|${code}|${pepper}`).digest('hex')
}

/** 定长比较（两边都是 hex ⇒ 等长），避免按字节短路泄露前缀。 */
export function codeMatches(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(candidate, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 把配置翻译成策略。**策略与配置分家**：策略是纯函数需要的形状，配置是 env 的形状。 */
export function guardPolicyFromConfig(config: ServerConfig): GuardPolicy {
  return {
    codeTtlMs: config.emailCodeTtlMs,
    maxAttemptsPerCode: config.emailCodeMaxAttempts,
    emailPerHour: config.emailCodeGuard.emailPerHour,
    emailSentPerDay: config.emailCodeGuard.emailSentPerDay,
    ipPerHour: config.emailCodeGuard.ipPerHour,
    globalPerHour: config.emailCodeGuard.globalPerHour,
    cooldownLadderMs: config.emailCodeGuard.cooldownLadderMs,
  }
}

export function mailSettingsFromConfig(config: ServerConfig): MailSettings {
  return {
    driver: config.mailDriver,
    apiUrl: config.mailApiUrl,
    apiKey: config.mailApiKey,
    authHeader: config.mailAuthHeader,
    from: config.mailFrom,
    fromName: config.mailFromName,
    bodyTemplate: config.mailBodyTemplate,
    timeoutMs: config.mailTimeoutMs,
  }
}

export function turnstileSettingsFromConfig(config: ServerConfig): TurnstileSettings {
  return {
    siteKey: config.turnstileSiteKey,
    secret: config.turnstileSecret,
    timeoutMs: 8000,
    action: config.turnstileAction,
    hostnames: config.turnstileHostnames,
  }
}

/** 人机验证是否**实际**启用（要密钥成对 + 期望主机名非空 + 策略要求）。 */
export function captchaActive(config: ServerConfig): boolean {
  return config.registerRequireCaptcha && turnstileEnabled(turnstileSettingsFromConfig(config))
}

/**
 * 「配了一半」的检测：**密钥给了但从没给期望主机名**。
 *
 * 为什么单独判这个：`hostnames` 为空 ⇒ `turnstileEnabled=false` ⇒ 人机验证**静默不生效**
 * （注册页不渲染控件）。这是"看起来配了、实际没防住"的典型形态，必须能在日志里被看见，
 * 否则只有抓包才能发现。
 */
export function captchaPartiallyConfigured(config: ServerConfig): boolean {
  const keysGiven = config.turnstileSiteKey !== '' && config.turnstileSecret !== ''
  return keysGiven && config.turnstileHostnames.length === 0
}

/**
 * 邮箱验证码是否**实际**强制。注意是"策略要求 **且** 邮件通道已配置"——
 * 只要求策略、不检查通道，会让一个配错 env 的部署**彻底注册不进来**。
 */
export function emailCodeActive(config: ServerConfig): boolean {
  if (!config.registerRequireEmailCode) return false
  const settings = mailSettingsFromConfig(config)
  if (settings.driver === 'log') return true
  return settings.apiKey !== '' && settings.from !== ''
}

export interface RequestCodeInput {
  email: string
  username: string
  ip: string | null
}

export interface RequestCodeOutcome {
  ok: boolean
  /** 直接作为 HTTP 状态码使用。 */
  status: number
  error: string | null
  retryAfterSeconds: number
  expiresInSeconds: number
}

export interface ConsumeCodeInput {
  email: string
  username: string
  code: string
  ip: string | null
}

export interface ConsumeCodeOutcome {
  ok: boolean
  status: number
  error: string | null
  /** 还剩几次机会（失败时给界面用；不泄露码本身）。 */
  attemptsLeft?: number
}

/** 同邮箱串行化：并发点两次"获取验证码"只会有一次真的发信。 */
function withEmailLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const previous = inflight.get(email) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  // 表里只留"不会 reject 的链尾"，避免未处理的 rejection 与 Map 无界增长。
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  inflight.set(email, tail)
  return run.finally(() => {
    if (inflight.get(email) === tail) inflight.delete(email)
  })
}

let lastPurgeAt = 0

/** 机会性清理：调用方不用管，量级极小（每邮箱每小时个位行）。 */
async function maybePurge(db: DbAdapter, now: number): Promise<void> {
  if (now - lastPurgeAt < PURGE_INTERVAL_MS) return
  lastPurgeAt = now
  try {
    await db.purgeEmailCodes(now - PURGE_OLDER_THAN_MS)
  } catch {
    // 清理失败不影响发码；下次再试。
  }
}

/**
 * 发码。**调用方必须先完成人机验证**（本函数不碰 Turnstile，避免两处都校一遍）。
 */
export async function requestRegisterCode(
  deps: { db: DbAdapter; config: ServerConfig; onWarn?: (message: string) => void },
  input: RequestCodeInput,
): Promise<RequestCodeOutcome> {
  const { db, config } = deps
  const policy = guardPolicyFromConfig(config)
  const now = Date.now()
  const email = normalizeEmail(input.email)
  const miss = (status: number, error: string, retryAfterSeconds = 0): RequestCodeOutcome => ({
    ok: false,
    status,
    error,
    retryAfterSeconds,
    expiresInSeconds: Math.ceil(policy.codeTtlMs / 1000),
  })

  if (!isValidEmail(email)) return miss(400, 'invalid_email')
  if (!isValidUsername(input.username)) return miss(400, 'invalid_username')

  // 提前挡住注定失败的注册：既不浪费邮件配额，也让用户在填表阶段就得到反馈。
  if ((await db.findUserByUsername(input.username)) !== undefined) return miss(409, 'username_taken')
  if ((await db.findUserByEmail(email)) !== undefined) return miss(409, 'email_taken')

  await maybePurge(db, now)

  const [hour, day] = await Promise.all([
    db.emailCodeCounts(email, input.ip, now - HOUR_MS),
    db.emailCodeCounts(email, input.ip, now - DAY_MS),
  ])
  const verdict = evaluateSendGuard({ hour, day }, now, policy)
  if (!verdict.allowed) {
    // ③ 被拒也落库：它是配额的一部分，也是"有人在猛撞"的证据。
    await db.recordEmailCode({
      id: randomUUID(),
      email,
      purpose: PURPOSE_REGISTER,
      codeHash: null,
      status: 'throttled',
      ip: input.ip,
      username: input.username,
      reason: verdict.reason,
      createdAt: now,
    })
    return miss(429, verdict.reason, verdict.retryAfterSeconds)
  }

  return withEmailLock(email, async () => {
    const code = generateCode()
    const settings = mailSettingsFromConfig(config)
    const result = await sendVerificationCodeMail(settings, {
      to: email,
      code,
      ttlMinutes: Math.round(policy.codeTtlMs / 60_000),
      brand: mailBrandFromConfig(config),
    })

    if (!result.ok) {
      // ② 发信失败**也**占配额（否则上游一挂，请求会无限重试把它压得更死）。
      await db.recordEmailCode({
        id: randomUUID(),
        email,
        purpose: PURPOSE_REGISTER,
        codeHash: null,
        status: 'failed',
        ip: input.ip,
        username: input.username,
        reason: result.error,
        createdAt: now,
      })
      deps.onWarn?.(`[register-code] 发送失败 to=${maskEmail(email)} driver=${settings.driver} err=${result.error ?? ''}`)
      return miss(502, 'mail_send_failed')
    }

    // ③ 只有真发出去才记 `sent`（它才是可校验的那一行）。
    if (settings.driver === 'log') {
      // 显式选择了 `log` 驱动才把验证码写进服务日志（开发/断网排障用）。
      deps.onWarn?.(`[register-code][log-driver] ${maskEmail(email)} 验证码=${code}（${Math.round(policy.codeTtlMs / 60_000)} 分钟内有效）`)
    }
    await db.recordEmailCode({
      id: randomUUID(),
      email,
      purpose: PURPOSE_REGISTER,
      codeHash: hashCode(email, PURPOSE_REGISTER, code, config.encryptionSecret),
      status: 'sent',
      ip: input.ip,
      username: input.username,
      reason: null,
      createdAt: now,
      expiresAt: now + policy.codeTtlMs,
    })

    return {
      ok: true,
      status: 200,
      error: null,
      retryAfterSeconds: Math.ceil(verdict.cooldownMs / 1000),
      expiresInSeconds: Math.ceil(policy.codeTtlMs / 1000),
    }
  })
}

/**
 * 校验并**消费**验证码。返回 `ok:true` 时该码已被标记用掉（单次使用），
 * 调用方可以放心建账号 —— 重复提交同一码会在第二次拿到 `code_used`。
 */
export async function consumeRegisterCode(
  deps: { db: DbAdapter; config: ServerConfig },
  input: ConsumeCodeInput,
): Promise<ConsumeCodeOutcome> {
  const { db, config } = deps
  const policy = guardPolicyFromConfig(config)
  const now = Date.now()
  const email = normalizeEmail(input.email)
  const fail = (status: number, error: string, attemptsLeft?: number): ConsumeCodeOutcome => ({
    ok: false,
    status,
    error,
    attemptsLeft,
  })

  if (!isValidEmail(email)) return fail(400, 'invalid_email')
  if (!/^\d{4,8}$/.test(input.code)) return fail(400, 'code_invalid')

  const row = await db.latestSentEmailCode(email, PURPOSE_REGISTER)
  const pre = evaluateVerifyGuard(row, now, policy)
  if (pre === 'missing') return fail(400, 'code_missing')
  if (pre === 'used') return fail(400, 'code_used')
  if (pre === 'too_many_attempts') return fail(400, 'code_attempts_exceeded')
  if (pre === 'expired') return fail(400, 'code_expired')
  if (row === undefined) return fail(400, 'code_missing')

  // 验证码与"申请时填的用户名"绑定：换用户名重放同一封邮件里拿到的码不作数。
  if (row.username !== null && row.username.toLowerCase() !== input.username.toLowerCase()) {
    return fail(400, 'code_username_mismatch')
  }

  const expected = hashCode(email, PURPOSE_REGISTER, input.code, config.encryptionSecret)
  if (!codeMatches(row.code_hash ?? '', expected)) {
    const nextAttempts = row.attempts + 1
    const consume = nextAttempts >= policy.maxAttemptsPerCode
    await db.bumpEmailCodeAttempts(row.id, consume, now)
    return consume
      ? fail(400, 'code_attempts_exceeded', 0)
      : fail(400, 'code_invalid', Math.max(0, policy.maxAttemptsPerCode - nextAttempts))
  }

  // 单次使用：CAS 失败 = 已被并发请求用掉。
  if (!(await db.consumeEmailCode(row.id, now))) return fail(409, 'code_used')
  return { ok: true, status: 200, error: null }
}

/** 日志里的邮箱脱敏（只留域名，够定位是哪家邮箱出问题）。 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@')
  return at <= 0 ? '***' : `***${email.slice(at)}`
}
