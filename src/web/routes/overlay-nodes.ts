/**
 * 覆盖网络 **管理面 API**（P2/S5 一并做 —— 该文件是 P1 的出口项）。
 *
 * ## 它回答两个问题
 * | 端点 | 作用 | 鉴权 |
 * |---|---|---|
 * | `GET /api/admin/overlay-nodes` | **有哪些网 / 每个节点什么状态**（只读汇总） | `requireAdmin` |
 * | `GET /api/admin/overlay-nodes/direct` | 本机**直连开关**现状 ＋ **三段提示** | `requireAdmin` |
 * | `POST /api/admin/overlay-nodes/direct` | **用户可设置**（口径①）—— 只改本机配置的 `direct` 字段 | `requireAdmin` |
 *
 * ## 🔴 三条纪律
 * ① **全部走 `requireAdmin`** —— ⛔ 不做第二个无鉴权端点：既有的 `GET /dsh_ai1net-overlay/bootstrap`
 *    之所以能无鉴权，是因为它**只服务还没有凭据的新节点**且内容被收窄到"去哪儿"；
 *    "**有哪些节点**"是**拓扑信息**，放公网 = 扩大暴露面（命中 **R5**）。
 * ② **只写"跟着这台机器走"的那一项** —— 直连开关放**本机配置**（`<NODE_CONFIG_FILE>.direct`），
 *    ⛔ 不写共享 drop-in / env：那属于控制面或运维的通道（见 `direct/index.ts#resolveDirectSwitch`
 *    的优先级口径：env ＞ 本机配置 ＞ 缺省）。
 * ③ **失败具名** —— 文件不存在 / 形状坏 / 写不进去，各自一个原因码，⛔ 不吞、⛔ 不静默创建。
 *
 * @module dsh_ai1net/web/routes/overlay-nodes
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

import type { FastifyPluginAsync } from 'fastify'

import {
  DIRECT_ENV_KEY,
  DEFAULT_DIRECT_ENABLED,
  NODE_CONFIG_FILE_DEFAULT,
  directFromNodeConfig,
  directHintLines,
  resolveDirectSwitch,
  writeNodeConfigDirect,
} from '../../net/relay/direct/index.js'
import { loadRegistry, summarizeNetworks, listNodes } from '../../net/relay/registry.js'
import { requireAdmin } from '../middleware/authn.js'
import { join } from 'node:path'
import { dataRootDir } from '../../platform-paths.js'

/** 本机配置落点（`DSH_AI1NET_OVERLAY_NODE_CONFIG` 可覆盖；缺省与 `join` 的 `--config` 一致）。 */
function nodeConfigFile(): string {
  const v = process.env.DSH_AI1NET_OVERLAY_NODE_CONFIG
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : NODE_CONFIG_FILE_DEFAULT
}

/** 注册表落点（`DSH_AI1NET_OVERLAY_NODES_FILE` 可覆盖；缺省 = 参数表 `NODES_REGISTRY_FILE`）。 */
function registryFile(): string {
  const v = process.env.DSH_AI1NET_OVERLAY_NODES_FILE
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : join(dataRootDir(), 'overlay', 'nodes.json')
}

const fss = {
  exists: (p: string) => existsSync(p),
  read: (p: string) => readFileSync(p, 'utf8'),
  write: (p: string, text: string, mode: number) => writeFileSync(p, text, { mode }),
  rename: (from: string, to: string) => renameSync(from, to),
}

/** 读本机配置里的 `direct`（**缺文件 ⇒ `undefined`**，形状坏 ⇒ 抛给调用方具名化）。 */
function readLocalDirect(): { file: string; present: boolean; direct?: boolean } {
  const file = nodeConfigFile()
  if (!existsSync(file)) return { file, present: false }
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
  return { file, present: true, direct: directFromNodeConfig(raw) }
}

export const overlayNodeRoutes: FastifyPluginAsync = async (app) => {
  /** 只读汇总：有哪些网 / 每张网几个 approved、几个 pending / 节点清单。 */
  app.get('/api/admin/overlay-nodes', { preHandler: requireAdmin }, async (_request, reply) => {
    const file = registryFile()
    if (!existsSync(file)) {
      // "这套准入还没开始用"是**合法状态** ⇒ 200 ＋ 明确的 `present:false`（⛔ 不是 500，也不是空 200）
      return reply.send({ registry: { file, present: false }, networks: [], nodes: [] })
    }
    let reg
    try {
      reg = loadRegistry(file)
    } catch (err) {
      return reply.code(500).send({ error: 'registry-unreadable', detail: err instanceof Error ? err.message : String(err) })
    }
    return reply.send({
      registry: { file, present: true, version: reg.version },
      networks: summarizeNetworks(reg),
      nodes: listNodes(reg).map((n) => ({
        network: n.network,
        hostId: n.hostId,
        status: n.status,
        group: n.group,
        appliedAt: n.appliedAt,
        approvedAt: n.approvedAt,
      })),
    })
  })

  /** 直连开关现状（含**三段提示** —— 用户口径③的"设置面显示"落点）。 */
  app.get('/api/admin/overlay-nodes/direct', { preHandler: requireAdmin }, async (_request, reply) => {
    let local: { file: string; present: boolean; direct?: boolean }
    try {
      local = readLocalDirect()
    } catch (err) {
      return reply.code(500).send({ error: 'node-config-bad', detail: err instanceof Error ? err.message : String(err) })
    }
    const state = resolveDirectSwitch(process.env, { localDirect: local.direct })
    return reply.send({
      envKey: DIRECT_ENV_KEY,
      defaultEnabled: DEFAULT_DIRECT_ENABLED,
      effective: state.enabled,
      source: state.source,
      raw: state.raw,
      invalid: state.invalid,
      nodeConfig: { file: local.file, present: local.present, direct: local.direct ?? null },
      hint: directHintLines(),
    })
  })

  /**
   * 设置直连开关（**用户可设置**）。
   *
   * ⛔ 只动本机配置的 `direct`；⚠️ 若 env 里显式设了 `DSH_AI1NET_OVERLAY_DIRECT`，它会**压过**本项
   * ⇒ 回执里把这件事**明说**（否则用户会以为"改了没生效 = 平台坏了"）。
   */
  app.post('/api/admin/overlay-nodes/direct', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { enabled?: unknown } | undefined
    if (body === undefined || typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'bad-body', detail: 'body 须为 {enabled: boolean}' })
    }
    const outcome = writeNodeConfigDirect(nodeConfigFile(), body.enabled, fss)
    if (!outcome.ok) return reply.code(400).send({ error: outcome.reason, detail: outcome.detail })
    const state = resolveDirectSwitch(process.env, { localDirect: outcome.direct })
    return reply.send({
      ok: true,
      file: outcome.file,
      direct: outcome.direct,
      effective: state.enabled,
      source: state.source,
      envOverrides: state.source === 'env',
      note:
        state.source === 'env'
          ? `⚠️ 本机 env 里已显式设了 ${DIRECT_ENV_KEY}=${state.raw} ⇒ 它**压过**本次设置（env ＞ 本机配置 ＞ 缺省）`
          : '已生效（重启节点服务后按本文件生效）',
    })
  })
}
