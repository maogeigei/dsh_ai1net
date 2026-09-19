/**
 * Postgres backend for {@link DbAdapter} via node-postgres (`pg`). Used when
 * a `DSH_AI1NET_DB_URL` is set. All methods are
 * genuinely async; transactions use {@link withTx}.
 * @module dsh_ai1net/db/pg
 */

import { randomUUID } from 'node:crypto'
import { Pool, types, type PoolClient } from 'pg'
import type { DbAdapter } from './adapter.js'
import { mapPgError } from './errors.js'
import { runPgMigrations } from './schema.js'
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

// Postgres returns int8 (BIGINT) as a string to avoid JS 53-bit precision loss.
// Our only BIGINT columns are epoch-*milliseconds*, which stay well below 2^53,
// so parse them back to numbers — the shared row mappers then read numbers in
// both backends. This is process-global and idempotent.
types.setTypeParser(20, (value: string) => Number(value))

// ⚠️ **本文件有一份自己的列清单**（PG 方言的查询都直接用它）—— ⛔ 与 `repo.ts` 的
//    `USER_COLS` 是**两份**，加列时**两处都要改**（实测踩到：只改了 repo.ts
//    ⇒ PG 下 `listPublicUsers` 读不到 `shared_model_granted`，admin 用户列表恒显示"未开启"）。
const USER_COLS =
  'id, username, pass_hash, role, home_dir, api_key_ref, created_at, approved_by, uid, email, shared_model_granted'
const EMAIL_CODE_COLS =
  'id, email, purpose, code_hash, status, attempts, ip, username, reason, created_at, expires_at, consumed_at'
const DOMAIN_COLS = 'id, user_id, domain, verified, nginx_config, updated_at'
const BUSINESS_PLUGIN_COLS = 'id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at'
const HOST_COLS = 'id, endpoint, via, network_id, agent_token, capacity_mb, used_mb, status, last_heartbeat'
const INSTANCE_COLS =
  'id, user_id, workspace_id, role, pid, port, status, started_at, last_exit, exit_code, last_error, folder, patch, '
  + 'host_id, epoch, heartbeat_at, lease_until' // v7 集群化归属/租约（T08 S2）—— 漏了它们会让 hostId 恒为 null

/** Run `fn` on a dedicated client inside a BEGIN/COMMIT/ROLLBACK transaction. */
export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

/**
 * 凭据行的列清单与映射—— 与 `repo.ts` 里同名的一组**逐字对应**：
 * 两个后端必须选出同一批列，否则就是"SQLite 上好好的、Postgres 上少字段"这种
 * 只在生产才出现的偏差。（**不**从 `repo.ts` 导入：那会把 better-sqlite3 原生依赖
 * 拖进 pg 模式。）
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

export class PgAdapter implements DbAdapter {
  constructor(private readonly pool: Pool, private readonly baseUid: number) {}

  async createUser(input: CreateUserInput): Promise<User> {
    const createdAt = Date.now()
    try {
      return await withTx(this.pool, async (client) => {
        const { rows } = await client.query(
          'INSERT INTO users (id, username, pass_hash, role, home_dir, email, created_at) '
          + 'VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING row_id',
          [input.id, input.username, input.passHash, input.role, input.homeDir, input.email ?? null, createdAt],
        )
        const uid = this.baseUid + Number((rows[0] as { row_id: number }).row_id)
        await client.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, input.id])
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
          // v11：新用户未授权平台共享模型（默认关闭），见 repo.ts 同处注释。
          shared_model_granted: false,
        }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE username = $1`, [username])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }
  async findUserBySlug(slug: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE LOWER(username) = $1`, [
      slug.toLowerCase(),
    ])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserById(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  /** v10：注册邮箱查重（大小写不敏感）。 */
  async findUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users WHERE LOWER(email) = $1`, [
      email.toLowerCase(),
    ])
    return rows.length > 0 ? toUser(rows[0] as Record<string, unknown>) : undefined
  }

  // ── v10 邮箱验证码（注册页）—— 与 SQLite 版同款语义，见 repo.ts 注释 ───────────

  async recordEmailCode(input: RecordEmailCodeInput): Promise<void> {
    await this.pool.query(
      'INSERT INTO email_codes '
      + '(id, email, purpose, code_hash, status, attempts, ip, username, reason, created_at, expires_at, consumed_at) '
      + 'VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10, NULL)',
      [
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
      ],
    )
  }

  async emailCodeCounts(email: string, ip: string | null, since: number): Promise<EmailCodeCounts> {
    const { rows } = await this.pool.query(
      `SELECT
         (SELECT COUNT(*) FROM email_codes WHERE email = $1 AND created_at >= $2)                     AS email_total,
         (SELECT COUNT(*) FROM email_codes WHERE email = $1 AND created_at >= $2 AND status = 'sent') AS email_sent,
         (SELECT COALESCE(MAX(created_at), 0) FROM email_codes WHERE email = $1)                      AS email_last_at,
         (SELECT COUNT(*) FROM email_codes WHERE ip IS NOT NULL AND ip = $3 AND created_at >= $2)     AS ip_total,
         (SELECT COUNT(*) FROM email_codes WHERE created_at >= $2)                                    AS global_total`,
      [email, since, ip],
    )
    const row = rows[0] as Record<string, unknown>
    return {
      emailTotal: Number(row.email_total ?? 0),
      emailSent: Number(row.email_sent ?? 0),
      emailLastAt: Number(row.email_last_at ?? 0),
      ipTotal: Number(row.ip_total ?? 0),
      globalTotal: Number(row.global_total ?? 0),
    }
  }

  async latestSentEmailCode(email: string, purpose: string): Promise<EmailCodeRow | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${EMAIL_CODE_COLS} FROM email_codes WHERE email = $1 AND purpose = $2 AND status = 'sent' `
      + 'ORDER BY created_at DESC LIMIT 1',
      [email, purpose],
    )
    return rows.length > 0 ? toEmailCode(rows[0] as Record<string, unknown>) : undefined
  }

  async bumpEmailCodeAttempts(id: string, consume: boolean, now: number): Promise<boolean> {
    const { rowCount } = consume
      ? await this.pool.query(
        'UPDATE email_codes SET attempts = attempts + 1, consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL',
        [now, id],
      )
      : await this.pool.query(
        'UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1 AND consumed_at IS NULL',
        [id],
      )
    return (rowCount ?? 0) > 0
  }

  async consumeEmailCode(id: string, now: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE email_codes SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL',
      [now, id],
    )
    return (rowCount ?? 0) > 0
  }

  async purgeEmailCodes(before: number): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM email_codes WHERE created_at < $1', [before])
    return rowCount ?? 0
  }

  async listPublicUsers(): Promise<PublicUser[]> {
    const { rows } = await this.pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at ASC`)
    return rows.map((row) => toPublicUser(toUser(row as Record<string, unknown>)))
  }

  async countAdmins(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`)
    return (rows[0] as { n: number }).n
  }

  async setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean> {
    const result =
      approvedBy === undefined
        ? await this.pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id])
        : await this.pool.query('UPDATE users SET role = $1, approved_by = $2 WHERE id = $3', [role, approvedBy, id])
    return (result.rowCount ?? 0) > 0
  }

  async setUserUid(userId: string, uid: number): Promise<void> {
    await this.pool.query('UPDATE users SET uid = $1 WHERE id = $2', [uid, userId])
  }

  async listUsersWithoutUid(): Promise<string[]> {
    const { rows } = await this.pool.query('SELECT id FROM users WHERE uid IS NULL')
    return (rows as Array<{ id: string }>).map((row) => row.id)
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5, $6)',
        [input.tokenHash, input.userId, Date.now(), input.expiresAt, input.ip ?? null, input.userAgent ?? null],
      )
    } catch (e) {
      mapPgError(e)
    }
  }

  async findSession(tokenHash: string): Promise<SessionRow | undefined> {
    const { rows } = await this.pool.query(
      'SELECT token_hash, user_id, created_at, expires_at, ip, user_agent FROM sessions WHERE token_hash = $1',
      [tokenHash],
    )
    return rows.length > 0 ? toSession(rows[0] as Record<string, unknown>) : undefined
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash])
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId])
  }

  async hasActiveSession(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM sessions WHERE user_id = $1 AND expires_at > $2 LIMIT 1',
      [userId, Date.now()],
    )
    return rows.length > 0
  }

  async findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined> {
    const { rows } = await this.pool.query(
      `SELECT u.id, u.username, u.pass_hash, u.role, u.home_dir, u.api_key_ref, u.created_at, u.approved_by, u.uid,
              u.shared_model_granted, u.email, s.expires_at
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token_hash = $1`,
      [tokenHash],
    )
    if (rows.length === 0) return undefined
    const row = rows[0] as Record<string, unknown>
    return { expiresAt: row.expires_at as number, user: toUser(row) }
  }

  async audit(actor: string | null, action: string, detail?: string | null): Promise<void> {
    await this.pool.query('INSERT INTO audit_log (ts, actor, action, detail) VALUES ($1, $2, $3, $4)', [
      Date.now(),
      actor,
      action,
      detail ?? null,
    ])
  }

  async findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined> {
    const { rows } = await this.pool.query(
      'SELECT id, user_id, name, rel_path, created_at FROM workspaces WHERE user_id = $1 AND rel_path = $2',
      [userId, relPath],
    )
    return rows.length > 0 ? toWorkspace(rows[0] as Record<string, unknown>) : undefined
  }

  async getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace> {
    const existing = await this.findWorkspaceByPath(userId, relPath)
    if (existing !== undefined) return existing
    const id = randomUUID()
    const segments = relPath.split('/').filter(Boolean)
    const name = segments.at(-1) ?? 'root'
    try {
      await this.pool.query(
        'INSERT INTO workspaces (id, user_id, name, rel_path, created_at) VALUES ($1, $2, $3, $4, $5)',
        [id, userId, name, relPath, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return { id, userId, name, relPath, createdAt: Date.now() }
  }

  async setFolderPlugins(
    workspaceId: string,
    selections: ReadonlyArray<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    try {
      await withTx(this.pool, async (client) => {
        await client.query('DELETE FROM folder_plugins WHERE workspace_id = $1', [workspaceId])
        for (const selection of selections) {
          await client.query(
            'INSERT INTO folder_plugins (workspace_id, plugin_id, enabled, updated_at) VALUES ($1, $2, $3, $4)',
            [workspaceId, selection.id, selection.enabled ? 1 : 0, Date.now()],
          )
        }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  async getEnabledPluginIds(workspaceId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      'SELECT plugin_id FROM folder_plugins WHERE workspace_id = $1 AND enabled = 1',
      [workspaceId],
    )
    return (rows as Array<{ plugin_id: string }>).map((row) => row.plugin_id)
  }

  async listBusinessPlugins(): Promise<BusinessPlugin[]> {
    const { rows } = await this.pool.query(`SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins ORDER BY name ASC`)
    return rows.map((row) => toBusinessPlugin(row as Record<string, unknown>))
  }

  async findBusinessPlugin(id: string): Promise<BusinessPlugin | undefined> {
    const { rows } = await this.pool.query(`SELECT ${BUSINESS_PLUGIN_COLS} FROM business_plugins WHERE id = $1`, [id])
    return rows.length > 0 ? toBusinessPlugin(rows[0] as Record<string, unknown>) : undefined
  }

  async upsertBusinessPlugin(input: UpsertBusinessPluginInput): Promise<BusinessPlugin> {
    await this.pool.query(
      `
      INSERT INTO business_plugins (id, name, description, version, tgz_path, file_size, uploaded_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        tgz_path = excluded.tgz_path,
        file_size = excluded.file_size,
        uploaded_by = excluded.uploaded_by,
        updated_at = excluded.updated_at
      `,
      [
        input.id,
        input.name,
        input.description ?? null,
        input.version ?? null,
        input.tgzPath,
        input.fileSize,
        input.uploadedBy,
        Date.now(),
      ],
    )
    return (await this.findBusinessPlugin(input.id))!
  }

  async deleteBusinessPlugin(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM business_plugins WHERE id = $1', [id])
    return (result.rowCount ?? 0) > 0
  }

  async findDomainByUser(userId: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE user_id = $1`, [userId])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async findDomainById(id: string): Promise<Domain | undefined> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains WHERE id = $1`, [id])
    return rows.length > 0 ? toDomain(rows[0] as Record<string, unknown>) : undefined
  }

  async listDomains(): Promise<Domain[]> {
    const { rows } = await this.pool.query(`SELECT ${DOMAIN_COLS} FROM domains ORDER BY updated_at DESC`)
    return rows.map((row) => toDomain(row as Record<string, unknown>))
  }

  async upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain> {
    try {
      await this.pool.query(
        `
        INSERT INTO domains (id, user_id, domain, verified, nginx_config, updated_at)
        VALUES ($1, $2, $3, 0, $4, $5)
        ON CONFLICT(user_id) DO UPDATE SET
          domain = excluded.domain,
          verified = 0,
          nginx_config = excluded.nginx_config,
          updated_at = excluded.updated_at
        `,
        [randomUUID(), userId, domain, nginxConfig, Date.now()],
      )
    } catch (e) {
      mapPgError(e)
    }
    return (await this.findDomainByUser(userId))!
  }

  async setDomainVerified(id: string, verified: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE domains SET verified = $1, updated_at = $2 WHERE id = $3', [
      verified ? 1 : 0,
      Date.now(),
      id,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async listCredentialKeys(userId: string): Promise<CredentialKey[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = $1 ORDER BY updated_at DESC`,
      [userId],
    )
    return (rows as CredentialRow[]).map(toCredentialKey)
  }

  async listEnabledCredentialKeys(userId: string): Promise<CredentialKey[]> {
    const { rows } = await this.pool.query(
      `SELECT ${CREDENTIAL_COLS} FROM credential_vault WHERE user_id = $1 AND enabled = 1 ORDER BY updated_at DESC`,
      [userId],
    )
    return (rows as CredentialRow[]).map(toCredentialKey)
  }

  /** 落地层专用：多返回 `secret_ref`（密文）—— 与 `listEnabledCredentialKeys` 的唯一差别。 */
  async listCredentialLandingRows(userId: string): Promise<CredentialLandingRow[]> {
    const { rows } = await this.pool.query(
      'SELECT key_name, route, base_url, api, models, secret_ref FROM credential_vault WHERE user_id = $1 AND enabled = 1 ORDER BY updated_at DESC',
      [userId],
    )
    return (
      rows as Array<{
        key_name: string
        route: string | null
        base_url: string | null
        api: string | null
        models: string | null
        secret_ref: string
      }>
    ).map((r) => ({
      name: r.key_name,
      route: r.route,
      baseUrl: r.base_url,
      api: r.api,
      models: r.models,
      encryptedRef: r.secret_ref,
    }))
  }

  /**
   * **内置 DeepSeek 条目**的 encrypted ref（语义重定义）。
   * 互斥被删之后 `enabled = 1` 可能命中多行 ⇒ 必须钉死"内置 + 最新一条"，
   * 否则调用方会随机拿到某一个厂家的 key（详见 `repo.ts` 同名函数的注释）。
   */
  async getEnabledCredentialKeyRef(userId: string): Promise<string | null> {
    const { rows } = await this.pool.query(
      "SELECT secret_ref FROM credential_vault WHERE user_id = $1 AND enabled = 1 AND (base_url IS NULL OR base_url = '') ORDER BY updated_at DESC, id DESC LIMIT 1",
      [userId],
    )
    const row = rows[0] as { secret_ref: string } | undefined
    return row?.secret_ref ?? null
  }

  /** Upsert by `name` 并启用它 —— **不动**其它条目（互斥已删）。 */
  async setCredentialKey(
    userId: string,
    name: string,
    encryptedRef: string,
    meta?: CredentialKeyMeta,
  ): Promise<CredentialKey> {
    const route = meta?.route ?? null
    const baseUrl = meta?.baseUrl ?? null
    const api = meta?.api ?? null
    const models = meta?.models ?? null
    try {
      return await withTx(this.pool, async (client) => {
        const existing = await client.query('SELECT id FROM credential_vault WHERE user_id = $1 AND key_name = $2', [
          userId,
          name,
        ])
        let id: string
        if (existing.rows.length > 0) {
          id = (existing.rows[0] as { id: string }).id
          await client.query(
            'UPDATE credential_vault SET secret_ref = $1, route = $2, base_url = $3, api = $4, models = $5, enabled = 1, updated_at = $6 WHERE id = $7',
            [encryptedRef, route, baseUrl, api, models, Date.now(), id],
          )
        } else {
          id = randomUUID()
          await client.query(
            'INSERT INTO credential_vault (id, user_id, key_name, secret_ref, route, base_url, api, models, enabled, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)',
            [id, userId, name, encryptedRef, route, baseUrl, api, models, Date.now()],
          )
        }
        return { id, name, enabled: true, updatedAt: Date.now(), route, baseUrl, api, models }
      })
    } catch (e) {
      mapPgError(e)
    }
  }

  /** 启用一个条目（**非互斥**，不再先全关）。 */
  async selectCredentialKey(userId: string, id: string): Promise<boolean> {
    return await this.toggleCredentialKey(userId, id, true)
  }

  async toggleCredentialKey(userId: string, id: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE credential_vault SET enabled = $1, updated_at = $2 WHERE id = $3 AND user_id = $4',
      [enabled ? 1 : 0, Date.now(), id, userId],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** 该用户是否启用「平台共享模型」—— 缺失行按 `true`（默认值）。 */
  async getSharedModelEnabled(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT shared_model_enabled FROM users WHERE id = $1', [userId])
    const row = rows[0] as { shared_model_enabled: number } | undefined
    return row === undefined ? true : Number(row.shared_model_enabled) !== 0
  }

  async setSharedModelEnabled(userId: string, enabled: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE users SET shared_model_enabled = $1 WHERE id = $2', [
      enabled ? 1 : 0,
      userId,
    ])
    return (result.rowCount ?? 0) > 0
  }

  /** 管理员是否已给该用户开启「平台共享模型」（v11）。缺失行按 `false`（失败关闭）。 */
  async getSharedModelGranted(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query('SELECT shared_model_granted FROM users WHERE id = $1', [userId])
    const row = rows[0] as { shared_model_granted: number } | undefined
    return row === undefined ? false : Number(row.shared_model_granted) !== 0
  }

  async setSharedModelGranted(userId: string, granted: boolean): Promise<boolean> {
    const result = await this.pool.query('UPDATE users SET shared_model_granted = $1 WHERE id = $2', [
      granted ? 1 : 0,
      userId,
    ])
    return (result.rowCount ?? 0) > 0
  }

  async deleteCredentialKey(userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM credential_vault WHERE id = $1 AND user_id = $2', [id, userId])
    return (result.rowCount ?? 0) > 0
  }

  async deleteUser(userId: string): Promise<boolean> {
    return await withTx(this.pool, async (client) => {
      await client.query('DELETE FROM credential_vault WHERE user_id = $1', [userId])
      await client.query('DELETE FROM domains WHERE user_id = $1', [userId])
      await client.query('DELETE FROM sessions WHERE user_id = $1', [userId])
      await client.query('DELETE FROM dsh_instances WHERE user_id = $1', [userId])
      await client.query('DELETE FROM audit_log WHERE actor = $1', [userId])
      await client.query(
        'DELETE FROM folder_plugins WHERE workspace_id IN (SELECT id FROM workspaces WHERE user_id = $1)',
        [userId],
      )
      await client.query('DELETE FROM workspaces WHERE user_id = $1', [userId])
      const result = await client.query('DELETE FROM users WHERE id = $1', [userId])
      return (result.rowCount ?? 0) > 0
    })
  }

  async upsertInstance(input: UpsertDshInstanceInput): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO dsh_instances (id, user_id, workspace_id, role, pid, port, status, started_at, folder, patch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           pid = excluded.pid,
           port = excluded.port,
           status = excluded.status,
           started_at = excluded.started_at,
           folder = excluded.folder,
           patch = excluded.patch`,
        [
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
        ],
      )
    } catch (e) {
      mapPgError(e)
    }
  }

  async findInstance(id: string): Promise<DshInstance | undefined> {
    const { rows } = await this.pool.query(`SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE id = $1`, [id])
    return rows.length > 0 ? toDshInstance(rows[0] as Record<string, unknown>) : undefined
  }

  async findUserInstance(userId: string, role: DshInstanceRole): Promise<DshInstance | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE user_id = $1 AND role = $2`,
      [userId, role],
    )
    return rows.length > 0 ? toDshInstance(rows[0] as Record<string, unknown>) : undefined
  }

  async listInstancesByRole(role: DshInstanceRole): Promise<DshInstance[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE role = $1 ORDER BY started_at ASC`,
      [role],
    )
    return rows.map((row) => toDshInstance(row as Record<string, unknown>))
  }

  async setInstanceStatus(
    id: string,
    status: DshInstanceStatus,
    outcome?: { exitCode?: number; lastError?: string },
  ): Promise<boolean> {
    const result =
      outcome === undefined
        ? await this.pool.query('UPDATE dsh_instances SET status = $1 WHERE id = $2', [status, id])
        : await this.pool.query(
            'UPDATE dsh_instances SET status = $1, last_exit = $2, exit_code = $3, last_error = $4 WHERE id = $5',
            [status, Date.now(), outcome.exitCode ?? null, outcome.lastError ?? null, id],
          )
    return (result.rowCount ?? 0) > 0
  }

  async deleteInstance(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM dsh_instances WHERE id = $1', [id])
    return (result.rowCount ?? 0) > 0
  }

  async deleteUserInstances(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM dsh_instances WHERE user_id = $1', [userId])
  }

  // ── 集群化：worker 注册表 + 归属/租约（v7；T08 S2 / 设计 §3.1–§3.2）────────
  // 与 `repo.ts` 的同名 SQLite 实现**逐条对齐**（两套实现并存是本库既有事实，
  // 见）：任何 schema/语义变更都要**两侧同改**，否则切库时才炸。

  async upsertDshHost(input: UpsertDshHostInput): Promise<DshHost> {
    try {
      const { rows } = await this.pool.query(
        `INSERT INTO dsh_hosts (id, endpoint, via, network_id, agent_token, capacity_mb, used_mb, status, last_heartbeat)
         VALUES ($1, $2, COALESCE($3::text, 'manager-ssh'), COALESCE($4::text, 'ops'), $5, $6, 0, $7, NULL)
         ON CONFLICT(id) DO UPDATE SET
           endpoint    = excluded.endpoint,
           via         = COALESCE($3::text, dsh_hosts.via),
           network_id  = COALESCE($4::text, dsh_hosts.network_id),
           agent_token = excluded.agent_token,
           capacity_mb = excluded.capacity_mb,
           status      = excluded.status
         RETURNING id, endpoint, via, network_id, agent_token, capacity_mb, used_mb, status, last_heartbeat`,
        [
          input.id,
          input.endpoint,
          input.via ?? null,
          input.networkId ?? null,
          input.agentToken,
          input.capacityMb,
          input.status ?? 'up',
        ],
      )
      return toDshHost(rows[0] as Record<string, unknown>)
    } catch (e) {
      mapPgError(e)
    }
  }

  async findDshHost(id: string): Promise<DshHost | undefined> {
    const { rows } = await this.pool.query(
      `SELECT ${HOST_COLS} FROM dsh_hosts WHERE id = $1`,
      [id],
    )
    return rows.length > 0 ? toDshHost(rows[0] as Record<string, unknown>) : undefined
  }

  async listDshHosts(): Promise<DshHost[]> {
    const { rows } = await this.pool.query(`SELECT ${HOST_COLS} FROM dsh_hosts ORDER BY id ASC`)
    return rows.map((row) => toDshHost(row as Record<string, unknown>))
  }

  async setDshHostStatus(
    id: string,
    status: DshHostStatus,
    usedMb?: number,
    heartbeatAt?: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE dsh_hosts
          SET status = $1,
              used_mb = COALESCE($2, used_mb),
              last_heartbeat = COALESCE($3, last_heartbeat)
        WHERE id = $4`,
      [status, usedMb ?? null, heartbeatAt ?? null, id],
    )
    return (result.rowCount ?? 0) > 0
  }

  /**
   * **原子抢占**（承重墙）：PG 侧用 `UPDATE … RETURNING` —— 只有真正更新到行才返回行，
   * 比"先读后写"少一次竞态窗口（SQLite 侧用 `changes` 判定，语义等价）。
   */
  async claimInstance(
    userId: string,
    hostId: string,
    ttlMs: number,
    meta?: { folder?: string; patch?: string },
  ): Promise<ClaimResult> {
    const now = Date.now()
    const id = clusterInstanceId(userId)
    await this.pool.query(
      `INSERT INTO dsh_instances (id, user_id, role, status) VALUES ($1, $2, 'main', 'starting')
       ON CONFLICT(id) DO NOTHING`,
      [id, userId],
    )
    // folder/patch 一起落库：迁移要能复现启动参数（见 repo.ts 同名处注释）
    const res = await this.pool.query(
      `UPDATE dsh_instances
          SET host_id = $1, epoch = epoch + 1, heartbeat_at = $2, lease_until = $3,
              folder = COALESCE($4, folder), patch = COALESCE($5, patch)
        WHERE id = $6 AND (host_id IS NULL OR lease_until < $2)
        RETURNING epoch, lease_until`,
      [hostId, now, now + ttlMs, meta?.folder ?? null, meta?.patch ?? null, id],
    )
    if (res.rows.length > 0) {
      const row = res.rows[0] as { epoch: number; lease_until: number }
      return { ok: true, epoch: row.epoch, leaseUntil: row.lease_until }
    }
    const cur = await this.pool.query('SELECT host_id, lease_until FROM dsh_instances WHERE id = $1', [id])
    const row = cur.rows[0] as { host_id: string | null; lease_until: number } | undefined
    return { ok: false, holder: row?.host_id ?? null, leaseUntil: row?.lease_until ?? 0 }
  }

  async renewInstanceLease(
    userId: string,
    hostId: string,
    epoch: number,
    ttlMs: number,
  ): Promise<boolean> {
    const now = Date.now()
    const result = await this.pool.query(
      `UPDATE dsh_instances SET heartbeat_at = $1, lease_until = $2
        WHERE id = $3 AND host_id = $4 AND epoch = $5`,
      [now, now + ttlMs, clusterInstanceId(userId), hostId, epoch],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** 只清租约、**保留 host_id**（见 repo.ts 同名函数的长注释）。 */
  async releaseInstanceLease(userId: string, hostId: string, epoch: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE dsh_instances SET lease_until = 0
        WHERE id = $1 AND host_id = $2 AND epoch = $3`,
      [clusterInstanceId(userId), hostId, epoch],
    )
    return (result.rowCount ?? 0) > 0
  }

  /** 钉住归属（首次触达工作区时用）：只写 host_id。 */
  async pinInstanceHost(userId: string, hostId: string): Promise<void> {
    const now = Date.now()
    const id = clusterInstanceId(userId)
    await this.pool.query(
      `INSERT INTO dsh_instances (id, user_id, role, status, host_id, epoch, heartbeat_at, lease_until)
       VALUES ($1, $2, 'main', 'stopped', $3, 0, 0, 0)
       ON CONFLICT(id) DO NOTHING`,
      [id, userId, hostId],
    )
    await this.pool.query(
      `UPDATE dsh_instances SET host_id = $1 WHERE id = $2 AND (host_id IS NULL OR lease_until < $3)`,
      [hostId, id, now],
    )
  }

  async listExpiredInstanceLeases(now: number): Promise<DshInstance[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances
        WHERE role = 'main' AND host_id IS NOT NULL AND lease_until < $1 AND status <> 'stopped'
        ORDER BY lease_until ASC`,
      [now],
    )
    return rows.map((row) => toDshInstance(row as Record<string, unknown>))
  }

  async listInstancesByHost(hostId: string): Promise<DshInstance[]> {
    const { rows } = await this.pool.query(
      `SELECT ${INSTANCE_COLS} FROM dsh_instances WHERE host_id = $1 ORDER BY user_id ASC`,
      [hostId],
    )
    return rows.map((row) => toDshInstance(row as Record<string, unknown>))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

/** Open a Postgres adapter: connect, run migrations, then wrap the pool. */
export async function openPgAdapter(connectionString: string, baseUid: number): Promise<PgAdapter> {
  const pool = new Pool({ connectionString })
  await runPgMigrations(pool)
  return new PgAdapter(pool, baseUid)
}
