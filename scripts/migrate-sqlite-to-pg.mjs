#!/usr/bin/env node
/**
 * T08 · S1.2：SQLite → Postgres 一次性数据迁移。
 *
 * 设计要点（都是踩过才会疼的地方）：
 *  1. **列清单不写死** —— 从 PG 的 information_schema 与 SQLite 的 PRAGMA 取**交集**，
 *     这样 schema 演进（v4 的 folder/patch、v6 的 enabled 等）不会让脚本静默少搬字段。
 *  2. **PG 表结构不由本脚本建** —— 先 import 平台自己的 `createDbAdapter`（带 dbUrl），
 *     让**平台的迁移**在 PG 上建库。这样"迁移脚本"与"平台 schema"永远不会两套。
 *  3. **identity 列要 `OVERRIDING SYSTEM VALUE`** —— `users.uid` 与 `audit_log.id` 是
 *     GENERATED ALWAYS AS IDENTITY；不覆盖就会重排 id，**uid 一变 = 所有用户文件属主失配**。
 *     搬完必须 `RESTART WITH` 把序列推到 max+1，否则下一条 INSERT 撞主键。
 *  4. **FK 顺序**：先 users，再 workspaces/sessions，最后引用它们的表。
 *  5. `--dry-run` 只报行数，不写任何东西。
 *
 * 用法：
 *   node scripts/migrate-sqlite-to-pg.mjs --sqlite <data-root>/dsh_ai1net.db \
 *        --pg postgres://dsh_ai1net:***@127.0.0.1:<pg-port>/dsh_ai1net [--dry-run]
 *
 * @module dsh_ai1net/scripts/migrate-sqlite-to-pg
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import pg from 'pg'
import { createDbAdapter } from '../lib/db/index.js'
import { resolveConfig } from '../lib/config.js'

/** FK 依赖顺序（父 → 子）。未列出的表会被追加到末尾并告警。 */
const ORDER = [
  'users',
  'workspaces',
  'sessions',
  'folder_plugins',
  'dsh_instances',
  'domains',
  'credential_vault',
  'business_plugins',
  'audit_log',
]

/** identity 列（必须 OVERRIDING SYSTEM VALUE + 搬完 RESTART）。 */
const IDENTITY = { users: 'uid', audit_log: 'id' }

/**
 * ⛔ **绝不搬**的表。
 *
 * `schema_migrations`：目标端的"已应用版本"标记由**平台的迁移**建立（见 `ensurePgSchema`），
 * 从源库搬会把同一批版本号再插一遍 ⇒ `schema_migrations_pkey` 唯一键冲突
 * （2026-09-15 实测踩到，事务已整体回滚）。语义上也应如此：**结构版本由平台在目标端决定**。
 */
const SKIP = new Set(['schema_migrations'])

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const sqlitePath = arg('sqlite')
const pgUrl = arg('pg')
const dryRun = process.argv.includes('--dry-run')

if (sqlitePath === undefined || pgUrl === undefined) {
  console.error('用法: node scripts/migrate-sqlite-to-pg.mjs --sqlite <file> --pg <url> [--dry-run]')
  process.exit(2)
}
if (!existsSync(sqlitePath)) {
  console.error(`SQLite 文件不存在: ${sqlitePath}`)
  process.exit(2)
}

/** 让**平台的迁移**在 PG 上建好结构（不自己写 DDL，避免两套 schema）。 */
async function ensurePgSchema() {
  const config = resolveConfig({ dataRoot: '/tmp/migrate-tooling', dbUrl: pgUrl })
  const db = await createDbAdapter(config)
  await db.close()
}

async function main() {
  const sq = new Database(sqlitePath, { readonly: true })
  await ensurePgSchema()
  const client = new pg.Client({ connectionString: pgUrl })
  await client.connect()

  const sqTables = sq
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
  const pgTables = (
    await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")
  ).rows.map((r) => r.table_name)

  const common = sqTables.filter((t) => pgTables.includes(t) && !SKIP.has(t))
  if (sqTables.some((t) => SKIP.has(t))) {
    console.log(`按设计跳过: ${[...SKIP].join(', ')}（目标端的结构版本由平台迁移建立）`)
  }
  const ordered = [
    ...ORDER.filter((t) => common.includes(t)),
    ...common.filter((t) => !ORDER.includes(t)),
  ]
  const extra = common.filter((t) => !ORDER.includes(t))
  if (extra.length > 0) console.warn(`⚠️ 未在 ORDER 中声明、按末尾处理的表: ${extra.join(', ')}`)

  /** 两端的列交集 —— 只搬双方都有的列。 */
  async function sharedCols(table) {
    const sqCols = sq.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
    const pgCols = (
      await client.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        ['public', table],
      )
    ).rows.map((r) => r.column_name)
    return sqCols.filter((c) => pgCols.includes(c))
  }

  const report = []
  await client.query('BEGIN')
  try {
    for (const table of ordered) {
      const cols = await sharedCols(table)
      if (cols.length === 0) {
        console.warn(`跳过 ${table}: 无公共列`)
        continue
      }
      const rows = sq.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all()
      const idCol = IDENTITY[table]
      if (!dryRun && rows.length > 0) {
        const colList = idCol !== undefined ? [idCol, ...cols.filter((c) => c !== idCol)] : cols
        const override = idCol !== undefined ? ' OVERRIDING SYSTEM VALUE' : ''
        const chunk = 200
        for (let i = 0; i < rows.length; i += chunk) {
          const slice = rows.slice(i, i + chunk)
          const values = []
          const tuples = slice.map((row) => {
            const ph = colList.map((c) => {
              values.push(row[c] ?? null)
              return `$${values.length}`
            })
            return `(${ph.join(',')})`
          })
          await client.query(
            `INSERT INTO ${table} (${colList.join(',')})${override} VALUES ${tuples.join(',')}`,
            values,
          )
        }
        if (idCol !== undefined) {
          await client.query(
            `SELECT setval(pg_get_serial_sequence('${table}','${idCol}'),
                           (SELECT COALESCE(MAX(${idCol}),0) FROM ${table}))`,
          )
        }
      }
      report.push({ table, rows: rows.length, cols: cols.length })
    }
    if (dryRun) await client.query('ROLLBACK')
    else await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  }

  console.log(`\n${dryRun ? '【DRY-RUN，已回滚】' : '【已提交】'} SQLite → PG 迁移明细`)
  for (const r of report) console.log(`  ${r.table.padEnd(18)} ${String(r.rows).padStart(6)} 行 / ${r.cols} 列`)

  // 校验：逐表比对行数
  let bad = 0
  if (!dryRun) {
    for (const r of report) {
      const pgCount = Number((await client.query(`SELECT COUNT(*) AS c FROM ${r.table}`)).rows[0].c)
      const sqCount = Number(sq.prepare(`SELECT COUNT(*) AS c FROM ${r.table}`).get().c)
      if (pgCount !== sqCount) {
        console.error(`  ✗ 行数不符 ${r.table}: PG=${pgCount} SQLite=${sqCount}`)
        bad += 1
      }
    }
    console.log(bad === 0 ? '\n✅ 逐表行数一致' : `\n❌ ${bad} 张表行数不符`)
  }

  await client.end()
  sq.close()
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
