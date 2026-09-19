/**
 * 覆盖网络 P0-2：**引导目录端点** `GET /dsh_ai1net-overlay/bootstrap`（**只读 + 无鉴权**）。
 *
 * ## 为什么必须无鉴权
 *
 * 它服务的对象正是「**还没有任何凭据**的新节点」（首次入网）⇒ 不能要求登录。
 * 因此它的暴露面必须**小到可以不设防**，这份目录里只允许出现四类东西：
 *
 * | 字段 | 说明 |
 * |---|---|
 * | `version` / `issuedAt` / `refreshAfterSeconds` | 结构与缓存策略（**被签名覆盖**） |
 * | `network` | 该目录所属的网（`ops`） |
 * | `relays[]` | 中继端点（**只放公网 / 域名形态**，过滤回环与私网） |
 * | `bootstrap[]` | **可轮换的引导地址清单** |
 *
 * ⛔ 目录里**不出现**：hostId、任何密钥、用户数据、内网地址、实例端口、版本号之外的内部标识。
 * 连上之后**能拨谁**由 relay 侧的「网维度 + 白名单」（P0-1）决定 —— 目录只管"去哪儿"。
 *
 * ## 失败关闭
 *
 * 没有配签名私钥 / 私钥读不出来 / 签名抛错 ⇒ **`503 directory-unavailable`**，
 * **绝不返回未签名目录**（否则"签名不对就拒绝"这条客户端判据会被一个半成品端点绕过）。
 *
 * 缓存策略 = `no-store`：目录**故意允许被轮换**，让 CDN / 浏览器留一份旧副本会把轮换能力拖死
 * （客户端自己按 `refreshAfterSeconds` 缓存，不需要中间层再插一手）。
 * @module dsh_ai1net/web/routes/overlay
 */

import type { FastifyPluginAsync } from 'fastify'
import { readFileSync } from 'node:fs'
import type { ServerConfig } from '../../config.js'
import {
  DIRECTORY_PATH,
  buildDirectoryDocument,
  publicRelayEntries,
  signDirectory,
  type OverlayDirectory,
} from '../../net/relay/directory.js'

/** 组装并签发目录；任一步不可用 ⇒ `undefined`（调用方回 503，**不发未签名目录**）。 */
function buildSignedDirectory(config: ServerConfig): { doc: OverlayDirectory; sig: string } | undefined {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  if (config.overlayDirKeyFile === '') {
    log('[overlay-dir] ⛔ 未配 DSH_AI1NET_OVERLAY_DIR_KEY ⇒ 目录端点返回 503（**不发未签名目录**）')
    return undefined
  }
  let pem: string
  try {
    pem = readFileSync(config.overlayDirKeyFile, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`[overlay-dir] ⛔ 读不到签名私钥 ${config.overlayDirKeyFile}（${msg}）⇒ 503`)
    return undefined
  }
  // `relays[]` 优先用**显式配置的中继入口**，其次用种子（种子本身就是中继入口 ⇒ 语义自洽）。
  const candidates = config.relayUrl !== '' ? [config.relayUrl, ...config.overlayBootstrapSeeds] : [...config.overlayBootstrapSeeds]
  const relays = publicRelayEntries(candidates)
  const bootstrap = publicRelayEntries(config.overlayBootstrapSeeds)
  try {
    const doc = buildDirectoryDocument({
      relays,
      bootstrap,
      network: config.overlayNetworkId,
      now: Date.now(),
    })
    return { doc, sig: signDirectory(doc, pem) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`[overlay-dir] ⛔ 目录组装/签发失败（${msg}）⇒ 503`)
    return undefined
  }
}

export const overlayRoutes: FastifyPluginAsync = async (app) => {
  app.get(DIRECTORY_PATH, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    const built = buildSignedDirectory(app.config)
    if (built === undefined) return reply.code(503).send({ error: 'directory-unavailable' })
    return { ...built.doc, sig: built.sig }
  })
}
