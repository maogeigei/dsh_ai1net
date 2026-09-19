#!/usr/bin/env node
/**
 * overlay-entropy.cjs —— 覆盖网络「低熵块治理」测熵探针（序㊺ · 只读 · 零第三方依赖）
 *
 * 口径（M1-a..d，见 `the design note`）：
 *   M1-a 种类数 / 重复率    —— 唯一块 id 数 ÷ 总块数 ＋ 完全重复块（同 id ≥ 2）清单
 *   M1-b 低熵块数 / 体积    —— 逐块经验 Shannon 熵（字节分布, bit/byte）＋ H 直方图
 *   M1-c 占首屏包比例       —— 低熵块字节 ÷ 总字节
 *   M1-d 子窗口熵（反向腿） —— 滑窗扫整份，给出低熵窗口**连续段的字节尺寸分布**
 *
 * 🔴 两条硬口径（⛔ 不许改）：
 *   1. **切分必须调用仓库里那份 `chunkify`**（默认 `../lib/net/relay/content/chunker.js`，
 *      由 `src/net/relay/content/chunker.ts` 编译而来）—— ⛔ 不复刻算法（复刻＝双源）。
 *      可用 `OVERLAY_CHUNKER=<path>` 覆盖（例如把探针与 chunker.js 一起放到取证目录）。
 *   2. **本探针只读本地文件**：⛔ 不 ssh、⛔ 不碰网络、⛔ 不写生产路径
 *      （取数由调用方完成 —— 见 `_tmp_seq45/` 的取数脚本，夹具模式封闭）。
 *
 * 用法：
 *   node scripts/overlay-entropy.cjs --in <S1 流文件> [--parts <parts.json>] [--json]
 *        [--window 4096] [--stride 4096] [--threshold 4.0] [--out <report.json>]
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? dflt : process.argv[i + 1]
}
const has = (name) => process.argv.includes(`--${name}`)

/** 经验 Shannon 熵（bit/byte）。空输入 ⇒ 0。 */
function entropyOf(buf) {
  if (buf.length === 0) return 0
  const counts = new Uint32Array(256)
  for (let i = 0; i < buf.length; i += 1) counts[buf[i]] += 1
  let h = 0
  const n = buf.length
  for (let b = 0; b < 256; b += 1) {
    const c = counts[b]
    if (c === 0) continue
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

/** H 直方图桶（0.5 bit/byte 一档，末档到 8）。 */
function histKey(h) {
  const lo = Math.min(7.5, Math.floor(h * 2) / 2)
  return `${lo.toFixed(1)}-${(lo + 0.5).toFixed(1)}`
}

/** 低熵窗口的**连续段**（非重叠窗口，stride = window）：返回段字节尺寸清单。 */
function lowEntropyRuns(buf, window, stride, threshold) {
  const sizes = []
  let run = 0
  for (let off = 0; off + window <= buf.length; off += stride) {
    const h = entropyOf(buf.subarray(off, off + window))
    if (h <= threshold) run += stride
    else if (run > 0) { sizes.push(run); run = 0 }
  }
  if (run > 0) sizes.push(run)
  return sizes
}

function bucketBytes(sizes) {
  const edges = [4096, 16384, 65536, 262144, 1048576, Infinity]
  const labels = ['<=4KiB', '4KiB-16KiB', '16KiB-64KiB', '64KiB-256KiB', '256KiB-1MiB', '>1MiB']
  const out = {}
  for (const l of labels) out[l] = 0
  for (const s of sizes) {
    for (let i = 0; i < edges.length; i += 1) {
      if (s <= edges[i]) { out[labels[i]] += 1; break }
    }
  }
  return out
}

async function main() {
  const inp = arg('in')
  if (inp === undefined) throw new Error('缺少 --in <文件>')
  const window = Number(arg('window', '4096'))
  const stride = Number(arg('stride', String(window)))
  const threshold = Number(arg('threshold', '4.0'))

  const chunkerPath = process.env.OVERLAY_CHUNKER
    ?? path.join(__dirname, '..', 'lib', 'net', 'relay', 'content', 'chunker.js')
  const chunker = await import(pathToFileURL(chunkerPath).href)
  const { chunkify, DEFAULT_BLOCK_SIZE } = chunker
  if (typeof chunkify !== 'function') throw new Error(`无法从 ${chunkerPath} 取到 chunkify`)

  const buf = fs.readFileSync(inp)
  const cut = chunkify(buf) // ⛔ 不传 blockSize ⇒ 用代码常量 DEFAULT_BLOCK_SIZE

  // ---- M1-a ----
  const freq = new Map()
  for (const c of cut.chunks) freq.set(c.id, (freq.get(c.id) ?? 0) + 1)
  const duplicates = [...freq.entries()].filter(([, n]) => n >= 2).map(([id, n]) => ({ id, count: n }))

  // ---- M1-b ----
  const perBlock = cut.chunks.map((c) => ({
    index: c.index,
    bytes: c.bytes.length,
    entropy: Number(entropyOf(c.bytes).toFixed(4)),
  }))
  const histogram = {}
  for (const b of perBlock) {
    const k = histKey(b.entropy)
    histogram[k] = (histogram[k] ?? 0) + 1
  }
  const lowBlocks = perBlock.filter((b) => b.entropy <= threshold)
  const lowBytes = lowBlocks.reduce((s, b) => s + b.bytes, 0)

  // ---- M1-d ----
  const runs = lowEntropyRuns(buf, window, stride, threshold)

  // ---- S2：按 combo 边界切片（每份 combo = 一份独立分发内容）----
  let s2 = null
  const partsFile = arg('parts')
  if (partsFile !== undefined) {
    const parts = JSON.parse(fs.readFileSync(partsFile, 'utf8'))
    const contents = []
    let off = 0
    for (const p of parts) {
      const n = Number(p.bytes) || 0
      if (n === 0) { contents.push({ order: p.order, bytes: 0, blocks: 0, note: `zero-bytes(code=${p.code})` }); continue }
      const c = chunkify(Buffer.from(buf.subarray(off, off + n)))
      off += n
      const es = c.chunks.map((x) => Number(entropyOf(x.bytes).toFixed(4)))
      contents.push({
        order: p.order,
        bytes: n,
        blocks: c.chunks.length,
        contentId: c.contentId,
        blockEntropies: es,
        min: Math.min(...es),
        max: Math.max(...es),
        lowEntropyBlocks: es.filter((e) => e <= threshold).length,
      })
    }
    s2 = {
      contents,
      lowEntropyContents: contents.filter((c) => c.lowEntropyBlocks > 0).map((c) => c.order),
      singleBlockContents: contents.filter((c) => c.blocks === 1).length,
      coveredBytes: off,
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    blockSize: DEFAULT_BLOCK_SIZE,
    threshold,
    window,
    stride,
    s1: {
      source: inp,
      bytes: buf.length,
      blocks: cut.chunks.length,
      uniqueBlockIds: freq.size,
      duplicateRatePct: Number(((1 - freq.size / cut.chunks.length) * 100).toFixed(4)),
      duplicates,
      lowEntropyBlocks: lowBlocks.length,
      lowEntropyBytes: lowBytes,
      lowEntropyRatioPct: Number(((lowBytes / buf.length) * 100).toFixed(6)),
      minBlockEntropy: Math.min(...perBlock.map((b) => b.entropy)),
      maxBlockEntropy: Math.max(...perBlock.map((b) => b.entropy)),
      histogram,
      perBlock,
    },
    m1d: {
      windows: Math.floor(buf.length / window),
      lowEntropyRuns: runs.length,
      runBytesTotal: runs.reduce((s, x) => s + x, 0),
      runBytesMin: runs.length ? Math.min(...runs) : 0,
      runBytesMax: runs.length ? Math.max(...runs) : 0,
      sizeHistogram: bucketBytes(runs),
      topRuns: [...runs].sort((a, b) => b - a).slice(0, 10),
    },
    s2,
  }

  const out = arg('out')
  if (out !== undefined) fs.writeFileSync(out, JSON.stringify(report, null, 2))
  if (has('json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }

  const L = []
  L.push(`=== M1 读数（blockSize=${DEFAULT_BLOCK_SIZE} threshold=${threshold} window=${window} stride=${stride}）===`)
  L.push(`[S1] ${inp}  bytes=${buf.length}  blocks=${cut.chunks.length}  unique=${freq.size}  dupRate=${report.s1.duplicateRatePct}%`)
  L.push(`[M1-a] 完全重复块=${duplicates.length}`)
  L.push(`[M1-b] 低熵块=${lowBlocks.length}  低熵字节=${lowBytes}  Hmin=${report.s1.minBlockEntropy} Hmax=${report.s1.maxBlockEntropy}`)
  L.push(`[M1-b] H 直方图=${JSON.stringify(histogram)}`)
  L.push(`[M1-c] 低熵字节占比=${report.s1.lowEntropyRatioPct}%`)
  L.push(`[M1-d] 低熵窗口段=${runs.length} 段字节total=${report.m1d.runBytesTotal} min=${report.m1d.runBytesMin} max=${report.m1d.runBytesMax}`)
  L.push(`[M1-d] 段尺寸直方图=${JSON.stringify(report.m1d.sizeHistogram)}`)
  L.push(`[M1-d] 最大10段=${JSON.stringify(report.m1d.topRuns)}`)
  if (s2 !== null) {
    L.push(`[S2] 内容数=${s2.contents.length} 单块内容=${s2.singleBlockContents} 低熵内容=${s2.lowEntropyContents.length} 覆盖字节=${s2.coveredBytes}`)
    for (const c of s2.contents) {
      L.push(`   #${c.order} bytes=${c.bytes} blocks=${c.blocks} Hmin=${c.min ?? '-'} low=${c.lowEntropyBlocks}`)
    }
  }
  process.stdout.write(L.join('\n') + '\n')
}

main().catch((e) => { process.stderr.write(`overlay-entropy 失败: ${e.message}\n`); process.exit(1) })
