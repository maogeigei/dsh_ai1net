#!/usr/bin/env node
/**
 * 覆盖网络 序⑥ · relay HMAC 密钥表增删（**运维小工具**，⛔ 非产品路径）。
 *
 * 为什么要有它：`/etc/dsh_ai1net/relay-keys.json` 是**直接编辑会毁掉整张表**的那类文件
 * （键 = 逻辑名 `<net>/<hostId>`，值 = 64 hex；写坏一个字符 ⇒ relay 起动即抛、
 * 全部节点同时被拒）。所以增删都走这个工具：**先备份、再原子写、写完自校验**。
 *
 * 用法：
 *   node scripts/overlay-relaykey-add.cjs --file /etc/dsh_ai1net/relay-keys.json --name ops/w-dev
 *   node scripts/overlay-relaykey-add.cjs --file … --name ops/w-dev --secret <64hex>
 *   node scripts/overlay-relaykey-add.cjs --file … --name ops/w-dev --remove
 *
 * @module scripts/overlay-relaykey-add
 */

'use strict'

const { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { randomBytes } = require('node:crypto')

const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const k = argv[i].slice(2)
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) args[k] = true
  else {
    args[k] = v
    i++
  }
}
if (typeof args.file !== 'string' || typeof args.name !== 'string') {
  process.stderr.write('usage: --file <relay-keys.json> --name <net/hostId> [--secret <64hex>] [--remove]\n')
  process.exit(2)
}

const table = JSON.parse(readFileSync(args.file, 'utf8'))
if (table === null || typeof table !== 'object' || Array.isArray(table)) {
  throw new Error(`${args.file} 不是对象`)
}
const before = Object.keys(table)
copyFileSync(args.file, `${args.file}.bak-seq6-${Date.now()}`)

if (args.remove === true) {
  if (!(args.name in table)) {
    process.stderr.write(`⚠ ${args.name} 不在表里（无需删）\n`)
  } else {
    delete table[args.name]
  }
} else {
  const secret =
    typeof args.secret === 'string' ? args.secret.trim().toLowerCase() : randomBytes(32).toString('hex')
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('secret 必须是 64 位 hex')
  table[args.name] = secret
}

const tmp = `${args.file}.tmp`
writeFileSync(tmp, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 })
renameSync(tmp, args.file)
chmodSync(args.file, 0o600)

// 自校验：用产品代码自己的装载器读一遍（键名/密钥形状非法会在这里炸）
const { loadKeysFile } = require('../lib/net/relay/keys.js')
const parsed = loadKeysFile(args.file)
process.stdout.write(
  `✓ ${args.file}：${before.length} → ${parsed.size} 条\n` +
    `  键：${[...parsed.keys()].join(', ')}\n` +
    (args.remove === true ? '' : `  ${args.name} 的 secret（仅本次打印，⛔ 别进日志）：${table[args.name]}\n`),
)
