#!/usr/bin/env node
/**
 * 覆盖网络 **节点侧** 命令行：一条命令接入（序㊱ · P1 · S3）。
 *
 * ## 用户口径（原话）
 * 「**b 要实现开启一台结点服务器，就能连上覆盖网络**，这样做这个网络才有价值」。
 * ⇒ 判据 = **一条命令**，⛔ 不是"照文档改四处配置"（现状：装单元 / 配密钥 / 写 drop-in / DB 登记）。
 *
 * ## 用法
 * ```bash
 * # ① 离线通道（控制面尚未开放接收入口时唯一可用；把申请单交给控制面收单）
 * node scripts/overlay-node-join.cjs --network ops --invite /tmp/invite.json \
 *      --signer-pub <hex> --out /tmp/application.json
 *
 * # ② HTTP 通道（控制面已开放接收入口时；才谈得上"一条命令完成"）
 * node scripts/overlay-node-join.cjs --network ops --invite <json|file> \
 *      --signer-pub <hex> --portal https://<控制面>/dsh_ai1net-overlay/join
 * ```
 *
 * | 选项 | 缺省 | 说明 |
 * |---|---|---|
 * | `--network` | **必填** | 要加入的网（`ops` ｜ `u:<租户>` ｜ 显式命名网） |
 * | `--invite` | **必填** | 邀请凭据：**文件路径**或**内联 JSON** |
 * | `--host` | 本机主机名（规范化） | 该节点在这张网里的**逻辑名** |
 * | `--key` | `/etc/dsh_ai1net/node.key` | 节点私钥落点（**`0600`，⛔ 永不出机**） |
 * | `--config` | `/etc/dsh_ai1net/overlay-node.json` | 本机配置落点（`0600`，只记"私钥在哪"） |
 * | `--out` / `--portal` | — | 二选一（⛔ 都没有 ⇒ **具名失败**，不静默成功） |
 * | `--direct` | **开**（🆕 序㊵） | 本机**直连（打洞）开关**：可写 `1/true/on/yes` 或 `0/false/off/no`；⛔ 取值非法 ⇒ **具名失败**（不静默取缺省）。关闭 ⇒ ⛔ 不绑 UDP 口、⛔ 不发直连候选 |
 * | `--signer-pub` | env `DSH_AI1NET_OVERLAY_SIGNER_PUBKEYS` | 受信签名者（空 ⇒ **不可验 = 不接受**） |
 *
 * ## 🔴 失败一律具名
 * 打印**走到第几步**（四步逐条 `✓`/`✗`）+ **原因码**，`exit 1`。
 * ⛔ 本文件与 `join.ts` 内**零空 `catch` 块** —— 这是本线治"配置错长得像网络不通"的机器判据。
 *
 * @module scripts/overlay-node-join
 */

'use strict'

const { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } = require('node:fs')

const joinx = require('../lib/net/relay/join.js')
const id = require('../lib/net/relay/identity.js')
const directx = require('../lib/net/relay/direct/index.js')

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

const args = parseArgs(process.argv.slice(2))

function need(name) {
  const v = args[name]
  if (typeof v !== 'string' || v.trim() === '') {
    process.stderr.write(`✗ join 失败：缺少必填参数 --${name}（用法见本文件头部表格）\n`)
    process.exit(2)
  }
  return v.trim()
}

function opt(name) {
  const v = args[name]
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** 受信签名者（`--signer-pub` 优先，回落 env —— 与 relay / dsh 同一套来源，⛔ 不另造）。 */
function trustedSigners() {
  const explicit = opt('signer-pub')
  if (explicit !== undefined) return explicit.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return id.identityEnvTrustedSigners(process.env)
}

/** `--invite` 既接受**文件路径**也接受**内联 JSON**（`{doc, sig}`）。 */
function readInvite(spec) {
  const trimmed = spec.trim()
  if (trimmed.startsWith('{')) {
    const raw = JSON.parse(trimmed)
    if (raw === null || typeof raw !== 'object') throw new Error('--invite 的 JSON 不是对象')
    const r = raw
    if (r.doc === undefined || r.sig === undefined) throw new Error('--invite 的 JSON 缺 doc / sig 字段')
    return { doc: r.doc, sig: r.sig }
  }
  return joinx.readSignedJson(trimmed)
}

const fss = { existsSync, readFileSync, writeFileSync, mkdirSync }

/** 真的发一次 POST（`--portal` 通道）。响应体**原样**带回 —— 控制面的原因码不许被吞掉。 */
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { status: res.status, body: await res.text() }
}

async function main() {
  const network = need('network')
  const invite = readInvite(need('invite'))
  const hostFromArg = opt('host')
  const hostId = hostFromArg ?? joinx.defaultHostId(require('node:os').hostname())
  if (hostId === '') {
    process.stderr.write('✗ join 失败：hostId 推不出来（本机主机名规范化后为空）⇒ 必须显式给 --host\n')
    process.exit(2)
  }
  const nodeKeyFile = opt('key') ?? '/etc/dsh_ai1net/node.key'
  const localConfigFile = opt('config') ?? '/etc/dsh_ai1net/overlay-node.json'
  const outFile = opt('out')
  const portalUrl = opt('portal')
  const signers = trustedSigners()

  // 🆕 序㊵（P2/S5）：直连（打洞）开关 —— **缺省开**（用户口径②），可用 `--direct 0` 当场关掉。
  const directArg = opt('direct')
  let direct = directx.DEFAULT_DIRECT_ENABLED
  if (directArg !== undefined) {
    const v = directArg.trim().toLowerCase()
    if (directx.DIRECT_ON_VALUES.includes(v)) direct = true
    else if (directx.DIRECT_OFF_VALUES.includes(v)) direct = false
    else {
      // ⛔ 取值非法 ⇒ **具名失败**（⛔ 不静默取缺省 —— 本线所有"配置错长得像网络不通"都源于这一手）
      process.stderr.write(
        `✗ join 失败：--direct ${JSON.stringify(directArg)} 既不在开集 ${directx.DIRECT_ON_VALUES.join('/')} 也不在关集 ${directx.DIRECT_OFF_VALUES.join('/')}\n`,
      )
      process.exit(2)
    }
  }

  const outcome = await joinx.runJoin(
    { network, hostId, invite, trustedSigners: signers, nodeKeyFile, localConfigFile, outFile, portalUrl, direct },
    joinx.nodeJoinIo({ fss, crypto: id, os: require('node:os'), fetchImpl: post }),
  )

  for (const s of outcome.steps) {
    process.stdout.write(`${s.ok ? '✓' : '✗'} [${s.step}] ${s.detail}\n`)
  }
  if (outcome.ok) {
    process.stdout.write(`${joinx.describeJoin(outcome)}\n`)
    process.stdout.write(
      `ℹ️ 节点文件权限：${statSync(nodeKeyFile).mode & 0o777 ? (statSync(nodeKeyFile).mode & 0o777).toString(8) : 'n/a'}` +
        `（私钥）｜${(statSync(localConfigFile).mode & 0o777).toString(8)}（配置）\n`,
    )
    process.stdout.write('🔴 本命令⛔ 不装服务单元、⛔ 不写 drop-in —— 白名单由**控制面派生**（`overlay-node-admit.cjs derive`）。\n')
    // 🆕 序㊵（P2/S5）：**用户口径③「提示用户」** —— 开启直连（打洞）时必须说清
    //    ① 谁可能连进来 ② 怎么关 ③ 关掉不影响什么（⛔ 禁止只写"已启用直连"）。
    process.stdout.write(`ℹ️ 直连（打洞）= ${direct ? '开（缺省）' : '关'}｜开关键 ${directx.DIRECT_ENV_KEY}｜本机配置字段 direct\n`)
    if (direct) {
      for (const line of directx.directHintLines()) process.stdout.write(`   ${line}\n`)
    } else {
      process.stdout.write(
        `   已按 --direct 关闭：⛔ 不绑任何 UDP 端口、⛔ 不发直连候选；跨机流量走中继（接入与准入不受影响）。\n`,
      )
    }
    if (outcome.applicationFile !== '') {
      process.stdout.write(`➡️ 把申请单交给控制面收单：overlay-node-admit.cjs apply --file ${outcome.applicationFile}\n`)
    }
    return
  }
  process.stdout.write(`${joinx.describeJoin(outcome)}\n`)
  process.stderr.write(`✗ join 失败：${outcome.reason} — 停在「${outcome.step}」步：${outcome.detail}\n`)
  process.exit(1)
}

main().catch((err) => {
  // ⛔ 唯一的兜底 catch，**必须打印原文**（空 catch = 静默失败 = 本线要根治的病）。
  process.stderr.write(`✗ join 异常：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
