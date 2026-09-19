> **English (primary): [contributing.md](contributing.md)** ｜ **[中文文档](contributing.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 贡献

## 本地开发

```sh
npm install          # pnpm / npm 均可；Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm run verify       # 构建 + 静态校验脚本  ← 提交前跑这个
```

**改动纪律**：只改 `src/` 与 `web/`，不要改 `lib/`（它是构建产物，改了会被覆盖）；提交前必过 `npm run verify`；关键决策写成纯函数，改实现要连同断言一起改；注释写的是「为什么」—— 行为变了，注释跟着变。

## Issue 与 PR

- **Bug** —— 附复现步骤、报错信息、运行环境（系统 / Node / DSH 版本）
- **建议** —— 说明使用场景与期望效果
- **PR** —— 请先 `npm run typecheck && npm run verify` 通过
- 提交信息建议用 `feat:` / `fix:` / `chore:` 前缀

## 版本与迭代

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）。
发布历史 —— 每个版本及其更新点 —— 在主页上：**[README → 版本更新说明](../README.zh-CN.md#版本更新说明)**。
