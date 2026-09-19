/**
 * Desktop / filesystem routes: list the user's workspace, create a folder, and
 * upload a file. Every path is resolved against the caller's own workspace
 * root, so one user can never address another user's files.
 *
 * The routes never touch `node:fs` themselves — they go through the
 * {@link UserFs} seam, which touches the users volume in-process.
 * @module dsh_ai1net/web/routes/desktop
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { requireAuth } from '../middleware/authn.js'
import { UserFsError } from '../../fs/user-fs.js'
import { extname } from 'node:path'

const mkdirSchema = {
  body: {
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: { path: { type: 'string', maxLength: 512 } },
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

/** 下载时的 content-type（只覆盖常见类型，其余 application/octet-stream）。 */
const DL_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
}
function downloadType(name: string): string {
  return DL_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Turn a seam failure into the `{error}` body the desktop UI switches on. */
export function sendFsError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof UserFsError) return reply.code(err.status).send({ error: err.code })
  throw err
}

export const desktopRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/desktop/tree', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    try {
      return { path, entries: await app.userFs.listDir(request.user!.id, path) }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/mkdir', { preHandler: requireAuth, schema: mkdirSchema }, async (request, reply) => {
    const { path } = request.body as { path: string }
    try {
      await app.userFs.mkdir(request.user!.id, path)
      return { ok: true }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/upload', { preHandler: requireAuth, schema: uploadSchema }, async (request, reply) => {
    const { path, name, data } = request.body as { path: string; name: string; data: string }
    let buf: Buffer
    try {
      buf = Buffer.from(data, 'base64')
    } catch {
      return reply.code(400).send({ error: 'bad_data' })
    }
    try {
      return { ok: true, name: await app.userFs.upload(request.user!.id, path, name, buf) }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  // 下载/查看工作区文件 —— 之前**没有**任何读取端点，AI 产出的文件用户既看不到也下不了，
  // 而 AI 只能给出 `/var/lib/.../ws/...` 这类宿主绝对路径（浏览器打不开）。
  // 路径经 UserFs 解析（限定在调用者自己的根内，逃逸即 bad_path），并限制单文件大小。
  app.get('/api/fs/download', { preHandler: requireAuth }, async (request, reply) => {
    const { path = '' } = request.query as { path?: string }
    try {
      const { name, data } = await app.userFs.readFile(request.user!.id, path)
      return reply
        .header('content-type', downloadType(name))
        .header('content-disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(name))
        .header('cache-control', 'no-store')
        .send(data)
    } catch (err) {
      return sendFsError(reply, err)
    }
  })

  app.post('/api/fs/create', { preHandler: requireAuth, schema: createSchema }, async (request, reply) => {
    const { path, name, type } = request.body as { path: string; name: string; type: 'file' | 'dir' }
    try {
      return { ok: true, name: await app.userFs.createEntry(request.user!.id, path, name, type), type }
    } catch (err) {
      return sendFsError(reply, err)
    }
  })
}
