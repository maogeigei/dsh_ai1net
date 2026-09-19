#!/usr/bin/env node
/**
 * Standalone orchestrator entry (`dsh_ai1net` bin).
 *
 * Subcommands:
 *   dsh_ai1net bootstrap-admin --username <u> --password <p>
 *   dsh_ai1net [server flags]
 * @module dsh_ai1net/cli
 */

import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { resolveConfig, type ConfigOverrides } from './config.js'
import { createDbAdapter } from './db/index.js'
import { createUserFs } from './fs/provider.js'
import { homeRoot, userRoot } from './fs/workspace.js'
import { hashPassword } from './web/auth.js'
import { hashUid } from './isolation.js'
import { buildServer } from './web/server.js'

const HELP = `dsh_ai1net — DSH server login orchestrator

Usage:
  dsh_ai1net [options]                      start the server
  dsh_ai1net bootstrap-admin [options]      create the first admin
  dsh_ai1net worker [options]               worker agent（cluster 模式：承载本机实例）
  dsh_ai1net doctor [--json]                单机自检（环境/隔离/存储/DB；非 0 退出 = 有硬失败）
  dsh_ai1net cluster status [--json]        全集群一屏（worker 目录 + 归属 + 过期租约）

Server options:
  --port <n>        Bind port (0 = ephemeral). Default 3080.
  --host <h>        Bind host. Default 127.0.0.1.
  --db <path>       SQLite database path.
  --data-root <p>   Root for per-user homes + workspaces.
  --dsh-bin <cmd>   Command used to launch a child DSH. Default "dsh".
  --log-level <l>   Pino log level. Default "info".
  --secure-cookies  Set the Secure flag on session cookies (behind HTTPS).
  --session-ttl <s> Session lifetime in seconds. Default 604800 (7 days).
  --isolation-mode <m> Isolation tier: "soft" or "account" (Linux, needs root). Default "soft".
  -h, --help        Show this help.

bootstrap-admin options:
  --username <u>    Admin username (required).
  --password <p>    Admin password (or DSH_AI1NET_ADMIN_PASSWORD env).
  --db <path>       Database path.
  --data-root <p>   Root for per-user homes.
`

interface ParsedValues {
  [key: string]: string | boolean | undefined
}

function toOverrides(values: ParsedValues): ConfigOverrides {
  const str = (value: string | boolean | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined
  const dshBin = str(values['dsh-bin'])
  return {
    port: str(values.port),
    host: str(values.host),
    dbPath: str(values.db),
    dataRoot: str(values['data-root']),
    dshCommand: dshBin ? [dshBin] : undefined,
    logLevel: str(values['log-level']),
    secureCookies: values['secure-cookies'] === true ? true : undefined,
    sessionTtlSeconds: str(values['session-ttl']),
    maxUploadBytes: str(values['max-upload']),
    isolationMode: str(values['isolation-mode']),
  }
}

/**
 * `dsh_ai1net doctor`：**单机自检**（T08 S7；设计 §15.5）。
 *
 * 把"装机/排障要逐条手查"的东西固化成一条命令：环境 → 隔离能力 → 存储 → DB。
 * **退出码非 0 = 有硬失败**（可直接用于 join 脚本的门禁）；warn 不影响退出码。
 */
async function doctorCmd(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } })
  const { execFileSync } = await import('node:child_process')
  const { statfsSync, accessSync, constants } = await import('node:fs')
  const config = resolveConfig({})
  const lines: Array<{ level: 'ok' | 'warn' | 'fail'; item: string; detail: string }> = []
  const add = (level: 'ok' | 'warn' | 'fail', item: string, detail: string): void => {
    lines.push({ level, item, detail })
  }

  // ── 环境 ───────────────────────────────────────────────────────────────
  add('ok', 'node', process.version)
  let cgroup = 'unknown'
  try {
    cgroup = statfsSync('/sys/fs/cgroup').type === 0x63677270 ? 'v2' : 'v1'
  } catch {
    cgroup = 'unknown'
  }
  add(cgroup === 'unknown' ? 'warn' : 'ok', 'cgroup', cgroup)
  let swap = ''
  try {
    // ⚠️ /proc/swaps 第一行是表头 ⇒ 要 NR>1，否则会把 "Filename" 当成设备名打出来
    swap = execFileSync('/usr/bin/awk', ['NR>1 && NF>0 {print $1}', '/proc/swaps'], { encoding: 'utf8' })
      .trim()
      .replace(/\n+/g, ' ')
  } catch {
    swap = ''
  }
  add(swap === '' ? 'ok' : 'warn', 'swap', swap === '' ? '未启用' : `已启用（${swap}）—— 实例超限会先换出而非被 OOM kill`)
  for (const bin of ['bwrap', 'setpriv', 'systemd-run', 'nft', 'dsh']) {
    const found = execFileSync('/usr/bin/which', [bin], { encoding: 'utf8' }).trim()
    add(found === '' ? 'fail' : 'ok', bin, found === '' ? '缺失' : found)
  }
  let bwrapVersion = ''
  try {
    bwrapVersion = execFileSync('bwrap', ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    bwrapVersion = ''
  }
  const minor = /bubblewrap (\d+)\.(\d+)/.exec(bwrapVersion)
  if (minor !== null && Number(minor[2]) < 5) {
    add('warn', 'bwrap 版本', `${bwrapVersion} —— **低于 0.5：不支持 --perms**（要改挂载点权限只能用 --tmpfs）`)
  } else if (bwrapVersion !== '') {
    add('ok', 'bwrap 版本', bwrapVersion)
  }

  // ── 隔离前提 ───────────────────────────────────────────────────────────
  try {
    const uid = execFileSync('setpriv', ['--reuid', '100001', '--regid', '100001', '--clear-groups', '--', 'id', '-u'], {
      encoding: 'utf8',
    }).trim()
    add('ok', 'setpriv 降权', `可用（uid=${uid}）`)
  } catch {
    add('fail', 'setpriv 降权', '失败（需要 root 或 CAP_SETUID）')
  }

  // ── 存储 ───────────────────────────────────────────────────────────────
  try {
    accessSync(config.dataRoot, constants.W_OK)
    add('ok', 'dataRoot 可写', config.dataRoot)
  } catch {
    add('fail', 'dataRoot 可写', `${config.dataRoot} 不可写`)
  }

  // ── DB ─────────────────────────────────────────────────────────────────
  try {
    const { createDbAdapter } = await import('./db/index.js')
    const db = await createDbAdapter(config)
    const hosts = await db.listDshHosts()
    await db.close()
    add('ok', 'DB', `${config.dbUrl === undefined ? `sqlite ${config.dbPath}` : 'postgres'}（dsh_hosts ${hosts.length} 条）`)
  } catch (err) {
    add('fail', 'DB', err instanceof Error ? err.message : String(err))
  }

  const failures = lines.filter((l) => l.level === 'fail').length
  if (values.json === true) {
    process.stdout.write(JSON.stringify({ ok: failures === 0, checks: lines }, null, 2) + '\n')
  } else {
    for (const l of lines) {
      const mark = l.level === 'ok' ? '✓' : l.level === 'warn' ? '!' : '✗'
      process.stdout.write(`${mark} ${l.item.padEnd(16)} ${l.detail}\n`)
    }
    process.stdout.write(`\n${failures === 0 ? 'OK：无硬失败' : `${failures} 项硬失败`}\n`)
  }
  if (failures > 0) process.exit(2)
}

/**
 * `dsh_ai1net cluster status`：**全集群一屏**（T08 S7；设计 §15.5）。
 * 读的是**控制面 DB**（Manager 侧运行），输出 worker 目录 + 实例归属 + 过期租约。
 */
async function clusterStatusCmd(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } })
  const config = resolveConfig({})
  const { createDbAdapter } = await import('./db/index.js')
  const db = await createDbAdapter(config)
  try {
    const [hosts, expired] = await Promise.all([
      db.listDshHosts(),
      db.listExpiredInstanceLeases(Date.now()),
    ])
    const byHost = new Map<string, number>()
    for (const h of hosts) byHost.set(h.id, (await db.listInstancesByHost(h.id)).length)
    if (values.json === true) {
      process.stdout.write(JSON.stringify({ deployMode: config.deployMode, hosts, expired }, null, 2) + '\n')
      return
    }
    process.stdout.write(`deployMode=${config.deployMode}  db=${config.dbUrl === undefined ? config.dbPath : 'postgres'}\n\n`)
    process.stdout.write('WORKER                     状态     容量(MB)   已用   实例  最后心跳\n')
    for (const h of hosts) {
      const hb = h.lastHeartbeat === null ? '从未' : new Date(h.lastHeartbeat).toISOString().replace('T', ' ').slice(0, 19)
      process.stdout.write(
        `${h.id.padEnd(26)} ${h.status.padEnd(8)} ${String(h.capacityMb).padStart(8)} ${String(h.usedMb).padStart(6)} ` +
          `${String(byHost.get(h.id) ?? 0).padStart(6)}  ${hb}\n`,
      )
    }
    process.stdout.write(`\n租约已过期（需人工确认后才可接管，见 R9）：${expired.length} 个\n`)
    for (const inst of expired) {
      process.stdout.write(`  ${inst.userId}  host=${inst.hostId ?? '-'}  epoch=${inst.epoch}  过期于 ${new Date(inst.leaseUntil).toISOString()}\n`)
    }
  } finally {
    await db.close()
  }
}

async function bootstrapAdmin(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      username: { type: 'string' },
      password: { type: 'string' },
      db: { type: 'string' },
      'data-root': { type: 'string' },
    },
  })
  const username = values.username
  const password = values.password ?? process.env.DSH_AI1NET_ADMIN_PASSWORD
  if (username === undefined || username === '' || password === undefined || password === '') {
    console.error('usage: dsh_ai1net bootstrap-admin --username <u> --password <p>')
    process.exit(2)
  }
  const config = resolveConfig({ dbPath: values.db, dataRoot: values['data-root'] })
  const db = await createDbAdapter(config)
  if ((await db.countAdmins()) > 0) {
    console.error('an admin already exists; refusing to create a second one')
    await db.close()
    process.exit(1)
  }
  const id = randomUUID()
  const homeDir = homeRoot(userRoot(config.dataRoot, id))
  const passHash = await hashPassword(password)
  // Create the user before initUserRoot so the per-user uid (baseUid + row_id)
  // is already assigned — same reason as the register route.
  const user = await db.createUser({ id, username, passHash, role: 'admin', homeDir })
  await createUserFs(config).initUserRoot(id, user.uid ?? undefined)
  await db.close()
  console.log(`admin "${username}" created (id: ${id})`)
}

async function runServer(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      db: { type: 'string' },
      'data-root': { type: 'string' },
      'dsh-bin': { type: 'string' },
      'log-level': { type: 'string' },
      'secure-cookies': { type: 'boolean' },
      'session-ttl': { type: 'string' },
      'max-upload': { type: 'string' },
      'isolation-mode': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) {
    process.stdout.write(HELP)
    return
  }

  const config = resolveConfig(toOverrides(values as ParsedValues))
  const app = await buildServer(config)
  await app.listen({ host: config.host, port: config.port })

  const address = app.server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.port
  app.log.info(`dsh_ai1net listening on http://${config.host}:${actualPort}`)
  app.log.info(`data root: ${config.dataRoot}; db: ${config.dbPath}`)

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`received ${signal}, shutting down`)
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/**
 * 运行 **worker agent**（T08 S3；设计 §11.2）。
 *
 * 它是 Worker 上唯一的"被拨入口"：把本机的实例生命周期（launch/stop/status/endpoint/fence）
 * 暴露给 Manager。**不连控制面 DB** —— 凭据（apiKey）与 uid 由 Manager 在 launch 时投递，
 * 只存内存（与 k8s 用 per-user Secret 同一思路）。**不是"不许有数据库"**：插件业务数据在
 * 实例 home 里、由实例自己读写（设计 §1.3 数据分层）。
 */
async function runWorker(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'host-id': { type: 'string' },
      token: { type: 'string' },
      'instance-host': { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help === true) {
    process.stdout.write(
      'usage: dsh_ai1net worker --token <secret> [--port 9000] [--host 0.0.0.0]\n' +
        '                   [--host-id <id>] [--instance-host <addr>]\n' +
        '  密钥也可用 DSH_AI1NET_CLUSTER_AGENT_TOKEN；host-id 默认取主机名。\n',
    )
    return
  }
  const token =
    (typeof values.token === 'string' ? values.token : undefined) ?? process.env.DSH_AI1NET_CLUSTER_AGENT_TOKEN
  if (token === undefined || token === '') {
    console.error('worker requires --token or DSH_AI1NET_CLUSTER_AGENT_TOKEN')
    process.exit(2)
  }
  const config = resolveConfig({
    logLevel: typeof values['log-level'] === 'string' ? values['log-level'] : undefined,
    clusterHostId: typeof values['host-id'] === 'string' ? values['host-id'] : undefined,
    clusterInstanceHost: typeof values['instance-host'] === 'string' ? values['instance-host'] : undefined,
  })
  const { buildWorkerAgent } = await import('./worker/agent.js')
  const host = typeof values.host === 'string' ? values.host : '0.0.0.0'
  const port = Number(typeof values.port === 'string' ? values.port : 9000)
  const agent = buildWorkerAgent(config, {
    hostId: config.clusterHostId,
    token,
    port,
    host,
    instanceHost: config.clusterInstanceHost,
    logLevel: config.logLevel,
  })
  await agent.app.listen({ host, port })
  agent.app.log.info(`worker agent listening on http://${host}:${port} (hostId ${config.clusterHostId})`)

  const shutdown = async (signal: string): Promise<void> => {
    agent.app.log.info(`received ${signal}, shutting down`)
    await agent.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function uidForUserCmd(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { 'base-uid': { type: 'string' }, db: { type: 'string' } },
  })
  const userId = positionals[0]
  if (userId === undefined) {
    console.error('usage: dsh_ai1net uid-for-user <userId> [--db <path>] [--base-uid N]')
    process.exit(2)
  }
  const dbPath = typeof values.db === 'string' ? values.db : undefined
  const baseUid = typeof values['base-uid'] === 'string' ? values['base-uid'] : undefined
  const config = resolveConfig({ dbPath, baseUid })
  const db = await createDbAdapter(config)
  const user = await db.findUserById(userId)
  await db.close()
  console.log(user?.uid ?? hashUid(userId, config.baseUid))
}

async function main(): Promise<void> {
  const [first, ...rest] = process.argv.slice(2)
  if (first === 'bootstrap-admin') {
    await bootstrapAdmin(rest)
    return
  }
  if (first === 'worker') {
    await runWorker(rest)
    return
  }
  if (first === 'doctor') {
    await doctorCmd(rest)
    return
  }
  if (first === 'cluster') {
    if (rest[0] === 'status') {
      await clusterStatusCmd(rest.slice(1))
      return
    }
    process.stderr.write('usage: dsh_ai1net cluster status [--json]\n')
    process.exit(2)
  }
  if (first === 'uid-for-user') {
    await uidForUserCmd(rest)
    return
  }
  await runServer(process.argv.slice(2))
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
