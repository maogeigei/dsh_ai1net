#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * ws-cleanup.cjs —— 用户工作区（ws）定期清理 + 磁盘画像
 *
 * 分三档（**判定依据只有"路径/文件名模式 + 年龄"**，因为无法可靠区分"AI 写的"）：
 *   T1 明确垃圾/平台产物  → 直接清（白名单精确匹配）
 *   T2 临时脚本（一次性、无复用价值）→ 超过 N 天未修改才清（默认 90 天）
 *   T3 其余一切（文档/表格/图片/视频/数据/目录）→ **永不自动删**，只统计
 *
 * 安全：默认 dry-run；--apply 时一律 `mv` 到 <userRoot>/trash/<日期>-ws-cleanup/（保留 30 天可恢复）；
 *       仅当该用户 ws ≥ --threshold MB 才动手（默认 2048 MB）。
 *
 * 用法：
 *   node ws-cleanup.cjs                          # dry-run + 画像
 *   node ws-cleanup.cjs --apply                  # 执行（含阈值判断）
 *   node ws-cleanup.cjs --apply --threshold 1024 --days 60
 *   node ws-cleanup.cjs --user-id <uuid>
 */
const { execFileSync } = require('node:child_process')
const { existsSync, lchownSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } = require('node:fs')
const { join, extname, basename } = require('node:path')
const Database = require('better-sqlite3')

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const num = (flag, dflt) => { const i = argv.indexOf(flag); const v = i >= 0 ? Number(argv[i + 1]) : NaN; return Number.isFinite(v) ? v : dflt }
const THRESHOLD_MB = num('--threshold', 2048)
const DAYS = num('--days', 90)
const idx = argv.indexOf('--user-id')
const ONLY = idx >= 0 ? argv[idx + 1] : ''
/** `--reclaim-only` = 只做属主回收，不跑清理（供高频 cron 用，与阈值无关）。 */
const RECLAIM_ONLY = argv.includes('--reclaim-only')
const STAMP = new Date().toISOString().slice(0, 10)
const CUTOFF = Date.now() - DAYS * 86400_000

// T1：平台产物/明确垃圾（精确名或后缀）；T2：一次性脚本（仅"顶层脚本文件"才算，避免误伤项目目录里的源码）
const T1_DIRS = ['.local', '.cache', '.poc-backup', 'poc', '__pycache__', '.pytest_cache', 'node_modules', '.ipynb_checkpoints']
const T1_SUFFIX = ['.tgz', '.tmp', '.log', '.bak', '.part', '.crdownload']
const T2_EXT = new Set(['.py', '.js', '.mjs', '.cjs', '.sh', '.bash', '.ps1', '.psm1', '.bat', '.cmd', '.ts', '.ipynb', '.sql'])

const duKB = (p) => { try { return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split(/\s+/)[0]) * 1024 } catch { return 0 } }
const fmt = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB')

/**
 * 属主回收：把用户工作区里**非该用户属主**的项 chown 回该用户。
 *
 * 根因：平台以 **root** 执行 `pnpm`，且把 `HOME` 指向用户工作区
 * （`src/web/routes/business-plugins.ts` 的 `pnpmEnv`）——
 * 因为要与 dsh 实例共用同一个 pnpm store，否则报 `ERR_PNPM_UNEXPECTED_STORE`（不能用别处的 HOME 绕）。
 * 副作用是 pnpm 在用户家目录建出 **root 属主**的 `.local/`（`.local/share/pnpm`）→
 * 用户之后再 `pip install --user` / npm user-prefix 就报 `Permission denied`
 * ——「在自己的目录里装不了包」（2026-09-11 实证）。
 *
 * 本函数**只 chown、不删除**：用户资产不受影响；root 建的 pnpm store 改属主后 pnpm 依旧可读写。
 * 与清理阈值**无关**，永远执行；不跟随软链（用 lstat + lchown）。
 */
function reclaimOwnership(root, uid) {
  let fixed = 0
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const p = join(dir, e)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.uid !== uid || st.gid !== uid) {
        try { lchownSync(p, uid, uid); fixed += 1 } catch { /* 尽力而为 */ }
      }
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
    }
  }
  walk(root)
  return fixed
}

const db = new Database(cfg.dbFile(), { readonly: true })
const users = db.prepare('SELECT id, username, uid, home_dir FROM users').all().filter((u) => ONLY === '' || u.id === ONLY)

for (const u of users) {
  const ws = join(u.home_dir, '..', 'ws')
  if (!existsSync(ws)) { console.log(`  ${u.username}: NO_WS`); continue }

  // 属主回收 —— 与阈值无关，always 执行（默认 dry-run 只报告，--apply 才动手）。
  const reclaimable = (() => {
    let n = 0
    const walk = (dir) => {
      let entries; try { entries = readdirSync(dir) } catch { return }
      for (const e of entries) {
        const p = join(dir, e); let st
        try { st = lstatSync(p) } catch { continue }
        if (st.uid !== u.uid || st.gid !== u.uid) n += 1
        if (st.isDirectory() && !st.isSymbolicLink()) walk(p)
      }
    }
    walk(ws); return n
  })()
  if (reclaimable > 0) {
    if (APPLY) {
      const fixed = reclaimOwnership(ws, u.uid)
      console.log(`  ${u.username}: 属主回收 ${fixed} 项 → ${u.uid}:${u.uid}（平台以 root 跑 pnpm 的残留）`)
    } else {
      console.log(`  ${u.username}: 发现 ${reclaimable} 项非本用户属主（--apply 时回收）`)
    }
  }
  if (RECLAIM_ONLY) continue

  const wsBytes = duKB(ws)
  const t1 = [], t2 = []  // T2 可被 ws/.keep 豁免
  let otherBytes = 0, otherCount = 0

  // 平台自建 bundle 以 `file:<ws>/xxx.tgz` 安装（如
  // 自研 bundle）。T1 的 `.tgz` 规则会删掉它们 → profile 的 dependencies 指向
  // 不存在的文件 → 之后**任何 pnpm 操作**（含用户启用功能插件）都 ENOENT 失败。
  // 故：凡被该用户任一 profile 的 `file:` 依赖引用的 ws 文件名，一律豁免 T1。
  const protectedNames = new Set()
  try {
    const profRoot = join(u.home_dir, 'profiles')
    if (existsSync(profRoot)) {
      for (const pname of readdirSync(profRoot)) {
        const pkgPath = join(profRoot, pname, 'package.json')
        if (!existsSync(pkgPath)) continue
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        for (const spec of Object.values(pkg.dependencies ?? {})) {
          if (typeof spec === 'string' && spec.startsWith('file:')) protectedNames.add(basename(spec.slice(5)))
        }
      }
    }
  } catch { /* 读不到就不豁免，保持原行为 */ }
  for (const entry of readdirSync(ws)) {
    const p = join(ws, entry)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) {
      if (T1_DIRS.includes(entry)) { t1.push({ p, size: duKB(p) }); continue }
      otherBytes += duKB(p); otherCount += 1  // 目录一律算用户资产（T3）
      continue
    }
    const ext = extname(entry).toLowerCase()
    // 被 profile 引用的平台 bundle 包不参与清理（体积计入"资产"）。
    if (protectedNames.has(entry)) { otherBytes += st.size; otherCount += 1; continue }
    if (T1_SUFFIX.includes(ext)) { t1.push({ p, size: st.size }); continue }
    if (T2_EXT.has(ext) && st.mtimeMs < CUTOFF) { t2.push({ p, size: st.size, mtime: st.mtime }); continue }
    otherBytes += st.size; otherCount += 1
  }

  // .keep 豁免：ws 顶层放一个 .keep 文件 → 该用户**跳过 T2**（一次性脚本不清理），T1 仍清
  const keepAll = existsSync(join(ws, '.keep'))
  if (keepAll && t2.length > 0) {
    console.log(`     (.keep 已存在 → T2 保留 ${t2.length} 项，不清理)`)
    t2.length = 0
  }
  const t1B = t1.reduce((a, c) => a + c.size, 0), t2B = t2.reduce((a, c) => a + c.size, 0)
  const over = wsBytes >= THRESHOLD_MB * 1048576
  console.log(`  ${u.username}: ws=${fmt(wsBytes)} (${over ? '≥' : '<'} 阈值 ${THRESHOLD_MB}MB) | T1=${t1.length}项/${fmt(t1B)} | T2=${t2.length}项(>${DAYS}天)/${fmt(t2B)} | 资产=${otherCount}项/${fmt(otherBytes)}`)
  for (const c of t1) console.log(`     T1 ${basename(c.p)}  ${fmt(c.size)}`)
  for (const c of t2) console.log(`     T2 ${basename(c.p)}  ${fmt(c.size)}  (mtime ${c.mtime.toISOString().slice(0, 10)})`)

  if (APPLY && over && (t1.length + t2.length) > 0) {
    const trash = join(u.home_dir, '..', 'trash', `${STAMP}-ws-cleanup`)
    mkdirSync(trash, { recursive: true })
    for (const c of [...t1, ...t2]) {
      const dest = join(trash, c.p.slice(ws.length + 1).replace(/\//g, '__'))
      try { execFileSync('mv', [c.p, dest]); execFileSync('chown', ['-R', `${u.uid}:${u.uid}`, dest]) }
      catch (e) { console.log(`     ! 失败 ${c.p}: ${String(e.message).split('\n')[0]}`) }
    }
    console.log(`     → 已清 ${t1.length + t2.length} 项 / ${fmt(t1B + t2B)} → trash/${STAMP}-ws-cleanup（保留 30 天）`)
  } else if (APPLY && !over) {
    console.log(`     (未超阈值，跳过清理)`)
  }
}
db.close()
console.log(APPLY ? 'done（已按阈值执行）' : 'done（dry-run，未改动）')
