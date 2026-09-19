#!/usr/bin/env node
/**
 * ensure-role-profile-patch.cjs — 按角色给 dsh profile 注入 cordis patch。
 *
 * 背景：
 *   · 2026-09-09：普通用户在设置面板不应看到「模型」分区（模型 KEY 由管理员经门户统一
 *     管控，；且避免普通用户误配自用 key 绕过统一 key）。
 *   · 2026-09-13（**§九**）：「模型」分区对普通用户放开 —— 用户要求把配置模型密钥
 *     开放给用户自己配，且「界面交互和官方一模一样」（⇒ 直接用官方页，不仿制）。
 *     实测：官方页在本环境**可用**（`/api/session/modelCatalog` 返回 200，"provider 目录
 *     不可用"的旧判断已不成立）。配套改平台注入：用户自配 ⇒ 不注入共享 env
 *     （`src/web/server.ts` 的 `resolveApiKey()` 恒返回 null，否则 env 优先级会静默盖掉
 *     用户配的 key）。仍禁用：plugins / plugin-inventory / cordis。
 *   · **2026-09-13：上面那条被推翻 —— 该分区必须重新禁掉，且这次连 admin 一起禁**。
 *     实测：官方页要求 Host settings 镜像，而平台是「浏览器经域名访问远程服务器」⇒
 *     `isLoopback` 为 false ⇒ persistence 降级为 `memory` ⇒ 页面**必报**「加载提供方目录失败」
 *     （完整判据见下方 `DISABLE_MODELS_BLOCK` 的注释）。⇒ 放开它只是给用户一个报错页；
 *     用户自配模型改走**平台自建的「模型设置」分区**（
 *     界面走 `/api/me/keys` 等接口，落地由 `src/web/server.ts` 在 spawn 时写
 *     `$DSH_HOME/.credentials.yaml` 与 `$DSH_HOME/settings.yaml` —— 字段名与官方包对齐，
 *     见 `src/web/model-landing.ts` 头注释）。
 *   cordis patch 支持对 client 插件行
 * `disabled: true`（dsh-app-boot applyEntryPatches：非 insert patch 按 id 合入
 * overrides）——生效位置 = profile 层 `cordis.patch.yml`（实例启动时打包 client
 * bundle，改后必须重启实例才生效；patchReload:live 对 client 增减不生效，已实测）。
 *
 * 用法：
 *   node ensure-role-profile-patch.cjs                  # 全部非 admin 用户
 *   node ensure-role-profile-patch.cjs guest            # 指定用户名（可多个）
 *   node ensure-role-profile-patch.cjs --restart guest  # 写后重启其实例（kill main，
 *                                                       # 由 watchdog 拉新）
 * 幂等：cordis.patch.yml 已含管理标记头或非默认空内容 → 跳过不覆盖。
 */
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const Database = require('better-sqlite3')

const DB_PATH = '/var/lib/dsh-ai1net/dsh_ai1net.db'
const PROFILE = 'web' // 当前唯一 profile
const MARK = '# dsh_ai1net role patch'
// --force：已由本脚本管理但内容落后（缺新版禁用项）时，整体升级为当前块。
const FORCE = process.argv.includes('--force')
const DISABLE_MODELS_BLOCK = [
  '# dsh_ai1net role patch: 普通用户隐藏模型分区 + 收归核心插件开关（/ 87）',
  '# admin 保留；由 ensure-role-profile-patch.cjs 管理，勿手改',
  '# 148 个 @deepseek-ai 官方插件均为运行骨架，用户禁用任一都可能搞坏实例，',
  '# 故插件栏 / 插件清单 / cordis 面板只对 admin 开放；ui-skill、ui-permission 保留给用户。',
  '#',
  '# ⛔ ui-settings-models **必须保持禁用**（2026-09-13 实地查证）：',
  '#    官方模型页要求 Host settings 镜像，而 `dsh-client-ui-settings` 的持久化判定是',
  '#      `isLoopback = transport.ownsHost || pageLocation === undefined || isLoopbackHostname(page)`,',
  '#    平台是「浏览器经域名访问远程服务器」⇒ 三条都不成立 ⇒ persistence 降级为 `memory`',
  '#    ⇒ `ensure()` 直接返回不读 ⇒ 页面必报「加载提供方目录失败: settings are unavailable',
  '#    in this browser」（官方 README 原文：a non-loopback browser cannot use that Host-only namespace）。',
  '#    ⇒ **放开它只会给用户一个报错页**；用户自配模型改走平台自建的「模型设置」分区。',
  '- id: ui-settings-models',
  '  name: "@deepseek-ai/dsh-client-ui-settings-models"',
  '  disabled: true',
  '- id: ui-settings-plugins',
  '  name: "@deepseek-ai/dsh-client-ui-settings-plugins"',
  '  disabled: true',
  '- id: ui-settings-plugin-inventory',
  '  name: "@deepseek-ai/dsh-client-ui-settings-plugin-inventory"',
  '  disabled: true',
  '- id: ui-cordis',
  '  name: "@deepseek-ai/dsh-client-ui-cordis"',
  '  disabled: true',
  '',
].join('\n')

/**
 * admin 的块：**只隐藏「模型」分区**。
 *
 * 为什么连 admin 也要隐藏：该页要求 Host settings 镜像，而平台是「浏览器经域名访问远程服务器」
 * ⇒ `isLoopback` 为 false ⇒ persistence 降级为 `memory` ⇒ 页面必报
 * 「加载提供方目录失败: settings are unavailable in this browser」。
 * **对 admin 同样如此** —— 之前这个补丁只写非 admin，所以 admin 一直能看到并点进报错页。
 * admin 的其余能力（插件栏 / cordis 面板）保持官方默认，**不**跟着禁。
 */
const ADMIN_MODELS_BLOCK = [
  '# dsh_ai1net role patch: admin 仅隐藏「模型」分区',
  '# 由 ensure-role-profile-patch.cjs 管理，勿手改',
  '# 该页在平台环境必然报错（non-loopback 页面拿不到 Host settings），故对 admin 一并隐藏。',
  '# 用户自配模型改走平台自建页（实例内「设置 → 模型设置」）。',
  '- id: ui-settings-models',
  '  name: "@deepseek-ai/dsh-client-ui-settings-models"',
  '  disabled: true',
  '',
].join('\n')

function isEmptyPatch(content) {
  const body = content
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
  return body.length === 0 || body.join('') === '[]'
}

/**
 * 从文本里摘掉本脚本**上一次写的那个块**（从 `MARK` 行起，到下一个平台块 `# >>>` 或文件尾），
 * 其余内容原样保留。
 *
 * ⚠️ 为什么不能直接 `writeFileSync(patchPath, block)`（老实现就是那么写的，是个**雷**）：
 * admin 的 `cordis.patch.yml` 里同时住着三个平台块 —— `disable-hmr`、
 * `workspace-scoped-picker`、本脚本的 role patch。整文件覆盖 ⇒ **另两个块被静默抹掉**：
 * disable-hmr 丢掉 = 生产实例重新连 HMR；picker 块丢掉 = 目录选择器回到「可改任意路径」的
 * 无限制版（v3 的收敛形同作废）。所以升级只准替换**自己那一段**。
 * @param text - 现有 patch 文本。
 * @returns 去掉本脚本那个块之后的文本（找不到 MARK 时原样返回）。
 */
function stripManagedBlock(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith(MARK))
  if (start < 0) return text
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('# >>>')) {
      end = i
      break
    }
  }
  while (end > start && lines[end - 1].trim() === '') end-- // 吃掉块尾空行，避免越删越空
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
}

function ensureUserPatch(user) {
  const patchPath = join(user.home_dir, 'profiles', PROFILE, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    return { user: user.username, action: 'NO_PROFILE', detail: 'profile 尚未创建（用户未首登 spawn）；请先登录一次再跑' }
  }
  const current = readFileSync(patchPath, 'utf8')
  const isAdmin = user.role === 'admin'
  const block = isAdmin ? ADMIN_MODELS_BLOCK : DISABLE_MODELS_BLOCK
  // 需要升级的三种旧态：① 还没写上本轮的「」标记（注释是判据的**唯一落盘处**，
  // 陈旧就等于判据丢失）；② 缺核心插件开关收归；③ 还禁着 ui-settings-models 的旧版（已放开）。
  const stale = !current.includes('')
  const legacy = isAdmin
    ? stale || !/^-\s*id:\s*ui-settings-models\s*$/m.test(current)
    : stale || !current.includes('ui-settings-plugins') || !/^-\s*id:\s*ui-settings-models\s*$/m.test(current)
  if (current.includes(MARK)) {
    if (FORCE && legacy) {
      const rest = stripManagedBlock(current).replace(/^\s*\n+/, '')
      writeFileSync(patchPath, (rest.trim() === '' ? '' : rest.replace(/\s*$/, '') + '\n\n') + block, 'utf8')
      return {
        user: user.username,
        action: 'upgraded',
        detail: isAdmin
          ? '已替换 admin 块（只隐藏「模型」分区；disable-hmr / picker 两个平台块原样保留）'
          : '已升级（收回「模型」分区 + 核心插件开关收归）',
      }
    }
    return { user: user.username, action: 'skip', detail: '已由本脚本管理' }
  }
  if (!isEmptyPatch(current)) {
    // admin 的 patch 里已经有**别的平台块**（disable-hmr / workspace-scoped-picker），
    // 整文件覆盖会丢掉它们 ⇒ **追加**（幂等：无 MARK 才追加；有 MARK 走上面的 upgrade 分支）。
    if (isAdmin) {
      writeFileSync(patchPath, current.replace(/\s*$/, '') + '\n\n' + block, 'utf8')
      return { user: user.username, action: 'wrote', detail: '已**追加** admin 块（只隐藏「模型」分区，保留既有平台块）' }
    }
    return { user: user.username, action: 'skip', detail: '用户已定制 cordis.patch.yml，不覆盖' }
  }
  writeFileSync(patchPath, block, 'utf8')
  return { user: user.username, action: 'wrote', detail: isAdmin ? '已写 admin 块（只隐藏「模型」分区）' : '已写入 role patch' }
}

function restartUserInstance(user) {
  // kill main 实例 → orchestrator 崩溃自愈（scheduleRestart，指数退避）拉起新实例
  // （读取新 patch 打包 bundle）。注：watchdog 因 enablePatch=false 不会启动。
  const out = execFileSync('pgrep', ['-f', `--profile ${PROFILE}`], { encoding: 'utf8' }).trim()
  const pids = out === '' ? [] : out.split('\n')
  // 该用户实例 cwd = users/<id>/ws（与 DB home_dir 同根），用 uid 匹配
  const uid = user.uid !== null && user.uid !== undefined ? String(user.uid) : null
  const envCmd = 'ps -o pid,user,args -C node | grep -E "dsh --profile web"'
  let killed = 0
  try {
    const lines = execFileSync('bash', ['-c', envCmd], { encoding: 'utf8' }).trim().split('\n')
    for (const line of lines) {
      const m = line.trim().match(/^\s*(\d+)\s+(\S+)/)
      if (!m) continue
      if (uid !== null && m[2] === `dsh-${user.id.replace(/-/g, '').slice(0, 20)}`) {
        execFileSync('kill', [m[1]])
        killed++
      }
    }
  } catch {
    // pgrep 无匹配等
  }
  return killed
}

function main() {
  const args = process.argv.slice(2)
  const restart = args.includes('--restart')
  const usernames = args.filter((a) => !a.startsWith('--'))
  const db = new Database(DB_PATH, { readonly: true })
  let rows
  if (usernames.length > 0) {
    rows = usernames.map((u) => db.prepare('SELECT id, username, role, home_dir, uid FROM users WHERE username=?').get(u)).filter(Boolean)
  } else {
    // **含 admin** —— admin 也要隐藏「模型」分区（该页在平台环境必然报错）。
    // admin 的块只禁 models 一项（插件栏 / cordis 面板保持官方默认，admin 需要它们）。
    rows = db.prepare("SELECT id, username, role, home_dir, uid FROM users WHERE role IN ('admin','active')").all()
  }
  db.close()
  if (rows.length === 0) {
    console.log('no non-admin user found')
    return
  }
  for (const user of rows) {
    const r = ensureUserPatch(user)
    if (restart && r.action === 'wrote') {
      const k = restartUserInstance(user)
      r.detail += `；已 kill 实例进程 ${k} 个（watchdog 将拉起新实例）`
    }
    console.log(JSON.stringify(r))
  }
}

main()
