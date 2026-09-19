/**
 * Admin 视角的「用户服务 / 工作区文件」路由。
 *
 * 背景：平台所有服务与文件 API 都是 `request.user.id` 语义（`desktop.ts` 头注释更明确写着
 * "one user can never address another user's files"）⇒ admin 在「设置 → 系统管理 → 服务管理」
 * 里**只能管自己**。用户要求「admin 要能管所有用户的服务」。
 *
 * 做法：**不动既有路由的语义**（避免把越界风险塞进普通用户路径），另开一组
 * `/api/admin/users/:id/...`，全部 `requireAdmin`，把 `request.user.id` 换成路径参数。
 * 底层 `UserFs` / `Spawner` 本来就都接受 `userId` 首参 ⇒ 零新增能力面；
 * 启动/状态复用 `dsh.ts` 导出的 `launchForUser` / `statusForUser`（一份实现，两处入口）。
 *
 * ⚠️ R5 权限影响评估：新增的是 **admin 对任意用户**的
 *   ① 浏览 / 新建 / 上传其工作区文件 —— 仍限定在该用户 ws 根内（`UserFs` 自带逃逸防护，
 *      越界即 `bad_path`）
 *   ② 启停其 DSH 实例 —— 与用户自己点「启动 / 停止」同一条 `supervisor` 路径
 * 这与 `requireAdmin` 既有职能（审批 / 禁用 / 删除用户）同级；服务器层面 admin 本就能读
 * `<data-root>/users/**`。**不扩大普通用户的能力面** —— 这些前缀下没有任何 `requireAuth` 版本。
 * @module dsh_ai1net/web/routes/admin-user-ops
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { requireAdmin } from '../middleware/authn.js'
import { sendFsError } from './desktop.js'
import { AlreadyRunningError, CrashBreakerOpenError } from '../../supervisor/orchestrator.js'
import { dshUrl, launchForUser, sendBreakerOpen, statusForUser } from './dsh.js'

// 与 desktop.ts / dsh.ts 的同名 schema 同形（那两处未导出，这里按同一形状内联）。
const createSchema = {
  body: {
    type: 'object',
    required: ['path', 'name', 'type'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: 512 },
      name: { type: 'string', maxLength: 255 },
      type: { type: 'string', enum: ['file', 'dir'] },
    },
  },
} as const

const uploadSchema = {
  body: {
    type: 'object',
    required: ['path', 'name', 'data'],
    additionalProperties: false,
    properties: {
      path: { type: 'string', maxLength: 512 },
      name: { type: 'string', maxLength: 255 },
      data: { type: 'string' },
    },
  },
} as const

const launchSchema = {
  body: {
    type: 'object',
    required: ['folder'],
    additionalProperties: false,
    properties: { folder: { type: 'string', maxLength: 512 } },
  },
} as const

export const adminUserOpsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * 解析 `:id` 指向的用户；不存在则回 404 并返回 `undefined`。
   * 每个路由都过这一关 —— 防 `:id` 乱填导致 `UserFs` 在错误根上操作。
   */
  async function targetOr404(id: string, reply: FastifyReply) {
    const user = await app.db.findUserById(id)
    if (user === undefined) {
      reply.code(404).send({ error: 'not_found' })
      return undefined
    }
    return user
  }

  // ── 工作区文件 ──────────────────────────────────────────────────────────────
  app.get('/api/admin/users/:id/fs/tree', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { path = '' } = request.query as { path?: string }
    if ((await targetOr404(id, reply)) === undefined) return
    try {
      return { path, entries: await app.userFs.listDir(id, path) }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post(
    '/api/admin/users/:id/fs/create',
    { preHandler: requireAdmin, schema: createSchema },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
      if ((await targetOr404(id, reply)) === undefined) return
      try {
        return { ok: true, name: await app.userFs.createEntry(id, path, name, type), type }
      } catch (err) {
        return sendFsError(reply, err)
      }
    },
  )

  app.post(
    '/api/admin/users/:id/fs/upload',
    { preHandler: requireAdmin, schema: uploadSchema },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { path, name, data } = request.body as { path: string; name: string; data: string }
      if ((await targetOr404(id, reply)) === undefined) return
      let buf: Buffer
      try {
        buf = Buffer.from(data, 'base64')
      } catch {
        return reply.code(400).send({ error: 'bad_data' })
      }
      try {
        return { ok: true, name: await app.userFs.upload(id, path, name, buf) }
      } catch (err) {
        return sendFsError(reply, err)
      }
    },
  )

  // ── 实例启停与状态 ─────────────────────────────────────────────────────────
  app.get('/api/admin/users/:id/dsh/status', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await targetOr404(id, reply)
    if (user === undefined) return
    return statusForUser(app, user)
  })

  app.post(
    '/api/admin/users/:id/dsh/launch',
    { preHandler: requireAdmin, schema: launchSchema },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { folder } = request.body as { folder: string }
      const user = await targetOr404(id, reply)
      if (user === undefined) return
      let instance
      try {
        instance = await launchForUser(app, id, folder)
      } catch (err) {
        if (err instanceof AlreadyRunningError) return reply.code(409).send({ error: 'already_running' })
        if (err instanceof CrashBreakerOpenError) return sendBreakerOpen(reply, err)
        return sendFsError(reply, err)
      }
      if (instance === null) return reply.code(400).send({ error: 'not_a_folder' })
      return {
        instance: { id: instance.id, port: instance.port, status: instance.status, launchToken: instance.launchToken },
        // ⚠️ 打开的是**该用户**实例的带 token URL —— admin 用它即可直接进去看（同 `dshUrl` 语义）
        url: dshUrl(app.config.baseDomain, user, instance.launchToken),
      }
    },
  )

  app.post('/api/admin/users/:id/dsh/stop', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if ((await targetOr404(id, reply)) === undefined) return
    await app.supervisor.stop(id)
    return { ok: true }
  })
}
