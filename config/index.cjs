/**
 * DSH 平台 — 脚本侧配置加载器（供 `scripts/` 下的 node 脚本使用）
 *
 * 与 `config/load.sh`（shell 侧）同一口径：
 *   **系统环境变量 > config/platform.env > 本模块的中性默认值**
 *
 * 用法（CJS）:
 *   const cfg = require('../config/index.cjs')
 *   cfg.dataRoot()      // 数据根
 *   cfg.stateDir()      // <platformDir>/state
 *
 * 用法（ESM）:
 *   import cfg from '../config/index.cjs'
 *
 * ⛔ 本模块**零副作用**（不建目录、不写文件）；未配置文件时不报错。
 */

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ENV_FILE = process.env.DSH_CONFIG_FILE || path.join(__dirname, 'platform.env')

/** 读取 platform.env 到对象（缓存；解析失败返回空对象）。 */
let _fileCache = null
function fileEnv() {
  if (_fileCache !== null) return _fileCache
  const out = {}
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8')
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (line === '' || line.startsWith('#')) continue
      const i = line.indexOf('=')
      if (i <= 0) continue
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1)
      }
      if (k !== '') out[k] = v
    }
  } catch {
    /* 文件不存在 ⇒ 全部走系统 env / 中性默认 */
  }
  _fileCache = out
  return out
}

/** 取一个键：系统 env 优先，其次配置文件。 */
function get(key) {
  const fromEnv = process.env[key]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const fromFile = fileEnv()[key]
  return fromFile !== undefined && fromFile !== '' ? fromFile : undefined
}

const isWin = process.platform === 'win32'

/** 数据根（每用户 home/ws、平台库）。 */
function dataRoot() {
  return get('DSH_AI1NET_DATA_ROOT') || path.join(os.homedir(), '.dsh_ai1net')
}

/** 平台私有目录的父目录（其下 state / backups / artifacts）。 */
function platformDir() {
  return get('DSH_PLATFORM_DIR') || path.join(dataRoot(), 'platform')
}

/** 平台状态目录。 */
function stateDir() {
  return get('DSH_PLATFORM_STATE_DIR') || path.join(platformDir(), 'state')
}

/** 平台备份目录。 */
function backupDir() {
  return get('DSH_PLATFORM_BACKUP_DIR') || path.join(platformDir(), 'backups')
}

/** 平台产物目录。 */
function artifactDir() {
  return get('DSH_PLATFORM_ARTIFACT_DIR') || path.join(platformDir(), 'artifacts')
}

/** 代码安装根（`lib/`、`scripts/` 所在）。 */
function installDir() {
  return get('DSH_INSTALL_DIR') || path.resolve(__dirname, '..')
}

/** 平台库文件路径（SQLite；Postgres 时用 dbUrl()）。 */
function dbFile() {
  return get('DSH_AI1NET_DB_FILE') || path.join(dataRoot(), 'dsh_ai1net.db')
}

/** 平台库连接串（未配置 ⇒ undefined，表示走 SQLite）。 */
function dbUrl() {
  return get('DSH_AI1NET_DB_URL')
}

/** 全员共享只读技能目录（`DSH_BUNDLED_SKILL_DIR`）。 */
function bundledSkillsDir() {
  return get('DSH_AI1NET_BUNDLED_SKILL_DIR') || path.join(dataRoot(), 'bundled-skills')
}

/** 每用户数据目录的父目录。 */
function usersDir() {
  return get('DSH_AI1NET_USERS_DIR') || path.join(dataRoot(), 'users')
}

/** 覆盖网络注册表 / 节点目录。 */
function overlayDir() {
  return get('DSH_AI1NET_OVERLAY_REGISTRY_DIR') || path.join(dataRoot(), 'overlay')
}

/** 代码安装根下的相对路径拼接（如 `installPath('lib','cli.js')`）。 */
function installPath(...parts) {
  return path.join(installDir(), ...parts)
}

/** 本机在 `dsh_hosts.id` 里的标识。 */
function hostId() {
  return get('DSH_AI1NET_CLUSTER_HOST_ID') || get('DSH_AI1NET_HOST_ID') || ''
}

/** 取多个键，一次返回（便于脚本解构）。 */
function all() {
  return {
    dataRoot: dataRoot(),
    platformDir: platformDir(),
    stateDir: stateDir(),
    backupDir: backupDir(),
    artifactDir: artifactDir(),
    installDir: installDir(),
    dbFile: dbFile(),
    dbUrl: dbUrl(),
    hostId: hostId(),
    bundledSkillsDir: bundledSkillsDir(),
    usersDir: usersDir(),
    overlayDir: overlayDir(),
    sep: isWin ? '\\' : '/',
  }
}

module.exports = {
  get, all,
  dataRoot, platformDir, stateDir, backupDir, artifactDir,
  installDir, installPath, dbFile, dbUrl, hostId,
  bundledSkillsDir, usersDir, overlayDir,
  ENV_FILE,
}
