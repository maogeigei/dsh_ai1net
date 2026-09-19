/**
 * The unified async DB interface. Routes depend only on this — never on
 * `better-sqlite3` or `pg` directly — so the backend can switch between SQLite
 * (`deployMode=local`) and Postgres (shared HA) without touching callers.
 * @module dsh_ai1net/db/adapter
 */

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

export interface DbAdapter {
  // users
  createUser(input: CreateUserInput): Promise<User>
  findUserByUsername(username: string): Promise<User | undefined>
  findUserBySlug(slug: string): Promise<User | undefined>
  findUserById(id: string): Promise<User | undefined>
  listPublicUsers(): Promise<PublicUser[]>
  countAdmins(): Promise<number>
  setUserRole(id: string, role: UserRole, approvedBy?: string): Promise<boolean>
  /** Assign a Linux uid to a user (used by the legacy backfill). */
  setUserUid(userId: string, uid: number): Promise<void>
  /** Ids of users whose uid column is still null (legacy rows awaiting backfill). */
  listUsersWithoutUid(): Promise<string[]>
  /**
   * Permanently delete a user and every owned row (credential_vault / domains /
   * sessions / dsh_instances / audit_log / folder_plugins / workspaces), inside
   * one transaction. Returns false when no such user exists.
   */
  deleteUser(userId: string): Promise<boolean>
  // sessions
  createSession(input: CreateSessionInput): Promise<void>
  findSession(tokenHash: string): Promise<SessionRow | undefined>
  deleteSession(tokenHash: string): Promise<void>
  deleteUserSessions(userId: string): Promise<void>
  findSessionWithUser(tokenHash: string): Promise<SessionUser | undefined>
  /** Whether the user has any session that has not yet expired (idle reap). */
  hasActiveSession(userId: string): Promise<boolean>
  /** Registration e-mail lookup (v10, case-insensitive). */
  findUserByEmail(email: string): Promise<User | undefined>
  // e-mail verification codes (v10) — 注册页「邮箱验证码」的存储 + 防爆破计数来源
  /** Append one `email_codes` row (sent / throttled / failed). */
  recordEmailCode(input: RecordEmailCodeInput): Promise<void>
  /** Rolling counters for one (email, ip) pair — the brute-force guard's only input. */
  emailCodeCounts(email: string, ip: string | null, since: number): Promise<EmailCodeCounts>
  /** The newest **deliverable** code for (email, purpose), or undefined. */
  latestSentEmailCode(email: string, purpose: string): Promise<EmailCodeRow | undefined>
  /**
   * 记一次校验失败：`attempts + 1`；`consume` 为真时同时打上 `consumed_at`（= 该码作废）。
   * 返回 false 表示该行已不存在（例如被并发守卫先行作废）。
   */
  bumpEmailCodeAttempts(id: string, consume: boolean, now: number): Promise<boolean>
  /** 校验通过：打上 `consumed_at`（**单次使用**）。返回 false = 在写入前已被别人用掉。 */
  consumeEmailCode(id: string, now: number): Promise<boolean>
  /** 删除早于 `before` 的 `email_codes` 行（自维护，避免表无限增长）。 */
  purgeEmailCodes(before: number): Promise<number>
  // audit
  audit(actor: string | null, action: string, detail?: string | null): Promise<void>
  // workspaces / plugins
  findWorkspaceByPath(userId: string, relPath: string): Promise<Workspace | undefined>
  getOrCreateWorkspace(userId: string, relPath: string): Promise<Workspace>
  setFolderPlugins(workspaceId: string, selections: ReadonlyArray<{ id: string; enabled: boolean }>): Promise<void>
  getEnabledPluginIds(workspaceId: string): Promise<string[]>
  // business plugins (系统外插件候选池)
  listBusinessPlugins(): Promise<BusinessPlugin[]>
  findBusinessPlugin(id: string): Promise<BusinessPlugin | undefined>
  upsertBusinessPlugin(input: UpsertBusinessPluginInput): Promise<BusinessPlugin>
  deleteBusinessPlugin(id: string): Promise<boolean>
  // domains
  findDomainByUser(userId: string): Promise<Domain | undefined>
  findDomainById(id: string): Promise<Domain | undefined>
  listDomains(): Promise<Domain[]>
  upsertDomain(userId: string, domain: string, nginxConfig: string): Promise<Domain>
  setDomainVerified(id: string, verified: boolean): Promise<boolean>
  // credential vault
  listCredentialKeys(userId: string): Promise<CredentialKey[]>
  /** 该用户**全部已启用**的条目（spawn 时按它们写实例配置）。 */
  listEnabledCredentialKeys(userId: string): Promise<CredentialKey[]>
  /** 同上 + **encrypted ref** —— **仅供 `server.ts` 的落地层**，绝不经 API 返回。 */
  listCredentialLandingRows(userId: string): Promise<CredentialLandingRow[]>
  getEnabledCredentialKeyRef(userId: string): Promise<string | null>
  setCredentialKey(
    userId: string,
    name: string,
    encryptedRef: string,
    meta?: CredentialKeyMeta,
  ): Promise<CredentialKey>
  selectCredentialKey(userId: string, id: string): Promise<boolean>
  /** 开/关**单个**条目（不动其它条目 —— 用户口径：可同时启用多个）。 */
  toggleCredentialKey(userId: string, id: string, enabled: boolean): Promise<boolean>
  /** 用户是否使用「平台共享模型」（admin 配的那把）—— 用户侧偏好。 */
  getSharedModelEnabled(userId: string): Promise<boolean>
  setSharedModelEnabled(userId: string, enabled: boolean): Promise<boolean>
  /**
   * （v11）：**管理员**是否已给该用户开启「平台共享模型」—— 逐用户门禁，默认关闭。
   * 生效 = 本项 ∧ `getSharedModelEnabled`（缺一不给）。
   */
  getSharedModelGranted(userId: string): Promise<boolean>
  setSharedModelGranted(userId: string, granted: boolean): Promise<boolean>
  deleteCredentialKey(userId: string, id: string): Promise<boolean>
  // instances (desired state used to rebuild a missing instance)
  upsertInstance(input: UpsertDshInstanceInput): Promise<void>
  findInstance(id: string): Promise<DshInstance | undefined>
  findUserInstance(userId: string, role: DshInstanceRole): Promise<DshInstance | undefined>
  listInstancesByRole(role: DshInstanceRole): Promise<DshInstance[]>
  /** Record a state transition; `exitCode`/`lastError` also stamp `last_exit`. */
  setInstanceStatus(
    id: string,
    status: DshInstanceStatus,
    outcome?: { exitCode?: number; lastError?: string },
  ): Promise<boolean>
  deleteInstance(id: string): Promise<boolean>
  deleteUserInstances(userId: string): Promise<void>
  // ── 集群化：worker 注册表 + 实例归属/租约（v7；T08 S2 / 设计 §3.1–§3.2）──
  // ⚠️ local 模式**不写**这些表（`LocalSpawner` 靠进程内 Map + 单机互斥），
  //    所以这些方法在单机路径上恒为"空/未认领"，不影响现有行为。
  /** 注册/更新一台 worker（join 幂等：同 id 重复执行 = 更新）。 */
  upsertDshHost(input: UpsertDshHostInput): Promise<DshHost>
  findDshHost(id: string): Promise<DshHost | undefined>
  listDshHosts(): Promise<DshHost[]>
  /** 心跳/状态上报：可只改状态，或同时带上容量水位与心跳时间。 */
  setDshHostStatus(
    id: string,
    status: DshHostStatus,
    usedMb?: number,
    heartbeatAt?: number,
  ): Promise<boolean>
  /**
   * **原子抢占**某用户的 main 实例归属（承重墙，见设计 §3.2）。
   * 仅当"无人持有 **或** 租约已过期"才成功；成功时 `epoch` +1（fencing）。
   * 返回 `ok:false` = 有人在管 ⇒ 调用方**退让**（不是接管）。
   */
  claimInstance(
    userId: string,
    hostId: string,
    ttlMs: number,
    meta?: { folder?: string; patch?: string },
  ): Promise<ClaimResult>
  /** 续租。**必须带 epoch**：不匹配说明已被他人抢占 ⇒ 本次续租失败（fencing）。 */
  renewInstanceLease(userId: string, hostId: string, epoch: number, ttlMs: number): Promise<boolean>
  /** 主动释放（停实例时）。同样带 epoch 校验，避免误清他人的归属。 */
  releaseInstanceLease(userId: string, hostId: string, epoch: number): Promise<boolean>
  /** 钉住归属（首次触达工作区时用）：只写 `host_id`，不动 epoch/租约。 */
  pinInstanceHost(userId: string, hostId: string): Promise<void>
  /** 租约已过期、但仍标着归属的实例 —— 供巡检/自愈（**不代表可以立即接管**，见 R9）。 */
  listExpiredInstanceLeases(now: number): Promise<DshInstance[]>
  /** 某 worker 上的全部实例 —— 对账用**一次拿回整机**（替代逐用户查询）。 */
  listInstancesByHost(hostId: string): Promise<DshInstance[]>
  // lifecycle
  close(): Promise<void>
}
