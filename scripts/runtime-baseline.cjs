#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * 运行时版本基线巡检。
 *
 * 目的：**保证实例共享的基础运行时（Python / pip / node / npm）版本稳定**，
 * 避免"版本差异导致插件功能无法使用"。
 *
 * 背景：运行时是平台在 `/usr/local/dsh-runtime/` 装的可移植发行版，
 * 实例内 `/usr` 只读 → 理论上改不了；本脚本是**观测兜底** ——
 * 一旦版本偏离基线（例：有人在宿主上手动装/换了版本），立刻告警，而不是等插件坏掉才发现。
 *
 * 用法：
 *   node runtime-baseline.cjs            # 对比，偏离则退出码 1（cron 会记日志）
 *   node runtime-baseline.cjs --accept   # 主动把当前版本写入基线（升级运行时后执行）
 */
const { execFileSync } = require('node:child_process')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')

const BASE = require('node:path').join(cfg.stateDir(), 'runtime-baseline.json')
const ACCEPT = process.argv.includes('--accept')

const run = (cmd, args) => {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).trim().split('\n')[0] }
  catch (e) { return `ERR:${String(e.message).split('\n')[0].slice(0, 60)}` }
}
const ver = (cmd, args) => (run(cmd, args).match(/\d+\.\d+(\.\d+)?/) ?? ['?'])[0]

const probe = () => ({
  rg: ver('/usr/local/bin/rg', ['--version']),
  jq: ver('/usr/local/bin/jq', ['--version']),
  ffmpeg: (run('/usr/local/bin/ffmpeg', ['-version']).match(/ffmpeg version (\S+)/)?.[1] ?? '?'),
  python3: ver('/usr/local/bin/python3', ['-V']),
  pip3: ver('/usr/local/bin/pip3', ['-V']),
  node: ver('/usr/local/bin/node', ['-v']),
  npm: ver('/usr/local/bin/npm', ['-v']),
  runtimePinned: existsSync('/usr/local/dsh-runtime/VERSION')
    ? (readFileSync('/usr/local/dsh-runtime/VERSION', 'utf8').match(/^python_version=(.+)$/m)?.[1] ?? '?')
    : 'MISSING',
})

const now = probe()
if (ACCEPT || !existsSync(BASE)) {
  writeFileSync(BASE, JSON.stringify({ acceptedAt: new Date().toISOString(), versions: now }, null, 2) + '\n')
  console.log(`==> 基线已写入 ${BASE}`)
  console.log('    ', JSON.stringify(now))
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASE, 'utf8'))
const drift = Object.keys(now).filter((k) => base.versions[k] !== now[k])
if (drift.length === 0) {
  console.log(`ok 运行时版本与基线一致：${JSON.stringify(now)}`)
  process.exit(0)
}
console.log('!! 运行时版本漂移')
for (const k of drift) console.log(`   ${k}: 基线 ${base.versions[k]} → 现在 ${now[k]}`)
console.log(`   基线时间 ${base.acceptedAt}；若本次是有意升级，执行：node runtime-baseline.cjs --accept`)
process.exit(1)
