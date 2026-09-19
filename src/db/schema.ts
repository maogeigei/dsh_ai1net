/**
 * Schema migrations, dual-dialect. Each migration carries SQLite and Postgres
 * DDL; the active adapter runs only its own dialect. `schema_migrations` is
 * shared (same table shape), so a SQLite↔Postgres dump/restore round-trips the
 * applied-version marker too.
 *
 * Dialect notes (kept out of the route layer):
 * - timestamps are epoch **milliseconds** (Date.now()), which exceeds 32-bit
 *   `INTEGER`; SQLite `INTEGER` is 64-bit, Postgres uses `BIGINT`.
 * - `enabled`/`verified` are `INTEGER 0/1` in *both* dialects so the row mappers
 *   stay byte-identical across backends (no boolean/0/1 branch).
 * - `audit_log.id` uses SQLite `AUTOINCREMENT` vs Postgres `IDENTITY`.
 * @module dsh_ai1net/db/schema
 */

import type { Database } from './connection.js'
import type { Pool } from 'pg'

const SQLITE_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   INTEGER NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

-- 【2026-09-11 便宜版】该表仅被 enablePatch 分支使用
-- （src/web/routes/dsh.ts 的 findWorkspaceByPath），而 DEFAULT_ENABLE_PATCH=false 且生产 env 未覆盖
-- → 本部署不可达。保留以兼容 Postgres 路径；请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (user_id, rel_path)
);

-- 【2026-09-11 便宜版】该表在本部署已废弃：folder_plugins 无任何业务/路由调用
-- （grep 实证：仅 src/db/* 自引用；平台已宣布 folder 级插件废弃）。
-- 保留表结构仅为兼容 Postgres 路径——请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   INTEGER,
  last_exit    INTEGER,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const SQLITE_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

const PG_V1 = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  pass_hash    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'pending'
               CHECK (role IN ('admin','pending','active','disabled')),
  home_dir     TEXT NOT NULL,
  api_key_ref  TEXT,
  created_at   BIGINT NOT NULL,
  approved_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);

-- 【2026-09-11 便宜版】该表仅被 enablePatch 分支使用
-- （src/web/routes/dsh.ts 的 findWorkspaceByPath），而 DEFAULT_ENABLE_PATCH=false 且生产 env 未覆盖
-- → 本部署不可达。保留以兼容 Postgres 路径；请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS workspaces (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  UNIQUE (user_id, rel_path)
);

-- 【2026-09-11 便宜版】该表在本部署已废弃：folder_plugins 无任何业务/路由调用
-- （grep 实证：仅 src/db/* 自引用；平台已宣布 folder 级插件废弃）。
-- 保留表结构仅为兼容 Postgres 路径——请勿在此表上新增功能。
CREATE TABLE IF NOT EXISTS folder_plugins (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  description  TEXT,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (workspace_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS dsh_instances (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id),
  role         TEXT NOT NULL CHECK (role IN ('main','watchdog')),
  pid          INTEGER,
  port         INTEGER,
  status       TEXT NOT NULL
               CHECK (status IN ('starting','running','crashed','repairing','stopped')),
  started_at   BIGINT,
  last_exit    BIGINT,
  exit_code    INTEGER,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts           BIGINT NOT NULL,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT
);

CREATE TABLE IF NOT EXISTS domains (
  id            TEXT PRIMARY KEY,
  user_id       TEXT UNIQUE REFERENCES users(id),
  domain        TEXT NOT NULL,
  verified      INTEGER NOT NULL DEFAULT 0,
  nginx_config  TEXT,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  key_name   TEXT NOT NULL,
  secret_ref TEXT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, key_name)
);
`

const PG_V2 = `
ALTER TABLE credential_vault ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0;
`

// v3: per-user Linux uid (non-colliding for new users via an identity column).
// SQLite reuses its implicit `rowid` for the incrementing integer, so only the
// `uid` column is added here; Postgres adds an explicit identity `row_id`.
const SQLITE_V3 = `
ALTER TABLE users ADD COLUMN uid INTEGER;
`

const PG_V3 = `
ALTER TABLE users ADD COLUMN row_id BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE users ADD COLUMN uid BIGINT;
`

// v4: desired-state columns on `dsh_instances`. The table has existed since v1
// but was never read or written; it holds the launch folder and the rendered
// Cordis patch, which is what a relaunch needs to rebuild an instance that
// went missing.
const SQLITE_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

const PG_V4 = `
ALTER TABLE dsh_instances ADD COLUMN folder TEXT;
ALTER TABLE dsh_instances ADD COLUMN patch TEXT;
`

// v5: business-plugin candidate pool (系统外插件 = 功能插件). Admin uploads a
// tgz bundle into the pool; users enable it per-instance from the dsh settings
// section . Same-name upload REPLACES the row (not overwrite — the old
// tgz file is removed first, so deleted files cannot survive).
const SQLITE_V5 = `
CREATE TABLE IF NOT EXISTS business_plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  version      TEXT,
  tgz_path     TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
`

const PG_V5 = `
CREATE TABLE IF NOT EXISTS business_plugins (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  version      TEXT,
  tgz_path     TEXT NOT NULL,
  file_size    BIGINT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id),
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);
`

// v6: 用户自配「模型厂家」支持。
// 原先 `credential_vault` 只存一把 key（`key_name` 兼作展示名）；用户要按**厂家**配模型，
// 平台还需要知道：**route**（= settings.yaml 里 `llm-pi-ai.providers` 的 dict 键）、
// **endpoint**（`baseURL`）、**协议**（`api`）、**模型清单**（`models`）—— spawn 时按这四样写
// `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers.<route>` 与
// `$DSH_HOME/.credentials.yaml` 的 `refs.<REF>`。
//   · `base_url` 为空 = **内置 DeepSeek**（只写 refs，不写 settings.yaml）。
//   · REF 命名：内置 = `DEEPSEEK_API_KEY`；自定义 = `<ROUTE 大写化>_API_KEY`
//     （须匹配 `@deepseek-ai/dsh-credentials` 的 `REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/`）。
//   · `api` 的合法值只有三个（`dsh-llm-pi-ai` 的 `PROTOCOLS` 键，顺序即默认优先级）：
//     `openai-completions` / `openai-responses` / `anthropic-messages`。
//   · ⚠️ 字段名是 **`api` 不是 `protocol`**；`apiKeyEnv`（不是 `apiKey`）；且该 profile
//     **不接受** `provider` / `maxRetries` / `maxRetryDelayMs`（会直接抛错）。
//     以上全部为 2026-09-13 读官方包 `dsh-llm-pi-ai@0.1.2-rc.1` 的 `lib/index.js`
//     （`const NS = "llm-pi-ai"` / `profile` schema / `PROTOCOLS`）实测结论。
// 另：`users.shared_model_enabled` = 用户**要不要用平台共享模型**（admin 配的那把）——
// 属于用户侧偏好，开关它**不动** admin 的配置（用户口径：条目各自开关，都能同时启用；
// 具体用哪个模型是在 dsh 对话框的模型选择器里挑）。
const SQLITE_V6 = `
ALTER TABLE credential_vault ADD COLUMN route TEXT;
ALTER TABLE credential_vault ADD COLUMN base_url TEXT;
ALTER TABLE credential_vault ADD COLUMN api TEXT;
ALTER TABLE credential_vault ADD COLUMN models TEXT;
ALTER TABLE users ADD COLUMN shared_model_enabled INTEGER NOT NULL DEFAULT 1;
`

const PG_V6 = `
ALTER TABLE credential_vault ADD COLUMN route TEXT;
ALTER TABLE credential_vault ADD COLUMN base_url TEXT;
ALTER TABLE credential_vault ADD COLUMN api TEXT;
ALTER TABLE credential_vault ADD COLUMN models TEXT;
ALTER TABLE users ADD COLUMN shared_model_enabled INTEGER NOT NULL DEFAULT 1;
`

// v7: 集群化 —— worker 注册表 + 实例归属/租约（T08 S2；设计 §3.1/§3.2）。
//
// 为什么需要它：local 模式靠"进程内 Map + 单机"天然保证「一个用户只有一个活实例」；
// 多机后这个保证必须落到 DB 的**原子 CAS** 上，否则两个 worker 会同时写同一个
// `$DSH_HOME`（会话日志 append 冲突 ⇒ 数据损坏）。
//
//   · `dsh_hosts` = worker 注册表：agent 地址、容量、水位、心跳时间。
//   · `dsh_instances.{host_id, epoch, heartbeat_at, lease_until}` = 归属与租约。
//     `epoch` 是 **fencing token**：抢占时 +1，旧持有者的写入据此被拒（防脑裂双写）。
//
// 抢占语义（两方言同款，见 `repo.ts` 的 claimInstance / `pg.ts` 同名方法）：
//   `INSERT … ON CONFLICT(id) DO UPDATE SET … WHERE host_id IS NULL OR lease_until < now`
//   —— 冲突时仅在"无人持有或租约过期"才更新；否则**不动行也不报错**，
//   调用方以「受影响行数 0」判定"有人在管"。
// ⚠️ 时间戳一律 **epoch 毫秒 BIGINT**（与全库一致，勿用 timestamptz）。
const SQLITE_V7 = `
CREATE TABLE IF NOT EXISTS dsh_hosts (
  id             TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  agent_token    TEXT NOT NULL,
  capacity_mb    INTEGER NOT NULL DEFAULT 0,
  used_mb        INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'up'
                 CHECK (status IN ('up','draining','down')),
  last_heartbeat INTEGER
);
ALTER TABLE dsh_instances ADD COLUMN host_id      TEXT;
ALTER TABLE dsh_instances ADD COLUMN epoch        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dsh_instances ADD COLUMN heartbeat_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dsh_instances ADD COLUMN lease_until  INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dsh_instances_host  ON dsh_instances (host_id);
CREATE INDEX IF NOT EXISTS idx_dsh_instances_lease ON dsh_instances (lease_until);
`

const PG_V7 = `
CREATE TABLE IF NOT EXISTS dsh_hosts (
  id             TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL,
  agent_token    TEXT NOT NULL,
  capacity_mb    BIGINT NOT NULL DEFAULT 0,
  used_mb        BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'up'
                 CHECK (status IN ('up','draining','down')),
  last_heartbeat BIGINT
);
ALTER TABLE dsh_instances ADD COLUMN host_id      TEXT;
ALTER TABLE dsh_instances ADD COLUMN epoch        BIGINT NOT NULL DEFAULT 0;
ALTER TABLE dsh_instances ADD COLUMN heartbeat_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE dsh_instances ADD COLUMN lease_until  BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_dsh_instances_host  ON dsh_instances (host_id);
CREATE INDEX IF NOT EXISTS idx_dsh_instances_lease ON dsh_instances (lease_until);
`

// v8（覆盖网络 S2）：`dsh_hosts.via` = **"这台 worker 经谁可达"**（`Reachability.via` 词表）。
//
// 为什么必须加列：现网两条 `endpoint` 字符串**同形、语义不同**，表里无法表达"经谁中转"
// （会合中继拆分方案 §2 C3）⇒ 换会合 / 中继组件时无处安放，越晚改代价越大。
//
// 加列**带默认值** `manager-ssh` ⇒ **先加列 → 再改代码 → 最后回填**，任一步中断都不崩；
// 旧代码只读 `endpoint`，完全不受影响（列可留着不删 ⇒ 零风险回滚）。
// ⚠️ 默认值对 `<host-b>`（隧道落点）正确、对 `<host-a>`（同机直连）**不正确** ⇒ 回填由部署步骤
//    显式 `UPDATE ... WHERE id='<host-a>'` 完成，**不写进迁移**（迁移是静态 SQL，写死 hostId 在别的部署上会错）。
const SQLITE_V8 = `
ALTER TABLE dsh_hosts ADD COLUMN via TEXT NOT NULL DEFAULT 'manager-ssh';
`

const PG_V8 = `
ALTER TABLE dsh_hosts ADD COLUMN via TEXT NOT NULL DEFAULT 'manager-ssh';
`

// v9（覆盖网络 ②·P0-1）：`dsh_hosts.network_id` = **这台 worker 属于哪张网**。
//
// 为什么必须加列：relay 的会话表 / 端点表原先只按 `hostId` 索引 —— 即平台自己的 Worker 隧道与
// 未来的用户设备挤进**同一个扁平命名空间**。今天只有 1 张网，问题不显形；一进第二类节点就会变成
// 「一张巨网 + 靠 ACL 兜」，而写错一条 ACL 就泄露 ⇒ 与「**权限只准收窄**」直接冲突。
// ⇒ 网维度必须做成**结构性**的：控制面这一侧落成显式列（本迁移），数据面落成 relay 的
//    「按网络分桶白名单 + 同网校验」（`src/net/relay/server.ts`）。
//
// 加列**带默认值** `ops`（运维网）⇒ **存量行天然正确**（现网 <worker-a> / <worker-b> / manager 全在运维网），
// 且顺序是「**先加列 → 再改代码 → 最后才谈回填**」，任一步中断都不崩；旧代码只读旧列，零影响。
// ⚠️ 与 v8 的 `via` 同一条纪律：**迁移里不写 `UPDATE ... WHERE id='...'`**（迁移是静态 SQL，
//    写死 hostId 在别的部署上会错）—— 真要改某台机的网络归属，由部署步骤显式 `UPDATE` 完成。
const SQLITE_V9 = `
ALTER TABLE dsh_hosts ADD COLUMN network_id TEXT NOT NULL DEFAULT 'ops';
`

const PG_V9 = `
ALTER TABLE dsh_hosts ADD COLUMN network_id TEXT NOT NULL DEFAULT 'ops';
`

// v10（注册页人机验证 + 邮箱验证码）：`users.email` ＋ `email_codes` 事件表。
//
// 为什么放 DB 而不是进程内 Map：① 本表既是**验证码存储**，也是**防爆破计数器的唯一来源**
// （冷却 / 每时每刻配额 / 试错次数全靠 `COUNT(*)` 现算）—— 进程内的计数器**一次 restart 即清零**，
// 而 deployment 恰好天天重启，等于把限流关掉；② 发码是被外部触发的花钱动作（邮件配额），
// 必须可审计（`audit_log` 只记"发生过"，记不了"每分钟多少次"）；③ PG/SQLite 双后端可查。
//
// 表设计取舍：**只建一张事件表**，把"发送请求"与"校验失败"都记成行（`status` 区分）——
// 比"验证码表 + 计数器表 + 黑名单表"三张表少两次 JOIN、且天然是取证时间线。
//   · `status`：`sent`（已发出，可校验）/ `throttled`（被限流，占位计入配额）/ `failed`（驱动发信失败）
//   · 只有 `sent` 且 `consumed_at IS NULL` 且未过期的那一行可被校验通过。
//   · `code_hash` **不存明文**：sha256(email:purpose:code:pepper)，pepper = 平台 `encryptionSecret`。
//   · `attempts` 记该码**已被试错几次**，达上限即 `consumed_at` 打上（作废，必须重新获取）。
// ⚠️ 时间戳仍是 **epoch 毫秒 BIGINT**（与全库一致，勿用 timestamptz）。
// ⚠️ `users.email` 唯一索引：存量行全为 NULL ⇒ 两方言都允许多个 NULL ⇒ 迁移不会失败；
//    用 `LOWER(email)` 保证大小写不敏感唯一（注册时不区分大小写）。
const SQLITE_V10 = `
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
CREATE TABLE IF NOT EXISTS email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  code_hash   TEXT,
  status      TEXT NOT NULL DEFAULT 'sent'
              CHECK (status IN ('sent','throttled','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  username    TEXT,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes (email, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_email_codes_ip    ON email_codes (ip, created_at);
`

const PG_V10 = `
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
CREATE TABLE IF NOT EXISTS email_codes (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  purpose     TEXT NOT NULL,
  code_hash   TEXT,
  status      TEXT NOT NULL DEFAULT 'sent'
              CHECK (status IN ('sent','throttled','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip          TEXT,
  username    TEXT,
  reason      TEXT,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes (email, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_email_codes_ip    ON email_codes (ip, created_at);
`

// v11: **平台共享模型改为「管理员逐用户授权」**（2026-09-19 用户口径）。
//
// 口径原文：「admin 设置的共享模型，需要 admin 在用户列表中开启（新增选项，默认关闭），
// 用户才能在会话中使用（以及在设置的模型设置页面展示）」。
//
// 为什么**新开一列**而不是把 v6 的 `shared_model_enabled` 改成默认 0：
//   · v6 那一列的语义是**用户侧偏好**（用户能在「设置 → 模型设置」里自己关掉，默认开）——
//     需求要的是**管理员门禁**，两者是**不同的人、不同的意图**；
//   · 若共用一列，用户在自己的设置里点一下就能把自己"授权"了 ⇒ 门禁形同不存在；
//   · 故：`shared_model_granted` = **管理员授权**（本列，`DEFAULT 0` = 默认关闭，
//     用户自己改不了）；`shared_model_enabled` = **用户偏好**（不变）。
//   · **生效 = granted AND enabled**（`server.ts#sharedLandingRows`）。
//
// ⚠️ `DEFAULT 0` 让**存量行也一并变 0**（PG/SQLite 加列都用默认值回填）⇒ 迁移后
// **所有既有用户都处于"未授权"**，需要 admin 在用户列表里逐个开启。这正是"默认关闭"的字面语义，
// 也是这条门禁第一次生效的可见证据（验收见）。
const SQLITE_V11 = `
ALTER TABLE users ADD COLUMN shared_model_granted INTEGER NOT NULL DEFAULT 0;
`

const PG_V11 = `
ALTER TABLE users ADD COLUMN shared_model_granted INTEGER NOT NULL DEFAULT 0;
`

interface Migration {
  version: number
  name: string
  sqlite: string
  pg: string
}

const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'initial schema', sqlite: SQLITE_V1, pg: PG_V1 },
  { version: 2, name: 'credential vault enabled flag', sqlite: SQLITE_V2, pg: PG_V2 },
  { version: 3, name: 'per-user uid', sqlite: SQLITE_V3, pg: PG_V3 },
  { version: 4, name: 'instance desired state', sqlite: SQLITE_V4, pg: PG_V4 },
  { version: 5, name: 'business plugin candidate pool', sqlite: SQLITE_V5, pg: PG_V5 },
  { version: 6, name: 'user model providers', sqlite: SQLITE_V6, pg: PG_V6 },
  { version: 7, name: 'cluster host registry + instance lease', sqlite: SQLITE_V7, pg: PG_V7 },
  { version: 8, name: 'host reachability via (覆盖网络 S2)', sqlite: SQLITE_V8, pg: PG_V8 },
  { version: 9, name: 'host network id (覆盖网络 P0-1)', sqlite: SQLITE_V9, pg: PG_V9 },
  { version: 10, name: 'user email + email verification codes', sqlite: SQLITE_V10, pg: PG_V10 },
  { version: 11, name: 'shared model admin grant (per-user, default off)', sqlite: SQLITE_V11, pg: PG_V11 },
]

/** Apply unapplied SQLite migrations inside a single transaction. */
export function runSqliteMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
  const applied = new Set(rows.map((row) => row.version))

  const apply = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      db.exec(migration.sqlite)
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now(),
      )
    }
  })
  apply()
}

/** Apply unapplied Postgres migrations inside a single transaction. */
export async function runPgMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        applied_at BIGINT NOT NULL
      );
    `)
    const { rows } = await client.query('SELECT version FROM schema_migrations')
    const applied = new Set(rows.map((row) => row.version as number))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      await client.query(migration.pg)
      await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [
        migration.version,
        Date.now(),
      ])
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}
