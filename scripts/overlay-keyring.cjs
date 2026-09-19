#!/usr/bin/env node
/**
 * 覆盖网络 序③：**密钥仪式工具**（一机一钥 + 信任根）。
 *
 * 把 `lib/net/relay/identity.js` 的纯函数包成命令行，做四件事：
 * 建根 / 建签名者 / 签发与吊销 / **恢复演练**。⛔ 它**自己不做任何校验决策** ——
 * 判据全在模块里（`verify*`），本工具只是"拿私钥签个名、把结果落盘"的搬运工。
 *
 * ## 四层与它们各自该在哪台机器上跑（⛔ 别搞混）
 * | 命令 | 该在哪跑 | 为什么 |
 * |---|---|---|
 * | `init-root` | **离线**（本工作区开发机 / 离线介质） | 根只授权签名者；在线 = 单点被攻破即全网伪造 |
 * | `init-signer` | **在线签名者**（现网 = <worker-a>） | 日常签发都在这台，频繁但爆炸半径小（根还能撤它） |
 * | `init-node` | **每台节点** | 一机一钥；私钥永不出机器 |
 * | `issue-grant` | 在线签名者 | 签发"某 hostId + 某节点公钥"的入网凭据 |
 * | `sign-revocations` | 在线签名者 | 撤单台（⛔ 撤**签名者**是"根重签一份 SignerSet"的事） |
 * | `verify-grant` | 任何地方 | 自检：凭据是不是受信签名者签的 |
 * | `recover-root` | 离线 | **恢复演练**：从纸质恢复码重建根私钥，再签一份 SignerSet 验通 |
 * | 🆕 `init-group-key` | **每个内容组一次**（结果 scp 到该组每台机器） | 生成**组密钥**（对称，32 B）落 `0600`；⛔ 密钥本体**永不进 stdout / 日志** |
 * | 🆕 `sign-group-key` | 在线签名者（47） | 签 `(network, group, epoch, keyId)` **三元组**（⛔ 载荷内**不含密钥本体**） |
 * | 🆕 `verify-group-key` | 任何地方 | 自检：三元组是不是受信签名者签的（篡改 `epoch` 必须失败） |
 *
 * ## 用法
 * ```bash
 * node scripts/overlay-keyring.cjs init-root     --dir /sec/dsh_ai1net-root
 * node scripts/overlay-keyring.cjs init-signer   --key /etc/dsh_ai1net/overlay-signer-key.pem
 * node scripts/overlay-keyring.cjs sign-signerset --root-key <pem> --signers <pubhex,…> --network ops --out <json>
 * node scripts/overlay-keyring.cjs init-node     --key /etc/dsh_ai1net/node.key
 * node scripts/overlay-keyring.cjs issue-grant   --signer-key <pem> --network ops --host <host-b> --node-key <file|hex> --out <json>
 * node scripts/overlay-keyring.cjs sign-revocations --signer-key <pem> --network ops --hosts a,b --out <json>
 * node scripts/overlay-keyring.cjs verify-grant  --file <json> --signer-pub <hex> [--host <host-b> --network ops]
 * node scripts/overlay-keyring.cjs recover-root  --code <hex> --out <pem> [--expect-pub <hex>]
 *                                              # 演练三判据：--expect-pub 比公钥；
 *                                              # 再给 --signers <hex,…> --network <n> --issued-at <iso> ⇒ 用重建的根签 SignerSet 验通（判据②）；
 *                                              # 再给 --expect-sig <b64>（原根对同一 doc 签出的）⇒ 逐字节比对（判据③）
 * # 🆕 序㉘ · 单 B（组密钥加密）：
 * node scripts/overlay-keyring.cjs init-group-key --group relay --epoch 1 --out /etc/dsh_ai1net/content-group-key.json [--network ops]
 * node scripts/overlay-keyring.cjs sign-group-key --signer-key <pem> --network ops --group relay --epoch 1 \
 *                                                --key /etc/dsh_ai1net/content-group-key.json --out <json>
 * node scripts/overlay-keyring.cjs verify-group-key --file <json> --signer-pub <hex> [--group relay --epoch 1]
 * ```
 *
 * 🔴 **所有落盘的私钥 / 密钥一律 `0600`**（`writeSecret`），且**stdout 只打印公钥 / 指纹** ——
 * 私钥进 stdout 就会进终端历史、`journalctl`、CI 日志。
 * ⚠️ 组密钥是**对称密钥** ⇒ 同一条铁律：stdout 只打印 `keyId`（`sha256(key)` 前 16 hex），⛔ 不打印 key。
 *
 * @module scripts/overlay-keyring
 */

'use strict'

const { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

const id = require('../lib/net/relay/identity.js')
// 🆕 序㉘ · 单 B：组密钥（对称）—— 生成 / 签名三元组 / 验签。⚠️ 只搬运算，判据全在模块里。
const cfgx = require('../lib/net/relay/content/crypto.js')

const [, , cmd, ...rest] = process.argv

/** 解析 `--k v` 与开关 `--flag`。 */
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
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
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
    throw new Error(`missing required --${name}（用法见本文件头部的表格）`)
  }
  return v.trim()
}

/** 写**私钥**类文件：`0600` + 同目录临时文件 + `rename`（不留半成品，也不留宽权限）。 */
function writeSecret(file, text, logAction) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
  process.stdout.write(`✓ ${logAction}：${file}（0600）\n`)
}

/** 写**公开**物（签名文档 / 公钥）：`0644` —— 它们本来就要被分发到每台机器。 */
function writePublic(file, obj) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o644 })
  renameSync(tmp, file)
  process.stdout.write(`✓ 已写出：${file}\n`)
}

function nowIso() {
  return new Date().toISOString()
}

/** `--node-key` 既接受**文件**（推荐：公钥从私钥推，不另存一份）也接受裸 hex。 */
function nodePublicKey(spec) {
  const raw = spec.trim()
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase()
  const pem = readFileSync(raw, 'utf8')
  return id.publicKeyOfPrivate(pem)
}

const COMMANDS = {
  /** 建**离线根**：私钥 + 公钥 + **纸质恢复码**（PKCS#8 DER 的 hex，可抄写）。 */
  'init-root': () => {
    const dir = need('dir')
    const key = id.generateAuthorityKey()
    writeSecret(`${dir}/root.key`, key.privateKeyPem, '根私钥')
    writeFileSync(`${dir}/root.pub`, `${key.publicKey}\n`, { mode: 0o644 })
    // 恢复码 = PKCS#8 DER 的 hex（由 `recover-root` 反解回 PEM）⇒ 可手抄、可打印、可存密码管理器。
    const der = require('node:crypto').createPrivateKey(key.privateKeyPem).export({ type: 'pkcs8', format: 'der' })
    const groups = (der.toString('hex').match(/.{1,8}/g) ?? []).join(' ')
    writeFileSync(`${dir}/root.recovery-code.txt`, `DSHS 覆盖网络 · 根密钥恢复码（第 1 份，纸质/离线保管）\n\n${groups}\n`, {
      mode: 0o600,
    })
    process.stdout.write(`✓ 根公钥（可公开，要下发到每台节点 / relay）：${key.publicKey}\n`)
    process.stdout.write(`✓ 根指纹：${id.nodeKeyFingerprint(key.publicKey)}\n`)
    process.stdout.write(`✓ 恢复码：${dir}/root.recovery-code.txt（0600，**请抄到纸或另存离线介质**）\n`)
  },

  /** 建**在线签名者**（每台管理员设备一把）。 */
  'init-signer': () => {
    const keyFile = need('key')
    const key = id.generateAuthorityKey()
    writeSecret(keyFile, key.privateKeyPem, '签名者私钥')
    writeFileSync(`${keyFile}.pub`, `${key.publicKey}\n`, { mode: 0o644 })
    process.stdout.write(`✓ 签名者公钥（要写进 SignerSet 并由**根**签发）：${key.publicKey}\n`)
    process.stdout.write(`✓ 签名者指纹：${id.nodeKeyFingerprint(key.publicKey)}\n`)
  },

  /** 建**节点密钥**（每机一把，一机一钥）。 */
  'init-node': () => {
    const keyFile = need('key')
    const key = id.generateNodeKey()
    writeSecret(keyFile, key.privateKeyPem, '节点私钥')
    process.stdout.write(`✓ 节点公钥：${key.publicKey}\n`)
    process.stdout.write(`✓ 节点指纹：${id.nodeKeyFingerprint(key.publicKey)}\n`)
  },

  /** **根**签一份签名者集合（授权签名者）—— ⛔ 只在离线跑。 */
  'sign-signerset': () => {
    const doc = {
      version: 1,
      network: need('network'),
      // `--issued-at` 可选：**恢复演练**要靠它把时间钉死，才谈得上"签名逐字节相同"。
      issuedAt: typeof args['issued-at'] === 'string' && args['issued-at'] !== '' ? args['issued-at'] : nowIso(),
      signers: need('signers').split(',').map((s) => s.trim()).filter((s) => s !== ''),
    }
    const sig = id.signSignerSet(doc, readFileSync(need('root-key'), 'utf8'))
    writePublic(need('out'), { doc, sig })
    // **自检**：签完立刻用根公钥验一遍 —— 签错比不签更危险（下游会以为"已经授权了"）。
    const pub = args['root-pub'] ?? readFileSync(`${dirname(need('root-key'))}/root.pub`, 'utf8').trim()
    const verdict = id.verifySignerSet(doc, sig, [pub])
    if (!verdict.ok) throw new Error(`自检失败：刚签的 SignerSet 验不过（${verdict.reason}）`)
    process.stdout.write(`✓ 自检通过（受信根验签 ok），签名者 ${doc.signers.length} 把\n`)
  },

  /** **签名者**签一份节点入网凭据。 */
  'issue-grant': () => {
    const doc = {
      version: 1,
      network: need('network'),
      hostId: need('host'),
      nodeKey: nodePublicKey(need('node-key')),
      issuedAt: nowIso(),
      expiresAt: args['expires-at'] ?? '',
    }
    const sig = id.signNodeGrant(doc, readFileSync(need('signer-key'), 'utf8'))
    writePublic(need('out'), { doc, sig })
    process.stdout.write(`✓ 已签发：${doc.network}/${doc.hostId} 节点指纹=${id.nodeKeyFingerprint(doc.nodeKey)}\n`)
  },

  /** **签名者**签一份吊销清单（撤单台）。 */
  'sign-revocations': () => {
    const doc = {
      version: 1,
      network: need('network'),
      issuedAt: nowIso(),
      hosts: (args.hosts ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''),
      nodeKeys: (args['node-keys'] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => nodePublicKey(s)),
    }
    const sig = id.signRevocations(doc, readFileSync(need('signer-key'), 'utf8'))
    writePublic(need('out'), { doc, sig })
    process.stdout.write(`✓ 已签发吊销清单：hosts=[${doc.hosts.join(',')}] nodeKeys=${doc.nodeKeys.length}\n`)
  },

  /** 自检：某份凭据是不是受信签名者签的（签发后立刻跑一次）。 */
  'verify-grant': () => {
    const raw = JSON.parse(readFileSync(need('file'), 'utf8'))
    const verdict = id.verifyPeerGrant(raw.doc, raw.sig, {
      trustedSignerKeys: need('signer-pub').split(',').map((s) => s.trim()),
      network: args.network,
      hostId: args.host,
    })
    if (!verdict.ok) {
      process.stderr.write(`✗ 验签失败：${verdict.reason}\n`)
      process.exit(1)
    }
    process.stdout.write(`✓ 验签通过：${verdict.doc.network}/${verdict.doc.hostId} 指纹=${id.nodeKeyFingerprint(verdict.doc.nodeKey)}\n`)
  },

  /**
   * 🆕 序㉘ · 单 B：生成**组密钥**（对称，32 字节 = `crypto.KEY_LEN`）—— **每个内容组一次**。
   *
   * 三条纪律：
   * ① 落盘走 `writeSecret` ⇒ **`0600`**（密钥本体只准在文件里，⛔ **不经网络、不经 relay**）；
   * ② stdout **只打印 `keyId`**（`sha256(key)` 前 16 hex）⇒ 可安全贴进回报 / 日志；
   * ③ 同一把密钥要铺到该组的**每台**机器（`scp` ＋ `0600` ＋ 属主正确）。
   */
  'init-group-key': () => {
    const group = need('group')
    const epoch = Number(need('epoch'))
    if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('--epoch 必须是正整数')
    const key = require('node:crypto').randomBytes(cfgx.KEY_LEN)
    const doc = {
      version: cfgx.CONTENT_CIPHER_VERSION,
      group,
      ...(args.network === undefined ? {} : { network: String(args.network) }),
      epoch,
      key: key.toString('base64'),
      previous: [],
    }
    writeSecret(need('out'), `${JSON.stringify(doc, null, 2)}\n`, '组密钥文件')
    process.stdout.write(
      `✓ group=${group} epoch=${epoch} keyId=${cfgx.keyIdOf(key)}（⚠️ 密钥本体只在文件里，⛔ stdout 不打印）\n`,
    )
  },

  /**
   * 🆕 序㉘ · 单 B：签名者签一份**组密钥凭据** = `(network, group, epoch, keyId)` **三元组**。
   *
   * 🔴 **载荷内不含密钥本体** —— 它只回答"当前这一代是哪一把（`keyId`）"，
   * 供节点做**版本错配检测**；密钥本体仍只走 `0600` 文件通道。
   */
  'sign-group-key': () => {
    const spec = need('key').trim()
    let keyB64 = spec
    try {
      const raw = JSON.parse(readFileSync(spec, 'utf8'))
      if (raw !== null && typeof raw === 'object' && typeof raw.key === 'string') keyB64 = raw.key
    } catch {
      /* 不是文件 ⇒ 当 base64 用（也允许直接给 base64，便于夹具） */
    }
    const keyBuf = Buffer.from(keyB64, 'base64')
    if (keyBuf.length !== cfgx.KEY_LEN) {
      throw new Error(`--key 必须给出 ${cfgx.KEY_LEN} 字节密钥（含 key 字段的 JSON 文件，或裸 base64）`)
    }
    const epoch = Number(need('epoch'))
    if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('--epoch 必须是正整数')
    const doc = {
      version: cfgx.CONTENT_CIPHER_VERSION,
      network: need('network'),
      group: need('group'),
      epoch,
      keyId: cfgx.keyIdOf(keyBuf),
      issuedAt: nowIso(),
    }
    const sig = id.signPayloadWith(readFileSync(need('signer-key'), 'utf8'), cfgx.groupKeyCredentialPayload(doc))
    writePublic(need('out'), { doc, sig })
    process.stdout.write(`✓ 已签发组密钥凭据：${doc.network}/${doc.group} epoch=${doc.epoch} keyId=${doc.keyId}\n`)
  },

  /**
   * 🆕 序㉘ · 单 B：自检组密钥凭据（**篡改 `epoch` 必须失败** —— 失败关闭）。
   *
   * 可选交叉核对：`--group` / `--epoch` / `--key`（给了就与凭据里的值**逐字比对**，
   * 防"签的是 A、装的是 B"这种静默错配）。
   */
  'verify-group-key': () => {
    const raw = JSON.parse(readFileSync(need('file'), 'utf8'))
    const verdict = cfgx.verifyGroupKeyCredential(raw.doc, raw.sig, need('signer-pub').split(',').map((s) => s.trim()))
    if (!verdict.ok) {
      process.stderr.write(`✗ 验签失败：${verdict.reason}\n`)
      process.exit(1)
    }
    const d = verdict.doc
    if (typeof args.group === 'string' && args.group.trim() !== d.group) {
      throw new Error(`⛔ 组名不配：凭据 group=${d.group} ≠ 传入 ${args.group.trim()}`)
    }
    if (args.epoch !== undefined && Number(args.epoch) !== d.epoch) {
      throw new Error(`⛔ epoch 不配：凭据 epoch=${d.epoch} ≠ 传入 ${String(args.epoch)}`)
    }
    process.stdout.write(`✓ 验签通过：network=${d.network} group=${d.group} epoch=${d.epoch} keyId=${d.keyId}\n`)
  },

  /**
   * **根密钥恢复演练**：从纸质恢复码重建根私钥（⛔ 不用原文件），再签一份 SignerSet 并验通。
   *
   * 判据 = **三件都成立**才算过：① 恢复码能重建出**同一把**公钥 ② 用它签出的 SignerSet
   * 被原根公钥验通 ③ 与原私钥签出的签名**逐字节相同**（Ed25519 是确定性的 —— 这条让
   * "看起来恢复了其实不是同一把钥匙"无处藏身）。
   */
  'recover-root': () => {
    const hex = need('code').replace(/\s+/g, '')
    const der = Buffer.from(hex, 'hex')
    const pem = require('node:crypto')
      .createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      .export({ type: 'pkcs8', format: 'pem' })
    writeSecret(need('out'), pem, '重建出的根私钥')
    const pub = id.publicKeyOfPrivate(pem)
    process.stdout.write(`✓ 重建出的根公钥：${pub}\n`)
    process.stdout.write(`✓ 根指纹：${id.nodeKeyFingerprint(pub)}\n`)
    const expect = typeof args['expect-pub'] === 'string' ? args['expect-pub'].trim() : ''
    if (expect !== '') {
      if (pub !== expect) throw new Error('⛔ 重建出的公钥与期望不符 ⇒ 恢复码不是这把根的')
      process.stdout.write('✓ [判据①] 与期望根公钥逐字节一致\n')
    }
    // 判据② ③：只比公钥不够（"看起来一致"），要比**签名逐字节相同**（Ed25519 是确定性的）
    // 才能证明"重建出来的就是同一把钥匙"。传入 `--signers` 时用重建的私钥签一份 SignerSet：
    if (typeof args.signers === 'string' && args.signers.trim() !== '') {
      const signers = args.signers.split(',').map((s) => s.trim()).filter((s) => s !== '')
      const doc = { version: 1, network: need('network'), issuedAt: need('issued-at'), signers }
      const sig = id.signSignerSet(doc, pem)
      const anchor = expect !== '' ? expect : pub
      const verdict = id.verifySignerSet(doc, sig, [anchor])
      if (!verdict.ok) throw new Error(`⛔ [判据②] 重建的根签出的 SignerSet 验不过（${verdict.reason}）`)
      process.stdout.write(`✓ [判据②] 重建的根签出的 SignerSet（${signers.length} 把）经原根公钥验签通过\n`)
      const wantSig = typeof args['expect-sig'] === 'string' ? args['expect-sig'].trim() : ''
      if (wantSig !== '') {
        if (sig !== wantSig) throw new Error('⛔ [判据③] 签名与原根私钥签出的不一致 ⇒ 重建出的不是同一把钥匙')
        process.stdout.write('✓ [判据③] 签名与原根私钥签出的逐字节相同\n')
      }
    }
  },
}

function main() {
  const fn = COMMANDS[cmd]
  if (fn === undefined) {
    process.stderr.write(`unknown command: ${String(cmd)}\n可用：${Object.keys(COMMANDS).join(' | ')}\n`)
    process.exit(2)
  }
  fn()
}

try {
  main()
} catch (err) {
  process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
