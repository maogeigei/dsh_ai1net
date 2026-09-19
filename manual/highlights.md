> **English (primary, this file)** ｜ **[中文文档](highlights.zh-CN.md)**

[← Back to README](../README.md)

# Highlights in detail

The condensed overview is in [README → Highlights](../README.md#highlights).

## 1. Process-level isolation

- **One OS account per user** — every user gets a deterministic uid; the instance starts de-privileged under that uid. The isolation boundary is the **kernel**, not a file-permission convention.
- **Port guard** — instances bind a dynamic loopback port only; the platform blocks direct connections from other same-host accounts by uid (**refuses to start** where the host cannot support it — no silent downgrade).
- **Egress guard** — cloud metadata endpoints are blocked, instances are prevented from reaching the host itself, and new outbound connections are observed.
- **Browser trust fence** — the reverse proxy scrubs `Origin` / `Referer` / `X-Forwarded-For` and rewrites `Host` to loopback.
- **Environment allowlist** — an instance's env is rebuilt from an allowlist before the user's own values are injected; platform secrets never enter a user process.
- **Path fence** — lexical containment checks plus per-segment rejection of symlink components; you cannot leave your own root.
- **Tiered upload scanning** — a P0 hit is a hard `400`; P1 hits (dynamic execution / outbound calls / sensitive env / hidden files) are recorded for admin review.
- **Isolation in layers** — soft → OS-account hard isolation → port guard, each independently switchable.

## 2. Self-healing and state recovery

- **Crash circuit-breaker** — exponential backoff with a cooldown cap (from 10 minutes up to 6 hours); a bad instance is never restarted forever, and requests during cooldown get `503 instance_circuit_open`.
- **Repair on demand** — the guardian instance is spawned once, only when the main instance crashes, to repair the profile ⇒ in steady state each active user runs exactly one process.
- **Seamless recovery after reaping** — navigation goes through a transition page, XHR waits for readiness before forwarding, and **401 is replayed transparently**; returning to the page wakes the instance and re-establishes the connection.
- **Session-expiry self-healing** — a self-healing script injected into instance pages (25-second heartbeat plus a stall check; recovery only after two consecutive failures, so no false positives).
- **Plugin-load failure self-healing** — a "crashes on start" caused by an incompatible plugin is detected and isolated instead of restarting forever.
- **Concurrency convergence** — one active session (last login wins) plus idle reaping (resident cap + TTL).

## 3. Governed plugin and skill management

- **Pre-check on import** — dependency range and exported symbols; incompatible plugins are rejected by default, with the per-item evidence shown back.
- **"Compatible ≠ usable"** — delivering an **absolute URL** to the browser is classed as **blocking** (it always fails behind a hosting platform, and the platform cannot compensate). See the [plugin porting guide](../PLUGIN-PORTING.md).
- **Enabling in three steps** — probe → roll back to a snapshot on failure → per-plugin isolation flag: only the incompatible plugin is disabled, never the whole instance.
- **Memory estimation** — estimated badges and status bars from measured load cost; exceeding the per-instance cap is blocked and requires confirmation, because cost depends on *what* is installed.
- **Two skill layers** — shared (bundled with the platform, read-only for users) plus personal; zip uploads are replaced atomically in two phases, same-name conflicts require confirmation, and skills take effect without restarting the instance.
- **One-click official catalogue** — roughly 3,400 entries, with Chinese descriptions back-filled.

## 4. Models and the access surface

- **The official model page cannot work here, so the platform builds its own** — the official "Settings → Models" page requires a host-settings mirror, but the platform is "a browser reaching a remote server over a domain" ⇒ all three of its `isLoopback` checks fail and persistence degrades to memory, so the page cannot read the provider catalogue. The platform instead **writes files itself**: enabled entries from the credential vault are written straight into the instance's `$DSH_HOME/.credentials.yaml` and `settings.yaml`.
- **Only touch what we wrote** — the platform tracks a `managed` manifest: key entries and provider sections placed by the user are **never overwritten and never deleted**; a delete removes only the platform's own line or the span between its own markers.
- **Backed by the official provider catalogue** — it reads the **same** `pi-ai` package the instance uses (same data source ⇒ no drift), lists the providers it ships (currently 39, including `kimi-coding` / `moonshotai-cn` / `minimax-cn` / `zai` / `xiaomi` / `ant-ling`), and puts the "directly reachable from mainland China" group first; picking a provider means **filling in one API key** — endpoint, protocol and model list all come from the catalogue.
- **Shared and personal coexist** — an admin can enable one shared key so users start with zero configuration, while users can still add their own entries and enable them individually. When a user brings their own key the platform **does not inject the shared env**, so the user's own key takes effect.
- **Out-of-scope administration does not pollute existing boundaries** — service and file APIs always mean "address only your own resources"; when an admin manages someone else, a **separate `/api/admin/users/:id/...` group, entirely behind `requireAdmin`**, is used instead of stuffing `if (admin)` into the original routes.

## 5. Testable and regressable

- **Key decisions are pure functions** — crash policy, path fence and patch rendering depend on neither processes nor the network: **unit-testable without starting an instance and without touching production**, so changes can be regressed immediately.
- **Built for regression** — key decisions are pure functions, so a behaviour change can be reasoned about in isolation; on top of that the **injection scripts are checked at runtime** (template evaluation plus `node --check`) as part of `npm run verify`.

## 6. Deployment and operations

- **One command covers the whole flow** — environment pre-check → dependencies and build → DSH CLI → environment file → data root → first admin → reverse proxy → service → health check.
- **Idempotent and rehearsable** — re-running only fills in what is missing; `--dry-run` **prints without writing anything** and never emits "done"-style messages.
- **Admin first, service second** — the order is fixed (starting the service first would hold the database lock), avoiding the classic "deployment finished but login fails".
- **Self-adapting reverse proxy** — detects `/etc/nginx/conf.d` and panel (BT-Panel) vhost directories; reload tries systemd, then init scripts, then `nginx -s`, and **never touches existing sites**.
- **Register → approve → log in** — self-registration lands as `pending` and only becomes usable after admin approval.
- **One host per user** — in subdomain mode session cookies are naturally isolated per user (several users on one host would evict each other's sessions).

## 7. Overlay network

- **No inbound port needed** — a node behind NAT never opens a listening port: it makes **one outbound connection** and every stream is multiplexed over it. The relay binds **loopback only**, so adding nodes does not add publicly reachable surface.
- **The address stays ordinary** — to the caller it is still a host and a port, so the transport can be replaced without touching the request path; the reverse proxy, remote spawner and remote file access are unchanged.
- **Direct when it works, relay when it does not** — candidate endpoints are exchanged over the connection that already exists (no new port, no new protocol) and a UDP path is attempted on top. A direct path counts only when **both directions** work; otherwise it is declared dead and the fall back is **named** — off, cooling down, no address, one-way, or past the deadline. Switching it off is not a loss of function.
- **Identity decides before address does** — four key layers: an offline root that only authorises signers, online signers that issue node credentials, one key per node, and an in-memory session key. Whether a node may join is verified **on the node itself**, so a compromised control plane cannot silently insert one; anything unverifiable is refused with a named reason rather than falling back to a shared credential.
- **Per-node keys, not a shared token** — a shared token would make the blast radius every node; each node carries its own key, and the key table is indexed by **logical name** so the same machine name can exist in two networks.
- **The network is a dimension, not a policy** — operator hosts and each user's devices live in separate networks (`ops`, and `u:<userId>` per user), and a session is **structurally** confined to its own network instead of being filtered by an access list afterwards.
- **Addresses are a rotatable handout** — bootstrap resolves as explicit env › cached signed directory › built-in seed, and a directory is accepted **only if it verifies against a trusted key**. The seeds inside it are the rotation handle, so moving a relay does not require reinstalling or upgrading clients.
- **The relay never sees plaintext** — a group key encrypts blocks **deterministically**, so the same plaintext still yields the same block id (per-group deduplication keeps working) while the relay only carries ciphertext. Fetches prefer the direct path and fall back to the relay.
- **Fail loud, never silently** — a refused join, a dead direct path and a rejected directory each carry a **structured reason**; unverifiable means refused. The failure modes this replaces are the ones that present as "the network is broken" when in fact the configuration is wrong.
