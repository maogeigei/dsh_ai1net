/**
 * Reverse proxy from the orchestrator to a running per-user DSH.
 *
 * Two entry points:
 * - subpath `/u/:slug/dsh/*` (authenticated, legacy), and
 * - per-user subdomain `<username>.<baseDomain>` (HTTP + WebSocket). The DSH's
 *   absolute-path SPA requires the subdomain form: its `/assets/*` and `/api/*`
 *   resolve against the host root, which only works when each DSH owns a host.
 * @module dsh_ai1net/supervisor/proxy
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { hashSessionToken, parseCookie } from '../web/auth.js'
import { requireAuth } from '../web/middleware/authn.js'
import type { Endpoint } from './spawner.js'

// Keep-alive pool for per-user DSH upstreams. Replaced (not just destroyed) on a
// connection error, because a restarted instance may come back on a different
// port and any pooled socket to the old endpoint would keep failing.
let upstreamAgent = new Agent({ keepAlive: true, maxSockets: 32 })

// Headers the DSH's browser-trust fence must NOT see from the browser, so the
// proxied request looks like a clean loopback client (its Host is overridden to
// loopback; a mismatched Origin would otherwise 403).
const STRIP_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
])


/**
 * 注入到**实例 HTML**里的「会话过期自愈」脚本。
 *
 * 为什么需要它：实例被空闲回收后**重建**（新端口 + 新 launch token），而**已打开的页面**
 * 仍带着旧 `dsh-auth-*` cookie → 之后任何 `/api/*` XHR 都会被新实例判 **401**，
 * dsh 前端只显示 `transport failure … HTTP 401`，用户只能手动刷新。
 * 导航路径的 401 已在上面处理（302 到当前实例新 token），但 **XHR 无法靠 302 自愈**，
 * 所以给页面这段脚本：发现 `/api/*` 返回 401 就显示覆盖层并 reload ——
 * reload 会走"导航 401 → 302 新 token"这条**已经工作**的链路，从而自动恢复。
 * 仅改写响应内容，不落盘、不改官方文件（R2）；README/技能已留档。
 */
// 注入到实例子域页面的自愈脚本（+ 增强）。
// ① 401 自愈：实例被回收重建后 launch token 轮换，页面内 /api/* 会拿到 401 → 亮覆盖层并整页 reload。
// ② 慢请求提示：服务端在实例未就绪时 hold 住请求最长 20 秒等拉起，
//    期间浏览器端原本毫无反馈（点了重连也看不出在等什么）→ 挂起 ≥3 秒即显示「实例正在启动」。
// ③ 回到页面自检 + 就地恢复：判据从「进程在不在跑」改为「页面还能不能连上实例」，
//    并把恢复过程做成**看得见**的（顶部轻提示 → 覆盖层），恢复后原地跳回而不是离开到门户域。
// 保持多行形式便于维护；注入时整段塞进 <script>，故内容不得含反引号 / ${。
// R1-①：从**独立文件**加载（原先是 TS 模板字面量 —— 里面的 \n 会在模板求值时先被转义，
// 曾把整段脚本写崩成 SyntaxError，而校验跳过了"求值"这一步，形同虚设）。
// 独立文件是纯 JS：可 node --check 直接校验，不再有转义陷阱。
/** R1-①：注入脚本从 `assets/inject/` 读取（纯 JS，可 node --check；无模板转义陷阱）。
 *  找不到文件 = **启动即失败**（fail-fast）：宁可平台起不来，也不要把"没有注入"的页面静默发给用户。 */
function loadInject(file: string): string {
  // ⚠️ 本项目是 ESM（package.json "type": "module"）—— **没有 __dirname**；
  // 用 import.meta.url 定位（2026-09-13 实测：写成 __dirname 会让整个平台起不来）
  const p = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'inject', file)
  try {
    return readFileSync(p, 'utf8')
  } catch (err) {
    throw new Error(`[inject] 读取注入脚本失败: ${p}（R1：assets/inject 必须随包部署）: ${String(err)}`)
  }
}
const SESSION_RECOVERY_JS = loadInject('recovery.js')

/**
 * 注入到实例页面的「实例助手」——右下角两个入口：
 *   ① 我的文件：浏览自己的工作区并**下载**任意文件（走平台 `/api/desktop/tree` + `/api/fs/download`，
 *      不暴露宿主绝对路径；此前用户拿到的只是 `/var/lib/...` 路径，浏览器打不开）；
 *   ② 能力：展示平台生成的实例能力清单（与 `bundled-skills/platform-capabilities` 同源）。
 * 另外：读取 `/api/dsh/session-permission`，若**老会话仍处于 workspace-write**（沙箱后端不可用 →
 * bash 会被 fail-closed 拒绝）则顶部给一条可操作的提示（含切换办法）。
 * 纯前端注入，不改官方包、不落盘（R2）；失败静默，绝不影响实例本身。
 */
// R1-①：从**独立文件**加载（原先是 TS 模板字面量 —— 里面的 \n 会在模板求值时先被转义，
// 曾把整段脚本写崩成 SyntaxError，而校验跳过了"求值"这一步，形同虚设）。
// 独立文件是纯 JS：可 node --check 直接校验，不再有转义陷阱。
const SESSION_ASSIST_JS = loadInject('assist.js')

/** 非 HTML / 已压缩 / 无正文的状态直接透传，避免破坏二进制或已编码内容。 */
function injectRecovery(html: string): string {
  const tag =
    '<script>' + SESSION_RECOVERY_JS + '</script>' + '<script>' + SESSION_ASSIST_JS + '</script>'
  return html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
}

function buildUpstreamHeaders(headers: IncomingHttpHeaders, port: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || STRIP_HEADERS.has(key.toLowerCase())) continue
    out[key] = value as string | string[]
  }
  // Keep Host loopback: DSH's /api trust fence requires the Host to be loopback
  // or a `--trusted-host` authority — a real domain would 403 every /api call.
  // DSH's absolute URLs are rewritten to the real origin in proxyHttp below.
  out.host = `127.0.0.1:${port}`
  return out
}

/** 从 freshAuthUrl 的 `?token=` 中取出当前实例的 launch token。 */
function tokenFromAuthUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  const m = /[?&]token=([^&]+)/.exec(url)
  return m === null || m[1] === undefined ? undefined : decodeURIComponent(m[1])
}

/**
 * 向**当前**实例要一份有效的浏览器凭证 cookie。
 *
 * 实例每次 (重)启动都会换 launch token **和** `dsh-auth-<随机后缀>` 的 cookie 名。
 * 已打开的页面还带着旧名字的 cookie → 新实例一律判 401。这里 GET `/?token=<当前>`
 * （实例回 303 + Set-Cookie），把 set-cookie 原样取出，供代理重放请求与回写浏览器。
 */
function fetchInstanceAuthCookies(endpoint: Endpoint, token: string): Promise<string[]> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: string[]): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const req = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: '/?token=' + encodeURIComponent(token),
        method: 'GET',
        headers: { host: `127.0.0.1:${endpoint.port}`, 'user-agent': 'dsh-proxy-auth-refresh' },
      },
      (res) => {
        const sc = res.headers['set-cookie']
        res.resume()
        finish(Array.isArray(sc) ? sc : sc === undefined ? [] : [sc])
      },
    )
    req.on('error', () => finish([]))
    req.setTimeout(5000, () => {
      req.destroy()
      finish([])
    })
    req.end()
  })
}

/**
 * 把浏览器带来的 cookie 与实例的新 cookie 合并 —— 丢掉旧的 `dsh-auth-*`
 * （新实例只认自己那份；旧名留着也没用），其余（`sid` 等代理不关心）原样保留。
 */
function mergeCookieHeader(original: string | undefined, fresh: string[]): string {
  const keep = (original ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x !== '' && !/^dsh-auth-/.test(x))
  const add = fresh
    .map((c) => (c.split(';')[0] ?? '').trim())
    .filter((x) => x !== '')
  return [...keep, ...add].join('; ')
}

/** Extract `<slug>` from `<slug>.<baseDomain>`, or null when not a match. */
export function parseSubdomain(host: string | undefined, baseDomain: string): string | null {
  if (host === undefined || baseDomain === '') return null
  const name = host.split(':')[0] ?? ''
  if (name === baseDomain) return null
  if (name.endsWith('.' + baseDomain)) {
    const slug = name.slice(0, -(baseDomain.length + 1))
    return slug !== '' ? slug.toLowerCase() : null
  }
  return null
}

/** The per-user subdomain for a username, or null when `baseDomain` is unset. */
export function subdomainForUser(baseDomain: string, username: string): string | null {
  return baseDomain === '' ? null : `${username.toLowerCase()}.${baseDomain}`
}

/** The browser-facing origin (`<scheme>://<host>`) this request reached us with,
 * used to rewrite DSH's loopback absolute URLs back to the real domain. */
function realOrigin(headers: IncomingHttpHeaders): string | undefined {
  const host = clientHost(headers)
  if (host === undefined) return undefined
  const proto = headers['x-forwarded-proto']
  const scheme = typeof proto === 'string' && proto !== '' ? proto : 'https'
  return `${scheme}://${host}`
}

/** A subdomain resolution: a tunnelable endpoint, an error to return, or null (not a subdomain). */
type SubdomainAccess = { endpoint: Endpoint; userId: string } | { error: string; code: number; userId?: string } | null

/**
 * The client-facing host, preferring `X-Forwarded-Host`. The control plane sits
 * behind an edge proxy (Tencent nginx) that hides the real Host to sidestep the
 * cloud provider's ICP check (manual/architecture.md); the real domain arrives
 * here. The subdomain auth check still validates the cookie against the slug, so
 * a spoofed forwarded host cannot reach another user's DSH.
 */
function clientHost(headers: IncomingHttpHeaders): string | undefined {
  const fwd = headers['x-forwarded-host']
  if (typeof fwd === 'string' && fwd !== '') return fwd
  if (Array.isArray(fwd) && fwd[0] !== '') return fwd[0]
  return headers.host
}

/**
 * Resolve a subdomain Host to a DSH port, authenticating the caller: the session
 * cookie must belong to a non-disabled user whose username matches the subdomain.
 */
async function resolveSubdomainAccess(
  app: FastifyInstance,
  host: string | undefined,
  cookieHeader: string | undefined,
): Promise<SubdomainAccess> {
  const slug = parseSubdomain(host, app.config.baseDomain)
  if (slug === null) return null
  const target = await app.db.findUserBySlug(slug)
  if (target === undefined) return { error: 'unknown_user', code: 404 }
  const token = parseCookie(cookieHeader, 'sid')
  const session = token === undefined ? undefined : await app.db.findSessionWithUser(hashSessionToken(token))
  if (session === undefined || session.expiresAt <= Date.now() || session.user.role === 'disabled') {
    return { error: 'unauthorized', code: 401 }
  }
  if (session.user.username.toLowerCase() !== slug) {
    return { error: 'forbidden', code: 403 }
  }
  const endpoint = await app.supervisor.endpointFor(session.user.id)
  if (endpoint === undefined) return { error: 'not_running', code: 404, userId: session.user.id }
  // userId 一并返回：实例侧 401（launch token 过期）时用它取当前实例的新 token。
  // Real user traffic to their own DSH counts as activity (idle-reap signal).
  app.supervisor.touch(session.user.id)
  return { endpoint, userId: session.user.id }
}

/**
 * 2026-09-19：**实例冷启动窗口内不许裸断连接**。
 *
 * 实测事故（admin 首次用新域 `admin.<baseDomain>` 进场）：
 *   16:06:52 `POST /api/dsh/enter`（耗时 11.1 s）拉起实例，scope 16:06:52 建立；
 *   16:07:04（12 s 后）用户 GET `/` —— 此时实例**进程已在、端口已分配**但 dsh 尚未开始监听，
 *   本文件的转发重试两次都失败 ⇒ 旧代码 `reply.raw.destroy()` **不写任何响应**
 *   ⇒ 边缘 nginx 只能记 `upstream prematurely closed connection while reading response header`
 *   并回 **502**（平台 journal 里该请求只有 `incoming request`、没有 `request completed`，
 *   正是"平台接了却没回"的铁证），浏览器看到的是一张无信息的 502 页。
 *
 * 处置：响应头尚未发出时回 **503 + Retry-After**（导航请求给一页会自刷新的极简 HTML），
 * 与「实例未就绪要给过渡/可重试信号」的既有口径一致；只有**已开始写响应**时才允许 destroy。
 */
function replyUpstreamUnavailable(request: FastifyRequest, reply: FastifyReply): void {
  if (reply.raw.headersSent || reply.raw.writableEnded) {
    reply.raw.destroy()
    return
  }
  const isNav =
    request.raw.method === 'GET' && String(request.headers.accept ?? '').includes('text/html')
  const common = { 'retry-after': '2', 'cache-control': 'no-store' }
  if (isNav) {
    reply.raw.writeHead(503, { ...common, 'content-type': 'text/html; charset=utf-8' })
    reply.raw.end(
      '<!doctype html><meta charset="utf-8"><title>实例启动中</title>' +
        '<body style="font:15px/1.7 system-ui,sans-serif;padding:48px;color:#333">' +
        '<h3 style="margin:0 0 8px">实例启动中…</h3>' +
        '<p style="margin:0;color:#666">正在唤醒你的工作区，页面将在 2 秒后自动重试。</p>' +
        '<script>setTimeout(function(){location.reload()},2000)</script>',
    )
    return
  }
  reply.raw.writeHead(503, { ...common, 'content-type': 'application/json' })
  reply.raw.end('{"error":"instance_starting"}')
}

function proxyHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  endpoint: Endpoint,
  targetPath: string,
  rewritePrefix?: string,
  rewriteLoopbackLocation = false,
  useKeepAlive = false,
  /**
   * 实例侧 401 时的恢复入口：浏览器导航遇到 dsh 的 "authentication required"
   * （launch token 过期 —— 实例重启/回收后刷新旧标签页）时调用，返回应 302 到的地址。
   * 返回 undefined 则回落到 '/'。
   */
  freshAuthUrl?: () => Promise<string | undefined>,
): void {
  reply.hijack()
  // 为「401 透明重放」准备请求体。
  // 只在 content-length 已知且不大时才缓冲（普通 /api JSON-RPC 请求都很小）；
  // 未知长度（chunked 上传）不缓冲 → 该请求退回旧行为（401 透传），不做重放。
  const MAX_REPLAY_BODY = 8 * 1024 * 1024
  const reqMethod = (request.raw.method ?? 'GET').toUpperCase()
  const mayHaveBody = reqMethod !== 'GET' && reqMethod !== 'HEAD'
  const clNum =
    typeof request.headers['content-length'] === 'string' ? Number(request.headers['content-length']) : NaN
  const bufferable = mayHaveBody && Number.isFinite(clNum) && clNum <= MAX_REPLAY_BODY
  let bodyBuf: Buffer | undefined
  // ★ 事后修正 1（2026-09-11）：重放闸门**不能**用 bufferable —— 它含 mayHaveBody，
  // 会让 GET/HEAD（含 dsh 的 SSE 会话流）永远无法重放。GET 没有请求体，反而最该能重放。
  const canReplay = mayHaveBody ? false : true
  let authRetryUsed = false
  let replayCookies: string[] = []

  // ── `/plugins/` 合并脚本的**条件请求短路**（ETag → 304）──────────────
  // 背景（实测 2026-09-14）：那条把全部客户端插件拼起来的脚本 **11,172,365 B、未压缩**，
  //   而我们对它下发 `no-cache`（为"改了 UI 就能看到"）；实例既不给 `ETag`
  //   也不给 `Last-Modified` ⇒ 浏览器"回源校验"退化成**每次全量重下 11 MB**
  //   （经 Cloudflare 实测 **114.87 s**；弱网/手机上直接表现为页面加载不出来）。
  // 本块 = 平台侧补一个**由 URL 派生**的强校验器（不改官方、不改实例、不动 rev）：
  //   · 官方 `@deepseek-ai/dsh-client-modules` 的契约是
  //     「**已公告响应不可变；未知组合或 revision 返回 404**」⇒ `(模块组合, rev)` 唯一决定内容，
  //     同一 URL 永远同一份字节 ⇒ 用 URL 派生 ETag 是**安全**的；
  //   · 只对 **GET/HEAD + `/plugins/` 且 URL 含 `rev=`** 生效（无 rev 的一律跳过，绝不冒险）；
  //   · 命中 `If-None-Match` 时**直接回 304、完全不回源**（省掉的正是那 11 MB）。
  //   · 未命中时行为与原先一致，只多一个 `ETag` 响应头（见响应头区块）。
  const pluginEtag =
    (reqMethod === 'GET' || reqMethod === 'HEAD') && targetPath.startsWith('/plugins/') && targetPath.includes('rev=')
      ? '"' + createHash('sha1').update(targetPath).digest('hex') + '"'
      : undefined
  if (pluginEtag !== undefined) {
    const inm = request.headers['if-none-match']
    if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === pluginEtag)) {
      reply.raw.writeHead(304, { etag: pluginEtag, 'cache-control': 'no-cache' })
      reply.raw.end()
      return
    }
  }

  const attempt = (connRetry: boolean, authCookie?: string): void => {
    // 修正（实测定位）：**HTML 导航请求必须向上游要 identity**。
    // 原因：dsh 实例对带 Accept-Encoding 的请求会 **gzip 压缩 HTML**（浏览器就带），
    // 于是响应带 content-encoding → 我下面的注入逻辑**主动跳过** → 浏览器拿到的页面
    // **没有自愈脚本** → C 方案对真实用户无效（而 curl 不带 Accept-Encoding，故此前验证
    // 是假阳性）。改法：只要**客户端接受 HTML**，就覆盖转发的 accept-encoding 为 identity，
    // 让上游回未压缩 HTML → 注入成功。体积影响可忽略（HTML ~24KB），且边缘 nginx 若开 gzip
    // 仍会对浏览器压缩，用户侧无感知。静态资源/SSE 的压缩行为不受影响。
    const upHeaders = buildUpstreamHeaders(request.headers, endpoint.port)
    if (String(request.headers.accept ?? '').includes('text/html')) {
      upHeaders['accept-encoding'] = 'identity'
    }
    // 重放时用**当前实例的新 cookie** 覆盖浏览器带来的旧 cookie。
    if (authCookie !== undefined) upHeaders.cookie = authCookie
    if (bodyBuf !== undefined) {
      // 请求体已缓冲 → 显式带上长度并去掉可能存在的 chunked 头，保证重放一致。
      delete upHeaders['transfer-encoding']
      upHeaders['content-length'] = String(bodyBuf.length)
    }
    const upstream = httpRequest(
      {
        host: endpoint.host,
        port: endpoint.port,
        path: targetPath,
        method: request.method,
        // Keep-alive is off in this deployment: local mode uses a fresh
        // connection per request: the loopback connect cost is negligible and
        // this avoids the half-open keep-alive pool that hung the proxy after
        // child-instance restarts (2026-09-09 outage: pooled sockets to a
        // since-recycled instance port never errored, so requests hung).
        agent: useKeepAlive && !connRetry ? upstreamAgent : false,
        // Host header stays loopback for the DSH trust fence; the TCP target host
        // is endpoint.host above.
        headers: upHeaders,
      },
      (upRes: IncomingMessage) => {
        const headers = { ...upRes.headers }
        const isNav =
          request.raw.method === 'GET' && String(request.headers.accept ?? '').includes('text/html')
        // **非导航**请求的实例侧 401 = 页面拿着旧实例的 dsh-auth cookie。
        // 透明重放：取当前实例新 cookie → 覆盖 cookie 头重发同一请求 → 新 cookie 回写浏览器。
        // 只重放一次（authRetryUsed），避免与实例互相刷 401 造成死循环。
        const replayReady = mayHaveBody ? bodyBuf !== undefined : canReplay
        if (upRes.statusCode === 401 && !isNav && !authRetryUsed && freshAuthUrl !== undefined && replayReady) {
          authRetryUsed = true
          upRes.resume()
          void (async () => {
            let cookieHeader: string | undefined
            try {
              const url = await freshAuthUrl()
              const tk = tokenFromAuthUrl(url)
              if (tk !== undefined) {
                const fresh = await fetchInstanceAuthCookies(endpoint, tk)
                if (fresh.length > 0) {
                  replayCookies = fresh
                  cookieHeader = mergeCookieHeader(request.headers.cookie, fresh)
                }
              }
            } catch {
              /* 取不到 → 回落到原样 401 */
            }
            if (cookieHeader === undefined) {
              reply.raw.writeHead(401, headers)
              reply.raw.end('unauthorized')
              return
            }
            process.stderr.write(
              `[proxy-auth-replay] ${request.raw.method ?? 'GET'} ${targetPath}（旧 cookie → 实例新 cookie，重放）\n`,
            )
            attempt(false, cookieHeader)
          })()
          return
        }
        // 重放成功后把新 cookie 交给浏览器：之后（含 SSE 自动重连）不再需要重放。
        // ── （治本）：把**陈旧的 `dsh-auth-*` cookie 从浏览器里清掉** ──────────
        // 由来（2026-09-14 实测）：dsh **每次实例 (重)启动都换** `dsh-auth-<随机后缀>` 的 cookie 名
        //   （见本文件头部注释）。浏览器把每一个旧名都留着，而平台此前只在**转发给实例时**丢弃
        //   旧的（`mergeCookieHeader`），**从不回写浏览器** ⇒ jar **只增不减** ⇒ `Cookie` 请求头
        //   越涨越长 ⇒ 涨到 ~15 KB（实测 12.8 KB 放行 / 19.1 KB 已被 431）就被 Cloudflare /
        //   本机 nginx 直接 **431** 拒掉 —— 请求**根本到不了平台** ⇒ 那条 11 MB 合并脚本取不到
        //   ⇒ 客户端报 `bundle script … failed to load`（界面「Failed to load plugins」）。
        //   ⚠️ 所以这一块**救不了已经 431 的当下**（那时请求进不来），它的作用是**防复发**：
        //      用户手动清一次之后，jar 不会再长回去。
        // 为什么只在「本次响应确实下发了 dsh-auth」时才动手：只有这时我们**确知当前有效的名字**，
        //   才能安全清掉其余旧名；否则（例如普通 API 响应不带该 cookie）宁可什么都不做。
        {
          const scNow = headers['set-cookie']
          const scList = Array.isArray(scNow) ? scNow : scNow === undefined ? [] : [String(scNow)]
          const freshNames = scList
            .map((c) => /^\s*(dsh-auth-[^=;\s]*)\s*=/.exec(String(c))?.[1] ?? '')
            .filter((n) => n !== '')
          if (freshNames.length > 0) {
            const staleNames = (request.headers.cookie ?? '')
              .split(';')
              .map((x) => (x.split('=')[0] ?? '').trim())
              .filter((n) => n.startsWith('dsh-auth-') && !freshNames.includes(n))
            if (staleNames.length > 0) {
              headers['set-cookie'] = [
                ...scList,
                ...staleNames.map((n) => `${n}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`),
              ]
            }
          }
        }

        if (authCookie !== undefined && replayCookies.length > 0) {
          const prev = headers['set-cookie']
          headers['set-cookie'] = [
            ...(Array.isArray(prev) ? prev : prev === undefined ? [] : [prev]),
            ...replayCookies,
          ]
        }
        const location = upRes.headers.location
        if (
          rewritePrefix !== undefined &&
          typeof location === 'string' &&
          location.startsWith('/') &&
          !location.startsWith('//') &&
          !location.startsWith(rewritePrefix)
        ) {
          headers.location = rewritePrefix + location
        }
        // ── 2026-09-12（平台缓存治理）：让「改了 client bundle 却看不到变化」不再发生 ──
        //
        // 背景（v0.2.6 实测，排查成本极高）：
        //   dsh 的客户端模块 URL 形如 `/plugins/??<pkg>/client.js,…&rev=<内容 sha1>`，
        //   `rev` 由 **dsh 官方**按内容计算（`dsh-client-modules`），**平台不得改（R2）**。
        //   平台更新 bundle 后，若 `rev` 未变 → 浏览器认为手上那份缓存仍有效 → **不重新请求**
        //   ⇒ 服务端已是新版、用户却一直看到旧 UI（本次：SQL 层/磁盘/服务端三处都验过是新的）。
        //
        // 处置：对实例的**模块/静态资源路径**统一加 `Cache-Control: no-cache` ——
        //   **允许缓存，但每次必须回源校验**（配合上游 ETag/Last-Modified 走 304，开销极小）。
        //   ⇒ bundle 一变，浏览器下一次请求就拿到新的，**用户无需清缓存/换无痕**。
        //
        // 2026-09-14（追加）：**HTML 外壳同样必须 no-cache**。
        //   实测根因：`/` 原先**不带任何缓存头**（无 Cache-Control / ETag / Last-Modified）
        //   ⇒ 浏览器对它走**启发式缓存**；而外壳里内嵌了带**内容哈希 `rev`** 的插件 bundle URL
        //   （见下方 `if` 之上那段注释）。插件集合一变、或实例重启重算 rev，
        //   旧外壳就会一直去请求**已不存在的 rev** ⇒ 实例按契约返回 **404**
        //   ⇒ dsh 客户端报 `client-modules: bundle script … failed to load` ⇒ 界面「Failed to load plugins」，
        //   且**普通刷新会命中缓存的外壳、复现不消失**（2026-09-14 真实事故：当天连铺 4 次插件 + 2 次重启平台）。
        //   ⇒ 外壳加 no-cache 后，浏览器每次都会回源取到**当前**的外壳与 rev。
        //
        // ⚠️ 勿删：这是 UI 改动能否被验收的前置机制（`工作台 UI 规范`）。
        if (
          targetPath.startsWith('/plugins/') ||
          targetPath.startsWith('/assets/') ||
          String(headers['content-type'] ?? '').includes('text/html')
        ) {
          headers['cache-control'] = 'no-cache'
        }
        // 把派生 ETag 一并透出，浏览器下次才能用 If-None-Match 换 304。
        if (pluginEtag !== undefined) headers.etag = pluginEtag
        // DSH builds absolute URLs from the loopback Host we forward; rewrite any
        // 127.0.0.1 Location to the real origin so the browser doesn't jump to the
        // user's own machine.
        if (
          rewriteLoopbackLocation &&
          typeof location === 'string' &&
          realOrigin(request.headers) !== undefined
        ) {
          headers.location = location.replace(/^https?:\/\/127\.0\.0\.1(:\d+)?/, realOrigin(request.headers)!)
        }
        // 2026-09-11：实例侧 401 = launch token 过期。浏览器导航时不要停在
        // dsh 的 "dsh web authentication required; reopen the URL printed by dsh web." 死端页，
        // 而是用当前实例的新 token 302 回同一地址（拿不到则回门户）。
        if (
          upRes.statusCode === 401 &&
          request.raw.method === 'GET' &&
          String(request.headers.accept ?? '').includes('text/html') &&
          freshAuthUrl !== undefined
        ) {
          upRes.resume()
          void freshAuthUrl()
            .then((url) => {
              reply.raw.writeHead(302, { location: url ?? '/' })
              reply.raw.end()
            })
            .catch(() => {
              reply.raw.writeHead(302, { location: '/' })
              reply.raw.end()
            })
          return
        }
        // HTML 响应缓冲后注入「会话过期自愈」脚本（其余一切原样 pipe，零影响）。
        const ctype = String(upRes.headers['content-type'] ?? '')
        const enc = upRes.headers['content-encoding']
        const status = upRes.statusCode ?? 502
        const canInject =
          ctype.includes('text/html') && enc === undefined && status !== 204 && status !== 304
        if (!canInject) {
          if (ctype.includes('text/html') && enc !== undefined) {
            process.stderr.write(`[inject-recovery] skip: content-encoding=${String(enc)}\n`)
          }
          reply.raw.writeHead(status, headers)
          upRes.pipe(reply.raw)
          return
        }
        const chunks: Buffer[] = []
        upRes.on('data', (c: Buffer) => chunks.push(c))
        upRes.on('end', () => {
          const out = injectRecovery(Buffer.concat(chunks).toString('utf8'))
          delete headers['content-length']
          delete headers['transfer-encoding']
          headers['content-length'] = String(Buffer.byteLength(out))
          reply.raw.writeHead(status, headers)
          reply.raw.end(out)
        })
        upRes.on('error', () => replyUpstreamUnavailable(request, reply))
      },
    )
    upstream.on('error', () => {
      if (connRetry) {
        // 冷启动窗口：实例端口已分配但还没监听 ⇒ 回 503（不是裸断连接，见 helper 注释）。
        replyUpstreamUnavailable(request, reply)
        return
      }
      // A stale keep-alive socket, or an instance that just restarted: drop the pool,
      // replace it with a fresh one, and retry once on a fresh connection.
      upstreamAgent.destroy()
      upstreamAgent = new Agent({ keepAlive: true, maxSockets: 32 })
      request.raw.unpipe(upstream)
      attempt(true)
    })
    if (bodyBuf !== undefined) upstream.end(bodyBuf)
    else request.raw.pipe(upstream)
  }
  if (!bufferable) {
    attempt(false)
    return
  }
  const pre: Buffer[] = []
  request.raw.on('data', (c: Buffer) => pre.push(c))
  request.raw.on('end', () => {
    bodyBuf = Buffer.concat(pre)
    attempt(false)
  })
  request.raw.on('error', () => reply.raw.destroy())
}

export async function registerDshProxy(app: FastifyInstance): Promise<void> {
  // Legacy authenticated subpath proxy.
  app.all('/u/:slug/dsh/*', { preHandler: requireAuth }, async (request, reply) => {
    const slug = (request.params as { slug: string }).slug
    if (request.user === null || request.user.id !== slug) {
      reply.code(403).send({ error: 'forbidden' })
      return
    }
    const endpoint = await app.supervisor.endpointFor(slug)
    if (endpoint === undefined) {
      reply.code(404).send({ error: 'not_running' })
      return
    }
    app.supervisor.touch(request.user!.id)
    const prefix = `/u/${slug}/dsh`
    const rawUrl = request.raw.url ?? '/'
    const targetPath = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) || '/' : rawUrl
    const pathScheme = app.config.secureCookies ? 'https' : 'http'
    proxyHttp(
      request,
      reply,
      endpoint,
      targetPath,
      prefix,
      app.config.deployMode === 'local',
      false,
      async () => {
        const status = await app.supervisor.status(request.user!.id)
        const token = status.main?.launchToken
        return token !== undefined && token !== ''
          ? `${pathScheme}://${app.config.baseDomain}${prefix}/?token=${encodeURIComponent(token)}`
          : `${pathScheme}://${app.config.baseDomain}/`
      },
    )
  })

  // Per-user subdomain: HTTP (intercept before normal routing).
  app.addHook('onRequest', async (request, reply) => {
    const access = await resolveSubdomainAccess(app, clientHost(request.headers), request.headers.cookie)
    if (access === null) return
    if ('error' in access) {
      // 浏览器导航（GET + 期待 HTML）的 401（会话失效/退出后刷新实例子域）→ 302 回门户
      // 登录页，而不是吐 JSON {"error":"unauthorized"} 停在原地。
      if (
        access.code === 401 &&
        request.raw.method === 'GET' &&
        (request.headers.accept ?? '').includes('text/html')
      ) {
        const scheme = app.config.secureCookies ? 'https' : 'http'
        reply.redirect(`${scheme}://${app.config.baseDomain}/login.html`)
        return
      }
      // 实例未运行（后台回收/崩溃/停止/熔断后刷新会话页）→ 需要拉起。
      //
      // 2026-09-11（体验修复）：**浏览器导航一律"立刻" 302 到平台自有的过渡页**，
      // 由过渡页显示加载动画并自己调 /api/dsh/enter 完成「拉起 + 等 token + 跳回」。
      // 原因：此前导航请求会在**服务端阻塞等待 launch token（最长 20 秒）**，这期间浏览器
      // 只看到白屏、没有任何反馈 → 用户以为卡死，只能手动刷新（那时实例已就绪，看似"刷新才好"）。
      // 现在导航分支**不阻塞**（0.2s 内返回 302），动画立刻出现，且**不会**在这里触发 launch
      //（拉起交给过渡页，单点、可重试）。
      if (access.code === 404 && access.error === 'not_running' && access.userId !== undefined) {
        const navScheme = app.config.secureCookies ? 'https' : 'http'
        const navHost = clientHost(request.headers) ?? app.config.baseDomain
        const isNavigation =
          request.raw.method === 'GET' && (request.headers.accept ?? '').includes('text/html')
        if (isNavigation) {
          const next = `${navScheme}://${navHost}${request.raw.url ?? '/'}`
          reply.redirect(
            `${navScheme}://${app.config.baseDomain}/wake.html?next=${encodeURIComponent(next)}`,
          )
          return
        }
        // 非导航（XHR / API）——**这是"页面已打开、再对话没反应"的主场景**。
        // 正解不是"回一个错误/动画"，而是**等实例就绪后继续转发**：请求最终成功，
        // dsh 前端自己会保持它的 loading 态 → 用户无感，不需要刷新。
        try {
          const folderAbs = app.userFs.resolvePath(access.userId, '')
          try {
            await app.supervisor.launch(access.userId, folderAbs, undefined)
          } catch {
            // 并发进场（另一请求正在拉起 → AlreadyRunningError）：等它拿到 token
            await app.supervisor.waitForLaunchTokenForUser(access.userId, 20000)
          }
        } catch {
          /* 拉起失败 → 落到下面的 503 */
        }
        const again = await resolveSubdomainAccess(app, clientHost(request.headers), request.headers.cookie)
        if (again !== null && !('error' in again)) {
          proxyHttp(
            request,
            reply,
            again.endpoint,
            request.raw.url ?? '/',
            undefined,
            app.config.deployMode === 'local',
            false,
            async () => {
              const st = await app.supervisor.status(again.userId)
              const tk = st.main?.launchToken
              return tk !== undefined && tk !== ''
                ? `${navScheme}://${navHost}/?token=${encodeURIComponent(tk)}`
                : `${navScheme}://${app.config.baseDomain}/`
            },
          )
          return
        }
        // 真的起不来：给明确的「启动中」+ Retry-After，让前端自行退避重试。
        reply.code(503).header('retry-after', '3').send({ error: 'instance_starting' })
        return
      }
      reply.code(access.code).send({ error: access.error })
      return
    }
    const navScheme = app.config.secureCookies ? 'https' : 'http'
    const navHost = clientHost(request.headers) ?? app.config.baseDomain
    proxyHttp(
      request,
      reply,
      access.endpoint,
      request.raw.url ?? '/',
      undefined,
      app.config.deployMode === 'local',
      false,
      async () => {
        const status = await app.supervisor.status(access.userId)
        const token = status.main?.launchToken
        return token !== undefined && token !== ''
          ? `${navScheme}://${navHost}/?token=${encodeURIComponent(token)}`
          : `${navScheme}://${app.config.baseDomain}/`
      },
    )
  })

  // Per-user subdomain: WebSocket upgrade tunnel. Auth is async (DB lookup), so
  // the raw `upgrade` callback defers to an async IIFE before deciding to tunnel.
  app.server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const access = await resolveSubdomainAccess(app, clientHost(req.headers), req.headers.cookie)
      if (access === null || 'error' in access) {
        socket.destroy()
        return
      }
      const upstream = connect({ host: access.endpoint.host, port: access.endpoint.port })
      upstream.on('connect', () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = (req.rawHeaders[i] ?? '').toLowerCase()
          if (name === 'host' || STRIP_HEADERS.has(name)) continue
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
        }
        lines.push(`Host: 127.0.0.1:${access.endpoint.port}`)
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head !== undefined && head.length > 0) upstream.write(head)
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
    })()
  })
}
