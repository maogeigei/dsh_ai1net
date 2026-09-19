/**
 * Cloudflare Turnstile 服务端校验（注册页人机验证）。
 *
 * 为什么人机验证放在**服务端**而不是只靠前端 widget：
 * 前端 widget 只负责"取一个 token"，token 本身**谁都能伪造**—— 只有拿它去 CF 的
 * `siteverify` 换回 `success:true` 才算数。因此后端必须独立再校一遍，且**发码与注册两处都校**
 * （发码是花钱动作、注册是建账号动作，任一被绕过都不算防住）。
 *
 * 两处刻意的选择：
 *   ① **失败关闭（fail-closed）**：CF 不可达 / 校验不通过 ⇒ 直接拒绝注册。
 *      理由：Turnstile 是反自动化闸门，若"网络一抖就放行"，攻击者只要让校验超时即可绕过。
 *      代价是 CF 侧长时间不可用时注册会受影响 —— 因此失败原因**分类返回**（见 `error`），
 *      运维能一眼分清"配错了密钥"和"上游抽风"。
 *   ② token **单次有效**（CF 语义）：一个 token 校验过一次后再用会拿到 `timeout-or-duplicate`。
 *      所以发码成功与注册成功之后，前端都必须 `reset()` 重新取 —— 见 `web/register.html`。
 * @module dsh_ai1net/web/turnstile
 */

/** Turnstile 的运行时配置（由 `config.ts` 从 env 组装）。 */
export interface TurnstileSettings {
  /** 站点公钥 —— 会下发到注册页，**不是秘密**。 */
  siteKey: string
  /** 服务端密钥 —— 只留在服务端，绝不下发。 */
  secret: string
  timeoutMs: number
  /**
   * 期望的 `action`（渲染 widget 时声明、siteverify 时回显）。
   * 为什么必须校：`action` 是 CF 给"这一枚 token 是给哪个业务用的"打的标签。
   * 不校它 ⇒ 我们**所有**用同一 sitekey 的入口共享 token，人机验证退化成"过了任意一处即可用到处"。
   * 取值约束（CF 规定）：1–32 字符，仅字母 / 数字 / `_` / `-`。
   */
  action: string
  /**
   * 期望的**前端主机名**白名单（`result.hostname` 必须在此列）。
   *
   * 🔴 为什么这是**最关键**的一项：sitekey 是公开的（会出现在页面 HTML 里）⇒
   * 攻击者可以在**自己的站点**上嵌入我们的 sitekey、为真人访客拿到合法 token，再拿去打我们的接口
   * —— 只校 `success` 的话，这条路完全通畅。`hostname` 是**服务端**（CF）判定并回显的，
   * 访客篡改不了 ⇒ 只有校它才能真正把 token 绑到"从我们站点发出的挑战"上。
   *
   * ⚠️ 空数组 = **不安全**，`captchaActive()` 据此判"未配置完成"（宁可功能不启用，也不放开）。
   */
  hostnames: string[]
  /**
   * siteverify 端点（可选，默认 Cloudflare 官方）。
   * 做成可覆盖的**唯一动机是可测性**：`action` / `hostname` 这两条判定是"放过还是拦下"的
   * 全部依据，必须能逐组合断言 —— 而硬编码 URL 就只能靠"真拿 CF token 打线上"才验得到。
   */
  verifyUrl?: string
}

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export interface TurnstileResult {
  ok: boolean
  /** CF 的错误码或本地判定的拒绝原因；网络失败时为 `network_error`。 */
  error: string | null
}

/** 是否启用：**公钥、私钥、期望主机名三者齐了才算配置完成**（缺一视为未启用并告警）。 */
export function turnstileEnabled(settings: TurnstileSettings): boolean {
  return settings.siteKey !== '' && settings.secret !== '' && settings.hostnames.length > 0
}

/**
 * 服务端校验一个 Turnstile token。永不抛异常。
 * 判定**三项齐备**才放行（与 Cloudflare 官方 canonical siteverify 同口径）：
 * `success === true` ∧ `action` 匹配 ∧ `hostname` 在白名单内。
 */
export async function verifyTurnstile(
  settings: TurnstileSettings,
  token: string,
  remoteIp?: string,
): Promise<TurnstileResult> {
  if (!turnstileEnabled(settings)) return { ok: false, error: 'not_configured' }
  if (token === '') return { ok: false, error: 'missing-input-response' }
  // 官方上限 2048：超长一律视为伪造（不必浪费一次上游往返）。
  if (token.length > 2048) return { ok: false, error: 'invalid-input-response' }

  const form = new URLSearchParams()
  form.set('secret', settings.secret)
  form.set('response', token)
  if (remoteIp !== undefined && remoteIp !== '') form.set('remoteip', remoteIp)

  try {
    const res = await fetch(settings.verifyUrl ?? SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(settings.timeoutMs),
    })
    if (!res.ok) return { ok: false, error: `siteverify_http_${res.status}` }
    const body = (await res.json()) as {
      success?: boolean
      action?: string
      hostname?: string
      'error-codes'?: string[]
    }
    if (body.success !== true) {
      const codes = body['error-codes'] ?? []
      return { ok: false, error: codes.length === 0 ? 'verification_failed' : codes.join(',') }
    }
    // ⚠️ `success:true` 之后**仍要**校这两项 —— 它们才是"这枚 token 是为我们站点、我们这个动作签发的"证据。
    if (settings.action !== '' && body.action !== settings.action) {
      return { ok: false, error: `action_mismatch: ${body.action ?? '(none)'}` }
    }
    if (body.hostname === undefined || !settings.hostnames.includes(body.hostname)) {
      return { ok: false, error: `hostname_mismatch: ${body.hostname ?? '(none)'}` }
    }
    return { ok: true, error: null }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `network_error: ${message.slice(0, 120)}` }
  }
}
