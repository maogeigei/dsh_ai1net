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
用户可感的行为变更记在主页：**[README → 版本更新说明](../README.zh-CN.md#版本更新说明)**。文档自身的结构调整记在这里：

- **v1.4.1**：`README` 开篇改为说明「为什么做这个项目」；`manual/project.md` 补上协作方式（人给出的判断方法、AI 如何照着方法比出优劣、择优定下而不是回头再问、方法到哪里就到头了；凡是问到人的问题都写成两三个候选、每个写明优点与缺点，红线必须单独提；另含文档集里怎么找到该读的那一份、把反复流程固化成技能、任务怎么在会话之间传递、让并行会话不相撞的三把锁），并按实际运用的顺序拆成子标题；`manual/project.md` 现在只讲「项目如何建成」，本地开发 / Issue 与 PR / 版本号搬进本文件；`manual/architecture.md` 增补覆盖网络一节与配图 `diagrams/architecture-overlay.svg`。
- **v1.3.1**：注册页与登录页两张截图写进 `README`。
