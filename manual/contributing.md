> **English (primary, this file)** ｜ **[中文文档](contributing.zh-CN.md)**

[← Back to README](../README.md)

# Contributing

## Local development

```sh
npm install          # pnpm or npm; Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm run verify       # build + static verification scripts  ← run before committing
```

**Rules for changes**: change `src/` and `web/` only — `lib/` is build output and edits there are overwritten; run `npm run verify` before committing; key decisions are written as pure functions, so change them together with their assertions; comments explain *why* — when the behaviour changes, the comment changes with it.

## Issues and pull requests

- **Bug** — include reproduction steps, error messages and your environment (OS / Node / DSH versions)
- **Suggestion** — describe the use case and the outcome you expect
- **PR** — make sure `npm run typecheck && npm run verify` passes first
- Commit messages are best prefixed with `feat:` / `fix:` / `chore:`

## Versions

Version numbers follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The release history — every version with its list of changes — lives on the homepage:
**[README → Version history](../README.md#version-history)**.
