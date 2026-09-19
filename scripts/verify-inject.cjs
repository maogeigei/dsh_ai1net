#!/usr/bin/env node
/**
 * verify-inject.cjs —— 注入脚本校验（**R1 起改为校验独立文件**）
 *
 * 历史（2026-09-13 事故）：注入脚本原先是 `proxy.ts` 里的 **TS 模板字面量**，里面的 `\n` 会在
 * 模板求值时先被转义 ⇒ 注入浏览器的那段 JS 变 SyntaxError ⇒ **整段脚本静默不执行**（浮层/自愈/助手全废）。
 * 当时"校验"只抽原始文本跑 new Function，**跳过了求值** ⇒ 假绿。
 *
 * 现在（R1）：脚本已外置到 `assets/inject/*.js`（纯 JS），本脚本负责：
 *   ① 断言这些文件存在、非空、且能通过 `node --check`（等价于浏览器解析）；
 *   ② 断言 `src/supervisor/proxy.ts` **不再**把注入脚本内联成模板字面量（防回退）；
 *   ③ 断言运行时串里不含 `<script` / `</script>`（会提前结束注入的 script 标签）。
 *
 * 用法：node scripts/verify-inject.cjs        退出码 0=合格 / 1=不合格
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, 'assets', 'inject')
const PROXY_SRC = path.join(ROOT, 'src', 'supervisor', 'proxy.ts')
let bad = 0

const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.js')) : []
console.log('=== 注入脚本（' + DIR + '，' + files.length + ' 个）===')
if (files.length === 0) { console.log('  ✗ assets/inject 下没有 .js（R1 要求注入脚本外置）'); bad++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vinj-'))
for (const f of files) {
  const abs = path.join(DIR, f)
  const code = fs.readFileSync(abs, 'utf8')
  if (code.trim().length < 100) { console.log('  ✗ ' + f + '：内容过短，疑似被清空'); bad++; continue }
  const t = path.join(tmp, f)
  fs.writeFileSync(t, code)
  const r = cp.spawnSync(process.execPath, ['--check', t], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.log('  ✗ ' + f + '：**语法失败**（浏览器里会静默失效）→ ' + String(r.stderr || '').split('\n').slice(0, 2).join(' '))
    bad++
  } else {
    const danger = ['</script', '<script'].filter((k) => code.includes(k))
    if (danger.length) { console.log('  ✗ ' + f + '：含 ' + danger.join('/') + '（会提前结束注入的 script 标签）'); bad++ }
    else console.log('  ✓ ' + f + ' 语法通过（' + code.length + ' 字符）')
  }
}
fs.rmSync(tmp, { recursive: true, force: true })

// 防回退：proxy.ts 不得再内联注入脚本
if (fs.existsSync(PROXY_SRC)) {
  const src = fs.readFileSync(PROXY_SRC, 'utf8')
  const inlined = /const SESSION_[A-Z_]+ = `/g.test(src)
  if (inlined) { console.log('  ✗ proxy.ts 仍把注入脚本内联成模板字面量（应改为 loadInject 读 assets/inject）'); bad++ }
  else {
    const loads = (src.match(/loadInject\('([^']+)'\)/g) || []).length
    console.log('  ✓ proxy.ts 已走 loadInject（' + loads + ' 处）')
    if (loads < files.length) { console.log('  ⚠️ loadInject 处数(' + loads + ') < 文件数(' + files.length + ')，确认是否漏用'); }
  }
}

// 防回退：proxy.ts 必须给**模块路径**与**HTML 外壳**都下发 `no-cache`。
//   由来：`/` 原先不带任何缓存头 ⇒ 浏览器启发式缓存外壳；而外壳内嵌带内容哈希 `rev` 的
//   bundle URL ⇒ 插件集合一变/实例一重启，旧外壳就一直去请求**已不存在的 rev** ⇒ 实例按契约 404
//   ⇒ 界面「Failed to load plugins」，**普通刷新命中缓存的外壳、复现不消失**（2026-09-14 真实事故）。
{
  const src = fs.readFileSync(PROXY_SRC, 'utf8')
  const hasPlugins = /targetPath\.startsWith\('\/plugins\/'\)/.test(src)
  const hasHtml = /includes\('text\/html'\)[\s\S]{0,200}cache-control/.test(src) || /text\/html[\s\S]{0,120}'no-cache'/.test(src)
  if (!hasPlugins || !hasHtml) {
    console.log(`  ✗ proxy.ts 缓存治理不完整（模块路径 no-cache=${hasPlugins} / HTML 外壳 no-cache=${hasHtml}）⇒ 插件一改用户就会"Failed to load plugins"`)
    bad++
  } else {
    console.log('  ✓ proxy.ts 缓存治理完整（/plugins/ 与 text/html 均 no-cache）')
  }
  // /plugins/ 必须有**由 URL 派生的 ETag + 304 短路** ——
  // 那条合并脚本 11 MB、未压缩，只靠 no-cache 会让浏览器**每次全量重下**
  // （实测经 CF 114.87 s）。rev 即修订标识 ⇒ 用 URL 派生 ETag 安全。
  const hasEtag = /const pluginEtag =/.test(src) && /createHash\('sha1'\).update\(targetPath\)/.test(src)
  const hasShort = /writeHead\(304, \{ etag: pluginEtag/.test(src)
  const etagOut = /headers\.etag = pluginEtag/.test(src)
  if (!hasEtag || !hasShort || !etagOut) {
    console.log(`  ✗ proxy.ts 缺 /plugins/ 的 ETag 条件请求短路（etag=${hasEtag} 304短路=${short} 透出=${etagOut}）`.replace('${short}', String(hasShort)))
    bad++
  } else {
    console.log('  ✓ proxy.ts 有 /plugins/ ETag + 304 短路（省掉每次 11 MB 重下）')
  }
  // 陈旧 dsh-auth cookie 必须**回写浏览器删除**（否则 Cookie 头只增不减，
  // 涨到 ~15 KB 就被 431 拒在 CF/nginx，请求到不了平台 —— 见实测）。
  const hasStale = /const staleNames =/.test(src) && /Max-Age=0/.test(src) && /startsWith\('dsh-auth-'\)/.test(src)
  if (!hasStale) {
    console.log('  ✗ proxy.ts 缺「陈旧 dsh-auth cookie 回写清理」（Cookie 头会只增不减 ⇒ 431）')
    bad++
  } else {
    console.log('  ✓ proxy.ts 会清理陈旧 dsh-auth cookie（防 Cookie 头无限增长）')
  }
}

console.log(bad ? '结论：' + bad + ' 项不合格 ❌ —— 别推上线' : '结论：全部合格 ✅')
process.exit(bad ? 1 : 0)
