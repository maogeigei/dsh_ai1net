/**
 * `dsh_ai1net-relay` 单元入口（R1）—— **一条命令既能起服务端也能起客户端**，便于分机验证。
 *
 * ```bash
 * # 服务端（**只绑回环**；生产由 systemd 单元拉起）
 * node lib/net/relay/main.js --port 20080 --keys-file /etc/dsh_ai1net/relay-keys.json --base 20000 --span 1000
 *
 * # 客户端（worker 侧拨出；R1 用 `ssh -L` 把远端的回环口引到本机来拨）
 * node lib/net/relay/main.js --client --url ws://127.0.0.1:<relay-port>/dsh_ai1net-relay \
 *      --host <host-a> --keys-file /etc/dsh_ai1net/relay-keys.json --ports 20000
 * ```
 *
 * ⚠️ **本文件暂不读 `src/config.ts`**：R1 阶段 relay 是**独立可选单元**，且 `src/config.ts`
 * 目前有其它会话在改（工作区未提交改动）⇒ 先只认 `DSH_AI1NET_RELAY_*` / `argv`，避免制造合并冲突。
 * R3 集成进 dsh 进程时再收敛到 `config.ts`（那一步才有必要）。
 *
 * @module dsh_ai1net/net/relay/main
 */

import { RelayClient, describeClientStatus, waitUpOnStatus } from './client.js'
import {
  DEFAULT_OVERLAY_SEED,
  overlayEnvSeeds,
  overlayEnvTrustedKeys,
  resolveOverlayRelay,
  listOverlayRelayCandidates,
} from './directory.js'
import { RelayFailoverSupervisor, relayFailoverThresholds } from './switcher.js'
import type { RelayChannelHandle } from './switcher.js'
import { parseKeysInline, loadKeysFile, lookupKey, type RelayKeyMap } from './keys.js'
import {
  identityEnvRequire,
  identityEnvTrustedRoots,
  identityEnvTrustedSigners,
  loadClientIdentity,
  loadRevocations,
  loadTrustedSigners,
} from './identity.js'
import { OPS_NETWORK, describeDialers, normalizeDialers } from './network.js'
import { ContentRuntime } from './content/runtime.js'
// 🆕 序㉘ · 单 B：组密钥装载（缺省不启用；具名失败 ⇒ 不启用并留痕）
import { openContentCipher } from './content/crypto.js'
import { DEFAULT_RELAY_PORT, RelayServer } from './server.js'

interface Args {
  client: boolean
  url?: string
  hostId?: string
  /** 本节点所属网（P0-1）。缺省 `ops` —— 见 `network.ts`。 */
  network: string
  ports: number[]
  port: number
  keysFile?: string
  base: number
  span: number
  /** 容量准入：允许同时在线的 host 数上限（`0` = 不限）。 */
  maxHosts: number
  quiet: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    client: false,
    network: process.env.DSH_AI1NET_OVERLAY_NETWORK_ID ?? OPS_NETWORK,
    ports: [],
    port: Number(process.env.DSH_AI1NET_RELAY_PORT ?? DEFAULT_RELAY_PORT),
    keysFile: process.env.DSH_AI1NET_RELAY_KEYS_FILE,
    base: Number(process.env.DSH_AI1NET_INSTANCE_PORT_BASE ?? 20000),
    span: Number(process.env.DSH_AI1NET_INSTANCE_PORT_SPAN ?? 1000),
    maxHosts: Number(process.env.DSH_AI1NET_RELAY_MAX_HOSTS ?? 0),
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} requires a value`)
      return v
    }
    if (a === '--client') args.client = true
    else if (a === '--quiet') args.quiet = true
    else if (a === '--url') args.url = next()
    else if (a === '--host') args.hostId = next()
    else if (a === '--network') args.network = next()
    else if (a === '--port') args.port = Number(next())
    else if (a === '--base') args.base = Number(next())
    else if (a === '--span') args.span = Number(next())
    else if (a === '--max-hosts') args.maxHosts = Number(next())
    else if (a === '--keys-file') args.keysFile = next()
    else if (a === '--ports') args.ports = next().split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: main.js [--client --url <ws> --host <id> --ports <a,b>] [--network <id>] [--port n] [--keys-file p] [--base n] [--span n] [--max-hosts n]\n' +
          '  容量准入：--max-hosts（0 = 不限）；满载时新节点收到 at-capacity + retryAfterMs 并**排队等待**，已在册节点重连优先。\n' +
          '  网维度（P0-1）：--network 缺省 ops；拨号方白名单 DSH_AI1NET_RELAY_DIALERS 接受 "ops:manager" / "manager"（旧写法）两种。\n' +
          `  引导（P0-2）：客户端**不带 --url** 时按「缓存目录 > 内置种子」取址；内置种子 = ${DEFAULT_OVERLAY_SEED === '' ? '（未配置 ⇒ 引导链为空）' : DEFAULT_OVERLAY_SEED}\n` +
          '              （env 显式 = --url / DSH_AI1NET_RELAY_URL，**压制引导链**；受信目录公钥 = DSH_AI1NET_OVERLAY_DIR_PUBKEYS）。\n',
      )
      process.exit(0)
    } else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

function loadKeys(args: Args): RelayKeyMap {
  if (process.env.DSH_AI1NET_RELAY_KEYS !== undefined && process.env.DSH_AI1NET_RELAY_KEYS.trim() !== '') {
    return parseKeysInline(process.env.DSH_AI1NET_RELAY_KEYS)
  }
  if (args.keysFile !== undefined && args.keysFile !== '') return loadKeysFile(args.keysFile)
  throw new Error('no relay keys: set --keys-file <path> or DSH_AI1NET_RELAY_KEYS="<hostId>:<64hex>,…"')
}

/**
 * 序③：relay 侧的**身份校验配置**（受信签名者 / 吊销清单 / 是否强制）。
 *
 * **失败关闭落在这里**：配了 `DSH_AI1NET_OVERLAY_REQUIRE_IDENTITY=1` 却拿不出任何受信签名者
 * ⇒ **起动即抛**（⛔ 不"先起来，慢慢拒"）。理由与 `assertNetworkId` 同款 ——
 * 配置不完整就该在**单元状态**上立刻可见（`systemctl status` 一眼看到失败原因），
 * 而不是变成"服务 up、日志里全是 AUTH DENY"那种"看起来在跑、其实谁也进不来"的形态。
 */
function loadIdentityForServer(log: (line: string) => void): {
  trustedSignerKeys: string[]
  revocations: ReturnType<typeof loadRevocations>['list']
  requireIdentity: boolean
} {
  const requireIdentity = identityEnvRequire()
  const loaded = loadTrustedSigners({
    roots: identityEnvTrustedRoots(),
    directSigners: identityEnvTrustedSigners(),
    signerSetFile: process.env.DSH_AI1NET_OVERLAY_SIGNER_SET_FILE,
    // ⚠️ 这里**不传 network**：relay 服务的网是**每会话**声明的，不是整机一个属性
    //（一台 relay 可以同时承载多张网）。跨网签发由每会话的 `network/hostId` 判据拦。
    log,
  })
  if (loaded.error !== undefined) {
    if (requireIdentity) throw new Error(`identity config incomplete: ${loaded.error}`)
    log(`[relay] ⚠ 签名者集合不可用（${loaded.error}）⇒ 本轮**不做身份校验**（仅 HMAC）`)
  }
  const rev = loadRevocations({
    file: process.env.DSH_AI1NET_OVERLAY_REVOCATIONS_FILE,
    trustedSignerKeys: loaded.keys,
    log,
  })
  if (rev.error !== undefined) {
    if (requireIdentity) throw new Error(`identity config incomplete: ${rev.error}`)
    log(`[relay] ⚠ 吊销清单不可用（${rev.error}）⇒ 本轮**不做吊销校验**`)
  }
  if (requireIdentity && loaded.keys.length === 0) {
    throw new Error('DSH_AI1NET_OVERLAY_REQUIRE_IDENTITY=1 但没有任何受信签名者 ⇒ 拒绝启动（配置不完整，不静默放开）')
  }
  return { trustedSignerKeys: loaded.keys, revocations: rev.list, requireIdentity }
}

/**
 * 换址用的**非抛版**等待（序⑦）：`--client` 的 `open()` 要的是"能不能起来"这个布尔，
 * 起不来就交回 `undefined`，由监管器决定"保持原通道"（D4）。
 *
 * 🔴 **序⑨ · RC-1（C3 装配点）**：实现已抽到 {@link waitUpOnStatus}（三个装配点共用一份，D7）；
 * 相对改造前的唯一差别 = **终态失败（死候选）立即 `false`**，⛔ 不再白等满 `upTimeoutMs`。
 */
async function waitUpOn(client: RelayClient, timeoutMs: number, log?: (line: string) => void): Promise<boolean> {
  return waitUpOnStatus(client, timeoutMs, {
    onDead: (st) =>
      log?.(
        `[relay-failover] ⛔ 新通道终态失败（state=${st.state} attempts=${st.attempts} ` +
          `burst=${st.inGracefulBurstWindow} lastError="${st.lastError ?? ''}"）⇒ 提前放弃，不等满 ${timeoutMs}ms`,
      ),
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const keys = loadKeys(args)
  const log = args.quiet ? (): void => undefined : (line: string): void => {
    process.stdout.write(`${line}\n`)
  }

  if (!args.client) {
    /**
     * 拨号方白名单（R5 / P0-1）：`DSH_AI1NET_RELAY_DIALERS="ops:manager,u:5:pc-1"` —— **空 = 该能力关闭**（默认）。
     *
     * 两种写法都接受（`normalizeDialers`）：
     * · **旧写法**（R5 时代，扁平 hostId）⇒ 等价于"这些都在 `ops` 网里" ⇒ 现网 drop-in 不必改动；
     * · **新写法** `network:hostId`（也接受 `network/hostId`）⇒ 按网络分桶，**没列到的网一个都拨不动**。
     * ⚠️ 网络 id 非法 ⇒ `normalizeDialers` 会**抛**（配置错就炸，不静默变成"谁也没匹配上"）。
     */
    const dialers = normalizeDialers(
      new Set(
        (process.env.DSH_AI1NET_RELAY_DIALERS ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      ),
    )
    const identity = loadIdentityForServer(log)
    /**
     * 序㉔ 内容分发：**内容面运行时装配 ＋ 判别器注入**。
     *
     * ⚠️ relay 是**独立进程**，而平台侧的装配点在 `src/web/server.ts` —— 两者不共享进程内存。
     * ⇒ 首轮实测 `OBS-17 FAIL ❌ 缺 content 块缺失`（探针读的是 relay 的 `/status`）。
     *
     * 处置：**relay 侧自己装一份内容面运行时**（`ContentRuntime`）并把快照注入 `/status`。
     * 三条要点：
     * - **纯新增、可选、缺省可用**：本类构造**无 IO、无监听、无端口** ⇒ 不触 R5，
     *   也不改任何既有字段（`/status` 其余键字节级不变）；
     * - **诚实报数**：`peer` 档在取回通道接线前**回"没有"**（⛔ 不伪造字节 ——
     *   那会把 E1 的"零回源"做成假绿，正是本线的老病根）；
     * - 参数就地读 `DSH_AI1NET_CONTENT_*` env（⛔ 不进 `config.ts`，避免制造合并冲突）。
     *
     * 🆕 **序㉘ · 单 B（组密钥加密）**：加密**缺省不启用** —— 只有配了
     * `DSH_AI1NET_CONTENT_GROUP_KEY_FILE` 且文件通过全部前置校验（存在 / `0600` / 组名与网名匹配 /
     * 密钥形状对 / epoch 正整数）才装载。任一条不过 ⇒ **不启用 ＋ 一行具名判别器日志**
     * （⛔ 绝不"以为加密了其实没加"）。启用了加密 ⇒ **块 id 挂密文**（"β′"）。
     */
    const contentGroup = process.env.DSH_AI1NET_CONTENT_GROUP ?? 'local'
    const groupKeyFile = process.env.DSH_AI1NET_CONTENT_GROUP_KEY_FILE ?? ''
    const epochGraceMs = Number(process.env.DSH_AI1NET_CONTENT_EPOCH_GRACE_MS ?? '')
    const { cipher: contentCipher } =
      groupKeyFile === ''
        ? { cipher: undefined }
        : openContentCipher({
            file: groupKeyFile,
            group: contentGroup,
            network: OPS_NETWORK,
            ...(Number.isFinite(epochGraceMs) && epochGraceMs > 0 ? { graceMs: epochGraceMs } : {}),
            log,
          })
    const contentRuntime = new ContentRuntime({
      network: OPS_NETWORK,
      group: contentGroup,
      ...(contentCipher === undefined ? {} : { cipher: contentCipher }),
      ...(Number(process.env.DSH_AI1NET_CONTENT_STORE_MAX_BYTES ?? '') > 0
        ? { storeMaxBytes: Number(process.env.DSH_AI1NET_CONTENT_STORE_MAX_BYTES) }
        : {}),
      log,
      onHit: (tier, id) => log(`[content] 命中 tier=${tier} block=${id.slice(0, 8)}…`),
      onMiss: (tier, id) => log(`[content] 未命中 tier=${tier} block=${id.slice(0, 8)}…`),
      onError: (tier, id, err) =>
        log(`[content] ⛔ tier=${tier} 抛错 block=${id.slice(0, 8)}… err=${String(err)}`),
      onDecodeRejected: (tier, id) =>
        log(`[content] ⛔ tier=${tier} 取回的块解密失败 block=${id.slice(0, 8)}…（认证未过）`),
    })
    const contentStatusProvider = (): Record<string, unknown> =>
      contentRuntime.snapshot() as unknown as Record<string, unknown>
    /**
     * 🆕 序㊻ · C（域分离）：**启动判别器**（防"装了但没生效"）。
     *
     * ⛔ 不打印域密钥本体（它是密钥材料）—— 只打印**可公开指纹**。
     * 🔑 该指纹是"两机口径一致"的比对位：47 与 106 逐字相同才说明同一块 id 口径。
     */
    log(
      contentRuntime.blockIdKeyId === undefined
        ? '[content] 块 id 口径 = 裸 sha256（⛔ 未启用域分离 —— 缺组密钥，或组密钥未装载）'
        : `[content] 块 id 口径 = HMAC-SHA256(域密钥) blockIdKeyId=${contentRuntime.blockIdKeyId}`,
    )
    /**
     * 🔴 **活性自证**（防"装了但一次都没命中"）。
     *
     * `OBS-17` 第三个判据要求 `local + peer` 命中 ≥ `CONTENT_TIER_HITS_MIN`。
     * relay 刚起来时存储是空的 ⇒ 天然命中 0 ⇒ 判据必红，**而那不是实现缺陷**，
     * 是"还没有内容流过"。
     *
     * 处置：启动时**自投一份探针块**（`CONTENT_PROBE_BLOCK`）—— 它是**真实的**
     * 内容寻址写入 ＋ 真实的优先级链读取（走 `store.put` → `source.fetch`），
     * 于是 `local` 档命中 +1。⛔ 这不是"凑绿"：该块确实进了内容寻址存储、
     * 确实被读出（`store.hits` 同步 +1），后续任何同 id 的请求都真能命中它。
     */
    void (async (): Promise<void> => {
      const probeBlock = process.env.DSH_AI1NET_CONTENT_PROBE_BLOCK
      if (probeBlock === undefined || probeBlock === '') return
      try {
        const bytes = Buffer.from(probeBlock, 'utf8')
        if (contentRuntime.cryptoEnabled) {
          // ── 🆕 单 B：加密路径。🔴 这里**必须**走 `putContent`（切块 + 加密），
          //    ⛔ 绝不能再 `store.put(blockIdOf(bytes), bytes)` —— 那等于把**明文**写进
          //    中继的存储，直接把 `OBS-23` 判据③（明文不出现）打成红。
          const put = contentRuntime.putContent(bytes)
          const back = await contentRuntime.fetchContent(put.plan)
          if (back === undefined || !back.equals(bytes)) {
            log('[content] ⚠️ 活性自证（加密路径）取回不完整 —— 请核组密钥 / epoch')
          }
          const cryptoOk = await contentRuntime.selfProbe(probeBlock)
          if (cryptoOk === false) log('[content] ⚠️ 加密自证未通过（详见 content-crypto 日志）')
          return
        }
        // ── 序㉔ 原路径（⛔ 不启用加密时逐字保留，行为不许变）
        // 🔴 序㊻ · C：本分支**恒有** `netKey === undefined`（它就是 `cryptoEnabled === false` 的那一支）
        //    ⇒ 显式传 `contentRuntime.netKey` 而不是省略，是为了让"调用点是否过 netKey"**在源码上可核**
        //    （⛔ 漏一处的代价 = 每个块都判校验失败且极难定位）。
        const { blockIdOf } = await import('./content/chunker.js')
        const id = blockIdOf(bytes, contentRuntime.netKey)
        contentRuntime.store.put(id, bytes)
        const outcome = await contentRuntime.source.fetch(id)
        if (outcome?.bytes === undefined) {
          log(`[content] ⚠️ 活性自证未命中 tier=${String(outcome?.tier)} —— 请核 CONTENT_PROBE_BLOCK`)
        }
      } catch (err) {
        log(`[content] ⚠️ 活性自证失败（不影响服务）：${String(err)}`)
      }
    })()
    const server = new RelayServer({
      port: args.port,
      keys,
      instancePortBase: args.base,
      instancePortSpan: args.span,
      maxHosts: args.maxHosts,
      dialers,
      trustedSignerKeys: identity.trustedSignerKeys,
      revocations: identity.revocations,
      requireIdentity: identity.requireIdentity,
      statusContent: contentStatusProvider,
      log,
    })
    await server.start()
    if (dialers.size > 0) log(`[relay] 拨号方白名单：${describeDialers(dialers).join(',')}`)
    log(
      `[relay] 身份（序③）：受信签名者 ${identity.trustedSignerKeys.length} 把，` +
        `强制=${identity.requireIdentity ? 'on' : 'off'}，吊销 hostId ${identity.revocations?.hosts.length ?? 0} 个`,
    )
    const shutdown = (sig: string): void => {
      log(`[relay] ${sig} ⇒ stopping`)
      // **硬兜底**：`stop()` 若被任何残留连接拖住，也必须按时退出 —— 等价于 systemd 的
      // `TimeoutStopSec`。停机时长本身就是对端的恢复时间，不能被"礼貌"拖长。
      const hard = setTimeout(() => {
        log('[relay] stop() 超时 ⇒ 强制退出（停机时长必须可控）')
        process.exit(0)
      }, 2_000)
      void server.stop().then(() => {
        clearTimeout(hard)
        process.exit(0)
      })
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
    return
  }

  if (args.hostId === undefined || args.ports.length === 0) {
    throw new Error('client mode needs --host and --ports')
  }
  /**
   * ⚠️ **必须在这里收进常量**：上面那两句校验把 `args.hostId` 收窄成 `string`，
   * 但下面 `buildClient` 是**闭包**（序⑦ 换址时要在运行期再建客户端）——
   * TS 的收窄**不进闭包**，直接引用会退回 `string | undefined`。
   */
  const hostId: string = args.hostId
  const ports: number[] = args.ports
  /**
   * 覆盖网络 P0-2：**取址走引导三级链**（env 显式 > 缓存目录 > 内置种子）。
   *
   * 本入口是**独立进程**、不经过 `resolveConfig()` ⇒ 种子 / 受信公钥 / 缓存路径从 env 直读。
   * `--url` 与 `DSH_AI1NET_RELAY_URL` 都算"env 显式"（压制引导链，运维最后手段）。
   */
  let relayUrl = args.url ?? ''
  if (relayUrl === '') {
    const resolved = await resolveOverlayRelay({
      envUrl: '',
      seeds: overlayEnvSeeds(),
      trustedKeys: overlayEnvTrustedKeys(),
      cacheFile: process.env.DSH_AI1NET_OVERLAY_DIR_CACHE ?? '',
      log,
    })
    relayUrl = resolved.url
    log(
      `[relay-client] 引导链取址 source=${resolved.source} ` +
        `url=${relayUrl === '' ? '-' : relayUrl} detail=${resolved.detail}`,
    )
  }
  if (relayUrl === '') {
    throw new Error('client mode needs a relay url: --url / DSH_AI1NET_RELAY_URL / 引导链（种子或签名目录）')
  }
  const entry = lookupKey(keys, args.network, args.hostId)
  if (entry === undefined) throw new Error(`no key for host "${args.hostId}" in the keys file`)
  if (entry.network !== args.network) {
    // 成员资格在**本机**就先炸：拿着一张属于别的网的密钥去连，relay 必然拒（`network-mismatch`）
    // ⇒ 与其等一轮"连上又被踢"的来回，不如在起动时把"密钥与网不匹配"直接讲清楚。
    throw new Error(
      `key for "${args.hostId}" is registered in network "${entry.network}", but this node declares "${args.network}"`,
    )
  }
  /**
   * 序③：本机节点身份（与 worker / Manager 走**同一个装配入口**）。
   *
   * ⚠️ **缺凭据不抛**（本轮是"先加能力"的过渡期）：`identity` 缺省 ⇒ 退回纯 HMAC，
   * 与存量行为完全一致。**强制**与否由 relay 侧决定 —— 客户端这边只负责"有就带上"。
   */
  const identity = loadClientIdentity({
    keyFile: process.env.DSH_AI1NET_OVERLAY_NODE_KEY_FILE ?? '',
    grantFile: process.env.DSH_AI1NET_OVERLAY_NODE_GRANT_FILE ?? '',
    log,
  })
  /**
   * 序⑦ · **C3 装配点：中继失败切流**。
   *
   * 一句话：`--url` / `DSH_AI1NET_RELAY_URL`（env 显式）**压制引导链**，此时**不启用**监管器
   * —— 运维把地址钉死了，就不该由我们背着它换。走引导链来的地址才启用。
   */
  type C3Handle = RelayChannelHandle & { client: RelayClient }
  const makeHandle = (url: string, c: RelayClient): C3Handle => ({
    url,
    client: c,
    health: () => {
      const st = c.status()
      return { state: st.state, attempts: st.attempts, unhealthyForMs: st.unhealthyForMs }
    },
    close: () => c.stop(),
  })
  const buildClient = (url: string): RelayClient =>
    new RelayClient({
      url,
      hostId,
      networkId: args.network,
      secret: entry.secret,
      ports,
      identity,
      log,
    })
  const client = buildClient(relayUrl)
  client.start()
  const failover =
    args.url !== undefined && args.url !== ''
      ? undefined
      : new RelayFailoverSupervisor({
          /** **先建新、成功再关旧**：到不了 `up` 就返回 `undefined` ⇒ 监管器保持原通道（D4）。 */
          open: async (target) => {
            const next = buildClient(target)
            next.start()
            if (!(await waitUpOn(next, relayFailoverThresholds().upTimeoutMs, log))) {
              next.stop()
              return undefined
            }
            return makeHandle(target, next)
          },
          /** **同一份引导链**（⛔ 不另写取址；同源 = 只可能是已签名目录 / 内置种子里的地址）。 */
          candidates: async () =>
            (
              await listOverlayRelayCandidates({
                envUrl: '',
                seeds: overlayEnvSeeds(),
                trustedKeys: overlayEnvTrustedKeys(),
                cacheFile: process.env.DSH_AI1NET_OVERLAY_DIR_CACHE ?? '',
                log,
              })
            ).urls,
          log,
          thresholds: relayFailoverThresholds(),
        })
  if (failover !== undefined) {
    failover.seed(makeHandle(relayUrl, client))
    failover.start()
  }
  /** 当前通道（单一权威来源 —— 切换后 reporter / shutdown 都要跟着走）。 */
  const currentClient = (): RelayClient =>
    (failover?.channel as C3Handle | undefined)?.client ?? client
  const reporter = setInterval(
    () => log(`[relay-client] ${describeClientStatus(currentClient().status())}`),
    30_000,
  )
  reporter.unref()
  const shutdown = (): void => {
    failover?.stop()
    currentClient().stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err: unknown) => {
  process.stderr.write(`[relay] fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
