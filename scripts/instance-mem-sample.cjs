#!/usr/bin/env node
const cfg = require('../config/index.cjs')
/**
 * instance-mem-sample.cjs —— 实例内存用量采样 + 阈值告警（cron 每 10 分钟；只读 + 追加式写一个 json）
 *
 * 为什么需要：本机内核 5.10 的 cgroup v2 **没有 `memory.peak`**（5.19+ 才有），
 * 因此 systemd 的 `MemoryPeak` 属性恒为 `[not set]`，`systemctl show` 也拿不到历史峰值。
 * 没有峰值数据，「MemoryMax 该定 384 还是能再降」就只能拍脑袋。
 * 本脚本把所有 `dsh-*.scope` 的 `memory.current` 记一次，按 **uid** 维护历史峰值
 * （scope 每次重启都换名字，所以按 uid 聚合才连续），为配额调整提供依据。
 *
 * 2026-09-12新增**阈值告警**：同一 uid 连续 `HIGH_STREAK` 次采样都 ≥
 * `limitMiB × HIGH_PCT` 时，日志行尾部追加 `⚠ 连续 N 次 ≥ 85%`，并给整行加 `WARN` 前缀（便于 grep）。
 * 阈值可用 env 覆盖：`DSH_MEM_ALERT_PCT`（默认 0.85）/ `DSH_MEM_ALERT_STREAK`（默认 3）。
 * 未达「连续」但已达单次高位时，也会标注 `（高位 N%，x/3）`，便于观察爬升趋势。
 *
 * ⚠️ 为什么要配套把 cron 从「每小时」提到「每 10 分钟」：每小时 × 连续 3 次 = 3 小时才报，
 * 而实例 OOM 常发生在分钟级（实测 guest 20:11:10 被 OOM kill，上一次采样还是 19:35），
 * 小时级采样根本抓不到，等于没有预警。10 分钟 × 3 次 = 30 分钟，才有实际提前量。
 *
 * 输出 `<platform-dir>/state/instance-mem-peak.json`：
 *   { "updatedAt": <ms>, "uids": { "<uid>": { peakMiB, peakAt, lastMiB, samples, unit, limitMiB, pct, highStreak } } }
 *
 * 用法：node instance-mem-sample.cjs [--print]
 */
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const STATE = cfg.stateDir()
const OUT = `${STATE}/instance-mem-peak.json`

// ⚠️ systemd 的 MemoryCurrent / MemoryMax 单位是**字节**（不是 KB）。
// 写成 /1024 会得到 1024 倍的假数字（首次运行实测：98 MiB 显示成 100336 MiB）。
const MiB = (bytes) => Math.round(Number(bytes) / 1048576)

// 阈值告警参数（env 可覆盖：DSH_MEM_ALERT_PCT / DSH_MEM_ALERT_STREAK）
const HIGH_PCT = Number(process.env.DSH_MEM_ALERT_PCT ?? 0.85)
const HIGH_STREAK = Number(process.env.DSH_MEM_ALERT_STREAK ?? 3)
// 采样间隔下限：距上次采样不足此时长（默认 60s）视为「同一轮内的重复触发」（手动调试 / 人工跑），
// 只保持计数、不累计也不清零 —— 否则连续手动跑几次就会把 highStreak 顶到阈值造成误告警。
const MIN_SAMPLE_GAP_MS = Number(process.env.DSH_MEM_ALERT_MIN_GAP_MS ?? 60000)

function scopes() {
  try {
    const out = execFileSync(
      'systemctl',
      ['list-units', '--type=scope', '--all', '--no-legend', '--plain', 'dsh-*.scope'],
      { encoding: 'utf8' },
    )
    return out
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((u) => /^dsh-\d+-[0-9a-f]+\.scope$/.test(u))
  } catch {
    return []
  }
}

function show(unit, prop) {
  try {
    return execFileSync('systemctl', ['show', unit, `-p${prop}`, '--value'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const now = Date.now()
let db = { updatedAt: now, uids: {} }
try {
  db = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  if (typeof db.uids !== 'object' || db.uids === null) db.uids = {}
} catch {
  /* 首次运行或文件损坏 → 重建 */
}

const seen = []
for (const unit of scopes()) {
  const uid = (unit.match(/^dsh-(\d+)-/) || [])[1]
  if (!uid) continue
  const cur = show(unit, 'MemoryCurrent')
  if (cur === '' || cur === '[not set]') continue
  const max = show(unit, 'MemoryMax')
  const lastMiB = MiB(cur)
  const limitMiB = max && max !== 'infinity' ? MiB(max) : null
  const prev = db.uids[uid] ?? { peakMiB: 0, peakAt: null, samples: 0, highStreak: 0 }
  const pct = limitMiB ? lastMiB / limitMiB : 0
  const tooSoon = prev.updatedAt ? now - Date.parse(prev.updatedAt) < MIN_SAMPLE_GAP_MS : false
  const highStreak = tooSoon
    ? (prev.highStreak ?? 0)
    : limitMiB && pct >= HIGH_PCT
      ? (prev.highStreak ?? 0) + 1
      : 0
  const entry = {
    peakMiB: Math.max(prev.peakMiB ?? 0, lastMiB),
    peakAt: lastMiB >= (prev.peakMiB ?? 0) ? new Date(now).toISOString() : (prev.peakAt ?? null),
    lastMiB,
    limitMiB,
    pct: Math.round(pct * 100),
    highStreak,
    samples: (prev.samples ?? 0) + 1,
    unit,
    updatedAt: new Date(now).toISOString(),
  }
  db.uids[uid] = entry
  seen.push({ uid, ...entry })
}
db.updatedAt = now

try {
  fs.mkdirSync(STATE, { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(db, null, 2) + '\n')
} catch (err) {
  console.error(`写入 ${OUT} 失败: ${String(err.message ?? err)}`)
  process.exitCode = 1
}

let alerted = 0
const line = seen
  .map((s) => {
    let note = ''
    if (s.limitMiB && s.highStreak >= HIGH_STREAK) {
      alerted++
      note = ` ⚠ 内存连续 ${s.highStreak} 次 ≥ ${Math.round(HIGH_PCT * 100)}%（${s.lastMiB}/${s.limitMiB} MiB）`
    } else if (s.limitMiB && s.pct >= Math.round(HIGH_PCT * 100)) {
      note = ` （高位 ${s.pct}%，${s.highStreak}/${HIGH_STREAK}）`
    }
    return `uid ${s.uid}: 当前 ${s.lastMiB} MiB / 峰值 ${s.peakMiB} MiB / 上限 ${s.limitMiB ?? '-'} MiB${note}`
  })
  .join(' | ')
if (process.argv.includes('--print') || seen.length > 0) {
  const tag = alerted > 0 ? 'WARN ' : ''
  console.log(`[${new Date(now).toISOString()}] ${tag}${seen.length} 个实例；${line || '无运行中实例'}`)
}
