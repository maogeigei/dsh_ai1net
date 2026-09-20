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
Behaviour changes a user can feel are recorded on the homepage:
**[README → Version history](../README.md#version-history)**. Changes to the documents themselves are recorded here:

- **v1.4.1**: the `README` opening now explains why the project exists; `manual/project.md` gains the collaboration model (the decision method the human supplies, how the AI weighs options by it and takes the better one instead of coming back to ask, where the method runs out; every question that reaches the human written as two or three options, each with what it is good for and what it costs, with red lines always raised on their own; plus how a document is found in a set this size, how recurring procedures become skills, how work passes between sessions, and the three locks that keep parallel sessions from colliding), laid out as sub-sections in the order the work actually uses them; `manual/project.md` now covers only how the project is built, with local development, issues and pull requests and version numbers moved into this file; `manual/architecture.md` gained an overlay section and the figure `diagrams/architecture-overlay.svg`.
- **v1.3.1**: the registration and login screenshots were documented in the `README`.
