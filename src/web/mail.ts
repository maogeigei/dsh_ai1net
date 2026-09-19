/**
 * 注册验证码的外发邮件层。
 *
 * 为什么做成"驱动 + 通用 HTTP 兜底"而不是直接写死某家 SDK：
 * ① 平台目前**没有**任何邮件基础设施（全库 grep `smtp|nodemailer|mail` = 0 命中），
 *    而注册是**唯一**必须先发信才能完成的功能 ⇒ 它是外部依赖最重的一环，必须能换；
 * ② 换供应商时**只改 env、不动代码**（`http` 驱动连 body 结构都能由配置给出），
 *    这对"以后可能要接别的邮件服务"是硬需求 —— 不必为了换家再走一次发布；
 * ③ 不引第三方依赖：`fetch` + JSON 就够，少一个供应链面。
 *
 * 驱动：
 *   · `brevo`  —— Brevo（原 Sendinblue）事务邮件 API：`POST /v3/smtp/email`，头 `api-key`。
 *                 本机已有可用凭据（见档案），因此作为默认驱动。
 *   · `http`   —— **任意** JSON HTTP 接口：URL / 鉴权头 / body 模板全部由 env 给，
 *                 body 里可用 `{{to}} {{code}} {{subject}} {{text}} {{from}} {{fromName}}` 占位。
 *   · `log`    —— 不真发信，只把验证码交给调用方（由路由写 journald）。**仅供开发/断网排障**，
 *                 显式选它才会生效（不选=不发日志，避免验证码进日志）。
 *
 * 纪律：**失败即失败**（返回 `{ok:false}`），不重试 —— 重试会造成"用户点一次收两封"，
 * 且与 `email_codes` 的事件计数（= 防爆破的判据）对不上。
 * @module dsh_ai1net/web/mail
 */

/** 邮件通道的运行时配置（由 `config.ts` 从 env 组装后传入，本模块不读 env）。 */
export interface MailSettings {
  driver: MailDriver
  /** 服务端点（`brevo` 驱动留空则用官方默认）。 */
  apiUrl: string
  apiKey: string
  /** `http` 驱动的鉴权头名（留空 + 有 apiKey ⇒ 用 `Authorization: Bearer`）。 */
  authHeader: string
  /** 发件地址（**必须**是该服务里已验证过的发件人，否则上游直接拒收）。 */
  from: string
  fromName: string
  /** `http` 驱动的 JSON body 模板（支持占位符）。 */
  bodyTemplate: string
  timeoutMs: number
}

export type MailDriver = 'brevo' | 'http' | 'log'

export interface VerificationMail {
  to: string
  code: string
  ttlMinutes: number
  /** 展示给收件人的站点名（如 `EXAMPLE`）。**为空则整句退化成"你的验证码"**，绝不回落到平台内部名。 */
  brand?: string
}

export interface MailResult {
  ok: boolean
  /** 失败原因（**不含**验证码本身），供审计与界面提示。 */
  error: string | null
  /** 上游返回的状态码（有则记），便于区分"配错了"与"上游抽风"。 */
  status?: number
}

/** 该驱动是否具备发信条件（缺关键项 ⇒ 视为未配置，路由据此回退/报错）。 */
export function mailConfigured(settings: MailSettings): boolean {
  if (settings.driver === 'log') return true
  if (settings.from === '') return false
  if (settings.driver === 'brevo') return settings.apiKey !== '' || settings.apiUrl !== ''
  return settings.apiUrl !== ''
}

/**
 * 渲染主题与正文（中英双语：平台默认语言是英语，运营方是中文，两者都照顾到）。
 * ⚠️ `brand` 为空时**不能**回落到任何内部名（邮件是给终端用户的，平台内部名不该出现在里面）——
 * 此时整句退化为"你的验证码是"。
 */
export function renderVerificationMail(mail: VerificationMail): { subject: string; text: string } {
  const brand = (mail.brand ?? '').trim()
  const name = brand === '' ? '' : ` ${brand}`
  const subject = brand === '' ? `${mail.code} is your verification code` : `${mail.code} is your ${brand} verification code`
  const text = [
    `Your${name} verification code is: ${mail.code}`,
    `It expires in ${mail.ttlMinutes} minutes. If you did not request this, just ignore this e-mail.`,
    '',
    `你的${name}验证码是：${mail.code}`,
    `有效期 ${mail.ttlMinutes} 分钟。若非本人操作，请忽略本邮件。`,
    ...(brand === '' ? [] : ['', `— ${brand}`]),
  ].join('\n')
  return { subject, text }
}

/** 占位符替换：值按 JSON 字符串转义后**只保留内容**，以便安全地嵌进 body 模板的引号内。 */
function applyTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (match, key: string) => {
    const value = values[key]
    if (value === undefined) return match
    // slice(1,-1) 去掉 JSON.stringify 加的两端引号：调用方的模板里自己带引号。
    return JSON.stringify(value).slice(1, -1)
  })
}

/** 发一封验证码邮件。永不抛异常 —— 失败以 `{ok:false}` 返回，由调用方决定如何记事件。 */
export async function sendVerificationCodeMail(
  settings: MailSettings,
  mail: VerificationMail,
): Promise<MailResult> {
  const { subject, text } = renderVerificationMail(mail)

  if (settings.driver === 'log') return { ok: true, error: null }

  if (!mailConfigured(settings)) {
    return { ok: false, error: 'mail_not_configured' }
  }

  try {
    if (settings.driver === 'brevo') {
      return await sendViaBrevo(settings, { ...mail, subject, text })
    }
    return await sendViaHttp(settings, { ...mail, subject, text })
  } catch (e) {
    // AbortSignal.timeout 抛的是 TimeoutError；其它是网络/解析错误。
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: message.slice(0, 200) }
  }
}

async function sendViaBrevo(
  settings: MailSettings,
  mail: VerificationMail & { subject: string; text: string },
): Promise<MailResult> {
  const url = settings.apiUrl === '' ? 'https://api.brevo.com/v3/smtp/email' : settings.apiUrl
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' }
  if (settings.apiKey !== '') headers['api-key'] = settings.apiKey
  const body = {
    sender: { email: settings.from, name: settings.fromName === '' ? undefined : settings.fromName },
    to: [{ email: mail.to }],
    subject: mail.subject,
    textContent: mail.text,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(settings.timeoutMs),
  })
  if (!res.ok) {
    // 上游会回一段 JSON（{code,message}）—— 它不含验证码，可以安全地截断留证。
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    return { ok: false, error: `brevo_http_${res.status}${detail === '' ? '' : `: ${detail}`}`, status: res.status }
  }
  return { ok: true, error: null, status: res.status }
}

async function sendViaHttp(
  settings: MailSettings,
  mail: VerificationMail & { subject: string; text: string },
): Promise<MailResult> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.apiKey !== '') {
    if (settings.authHeader !== '') headers[settings.authHeader] = settings.apiKey
    else headers.authorization = `Bearer ${settings.apiKey}`
  }
  const values: Record<string, string> = {
    to: mail.to,
    code: mail.code,
    subject: mail.subject,
    text: mail.text,
    from: settings.from,
    fromName: settings.fromName,
  }
  const body =
    settings.bodyTemplate === ''
      ? JSON.stringify({ from: settings.from, to: mail.to, subject: mail.subject, text: mail.text })
      : applyTemplate(settings.bodyTemplate, values)

  const res = await fetch(settings.apiUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(settings.timeoutMs),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200)
    return { ok: false, error: `mail_http_${res.status}${detail === '' ? '' : `: ${detail}`}`, status: res.status }
  }
  return { ok: true, error: null, status: res.status }
}
