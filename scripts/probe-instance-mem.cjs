#!/usr/bin/env node
/**
 * probe-instance-mem.cjs —— 实例内存分解探针（只读）
 *
 * 回答"一个用户实例凭什么占这么多内存"：把 RSS 拆成
 *   ① 共享只读代码页（node 二进制 + 原生模块）—— **多实例物理上只占一份**
 *   ② 私有匿名页（V8 堆 / 线程栈 / Buffer）—— 每实例真正独占，也是 cgroup 计数的口径
 * 并列出最大的内存段，便于识别是不是某个大依赖（sharp / koffi / node-pty 等）。
 *
 * 用法（root 在宿主执行）：
 *   node probe-instance-mem.cjs                 # 自动找实例进程 + 打印空 node 基线
 *   node probe-instance-mem.cjs <pid> [pid...]  # 指定进程
 */
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const MiB = (kb) => Math.round(kb / 1024)

function rollup(pid) {
  const s = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8')
  const num = (k) => Number((s.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0)
  return {
    rss: num('Rss'),
    pss: num('Pss'),
    shared: num('Shared_Clean'),
    privateDirty: num('Private_Dirty'),
    privateClean: num('Private_Clean'),
    anon: num('Anonymous'),
    swap: num('Swap'),
  }
}

function biggestSegments(pid, top = 12) {
  const smaps = fs.readFileSync(`/proc/${pid}/smaps`, 'utf8')
  const blocks = smaps.split(/(?=^[0-9a-f]+-[0-9a-f]+ )/m).filter((b) => /^[0-9a-f]+-[0-9a-f]+ /.test(b))
  const rows = blocks.map((b) => {
    const nameM = b.match(/^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+ +(.*)$/m)
    return {
      rss: Number((b.match(/^Rss:\s+(\d+)/m) || [])[1] || 0),
      anon: Number((b.match(/^Anonymous:\s+(\d+)/m) || [])[1] || 0),
      name: nameM ? nameM[1].trim() : '[anon]',
    }
  })
  rows.sort((a, b) => b.rss - a.rss)
  return rows.slice(0, top)
}

/** 按"归属"聚合：每个段拆 Shared_Clean/Dirty 与 Private_Clean/Dirty，按私有量排序。
 *  这能直接回答"私有内存到底是什么" —— 是 node 二进制被写时复制，还是 JS 堆。 */
function breakdownByOwner(pid, top = 10) {
  const smaps = fs.readFileSync(`/proc/${pid}/smaps`, 'utf8')
  const blocks = smaps.split(/(?=^[0-9a-f]+-[0-9a-f]+ )/m).filter((b) => /^[0-9a-f]+-[0-9a-f]+ /.test(b))
  const agg = new Map()
  for (const b of blocks) {
    const nameM = b.match(/^[0-9a-f]+-[0-9a-f]+ \S+ \S+ \S+ \S+ +(.*)$/m)
    const name = (nameM ? nameM[1].trim() : '') || '[anon]'
    const g = (k) => Number((b.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1] || 0)
    const cur = agg.get(name) || { rss: 0, shared: 0, priv: 0 }
    cur.rss += g('Rss')
    cur.shared += g('Shared_Clean') + g('Shared_Dirty')
    cur.priv += g('Private_Clean') + g('Private_Dirty')
    agg.set(name, cur)
  }
  return [...agg.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.priv - a.priv)
    .slice(0, top)
}

function findInstances() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,user,args', '--no-headers'], { encoding: 'utf8' })
    return out
      .split('\n')
      .filter((l) => {
        // 只认真正的实例进程；跳过 bwrap 包装进程（它的参数里同样含 "dsh --profile"，
        // 且只是 ~1 MiB 的转发壳，混进来会污染"最大内存段"清单）。
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)
        if (!m) return false
        return /(^|\s)node\s+\S*dsh\s+--profile/.test(m[3]) && !/bwrap/.test(m[3])
      })
      .map((l) => {
        const parts = l.trim().split(/\s+/)
        return { pid: parts[0], user: parts[1] }
      })
  } catch {
    return []
  }
}

/** 空 node 基线：用来回答"dsh 自身让一个 node 进程多花多少"。 */
function baseline() {
  const code = `
    const fs=require('node:fs');
    const s=fs.readFileSync('/proc/self/smaps_rollup','utf8');
    const n=k=>Number((s.match(new RegExp('^'+k+':\\\\s+(\\\\d+)','m'))||[])[1]||0);
    process.stdout.write(JSON.stringify({rss:n('Rss'),pss:n('Pss'),shared:n('Shared_Clean'),priv:n('Private_Dirty')}));`
  const out = execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' })
  return JSON.parse(out)
}

const args = process.argv.slice(2)
const targets = args.length > 0 ? args.map((p) => ({ pid: p, user: '?' })) : findInstances()

console.log('=== 环境 ===')
console.log('node', process.version, '| enableCompileCache:', typeof require('node:module').enableCompileCache)
console.log('NODE_OPTIONS =', process.env.NODE_OPTIONS ?? '(未设置)')

const b = baseline()
console.log(
  `空 node 基线：Rss ${MiB(b.rss)} MiB | 共享 ${MiB(b.shared)} | 私有 ${MiB(b.priv)} | 虚拟已用 ${MiB(b.pss)} MiB`,
)

for (const t of targets) {
  let r
  try {
    r = rollup(t.pid)
  } catch (e) {
    console.log(`\n=== pid ${t.pid}：读不到（${String(e.message).slice(0, 60)}）`)
    continue
  }
  const cmd = fs.readFileSync(`/proc/${t.pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
  console.log(`\n=== pid ${t.pid}（user ${t.user}）===`)
  console.log(cmd.slice(0, 150))
  console.log(
    `RSS ${MiB(r.rss)} MiB = 共享代码 ${MiB(r.shared)} + 私有 ${MiB(r.privateDirty)}\n` +
      `  PSS ${MiB(r.pss)} MiB（按共享比例摊分后的"真实归属"）| 匿名 ${MiB(r.anon)} | swap ${MiB(r.swap)}`,
  )
  console.log(`  dsh 自身开销（相对空 node）：私有 +${MiB(r.privateDirty - b.priv)} MiB | RSS +${MiB(r.rss - b.rss)} MiB`)
  console.log('  最大的内存段：')
  for (const s of biggestSegments(t.pid)) {
    console.log(`    ${String(MiB(s.rss)).padStart(5)} MiB  (anon ${String(MiB(s.anon)).padStart(4)})  ${s.name.slice(0, 64)}`)
  }
  console.log('  按归属拆「共享 / 私有」（私有才是每实例独占，按私有量排序）：')
  for (const o of breakdownByOwner(t.pid)) {
    console.log(
      `    共享 ${String(MiB(o.shared)).padStart(4)} MiB | 私有 ${String(MiB(o.priv)).padStart(4)} MiB | 合计 ${String(MiB(o.rss)).padStart(4)} MiB  ${o.name.slice(0, 56)}`,
    )
  }
}
