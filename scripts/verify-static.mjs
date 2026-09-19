#!/usr/bin/env node
/**
 * verify-static.mjs —— 静态页不变量校验（2026-09-13 新增）
 *
 * 为什么需要：平台有 9 个静态页，其中 wake.html 承担"启动过渡页"（有 5 个 id 被内联 JS 依赖），
 * 而"去平台痕迹"（用户可见面不得出现 dsh_ai1net）是个**容易回归**的约束 ——
 * 新人加个页面忘了改名就会漏出去。把它变成 CI 可跑的判据。
 *
 * 用法：node scripts/verify-static.mjs        退出码 0=全绿 / 1=有违规
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = join(ROOT, 'web')
const BANNED = 'dsh_ai1net'          // 用户可见面不得出现的平台内部名
const WAKE_IDS = ['spin', 'step', 'acts', 'retry', 'note']   // wake.html 内联 JS 依赖的 id
// R5：已完成多语言迁移的页面（**迁移一页加一个**）。这些页不得再出现裸中文文案。
const I18N_PAGES = ['login.html', 'register.html', 'wake.html', 'index.html']

let bad = 0
const pages = readdirSync(WEB).filter((f) => f.endsWith('.html'))
console.log('=== 静态页不变量（' + pages.length + ' 页）===')

for (const f of pages) {
  const s = readFileSync(join(WEB, f), 'utf8')
  const problems = []
  const title = /<title[^>]*>([^<]*)<\/title>/.exec(s)
  if (!title || title[1].trim() === '') problems.push('缺 <title> 或为空')
  else if (title[1].includes(BANNED)) problems.push('title 含内部平台名: ' + title[1])
  if (s.includes(BANNED)) problems.push('页面正文含内部平台名（去痕迹约束）')

  // R5：**已迁移多语言的页面不得再出现裸中文文案** —— 用户可见文案必须走词条
  // （`data-i18n` / `I18N.t`）。注释不算文案，故先剥掉 HTML 与 JS 注释再判。
  // 只对白名单页生效 ⇒ 未迁移页仍允许中文，不会误拦（迁移一页就往 I18N_PAGES 加一个）。
  if (I18N_PAGES.includes(f)) {
    const stripped = s
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/[ \t]\/\/[^\n]*/g, '')   // 行尾注释（`code  // 说明`）也要剥（`https://` 不会被误伤：左邻是 `:` 不是空格）
    const cjk = stripped.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /[\u4e00-\u9fa5]/.test(l))
    if (cjk.length) {
      problems.push('已迁移多语言但仍有裸中文文案（行 ' + cjk.slice(0, 3).map(([n]) => n).join('/') + '…）')
    }
    if (!s.includes('/i18n.js')) problems.push('已迁移多语言但未引入 /i18n.js')
  }

  if (f === 'wake.html') {
    for (const id of WAKE_IDS) {
      if (!new RegExp('id="' + id + '"').test(s)) problems.push('缺 id="' + id + '"（内联 JS 依赖）')
    }
    if (!s.includes('instance_circuit_open')) problems.push('缺的熔断提示分支')
  }

  if (problems.length) { bad++; console.log('  ✗ ' + f + '：' + problems.join('；')) }
  else console.log('  ✓ ' + f + (title ? '（title=' + title[1] + '）' : ''))
}

// 内联 <script> 必须能被 JS 解析（2026-09-13 事故：脚本语法错误 = 静默失效）
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const tmp = mkdtempSync(join(tmpdir(), 'vstatic-'))
for (const f of pages) {
  const s = readFileSync(join(WEB, f), 'utf8')
  const blocks = [...s.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  blocks.forEach((code, i) => {
    const file = join(tmp, f.replace(/\W/g, '_') + '.' + i + '.js')
    writeFileSync(file, code)
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); console.log('  ✓ ' + f + ' 内联脚本#' + i + ' 语法通过') }
    catch (e) { bad++; console.log('  ✗ ' + f + ' 内联脚本#' + i + ' **语法失败**：' + String(e.stderr || e).split('\n').slice(0, 2).join(' ')) }
  })
}

// CSS/JS 资源也要过一遍去痕迹约束
for (const f of readdirSync(WEB).filter((f) => /\.(css|js)$/.test(f))) {
  const s = readFileSync(join(WEB, f), 'utf8')
  if (s.includes(BANNED)) { bad++; console.log('  ✗ ' + f + '：含内部平台名') }
  else console.log('  ✓ ' + f)
}

// SVG 资产单独过一遍（2026-09-19 新增）。
// 为什么必须查：**XML 注释里不允许出现两个连续 ASCII 连字符**，而 SVG 文件里写 CSS 变量名
// （双连字符加名字）是最自然的写法 ⇒ 一旦踩中，**整份 SVG 解析失败、图标静默不显示**，
// 页面与接口都不报任何错。第一版 favicon 就栽在这里（注释里写了 `--ink`），
// 是靠"用真解析器验一遍"才抓到的 ⇒ 把它做成可重跑的判据，而不是靠人记得。
for (const f of readdirSync(WEB).filter((f) => f.endsWith('.svg'))) {
  const s = readFileSync(join(WEB, f), 'utf8')
  const problems = []
  if (s.includes(BANNED)) problems.push('含内部平台名')
  if (!/^\s*<svg[\s>]/.test(s)) problems.push('未以 <svg 开头')
  if (!s.trimEnd().endsWith('</svg>')) problems.push('未以 </svg> 结尾')
  if (!/viewBox="0 0 \d+ \d+"/.test(s)) problems.push('缺 viewBox（缩放不可控）')
  for (const m of s.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1].includes('--')) {
      problems.push('XML 注释含双连字符（XML 语法不允许 ⇒ 整份 SVG 会解析失败、图标静默不显示）')
    }
  }
  if (problems.length) { bad++; console.log('  ✗ ' + f + '：' + problems.join('；')) }
  else console.log('  ✓ ' + f)
}

console.log(bad ? '结论：' + bad + ' 项不合格 ❌' : '结论：全部合格 ✅')
process.exit(bad ? 1 : 0)
