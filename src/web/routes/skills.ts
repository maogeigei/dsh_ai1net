/**
 * Skill management routes.
 *
 * Two scopes, mirroring the dsh skill layers discovered by
 * `@deepseek-ai/dsh-skill-filesystem`:
 *   - shared  (`/api/skills/shared`): admin-only. Targets the platform
 *     bundled layer (`DSH_BUNDLED_SKILL_DIR`, rank 600, read-only for users).
 *   - mine    (`/api/skills/mine`):   any authenticated user. Targets the
 *     user's own `$DSH_HOME/skills` (rank 400 user-dsh layer).
 *
 * Upload contract (ZIP only): one base64 `.zip` whose root holds exactly one
 * top-level directory containing `SKILL.md` with frontmatter `name`
 * (`^[a-z0-9]+(-[a-z0-9]+)*$`) and `description`. Both are REQUIRED — dsh
 * ignores skills that miss either (see parseSkillFile / SKILL_NAME in
 * @deepseek-ai/dsh-skill).
 *
 * Two-phase install for overwrite safety:
 *   1. POST upload  → validate + stage the archive. If no same-name skill
 *      exists it is installed immediately; if one exists the response carries
 *      `conflict: true` + `stagedId` and nothing is touched yet.
 *   2. POST apply   → after the user confirms, atomically REPLACE the target:
 *      the previous skill directory is removed in full (files absent from the
 *      new zip are deleted too), then the staged one is renamed in.
 *
 * Discovery is watch-based on the host, so install/remove take effect without
 * an instance restart (verified: addDir/unlinkDir watch events invalidate).
 * @module dsh_ai1net/web/routes/skills
 */

import type { FastifyPluginAsync } from 'fastify'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, chownSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { requireAdmin, requireAuth } from '../middleware/authn.js'
import { scanDir } from '../security-scan.js'
import { userRoot } from '../../fs/workspace.js'

/** dsh skill-name rule (mirrors SKILL_NAME in @deepseek-ai/dsh-skill). */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Route-level body limit for uploads (base64 ~4/3 of archive size). */
const UPLOAD_BODY_LIMIT = 180 * 1024 * 1024

const STAGE_PREFIX = '.skill-upload-'
/** A staged upload id is just the staging dir name under `dataRoot`. */
const STAGE_ID_RE = /^\.skill-upload-[0-9a-f]{12}$/
/** Staging dirs older than this (ms) are garbage-collected on next upload. */
const STAGE_TTL_MS = 10 * 60 * 1000

/**
 * 上传硬上限（zip bomb 防护）。
 * `UPLOAD_BODY_LIMIT` 只限制 **HTTP body（= 压缩体）**；宿主 `quotaon /` 未启用 = **无磁盘配额**
 * ，一个 180MB 的 zip 可解压出几十 GB → 撑爆 40G 单分区、**打瘫全平台**（跨租户）。
 * 因此必须限制**解压后**的规模。
 */
const MAX_SKILL_FILES = 2000
const MAX_SKILL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024

/**
 * 「已禁用」的用户技能存放处（在 `$DSH_HOME` 下、但 **不在** `skills/` 内）。
 * dsh 的 `discoverRoot` 只扫 `$DSH_HOME/skills`，所以放进这里是"保留但不可见"= 禁用，
 * 从而在 dsh **没有 disable 机制**的前提下实现用户侧「启用 / 禁用 / 删除」。
 */
const SKILL_LIBRARY_DIR = 'skills-library'

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const e = new Error(message) as Error & { statusCode: number }
  e.statusCode = statusCode
  return e
}

/** Parse `name`/`description` from a SKILL.md frontmatter block. */
function parseSkillMeta(markdown: string): { name?: string; description?: string } {
  const block = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown)
  if (block === null) return {}
  const fm = block[1]
  const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(fm)
  const description = /^description:\s*["']?(.*?)["']?\s*$/m.exec(fm)
  return {
    name: name?.[1]?.trim(),
    description: description?.[1]?.trim(),
  }
}

async function skillMetaAt(dir: string): Promise<{ name?: string; description?: string }> {
  try {
    return parseSkillMeta(await readFileSync(join(dir, 'SKILL.md'), 'utf8'))
  } catch {
    return {}
  }
}

interface SkillSummary {
  /** On-disk directory name, always == frontmatter name. */
  dir: string
  /** Frontmatter `name`. */
  name: string
  description: string
  /** Recursive bytes. */
  size: number
  /** Recursive file count. */
  files: number
  mtimeMs: number
}

async function dirSizeAndCount(abs: string): Promise<{ size: number; files: number }> {
  let size = 0
  let files = 0
  for (const entry of await readdir(abs, { withFileTypes: true })) {
    const st = await stat(join(abs, entry.name))
    if (st.isDirectory()) {
      const sub = await dirSizeAndCount(join(abs, entry.name))
      size += sub.size
      files += sub.files
    } else {
      size += st.size
      files += 1
    }
  }
  return { size, files }
}

async function summarizeSkillDir(abs: string): Promise<SkillSummary> {
  const meta = await skillMetaAt(abs)
  const st = await stat(abs)
  const { size, files } = st.isDirectory() ? await dirSizeAndCount(abs) : { size: st.size, files: 1 }
  return {
    dir: basename(abs),
    name: meta.name ?? basename(abs),
    description: meta.description ?? '',
    size,
    files,
    mtimeMs: st.mtimeMs,
  }
}

/** List single-level skill directories under `root` (dirs only, skip hidden). */
async function listSkills(root: string): Promise<SkillSummary[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      out.push(await summarizeSkillDir(join(root, entry.name)))
    } catch {
      // entry vanished mid-scan
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** Remove staging dirs left over from abandoned uploads (TTL). */
function collectStaleStages(dataRoot: string): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dataRoot).filter((n) => n.startsWith(STAGE_PREFIX))
  } catch {
    return []
  }
  const stale: string[] = []
  for (const name of names) {
    try {
      if (Date.now() - lstatSync(join(dataRoot, name)).mtimeMs > STAGE_TTL_MS) stale.push(name)
    } catch {
      stale.push(name)
    }
  }
  return stale
}

/**
 * 累加 zip 内所有成员的**解压后**字节数（解析 `unzip -l` 的表格区）。
 * 用于 zip bomb 防护：压缩体 180MB 上限对解压规模毫无约束力。
 */
function sumUncompressedSize(payload: string): number {
  const out = execFileSync('unzip', ['-l', payload], { encoding: 'utf8', timeout: 30000 })
  let total = 0
  let inTable = false
  for (const line of out.split('\n')) {
    if (/^\s*-{5,}/.test(line)) {
      if (inTable) break // 第二条分隔线 = 表格结束
      inTable = true
      continue
    }
    if (!inTable) continue
    const n = Number(line.trim().split(/\s+/)[0])
    if (Number.isFinite(n)) total += n
  }
  return total
}

/**
 * 找出任何**非普通文件/目录**的条目（symlink / 设备 / FIFO / socket），返回其相对路径。
 *
 * ⚠️ 这是修的 P0 的根因所在：zip 的成员**可以是符号链接**，而 `unzip` 默认**原样恢复**它。
 * symlink 的目标写在 **zip 元数据**里，不在任何文件内容里 → `scanDir`（只读文件内容，且遇到
 * `!isFile()` 直接 `continue`）**永远看不到它**。而随后以 **root** 身份执行的 `chownTree` /
 * `chmodTree` 会**跟随**该链接 → **改写链接目标（宿主任意文件）的属主与权限**。
 * 实测：`-rw------- root:root` → `-rw-r--r-- <租户uid>`；指向 `/etc/shadow` 即等于
 * 把密码哈希 chmod 成 644 并 chown 给该租户。
 */
function findSpecialEntry(root: string, rel = ''): string | null {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry)
    const relPath = rel === '' ? entry : `${rel}/${entry}`
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) return relPath
    if (st.isDirectory()) {
      const hit = findSpecialEntry(abs, relPath)
      if (hit !== null) return hit
      continue
    }
    if (!st.isFile()) return relPath
  }
  return null
}

/**
 * Validate + extract a `.zip` skill archive under `<dataRoot>/<staging>`.
 * @returns staged top dir, registered skill name/description, file count.
 */
function stageZipArchive(dataRoot: string, archive: Buffer): { stage: string; topDir: string; name: string; description: string; fileCount: number } {
  const stage = join(dataRoot, STAGE_PREFIX + randomBytes(6).toString('hex'))
  const payload = join(stage, 'payload.zip')
  const unzipDir = join(stage, 'unzip')
  mkdirSync(unzipDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(payload, archive)

    // 1. List members (no extraction yet) and validate every path.
    const members = execFileSync('unzip', ['-Z1', payload], { encoding: 'utf8', timeout: 30000 }).split('\n')
    const tops = new Set<string>()
    let hasSkillMd = false
    let fileCount = 0
    for (let raw of members) {
      raw = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      if (raw === '' || raw === '.' || raw === '__MACOSX' || raw.startsWith('__MACOSX/')) continue
      if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw httpError(400, `zip member uses an absolute path: ${raw}`)
      if (raw.split('/').includes('..')) throw httpError(400, `zip member escapes the root: ${raw}`)
      const top = raw.split('/')[0]!
      if (top === '.DS_Store') continue
      tops.add(top)
      if (raw.endsWith('/SKILL.md')) hasSkillMd = true
      if (!raw.endsWith('/')) fileCount += 1
    }
    if (tops.size !== 1) {
      throw httpError(400, `zip 必须包含且仅包含一个顶层技能目录（当前 ${tops.size} 个）`)
    }
    const top = [...tops][0]!
    if (top.startsWith('.')) throw httpError(400, 'zip 顶层目录名无效（不能以 . 开头）')
    if (!hasSkillMd) throw httpError(400, 'zip 缺少 <顶层目录>/SKILL.md —— 不是 dsh 技能包')
    if (fileCount === 0) throw httpError(400, 'zip 为空（无文件）')

    // 1b. 规模上限（zip bomb 防护）——压缩体上限对解压规模无约束力。
    if (fileCount > MAX_SKILL_FILES) {
      throw httpError(400, `技能包文件数超限（${fileCount} > ${MAX_SKILL_FILES}）`)
    }
    const uncompressedBytes = sumUncompressedSize(payload)
    if (uncompressedBytes > MAX_SKILL_UNCOMPRESSED_BYTES) {
      throw httpError(
        400,
        `技能包解压后体积超限（${Math.ceil(uncompressedBytes / 1048576)}MB > ${MAX_SKILL_UNCOMPRESSED_BYTES / 1048576}MB）`,
      )
    }

    // 2. Extract.
    execFileSync('unzip', ['-q', payload, '-d', unzipDir], { timeout: 120000 })

    // 2a. 拒绝任何非普通文件条目（symlink / 设备 / FIFO / socket）——见 findSpecialEntry 注释。
    //     必须在 scanDir 之前、也必须在任何 chown/chmod 之前拦住。
    const specialEntry = findSpecialEntry(unzipDir)
    if (specialEntry !== null) {
      throw httpError(400, `技能包不允许包含符号链接/设备/管道文件：${specialEntry}`)
    }

    // 2b. Security scan (危险内容扫描) — reject obviously-malicious patterns.
    const scanFindings = scanDir(unzipDir)
    if (scanFindings.length > 0) {
      process.stderr.write(
        `[upload-scan-warnings] ${JSON.stringify({ count: scanFindings.length, findings: scanFindings.slice(0, 20) })}\n`,
      )
    }

    // 3. Validate the dsh-standard skill files inside.
    const skillMd = readFileSync(join(unzipDir, top, 'SKILL.md'), 'utf8')
    const meta = parseSkillMeta(skillMd)
    if (meta.name === undefined || !SKILL_NAME_RE.test(meta.name)) {
      throw httpError(
        400,
        `SKILL.md frontmatter name 必须为小写连字符（如 my-skill），当前为 "${meta.name ?? ''}" —— 请修改 SKILL.md 后重新打包`,
      )
    }
    if (meta.description === undefined || meta.description.trim() === '') {
      throw httpError(400, `SKILL.md frontmatter 缺少 description —— dsh 要求 name 与 description 同时存在`)
    }
    return {
      stage,
      topDir: join(unzipDir, top),
      name: meta.name,
      description: meta.description.trim(),
      fileCount,
    }
  } catch (err) {
    rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
}

function chownTree(root: string, uid: number, gid: number): void {
  lchownSync(root, uid, gid)
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry)
    const st = lstatSync(abs)
    // 绝不跟随符号链接（跟随 = 以 root 改写**链接目标**的属主）。
    // 即便 stageZipArchive 已拒绝 symlink 成员，这里也保持"不跟随"作为纵深防御。
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) chownTree(abs, uid, gid)
    else lchownSync(abs, uid, gid)
  }
}

function chmodTree(root: string, dirMode: number, fileMode: number): void {
  chmodSync(root, dirMode)
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry)
    const st = lstatSync(abs)
    // Linux 无 lchmod（ENOSYS），因此对 symlink 一律**跳过**而不是"不跟随地改"。
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) chmodTree(abs, dirMode, fileMode)
    else chmodSync(abs, fileMode)
  }
}

/**
 * Phase 2: atomically REPLACE `<targetRoot>/<name>` with the staged skill.
 * The previous directory is removed IN FULL first — files that exist only in
 * the old skill (absent from the new zip) are deleted as well.
 */
async function applyStaged(
  dataRoot: string,
  stagedId: string,
  targetRoot: string,
  owner?: { uid: number; gid: number },
): Promise<SkillSummary> {
  if (!STAGE_ID_RE.test(stagedId)) throw httpError(400, 'invalid staged id')
  const stage = join(dataRoot, stagedId)
  if (!existsSync(stage)) throw httpError(404, 'staged upload not found or expired — 请重新上传')
  const unzipDir = join(stage, 'unzip')
  let top: string | undefined
  for (const entry of readdirSync(unzipDir)) {
    if (lstatSync(join(unzipDir, entry)).isDirectory()) { top = entry; break }
  }
  if (top === undefined) throw httpError(400, 'staged skill is empty')
  const meta = await skillMetaAt(join(unzipDir, top))
  if (meta.name === undefined) throw httpError(400, 'staged skill has no valid SKILL.md')
  const target = join(targetRoot, meta.name)
  try {
    // Full replacement: remove everything the old skill had, then move the new
    // one in — files absent from the new zip cannot survive.
    if (existsSync(target)) await rm(target, { recursive: true, force: true })
    const topAbs = join(unzipDir, top)
    if (owner !== undefined) {
      chownTree(topAbs, owner.uid, owner.gid)
      chmodTree(topAbs, 0o755, 0o644)
    }
    await rename(topAbs, target)
    return await summarizeSkillDir(target)
  } finally {
    rm(stage, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface UploadBody {
  file: string
  filename: string
}

interface ApplyBody {
  stagedId: string
}

const uploadSchema = {
  body: {
    type: 'object',
    required: ['file', 'filename'],
    additionalProperties: false,
    properties: {
      file: { type: 'string', maxLength: UPLOAD_BODY_LIMIT },
      filename: { type: 'string', maxLength: 255 },
    },
  },
} as const

const applySchema = {
  body: {
    type: 'object',
    required: ['stagedId'],
    additionalProperties: false,
    properties: { stagedId: { type: 'string', maxLength: 64 } },
  },
} as const

function requireZipName(filename: string): void {
  if (!basename(filename).toLowerCase().endsWith('.zip')) {
    throw httpError(400, '仅支持 .zip 文件')
  }
}

export const skillRoutes: FastifyPluginAsync = async (app) => {
  const gc = (): void => {
    for (const stale of collectStaleStages(app.config.dataRoot)) {
      rm(join(app.config.dataRoot, stale), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ── shared: platform bundled layer, admin only ──────────────────────────
  app.get('/api/skills/shared', { preHandler: requireAdmin }, async () => {
    const root = app.config.bundledSkillDir
    await mkdir(root, { recursive: true, mode: 0o755 }).catch(() => undefined)
    return { skills: await listSkills(root) }
  })

  // Phase 1: validate + stage. No same-name skill → install immediately.
  // Same-name skill exists → 200 with conflict:true + stagedId (nothing touched).
  app.post(
    '/api/skills/shared',
    { preHandler: requireAdmin, bodyLimit: UPLOAD_BODY_LIMIT, schema: uploadSchema },
    async (request, reply) => {
      const root = app.config.bundledSkillDir
      await mkdir(root, { recursive: true, mode: 0o755 }).catch(() => undefined)
      const body = request.body as UploadBody
      try {
        requireZipName(body.filename)
        const archive = Buffer.from(body.file, 'base64')
        if (archive.length === 0) throw httpError(400, 'empty archive payload')
        gc()
        const staged = stageZipArchive(app.config.dataRoot, archive)
        const existing = existsSync(join(root, staged.name))
        if (!existing) {
          const skill = await applyStaged(app.config.dataRoot, basename(staged.stage), root)
          await app.db.audit(request.user?.id ?? null, 'install_shared_skill', JSON.stringify({ name: skill.name }))
          return { ok: true, skill }
        }
        // Conflict: keep the staged copy, ask the user to confirm replacement.
        const old = await summarizeSkillDir(join(root, staged.name))
        return {
          ok: true,
          conflict: true,
          stagedId: basename(staged.stage),
          skill: { name: staged.name, description: staged.description, files: staged.fileCount },
          existing: { name: old.name, size: old.size, files: old.files, mtimeMs: old.mtimeMs },
        }
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 400).send({ error: e.message })
      }
    },
  )

  // Phase 2: confirm replacement (full replace — old files not in the new zip are removed).
  app.post(
    '/api/skills/shared/apply',
    { preHandler: requireAdmin, schema: applySchema },
    async (request, reply) => {
      const { stagedId } = request.body as ApplyBody
      try {
        const skill = await applyStaged(app.config.dataRoot, stagedId, app.config.bundledSkillDir)
        await app.db.audit(request.user?.id ?? null, 'replace_shared_skill', JSON.stringify({ name: skill.name }))
        return { ok: true, skill }
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 400).send({ error: e.message })
      }
    },
  )

  app.delete('/api/skills/shared/:name', { preHandler: requireAdmin }, async (request, reply) => {
    const { name } = request.params as { name: string }
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'invalid_skill_name' })
    const root = app.config.bundledSkillDir
    const target = join(root, name)
    if (!existsSync(target)) return reply.code(404).send({ error: 'not_found' })
    await rm(target, { recursive: true, force: true })
    await app.db.audit(request.user?.id ?? null, 'delete_shared_skill', JSON.stringify({ name }))
    return { ok: true }
  })

  // ── mine: personal layer under $DSH_HOME/skills, any authenticated user ─
  const mineRoot = (userId: string): string => join(userRoot(app.config.dataRoot, userId), 'home', 'skills')

  /** 「已禁用」用户技能的存放处 —— 在 `$DSH_HOME` 下但不在 `skills/` 内，故 dsh 扫不到。 */
  const libraryRoot = (userId: string): string =>
    join(userRoot(app.config.dataRoot, userId), 'home', SKILL_LIBRARY_DIR)

  /** 平台共享技能（rank 600）名集合：对用户**只读**，不可禁用/删除/覆盖。 */
  const sharedNames = (): Set<string> => {
    const dir = app.config.bundledSkillDir
    if (dir === '' || !existsSync(dir)) return new Set()
    try {
      return new Set(readdirSync(dir).filter((n) => SKILL_NAME_RE.test(n)))
    } catch {
      return new Set()
    }
  }

  /** 用户技能名 → 是否被平台共享层占用（占用则 409，避免用户白上传一份永远不生效的技能）。 */
  const assertNotShared = (name: string): void => {
    if (sharedNames().has(name)) {
      throw httpError(409, `「${name}」是平台共享技能（全员只读，用户不可禁用/删除/覆盖）—— 请改用其他技能名`)
    }
  }

  async function ensureMineRoot(userId: string): Promise<{ root: string; owner: { uid: number; gid: number } }> {
    const root = mineRoot(userId)
    const home = join(userRoot(app.config.dataRoot, userId), 'home')
    const homeStat = lstatSync(home)
    const owner = { uid: homeStat.uid, gid: homeStat.gid }
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true, mode: 0o755 })
      chownSync(root, owner.uid, owner.gid)
    }
    return { root, owner }
  }

  // 列表：合并三类 —— 平台共享（locked，只读）/ 用户已启用 / 用户已禁用（库中保留）。
  app.get('/api/skills/mine', { preHandler: requireAuth }, async (request) => {
    const user = request.user!
    const { root } = await ensureMineRoot(user.id)
    const lib = libraryRoot(user.id)
    const sharedDir = app.config.bundledSkillDir
    const [enabled, disabled, shared] = await Promise.all([
      listSkills(root),
      existsSync(lib) ? listSkills(lib) : Promise.resolve([]),
      sharedDir !== '' && existsSync(sharedDir) ? listSkills(sharedDir) : Promise.resolve([]),
    ])
    return {
      skills: [
        // 平台共享层（rank 600，全员只读；dsh 无 disable 机制 → 标 locked，前端不可操作）
        ...shared.map((s) => ({ ...s, source: 'shared' as const, enabled: true, locked: true })),
        ...enabled.map((s) => ({ ...s, source: 'user' as const, enabled: true, locked: false })),
        ...disabled.map((s) => ({ ...s, source: 'user' as const, enabled: false, locked: false })),
      ],
    }
  })

  app.post(
    '/api/skills/mine',
    { preHandler: requireAuth, bodyLimit: UPLOAD_BODY_LIMIT, schema: uploadSchema },
    async (request, reply) => {
      const user = request.user!
      const { root, owner } = await ensureMineRoot(user.id)
      const body = request.body as UploadBody
      try {
        requireZipName(body.filename)
        const archive = Buffer.from(body.file, 'base64')
        if (archive.length === 0) throw httpError(400, 'empty archive payload')
        gc()
        const staged = stageZipArchive(app.config.dataRoot, archive)
        // 与平台共享技能同名 → 直接拒（否则用户会白上传一份永远被 rank 600 压住的技能）。
        try {
          assertNotShared(staged.name)
        } catch (err) {
          await rm(staged.stage, { recursive: true, force: true }).catch(() => undefined)
          throw err
        }
        if (!existsSync(join(root, staged.name))) {
          const skill = await applyStaged(app.config.dataRoot, basename(staged.stage), root, owner)
          return { ok: true, skill }
        }
        const old = await summarizeSkillDir(join(root, staged.name))
        return {
          ok: true,
          conflict: true,
          stagedId: basename(staged.stage),
          skill: { name: staged.name, description: staged.description, files: staged.fileCount },
          existing: { name: old.name, size: old.size, files: old.files, mtimeMs: old.mtimeMs },
        }
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 400).send({ error: e.message })
      }
    },
  )

  app.post(
    '/api/skills/mine/apply',
    { preHandler: requireAuth, schema: applySchema },
    async (request, reply) => {
      const user = request.user!
      const { root, owner } = await ensureMineRoot(user.id)
      const { stagedId } = request.body as ApplyBody
      try {
        const skill = await applyStaged(app.config.dataRoot, stagedId, root, owner)
        return { ok: true, skill }
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        return reply.code(e.statusCode ?? 400).send({ error: e.message })
      }
    },
  )

  /**
   * 启用：库（skills-library）→ `$DSH_HOME/skills`。
   * dsh 的 skill 发现是 watch 驱动的，所以**即时生效、无需重启实例**。
   */
  app.post('/api/skills/mine/:name/enable', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!
    const { name } = request.params as { name: string }
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'invalid_skill_name' })
    try {
      assertNotShared(name)
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 409).send({ error: e.message })
    }
    const { root, owner } = await ensureMineRoot(user.id)
    const src = join(libraryRoot(user.id), name)
    if (!existsSync(src)) return reply.code(404).send({ error: 'not_found' })
    const dst = join(root, name)
    if (existsSync(dst)) return reply.code(409).send({ error: 'already_enabled' })
    await rename(src, dst)
    chownTree(dst, owner.uid, owner.gid)
    chmodTree(dst, 0o755, 0o644)
    await app.db.audit(user.id, 'enable_skill', JSON.stringify({ name }))
    return { ok: true, skill: await summarizeSkillDir(dst) }
  })

  /**
   * 禁用：`$DSH_HOME/skills` → 库。**保留文件**（可再次启用），只是移出 dsh 的扫描根
   * —— 因为 `dsh-skill-filesystem` **没有 disable/deny 机制**。
   */
  app.post('/api/skills/mine/:name/disable', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!
    const { name } = request.params as { name: string }
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'invalid_skill_name' })
    try {
      assertNotShared(name)
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 409).send({ error: e.message })
    }
    const { root, owner } = await ensureMineRoot(user.id)
    const src = join(root, name)
    if (!existsSync(src)) return reply.code(404).send({ error: 'not_found' })
    const lib = libraryRoot(user.id)
    mkdirSync(lib, { recursive: true, mode: 0o755 })
    chownSync(lib, owner.uid, owner.gid)
    const dst = join(lib, name)
    if (existsSync(dst)) await rm(dst, { recursive: true, force: true })
    await rename(src, dst)
    await app.db.audit(user.id, 'disable_skill', JSON.stringify({ name }))
    return { ok: true }
  })

  /** 删除：库与启用位置一起删（彻底移除用户自建技能）。 */
  app.delete('/api/skills/mine/:name', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user!
    const { name } = request.params as { name: string }
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'invalid_skill_name' })
    try {
      assertNotShared(name)
    } catch (err) {
      const e = err as Error & { statusCode?: number }
      return reply.code(e.statusCode ?? 409).send({ error: e.message })
    }
    const targets = [join(mineRoot(user.id), name), join(libraryRoot(user.id), name)]
    const present = targets.filter((t) => existsSync(t))
    if (present.length === 0) return reply.code(404).send({ error: 'not_found' })
    for (const t of present) await rm(t, { recursive: true, force: true })
    await app.db.audit(user.id, 'delete_skill', JSON.stringify({ name }))
    return { ok: true }
  })
}
