/**
 * DSH launch / supervise / restart routes + the reverse proxy to a running
 * instance. Launch resolves the requested folder, reads its enabled plugins,
 * writes a cordis patch, and spawns a main+watchdog pair; restart writes a
 * post-restart command handoff and respawns the main.
 * @module dsh_ai1net/web/routes/dsh
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify'
import type { Instance } from '../../supervisor/spawner.js'
import { requireAuth } from '../middleware/authn.js'
import { sendFsError } from './desktop.js'
import { AlreadyRunningError, CrashBreakerOpenError } from '../../supervisor/orchestrator.js'
import { renderPatch } from '../../supervisor/patch.js'
import { subdomainForUser } from '../../supervisor/proxy.js'
import { homeRoot, userRoot } from '../../fs/workspace.js'
import { join } from 'node:path'
import { stateDir } from '../../platform-paths.js'
import { latestSessionPreset } from '../../supervisor/session-preset.js'

const launchSchema = {
  body: {
    type: 'object',
    required: ['folder'],
    additionalProperties: false,
    properties: { folder: { type: 'string', maxLength: 512 } },
  },
} as const

const restartSchema = {
  body: {
    type: 'object',
    required: ['command'],
    additionalProperties: false,
    properties: { command: { type: 'string', maxLength: 1024 } },
  },
} as const

export function alive(status: string | undefined): boolean {
  // 'failed' = 崩溃熔断后停止自动重启，同样不可复用。
  return status !== undefined && status !== 'crashed' && status !== 'stopped' && status !== 'failed'
}

/**
 * 熔断冷却期内的统一响应（503 + 可读信息）。
 *
 * 为什么是 503 而不是 500：这不是"服务坏了"，而是平台**主动拒绝在冷却期内启动**，
 * 客户端应展示「稍后重试」。`retryAfterMs` 供前端提示具体等待时长；
 * `opens` 是累计熔断次数（同一实例反复崩 → 该值递增，可据此判断"该找人了"）。
 */
export function sendBreakerOpen(reply: FastifyReply, err: CrashBreakerOpenError): FastifyReply {
  return reply.code(503).send({
    error: 'instance_circuit_open',
    opens: err.opens,
    retryAfterMs: err.retryAfterMs,
    message: '实例因连续崩溃被暂时熔断，请稍后重试',
  })
}

export function dshUrl(baseDomain: string, user: { id: string; username: string }, token?: string): string {
  const sub = subdomainForUser(baseDomain, user.username)
  const base = sub !== null ? `https://${sub}/` : `/u/${user.id}/dsh/`
  return token !== undefined && token !== '' ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * 启动**任意用户**实例的共用主体：`POST /api/dsh/launch`（自己）与
 * `POST /api/admin/users/:id/dsh/launch`（admin 替别人）都走它 —— 避免"两处副本必然漂"。
 *
 * 返回 `null` 表示目标路径不是文件夹（调用方回 400 `not_a_folder`）；
 * `fs.resolvePath` 的越界错误原样抛出（调用方走 `sendFsError`）；
 * `AlreadyRunningError` / `CrashBreakerOpenError` 也原样抛出（调用方映射 409 / 503）。
 *
 * ⚠️ `userId` 是**被操作的那个用户**，不是调用者 —— 调用方负责鉴权（自己的 id 或 admin）。
 */
export async function launchForUser(
  app: FastifyInstance,
  userId: string,
  folder: string,
): Promise<Instance | null> {
  const fs = app.userFs
  const folderAbs = fs.resolvePath(userId, folder)
  if (!(await fs.isDirectory(userId, folder))) return null
  // Per-folder plugin selection → cordis patch. Rendered here but *not* written:
  // the spawner decides where it lands.
  let patch: string | undefined
  if (app.config.enablePatch) {
    const workspace = await app.db.findWorkspaceByPath(userId, folder)
    // Only inject plugins the user still has installed; a stale selection for a
    // since-removed bundle would otherwise fail to resolve in the child DSH.
    const installed = new Set((await fs.listInstalledPlugins(userId)).map((plugin) => plugin.id))
    const enabled = (workspace === undefined ? [] : await app.db.getEnabledPluginIds(workspace.id)).filter((id) =>
      installed.has(id),
    )
    patch = renderPatch(enabled)
  }
  return app.supervisor.launch(userId, folderAbs, patch)
}

/**
 * 某用户实例的**观测面**（`GET /api/dsh/status` 与 admin 视角共用）。
 * 归档口径见/ 78 / 84 —— 只此一份，别再复制出第二份。
 */
export async function statusForUser(app: FastifyInstance, user: { id: string; username: string }) {
  const { main, watchdog } = await app.supervisor.status(user.id)
  return {
    running: alive(main?.status),
    instance: main
      ? {
          id: main.id,
          port: main.port,
          status: main.status,
          exitCode: main.exitCode,
          lastError: main.lastError,
          // 观测面（A2）：自动重启次数 + 最近崩溃时间
          restarts: main.restarts ?? 0,
          lastCrashedAt: main.lastCrashedAt ?? null,
        }
      : null,
    watchdog: watchdog ? { id: watchdog.id, status: watchdog.status, exitCode: watchdog.exitCode } : null,
    // 观测面：熔断状态 —— 非 null 即"该用户正被冷却"，供门户/排查直接看到
    breaker: app.supervisor.breakerInfo?.(user.id) ?? null,
    // 观测面：本实例**真实**内存配额（= instanceMemMb() 的结果，与 spawn 同源）
    quota: app.supervisor.quotaInfo?.(user.id) ?? null,
    url: dshUrl(app.config.baseDomain, user, main?.launchToken),
  }
}

export const dshRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/dsh/launch', { preHandler: requireAuth, schema: launchSchema }, async (request, reply) => {
    const { folder } = request.body as { folder: string }
    const user = request.user!
    let instance: Instance | null
    try {
      instance = await launchForUser(app, user.id, folder)
    } catch (err) {
      if (err instanceof AlreadyRunningError) return reply.code(409).send({ error: 'already_running' })
      // 熔断冷却期内的启动被拒（用户选文件夹也会走到这里）
      if (err instanceof CrashBreakerOpenError) return sendBreakerOpen(reply, err)
      return sendFsError(reply, err) // 路径越界等 → 400（非 UserFsError 会被原样抛出）
    }
    if (instance === null) return reply.code(400).send({ error: 'not_a_folder' })
    return {
      instance: { id: instance.id, port: instance.port, status: instance.status, launchToken: instance.launchToken },
      url: dshUrl(app.config.baseDomain, user, instance.launchToken),
    }
  })

  // handoff 停写。重启后执行命令的能力依赖 watchdog，而 watchdog 需要
  // `ENABLE_PATCH=true`（线上为 false → 永不启动），且 handoff.json 无人消费。
  // 停写避免"写了没人读"的误导；command 若不为空则记日志留痕。
  app.post('/api/dsh/restart', { preHandler: requireAuth, schema: restartSchema }, async (request, reply) => {
    const { command } = request.body as { command: string }
    const user = request.user!
    if (command !== '') {
      process.stderr.write(
        `[handoff-disabled] restart-with-command ignored (userId=${user.id}, bytes=${command.length})\n`,
      )
    }
    const instance = await app.supervisor.restartMain(user.id)
    if (instance === undefined) return reply.code(404).send({ error: 'not_running' })
    await app.supervisor.spawnWatchdog(user.id)
    return {
      instance: {
        id: instance.id,
        port: instance.port,
        status: instance.status,
        launchToken: instance.launchToken,
        restarts: instance.restarts ?? 0,
      },
      // 能力未启用：请勿依赖"重启后执行命令"（§四 A3）。
      handoff: { accepted: false, reason: 'watchdog_disabled' },
      url: dshUrl(app.config.baseDomain, user, instance.launchToken),
    }
  })

  app.post('/api/dsh/stop', { preHandler: requireAuth }, async (request) => {
    await app.supervisor.stop(request.user!.id)
    return { ok: true }
  })

  // ①：会话权限档位提示 —— 档位是**会话创建时播种**的，平台改默认值不会更新既有会话；
  // 老会话停在 workspace-write 时（本机沙箱后端不可用）dsh 会 fail-closed 拒绝任何 shell，
  // 用户只看到「bash 不可用」。这里把差异暴露出来，由实例页面提示用户切换。
  app.get('/api/dsh/session-permission', { preHandler: requireAuth }, async (request) => {
    const expected = process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'
    const home = homeRoot(userRoot(app.config.dataRoot, request.user!.id))
    const session = latestSessionPreset(home) ?? null
    // 只有"受限档位 + 沙箱后端不可用"这一种组合会真正挡住用户，故仅对 workspace-write 报警。
    const stale = session !== null && session.preset !== expected && session.preset === 'workspace-write'
    return { expected, session, stale }
  })

  // ②：实例能力清单（由 scripts/gen-capabilities.cjs 生成，与实例内 skill 同源）。
  app.get('/api/capabilities', { preHandler: requireAuth }, async () => {
    const { readFileSync } = await import('node:fs')
    const file = process.env.DSH_CAPABILITIES_FILE ?? join(stateDir(), 'capabilities.json')
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { generatedAt: null, note: '能力清单尚未生成（运行 scripts/gen-capabilities.cjs）' }
    }
  })

  app.get('/api/dsh/status', { preHandler: requireAuth }, async (request) => statusForUser(app, request.user!))

  // 登录直达（方案 05，2026-09-09；admin 亦直达 —— 2026-09-09 决策②补充）：
  // 所有已放行角色（admin / active）统一：已运行实例复用其 launchToken URL，
  // 未运行则在 ws 根目录 launch 后返回带 token 的会话 URL。
  // desktop 管理台不再作为登录落点，admin 经会话侧栏"门户/管理台"入口或直
  // 接访问 /portal.html 进入。
  app.post('/api/dsh/enter', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!
    if (user.role !== 'active' && user.role !== 'admin') return reply.code(403).send({ error: 'not_allowed' })
    // Entering the workspace is itself activity (idle-reap signal).
    app.supervisor.touch(user.id)

    // 复用已运行实例（含刚被其它请求 spawn、仍在启动中的实例）：等 launch token 到位
    // 再返回 URL，避免把浏览器直接导向「HTTP 已监听但路由未就绪 → 404」的启动窗口。
    let { main } = await app.supervisor.status(user.id)
    if (main !== undefined && alive(main.status)) {
      if ((main.launchToken ?? '') === '') await app.supervisor.waitForLaunchTokenForUser(user.id)
      main = (await app.supervisor.status(user.id)).main
      if (main !== undefined && alive(main.status) && (main.launchToken ?? '') !== '') {
        return {
          kind: 'session',
          instance: { id: main.id, port: main.port, status: main.status },
          url: dshUrl(app.config.baseDomain, user, main.launchToken),
        }
      }
      // 启动超时或中途崩溃：不给空 token URL（否则浏览器会撞 404），改提示稍后重试
      return reply.code(503).send({ error: 'instance_starting' })
    }

    try {
      const fs = app.userFs
      const folderAbs = fs.resolvePath(user.id, '')
      if (!(await fs.isDirectory(user.id, ''))) return reply.code(400).send({ error: 'not_a_folder' })
      // 根目录 launch：无文件夹级插件勾选 → patch 传 undefined（渲染为空）
      const instance = await app.supervisor.launch(user.id, folderAbs, undefined)
      return {
        kind: 'session',
        instance: { id: instance.id, port: instance.port, status: instance.status, launchToken: instance.launchToken },
        url: dshUrl(app.config.baseDomain, user, instance.launchToken),
      }
    } catch (err) {
      if (err instanceof AlreadyRunningError) {
        // 并发进入：另一请求正在 spawn 同一实例 → 同样等 token 到位再返回
        await app.supervisor.waitForLaunchTokenForUser(user.id)
        const m = (await app.supervisor.status(user.id)).main
        if (m !== undefined && alive(m.status) && (m.launchToken ?? '') !== '') {
          return {
            kind: 'session',
            instance: { id: m.id, port: m.port, status: m.status },
            url: dshUrl(app.config.baseDomain, user, m.launchToken),
          }
        }
        return reply.code(503).send({ error: 'instance_starting' })
      }
      // 熔断冷却期内拒绝隐式拉起（用户 F5 / 注入脚本自愈都会到这里）
      if (err instanceof CrashBreakerOpenError) return sendBreakerOpen(reply, err)
      throw err
    }
  })

}
