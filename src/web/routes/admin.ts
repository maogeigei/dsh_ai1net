/**
 * Admin routes: list users and approve/disable accounts. All guarded by
 * `requireAdmin`.
 * @module dsh_ai1net/web/routes/admin
 */

import type { FastifyPluginAsync } from 'fastify'
import { execFileSync, spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { requireAdmin } from '../middleware/authn.js'
import { userRoot } from '../../fs/workspace.js'
import { scriptPath, stateDir } from '../../platform-paths.js'

/** 新用户审批通过后自动铺「功能插件」分区的脚本（幂等）。
 * 路径由**安装根**推导（`DSH_INSTALL_DIR` 可覆盖），⛔ 不写死绝对路径。 */
const ENSURE_BIZ_PLUGINS =
  process.env.DSH_ENSURE_BIZ_PLUGINS ?? scriptPath('ensure-biz-plugins.cjs')

/** 「平台共享模型」逐用户授权的入参（只有开关本身）。 */
const sharedModelSchema = {
  body: {
    type: 'object',
    required: ['enabled'],
    additionalProperties: false,
    properties: { enabled: { type: 'boolean' } },
  },
} as const

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // 存储用量面板（读取维护脚本生成的快照文件，避免每次请求都 du）
  app.get('/api/admin/storage', { preHandler: requireAdmin }, async () => {
    const { readFileSync } = await import('node:fs')
    try {
      return JSON.parse(readFileSync(process.env.DSH_STORAGE_REPORT ?? '/var/run/dsh-storage-report.json', 'utf8'))
    } catch {
      return { generatedAt: null, users: [], note: '报告尚未生成（cron 每小时刷新一次）' }
    }
  })

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => ({
    users: await app.db.listPublicUsers(),
  }))

  app.post('/api/admin/users/:id/approve', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'pending') return reply.code(409).send({ error: 'not_pending' })
    await app.db.setUserRole(id, 'active', request.user?.id)
    await app.db.audit(request.user?.id ?? null, 'approve', JSON.stringify({ userId: id }))
    // 审批通过后异步铺「功能插件」分区（普通用户才能在设置里启停插件）。
    // fire-and-forget：不阻塞审批响应；失败由巡检（cron 跑同一脚本）兜底。
    if (ENSURE_BIZ_PLUGINS === '') return { ok: true }
    const prov = spawn(process.execPath, [ENSURE_BIZ_PLUGINS, id], { stdio: "ignore", detached: true })
    prov.on("error", (err) => app.log.warn({ err }, "post-approve 脚本调用失败"))
    prov.unref()
    return { ok: true }
  })

  app.post('/api/admin/users/:id/disable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_disable_admin' })
    await app.db.setUserRole(id, 'disabled', request.user?.id)
    await app.db.deleteUserSessions(id)
    await app.supervisor.stop(id) // 停掉该用户运行中的 DSH（待办.md §二）
    await app.db.audit(request.user?.id ?? null, 'disable', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  app.post('/api/admin/users/:id/enable', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role !== 'disabled') return reply.code(409).send({ error: 'not_disabled' })
    await app.db.setUserRole(id, 'active', request.user?.id)
    await app.db.audit(request.user?.id ?? null, 'enable', JSON.stringify({ userId: id }))
    return { ok: true }
  })

  /**
   * **逐个用户**开启/关闭「平台共享模型」（2026-09-19 用户口径）。
   *
   * 口径原文：「admin 设置的共享模型，需要 admin 在用户列表中开启（新增选项，**默认关闭**），
   * 用户才能在会话中使用（以及在设置的模型设置页面展示）」。
   *
   * 为什么放在 admin 路由而不是复用 `/api/me/models/shared`：那一条写的是**用户偏好**
   * （`shared_model_enabled`，用户自己在设置页开关）；本条的写入目标是**管理员授权**
   * （`shared_model_granted`，默认 0）—— 两列、两个主体，⛔ 不能共用一个写入口，
   * 否则用户点一下就等于给自己授权了（门禁失效）。
   *
   * ⚠️ 落地发生在 **spawn 时**（`server.ts#landModels`）⇒ 改完必须让目标用户的实例重启
   * 才能看到变化。这里直接调 `restartMain(id)`：**只影响这一个用户**；他没在跑就是空操作
   * （下次启动自然按新授权落地）。这与用户自己改条目的行为一致（§四）。
   */
  app.post(
    '/api/admin/users/:id/models/shared',
    { preHandler: requireAdmin, schema: sharedModelSchema },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const { enabled } = request.body as { enabled: boolean }
      const user = await app.db.findUserById(id)
      if (user === undefined) return reply.code(404).send({ error: 'not_found' })
      if (!(await app.db.setSharedModelGranted(id, enabled))) return reply.code(404).send({ error: 'not_found' })
      await app.db.audit(
        request.user?.id ?? null,
        'shared_model_grant',
        JSON.stringify({ userId: id, username: user.username, enabled }),
      )
      // 重启目标实例是**尽力而为**：授权已经落库了，它才是这次操作的真结果。
      // ⚠️ 两种"没重启"都不算失败：① 实例没在跑（`restartMain` 返 undefined）——
      //    下次启动自然按新授权落地；② 归属租约被别的持有者占着（抛 LeaseBusyError）
      //    —— 那不是本次授权的问题，⛔ 不能把它报成"开启失败"（2026-09-19 实测：
      //    报 500 时 admin 界面显示"操作失败"，而库里其实已经改对了）。
      let restarted = false
      try {
        restarted = (await app.supervisor.restartMain(id)) !== undefined
      } catch (err) {
        app.log.warn({ err, userId: id }, '共享模型授权已落库，但重启目标实例失败（下次启动生效）')
      }
      return { ok: true, sharedModelGranted: enabled, restarted }
    },
  )

  // 永久删除用户：admin 不可删；删除 = 停实例 → DB 事务清全部关联行 →
  // 删数据目录（users/<id>/）→ 删 provision 创建的 OS 账号 dsh-<short>。
  app.delete('/api/admin/users/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const user = await app.db.findUserById(id)
    if (user === undefined) return reply.code(404).send({ error: 'not_found' })
    if (user.role === 'admin') return reply.code(409).send({ error: 'cannot_delete_admin' })

    await app.supervisor.stop(id) // 停掉运行中的 DSH，避免进程占用刚删的目录

    if (!(await app.db.deleteUser(id))) return reply.code(404).send({ error: 'not_found' })

    // 数据目录：users/<id>/{home,ws} 整棵删除（force 容忍不存在）
    await rm(userRoot(app.config.dataRoot, id), { recursive: true, force: true })

    // OS 账号：与平台开通脚本同规则 dsh-<id 去横线前 20 位>；不存在则忽略
    const short = id.replace(/-/g, '').slice(0, 20)
    try {
      execFileSync('userdel', [`dsh-${short}`], { stdio: 'ignore' })
    } catch {
      // 账号可能从未被 provision（如 uid 冲突跳过）——DB/目录已清，可接受
    }

    await app.db.audit(request.user?.id ?? null, 'delete_user', JSON.stringify({ userId: id, username: user.username }))
    return { ok: true }
  })
  /**
   * 实例共享运行时/工具清单（admin 只读）。
   * 数据全部用 shell 取（避免为此新增 import）：版本 = 直接执行二进制；
   * 基线 = cat <platform-dir>/state/runtime-baseline.json；清单 = cat SHARED-TOOLS.md。
   * 升级/卸载不在此做 —— 走 `scripts/install-*.sh`（幂等、带 sha256 校验），
   * 升级后必须跑 `runtime-baseline.cjs --accept` 刷新基线（与版本冻结策略配套）。
   */
  app.get('/api/admin/runtime', { preHandler: requireAdmin }, async () => {
    const sh = (cmd: string, args: string[], fallback = ''): string => {
      try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim() } catch { return fallback }
    }
    const first = (cmd: string, args: string[]): string => sh(cmd, args, '缺失').split('\n')[0]

    const items = [
      { name: 'python3', group: '运行时', kind: '可移植发行版', version: first('/usr/local/bin/python3', ['-V']),
        source: 'python-build-standalone install_only_stripped', script: 'scripts/install-python-runtime.sh', removable: false },
      { name: 'pip3', group: '运行时', kind: '随 python3', version: first('/usr/local/bin/pip3', ['-V']),
        source: '随 python-build-standalone', script: 'scripts/install-python-runtime.sh', removable: false },
      { name: 'node', group: '运行时', kind: '平台预装', version: first('/usr/local/bin/node', ['-v']),
        source: '官方 node 分发（平台部署时预装）', script: '—（升级需走独立流程）', removable: false },
      { name: 'npm', group: '运行时', kind: '随 node', version: first('/usr/local/bin/npm', ['-v']),
        source: '随 node', script: '—（升级需走独立流程）', removable: false },
      { name: 'jq', group: '共享工具', kind: '静态单文件', version: first('/usr/local/bin/jq', ['--version']),
        source: 'jqlang/jq 官方静态构建', script: 'scripts/install-shared-tools.sh', removable: true },
      { name: 'rg', group: '共享工具', kind: '静态单文件(musl)', version: first('/usr/local/bin/rg', ['--version']),
        source: 'BurntSushi/ripgrep musl 静态', script: 'scripts/install-shared-tools.sh', removable: true },
      { name: 'ffmpeg', group: '共享工具', kind: '静态单文件', version: first('/usr/local/bin/ffmpeg', ['-version']),
        source: 'BtbN/FFmpeg-Builds 静态构建', script: 'scripts/install-shared-tools.sh', removable: true },
      { name: 'ffprobe', group: '共享工具', kind: '静态单文件', version: first('/usr/local/bin/ffprobe', ['-version']),
        source: 'BtbN/FFmpeg-Builds 静态构建', script: 'scripts/install-shared-tools.sh', removable: true },
    ]

    // 与基线对比
    let baseline: unknown = null
    let drift: string[] = []
    try {
      baseline = JSON.parse(sh('cat', [join(stateDir(), 'runtime-baseline.json')], '{}'))
      const v = (baseline as { versions?: Record<string, string> }).versions ?? {}
      const num = (s: string): string => (s.match(/\d+\.\d+(\.\d+)?/) ?? [''])[0]
      const pair: Array<[string, string]> = [
        ['python3', num(first('/usr/local/bin/python3', ['-V']))],
        ['pip3', num(first('/usr/local/bin/pip3', ['-V']))],
        ['node', num(first('/usr/local/bin/node', ['-v']))],
        ['npm', num(first('/usr/local/bin/npm', ['-v']))],
        ['jq', num(first('/usr/local/bin/jq', ['--version']))],
        ['rg', num(first('/usr/local/bin/rg', ['--version']))],
      ]
      drift = pair.filter(([k, now]) => v[k] !== undefined && v[k] !== now).map(([k, now]) => `${k}: 基线 ${v[k]} → 现在 ${now}`)
    } catch { /* 基线缺失不报错 */ }

    const bytes = Number(sh('du', ['-sk', '/usr/local/dsh-runtime'], '0').split(/\s+/)[0] || 0) * 1024
    return {
      runtimeDir: { path: '/usr/local/dsh-runtime', bytes, installedAt: sh('stat', ['-c', '%y', '/usr/local/dsh-runtime']) },
      items,
      baseline,
      drift,
      manifest: sh('cat', ['/usr/local/dsh-runtime/SHARED-TOOLS.md']),
      installScripts: ['scripts/install-python-runtime.sh', 'scripts/install-shared-tools.sh'],
      baselineScript: 'scripts/runtime-baseline.cjs --accept',
      note: '实例内 /usr 为只读挂载 + /usr/local/bin 在实例 PATH 首位 → 这里装的东西对全部用户立即生效，用户无法自行安装或修改。',
    }
  })

  // ── 集群管理面（T08 S6）：worker 注册表 + 实例迁移 ────────────────────────

  /**
   * Worker 列表。
   * ⚠️ **绝不下发 `agentToken`** —— 它是内网共享密钥，只回 `hasToken` 供排查"配没配"。
   */
  app.get('/api/admin/hosts', { preHandler: requireAdmin }, async () => {
    const hosts = await app.db.listDshHosts()
    return {
      deployMode: app.config.deployMode,
      hosts: hosts.map((h) => ({
        id: h.id,
        endpoint: h.endpoint,
        // 覆盖网络 S2：`via` 必须**可见** —— 否则"经谁可达"这件事运维查不出来，
        // 加列就等于白加（迁移出问题时第一眼就要能看见）。
        via: h.via,
        capacityMb: h.capacityMb,
        usedMb: h.usedMb,
        status: h.status,
        lastHeartbeat: h.lastHeartbeat,
        hasToken: h.agentToken !== '',
      })),
    }
  })

  /** 注册/更新一台 worker（join 脚本调用；**幂等**：同 id 重复执行 = 更新并标回 `up`）。 */
  app.post('/api/admin/hosts', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as {
      id?: string
      endpoint?: string
      /** 覆盖网络 S2：**经谁可达**（`local` / `manager-ssh` / 未来的 `relay:<id>`）。省略 = 列默认。 */
      via?: string
      token?: string
      capacityMb?: number
    }
    if (body.id === undefined || body.endpoint === undefined || body.token === undefined) {
      return reply.code(400).send({ error: 'id, endpoint and token are required' })
    }
    const host = await app.db.upsertDshHost({
      id: body.id,
      endpoint: body.endpoint,
      via: body.via,
      agentToken: body.token,
      capacityMb: Number(body.capacityMb ?? 0),
    })
    await app.db.audit(
      request.user?.id ?? null,
      'host.upsert',
      JSON.stringify({ id: host.id, endpoint: host.endpoint, via: host.via }),
    )
    return {
      ok: true,
      host: {
        id: host.id,
        endpoint: host.endpoint,
        via: host.via,
        capacityMb: host.capacityMb,
        status: host.status,
      },
    }
  })

  /**
   * **计划内迁移**（T08 S6；设计 §4.2）：drain → 目标机拉起 → 归属原子更新（epoch+1）。
   *
   * 顺序不可换：**先停源、再在目标机拉起**。如果反序，两台上会同时有实例（同一个 home ⇒ 双写）。
   * 归属的原子性由租约保证（`claimInstance` 会把 `host_id` 换成目标机并 `epoch+1`），
   * 所以旧机即便复活也会被 fencing 挡住（设计 §11.5）。
   *
   * ⚠️ **数据不搬家**：`folder` 是实例眼里的绝对路径，能在目标机上生效的前提是
   * **两台 worker 的 dataRoot 同路径 + 用户数据位置无关**（共享存储或已同步）——
   * 这正是设计 §12/§14.3 的前提，不是本路由能替你保证的。
   */
  app.post('/api/admin/users/:id/dsh/migrate', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { targetHost } = request.body as { targetHost?: string }
    if (targetHost === undefined || targetHost === '') {
      return reply.code(400).send({ error: 'targetHost is required' })
    }
    const before = await app.db.findUserInstance(id, 'main')
    if (before === undefined) return reply.code(404).send({ error: 'not_found', detail: '该用户没有 main 实例记录' })
    if (before.hostId === targetHost) return reply.code(409).send({ error: 'already_there' })

    const target = await app.db.findDshHost(targetHost)
    if (target === undefined) return reply.code(404).send({ error: 'unknown_host' })
    if (target.status === 'down') return reply.code(409).send({ error: 'target_down' })

    const source = before.hostId
    // fail-loud：没有 folder 就没法在目标机上复现启动（空 cwd 会让 bwrap 直接崩）
    if ((before.folder ?? '') === '') {
      return reply.code(409).send({ error: 'no_folder_recorded', detail: '该实例没有记录 folder，无法复现启动' })
    }
    // ① drain：停源机实例（优雅停机 → 会话落盘；同时释放归属）
    if (source !== null) await app.supervisor.stop(id, source)
    // ② 目标机拉起（走租约：以 targetHost 认领 → epoch+1）
    const instance = await app.supervisor.launch(id, before.folder ?? '', before.patch ?? undefined, {
      hostId: targetHost,
    })
    const after = await app.db.findUserInstance(id, 'main')
    await app.db.audit(
      request.user?.id ?? null,
      'dsh.migrate',
      JSON.stringify({ userId: id, from: source, to: after?.hostId, epoch: after?.epoch }),
    )
    return {
      ok: true,
      from: source,
      to: after?.hostId ?? null,
      epoch: after?.epoch ?? 0,
      port: instance.port ?? null,
    }
  })

}
