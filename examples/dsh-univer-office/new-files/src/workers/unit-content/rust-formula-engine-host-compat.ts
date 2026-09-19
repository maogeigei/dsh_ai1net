import { createRequire } from 'node:module'
import type { IConfigService, Injector } from '@univerjs/core'
import type { IUniverRustFormulaEngineConfig } from '@univerjs-pro/engine-formula-rust'
import * as rustEngine from '@univerjs-pro/engine-formula-rust'

export * from '@univerjs-pro/engine-formula-rust'

/**
 * 宿主兼容垫片：Rust 公式引擎绑定装不上时，自动回落到 JS 公式引擎
 * （2026-09-13 · 实测于 Alibaba Cloud Linux 3 / glibc 2.32）。
 *
 * **为什么需要**：`@univerjs-pro/engine-formula-rust-binding` 的 linux-x64 产物是按
 * **glibc ≥ 2.35** 链接的（`univer-formula.linux-x64-gnu.node` 依赖 `GLIBC_2.35`）。
 * 本平台的用户实例跑在 Alibaba Cloud Linux 3（glibc **2.32**）上 ⇒ `require()` 直接抛
 * `version 'GLIBC_2.35' not found` ⇒ **内容投影**（execute / inspect / export / render-source）
 * 在建投影时整进程崩掉（不是可捕获的降级，是 uncaught throw）。
 *
 * **上游本就有闸门**：`IUniverRustFormulaEngineConfig.useRustEngine: false` ⇒ 上游插件的
 * `onReady()` / `_extendFormulaExecutionDependencies()` 就不会注册
 * `RustEngineSyncController` / `RustSameRuntimeProjectionController`，公式改由
 * `@univerjs-pro/engine-formula` 的 **JS 引擎**计算（功能等价，只是大表算得慢些）。
 * 但 `@univerjs-cli/headless-univer` 的 `createStandardHeadlessUniverFactory()` **不接受该配置、
 * 也不暴露注册点** ⇒ 只能在本仓库自己的构建里把该模块换成本垫片（见 `scripts/build.mjs`
 * 的 `rustFormulaEngineHostCompat()`，**只作用于 worker 构建**）。
 *
 * **行为**：绑定装得上（glibc ≥ 2.35 的宿主）⇒ 原样转交上游（继续用 Rust）；
 * 绑定装不上 ⇒ 强制 `useRustEngine: false`。**宿主机 glibc 升级后本垫片无需改动**即自动恢复 Rust，
 * 因此不需要额外的开关或版本判断。
 */
const BINDING_PACKAGE = '@univerjs-pro/engine-formula-rust-binding'

function rustBindingLoadable(): boolean {
  try {
    // ⚠️ 本文件**同时**被打进 worker（ESM 产物）与 gateway（**CJS** 产物）——
    // CJS 产物里 esbuild 会把 `import.meta` 降级成空对象（`var import_meta = {}`），
    // 于是 `createRequire(import.meta.url)` 变成 `createRequire(undefined)`，**网关启动即崩**
    // （`ERR_INVALID_ARG_VALUE`，2026-09-13 实测）。⇒ 按运行形态二选一取「当前模块路径」。
    const modulePath =
      typeof __filename === 'string' && __filename.length > 0 ? __filename : import.meta.url
    createRequire(modulePath)(BINDING_PACKAGE)
    return true
  } catch (error: unknown) {
    process.stderr.write(
      '[uvcompat] Rust formula engine binding unavailable -> JS formula engine fallback: ' +
        String((error as Error)?.message ?? error)
          .split('\n')[0] +
        '\n'
    )
    return false
  }
}

const rustAvailable = rustBindingLoadable()

/** 与上游同名导出；仅在绑定不可用时改写配置。 */
export class UniverRustFormulaEnginePlugin extends rustEngine.UniverRustFormulaEnginePlugin {
  public constructor(
    config: Partial<IUniverRustFormulaEngineConfig> | undefined,
    injector: Injector,
    configService: IConfigService
  ) {
    super(
      rustAvailable ? config : { ...(config ?? {}), useRustEngine: false },
      injector,
      configService
    )
  }
}
