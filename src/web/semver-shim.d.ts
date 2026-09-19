/**
 * 极简类型声明
 *
 * `semver` 是平台的**传递依赖**（`node_modules/semver` 实测 7.8.5，无 `@types/semver`）。
 * 兼容性预检只用到 `satisfies`，故按需声明所需形状 —— 既不引入新依赖，也不让
 * `tsc` 因缺声明而失败（TS7016）。
 *
 * ⚠️ 语义提醒：**不传第三参**（即不使用 `includePrerelease`）。
 * 这与 npm/pnpm 的实际安装判定一致；线上那次插件崩溃正是「prerelease 默认不匹配范围」导致的
 * （它写 `<0.1.2`，pnpm 于是给它装了自带的旧版 dsh-tool-web）。详见 `plugin-compat.ts` 头注。
 */
declare module 'semver' {
  /** 版本是否落在范围内（默认语义，与 npm 一致）。 */
  export function satisfies(version: string, range: string): boolean
}
