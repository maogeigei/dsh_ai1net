#!/usr/bin/env node
/**
 * verify-model-landing.mjs —— 模型落地层回归
 *
 * 为什么需要：`src/web/model-landing.ts` 干的是**改写实例自己的配置文件**
 * （`$DSH_HOME/.credentials.yaml` 与 `settings.yaml`）——这类逻辑错了**不会报错**，
 * 只会让实例静默少一个厂家、或者把用户自己配的 key 覆盖掉。官方「设置 → 模型」页
 * 在平台环境必然报错（见 `ensure-role-profile-patch.cjs` 注释），所以平台自己写的这两处
 * 文件就是**唯一**的配置来源，没有第二双眼睛。
 *
 * 本脚本用固定样例把 12 条不变式钉死：**幂等**、**不碰用户自己的**、**删得掉自己写的**、
 * **字段名必须与官方一致**（`api` 不是 `protocol`；`apiKeyEnv` 不是 `apiKey`）。
 * 用法：node scripts/verify-model-landing.mjs     退出码 0=全绿 / 1=有失败
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// ⚠️ 动态 import 必须走 file:// URL —— 本机是 Windows，裸 `D:\...` 会被 ESM loader 拒
// （ERR_UNSUPPORTED_ESM_URL_SCHEME）；pathToFileURL 在 Linux 上同样正确。
const {
  BUILTIN_REF,
  PI_AI_NS,
  PROTOCOLS,
  normalizeProtocol,
  parseModels,
  readRefValue,
  reconcileCredentials,
  reconcileSettings,
  refForEntry,
  routeRef,
} = await import(pathToFileURL(join(ROOT, 'lib/web/model-landing.js')).href)

let failed = 0
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (extra ? '  ' + extra : ''))
  if (!cond) failed++
}
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

console.log('verify-model-landing（落地层）\n')

// ── 1. ref 命名 ───────────────────────────────────────────────────────────────
console.log('[1] ref 命名（须匹配官方 REF_PATTERN，否则 dsh 静默不认）')
ok('my-gateway → MY_GATEWAY_API_KEY', routeRef('my-gateway') === 'MY_GATEWAY_API_KEY', routeRef('my-gateway'))
ok('数字开头补 X', routeRef('2fast') === 'X2FAST_API_KEY', routeRef('2fast'))
ok('空串也合法', REF_PATTERN.test(routeRef('')))
ok('中文名也合法（折成 X_API_KEY）', routeRef('硅基流动') === 'X_API_KEY', routeRef('硅基流动'))
ok('内置条目 → DEEPSEEK_API_KEY', refForEntry({ route: 'deepseek', baseUrl: null }) === BUILTIN_REF)
ok('自定义 → routeRef(route)', refForEntry({ route: 'my-gw', baseUrl: 'https://x/v1' }) === 'MY_GW_API_KEY')
ok('官方分区名是 llm-pi-ai', PI_AI_NS === 'llm-pi-ai')
ok('协议只有官方那三个', PROTOCOLS.length === 3 && PROTOCOLS[0] === 'openai-completions')
ok('未知协议回落默认', normalizeProtocol('nope') === 'openai-completions')

// ── 2. 凭据文件：从零创建 ─────────────────────────────────────────────────────
console.log('\n[2] .credentials.yaml 从零创建')
let cred = reconcileCredentials('', [{ ref: BUILTIN_REF, value: 'sk-shared' }], [])
ok('写出 version/refs/行', cred.text === "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-shared'\n", JSON.stringify(cred.text))
ok('managed 记录该 ref', cred.managed.length === 1 && cred.managed[0] === BUILTIN_REF)

// ── 3. 凭据文件：追加第二条 + 保留用户自己的内容 ──────────────────────────────
console.log('\n[3] 追加第二条（用户自己的 ref 必须原样保留）')
const withUserOwn = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-shared'\nrecords:\n  saved-by-dsh: 'zzz'\n"
cred = reconcileCredentials(
  withUserOwn,
  [
    { ref: BUILTIN_REF, value: 'sk-shared' },
    { ref: 'MY_GW_API_KEY', value: 'sk-gw' },
  ],
  [BUILTIN_REF],
)
ok('新增了自定义 ref', cred.text.includes("MY_GW_API_KEY: 'sk-gw'"))
ok('records: 段完整保留', cred.text.includes('records:') && cred.text.includes("saved-by-dsh: 'zzz'"))
ok('已管线的 ref 值被刷新', cred.text.includes("DEEPSEEK_API_KEY: 'sk-shared'"))
ok('缩进正确（两条都在 refs 下）', /refs:\n( {2}\S+.*\n)+/.test(cred.text), JSON.stringify(cred.text))

// ── 4. 凭据文件：用户自己的 ref 绝不覆盖 / 删除 ───────────────────────────────
console.log('\n[4] 用户自己写的 ref：不覆盖、不删除')
const userOwn = "version: 1\nrefs:\n  USER_OWN_KEY: 'mine'\n"
const untouched = reconcileCredentials(userOwn, [{ ref: 'USER_OWN_KEY', value: 'platform-would-write' }], [])
ok('值未被改写', untouched.text.includes("USER_OWN_KEY: 'mine'"), JSON.stringify(untouched.text))
ok('未把它记为平台托管', untouched.managed.length === 0)
const notManagedDrop = reconcileCredentials(userOwn, [], ['SOME_OTHER_KEY'])
ok('不在 managed 里的 ref 不会被删', notManagedDrop.text.includes('USER_OWN_KEY'), JSON.stringify(notManagedDrop.text))

// ── 5. 凭据文件：关掉条目 ⇒ 平台自己写的那行被删 ──────────────────────────────
console.log('\n[5] 关掉条目 ⇒ 撤掉平台自己写的 ref（验收③依赖这条）')
const twoRefs = "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-shared'\n  MY_GW_API_KEY: 'sk-gw'\n"
const disabled = reconcileCredentials(twoRefs, [], [BUILTIN_REF, 'MY_GW_API_KEY'])
ok('DEEPSEEK_API_KEY 已移除', !disabled.text.includes('DEEPSEEK_API_KEY'), JSON.stringify(disabled.text))
ok('MY_GW_API_KEY 已移除', !disabled.text.includes('MY_GW_API_KEY'))
ok('managed 清空', disabled.managed.length === 0)

// ── 6. 幂等（最容易被忽略的不变式）────────────────────────────────────────────
console.log('\n[6] 幂等：同一输入跑两次结果必须相同')
const once = reconcileCredentials(twoRefs, [{ ref: BUILTIN_REF, value: 'sk-shared' }], [BUILTIN_REF])
const twice = reconcileCredentials(once.text, [{ ref: BUILTIN_REF, value: 'sk-shared' }], once.managed)
ok('凭据：第二次无变化', twice.text === once.text, JSON.stringify(twice.text))

// ── 7. settings.yaml：从零创建厂商段 ─────────────────────────────────────────
console.log('\n[7] settings.yaml 从零创建（字段名必须与官方一致）')
const gw = { route: 'my-gw', apiKeyEnv: 'MY_GW_API_KEY', baseURL: 'https://api.example.com/v1', api: 'openai-completions', models: ['gpt-4o', 'gpt-4o-mini'] }
let set = reconcileSettings('', [gw], [])
ok('含 llm-pi-ai → providers 链', set.text.includes('llm-pi-ai:\n  providers:'))
ok('字段是 apiKeyEnv（不是 apiKey）', set.text.includes('apiKeyEnv: MY_GW_API_KEY') && !set.text.includes('apiKey:'))
ok('字段是 api（不是 protocol）', set.text.includes('api: openai-completions') && !set.text.includes('protocol:'))
ok('baseURL 存在', set.text.includes('baseURL: https://api.example.com/v1'))
ok('models 是 id 列表', set.text.includes('- id: gpt-4o') && set.text.includes('- id: gpt-4o-mini'))
ok('有 begin/end 标记（删的依据）', set.text.includes('# dsh_ai1net:model-route my-gw begin') && set.text.includes('# dsh_ai1net:model-route my-gw end'))
ok('managed 记录 route', set.managed.includes('my-gw'))

// ── 8. settings.yaml：往既有文档追加，且不破坏别人的键 ────────────────────────
console.log('\n[8] settings.yaml 追加：既有顶层键与注释必须保留')
const existingSettings = "# 用户自己的备注\n" + "llm-pi-ai:\n  providers:\n    deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY\nagent-default-model: deepseek-chat\n"
set = reconcileSettings(existingSettings, [gw], [])
ok('既有 deepseek 段保留', set.text.includes('deepseek:\n      apiKeyEnv: DEEPSEEK_API_KEY'))
ok('既有顶层键保留', set.text.includes('agent-default-model: deepseek-chat'))
ok('既有注释保留', set.text.includes('# 用户自己的备注'))
ok('新厂家已插入 providers 之下', set.text.indexOf('my-gw:') > set.text.indexOf('providers:'))
ok('未重复写入 deepseek', (set.text.match(/^ {4}deepseek:$/gm) ?? []).length === 1)
// 回归项：第一版实现把 `providers:` 当成顶层键去找 ⇒ 找不到 ⇒ 又补一行 ⇒ 文档里两个同键。
ok('providers 只有一处（防重复键）', (set.text.match(/^[ \t]+providers:$/gm) ?? []).length === 1)

// ── 9. settings.yaml：关掉厂家 ⇒ 整块删除 ────────────────────────────────────
console.log('\n[9] settings.yaml 关掉厂家 ⇒ 只删自己那块')
const removed = reconcileSettings(set.text, [], ['my-gw'])
ok('my-gw 块已删干净', !removed.text.includes('my-gw'), JSON.stringify(removed.text.slice(-160)))
ok('deepseek 段还在', removed.text.includes('deepseek:'))
ok('顶层键还在', removed.text.includes('agent-default-model'))
const removedTwice = reconcileSettings(removed.text, [], removed.managed)
ok('删除也幂等', removedTwice.text === removed.text)

// ── 10. settings.yaml：文件里已有同名 route（非平台写的）⇒ 不重复写 ──────────
console.log('\n[10] 已存在同名 route ⇒ 不重复写（防 YAML 重复键）')
const collide = reconcileSettings("llm-pi-ai:\n  providers:\n    my-gw:\n      apiKeyEnv: USER_SET\n", [gw], [])
ok('未插入第二个 my-gw', (collide.text.match(/^ {4}my-gw:$/gm) ?? []).length === 1, JSON.stringify(collide.text))

// ── 11. parseModels 宽容性 ───────────────────────────────────────────────────
console.log('\n[11] parseModels：坏值只能被丢弃，不能把整份文件写坏')
ok('坏 JSON → []', parseModels('{oops').length === 0)
ok('非数组 → []', parseModels('"x"').length === 0)
ok('过滤非字符串项', JSON.stringify(parseModels('["a", 1, null, "b"]')) === '["a","b"]')
ok('去重', parseModels('["a","a"]').length === 1)
ok('限长 50', parseModels(JSON.stringify(Array.from({ length: 80 }, (_, i) => 'm' + i))).length === 50)
ok('null → []', parseModels(null).length === 0)

// ── 12. 认不出的布局：宁可不动 ───────────────────────────────────────────────
console.log('\n[12] 认不出的凭据布局 ⇒ 原样返回（不冒写坏凭据的风险）')
const weird = 'this: is\n  not: a credentials doc\n'
const keptWeird = reconcileCredentials(weird, [{ ref: 'A_KEY', value: 'v' }], [])
ok('原样返回', keptWeird.text === weird)

// ── 13. readRefValue（一次性交接：认领老实现写下的 ref）──────────────────────
console.log('\n[13] readRefValue：读出文件里某 ref 的当前值')
ok('带单引号', readRefValue("version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-1'\n", 'DEEPSEEK_API_KEY') === 'sk-1')
ok('不带引号', readRefValue('version: 1\nrefs:\n  ANYSEARCH_API_KEY: as_sk_x\n', 'ANYSEARCH_API_KEY') === 'as_sk_x')
ok('没有该 ref → null', readRefValue("version: 1\nrefs:\n  OTHER: 'x'\n", 'DEEPSEEK_API_KEY') === null)
ok('不在 refs 段下的同名行不算', readRefValue("version: 1\nrecords:\n  DEEPSEEK_API_KEY: 'z'\n", 'DEEPSEEK_API_KEY') === null)
ok(
  '真实样例（服务器现状两把 key + records 段）',
  readRefValue(
    "version: 1\nrefs:\n  DEEPSEEK_API_KEY: 'sk-81c7'\n  ANYSEARCH_API_KEY: as_sk_4\nrecords:\n  client-connection/browser-session:\n    kind: grant\n",
    'DEEPSEEK_API_KEY',
  ) === 'sk-81c7',
)

console.log('')
if (failed > 0) {
  console.log(`✗ verify-model-landing 失败 ${failed} 项`)
  process.exit(1)
}
console.log('✓ verify-model-landing 全绿')
