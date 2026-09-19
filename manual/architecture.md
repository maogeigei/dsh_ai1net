> **English (primary, this file)** ｜ **[中文文档](architecture.zh-CN.md)**

[← Back to README](../README.md)

# Architecture in detail

The diagram itself is in [README → Architecture](../README.md#architecture).

## The base

**The base is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`)** — DeepSeek AI's open-source **agent harness** (MIT, an **everything-is-a-plugin** architecture driven by Cordis). The official repository is <https://github.com/deepseek-ai/deepseek-harness> (the `@deepseek-ai/dsh` npm package declares it as its `repository` and `homepage`), and the CLI lives in its `apps/cli` directory.

| Item | Value |
|---|---|
| **dsh version this platform is built and validated against** | **`0.1.5-rc.1`** |
| Official repository | <https://github.com/deepseek-ai/deepseek-harness> |
| npm package | `@deepseek-ai/dsh` |

> ⚠️ **How the version is pinned.** `install.sh` installs the **latest** `@deepseek-ai/dsh` and does not pin it, so the version actually in use is whatever the host has. Because DSH is in developer preview and ships breaking changes, the platform treats the DSH version as a **frozen runtime baseline** and builds both a **plugin compatibility pre-check** and **drift inspection** on top of it — so a host that has moved to a different DSH version is visible rather than silently broken.

By default DSH is a **single-user, local** product: `npx @deepseek-ai/dsh web` starts a Web UI on `127.0.0.1:3080`, with plugins and skills all attached to one profile.

This project **neither modifies nor embeds** DSH's code. It wraps a hosting platform around it: one `dsh` instance is spawned per user as a child process, and the public side handles accounts and approval, routing and reverse proxying, isolation and guards, unified plugin and skill management, self-healing and operations.

> DSH is in **developer preview** and the upstream project says outright that **breaking changes** will happen — which is why the platform ships **plugin compatibility pre-checks** and **runtime version freezing** as built-in capabilities.

## Which parts of the official documentation do not apply here

DSH's own documentation is written for **a single-user install you run locally**. Below are the specific upstream items that stop holding once DSH is hosted, and what the platform does instead.

Sources: the [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness) (`master` branch) and its documentation site <https://deepseek-harness.github.io/deepseek-harness/>. Where an item is not a quotable upstream sentence but something we measured on a real deployment, it is marked **[measured]**.

### 1. "Run from npm" — the local-browser assumption

Upstream (README → *Run*):

> `npx @deepseek-ai/dsh web` … *"The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address."*

**Why it does not hold**: both sentences assume the browser and the process are on **the same machine** (or that you hold an SSH port-forward into it). On the platform the browser is **the user's own computer** and the intended access path is a public domain — so `127.0.0.1:3080` resolves to the *user's* laptop, and `--open` / `--no-open` are meaningless.

**What the platform does instead**: `install.sh` installs DSH as a **service**, with no browser step and no expectation that end users ever touch `127.0.0.1`; they reach `https://<domain>/` (control plane) and `https://<username>.<domain>/` (their own DSH) through nginx. See [installation.md](installation.md).

### 2. The official "Settings → Models" page cannot read the provider catalogue **[measured]**

That page requires a **host-settings mirror** and decides persistence with `isLoopback`-style checks. Reaching the platform means browser → domain → remote server, so those checks fail and persistence degrades to memory ⇒ **the page cannot list providers at all**.

**What the platform does instead**: it **writes the credential files itself** — enabled entries from the credential vault go straight into the instance's `$DSH_HOME/.credentials.yaml` and `settings.yaml`, and only entries carrying the platform's own `managed` marker are ever touched. The provider list is read from the **same `pi-ai` package the instance uses**, so it cannot drift. See [highlights §4](highlights.md#4-models-and-the-access-surface).

### 3. Client-plugin `inject` and the official UI packages **[measured]**

Upstream's plugin mechanism lets a client plugin declare `dsh.client.inject`. The platform's role patch **disables several official UI packages per role**, so a plugin injects only packages that are delivered in the role it targets.

**What the platform does instead**: see [PLUGIN-PORTING.md §H7](../PLUGIN-PORTING.md) — plugin authors must not inject official UI packages unless they are guaranteed to be delivered in that role.

### 4. "Add the `dsh-plugin` topic to your plugin repository for discoverability"

That is upstream's discovery route (the GitHub [`dsh-plugin` topic](https://github.com/topics/dsh-plugin)). It is **not** how a plugin reaches this platform: the platform keeps its **own admin-managed candidate pool**, with an official recommended catalogue, a compatibility pre-check and per-plugin memory estimates.

### 5. "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" and `SAFETY.md`

Upstream is explicit that DSH is in developer preview with breaking changes, and points at `SAFETY.md` for the safety notice — but it is describing **a single-user local install**, so it offers **no isolation between tenants**.

**What the platform does instead**: it treats the DSH version as a **frozen runtime baseline** (see [above](#the-base)), gates plugin enabling behind a compatibility pre-check, and layers uid isolation, a port guard and an egress guard on top.

⇒ In short: **the upstream documentation remains the authority on DSH itself; what this repository documents is the hosted form of it.** Where the two disagree, the difference is this section.

## Request path

Browser → nginx (TLS termination, main domain plus wildcard subdomains) → control plane (a single Fastify process: auth / approval / admin surface / web desktop) → routed by `Host` or `/u/<userId>/dsh/*` → the user instance (bound only to a loopback dynamic port, never exposed).

## Self-healing path

```
main instance crashes ──▶ spawn a "guardian instance" on demand to repair the profile ──▶ restart the main instance
        │                                                                                        │
        └── repeated crashes ──▶ exponential backoff ──▶ circuit-breaker cooldown (10min up to 6h) ──▶ refuse to start during cooldown (503)
```

## Deployment shape

Single machine (bare metal + systemd + nginx): `sudo bash install.sh` deploys in one shot; the control plane orchestrates each per-user instance via `child_process` + `setuid`, data lives in a local SQLite database, and instances bind loopback ports only.

## Repository layout

```
src/            Control-plane source (TypeScript)
  db/           Data layer (SQLite)
  fs/           Per-user filesystem (local implementation + path fence)
  supervisor/   Instance orchestration (spawn / proxy / crash policy / session presets)
  web/          Fastify server and routes (auth / admin / dsh / skills / plugins / whitelist …)
web/            Control-plane static pages (login / register / admin portal / wake page)
scripts/        Operations scripts (install shared runtime, cleanup, backup, static checks)
config/         Deployment configuration (template plus the shell / Node loaders)
install.sh      One-shot single-machine deployment
Dockerfile      Control-plane image
README.md       Project documentation (this file)
PLUGIN-PORTING.md  Plugin porting guide
manual/         Supporting documentation (installation, configuration, security, FAQ …)
examples/       Plugin porting example
diagrams/       Architecture diagrams (SVG plus self-contained HTML)
```
