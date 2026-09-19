> **English (primary, this file)** ｜ **[中文文档](configuration.zh-CN.md)**

[← Back to README](../README.md)

# Configuration

Every environment variable is optional; a same-named CLI flag (`--port` / `--db` / `--isolation-mode` and so on) takes precedence. Full definitions live in `src/config.ts` and `node lib/cli.js --help`.

| Variable | Default | Description |
|---|---|---|
| `DSH_AI1NET_PORT` | `3080` | Control-plane bind port (the nginx upstream) |
| `DSH_AI1NET_DATA_ROOT` | `~/.dsh_ai1net` | Root of per-user home / workspace (use `/var/lib/dsh_ai1net` in production) |
| `DSH_AI1NET_DSH_BIN` | `dsh` | The child DSH executable (**an absolute path is recommended**) |
| `DSH_AI1NET_ISOLATION_MODE` | `soft` | `soft` for soft isolation / `account` for OS-account hard isolation (Linux, needs root) |
| `DSH_AI1NET_BASE_UID` | `100000` | Base uid for account-level isolation |
| `DSH_AI1NET_PORT_GUARD` | `false` | Port guard; enabling it on an unsupported host makes the service **refuse to start** |
| `DSH_AI1NET_SECURE_COOKIES` | `false` | Set to `true` for HTTPS deployments (adds `Secure` and `SameSite=None` to cookies) |
| `DSH_AI1NET_BASE_DOMAIN` | empty | Base domain for per-user subdomains (e.g. `dsh.example.com`); empty = sub-path access only |
| `DSH_AI1NET_COOKIE_DOMAIN` | empty | `Domain` of the session cookie (e.g. `.dsh.example.com` — note the leading dot) |
| `DSH_AI1NET_SESSION_TTL` | `604800` | Session lifetime in seconds (7 days by default) |
| `DSH_AI1NET_MAX_UPLOAD` | `25MB` | Maximum upload request body |
| `DSH_AI1NET_PACKAGE_DIR` | (auto-detected) | **Package root of the bundled dsh.** Detected in order: reverse-resolved from `DSH_AI1NET_DSH_BIN` through symlinks → `/usr/local/lib/node_modules`, `/usr/lib/node_modules` → `npm root -g`. ⚠️ Where `npm i -g` lands depends on the distribution (a Node installed by the distro's package manager usually lands in `/usr/lib/node_modules`), and **hard-coding it silently breaks both the provider catalogue in "Model settings" and the "plugin compatibility pre-check"** (no error, just degraded behaviour) ⇒ set it explicitly only when detection fails. The unprefixed `DSH_PACKAGE_DIR` is accepted as well |
| `DSH_AI1NET_COMPAT_ROOT` | (same as the left) | Same as above (legacy name). The unprefixed `DSH_COMPAT_ROOT` is accepted as well |
| `DSH_AI1NET_PI_AI_DATA_DIR` | (auto-detected) | Data location of the `@earendil-works/pi-ai` **provider catalogue** (`<package root>/node_modules/@earendil-works/pi-ai/dist/providers/data`); normally no need to set it. The unprefixed `PI_AI_DATA_DIR` is accepted as well |
| `DSH_AI1NET_RESTART_BACKOFF` | `1000` | Delay before an automatic restart after a crash (milliseconds) |
| `DSH_AI1NET_RESTART_BACKOFF_MAX` | `30000` | Backoff ceiling (milliseconds) |
| `DSH_AI1NET_CRASH_MAX_RESTARTS` | `5` | Automatic restarts allowed within the circuit-breaker window |
| `DSH_AI1NET_CRASH_WINDOW` | `600000` | Circuit-breaker window (milliseconds) |
| `DSH_AI1NET_CRASH_STABLE` | `60000` | How long it must run continuously to count as recovered (milliseconds) |
| `DSH_AI1NET_CRASH_BREAKER_COOLDOWN` | `600000` | Initial circuit-breaker cooldown (milliseconds) |
| `DSH_AI1NET_CRASH_BREAKER_MAX_COOLDOWN` | `21600000` | Cooldown ceiling (milliseconds, 6 hours) |
| `DSH_AI1NET_MAX_IDLE_INSTANCES` | `4` | Maximum resident instances (beyond this, the idlest are reaped) |
| `DSH_AI1NET_INSTANCE_IDLE_TTL` | `604800` | How long an instance may stay idle before being reaped (seconds, 7 days) |
| `DSH_AI1NET_IDLE_REAP_INTERVAL` | `60` | Idle-reaping interval (seconds) |
| `DSH_AI1NET_BUNDLED_SKILL_DIR` | `<dataRoot>/bundled-skills` | Directory of the bundled shared skill layer (read-only for users) |
| `DSH_AI1NET_ENABLE_PATCH` | `false` | Whether to inject `--patch` into the child DSH (runtime plugins plus per-folder plugins) |
| `DSH_AI1NET_SECRET` | auto-generated | Master key for encrypting the credential vault; when unset it is generated and persisted to `<dataRoot>/secret.key` (0600) |

Notes:

- **Where a deployment's own values come from**: `config/platform.env` — copy `config/platform.env.example` and fill it in. That file is **git-ignored, so it is never published**; only the template and the two loaders are in the repository. Precedence is **system environment > `config/platform.env` > the defaults above**. The loaders are `config/load.sh` (shell) and `config/index.cjs` (Node scripts); the control plane itself reads the process environment, which `install.sh` supplies through the systemd unit. A missing file is reported as a warning and falls back to the defaults.
- The values `install.sh` writes differ from the defaults above (the script picks per scenario): `ISOLATION_MODE=account` (downgraded to `soft` when `useradd`/`setpriv` is missing), `ENABLE_PATCH=true`, `PORT_GUARD=false` (enabled by `--port-guard`). The real content of `/etc/dsh_ai1net.env` is authoritative.
- **Injected by the platform, not meant to be set by hand**: `DSH_AI1NET_ROLE`, `DSH_AI1NET_HANDOFF_PATH`, `DSH_AI1NET_USER_ROOT`.
- **CLI only**: `DSH_AI1NET_ADMIN_PASSWORD` is equivalent to `bootstrap-admin --password`.
- **Optional hook**: `DSH_PICKER_ENSURE_SCRIPT` names an initialization script to run after an instance starts (empty = do not run).
