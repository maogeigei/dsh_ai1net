/**
 * Shared upload security scan (安全检测) for skill and business-plugin uploads.
 *
 * 分级（2026-09-11）：
 *   · **P0（阻断）** —— 明显恶意/提权模式：命中即拒绝上传（HTTP 400），与历史行为一致；
 *   · **P1（告警）** —— 可疑但常见的模式（动态执行、外联、敏感 env、长 base64、隐藏文件/`.git`）：
 *     **不阻断**，作为 findings 返回并写日志，供管理员在上传时人工复核。
 * 之前只有"命中即 400"，缺少分级与整改提示；现在 `scanDir` 返回 P1 findings（调用方可忽略）。
 * @module dsh_ai1net/web/security-scan
 */

import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs'
import { basename, join } from 'node:path'

const SCAN_TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.py', '.json', '.md', '.txt',
  '.yml', '.yaml', '.html', '.css', '.toml', '.ini', '.conf', '.env', '.cfg',
  // 2026-09-11 扩展：非 JS 生态的常见脚本/配置（上传包里同样可能藏恶意指令）
  '.rs', '.go', '.java', '.php', '.rb', '.pl', '.lua', '.sql', '.ps1', '.psm1', '.bat', '.cmd',
])

/** 扫描体积上限（旧值 2MB 会漏掉较大脚本；提到 8MB，仍跳过二进制/超大文件）。 */
const SCAN_MAX_BYTES = 8 * 1024 * 1024

/** P0：明显恶意/提权 → 直接阻断上传。 */
const BLOCK_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /rm\s+-rf\s+(\/|\/\*|~\s*|\$HOME)\b/, why: '含删除根目录/家目录命令' },
  { re: /(?:curl|wget)\s+[^\s|>]+\s*\|\s*(?:sh|bash)\b/, why: '下载并执行远程脚本' },
  { re: /\/etc\/(?:passwd|shadow|sudoers)\b/, why: '读取系统凭证文件' },
  { re: /\.ssh\/(?:id_rsa|id_ed25519|id_ecdsa|authorized_keys)/, why: '读取 SSH 私钥' },
  { re: /\.aws\/(?:credentials|config)\b/, why: '读取云平台凭证' },
  { re: /\/var\/lib\/dsh_ai1net\b/, why: '读取本平台数据目录' },
  { re: /\.credentials\.yaml/, why: '读取实例会话密钥' },
  // 2026-09-11 新增（/M 对齐）：仍是"明显恶意"档，故归 P0
  { re: /\bnc\s+-[a-z]*e[a-z]*\s+\S+\s+\d+/, why: '反弹 shell（nc -e）' },
  { re: /\/dev\/tcp\/\d{1,3}(\.\d{1,3}){3}\/\d+/, why: '反弹 shell（/dev/tcp）' },
  { re: /(?:base64\s+-d|b64decode|atob)\s*[\s\S]{0,40}?\|\s*(?:sh|bash)\b/, why: 'base64 解码后直接执行' },
  { re: /\bchmod\s+(?:\+s|4[0-7]{3}|6[0-7]{3})\b[^\n]{0,40}(?:\/usr\/bin|\/bin)\//, why: '尝试为系统二进制加 setuid/特权位' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, why: 'fork 炸弹' },
]

/**
 * P1：可疑但常见 → **不阻断**，作为 findings 上报（管理员人工复核）。
 * 说明书见与/M。
 */
const WARN_RULES: Array<{ id: string; re: RegExp; why: string }> = [
  { id: 'dynamic-exec', re: /\b(?:child_process|execSync|execFileSync|spawnSync|require\('child_process'\))/, why: '动态执行子进程（需确认目标命令可信）' },
  { id: 'vm-eval', re: /\b(?:new\s+Function\s*\(|require\('vm'\)|from 'node:vm'|eval\s*\()/, why: '动态求值 vm/eval/new Function' },
  { id: 'sensitive-env', re: /process\.env\s*[.\[]\s*['"]?(?:DEEPSEEK_API_KEY|DSH_[A-Z_]+|[A-Z_]*TOKEN|[A-Z_]*SECRET|[A-Z_]*KEY)/, why: '读取敏感环境变量' },
  { id: 'long-base64', re: /[A-Za-z0-9+/]{600,}={0,2}/, why: '超长 base64 载荷（可能是混淆/内嵌二进制）' },
  { id: 'network-egress', re: /https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, why: '外部网络访问（需确认域名可信；配合出网护栏）' },
  { id: 'hidden-or-git', re: /(?:\.git\/|(?:^|\/)\.[a-z][a-z0-9_-]*\/)/i, why: '包含隐藏目录/.git（可能携带仓库元数据或绕过审查）' },
]

/** 一条扫描发现（P1 告警）。 */
export interface ScanFinding { rule: string; why: string; file: string }

/** 一条 P0 命中（默认阻断；业务插件上传可交由 admin 显式信任后放行）。 */
export interface ScanBlock { why: string; file: string }

/** 收集式扫描结果：`warnings` = P1 告警，`blocked` = P0 命中。 */
export interface ScanResult { warnings: ScanFinding[]; blocked: ScanBlock[] }

export function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number }
  e.statusCode = statusCode
  return e
}

/**
 * Recursively walk text files under `root`, filling `findings` (P1) and `blocks` (P0).
 * 遍历本身不抛：是否阻断由调用方（{@link scanDir} / {@link scanDirDetailed}）决定。
 */
function walk(root: string, rel: string, findings: ScanFinding[], blocks: ScanBlock[]): void {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const abs = join(root, entry)
    const relPath = rel === '' ? entry : `${rel}/${entry}`
    let st: Stats
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(abs, relPath, findings, blocks)
      continue
    }
    if (!st.isFile()) continue
    const base = basename(entry)
    const dot = base.lastIndexOf('.')
    const ext = dot >= 0 ? base.slice(dot).toLowerCase() : ''
    const hasShebangCandidate = ext === '' // 无扩展名文件也可能是脚本（按内容判 shebang）
    if (!SCAN_TEXT_EXT.has(ext) && !hasShebangCandidate) continue
    if (st.size > SCAN_MAX_BYTES) continue // 跳过超大文件（不太可能是源码）
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    // 二进制探测 + shebang 判定（0x00 视为二进制；无扩展名须含 shebang 才继续）
    if (text.includes('\u0000')) continue
    if (hasShebangCandidate && !/^#!\s*\S/.test(text.slice(0, 64))) continue
    for (const p of BLOCK_PATTERNS) {
      if (p.re.test(text)) blocks.push({ why: p.why, file: relPath })
    }
    for (const w of WARN_RULES) {
      if (w.re.test(text)) {
        findings.push({ rule: w.id, why: w.why, file: relPath })
      }
    }
  }
}

/**
 * Recursively scan text files under `root`.
 * P0 命中 → 抛 400（**阻断上传**，既有行为：技能上传等路径依赖它）；P1 命中 → 收集并返回。
 */
export function scanDir(root: string, rel = '', findings: ScanFinding[] = []): ScanFinding[] {
  const blocks: ScanBlock[] = []
  walk(root, rel, findings, blocks)
  if (blocks.length > 0) {
    throw httpError(400, `安全检测未通过（P0 阻断）：${blocks[0].why}（${blocks[0].file}）`)
  }
  return findings
}

/**
 * 收集式扫描：**P0 命中不抛**，与 P1 告警一并返回。
 *
 * 供「上传者本人就是可信管理员、且需要看到逐条命中再决定」的路径使用 ——
 * 目前是业务插件（功能插件）投放：命中的往往是文档里的说明性字样（例如 README 教用户
 * 把 key 写进 `.credentials.yaml`），直接 400 会让 admin 无从判断，也没法对**已人工确认**
 * 的包放行。调用方拿到 `blocked` 后可以：默认拒绝并把详情回显给 admin，
 * 或在 admin **显式声明信任**（并留痕）后继续入库。
 */
export function scanDirDetailed(root: string): ScanResult {
  const warnings: ScanFinding[] = []
  const blocks: ScanBlock[] = []
  walk(root, '', warnings, blocks)
  return { warnings, blocked: blocks }
}
