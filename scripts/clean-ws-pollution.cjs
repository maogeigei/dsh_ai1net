#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * clean-ws-pollution.cjs —— 清理"平台安装插件"在用户工作区留下的污染
 *
 * 白名单（精确匹配，绝不碰其它内容）：
 *   ws/.local        pnpm store（旧 HOME=<ws> 造成）
 *   ws/.cache        pnpm metadata 缓存
 *   ws/.poc-backup   PoC 备份
 *   ws/poc           PoC 源码副本
 *   ws/*.tgz         安装用插件包（现在改为直接用 <platform-dir>/artifacts/ 不再复制）
 *
 * 用法：
 *   node clean-ws-pollution.cjs            # dry-run（默认，只打印）
 *   node clean-ws-pollution.cjs --apply    # 实际执行：mv 到 <userRoot>/trash/<日期>-ws-pollution/
 *   node clean-ws-pollution.cjs --apply --user-id <uuid>
 * 动作是**移动**（同盘 mv，秒级、可恢复），不是删除。
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const Database = require('better-sqlite3')

const APPLY = process.argv.includes('--apply')
const idx = process.argv.indexOf('--user-id')
const onlyId = idx >= 0 ? process.argv[idx + 1] : ''
const STAMP = new Date().toISOString().slice(0, 10)

const db = new Database(cfg.dbFile(), { readonly: true })
const users = db.prepare('SELECT id, username, uid, home_dir FROM users').all()
  .filter((u) => onlyId === '' || u.id === onlyId)

const du = (p) => {
  try {
    const out = execFileSync('du', ['-sk', p], { encoding: 'utf8' })
    return Number(out.split(/\s+/)[0]) * 1024
  } catch { return 0 }
}
const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

for (const u of users) {
  const ws = join(u.home_dir, '..', 'ws')
  if (!existsSync(ws)) { console.log(`  ${u.username}: NO_WS`); continue }
  const cands = []
  for (const rel of ['.local', '.cache', '.poc-backup', 'poc']) {
    const p = join(ws, rel)
    if (existsSync(p)) cands.push({ p, size: du(p) })
  }
  for (const f of readdirSync(ws)) {
    if (f.endsWith('.tgz')) {
      const p = join(ws, f)
      try { if (statSync(p).isFile()) cands.push({ p, size: statSync(p).size }) } catch {}
    }
  }
  const total = cands.reduce((a, c) => a + c.size, 0)
  console.log(`  ${u.username}: 候选 ${cands.length} 项 / ${fmt(total)}${APPLY ? ' → 移入回收站' : '（dry-run）'}`)
  for (const c of cands) console.log(`     - ${c.p.replace(ws, 'ws')}  ${fmt(c.size)}`)
  if (APPLY && cands.length > 0) {
    const trash = join(u.home_dir, '..', 'trash', `${STAMP}-ws-pollution`)
    mkdirSync(trash, { recursive: true })
    for (const c of cands) {
      const dest = join(trash, c.p.slice(ws.length + 1).replace(/\//g, '__'))
      try {
        execFileSync('mv', [c.p, dest])
        execFileSync('chown', ['-R', `${u.uid}:${u.uid}`, dest])
      } catch (e) { console.log(`     ! 移动失败 ${c.p}: ${String(e.message).split('\n')[0]}`) }
    }
    console.log(`     → 已移至 ${trash.replace(u.home_dir, 'home')}（保留 30 天，可整目录移回恢复）`)
  }
}
db.close()
console.log(APPLY ? 'done（已移动）' : 'done（dry-run，未改动）')
