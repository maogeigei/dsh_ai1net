#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * session-gc.cjs —— 会话记录保留期回收
 * 规则（用户 2026-09-11 定）：**每个用户的 sessions 达到阈值才触发**，清理 **超过 N 天** 的会话目录。
 * 结构：<home>/sessions/<workspace-slug>/<session-id>/session.jsonl.zstd
 * 安全：默认 dry-run；--apply 时 `mv` 到 <userRoot>/trash/<日期>-session-gc/（保留 30 天）。
 * 说明：storages/session_projcache 体积很小（KB 级），本脚本不动它（留作后续细化）。
 *
 * 用法：node session-gc.cjs [--apply] [--threshold 500] [--days 90] [--user-id <uuid>]
 */
const { execFileSync } = require('node:child_process')
const { existsSync, mkdirSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const Database = require('better-sqlite3')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const num = (flag, dflt) => { const i = argv.indexOf(flag); const v = i >= 0 ? Number(argv[i + 1]) : NaN; return Number.isFinite(v) ? v : dflt }
const THRESHOLD_MB = num('--threshold', 500)
const DAYS = num('--days', 90)
const idx = argv.indexOf('--user-id')
const ONLY = idx >= 0 ? argv[idx + 1] : ''
const STAMP = new Date().toISOString().slice(0, 10)
const CUTOFF = Date.now() - DAYS * 86400_000

const duKB = (p) => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024 } catch { return 0 } }
const fmt = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

const db = new Database(cfg.dbFile(), { readonly: true })
const users = db.prepare('SELECT id, username, uid, home_dir FROM users').all().filter((u) => ONLY === '' || u.id === ONLY)

for (const u of users) {
  const sessions = join(u.home_dir, 'sessions')
  if (!existsSync(sessions)) { console.log(`  ${u.username}: NO_SESSIONS`); continue }
  const total = duKB(sessions)
  const over = total >= THRESHOLD_MB * 1048576
  const stale = []
  for (const slug of readdirSync(sessions)) {
    const slugDir = join(sessions, slug)
    let st; try { st = statSync(slugDir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const sid of readdirSync(slugDir)) {
      const sd = join(slugDir, sid)
      let sst; try { sst = statSync(sd) } catch { continue }
      if (!sst.isDirectory()) continue
      const f = join(sd, 'session.jsonl.zstd')
      let mtime = sst.mtimeMs
      try { if (existsSync(f)) mtime = statSync(f).mtimeMs } catch {}
      if (mtime < CUTOFF) stale.push({ p: sd, size: duKB(sd), mtime: new Date(mtime) })
    }
  }
  const staleB = stale.reduce((a, c) => a + c.size, 0)
  console.log(`  ${u.username}: sessions=${fmt(total)} (${over ? '≥' : '<'} 阈值 ${THRESHOLD_MB}MB) | 超 ${DAYS} 天会话=${stale.length} 个 / ${fmt(staleB)}`)
  for (const c of stale) console.log(`     ${c.p.split('/').slice(-2).join('/')}  ${fmt(c.size)}  (${c.mtime.toISOString().slice(0, 10)})`)
  if (APPLY && over && stale.length > 0) {
    const trash = join(u.home_dir, '..', 'trash', `${STAMP}-session-gc`)
    mkdirSync(trash, { recursive: true })
    for (const c of stale) {
      const dest = join(trash, c.p.split('/').slice(-2).join('__'))
      try { execFileSync('mv', [c.p, dest]); execFileSync('chown', ['-R', `${u.uid}:${u.uid}`, dest]) }
      catch (e) { console.log(`     ! 失败 ${c.p}: ${String(e.message).split('\n')[0]}`) }
    }
    // 同步回收投影缓存：storages/session_projcache/sessions/<session-id>.json（按 id 精确匹配）
    const pcDir = join(u.home_dir, 'storages', 'session_projcache', 'sessions')
    let pcMoved = 0
    if (existsSync(pcDir)) {
      for (const c of stale) {
        const sid = c.p.split('/').pop()
        const pc = join(pcDir, `${sid}.json`)
        if (existsSync(pc)) {
          try { execFileSync('mv', [pc, join(trash, `projcache__${sid}.json`)]); pcMoved += 1 } catch {}
        }
      }
    }
    console.log(`     → 已移 ${stale.length} 个会话 / ${fmt(staleB)}${pcMoved > 0 ? `（+ ${pcMoved} 个投影缓存）` : ''} → trash/${STAMP}-session-gc（保留 30 天）`)
  } else if (APPLY && !over) console.log('     (未超阈值，跳过)')
}
db.close()
console.log(APPLY ? 'done（已按阈值执行）' : 'done（dry-run，未改动）')
