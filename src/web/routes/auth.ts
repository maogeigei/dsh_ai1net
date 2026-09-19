/**
 * Auth routes: self-registration (→ pending), login, logout, and the current
 * identity. Registration always yields a `pending` user; an admin approves it.
 * @module dsh_ai1net/web/routes/auth
 */

import type { FastifyPluginAsync } from 'fastify'
import { randomUUID } from 'node:crypto'
import { requireAuth } from '../middleware/authn.js'
import { homeRoot, userRoot } from '../../fs/workspace.js'
import { deriveKey, encrypt } from '../../crypto.js'
import { toPublicUser } from '../../db/types.js'
import { catalogDiagnostics, isCatalogProvider, isCnProvider, listCatalogProviders } from '../model-catalog.js'
import { PROTOCOLS } from '../model-landing.js'
import { backupHomeFile } from '../home-files.js'
import { isLocaleId, reconcileLocalePreference } from '../locale-pref.js'
import {
  captchaActive,
  captchaPartiallyConfigured,
  consumeRegisterCode,
  emailCodeActive,
  guardPolicyFromConfig,
  isValidEmail,
  normalizeEmail,
  requestRegisterCode,
  turnstileSettingsFromConfig,
} from '../email-code.js'
import { verifyTurnstile } from '../turnstile.js'
import { join } from 'node:path'
import {
  clearSessionCookie,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  parseCookie,
  sessionCookie,
  verifyPassword,
} from '../auth.js'

const localeSchema = {
  body: {
    type: 'object',
    required: ['locale'],
    additionalProperties: false,
    properties: { locale: { type: 'string', minLength: 2, maxLength: 8 } },
  },
} as const

const registerSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
      password: { type: 'string', minLength: 8, maxLength: 128 },
      // 邮箱 + 验证码 + 人机验证 token 一律**可选**声明 ——
      // 「必填」由配置决定（`emailCodeActive` / `captchaActive`），schema 只保证形状与长度。
      // 这样同一份代码在"没配邮件的环境"里仍是老行为，不用改 schema 再发一次版。
      email: { type: 'string', maxLength: 254 },
      code: { type: 'string', maxLength: 16 },
      captchaToken: { type: 'string', maxLength: 4096 },
    },
  },
} as const

const emailCodeSchema = {
  body: {
    type: 'object',
    required: ['username', 'email'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 32, pattern: '^[a-zA-Z0-9_-]+$' },
      email: { type: 'string', minLength: 6, maxLength: 254 },
      captchaToken: { type: 'string', maxLength: 4096 },
    },
  },
} as const

interface RegisterBody {
  username: string
  password: string
  email?: string
  code?: string
  captchaToken?: string
}

/**
 * 真实客户端 IP（防爆破的**次要**维度）。
 *
 * 站点经 Cloudflare → 宝塔 nginx → `127.0.0.1:3080`，`trustProxy` 已开 ⇒ `request.ip` 取 XFF 首项
 * （由 CF 覆写，不可由访客伪造）。这里优先用 `CF-Connecting-IP`（CF 的权威口径，且不受链路上
 * 其它代理拼接 XFF 的影响）。
 * ⚠️ **它是次要维度**：源站若可被直连，头仍可伪造 —— 因此真正的承重维度是
 * **邮箱维度**（攻击者无法伪造目标地址）与**全局闸门**（保护邮件服务商配额）。IP 维度只用来
 * 让"同一台机器猛撞"更快被拦住。
 */
function clientIp(request: { headers: Record<string, unknown>; ip: string }): string | null {
  const header = request.headers['cf-connecting-ip']
  const value = Array.isArray(header) ? header[0] : header
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return request.ip === '' ? null : request.ip
}

/** 人机验证：配置齐了才校；未配置时**放行**（老行为），并由调用方必要时告警。 */
async function checkCaptcha(
  app: { config: unknown; log: { warn: (message: string) => void } },
  token: string | undefined,
  ip: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = app.config as Parameters<typeof captchaActive>[0]
  if (!captchaActive(config)) {
    // 「密钥给了但没给期望主机名」⇒ 人机验证**静默不生效**。这是最危险的形态
    // （看起来配了、实际没防住），所以每次走到这里都留一条告警，让它在日志里可见。
    // 去重只做在同一进程内，不影响可观测性（重启后第一条仍会打出来）。
    if (captchaPartiallyConfigured(config)) captchaWarnOnce(app)
    return { ok: true }
  }
  const verdict = await verifyTurnstile(turnstileSettingsFromConfig(config), token ?? '', ip ?? undefined)
  if (verdict.ok) return { ok: true }
  // 上游故障与"token 不对"必须可分：前者是运维问题，后者是访客问题。
  const upstream = verdict.error !== null && verdict.error.startsWith('network_error')
  app.log.warn(`[register] Turnstile 校验失败 ip=${ip ?? '-'} err=${verdict.error ?? ''}`)
  return { ok: false, error: upstream ? 'captcha_unavailable' : 'captcha_failed' }
}

let captchaPartialWarned = false
/** 只在进程内第一条上告警，避免被机器人刷日志。 */
function captchaWarnOnce(app: { log: { warn: (message: string) => void } }): void {
  if (captchaPartialWarned) return
  captchaPartialWarned = true
  app.log.warn(
    '[register] Turnstile 已配 siteKey/secret，但期望主机名列表为空 ⇒ 人机验证**未启用**'
    + '（请设 DSH_AI1NET_TURNSTILE_HOSTNAMES=<域名[,www.域名]>）',
  )
}

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    additionalProperties: false,
    properties: {
      username: { type: 'string', maxLength: 64 },
      password: { type: 'string', maxLength: 128 },
    },
  },
} as const

interface Credentials {
  username: string
  password: string
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * 注册页需要知道的**公开**配置。
   *
   * 为什么要一个端点而不是把 sitekey 写进 HTML：
   *   · sitekey 随环境变（本地/测试/线上各一个 Turnstile widget），写死会让"换环境忘记换 key"
   *     变成一次静默失效 —— 人机验证看起来在，其实一直在报 `invalid-input-secret`；
   *   · 前端据此**决定要不要渲染**控件，而不是渲染一个永远失败的控件。
   * ⚠️ 只回**公钥**。服务端密钥永不出现在任何响应里。
   */
  app.get('/api/auth/register/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    const captchaOn = captchaActive(app.config)
    return {
      captcha: {
        enabled: captchaOn,
        // 未启用时给空串 ⇒ 前端不会去加载 CF 脚本（少一个第三方请求）。
        siteKey: captchaOn ? app.config.turnstileSiteKey : '',
        // ⚠️ `action` 必须由**服务端**下发且与 siteverify 校验的一致：两边各写一份常量，
        // 一旦漂掉就是"过不了验证且看不出原因"（CF 只回 action 不匹配，不说是谁配错）。
        action: app.config.turnstileAction,
      },
      emailCode: {
        enabled: emailCodeActive(app.config),
        ttlSeconds: Math.round(app.config.emailCodeTtlMs / 1000),
        maxAttempts: app.config.emailCodeMaxAttempts,
      },
      // 前端做即时校验用（避免"提交了才说格式错"），与后端同一份口径。
      usernamePattern: '^[a-zA-Z0-9_-]{3,32}$',
      minPasswordLength: 8,
    }
  })

  /**
   * 请求邮箱验证码。
   *
   * 顺序不可交换：**人机验证 → 配额/冷却 → 发信 → 落事件**。
   * 反过来的话，机器人只需猛点就能把真用户的配额吃光（用自己的拒绝服务挡住别人）。
   */
  app.post(
    '/api/auth/register/email-code',
    { schema: emailCodeSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body as { username: string; email: string; captchaToken?: string }
      const ip = clientIp(request as unknown as { headers: Record<string, unknown>; ip: string })

      if (!emailCodeActive(app.config)) return reply.code(503).send({ error: 'email_code_disabled' })

      const captcha = await checkCaptcha(app, body.captchaToken, ip)
      if (!captcha.ok) return reply.code(403).send({ error: captcha.error })

      const outcome = await requestRegisterCode(
        { db: app.db, config: app.config, onWarn: (message) => app.log.warn(message) },
        { email: body.email, username: body.username, ip },
      )
      if (!outcome.ok) {
        await app.db.audit(null, 'register_code_rejected', JSON.stringify({ reason: outcome.error, ip }))
        if (outcome.retryAfterSeconds > 0) reply.header('retry-after', String(outcome.retryAfterSeconds))
        return reply.code(outcome.status).send({
          error: outcome.error,
          retryAfterSeconds: outcome.retryAfterSeconds,
        })
      }
      await app.db.audit(null, 'register_code_sent', JSON.stringify({ ip }))
      return reply.header('retry-after', String(outcome.retryAfterSeconds)).send({
        ok: true,
        retryAfterSeconds: outcome.retryAfterSeconds,
        expiresInSeconds: outcome.expiresInSeconds,
      })
    },
  )

  app.post(
    '/api/auth/register',
    { schema: registerSchema, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as RegisterBody
      const body = request.body as RegisterBody
      const ip = clientIp(request as unknown as { headers: Record<string, unknown>; ip: string })
      const email = normalizeEmail(body.email ?? '')

      // ① 先做**无副作用**的占用检查：命中就不必浪费一次人机验证与一个验证码。
      if ((await app.db.findUserByUsername(username)) !== undefined) {
        return reply.code(409).send({ error: 'username_taken' })
      }
      if (email !== '' && (await app.db.findUserByEmail(email)) !== undefined) {
        return reply.code(409).send({ error: 'email_taken' })
      }

      // ② 人机验证（配置齐了才校）。
      const captcha = await checkCaptcha(app, body.captchaToken, ip)
      if (!captcha.ok) return reply.code(403).send({ error: captcha.error })

      // ③ 邮箱验证码（配置齐了才强制）。**校验通过即消费**，同一码不能建两个账号。
      if (emailCodeActive(app.config)) {
        if (email === '' || !isValidEmail(email)) return reply.code(400).send({ error: 'email_required' })
        const verdict = await consumeRegisterCode(
          { db: app.db, config: app.config },
          { email, username, code: (body.code ?? '').trim(), ip },
        )
        if (!verdict.ok) {
          await app.db.audit(null, 'register_code_invalid', JSON.stringify({ reason: verdict.error, ip }))
          return reply.code(verdict.status).send({ error: verdict.error, attemptsLeft: verdict.attemptsLeft })
        }
      }

      const id = randomUUID()
      const homeDir = homeRoot(userRoot(app.config.dataRoot, id))
      const passHash = await hashPassword(password)
      // Create the user first so `initUserRoot` resolves the DB-assigned uid
      // (baseUid + row_id) instead of the hash fallback — the user's DSH process must
      // run as that *same* uid or the DSH cannot write its dirs.
      const user = await app.db.createUser({
        id,
        username,
        passHash,
        role: 'pending',
        homeDir,
        email: email === '' ? null : email,
      })
      await app.userFs.initUserRoot(id, user.uid ?? undefined)
      await app.db.audit(id, 'register', JSON.stringify({ username, email: email === '' ? null : email }))
      return reply.code(201).send({ user: { id, username, role: 'pending' } })
    },
  )

  app.post(
    '/api/auth/login',
    { schema: loginSchema, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { username, password } = request.body as Credentials
      const user = await app.db.findUserByUsername(username)
      if (user === undefined || !(await verifyPassword(password, user.pass_hash))) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }
      if (user.role === 'pending') return reply.code(403).send({ error: 'pending_review' })
      if (user.role === 'disabled') return reply.code(403).send({ error: 'disabled' })

      const token = newSessionToken()
      // 单活跃会话（last-wins）：新登录顶掉该账号此前所有会话——旧浏览器的
      // sid 立即失效，proxy/API 对其返回 401，需重新登录后才能继续访问。
      await app.db.deleteUserSessions(user.id)
      await app.db.createSession({
        tokenHash: hashSessionToken(token),
        userId: user.id,
        expiresAt: Date.now() + app.config.sessionTtlSeconds * 1000,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      await app.db.audit(user.id, 'login', null)
      reply.header(
        'set-cookie',
        sessionCookie(token, app.config.sessionTtlSeconds, app.config.secureCookies, app.config.cookieDomain),
      )
      return { user: toPublicUser(user) }
    },
  )

  app.post('/api/auth/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined) await app.db.deleteSession(hashSessionToken(token))
    reply.header('set-cookie', clearSessionCookie(app.config.secureCookies, app.config.cookieDomain))
    return { ok: true }
  })

  // ---- 同源退出页：会话内「退出登录」整页跳转（清 sid + 删 session → 回登录页） ----
  app.get('/logout', async (request, reply) => {
    const token = parseCookie(request.headers.cookie, 'sid')
    if (token !== undefined) await app.db.deleteSession(hashSessionToken(token))
    reply.header('set-cookie', clearSessionCookie(app.config.secureCookies, app.config.cookieDomain))
    return reply.redirect('/')
  })

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }))

  const keyAddSchema = {
    body: {
      type: 'object',
      required: ['name', 'apiKey'],
      additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 32 },
        apiKey: { type: 'string', minLength: 1, maxLength: 256 },
        // 补做：**目录厂家 id**（选了它只需 apiKey；endpoint/协议/模型由官方目录兜底）。
        provider: { type: 'string', minLength: 1, maxLength: 40 },
        // 自定义厂家三件套 —— **都不给**就是老语义的「内置 DeepSeek 那一把 key」。
        route: { type: 'string', minLength: 1, maxLength: 40 },
        baseUrl: { type: 'string', maxLength: 300 },
        api: { type: 'string', minLength: 1, maxLength: 40 },
        models: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 128 } },
      },
    },
  } as const

  const toggleSchema = {
    body: {
      type: 'object',
      required: ['enabled'],
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
    },
  } as const

  // ---- 模型厂家与密钥（2026-09-13 第三轮口径）--------------------------
  //   用户口径（**已定，不得再拿去当选择题**）：
  //     ① 条目**各自开关、可同时启用**（不再互斥）；
  //     ② admin 配的**平台共享模型也列入**列表，用户可开关（`users.shared_model_enabled`）；
  //     ③ 具体用哪个模型**在 dsh 对话框的模型选择器里选** —— 平台只负责把「已启用」的都配好。
  //   ⇒ 因此**不再有**"当前生效的那一把"这种概念：`keySourceOf` 只回答"有没有自己的内置
  //      DeepSeek key"，供界面文案用；真正生效的是 spawn 时的落地结果（`server.ts`）。
  //   ⚠️ 落地发生在 **spawn** 时 ⇒ 改完必须**重启实例**才生效，这也是这几条路由最后都要
  //      `refreshAfterKeyChange` 的原因。

  /** 展示名 → route 的默认值：英文/数字折成小写短横线；纯中文名折不出东西 ⇒ `provider`。 */
  function slugify(name: string): string {
    const s = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
    return s === '' || !/^[a-z0-9]/.test(s) ? 'provider' : s
  }

  /** 该用户当前**实际生效**的密钥来源。 */
  async function keySourceOf(userId: string): Promise<'own' | 'shared' | 'none'> {
    if ((await app.db.getEnabledCredentialKeyRef(userId)) !== null) return 'own'
    // 关掉了共享开关的人**就是** none —— 这正是验收③要的语义。
    if (!(await app.db.getSharedModelEnabled(userId))) return 'none'
    // **管理员没授权 ⇒ 就是 none**（门禁先于内容；用户自己的条目不受影响，
    // 因为上面那一步已经判过了）。
    if (!(await app.db.getSharedModelGranted(userId))) return 'none'
    const admins = (await app.db.listPublicUsers()).filter((u) => u.role === 'admin')
    if (admins.length === 0) return 'none'
    return (await app.db.getEnabledCredentialKeyRef(admins[0].id)) !== null ? 'shared' : 'none'
  }

  /**
   * 平台共享模型的**非敏感**信息（名字 / 归属 / 条数；绝不返回密钥本身）。
   *
   * `granted`= **管理员有没有给这个人开**；前端据它决定**要不要渲染**整个
   * 「平台共享模型」区块 —— 未授权时连块都不出现（用户口径：开了才"在使用 ＋ 在设置页展示"）。
   * ⚠️ 未授权时**仍然返回** `owner` / `count` 等字段（不额外做信息收窄），因为这条接口
   * 只有**本人或 admin** 能看，且这些是"平台有哪些共享模型"这种非敏感目录信息。
   */
  async function sharedKeyInfo(userId: string): Promise<{
    available: boolean
    name: string | null
    owner: string | null
    ownerIsMe: boolean
    enabled: boolean
    granted: boolean
    count: number
  }> {
    const admins = (await app.db.listPublicUsers()).filter((u) => u.role === 'admin')
    const enabled = await app.db.getSharedModelEnabled(userId)
    const granted = await app.db.getSharedModelGranted(userId)
    if (admins.length === 0) {
      return { available: false, name: null, owner: null, ownerIsMe: false, enabled, granted, count: 0 }
    }
    // 共享**不再假设只有一把** —— admin 也能配多条（与用户侧同一套口径）。
    const keys = await app.db.listEnabledCredentialKeys(admins[0].id)
    // `ownerIsMe`：admin 看的是**自己**配的那些 ⇒ 前端文案要区分「我配的」与「别人配的」。
    return {
      available: keys.length > 0,
      name: keys[0]?.name ?? null,
      owner: admins[0].username,
      ownerIsMe: admins[0].id === userId,
      enabled,
      granted,
      count: keys.length,
    }
  }
  /** 改动后的刷新：admin 动的是共享内容 ⇒ 广播重启；其他人只重启自己。 */
  async function refreshAfterKeyChange(userId: string, role: string): Promise<void> {
    if (role === 'admin') await app.supervisor.restartAllMains()
    else await app.supervisor.restartMain(userId)
  }

  app.get('/api/me/keys', { preHandler: requireAuth }, async (request) => ({
    keys: await app.db.listCredentialKeys(request.user!.id),
    effective: await keySourceOf(request.user!.id),
    // `shared.granted`= admin 是否已授权；`shared.enabled` = 用户自己的偏好。
    shared: await sharedKeyInfo(request.user!.id),
    // 档 87：把「共享开关」与「协议枚举」一并给出，免得前端各写一份常量然后漂掉。
    sharedModelEnabled: await app.db.getSharedModelEnabled(request.user!.id),
    // 档 138：管理员授权（前端只在 true 时渲染「平台共享模型」区块）。
    sharedModelGranted: await app.db.getSharedModelGranted(request.user!.id),
    protocols: [...PROTOCOLS],
  }))

  /**
   * 官方 **pi-ai 厂家目录**（补做）——「新增模型条目」的选择框数据源。
   *
   * 为什么由后端给：目录是**安装期冻结**在官方包里的（`@earendil-works/pi-ai/dist/providers/data/`），
   * 前端拿不到也不该硬编码；后端读一次缓存 10 分钟。选中的厂家**只要填 API Key** ——
   * endpoint / 协议 / 模型目录全由目录提供（见 `model-catalog.ts` 头注释）。
   * ⚠️ 目录里的 `deepseek` 被**排除**：平台已有「内置 DeepSeek」入口（走 `dsh-llm-deepseek` +
   * 平台共享 key），再列一个同名选项只会让用户分不清哪个生效。
   */
  app.get('/api/me/model-providers', { preHandler: requireAuth }, async () => {
    const all = await listCatalogProviders()
    return {
      providers: all
        .filter((p) => p.id !== 'deepseek')
        .map((p) => ({
          id: p.id,
          label: p.label,
          api: p.api,
          baseURL: p.baseURL,
          cn: isCnProvider(p.id),
          modelCount: p.models.length,
          // 只回前 60 个模型名给界面展示（足量的"看到它自带什么"），不整份下发。
          models: p.models.slice(0, 60).map((m) => m.name ?? m.id),
        })),
      // 目录**可读性**：读不到时前端要如实说明"为什么只剩两项"，而不是静默给个空列表
      // （2026-09-14：这个静默曾让一个 P1 布局缺陷长期不可见）。
      catalog: catalogDiagnostics(),
    }
  })

  app.post('/api/me/keys', { preHandler: requireAuth, schema: keyAddSchema }, async (request, reply) => {
    const body = request.body as {
      name: string
      apiKey: string
      provider?: string
      route?: string
      baseUrl?: string
      api?: string
      models?: string[]
    }
    const cleanName = body.name.trim()
    // 展示名**允许中文**（寻址用的是 route），但仍拒掉控制字符，免得污染日志与界面。
    // eslint-disable-next-line no-control-regex
    if (cleanName === '' || /[\u0000-\u001f\u007f]/.test(cleanName)) {
      return reply.code(400).send({ error: 'invalid_name' })
    }
    // Header-safe charset only: reject spaces, quotes, non-ASCII, etc.
    if (!/^[A-Za-z0-9\-_.]{1,256}$/.test(body.apiKey)) {
      return reply.code(400).send({ error: 'invalid_api_key' })
    }
    const existingKeys = await app.db.listCredentialKeys(request.user!.id)
    /** route 是 settings.yaml 里的 dict 键 ⇒ 同一用户下撞键 = 后写的覆盖前者、静默失效。 */
    const routeTaken = (r: string): boolean => existingKeys.some((k) => k.route === r && k.name !== cleanName)

    // ── 情形 A：**目录厂家**（用户只填了 API Key）────────────────────────────────
    const providerId = (body.provider ?? '').trim()
    if (providerId !== '') {
      if (!(await isCatalogProvider(providerId))) return reply.code(400).send({ error: 'unknown_provider' })
      if (routeTaken(providerId)) return reply.code(409).send({ error: 'route_taken' })
      const key = await app.db.setCredentialKey(
        request.user!.id,
        cleanName,
        encrypt(body.apiKey, deriveKey(app.config.encryptionSecret)),
        // 只记 route：endpoint / 协议 / 模型清单**都不写**，交给官方目录兜底。
        { route: providerId, baseUrl: null, api: null, models: null },
      )
      await app.db.audit(request.user!.id, 'set_api_key', JSON.stringify({ name: cleanName, provider: providerId }))
      await refreshAfterKeyChange(request.user!.id, request.user!.role)
      return { key }
    }

    // ── 情形 B：内置 DeepSeek（不带 baseUrl）／自定义网关（带 baseUrl）────────────
    const baseUrl = (body.baseUrl ?? '').trim()
    const isCustom = baseUrl !== ''
    let route: string | null = null
    let api: string | null = null
    let models: string | null = null
    if (isCustom) {
      if (!/^https?:\/\/\S{1,280}$/.test(baseUrl)) return reply.code(400).send({ error: 'invalid_base_url' })
      route = (body.route ?? '').trim().toLowerCase() || slugify(cleanName)
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(route)) return reply.code(400).send({ error: 'invalid_route' })
      if (body.api !== undefined && !(PROTOCOLS as readonly string[]).includes(body.api)) {
        return reply.code(400).send({ error: 'invalid_api' })
      }
      api = body.api ?? null
      const ids = (body.models ?? []).map((m) => m.trim()).filter((m) => m !== '')
      if (ids.length === 0) return reply.code(400).send({ error: 'models_required' })
      models = JSON.stringify(ids.slice(0, 50))
      if (routeTaken(route)) return reply.code(409).send({ error: 'route_taken' })
    }
    const key = await app.db.setCredentialKey(
      request.user!.id,
      cleanName,
      encrypt(body.apiKey, deriveKey(app.config.encryptionSecret)),
      { route, baseUrl: isCustom ? baseUrl : null, api, models },
    )
    await app.db.audit(request.user!.id, 'set_api_key', JSON.stringify({ name: cleanName, route, custom: isCustom }))
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { key }
  })

  /** 开/关**单个**条目（口径①：不互斥、可同时启用）。 */
  app.post('/api/me/keys/:id/toggle', { preHandler: requireAuth, schema: toggleSchema }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { enabled } = request.body as { enabled: boolean }
    if (!(await app.db.toggleCredentialKey(request.user!.id, id, enabled))) {
      return reply.code(404).send({ error: 'not_found' })
    }
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  /**
   * 平台共享模型的开关（口径② ＋ ）—— 只动**自己**的偏好，不碰 admin 的配置。
   *
   * ⚠️ 语义边界（别混）：本路由写的是 `shared_model_enabled` = **用户偏好**（"我要不要用"）；
   * **能否用**由 admin 在用户列表里写的 `shared_model_granted` 先定（默认关闭）。
   * 两者是**与**关系 ⇒ 用户把开关打开、但 admin 没授权时，仍然什么也不会落地。
   * 所以这里**不校验授权**：让用户能先关掉自己不想用的、也允许他先打开（授权一到即生效），
   * 且**不泄露**"管理员是否授权了别人"这类信息。
   */
  app.post('/api/me/models/shared', { preHandler: requireAuth, schema: toggleSchema }, async (request, reply) => {
    const { enabled } = request.body as { enabled: boolean }
    if (!(await app.db.setSharedModelEnabled(request.user!.id, enabled))) {
      return reply.code(404).send({ error: 'not_found' })
    }
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  /**
   * @deprecated 起语义已变成"启用这一个、**不关**别的"（与 `toggle(true)` 同义）。
   * 保留路由只为老客户端不 404；新前端不该再用它。
   */
  /**
   * 语言偏好持久化（2026-09-15）—— 把用户在实例「用户设置」里选的语言**记住**。
   *
   * 为什么需要：官方 `dsh-client-locale` 只对 **loopback** 页面持久化到 `settings.yaml`；平台是
   * 「浏览器经域名访问远程实例」⇒ 非 loopback ⇒ 官方只为当前进程保留选择，刷新即回默认。
   * 本路由**替官方把它自己的设置写进它自己的文件**（顶层 `locale: → preference:`），
   * ⇒ 官方语义不破（实例启动时读自己的设置即生效）+ 用户选择跨页面 / 跨重启保留。
   * ⚠️ 写文件沿用 `model-landing` 那套（备份到平台目录 + chown 给 home 属主），见 `home-files.ts`。
   * 🔴 但**读写必须走 `app.userFs`**（§五）：用户卷跟着实例走 —— 实例在 worker 上时
   * `home/` 就在那台机，直接 `join(home_dir, …)` + 本机 fs 只会读到自己盘上一个不存在的路径
   * （**空串、不报错**）⇒ 这条路由对"实例不在控制面本机"的用户**静默失效**（语言选择永远存不上）。
   */
  app.post('/api/me/locale', { preHandler: requireAuth, schema: localeSchema }, async (request, reply) => {
    const { locale } = request.body as { locale: string }
    if (!isLocaleId(locale)) return reply.code(400).send({ error: 'invalid_locale' })
    const userId = request.user!.id
    const text = (await app.userFs.readHomeFile(userId, 'settings.yaml')) ?? ''
    const next = reconcileLocalePreference(text, locale)
    if (next.changed) {
      // 备份放**平台侧**（控制面的备份目录），写入走 `userFs`（可能落到远端那台机）——
      // 与 `server.ts#landModels` 同一套口径，⛔ 别在这里自己拼绝对路径。
      await backupHomeFile(homeRoot(userRoot(app.config.dataRoot, userId)), 'settings.yaml', text)
      await app.userFs.writeHomeFile(userId, 'settings.yaml', next.text)
    }
    return { ok: true, locale, changed: next.changed }
  })

  app.post('/api/me/keys/:id/select', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!(await app.db.selectCredentialKey(request.user!.id, id))) return reply.code(404).send({ error: 'not_found' })
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })

  app.delete('/api/me/keys/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!(await app.db.deleteCredentialKey(request.user!.id, id))) return reply.code(404).send({ error: 'not_found' })
    // 删掉的是自己配的 ⇒ 落地时自然回落到「平台共享模型」（前提是共享开关开着）。
    await refreshAfterKeyChange(request.user!.id, request.user!.role)
    return { ok: true }
  })
}
