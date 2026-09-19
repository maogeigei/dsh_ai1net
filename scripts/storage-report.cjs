#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * storage-report.cjs —— 每用户存储用量上报
 * 输出：/var/run/dsh-storage-report.json（供门户 GET /api/admin/storage 直接读取，避免每次请求都 du）
 * cron：每小时一次。
 */
const { execFileSync } = require('node:child_process')
const { existsSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const Database = require('better-sqlite3')

const OUT = process.env.DSH_STORAGE_REPORT ?? '/var/run/dsh-storage-report.json'
const WS_MB = Number(process.env.DSH_WS_THRESHOLD_MB ?? 2048)
const SESS_MB = Number(process.env.DSH_SESSIONS_THRESHOLD_MB ?? 1024)

const duKB = (p) => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024 } catch { return 0 } }
const db = new Database(cfg.dbFile(), { readonly: true })
const users = db.prepare('SELECT username, home_dir FROM users ORDER BY username').all()

const rows = users.map((u) => {
  const ws = join(u.home_dir, '..', 'ws'), sessions = join(u.home_dir, 'sessions'), trash = join(u.home_dir, '..', 'trash')
  const t1 = [], t2 = []
  // 仅统计顶层候选（与 ws-cleanup 口径一致），供管理员判断
  if (existsSync(ws)) {
    const { readdirSync, statSync } = require('node:fs')
    const T1_DIRS = ['.local', '.cache', '.poc-backup', 'poc', '__pycache__', '.pytest_cache', 'node_modules', '.ipynb_checkpoints']
    const T1_SUFFIX = ['.tgz', '.tmp', '.log', '.bak', '.part', '.crdownload']
    const T2_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.bash', '.ps1', '.psm1', '.bat', '.cmd', '.ts', '.ipynb', '.sql'])
    const CUTOFF = Date.now() - 90 * 86400_000
    for (const e of readdirSync(ws)) {
      const p = join(ws, e)
      let st; try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { if (T1_DIRS.includes(e)) t1.push({ name: e, size: duKB(p) }); continue }
      const dot = e.lastIndexOf('.')
      const ext = dot >= 0 ? e.slice(dot).toLowerCase() : ''
      if (T1_SUFFIX.includes(ext)) t1.push({ name: e, size: st.size })
      else if (T2_EXT.has(ext) && st.mtimeMs < CUTOFF) t2.push({ name: e, size: st.size })
    }
  }
  const wsB = existsSync(ws) ? duKB(ws) : 0
  const sessB = existsSync(sessions) ? duKB(sessions) : 0
  const trashB = existsSync(trash) ? duKB(trash) : 0
  return {
    username: u.username,
    ws: wsB, sessions: sessB, trash: trashB, total: wsB + sessB + trashB,
    wsOver: wsB >= WS_MB * 1048576, sessionsOver: sessB >= SESS_MB * 1048576,
    cleanableT1: t1.length, cleanableT2: t2.length,
    cleanableBytes: [...t1, ...t2].reduce((a, c) => a + c.size, 0),
    topCleanable: [...t1, ...t2].sort((a, b) => b.size - a.size).slice(0, 5).map((c) => `${c.name} (${(c.size / 1048576).toFixed(1)}MB)`),
  }
})
db.close()
const report = {
  generatedAt: new Date().toISOString(),
  thresholds: { wsMB: WS_MB, sessionsMB: SESS_MB, keepDays: { ws: 90, sessions: 365 }, trashKeepDays: 30 },
  totals: { ws: rows.reduce((a, r) => a + r.ws, 0), sessions: rows.reduce((a, r) => a + r.sessions, 0), trash: rows.reduce((a, r) => a + r.trash, 0) },
  users: rows,
}
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
const fmt = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + 'G' : (b / 1048576).toFixed(1) + 'M')
for (const r of rows) console.log(`  ${r.username}: ws=${fmt(r.ws)} sessions=${fmt(r.sessions)} trash=${fmt(r.trash)} | 可清 ${r.cleanableT1 + r.cleanableT2} 项/${fmt(r.cleanableBytes)}`)
console.log(`  → 已写入 ${OUT}`)
