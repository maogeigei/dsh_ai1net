#!/usr/bin/env node
/**
 * verify-dsh-install.mjs —— 「平台内置 dsh 安装位置解析」回归（2026-09-14 · 修 P1）
 *
 * 为什么必须有：定位失败**不报错** —— 厂家目录读成空 ⇒ 前端「新增模型条目」只剩内置
 * DeepSeek；平台包计数为 0 ⇒ 兼容性预检退化成「平台包目录不可读」。两者都只在**另一种
 * 安装布局**（`npm root -g` = `/usr/lib/node_modules`）上出现，本机 `/usr/local` 布局
 * **永远测不出来** ⇒ 只有把解析规则钉死成断言，才能防回归。
 *
 * 用法：node scripts/verify-dsh-install.mjs     退出码 0=全绿 / 1=有失败
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const M = await import(pathToFileURL(join(ROOT, 'lib/web/dsh-install.js')).href)
const { dshPackageRoot, dshScopeDir, piAiDataDir, resetInstallPathsCache } = M

let failed = 0
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  if (!cond) failed++
}

/** 清掉所有相关 env，保证用例互不干扰。 */
const ENVS = [
  'DSH_PACKAGE_DIR',
  'DSH_AI1NET_PACKAGE_DIR',
  'DSH_COMPAT_ROOT',
  'DSH_AI1NET_COMPAT_ROOT',
  'DSH_AI1NET_DSH_BIN',
  'PI_AI_DATA_DIR',
  'DSH_AI1NET_PI_AI_DATA_DIR',
]
const clearEnv = () => {
  for (const k of ENVS) delete process.env[k]
  resetInstallPathsCache()
}

console.log('verify-dsh-install（P1：安装位置解析）\n')

// ── 1. env 覆盖（无条件优先，含本仓前缀别名与导出侧旧名）────────────────────────
console.log('[1] env 显式覆盖')
for (const k of ['DSH_PACKAGE_DIR', 'DSH_AI1NET_PACKAGE_DIR', 'DSH_COMPAT_ROOT', 'DSH_AI1NET_COMPAT_ROOT']) {
  clearEnv()
  process.env[k] = '/tmp/fake-root-' + k
  ok(`${k} 生效`, dshPackageRoot() === '/tmp/fake-root-' + k, dshPackageRoot())
}

// ── 2. 由「配置的 dsh 可执行文件」向上解出包根（**最可靠的一路**）────────────────
console.log('\n[2] 由 dsh 可执行文件解出包根（模拟 /usr/lib 布局）')
const T = mkdtempSync(join(tmpdir(), 'dsh-install-'))
const pkgRoot = join(T, 'node_modules', '@deepseek-ai', 'dsh')
mkdirSync(join(pkgRoot, 'lib'), { recursive: true })
writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0-test' }))
const binPath = join(pkgRoot, 'lib', 'bin.js')
writeFileSync(binPath, '// stub\n')

for (const k of ['DSH_AI1NET_DSH_BIN']) {
  clearEnv()
  process.env[k] = binPath
  ok(`${k} → 解出包根`, dshPackageRoot() === pkgRoot, dshPackageRoot().replace(T, '<T>'))
}

// 反例：bin 指向一个**不是 dsh 包**的目录 ⇒ 不许误判
clearEnv()
const otherRoot = join(T, 'node_modules', '@other', 'thing')
mkdirSync(join(otherRoot, 'lib'), { recursive: true })
writeFileSync(join(otherRoot, 'package.json'), JSON.stringify({ name: '@other/thing' }))
const otherBin = join(otherRoot, 'lib', 'bin.js')
writeFileSync(otherBin, '// stub\n')
process.env.DSH_AI1NET_DSH_BIN = otherBin
ok('包名不匹配时不误认（回落到默认值）', !dshPackageRoot().startsWith(otherRoot), dshPackageRoot().replace(T, '<T>'))

// ── 3. 派生量 ─────────────────────────────────────────────────────────────────
console.log('\n[3] 派生：scope 目录 / pi-ai 数据目录')
clearEnv()
process.env.DSH_PACKAGE_DIR = '/opt/whatever/dsh'
ok(
  'dshScopeDir = <root>/node_modules/@deepseek-ai',
  dshScopeDir() === join('/opt/whatever/dsh', 'node_modules', '@deepseek-ai'),
  dshScopeDir(),
)
ok(
  'piAiDataDir 落在 <root>/node_modules/@earendil-works/pi-ai/dist/providers/data',
  piAiDataDir() === join('/opt/whatever/dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'),
  piAiDataDir(),
)
for (const k of ['PI_AI_DATA_DIR', 'DSH_AI1NET_PI_AI_DATA_DIR']) {
  clearEnv()
  process.env.DSH_PACKAGE_DIR = '/opt/whatever/dsh'
  process.env[k] = '/tmp/data-' + k
  ok(`${k} 覆盖 piAiDataDir`, piAiDataDir() === '/tmp/data-' + k, piAiDataDir())
}

// ── 4. 缓存语义（env 改了不 reset 就用旧值；reset 后重新解析）────────────────────
console.log('\n[4] 缓存语义')
clearEnv()
process.env.DSH_PACKAGE_DIR = '/first'
const first = dshPackageRoot()
process.env.DSH_PACKAGE_DIR = '/second'
ok('缓存生效（不 reset 仍是旧值）', dshPackageRoot() === first && first === '/first', dshPackageRoot())
resetInstallPathsCache()
ok('reset 后重新解析', dshPackageRoot() === '/second', dshPackageRoot())

// ── 5. 本机实况：必须返回可用的绝对路径（不抛错）───────────────────────────────
console.log('\n[5] 本机实况')
clearEnv()
const real = dshPackageRoot()
ok('返回非空绝对路径', typeof real === 'string' && real.length > 0 && real.startsWith('/'), real)
ok('dshScopeDir 形状正确', dshScopeDir().endsWith(join('node_modules', '@deepseek-ai')), dshScopeDir())

// ── 6. 目录可读性诊断：**「读不到」必须与「目录为空」可区分**（2026-09-14 留痕）─────
console.log('\n[6] 目录可读性诊断（静默降级 → 可观测）')
const cat = await import(pathToFileURL(join(ROOT, 'lib/web/model-catalog.js')).href)
const warnings = []
const realWarn = console.warn
console.warn = (...a) => warnings.push(a.join(' '))

clearEnv()
process.env.PI_AI_DATA_DIR = join(T, 'no-such-data-dir') // 不存在 ⇒ 读不到
process.env.DSH_PACKAGE_DIR = '/nonexistent'
await cat.listCatalogProviders(true)
const d1 = cat.catalogDiagnostics()
ok('读不到时 readable=false', d1 !== null && d1.readable === false, JSON.stringify(d1))
ok('读不到时 count=0', d1 !== null && d1.count === 0)
ok('读不到时**告警过一次**（不再静默）', warnings.some((w) => w.includes('厂家目录不可读')), warnings[0]?.slice(0, 60) ?? '(无)')

clearEnv()
const emptyDir = join(T, 'empty-data')
mkdirSync(emptyDir, { recursive: true })
process.env.PI_AI_DATA_DIR = emptyDir // 存在但没有任何 <id>.json ⇒ "目录为空"
await cat.listCatalogProviders(true)
const d2 = cat.catalogDiagnostics()
ok('目录可读但为空时 readable=true（与"读不到"可区分）', d2 !== null && d2.readable === true && d2.count === 0, JSON.stringify(d2))
ok('已告警过就不再刷日志', warnings.filter((w) => w.includes('厂家目录不可读')).length === 1, String(warnings.length))
console.warn = realWarn

rmSync(T, { recursive: true, force: true })
console.log('')
if (failed > 0) {
  console.log(`✗ verify-dsh-install 失败 ${failed} 项`)
  process.exit(1)
}
console.log('✓ verify-dsh-install 全绿')
