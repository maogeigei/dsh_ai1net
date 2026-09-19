/**
 * Child-process helpers for the supervisor: env scrubbing and free-port lookup.
 *
 * Env scrubbing mirrors the harness `scrubbedParentEnv` / `SENSITIVE_ENV_PATTERN`
 * doctrine (packages/subprocess/subprocess/src/index.ts): build the child env
 * from a clean allowlist so no orchestrator secret leaks into a user DSH, then
 * inject only the resolved per-user values.
 * @module dsh_ai1net/supervisor/spawn
 */

import { createServer } from 'node:net'

const ALLOWED_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'PATHEXT',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'LANG',
  'LC_ALL',
  // Shared read-only skill dir; injected explicitly in baseEnv, allowlisted here
  // so it survives scrubEnv if ever set on the orchestrator process.
  'DSH_BUNDLED_SKILL_DIR',
  // 实例内权限档位（dsh-base 读 DSH_PERMISSION_MODE 决定 sandbox mode + approval policy）。
  // 只做 allowlist，实际值由 orchestrator.baseEnv 注入。
  'DSH_PERMISSION_MODE',
  // 冻结实例的基础运行时版本（Python / pip / node 一律用平台装的那份，禁止版本漂移）。
  // 这两条是**限制性** env（语义为收窄，不是扩大）：
  //   · PYTHONNOUSERSITE=1 —— 不把 `$HOME/.local/lib/python*/site-packages` 加进 sys.path
  //     （实测：一旦该目录被 pip 创建，它就在 sys.path 里且**优先于平台 site-packages** →
  //      用户装的同名包会盖住平台包，正是"版本差异导致插件功能不可用"的来源）；
  //   · PYTHONUSERBASE=<只读占位位> —— 让 `pip install --user` **明确失败**而不是静默无效。
  'PYTHONNOUSERSITE',
  'PYTHONUSERBASE',
])

/** Drop credential-shaped and unknown env vars; keep only a safe allowlist. */
export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (ALLOWED_ENV.has(key) && value !== undefined) out[key] = value
  }
  return out
}

/** Reserve an ephemeral loopback port, release it, and return its number. */
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => {
        if (port !== undefined) resolve(port)
        else reject(new Error('could not reserve a free port'))
      })
    })
  })
}

/**
 * 在 `[base, base + span)` 内取一个空闲回环端口（覆盖网络 S3）。
 *
 * ## 为什么不能用 `listen(0)`
 * `listen(0)` 让**每台 worker 各自**随机取端口，而所有跨机实例的**隧道落点全挤在 Manager
 * 的 `127.0.0.1`** 上 ⇒ **两台 worker 取到同号就撞号**：`ssh -R` 失败被静默忽略
 * （`tunnel.forward()` 的返回值无人检查），Manager 仍按该端口拨 ⇒ **打到别人的实例**
 * （2026-09-16 实测）。给每台 worker 一段**互不重叠**的区间即可根治。
 *
 * ⛔ 区间用尽 **抛错**，不静默退回 `listen(0)` —— 那等于把撞号风险悄悄放回来。
 */
export function findFreePortInRange(base: number, span: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let candidate = base
    const end = base + span
    const attempt = (): void => {
      if (candidate >= end) {
        reject(new Error(`实例端口区间已耗尽：${base}-${end - 1}（span=${span}）`))
        return
      }
      const port = candidate
      candidate += 1
      const server = createServer()
      server.once('error', () => attempt())
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const got = typeof address === 'object' && address !== null ? address.port : undefined
        server.close(() => {
          if (got === undefined) attempt()
          else resolve(got)
        })
      })
    }
    attempt()
  })
}

/**
 * 取实例端口的**统一入口**：配了区间（`base>0 && span>0`）就走区间，否则退回旧的 `listen(0)`。
 * 单机 / 未配 env 的部署因此**行为零变化**。
 */
export function findInstancePort(base: number, span: number): Promise<number> {
  return base > 0 && span > 0 ? findFreePortInRange(base, span) : findFreePort()
}
