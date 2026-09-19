/**
 * 用户 home 下配置文件的读写（`settings.yaml` / `.credentials.yaml`）。
 *
 * **为什么单独成模块**：这段逻辑原先**内联在 `server.ts` 的闭包里**，只有"模型落地"那一条路径能用；
 * 2026-09-15 加"语言偏好持久化"（`/api/me/locale`）时需要**同一套**语义 —— 与其复制一份
 * （两份实现迟早漂），不如抽出来共用（R11：同一事实只有一处）。
 *
 * ⚠️ **`writeHomeFile` 里那两步都不能省**（都是从事故里换来的）：
 *   ① **先备份到平台目录**（`DSH_PLATFORM_BACKUP_DIR`，默认 `<platform-dir>/backups`）
 *      —— ⛔ 不能备份进用户 home：那是 dsh 的 watch 域，放进去的文件会被扫；
 *   ② **写完 chown 给 home 属主** —— 实例以 `dsh-<uid>` 身份运行，root 写的 0600 文件它**读不了**
 *      ⇒ 漏掉这步就是"配置写了但实例死活读不到"（/ R10 同族）。
 *
 * @module dsh_ai1net/web/home-files
 */

import { basename, dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { chown, mkdir, readFile, stat, writeFile } from 'node:fs/promises'

import { backupDir } from '../platform-paths.js'

/** 读文本，文件不存在 / 读不动 ⇒ 空串（调用方按"从零建文档"处理）。 */
export async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 写 home 里的配置文件：备份（落**平台目录**）→ 写 → chown 给 home 属主。
 * 实例以 dsh-<uid> 身份运行，root 写的 600 文件它读不了 ⇒ 最后一步不能省。
 */
export async function writeHomeFile(homeDir: string, file: string, text: string): Promise<void> {
  await backupHomeFile(homeDir, file, text)
  await writeFile(file, text, { mode: 0o600 })
  try {
    const st = await stat(homeDir)
    await chown(file, st.uid, st.gid)
  } catch {
    /* chown 失败（非 root 运行等）不阻断 */
  }
}

/**
 * 只做**备份**那一步（写进平台备份目录），**不碰用户文件**。
 *
 * 为什么单独抽出来：用户卷可能**不在本机**（实例在 worker 上）⇒ 写入必须走
 * `UserFs`（会按归属路由到那台机），而备份是**平台自己**的副本 —— 落在控制面的
 * `<platform-dir>/backups` 正合适，也不该为了备份再往远端开一条通道。
 * 备份的命名规则与 {@link writeHomeFile} 的①步**逐字一致**（⛔ 别各写一套）。
 */
export async function backupHomeFile(homeDir: string, fileOrName: string, text: string): Promise<void> {
  try {
    const bakDir = backupDir()
    await mkdir(bakDir, { recursive: true })
    const label = basename(fileOrName).replace(/^\./, '').replace(/\.ya?ml$/, '')
    // ⚠️ 带上 home 的**父目录名**（= 用户 id）：只写 basename 的话每个人都是 "home"，
    //    备份文件互相看不出是谁的（旧实现就是这个毛病：credentials-home-*.yaml）。
    const who = basename(dirname(homeDir))
    writeFileSync(join(bakDir, `${label}-${who}-${Date.now()}.yaml`), text, { mode: 0o600 })
  } catch {
    /* 备份失败不阻断 */
  }
}
