/**
 * 语言偏好持久化 —— 把用户在实例里选的界面语言**记住**。
 *
 * ## 为什么需要它（2026-09-15）
 * 官方 `dsh-client-locale` README 原文：语言选择立即生效，但**只有 loopback 页面**会把选择
 * 持久化到 `$DSH_HOME/settings.yaml`；**非 loopback 页面只为当前进程保留**。
 * 平台是"浏览器经域名访问远程实例" ⇒ **属非 loopback** ⇒ 用户切完语言、一刷新就回默认英语。
 *
 * ## 最优方案 = **A（守官方语义）+ B（记住选择）同时成立**
 * 不是"另造一套语言状态"，而是**替官方把它的设置写进它自己的文件**：
 *   `settings.yaml` 顶层 `locale:` → `preference: <id>`（键名取自官方 locale 包的 settings schema，
 *   已核对：该包 host 半边的 schema 用的就是 `locale` / `preference`）。
 * ⇒ 官方运行时启动时读自己的设置文件即生效（A 成立），用户的选择跨页面 / 跨重启保留（B 成立）。
 * ⇒ **零官方改动**、不新增平台侧语言状态（单一来源仍是官方 settings.yaml）。
 *
 * 与 `model-landing.ts` 的关系：同一个文件、同一套"按行对账"的写法（不整份 YAML 解析，
 * 避免把注释 / 顺序 / 未知字段写坏），并且**只动自己那两行**。
 *
 * @module dsh_ai1net/web/locale-pref
 */

/** 官方 `dsh-client-locale` 的 `LOCALE_IDS`（`en` 是它的 FALLBACK，即默认英语）。 */
export const LOCALE_IDS = ['en', 'zh'] as const
export type LocaleId = (typeof LOCALE_IDS)[number]

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === 'string' && (LOCALE_IDS as readonly string[]).includes(value)
}

/** 顶层块名与缩进（官方 schema：顶层 `locale:`，其下 2 空格 `preference:`）。 */
const BLOCK = 'locale'
const INDENT = '  '
const KEY = 'preference'

/**
 * 把 `preference: <id>` 对账进 `settings.yaml` 文本。
 *
 * 行为（全部按"只碰自己那两行"设计）：
 *   · 已有顶层 `locale:` 块 + 其下 `preference:` ⇒ **原地替换值**；
 *   · 已有顶层 `locale:` 块但**没有** `preference:` ⇒ 紧跟块头插入一行；
 *   · 没有 `locale:` 块 ⇒ 追加 `locale:\n  preference: <id>\n`；
 *   · 值已等于目标 ⇒ `changed: false`（幂等，调用方可据此跳过写盘）。
 *
 * ⛔ **不整份解析 YAML**：这一文件里还有别的插件写的块与用户注释，解析再回写会把它们写坏
 * （`model-landing.ts` 头注释里记着同类教训）。
 */
export function reconcileLocalePreference(text: string, preference: LocaleId): { text: string; changed: boolean } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text === '' ? [] : text.split(/\r?\n/)
  const want = `${INDENT}${KEY}: ${preference}`

  const isBlockHead = (l: string): boolean => new RegExp(`^${BLOCK}\\s*:\\s*(#.*)?$`).test(l)

  for (let i = 0; i < lines.length; i++) {
    if (!isBlockHead(lines[i]!)) continue
    // 块内找 preference（缩进 ≥ 2 且不是更深层嵌套）
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l.trim() === '' || l.trimStart().startsWith('#')) continue
      // 出了本块（缩进 0 的新键 / 更深层缩进的子块）⇒ 停
      if (!/^\s/.test(l)) break
      const m = new RegExp(`^(\\s+)${KEY}\\s*:\\s*(.*)$`).exec(l)
      if (m) {
        const cur = m[2]!.trim().replace(/^["']|["']$/g, '')
        if (cur === preference) return { text, changed: false }
        lines[j] = `${INDENT}${KEY}: ${preference}`
        return { text: lines.join(eol), changed: true }
      }
    }
    // 块头存在但没有 preference ⇒ 紧跟其后插入
    lines.splice(i + 1, 0, want)
    return { text: lines.join(eol), changed: true }
  }

  // 没有 locale 块 ⇒ 追加（去掉尾部空行再加，保持文档整洁）
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  lines.push(`${BLOCK}:`, want)
  return { text: lines.join(eol) + eol, changed: true }
}
