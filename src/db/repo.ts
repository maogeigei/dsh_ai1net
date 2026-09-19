/**
 * Synchronous SQLite data access. This is the raw layer behind
 * {@link SqliteAdapter}; the route layer must never import these functions
 * directly — it goes through {@link DbAdapter} so Postgres can be substituted.
 *
 * All access is parameterized (prepared statements). Functions take the
 * connection explicitly so they stay free of Fastify/app state and testable.
 * @module dsh_ai1net/db/repo
 */

import { randomUUID } from 'node:crypto'
import type { Database } from './connection.js'
import { prepare } from './prepared.js'
import {
  clusterInstanceId,
  toBusinessPlugin,
  toDomain,
  toDshHost,
  toDshInstance,
  toEmailCode,
  toPublicUser,
  toSession,
  toUser,
  toWorkspace,
  type BusinessPlugin,
  type ClaimResult,
  type CredentialKey,
  type CredentialKeyMeta,
  type CredentialLandingRow,
  type CreateSessionInput,
  type CreateUserInput,
  type Domain,
  type DshHost,
  type DshHostStatus,
  type DshInstance,
  type DshInstanceRole,
  type DshInstanceStatus,
  type EmailCodeCounts,
  type EmailCodeRow,
  type PublicUser,
  type RecordEmailCodeInput,
  type SessionRow,
  type SessionUser,
  type UpsertBusinessPluginInput,
  type UpsertDshHostInput,
  type UpsertDshInstanceInput,
  type User,
  type UserRole,
  type Workspace,
} from './types.js'

const USER_COLS =
  'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by, uid, email, shared_model_granted'
const EMAIL_CODE_COLS =
  'id, email, purpose, code_hash, status, attempts, ip, username, reason, created_at, expires_at, consumed_at'
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'
const BUSINESS_PLUGIN_COLS = 'id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at'
const INSTANCE_COLS =
  'id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch, '
  + 'host_id, epoch, heartbeat_at, lease_until' // v7 集群化归属/租约（T08 S2）—— 漏了它们会让 hostId 恒为 null

export function createUser(db: Database, input: CreateUserInput, baseUid: number): User {
  const createdAt = Date.now()
  return db.transaction((): User => {
    const info = prepare(db,
      'INSERT INTO users (id, username, pass_hash, role, home_dir, email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(input.id, input.username, input.passHash, input.role, input.homeDir, input.email ?? null, createdAt)
    // SQLite's implicit rowid is the per-user incrementing integer; uid = baseUid + it.
    const uid = baseUid + Number(info.lastInsertRowid)
    prepare(db, 'UPDATE users SET uid = ? WHERE id = ?').run(uid, input.id)
    return {
      id: input.id,
      username: input.username,
      pass_hash: input.passHash,
      role: input.role,
      home_dir: input.homeDir,
      api_key_ref: null,
      created_at: createdAt,
      approved_by: null,
      uid,
      email: input.email ?? null,
      // v11：新用户**未授权**平台共享模型（默认关闭）—— 与列默认值一致，这里显式写出来
      // 是为了让"新用户拿到什么"在这一个地方就能读全，不必再去翻迁移 SQL。
      shared_model_granted: false,
    }
  })()
}

export function findUserByUsername(db: Database, username: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE username = ?`).get(username)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

/** Case-insensitive username lookup (for subdomain routing). */
export function findUserBySlug(db: Database, slug: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE LOWER(username) = ?`).get(slug.toLowerCase())
  return row ? toUser(row as Record<string, unknown>) : undefined
}

/** v10：注册邮箱查重（大小写不敏感）。 */
export function findUserByEmail(db: Database, email: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE LOWER(email) = ?`).get(email.toLowerCase())
  return row ? toUser(row as Record<string, unknown>) : undefined
}

// ── v10 邮箱验证码 ────────────────────────────────────────────────────────────
// 全部计数都**现算**（不维护冗余计数器）：省掉"计数器与事实不一致"的整类缺陷，
// 代价只是一次带索引的 COUNT；量级（每邮箱每小时个位数行）完全够用。

export function recordEmailCode(db: Database, input: RecordEmailCodeInput): void {
  prepare(db,
    `INSERT INTO email_codes (${EMAIL_CODE_COLS}) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.id,
    input.email,
    input.purpose,
    input.codeHash,
    input.status,
    input.ip ?? null,
    input.username ?? null,
    input.reason ?? null,
    input.createdAt,
    input.expiresAt ?? null,
  )
}

export function emailCodeCounts(db: Database, email: string, ip: string | null, since: number): EmailCodeCounts {
  const row = prepare(db, `
    SELECT
      (SELECT COUNT(*) FROM email_codes WHERE email = ? AND created_at >= ?)                        AS email_total,
      (SELECT COUNT(*) FROM email_codes WHERE email = ? AND created_at >= ? AND status = 'sent')    AS email_sent,
      (SELECT COALESCE(MAX(created_at), 0) FROM email_codes WHERE email = ?)                        AS email_last_at,
      (SELECT COUNT(*) FROM email_codes WHERE ip IS NOT NULL AND ip = ? AND created_at >= ?)        AS ip_total,
      (SELECT COUNT(*) FROM email_codes WHERE created_at >= ?)                                      AS global_total
  `).get(email, since, email, since, email, ip, since, since) as Record<string, unknown>
  return {
    emailTotal: Number(row.email_total ?? 0),
    emailSent: Number(row.email_sent ?? 0),
    emailLastAt: Number(row.email_last_at ?? 0),
    ipTotal: Number(row.ip_total ?? 0),
    globalTotal: Number(row.global_total ?? 0),
  }
}

export function latestSentEmailCode(db: Database, email: string, purpose: string): EmailCodeRow | undefined {
  const row = prepare(db,
    `SELECT ${EMAIL_CODE_COLS} FROM email_codes WHERE email = ? AND purpose = ? AND status = 'sent' `
    + 'ORDER BY created_at DESC LIMIT 1',
  ).get(email, purpose)
  return row ? toEmailCode(row as Record<string, unknown>) : undefined
}

export function bumpEmailCodeAttempts(db: Database, id: string, consume: boolean, now: number): boolean {
  const info = consume
    ? prepare(db, 'UPDATE email_codes SET attempts = attempts + 1, consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(now, id)
    : prepare(db, 'UPDATE email_codes SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL').run(id)
  return info.changes > 0
}

export function consumeEmailCode(db: Database, id: string, now: number): boolean {
  const info = prepare(db, 'UPDATE email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(now, id)
  return info.changes > 0
}

export function purgeEmailCodes(db: Database, before: number): number {
  return prepare(db, 'DELETE FROM email_codes WHERE created_at < ?').run(before).changes
}

export function findUserById(db: Database, id: string): User | undefined {
  const row = prepare(db, `SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id)
  return row ? toUser(row as Record<string, unknown>) : undefined
}

export function listPublicUsers(db: Database): PublicUser[] {
  const rows = prepare(db, `SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toPublicUser(toUser(row)))
}

export function countAdmins(db: Database): number {
  const row = prepare(db, `SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).get() as { n: number }
  return row.n
}

export function setUserRole(db: Database, id: string, role: UserRole, approvedBy?: string): boolean {
  const info =
    approvedBy === undefined
      ? prepare(db, 'UPDATE users SET role = ? WHERE id = ?').run(role, id)
      : prepare(db, 'UPDATE users SET role = ?, approved_by = ? WHERE id = ?').run(role, approvedBy, id)
  return info.changes > 0
}

export function createSession(db: Database, input: CreateSessionInput): void {
  prepare(db,
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null)
}

export function findSession(db: Database, tokenHash: string): SessionRow | undefined {
  const row = prepare(db, 'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = ?')
    .get(tokenHash)
  return row ? toSession(row as Record<string, unknown>) : undefined
}

export function deleteSession(db: Database, tokenHash: string): void {
  prepare(db, 'DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
}

export function deleteUserSessions(db: Database, userId: string): void {
  prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** Append an audit entry. `actor` is a user id or `'system'`. */
export function audit(db: Database, actor: string | null, action: string, detail?: string | null): void {
  prepare(db, 'INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(),
    actor,
    action,
    detail ?? null,
  )
}

export function findWorkspaceByPath(db: Database, userId: string, relPath: string): Workspace | undefined {
  const row = prepare(db, 'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = ? AND rel_path = ?')
    .get(userId, relPath)
  return row ? toWorkspace(row as Record<string, unknown>) : undefined
}

/** Upsert a workspace row by (user, relPath); create with a derived name. */
export function getOrCreateWorkspace(db: Database, userId: string, relPath: string): Workspace {
  const existing = findWorkspaceByPath(db, userId, relPath)
  if (existing !== undefined) return existing
  const id = randomUUID()
  const segments = relPath.split('/').filter(Boolean)
  const name = segments.at(-1) ?? 'root'
  prepare(db, 'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    userId,
    name,
    relPath,
    Date.now(),
  )
  return { id, userId, name, relPath, createdAt: Date.now() }
}

/** Replace a workspace's plugin selection (insert/delete in one transaction). */
export function setFolderPlugins(
  db: Database,
  workspaceId: string,
  selections: ReadonlyArray<{ id: string; enabled: boolean }>,
): void {
  const tx = db.transaction(() => {
    prepare(db, 'DELETE FROM folder_plugins WHERE workspace_id = ?').run(workspaceId)
    const insert = prepare(db,
      'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES (?, ?, ?, ?)',
    )
    for (const selection of selections) {
      insert.run(workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now())
    }
  })
  tx()
}

/** Enabled plugin ids for a workspace. */
export function getEnabledPluginIds(db: Database, workspaceId: string): string[] {
  const rows = prepare(db, 'SELECT plugin_id FROM folder_plugins WHERE workspace_id = ? AND enabled = 1')
    .all(workspaceId) as Array<{ plugin_id: string }>
  return rows.map((row) => row.plugin_id)
}

export function findDomainByUser(db: Database, userId: string): Domain | undefined {
  const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = ?`).get(userId)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function findDomainById(db: Database, id: string): Domain | undefined {
  const row = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains WHERE id = ?`).get(id)
  return row ? toDomain(row as Record<string, unknown>) : undefined
}

export function listDomains(db: Database): Domain[] {
  const rows = prepare(db, `SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toDomain(row))
}

/** Upsert a user's custom domain (resetting `verified` to 0). */
export function upsertDomain(db: Database, userId: string, domain: string, nginxConfig: string): Domain {
  prepare(db, `
    INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      domain = excluded.domain,
      verified = 0,
      nginx_config = excluded.nginx_config,
      updated_at = excluded.updated_at
  `).run(randomUUID(), userId, domain, nginxConfig, Date.now())
  return findDomainByUser(db, userId)!
}

/**
 * 两个凭据列表共用的列清单与行映射—— 抽出来是为了**两处不可能漂**：
 * 之前 `listCredentialKeys` 与 `listEnabledCredentialKeys` 各写一份 SELECT，
 * 加一次列就要改两处，漏一处就是"一个列表有 route、另一个没有"。
 */
const CREDENTIAL_COLS = 'id, key_name, enabled, updated_at, route, base_url, api, models'

interface CredentialRow {
  id: string
  key_name: string
  enabled: number
  updated_at: number
  route: string | null
  base_url: string | null
  api: string | null
  models: string | null
}

function toCredentialKey(r: CredentialRow): CredentialKey {
  return {
    id: r.id,
    name: r.key_name,
    enabled: r.enabled === 1,
    updatedAt: r.updated_at,
    route: r.route,
    baseUrl: r.base_url,
    api: r.api,
    models: r.models,
  }
}

/** List a user's named credential keys (metadata only). */
export function listCredentialKeys(db: Database, userId: string): CredentialKey[] {
  const rows = prepare(
    db,
    `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = ? ORDER BY updated_at DESC`,
  ).all(userId) as CredentialRow[]
  return rows.map(toCredentialKey)
}

/**
 * **内置 DeepSeek 条目**的 encrypted ref（**语义重定义**，必须读这一条）。
 *
 * 老语义是「那一把启用的 key」—— 当时 `setCredentialKey` 会先 `SET enabled = 0` 全关，
 * 所以 `enabled = 1` **最多一行**，不带 ORDER BY 也唯一。
 * 用户口径改成「条目各自开关、都能同时启用」后，互斥被删（见 `setCredentialKey`）⇒
 * `WHERE enabled = 1` 可能命中**多行**，而**没有 ORDER BY 就是"任取一条"** ——
 * `auth.ts` 的 `keySourceOf()` 与 `server.ts` 的 `resolveApiKey()` 会因此**随机飘**。
 *
 * ⇒ 这里把语义钉死为：**已启用、且是内置 DeepSeek（`base_url` 为空）的最新一条**。
 * 自定义厂家**不算**"自己的 DeepSeek key"（它们各自有自己的 ref 与 settings 段）。
 * @returns 该 ref，或 `null`（用户没有任何启用的内置条目）。
 */
export function getEnabledCredentialKeyRef(db: Database, userId: string): string | null {
  const row = prepare(
    db,
    "SELECT secret_ref FROM credential_vault WHERE user_id = ? AND enabled = 1 AND (base_url IS NULL OR base_url = '') ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get(userId) as { secret_ref: string } | undefined
  return row?.secret_ref ?? null
}

/**
 * Upsert a named key by `name` and enable it —— **不动**其它条目。
 *
 * ⚠️ 老行为是「先 `SET enabled = 0` 全关，再开这一个」（单选）。用户口径已改为
 * 「条目各自开关、都能同时启用」，所以那一行**已删**：否则用户每加一把 key，
 * 别的厂家就被静默关掉。要"只开这一个"请显式先关别的（`toggleCredentialKey`）。
 * @param meta - 模型厂家元数据（route / endpoint / 协议 / 模型清单），见 {@link CredentialKeyMeta}。
 */
export function setCredentialKey(
  db: Database,
  userId: string,
  name: string,
  encryptedRef: string,
  meta: CredentialKeyMeta = {},
): CredentialKey {
  const route = meta.route ?? null
  const baseUrl = meta.baseUrl ?? null
  const api = meta.api ?? null
  const models = meta.models ?? null
  const id = db.transaction(() => {
    const existing = prepare(db, 'SELECT id FROM credential_vault WHERE user_id = ? AND key_name = ?').get(
      userId,
      name,
    ) as { id: string } | undefined
    if (existing !== undefined) {
      prepare(
        db,
        'UPDATE credential_vault SET secret_ref = ?, route = ?, base_url = ?, api = ?, models = ?, enabled = 1, updated_at = ? WHERE id = ?',
      ).run(encryptedRef, route, baseUrl, api, models, Date.now(), existing.id)
      return existing.id
    }
    const newId = randomUUID()
    prepare(
      db,
      'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, route, base_url, api, models, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    ).run(newId, userId, name, encryptedRef, route, baseUrl, api, models, Date.now())
    return newId
  })()
  return { id, name, enabled: true, updatedAt: Date.now(), route, baseUrl, api, models }
}

/**
 * 启用某一个条目（**改为非互斥**）。
 *
 * 老语义是「单选」：先 `SET enabled = 0` 把该用户所有条目关掉，再开这一个。
 * 用户口径改成「各自开关、可同时启用」之后，那一步会**悄悄关掉别的已启用条目**
 * （用户看不出为什么换了个厂家另一个就不生效了），所以这里退化成
 * `toggleCredentialKey(id, true)` 的同义实现 —— **保留函数名只为接口兼容**。
 */
export function selectCredentialKey(db: Database, userId: string, id: string): boolean {
  return toggleCredentialKey(db, userId, id, true)
}

/**
 * 打开/关闭**单个**条目（用户口径：条目各自开关、可同时启用）。
 * 与 `selectCredentialKey`（名字带"单选"但已改为非互斥）的差别：这里**只碰这一行**。
 * @returns 是否命中了该用户下的这一行（false = 不存在或不属于他）。
 */
export function toggleCredentialKey(db: Database, userId: string, id: string, enabled: boolean): boolean {
  const info = prepare(db, 'UPDATE credential_vault SET enabled = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
    enabled ? 1 : 0,
    Date.now(),
    id,
    userId,
  )
  return info.changes > 0
}

/** 该用户**所有已启用**的条目（含 route / base_url / api / models）—— spawn 时按它们写实例配置。 */
export function listEnabledCredentialKeys(db: Database, userId: string): CredentialKey[] {
  const rows = prepare(
    db,
    `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC`,
  ).all(userId) as CredentialRow[]
  return rows.map(toCredentialKey)
}

/**
 * 该用户**所有已启用**的条目 + 各自 encrypted ref —— **仅供落地层**。
 * 与 `listEnabledCredentialKeys` 的差别只有一个：多返回 `secret_ref`。
 * 单独一个函数是为了让"密文"这件事**不可能**顺着 `/api/me/keys` 漏出去。
 */
export function listCredentialLandingRows(db: Database, userId: string): CredentialLandingRow[] {
  const rows = prepare(
    db,
    'SELECT key_name, route, base_url, api, models, secret_ref FROM credential_vault WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC',
  ).all(userId) as Array<{
    key_name: string
    route: string | null
    base_url: string | null
    api: string | null
    models: string | null
    secret_ref: string
  }>
  return rows.map((r) => ({
    name: r.key_name,
    route: r.route,
    baseUrl: r.base_url,
    api: r.api,
    models: r.models,
    encryptedRef: r.secret_ref,
  }))
}

/**
 * 该用户是否启用「平台共享模型」—— **用户侧偏好**，开关它**不动** admin 的配置。
 *
 * 缺失行一律按 `true` 处理：V6 迁移给所有老用户填了默认 1，而"查不到这个人"时
 * 也不该因为一个开关把共享 key 断掉（宁可多给，不可少给）。
 */
export function getSharedModelEnabled(db: Database, userId: string): boolean {
  const row = prepare(db, 'SELECT shared_model_enabled FROM users WHERE id = ?').get(userId) as
    | { shared_model_enabled: number }
    | undefined
  return row === undefined ? true : row.shared_model_enabled !== 0
}

/** 打开/关闭「平台共享模型」。@returns 是否命中该用户。 */
export function setSharedModelEnabled(db: Database, userId: string, enabled: boolean): boolean {
  const info = prepare(db, 'UPDATE users SET shared_model_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, userId)
  return info.changes > 0
}

/**
 * **管理员**是否已给该用户开启「平台共享模型」（v11）—— 逐用户门禁。
 *
 * 缺失行按 **`false`**（= 未授权）：这与 `getSharedModelEnabled` 的"缺失按 true"**故意相反**，
 * 因为两者方向不同 —— 用户偏好缺失时"多给"是无害的，而门禁缺失时"多给"就等于把门打开了。
 * 门禁类判据一律**失败关闭**。
 */
export function getSharedModelGranted(db: Database, userId: string): boolean {
  const row = prepare(db, 'SELECT shared_model_granted FROM users WHERE id = ?').get(userId) as
    | { shared_model_granted: number }
    | undefined
  return row === undefined ? false : row.shared_model_granted !== 0
}

/** 设置「平台共享模型」的管理员授权。@returns 是否命中该用户。 */
export function setSharedModelGranted(db: Database, userId: string, granted: boolean): boolean {
  const info = prepare(db, 'UPDATE users SET shared_model_granted = ? WHERE id = ?').run(granted ? 1 : 0, userId)
  return info.changes > 0
}

/** Delete a named key (by id, scoped to the user). */
export function deleteCredentialKey(db: Database, userId: string, id: string): boolean {
  const info = prepare(db, 'DELETE FROM credential_vault WHERE id = ? AND user_id = ?').run(id, userId)
  return info.changes > 0
}

/**
 * Permanently delete a user and all owned rows. Child tables are removed
 * explicitly (in dependency order) rather than relying on FK cascade, so the
 * cleanup works even when `PRAGMA foreign_keys` is off. Returns false when the
 * user does not exist.
 */
export function deleteUser(db: Database, userId: string): boolean {
  const deleted = db.transaction(() => {
    prepare(db, 'DELETE FROM credential_vault WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM domains WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM sessions WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM dsh_instances WHERE user_id = ?').run(userId)
    prepare(db, 'DELETE FROM audit_log WHERE actor = ?').run(userId)
    prepare(
      db,
      'DELETE FROM folder_plugins WHERE workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)',
    ).run(userId)
    prepare(db, 'DELETE FROM workspaces WHERE user_id = ?').run(userId)
    const info = prepare(db, 'DELETE FROM users WHERE id = ?').run(userId)
    return info.changes > 0
  })()
  return deleted as boolean
}

/** Set the verified flag on a domain. */
export function setDomainVerified(db: Database, id: string, verified: boolean): boolean {
  const info = prepare(db, 'UPDATE domains SET verified = ?, updated_at = ? WHERE id = ?')
    .run(verified ? 1 : 0, Date.now(), id)
  return info.changes > 0
}

/** Whether any of a user's sessions is still unexpired. */
export function hasActiveSession(db: Database, userId: string): boolean {
  const row = prepare(db, 'SELECT 1 FROM sessions WHERE user_id = ? AND expires_at > ? LIMIT 1')
    .get(userId, Date.now()) as { 1: number } | undefined
  return row !== undefined
}

/** Look up a session and its user in a single join. */
export function findSessionWithUser(db: Database, tokenHash: string): SessionUser | undefined {
  const row = prepare(
    db,
    `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by, u.uid,
            u.shared_model_granted, u.email, s.expires_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token_hash = ?`,
  ).get(tokenHash) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  return { expiresAt: row.expires_at as number, user: toUser(row) }
}

/** Assign a Linux uid to a user (legacy backfill). */
export function setUserUid(db: Database, userId: string, uid: number): void {
  prepare(db, 'UPDATE users SET uid = ? WHERE id = ?').run(uid, userId)
}

/** Ids of users whose uid is still null (legacy rows awaiting backfill). */
export function listUsersWithoutUid(db: Database): string[] {
  const rows = prepare(db, 'SELECT id FROM users WHERE uid IS NULL').all() as Array<{ id: string }>
  return rows.map((row) => row.id)
}

/** Record (or re-record) an instance's desired state. Keyed on the caller's
 * deterministic id, so a relaunch overwrites rather than duplicating. */
export function upsertInstance(db: Database, input: UpsertDshInstanceInput): void {
  prepare(db, `
    INSERT INTO dsh_instances (id, user_id, workspace_id, role, pid, port, status, started_at, folder, patch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      pid = excluded.pid,
      port = excluded.port,
      status = excluded.status,
      started_at = excluded.started_at,
      folder = excluded.folder,
      patch = excluded.patch
  `).run(
    input.id,
    input.userId,
    input.workspaceId ?? null,
    input.role,
    input.pid ?? null,
    input.port ?? null,
    input.status,
    Date.now(),
    input.folder ?? null,
    input.patch ?? null,
  )
}

export function findInstance(db: Database, id: string): DshInstance | undefined {
  const row = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE id = ?`).get(id)
  return row ? toDshInstance(row as Record<string, unknown>) : undefined
}

export function findUserInstance(db: Database, userId: string, role: DshInstanceRole): DshInstance | undefined {
  const row = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE user_id = ? AND role = ?`).get(userId, role)
  return row ? toDshInstance(row as Record<string, unknown>) : undefined
}

export function listInstancesByRole(db: Database, role: DshInstanceRole): DshInstance[] {
  const rows = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE role = ? ORDER BY started_at ASC`)
    .all(role) as Array<Record<string, unknown>>
  return rows.map((row) => toDshInstance(row))
}

/** Record a state transition; an `outcome` also stamps `last_exit`. */
export function setInstanceStatus(
  db: Database,
  id: string,
  status: DshInstanceStatus,
  outcome?: { exitCode?: number; lastError?: string },
): boolean {
  const info =
    outcome === undefined
      ? prepare(db, 'UPDATE dsh_instances SET status = ? WHERE id = ?').run(status, id)
      : prepare(db, 'UPDATE dsh_instances SET status = ?, last_exit = ?, exit_code = ?, last_error = ? WHERE id = ?')
          .run(status, Date.now(), outcome.exitCode ?? null, outcome.lastError ?? null, id)
  return info.changes > 0
}

export function deleteInstance(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM dsh_instances WHERE id = ?').run(id)
  return info.changes > 0
}

export function deleteUserInstances(db: Database, userId: string): void {
  prepare(db, 'DELETE FROM dsh_instances WHERE user_id = ?').run(userId)
}

// ── business plugins (系统外插件候选池) ────────────────────────────────

export function listBusinessPlugins(db: Database): BusinessPlugin[] {
  const rows = prepare(db, `SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins ORDER BY name ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toBusinessPlugin(row))
}

export function findBusinessPlugin(db: Database, id: string): BusinessPlugin | undefined {
  const row = prepare(db, `SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins WHERE id = ?`).get(id)
  return row ? toBusinessPlugin(row as Record<string, unknown>) : undefined
}

/**
 * Upsert a candidate-pool row keyed on the bundle package name (`id`). Same-name
 * upload REPLACES the row — the caller removes the previous tgz file first so no
 * stale artifact survives.
 */
export function upsertBusinessPlugin(db: Database, input: UpsertBusinessPluginInput): BusinessPlugin {
  prepare(db, `
    INSERT INTO business_plugins (id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      version = excluded.version,
      tgz_path = excluded.tgz_path,
      file_size = excluded.file_size,
      uploaded_by = excluded.uploaded_by,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.name,
    input.description ?? null,
    input.version ?? null,
    input.tgzPath,
    input.fileSize,
    input.uploadedBy,
    Date.now(),
    Date.now(),
  )
  return findBusinessPlugin(db, input.id)!
}

export function deleteBusinessPlugin(db: Database, id: string): boolean {
  const info = prepare(db, 'DELETE FROM business_plugins WHERE id = ?').run(id)
  return info.changes > 0
}

// ── 集群化：worker 注册表 + 实例归属/租约（v7；T08 S2 / 设计 §3.1–§3.2）────────
//
// ⚠️ local 模式**不调用**这些函数（`LocalSpawner` 靠进程内 Map + 单机互斥），
//    所以它们的存在不会改变现有单机行为。

const HOST_COLS = 'id, endpoint, via, network_id, agent_token, capacity_mb, used_mb, status, last_heartbeat'

/** 注册/更新一台 worker。join 幂等：同 id 重复执行 = 更新（并把它标回 `up`）。
 *
 * ⚠️ `via` 与 `networkId` **省略时不覆盖已有值**（`COALESCE` 到旧值）：否则一次不带它们的
 * join 会把回填好的 `local` / 已划定的网络归属冲回列默认值（那种漂移在换中继、建第二张网之前
 * **看不出症状**）。
 */
export function upsertDshHost(db: Database, input: UpsertDshHostInput): DshHost {
  prepare(db, `
    INSERT INTO dsh_hosts (id, endpoint, via, network_id, agent_token, capacity_mb, used_mb, status, last_heartbeat)
    VALUES (?, ?, COALESCE(?, 'manager-ssh'), COALESCE(?, 'ops'), ?, ?, 0, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      endpoint    = excluded.endpoint,
      via         = COALESCE(?, dsh_hosts.via),
      network_id  = COALESCE(?, dsh_hosts.network_id),
      agent_token = excluded.agent_token,
      capacity_mb = excluded.capacity_mb,
      status      = excluded.status
  `).run(
    input.id,
    input.endpoint,
    input.via ?? null,
    input.networkId ?? null,
    input.agentToken,
    input.capacityMb,
    input.status ?? 'up',
    input.via ?? null,
    input.networkId ?? null,
  )
  const row = prepare(db, `SELECT ${HOST_COLS} FROM dsh_hosts WHERE id = ?`).get(input.id)
  return toDshHost(row as Record<string, unknown>)
}

export function findDshHost(db: Database, id: string): DshHost | undefined {
  const row = prepare(db, `SELECT ${HOST_COLS} FROM dsh_hosts WHERE id = ?`).get(id)
  return row ? toDshHost(row as Record<string, unknown>) : undefined
}

export function listDshHosts(db: Database): DshHost[] {
  const rows = prepare(db, `SELECT ${HOST_COLS} FROM dsh_hosts ORDER BY id ASC`).all() as Array<
    Record<string, unknown>
  >
  return rows.map((row) => toDshHost(row))
}

/** 心跳/状态上报（只更新显式给出的字段，避免 heartbeat 覆盖 status）。 */
export function setDshHostStatus(
  db: Database,
  id: string,
  status: DshHostStatus,
  usedMb?: number,
  heartbeatAt?: number,
): boolean {
  const info = prepare(db, `
    UPDATE dsh_hosts
       SET status = ?,
           used_mb = COALESCE(?, used_mb),
           last_heartbeat = COALESCE(?, last_heartbeat)
     WHERE id = ?
  `).run(status, usedMb ?? null, heartbeatAt ?? null, id)
  return info.changes > 0
}

/**
 * **原子抢占**某用户 main 实例的归属（承重墙）。仅当"无人持有 **或** 租约已过期"才成功，
 * 成功时 `epoch` +1（fencing token）。失败时返回当前持有者与租约到期时刻。
 */
export function claimInstance(
  db: Database,
  userId: string,
  hostId: string,
  ttlMs: number,
  meta?: { folder?: string; patch?: string },
): ClaimResult {
  const now = Date.now()
  const id = clusterInstanceId(userId)
  // 新用户没有 dsh_instances 行 ⇒ 先保证行存在（否则 UPDATE 影响 0 行被误判为"有人在管"）。
  prepare(db, `
    INSERT INTO dsh_instances (id, user_id, role, status)
    VALUES (?, ?, 'main', 'starting')
    ON CONFLICT(id) DO NOTHING
  `).run(id, userId)
  // ⚠️ **必须把 folder/patch 一起落库**（2026-09-15 实测踩到）：集群模式下实例行是这里建的，
  //    而 local 模式不写库 ⇒ 若这里不记，`folder` 永远是 NULL，**迁移时复现不了启动参数**
  //    （表现为 `bwrap: Can't chdir to :` 空路径 ⇒ 崩溃循环）。用 COALESCE 保证不覆盖已有值。
  const info = prepare(db, `
    UPDATE dsh_instances
       SET host_id = ?, epoch = epoch + 1, heartbeat_at = ?, lease_until = ?,
           folder = COALESCE(?, folder), patch = COALESCE(?, patch)
     WHERE id = ? AND (host_id IS NULL OR lease_until < ?)
  `).run(hostId, now, now + ttlMs, meta?.folder ?? null, meta?.patch ?? null, id, now)
  const row = prepare(db, 'SELECT host_id, epoch, lease_until FROM dsh_instances WHERE id = ?').get(id) as
    | { host_id: string | null; epoch: number; lease_until: number }
    | undefined
  if (row === undefined) return { ok: false, holder: null, leaseUntil: 0 }
  return info.changes > 0
    ? { ok: true, epoch: row.epoch, leaseUntil: row.lease_until }
    : { ok: false, holder: row.host_id, leaseUntil: row.lease_until }
}

/** 续租。**必须带 epoch**：不匹配说明已被他人抢占 ⇒ 返回 false（fencing 生效）。 */
export function renewInstanceLease(
  db: Database,
  userId: string,
  hostId: string,
  epoch: number,
  ttlMs: number,
): boolean {
  const now = Date.now()
  const info = prepare(db, `
    UPDATE dsh_instances SET heartbeat_at = ?, lease_until = ?
     WHERE id = ? AND host_id = ? AND epoch = ?
  `).run(now, now + ttlMs, clusterInstanceId(userId), hostId, epoch)
  return info.changes > 0
}

/**
 * 主动释放**租约**（停实例时）。带 epoch 校验，避免误清他人的归属。
 *
 * ⚠️ **只清 `lease_until`，保留 `host_id`**（2026-09-15 生产切换暴露）：
 * `host_id` 的语义是「**这个用户的数据在哪台机器**」—— 用户的工作区在**本地盘**上，
 * 把归属一起清掉就等于**丢掉粘性锚点**，下次启动可能被调度到没有他数据的机器上（工作区看起来是空的）。
 * 「谁现在在托管」是**租约**（`lease_until`）的语义，所以释放只该清租约。
 */
export function releaseInstanceLease(db: Database, userId: string, hostId: string, epoch: number): boolean {
  const info = prepare(db, `
    UPDATE dsh_instances SET lease_until = 0
     WHERE id = ? AND host_id = ? AND epoch = ?
  `).run(clusterInstanceId(userId), hostId, epoch)
  return info.changes > 0
}

/**
 * **钉住**某用户的归属（首次触达其工作区时用）：只写 `host_id`，不动 epoch/租约。
 *
 * 为什么需要：新用户还没有归属，`selectHost` 会在**写文件那一步**与**launch 那一步**各自选一次，
 * 两次可能选到不同机器 ⇒ 「文件写到 A、实例起在 B」⇒ 实例看不到自己的文件（2026-09-15 实测）。
 * 首次触达就把归属钉住，后续（含 launch）都走粘性，两面必然一致。
 */
export function pinInstanceHost(db: Database, userId: string, hostId: string): void {
  const now = Date.now()
  const id = clusterInstanceId(userId)
  prepare(db, `
    INSERT INTO dsh_instances (id, user_id, role, status, host_id, epoch, heartbeat_at, lease_until)
    VALUES (?, ?, 'main', 'stopped', ?, 0, 0, 0)
    ON CONFLICT(id) DO NOTHING
  `).run(id, userId, hostId)
  prepare(db, `
    UPDATE dsh_instances SET host_id = ?
     WHERE id = ? AND (host_id IS NULL OR lease_until < ?)
  `).run(hostId, id, now)
}

/** 租约过期但仍标着归属的 main 实例（供巡检/自愈；**不等于可以立即接管**，见 R9）。 */
export function listExpiredInstanceLeases(db: Database, now: number): DshInstance[] {
  const rows = prepare(db, `
    SELECT ${INSTANCE_COLS} FROM dsh_instances
     WHERE role = 'main' AND host_id IS NOT NULL AND lease_until < ? AND status <> 'stopped'
     ORDER BY lease_until ASC
  `).all(now) as Array<Record<string, unknown>>
  return rows.map((row) => toDshInstance(row))
}

/** 某 worker 上的全部实例 —— 对账**一次拿回整机**（替代逐用户查询）。 */
export function listInstancesByHost(db: Database, hostId: string): DshInstance[] {
  const rows = prepare(db, `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE host_id = ? ORDER BY user_id ASC`).all(
    hostId,
  ) as Array<Record<string, unknown>>
  return rows.map((row) => toDshInstance(row))
}
