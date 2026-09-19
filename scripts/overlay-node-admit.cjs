#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * 覆盖网络 **控制面侧** 命令行：网注册表 / 准入凭据 / 白名单派生（序㊱ · P1 · S1＋S2＋S4）。
 *
 * ## 八条命令
 * | 命令 | 作用 | 跑在哪 |
 * |---|---|---|
 * | `init` | 建注册表目录（惰性，⛔ 不改任何既有配置） | **控制面** |
 * | `issue-invite` | 签一张**准入邀请**（网络绑定 ＋ 有效期 ＋ 一次性 nonce，⛔ 载荷无密钥） | **控制面**（在线签名者） |
 * | `list` | 列出「有哪些网、每张网有哪些节点、谁已批准」 | 任何地方（只读） |
 * | `apply` | 收一份节点申请单：验签 → **原子占位 nonce**（一次性）→ 记 `pending` | **控制面** |
 * | `approve` / `remove` | 批准 / 移除节点（⇒ 进出派生白名单） | **控制面** |
 * | `derive` | 把 approved 集合**投影**成 relay 白名单（缺省**只打印**，`--apply` 才落盘） | **控制面** |
 * | `selfcheck` | **端到端自检**（真跑一遍上面全部动作，输出机器可读读数 ⇒ `OBS-25` 的数据源） | 任何地方（临时目录） |
 *
 * ## 三条纪律
 * ① 🔴 **`derive` 缺省不落盘**（`--apply` 才写）—— P1 不动任何既有 drop-in，
 *    **手写 drop-in 退化为应急通道、⛔ 不删**（`registry.ts#deriveDropIn` 的语义就是"多一条路"）。
 * ② 🔴 **邀请凭据与申请单里 ⛔ 不含任何密钥本体**（只有网络 / nonce / 有效期 / **公钥**）——
 *    stdout 也⛔ 不打印任何私钥。
 * ③ 🔴 **失败一律具名**（`✗ <命令> 失败：<reason> — <detail>` 走 stderr、`exit 1`），
 *    ⛔ **零空 `catch` 块**（这是 `OBS-25` 的机器判据之一）。
 *
 * ## 全局选项（**键名不可混用**）
 * | 选项 | 含义 | 备注 |
 * |---|---|---|
 * | `--dir` | 注册表**目录** | 优先于 env `DSH_AI1NET_OVERLAY_REGISTRY_DIR`，缺省 `<data-root>/overlay` |
 * | `--registry` | 注册表**文件**（覆盖 `--dir` 下的 `nodes.json`） | 🔴 **⛔ 不要用 `--file`** —— 那是 `apply` 的申请单入参 |
 * | `--signer-pub` | 受信签名者公钥（可重复） | 未给 ⇒ 回落 env `DSH_AI1NET_OVERLAY_SIGNER_PUBKEYS` |
 *
 * @module scripts/overlay-node-admit
 */

'use strict'

const { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { randomBytes } = require('node:crypto')
const { dirname, join } = require('node:path')

const reg = require('../lib/net/relay/registry.js')
const joinx = require('../lib/net/relay/join.js')
const id = require('../lib/net/relay/identity.js')

const [, , cmd, ...rest] = process.argv

/** 解析 `--k v` / 开关 `--flag`（与 `overlay-keyring.cjs` 同一套，⛔ 不另造）。 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

const args = parseArgs(rest)

function need(name) {
  const v = args[name]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`missing required --${name}（用法见本文件头部表格）`)
  }
  return v.trim()
}

function opt(name) {
  const v = args[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** 注册表目录（`DSH_AI1NET_OVERLAY_REGISTRY_DIR` 可覆盖；⛔ 生产值不在代码里写死第二份口径）。 */
const REGISTRY_DIR = opt('dir') ?? cfg.overlayDir()
/**
 * 🔴 **覆盖注册表文件用 `--registry`，⛔ 不是 `--file`** —— 真机首轮实测踩坑：
 * `--file` 在本 CLI 里已被 **`apply --file <申请单>`** 占用（还有 `issue-invite --out`），
 * 原先这里写 `opt('file')` ⇒ **`apply --file app.json` 会把注册表文件也指到 app.json**
 * ⇒ 收单在第 4 步（`loadReg`）炸出「注册表 …/app.json 形状非法」，**前 3 步副作用已发生**
 * （nonce 已被原子占位）⇒ 表现为「收单失败 + 同一张邀请再也用不了」。
 * ⇒ 两个语义**必须分开两个键**；⛔ 不许再退回 `--file`。
 */
const REGISTRY_FILE = opt('registry') ?? join(REGISTRY_DIR, 'nodes.json')
const CONSUMED_DIR = join(REGISTRY_DIR, 'consumed')

/** `--signer-pub` 未给时回落到 env（与 relay / dsh 同一套受信来源）。 */
function trustedSigners() {
  const explicit = opt('signer-pub')
  if (explicit !== undefined) return explicit.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return id.identityEnvTrustedSigners(process.env)
}

function nowIso() {
  return new Date().toISOString()
}

function ok(line) {
  process.stdout.write(`${line}\n`)
}

/**
 * 邀请的**本地**有效期（分钟）。缺省 30 min（短窗 = 凭据泄露窗口小）。
 * ⚠️ 这是**控制面侧签发参数**，⛔ 不是生产 env。
 */
function inviteTtlMs() {
  const raw = opt('ttl-min')
  const min = raw === undefined ? 30 : Number(raw)
  if (!Number.isFinite(min) || min <= 0) throw new Error('--ttl-min 必须是正数（分钟）')
  return min * 60 * 1000
}

function loadReg() {
  return reg.loadRegistry(REGISTRY_FILE)
}

/** 写回注册表 —— ⛔ 只有控制面可写（`registry.ts` 的 `saveRegistry` 不做任何权限判断，纪律在调用方）。 */
function commit(r) {
  reg.saveRegistry(REGISTRY_FILE, r)
}

const COMMANDS = {
  /** 建注册表目录（**惰性**：只 `mkdir` + 写一份空注册表；⛔ 不动任何既有 drop-in / env）。 */
  init: () => {
    mkdirSync(REGISTRY_DIR, { recursive: true })
    mkdirSync(CONSUMED_DIR, { recursive: true })
    if (!existsSync(REGISTRY_FILE)) commit(reg.emptyRegistry())
    chmodSync(REGISTRY_FILE, 0o644)
    ok(`✓ 注册表就绪：${REGISTRY_FILE}（0644）`)
    ok(`✓ 一次性台账目录：${CONSUMED_DIR}`)
    ok(`ℹ️ ${reg.describeRegistryLine(loadReg())}`)
    ok('ℹ️ ⛔ 本命令不改任何既有配置；白名单派生要显式跑 `derive --apply`（缺省只打印）。')
  },

  /** 签一张准入邀请（**网络绑定 ＋ 有效期 ＋ 一次性 nonce**；⛔ 载荷内无任何密钥）。 */
  'issue-invite': () => {
    const network = need('network')
    const doc = {
      version: reg.NODES_REGISTRY_VERSION,
      network,
      nonce: reg.newInviteNonce(randomBytes),
      issuedAt: nowIso(),
      expiresAt: new Date(Date.now() + inviteTtlMs()).toISOString(),
    }
    const sig = id.signPayloadWith(readFileSync(need('signer-key'), 'utf8'), reg.networkInvitePayload(doc))
    const out = opt('out')
    if (out !== undefined) {
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, `${JSON.stringify({ doc, sig }, null, 2)}\n`, { mode: 0o644 })
      ok(`✓ 邀请已写出：${out}`)
    } else {
      process.stdout.write(`${JSON.stringify({ doc, sig })}\n`)
    }
    ok(`✓ 邀请：network=${doc.network} nonce=${doc.nonce} 有效期至 ${doc.expiresAt}`)
    ok('🔴 载荷内**不含任何密钥本体**（只有网 / nonce / 有效期）—— 节点私钥在节点上生成、永不出机。')
  },

  /** 列出网与节点（只读）。 */
  list: () => {
    const r = loadReg()
    const network = opt('network')
    if (args.json === true) {
      process.stdout.write(
        `${JSON.stringify({ file: REGISTRY_FILE, networks: reg.summarizeNetworks(r), nodes: reg.listNodes(r, network) }, null, 2)}\n`,
      )
      return
    }
    ok(`注册表：${REGISTRY_FILE}`)
    ok(`ℹ️ ${reg.describeRegistryLine(r)}`)
    for (const n of reg.summarizeNetworks(r)) {
      if (network !== undefined && n.network !== network) continue
      ok(`  · ${n.network}  total=${n.total} approved=${n.approved} pending=${n.pending}`)
    }
    for (const node of reg.listNodes(r, network)) {
      ok(
        `    - ${node.network}/${node.hostId}  status=${node.status}` +
          ` group=${node.group || '(默认)'} key=${node.nodeKey.slice(0, 16)}…` +
          ` appliedAt=${node.appliedAt}${node.approvedAt === '' ? '' : ` approvedAt=${node.approvedAt}`}`,
      )
    }
  },

  /**
   * 收一份申请单 —— **四件都做**：验签 → 原子占位 nonce（一次性）→ 记 `pending` → 打印。
   *
   * 🔴 **一次性是这里保证的**（`consumeNonce` 走 `O_CREAT|O_EXCL`，内核原子）：
   * 两台机器**同时**拿同一张邀请来收单 ⇒ **恰好一台**成功，另一台得到 `invite-already-used`。
   */
  apply: () => {
    // 🔴 读的是**申请单**（`join.ts#parseApplication` 的**唯一形状**）—— 真机首轮就栽在
    //    "apply 按裸 `{doc,sig}` 去读 join 的产物" ⇒ ⛔ 两处形状必须由同一个解析函数读。
    let app
    try {
      app = joinx.readApplicationFile(need('file'))
    } catch (err) {
      process.stderr.write(`✗ apply 失败：application-shape-invalid — ${err instanceof Error ? err.message : String(err)}\n`)
      process.exit(1)
    }
    const { network, hostId, nodeKey } = app
    const signers = trustedSigners()
    if (signers.length === 0) {
      process.stderr.write('✗ apply 失败：invite-no-trusted-signer — 未配置受信签名者（--signer-pub 或 DSH_AI1NET_OVERLAY_SIGNER_PUBKEYS）\n')
      process.exit(1)
    }
    const inv = app.invite
    const verdict = reg.verifyNetworkInvite(inv.doc, inv.sig, signers, { network })
    if (!verdict.ok) {
      process.stderr.write(`✗ apply 失败：invite-${verdict.reason} — 邀请验签未通过（network=${network}）\n`)
      process.exit(1)
    }
    // 🔴 一次性占位：**先占位再落库**（占位失败 ⇒ 根本不产生任何状态变化）。
    const led = reg.consumeNonce({ dir: CONSUMED_DIR }, verdict.doc.nonce, `apply network=${network} host=${hostId}`)
    if (!led.ok) {
      process.stderr.write(
        `✗ apply 失败：invite-already-used — nonce ${verdict.doc.nonce} 已被用掉（一次性凭据，⛔ 不重复受理）\n`,
      )
      process.exit(1)
    }
    const r = loadReg()
    const edit = reg.applyApplication(r, { network, hostId, nodeKey, at: nowIso(), group: opt('group') })
    if (!edit.ok) {
      process.stderr.write(`✗ apply 失败：${edit.reason} — network=${network} host=${hostId} nodeKey=${nodeKey.slice(0, 16)}…\n`)
      process.exit(1)
    }
    commit(r)
    ok(`✓ 已收单（${edit.created ? '新申请' : '刷新既有申请'}）：${network}/${hostId} status=${edit.record.status}`)
    ok('ℹ️ ⛔ 收单**不等于**批准 —— 该节点仍未进白名单（默认拒绝 ⇒ relay 侧拨不动），要 `approve` 才生效。')
  },

  /** 批准（⇒ 进入派生白名单）。 */
  approve: () => {
    const r = loadReg()
    const edit = reg.approveNode(r, need('network'), need('host'), nowIso(), opt('group'))
    if (!edit.ok) {
      process.stderr.write(`✗ approve 失败：${edit.reason} — 该节点未在注册表里申请过（⛔ 不凭空批准）\n`)
      process.exit(1)
    }
    commit(r)
    ok(`✓ 已批准：${edit.record.network}/${edit.record.hostId}（approvedAt=${edit.record.approvedAt}）`)
  },

  /** 移除（⇒ 退出派生白名单；⚠️ relay 侧生效要等一次 reload）。 */
  remove: () => {
    const r = loadReg()
    const edit = reg.removeNode(r, need('network'), need('host'))
    if (!edit.ok) {
      process.stderr.write(`✗ remove 失败：${edit.reason} — 注册表里没有该节点\n`)
      process.exit(1)
    }
    commit(r)
    ok(`✓ 已移除：${edit.record.network}/${edit.record.hostId}`)
    ok('⚠️ relay 侧要等一次 `systemctl restart dsh_ai1net-relay` 才不再接受它的拨号（派生只改配置源）。')
  },

  /**
   * **白名单派生** —— 把该网 approved 集合投影成 `DSH_AI1NET_RELAY_DIALERS`。
   *
   * 🔴 **缺省 `--dry-run` 语义**（只打印，⛔ 不落盘）—— P1 的硬门是"不动任何既有配置"。
   * 要落盘必须显式 `--apply`；`--out` 可指定别处（做对照用）。
   */
  derive: () => {
    const r = loadReg()
    const network = need('network')
    const content = reg.deriveDropIn(r, {
      network,
      unit: opt('unit') ?? 'dsh_ai1net-relay',
      libDir: opt('lib'),
      varName: opt('var'),
    })
    const audit = reg.auditDerivation(r)
    ok(`ℹ️ ${reg.describeRegistryLine(r)}`)
    ok(`ℹ️ 派生自审：${audit.ok ? '一致 ✅' : '❌ 不一致'}`)
    for (const m of audit.mismatches) ok(`   ❌ 集合不配：${m}`)
    for (const m of audit.misfiled) ok(`   ❌ 结构性错桶（跨网共享）：${m}`)
    const target = opt('out') ?? reg.dropInPath(opt('unit') ?? 'dsh_ai1net-relay').replace(/ \(lib=.*\)$/, '')
    if (args.apply === true) {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, `${content}\n`, { mode: 0o644 })
      ok(`✓ 已落盘：${target}（0644）`)
      ok('⚠️ 生效要一次 `systemctl daemon-reload && systemctl restart dsh_ai1net-relay`（⛔ 本命令不代跑）。')
      ok('🔴 手写 drop-in 是**应急通道**，⛔ 未被删除 —— 控制面不可用时照旧生效。')
    } else {
      ok(`ℹ️ 未落盘（缺省 dry-run）⇒ 打印内容如下；要落盘加 \`--apply --out ${target}\``)
      process.stdout.write(`${content}\n`)
    }
  },

  /**
   * **端到端自检**（临时目录里真跑一遍全部动作）—— `OBS-25` 的数据源。
   *
   * 判据不是"函数跑通了"，而是**六件同时成立**（逐条给原始读数）：
   * ① 四步编排真跑完（`runJoin` 四条 step 全 ok）；② **回环的正当性**：申请单里
   * **逐字不含私钥**；③ 节点私钥文件权限 = `600`；④ 收单**一次性**（第二次 ⇒ `invite-already-used`）；
   * ⑤ 四条**负腿**各自**具名**拒绝（坏签名 / 过期 / 错网 / 无受信签名者）；
   * ⑥ 派生自审一致 ＋ 两张网**零共享**。
   */
  selfcheck: async () => {
    const tmp = opt('tmp') ?? join(require('node:os').tmpdir(), `dsh_ai1net-selfcheck-${process.pid}`)
    const dir = {
      root: tmp,
      key: join(tmp, 'signer.key'),
      nodeKey: join(tmp, 'node.key'),
      nodeCfg: join(tmp, 'node.json'),
      app: join(tmp, 'application.json'),
      regDir: join(tmp, 'registry'),
    }
    mkdirSync(join(dir.regDir, 'consumed'), { recursive: true })

    const signer = id.generateAuthorityKey()
    writeFileSync(dir.key, signer.privateKeyPem, { mode: 0o600 })

    /** 签一张邀请（helper：与 `issue-invite` 同一条路径，⛔ 不复制逻辑）。 */
    const issue = (network, expiresInMs) => {
      const doc = {
        version: reg.NODES_REGISTRY_VERSION,
        network,
        nonce: reg.newInviteNonce(randomBytes),
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      }
      return { doc, sig: id.signPayloadWith(signer.privateKeyPem, reg.networkInvitePayload(doc)) }
    }

    const io = joinx.nodeJoinIo({
      fss: { existsSync, readFileSync, writeFileSync, mkdirSync },
      crypto: id,
      os: require('node:os'),
      fetchImpl: async () => ({ status: 599, body: 'selfcheck 不走 HTTP 通道' }),
    })
    const signers = [signer.publicKey]

    // ── ① 正当路径：真的跑完四步 ──────────────────────────────────────────
    const goodInvite = issue('selfcheck-net', 5 * 60 * 1000)
    const joined = await joinx.runJoin(
      {
        network: 'selfcheck-net',
        hostId: 'node-a',
        invite: goodInvite,
        trustedSigners: signers,
        nodeKeyFile: dir.nodeKey,
        localConfigFile: dir.nodeCfg,
        outFile: dir.app,
      },
      io,
    )

    // ── ② 申请单逐字不含私钥（**字节级**，⛔ 不是"语义上应该没有"）──────────
    const appText = existsSync(dir.app) ? readFileSync(dir.app, 'utf8') : ''
    const nodePriv = existsSync(dir.nodeKey) ? readFileSync(dir.nodeKey, 'utf8') : ''
    // 取私钥 PEM 的**主体行**（去掉 BEGIN/END 包裹与换行）当探针串 —— 出现即泄露。
    const privBody = (nodePriv.split('\n').filter((l) => l !== '' && !l.startsWith('-----')).join('') || '')
    const privateKeyLeak = appText === '' || privBody === '' ? -1 : appText.includes(privBody) ? 1 : 0

    // ── ③ 节点私钥文件权限 ────────────────────────────────────────────────
    const nodeKeyMode = existsSync(dir.nodeKey) ? (require('node:fs').statSync(dir.nodeKey).mode & 0o777).toString(8) : 'absent'

    // ── ④ 控制面**按 CLI 同样的路径**收单（解析申请单文件 → 验签 → 原子占位 → 落 pending）──
    //    🔴 真机首轮实测教训：selfcheck 原先**直接调库**、绕过了 `apply` 的解析 ⇒ 掩盖了
    //    "join 产出的申请单 与 apply 的解析形状不一致"这个真缺陷。⇒ 这里必须走**文件 → 解析**。
    const failures = []
    const regFile = join(dir.regDir, 'nodes.json')
    const led = { dir: join(dir.regDir, 'consumed') }
    let parsedApp
    let appShapeErr = ''
    try {
      parsedApp = joinx.readApplicationFile(dir.app)
    } catch (err) {
      appShapeErr = err instanceof Error ? err.message : String(err)
    }
    if (appShapeErr !== '') {
      failures.push({ leg: 'cli-roundtrip', step: 'register', reason: 'application-shape-invalid', named: true, detail: appShapeErr.slice(0, 160) })
    }
    const invFromFile =
      parsedApp === undefined
        ? { ok: false, reason: 'bad-payload' }
        : reg.verifyNetworkInvite(parsedApp.invite.doc, parsedApp.invite.sig, signers, { network: parsedApp.network })
    const first = invFromFile.ok ? reg.consumeNonce(led, invFromFile.doc.nonce, 'selfcheck first') : { ok: false, reason: 'invite-bad-payload' }
    const second = invFromFile.ok ? reg.consumeNonce(led, invFromFile.doc.nonce, 'selfcheck second') : { ok: false, reason: 'invite-bad-payload' }
    const r = reg.emptyRegistry()
    const applied =
      parsedApp !== undefined && first.ok
        ? reg.applyApplication(r, {
            network: parsedApp.network,
            hostId: parsedApp.hostId,
            nodeKey: parsedApp.nodeKey,
            at: new Date().toISOString(),
          })
        : { ok: false, reason: 'not-applied' }
    const approved = reg.approveNode(r, parsedApp?.network ?? 'selfcheck-net', parsedApp?.hostId ?? 'node-a', new Date().toISOString())
    reg.saveRegistry(regFile, r)

    // ── ⑤ 四条负腿：每条都必须**具名**拒绝 ────────────────────────────────
    const record = (leg, outcome) => {
      const named = typeof outcome.reason === 'string' && outcome.reason !== ''
      failures.push({
        leg,
        step: typeof outcome.step === 'string' ? outcome.step : '',
        reason: named ? outcome.reason : '',
        named,
        detail: typeof outcome.detail === 'string' ? outcome.detail.slice(0, 160) : '',
      })
    }
    const joinBase = {
      network: 'selfcheck-net',
      hostId: 'node-b',
      trustedSigners: signers,
      nodeKeyFile: join(tmp, 'node-b.key'),
      localConfigFile: join(tmp, 'node-b.json'),
      outFile: join(tmp, 'application-b.json'),
    }
    // 负腿 1：签名被篡改
    const tampered = issue('selfcheck-net', 5 * 60 * 1000)
    tampered.sig = `${tampered.sig.slice(0, -4)}AAAA`
    record('bad-signature', await joinx.runJoin({ ...joinBase, invite: tampered }, io))
    // 负腿 2：已过期
    record('expired', await joinx.runJoin({ ...joinBase, invite: issue('selfcheck-net', -60 * 1000) }, io))
    // 负腿 3：邀请绑的是别张网
    record('wrong-network', await joinx.runJoin({ ...joinBase, invite: issue('other-net', 5 * 60 * 1000) }, io))
    // 负腿 4：没配受信签名者（**不可验 = 不接受**）
    record('no-trusted-signer', await joinx.runJoin({ ...joinBase, invite: issue('selfcheck-net', 5 * 60 * 1000), trustedSigners: [] }, io))
    // 负腿 5：既没 --portal 也没 --out（⛔ 不许静默成功）
    record('no-channel', await joinx.runJoin({ ...joinBase, invite: issue('selfcheck-net', 5 * 60 * 1000), outFile: '' }, io))

    // ── ⑥ 派生自审 ＋ 两网零共享 ─────────────────────────────────────────
    const audit = reg.auditDerivation(r)
    const derived = reg.deriveDialers(r)
    const nets = [...derived.keys()].sort()
    // **跨网共享** = 同一 hostId 出现在 ≥2 张网（结构性隔离下**必然为 0**：桶键含网络）。
    const seen = new Map()
    let crossNetworkShared = 0
    for (const n of nets) for (const h of derived.get(n) ?? []) {
      if (seen.has(h)) crossNetworkShared++
      seen.set(h, n)
    }
    const dropIn = reg.deriveDropIn(r, { network: 'selfcheck-net' })
    const dropInHasNetwork = dropIn.includes('selfcheck-net/node-a')

    const steps = joined.ok ? joined.steps : []
    // ⚠️ **权限只在 Linux 上可判**：Windows 的 `stat.mode` 是只读属性模拟（恒 666/444），
    //    拿它当"0600 成立"= **假绿**。⇒ 记 `platform` 并让判据可区分"不成立"与"这台机器不可判"。
    const modeOk = process.platform === 'linux' ? nodeKeyMode === '600' : null
    const report = {
      version: 1,
      at: new Date().toISOString(),
      platform: process.platform,
      tmp,
      artifacts: { join: true, registry: true, admitCli: true },
      joinSteps: steps.map((s) => ({ step: s.step, ok: s.ok })),
      joinStepsMin: joinx.JOIN_STEPS.length,
      joinOk: joined.ok === true,
      joinFailStep: joined.ok ? '' : joined.step,
      joinFailReason: joined.ok ? '' : joined.reason,
      application: {
        bytes: Buffer.byteLength(appText, 'utf8'),
        hasPrivateKey: privateKeyLeak,
        containsOnlyPublicKey: joined.ok ? appText.includes(joined.nodeKey) : false,
        // 🔴 **CLI 回环**：申请单文件能否被 `parseApplication` 读回（真机首轮栽的就是这条）。
        shapeOk: parsedApp !== undefined,
        shapeError: appShapeErr.slice(0, 200),
        // 申请单里读回的 hostId/network 必须与 join 的输入**逐字一致**（防"写对了但读歪了"）。
        hostMatches: parsedApp !== undefined && parsedApp.hostId === 'node-a' && parsedApp.network === 'selfcheck-net',
      },
      nodeKeyMode,
      // `null` = **本平台不可判**（⛔ 不是 PASS）；判据只对 `600` 取真。
      nodeKeyModeOk: modeOk,
      ledger: { first: first.ok ? 'ok' : first.reason, second: second.ok ? 'ok' : second.reason },
      registry: {
        file: regFile,
        applied: applied.ok ? applied.record.status : applied.reason,
        approved: approved.ok ? approved.record.status : approved.reason,
        auditOk: audit.ok,
        mismatches: audit.mismatches,
        misfiled: audit.misfiled,
      },
      derivation: { networks: nets, crossNetworkShared, dropInHasNetwork },
      namedFailures: failures,
      silentRejections: failures.filter((f) => f.named !== true || f.reason === '').length,
    }
    const out = opt('out')
    if (args.json === true || out !== undefined) {
      const text = `${JSON.stringify(report, null, 2)}\n`
      if (out !== undefined) writeFileSync(out, text, { mode: 0o644 })
      if (args.json === true && out === undefined) process.stdout.write(text)
      if (out !== undefined) ok(`✓ 自检读数已写出：${out}`)
      return
    }
    ok(`✓ join 四步：${steps.filter((s) => s.ok).length}/${joinx.JOIN_STEPS.length}｜ok=${report.joinOk}`)
    ok(`✓ 申请单 ${report.application.bytes} B｜私钥出现次数=${report.application.hasPrivateKey}（须 0）`)
    ok(
      modeOk === null
        ? `⚠️ 私钥权限=${nodeKeyMode} —— platform=${process.platform} ⇒ **本平台不可判**（⛔ 不当 PASS；真机腿见部署后 ssh stat -c %a）`
        : `✓ 私钥权限=${nodeKeyMode}（须 600）⇒ ${modeOk ? '成立' : '不成立'}`,
    )
    ok(`✓ 一次性：first=${report.ledger.first} second=${report.ledger.second}（须 invite-already-used）`)
    ok(`✓ 派生自审 auditOk=${audit.ok}｜网=${nets.join(',')}｜跨网共享=${crossNetworkShared}（须 0）`)
    for (const f of failures) ok(`  · 负腿 ${f.leg}: step=${f.step} reason=${f.reason}`)
    ok(`✓ 具名失败 ${failures.length} 条｜静默拒绝=${report.silentRejections}（须 0）`)
  },
}

async function main() {
  const fn = COMMANDS[cmd]
  if (fn === undefined) {
    process.stderr.write(`unknown command: ${String(cmd)}\n可用：${Object.keys(COMMANDS).join(' | ')}\n`)
    process.exit(2)
  }
  await fn()
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
