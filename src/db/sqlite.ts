/**
 * SQLite backend for {@link DbAdapter}. Wraps the synchronous better-sqlite3
 * repo in async methods and maps constraint errors onto the shared hierarchy.
 * Used when `deployMode=local` (no `DSH_AI1NET_DB_URL`).
 *
 * NOTE: better-sqlite3 is synchronous; the `async` here only matches the
 * interface — the underlying calls still block the event loop. Fine for the
 * small single-machine local mode this backend targets (see manual/architecture.md).
 * @module dsh_ai1net/db/sqlite
 */

import type { DbAdapter } from './adapter.js'
import { openDatabase, type Database } from './connection.js'
import { mapSqliteError } from './errors.js'
import {
  audit as auditSync,
  bumpEmailCodeAttempts as bumpEmailCodeAttemptsSync,
  consumeEmailCode as consumeEmailCodeSync,
  countAdmins as countAdminsSync,
  createSession as createSessionSync,
  createUser as createUserSync,
  deleteBusinessPlugin as deleteBusinessPluginSync,
  deleteCredentialKey as deleteCredentialKeySync,
  deleteInstance as deleteInstanceSync,
  deleteSession as deleteSessionSync,
  deleteUser as deleteUserSync,
  deleteUserInstances as deleteUserInstancesSync,
  deleteUserSessions as deleteUserSessionsSync,
  emailCodeCounts as emailCodeCountsSync,
  findBusinessPlugin as findBusinessPluginSync,
  findDomainById as findDomainByIdSync,
  findDomainByUser as findDomainByUserSync,
  findInstance as findInstanceSync,
  findSession as findSessionSync,
  findSessionWithUser as findSessionWithUserSync,
  hasActiveSession as hasActiveSessionSync,
  findUserByEmail as findUserByEmailSync,
  findUserById as findUserByIdSync,
  findUserBySlug as findUserBySlugSync,
  findUserByUsername as findUserByUsernameSync,
  findUserInstance as findUserInstanceSync,
  findWorkspaceByPath as findWorkspaceByPathSync,
  getEnabledCredentialKeyRef as getEnabledCredentialKeyRefSync,
  getEnabledPluginIds as getEnabledPluginIdsSync,
  getOrCreateWorkspace as getOrCreateWorkspaceSync,
  getSharedModelEnabled as getSharedModelEnabledSync,
  getSharedModelGranted as getSharedModelGrantedSync,
  latestSentEmailCode as latestSentEmailCodeSync,
  listBusinessPlugins as listBusinessPluginsSync,
  listCredentialKeys as listCredentialKeysSync,
  listCredentialLandingRows as listCredentialLandingRowsSync,
  listDomains as listDomainsSync,
  listEnabledCredentialKeys as listEnabledCredentialKeysSync,
  listInstancesByRole as listInstancesByRoleSync,
  listPublicUsers as listPublicUsersSync,
  listUsersWithoutUid as listUsersWithoutUidSync,
  purgeEmailCodes as purgeEmailCodesSync,
  recordEmailCode as recordEmailCodeSync,
  selectCredentialKey as selectCredentialKeySync,
  setCredentialKey as setCredentialKeySync,
  setDomainVerified as setDomainVerifiedSync,
  setFolderPlugins as setFolderPluginsSync,
  setInstanceStatus as setInstanceStatusSync,
  setSharedModelEnabled as setSharedModelEnabledSync,
  setSharedModelGranted as setSharedModelGrantedSync,
  setUserRole as setUserRoleSync,
  setUserUid as setUserUidSync,
  toggleCredentialKey as toggleCredentialKeySync,
  // 集群化（v7；T08 S2）
  claimInstance as claimInstanceSync,
  findDshHost as findDshHostSync,
  listDshHosts as listDshHostsSync,
  listExpiredInstanceLeases as listExpiredInstanceLeasesSync,
  listInstancesByHost as listInstancesByHostSync,
  pinInstanceHost as pinInstanceHostSync,
  releaseInstanceLease as releaseInstanceLeaseSync,
  renewInstanceLease as renewInstanceLeaseSync,
  setDshHostStatus as setDshHostStatusSync,
  upsertDshHost as upsertDshHostSync,
  upsertBusinessPlugin as upsertBusinessPluginSync,
  upsertDomain as upsertDomainSync,
  upsertInstance as upsertInstanceSync,
} from './repo.js'
import type {
  BusinessPlugin,
  ClaimResult,
  CredentialKey,
  CredentialKeyMeta,
  CredentialLandingRow,
  CreateSessionInput,
  CreateUserInput,
  Domain,
  DshHost,
  DshHostStatus,
  DshInstance,
  DshInstanceRole,
  DshInstanceStatus,
  EmailCodeCounts,
  EmailCodeRow,
  PublicUser,
  RecordEmailCodeInput,
  SessionRow,
  SessionUser,
  UpsertBusinessPluginInput,
  UpsertDshHostInput,
  UpsertDshInstanceInput,
  User,
  UserRole,
  Workspace,
} from './types.js'

export class SqliteAdapter implements DbAdapter {
  private readonly db: Database

  constructor(path: string, private readonly baseUid: number) {
    this.db = openDatabase(path)
  }

  async createUser(input: CreateUserInput): Promise<User> {
    try {
      return createUserSync(this.db, input, this.baseUid)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findUserByUsername(username: string): Promise<User | undefined> {
    return findUserByUsernameSync(this.db, username)
  }

  async findUserBySlug(slug: string): Promise<User | undefined> {
    return findUserBySlugSync(this.db, slug)
  }

  async findUserById(id: string): Promise<User | undefined> {
    return findUserByIdSync(this.db, id)
  }

  async listPublicUsers(): Promise<PublicUser[]> {
    return listPublicUsersSync(this.db)
  }

  async countAdmins(): Promise<number> {
    return countAdminsSync(this.db)
  }

  async setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean> {
    return setUserRoleSync(this.db, id, role, approvedBy)
  }

  async setUserUid(userId: string, uid: number): Promise<void> {
    setUserUidSync(this.db, userId, uid)
  }

  async listUsersWithoutUid(): Promise<string[]> {
    return listUsersWithoutUidSync(this.db)
  }

  async createSession(input: CreateSessionInput): Promise<void> {
    try {
      createSessionSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findSession(tokenHash: string): Promise<SessionRow | undefined> {
    return findSessionSync(this.db, tokenHash)
  }

  async deleteSession(tokenHash: string): Promise<void> {
    deleteSessionSync(this.db, tokenHash)
  }

  async deleteUserSessions(userId: string): Promise<void> {
    deleteUserSessionsSync(this.db, userId)
  }

  async findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined> {
    return findSessionWithUserSync(this.db, tokenHash)
  }

  async hasActiveSession(userId: string): Promise<boolean> {
    return hasActiveSessionSync(this.db, userId)
  }

  async audit(actor: string | null, action: string, detail?: string | null): Promise<void> {
    auditSync(this.db, actor, action, detail)
  }

  // ── v10 邮箱验证码（注册页）────────────────────────────────────────────────
  async findUserByEmail(email: string): Promise<User | undefined> {
    return findUserByEmailSync(this.db, email)
  }

  async recordEmailCode(input: RecordEmailCodeInput): Promise<void> {
    recordEmailCodeSync(this.db, input)
  }

  async emailCodeCounts(email: string, ip: string | null, since: number): Promise<EmailCodeCounts> {
    return emailCodeCountsSync(this.db, email, ip, since)
  }

  async latestSentEmailCode(email: string, purpose: string): Promise<EmailCodeRow | undefined> {
    return latestSentEmailCodeSync(this.db, email, purpose)
  }

  async bumpEmailCodeAttempts(id: string, consume: boolean, now: number): Promise<boolean> {
    return bumpEmailCodeAttemptsSync(this.db, id, consume, now)
  }

  async consumeEmailCode(id: string, now: number): Promise<boolean> {
    return consumeEmailCodeSync(this.db, id, now)
  }

  async purgeEmailCodes(before: number): Promise<number> {
    return purgeEmailCodesSync(this.db, before)
  }

  async findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined> {
    return findWorkspaceByPathSync(this.db, userId, relPath)
  }

  async getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace> {
    try {
      return getOrCreateWorkspaceSync(this.db, userId, relPath)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async setFolderPlugins(
    workspaceId: string,
    selections: ReadonlyArray<{ id: string; enabled: boolean }>,
  ): Promise<void> {
    try {
      setFolderPluginsSync(this.db, workspaceId, selections)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async getEnabledPluginIds(workspaceId: string): Promise<string[]> {
    return getEnabledPluginIdsSync(this.db, workspaceId)
  }

  async listBusinessPlugins(): Promise<BusinessPlugin[]> {
    return listBusinessPluginsSync(this.db)
  }

  async findBusinessPlugin(id: string): Promise<BusinessPlugin | undefined> {
    return findBusinessPluginSync(this.db, id)
  }

  async upsertBusinessPlugin(input: UpsertBusinessPluginInput): Promise<BusinessPlugin> {
    try {
      return upsertBusinessPluginSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async deleteBusinessPlugin(id: string): Promise<boolean> {
    return deleteBusinessPluginSync(this.db, id)
  }

  async findDomainByUser(userId: string): Promise<Domain | undefined> {
    return findDomainByUserSync(this.db, userId)
  }

  async findDomainById(id: string): Promise<Domain | undefined> {
    return findDomainByIdSync(this.db, id)
  }

  async listDomains(): Promise<Domain[]> {
    return listDomainsSync(this.db)
  }

  async upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain> {
    try {
      return upsertDomainSync(this.db, userId, domain, nginxConfig)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async setDomainVerified(id: string, verified: boolean): Promise<boolean> {
    return setDomainVerifiedSync(this.db, id, verified)
  }

  async listCredentialKeys(userId: string): Promise<CredentialKey[]> {
    return listCredentialKeysSync(this.db, userId)
  }

  async listEnabledCredentialKeys(userId: string): Promise<CredentialKey[]> {
    return listEnabledCredentialKeysSync(this.db, userId)
  }

  async listCredentialLandingRows(userId: string): Promise<CredentialLandingRow[]> {
    return listCredentialLandingRowsSync(this.db, userId)
  }

  async getEnabledCredentialKeyRef(userId: string): Promise<string | null> {
    return getEnabledCredentialKeyRefSync(this.db, userId)
  }

  async setCredentialKey(
    userId: string,
    name: string,
    encryptedRef: string,
    meta?: CredentialKeyMeta,
  ): Promise<CredentialKey> {
    try {
      return setCredentialKeySync(this.db, userId, name, encryptedRef, meta)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async selectCredentialKey(userId: string, id: string): Promise<boolean> {
    return selectCredentialKeySync(this.db, userId, id)
  }

  async toggleCredentialKey(userId: string, id: string, enabled: boolean): Promise<boolean> {
    return toggleCredentialKeySync(this.db, userId, id, enabled)
  }

  async getSharedModelEnabled(userId: string): Promise<boolean> {
    return getSharedModelEnabledSync(this.db, userId)
  }

  async setSharedModelEnabled(userId: string, enabled: boolean): Promise<boolean> {
    return setSharedModelEnabledSync(this.db, userId, enabled)
  }

  async getSharedModelGranted(userId: string): Promise<boolean> {
    return getSharedModelGrantedSync(this.db, userId)
  }

  async setSharedModelGranted(userId: string, granted: boolean): Promise<boolean> {
    return setSharedModelGrantedSync(this.db, userId, granted)
  }

  async deleteCredentialKey(userId: string, id: string): Promise<boolean> {
    return deleteCredentialKeySync(this.db, userId, id)
  }

  async deleteUser(userId: string): Promise<boolean> {
    return deleteUserSync(this.db, userId)
  }

  async upsertInstance(input: UpsertDshInstanceInput): Promise<void> {
    try {
      upsertInstanceSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findInstance(id: string): Promise<DshInstance | undefined> {
    return findInstanceSync(this.db, id)
  }

  async findUserInstance(userId: string, role: DshInstanceRole): Promise<DshInstance | undefined> {
    return findUserInstanceSync(this.db, userId, role)
  }

  async listInstancesByRole(role: DshInstanceRole): Promise<DshInstance[]> {
    return listInstancesByRoleSync(this.db, role)
  }

  async setInstanceStatus(
    id: string,
    status: DshInstanceStatus,
    outcome?: { exitCode?: number; lastError?: string },
  ): Promise<boolean> {
    return setInstanceStatusSync(this.db, id, status, outcome)
  }

  async deleteInstance(id: string): Promise<boolean> {
    return deleteInstanceSync(this.db, id)
  }

  async deleteUserInstances(userId: string): Promise<void> {
    deleteUserInstancesSync(this.db, userId)
  }

  // ── 集群化：worker 注册表 + 归属/租约（v7；T08 S2）────────────────────────
  // local 模式不会走到这些方法（`LocalSpawner` 不写库），它们只是让
  // **SQLite 侧与 PG 侧行为一致** —— 测试与单机试跑都需要。

  async upsertDshHost(input: UpsertDshHostInput): Promise<DshHost> {
    try {
      return upsertDshHostSync(this.db, input)
    } catch (e) {
      mapSqliteError(e)
    }
  }

  async findDshHost(id: string): Promise<DshHost | undefined> {
    return findDshHostSync(this.db, id)
  }

  async listDshHosts(): Promise<DshHost[]> {
    return listDshHostsSync(this.db)
  }

  async setDshHostStatus(
    id: string,
    status: DshHostStatus,
    usedMb?: number,
    heartbeatAt?: number,
  ): Promise<boolean> {
    return setDshHostStatusSync(this.db, id, status, usedMb, heartbeatAt)
  }

  async claimInstance(
    userId: string,
    hostId: string,
    ttlMs: number,
    meta?: { folder?: string; patch?: string },
  ): Promise<ClaimResult> {
    return claimInstanceSync(this.db, userId, hostId, ttlMs, meta)
  }

  async renewInstanceLease(userId: string, hostId: string, epoch: number, ttlMs: number): Promise<boolean> {
    return renewInstanceLeaseSync(this.db, userId, hostId, epoch, ttlMs)
  }

  async releaseInstanceLease(userId: string, hostId: string, epoch: number): Promise<boolean> {
    return releaseInstanceLeaseSync(this.db, userId, hostId, epoch)
  }

  async pinInstanceHost(userId: string, hostId: string): Promise<void> {
    pinInstanceHostSync(this.db, userId, hostId)
  }

  async listExpiredInstanceLeases(now: number): Promise<DshInstance[]> {
    return listExpiredInstanceLeasesSync(this.db, now)
  }

  async listInstancesByHost(hostId: string): Promise<DshInstance[]> {
    return listInstancesByHostSync(this.db, hostId)
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
