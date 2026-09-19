/**
 * **部署相关路径的唯一解析处**。
 *
 * ## 为什么单独成模块
 * 这些路径原先各自**硬编码在 5 个文件里**（`<platform-dir>/state`、`<platform-dir>/backups`、
 * `<install-dir>/scripts`、`<data-root>/overlay` …）⇒ 仓库副本换一个部署者就会**带出别人的
 * 目录结构与主机信息**。集中到这里后：代码内**不含任何真实路径**，一律从配置读取
 * （见 `config/platform.env` 与 `config/README.md`）。
 *
 * ## 两条纪律
 * ① **⛔ 不要在别处重算这套路径** —— 同一事实只有一处（R11）。要新路径就加在这里。
 * ② **本模块必须零副作用** —— 不建目录、不写文件、不抛错。`resolveConfig()` 会
 *    `mkdir` 数据根并可能生成 `secret.key`，所以**不能**在这里调它（会被静态资源
 *    或只读路径调用）。这里只做 `process.env` + 中性默认值的纯计算。
 *
 * @module dsh_ai1net/platform-paths
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 数据根（每用户 home/ws、平台库）。部署时用 `DSH_AI1NET_DATA_ROOT` 指定。 */
export function dataRootDir(): string {
  return process.env.DSH_AI1NET_DATA_ROOT ?? join(homedir(), '.dsh_ai1net')
}

/** 平台私有目录的父目录（其下 `state` / `backups` / `artifacts`）。
 * 缺省取 `<数据根>/platform` —— **中性默认**，不含任何真实部署路径。 */
export function platformDir(): string {
  return process.env.DSH_PLATFORM_DIR ?? join(dataRootDir(), 'platform')
}

/** 平台状态目录（托管清单、能力清单、运行时基线）。 */
export function stateDir(): string {
  return process.env.DSH_PLATFORM_STATE_DIR ?? join(platformDir(), 'state')
}

/** 平台备份目录（改写用户 home 文件前的平台侧备份）。 */
export function backupDir(): string {
  return process.env.DSH_PLATFORM_BACKUP_DIR ?? join(platformDir(), 'backups')
}

/** 平台产物目录（插件 / 产物 tgz）。 */
export function artifactDir(): string {
  return process.env.DSH_PLATFORM_ARTIFACT_DIR ?? join(platformDir(), 'artifacts')
}

/** 代码安装根（`lib/`、`scripts/` 所在）。
 * 默认从本模块位置推导：`<root>/lib/platform-paths.js` ⇒ `<root>`。 */
export function installDir(): string {
  const fromEnv = process.env.DSH_INSTALL_DIR
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)))
  } catch {
    return process.cwd()
  }
}

/** 代码根下的脚本路径（如 `installDir()/scripts/ensure-biz-plugins.cjs`）。 */
export function scriptPath(...parts: string[]): string {
  return join(installDir(), 'scripts', ...parts)
}
