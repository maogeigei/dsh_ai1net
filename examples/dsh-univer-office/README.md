> **English (primary, this file)** ｜ **[中文文档](README.zh-CN.md)**

# Plugin porting example: `dsh-univer-office`

> ### 🙏 Credit
> The original plugin in this example is **[dream-num](https://github.com/dream-num)**'s
> **[`dsh-univer-office`](https://github.com/dream-num/dsh-univer-office) (Apache-2.0)** — **thanks to the author for open-sourcing it**.
> Moving a 41 MB online spreadsheet/document plugin into a hosted environment is only possible because someone built it in the first place.
> This directory contains **only the changes we made** (the patch, the new modules and the companion skill) and **no copy of the upstream source**;
> the full narrative is in [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4.

---

## 1. Why porting was necessary

`dsh-univer-office` **passed every static compatibility pre-check** (dependency range ✅, exported symbols ✅) yet was **completely unusable** on the platform. The cause was two **mutually independent** obstacles — **either one alone is enough to break it**:

| # | Obstacle | Mechanism | Measured symptom |
|---|---|---|---|
| **①** | Host → Gateway over **TCP loopback** | The gateway is `spawn`ed by the host and **inherits the same uid**; the platform's egress guard answers the instance uid range accessing `127.0.0.0/8` with `reject with tcp reset` ⇒ **the host cannot reach the gateway it started itself** | Creating a document always reported `bundled Gateway did not become ready within 10000ms` |
| **②** | Browser → Viewer over an **absolute URL** | The source hard-codes `gateway = http://127.0.0.1:${port}` and `viewerUrl = ${gateway}/?file=…`, used as an **iframe src** ⇒ the browser goes looking for the Viewer on **the user's own computer** at `127.0.0.1` | `grep -o "viewerUrl: [^,]*" lib/index.js` |

⇒ **The right answer is not "a different address" but "a different path"**: inter-process traffic moves to a **unix socket**, and the browser side moves to a **same-origin reverse proxy plus relative paths**.

("Just use the server IP" is the first idea most people have and the wrongest: the guard's block list already contains the server's own IP; binding a port on a shared multi-tenant host leaks across tenants; and an HTTP iframe inside an HTTPS page is hard-blocked by the browser.)

## 2. Contents

| Path | What it is |
|---|---|
| `port.patch` | Every change to **tracked files** (**19 files, +560 / −58**) |
| `new-files/` | The 6 modules **added** by this port (`git diff` does not include untracked files, so they are kept separately) |
| `companion-skill/office-file-generation/` | The companion skill: this host's glibc 2.32 cannot run Univer's native bindings, so it produces `.docx / .xlsx / .pptx` directly with the **Python standard library only** |

> **Coverage.** These artefacts are **self-consistent at `0.2.27`** — that is the version `port.patch` sets, and everything here can be applied as-is. The rounds that followed (the bundled-glibc launcher in `0.2.28`, and widening the peer ranges ahead of a platform upgrade in `0.2.29`) are described in [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4.5–§4.6; **nothing in this directory depends on them**.

## 3. Baseline and how to apply it

```sh
git clone https://github.com/dream-num/dsh-univer-office.git
cd dsh-univer-office
git checkout 5c190b6                       # this port's upstream baseline (2026-09-10; package.json there = 0.2.14)
git apply -p1 < /path/to/port.patch
cp -r /path/to/new-files/src/* src/        # the added modules (not in the patch)
```

> ⚠️ The `package.json` difference inside the patch spans `0.2.14 → 0.2.27` — that is not a plain version jump, it **is the iteration record of the porting work** (twelve build artefacts, 0.2.16 through 0.2.27, were kept locally as evidence).

## 4. What the port changed

### 4.1 New modules

| Module | Purpose |
|---|---|
| `shared/gateway-socket` | Parses `UNIVER_DSH_GATEWAY_SOCKET` (a path value or `auto`) and defines the `unix:<path>` endpoint identity |
| `shared/unix-http` | A minimal **HTTP over unix socket** client (`status`/`headers`/`text`/`json`/`arrayBuffer`/`signal`) — **zero new dependencies** |
| `shared/gateway-request` | The **unified transport entry point** `requestGateway(endpoint, path, init)`: picks socket or TCP automatically from the endpoint prefix |
| `host/webServer/viewer-proxy` | A **same-origin reverse proxy**: HTTP (streaming, stripping hop-by-hop headers) plus **WebSocket upgrade forwarding** |
| `shared/viewer-paths` | Browser-side path constants (kept independent of webServer to avoid a reverse dependency) |
| `workers/unit-content/rust-formula-engine-host-compat` | A host-compatibility shim: replaces `@univerjs-pro/engine-formula-rust` with the in-repo implementation |

> ⚠️ A **later** round (`0.2.28`) added a seventh module, `host/processes/glibc-runtime.ts`, which launches a process through a bundled glibc runtime (so native Office import/export works on an older host). It is described in [**PLUGIN-PORTING.md**](../../PLUGIN-PORTING.md) §4.5–§4.6, but it **is not part of `new-files/` here** — this directory stays exactly consistent with what `port.patch` produces.

### 4.2 Three design decisions (all learned the hard way)

1. **The socket is an *optional transport*, not a replacement for TCP** — enabled by env (set a path, or set `auto` to derive a process-level path under a private temporary directory);
   **leave it unset and upstream behaviour is preserved exactly** ⇒ **upstream-friendly (the default behaviour is unchanged, so it can be merged safely)**, and rolling back means simply **deleting that env**.
2. **Only two proxy rules** — all of this plugin's data-plane requests live under one prefix (WebSocket included):
   `/uf/**` → forward to the gateway (HTTP + WS upgrade); `/<plugin>-api/viewer/**` → forward to the gateway's page and static assets.
   ⚠️ Once the Viewer page has loaded it requests `/uf/*` **using absolute paths**, so the proxy **must take over `/uf/*`**.
3. **Two subtle platform-side pitfalls** —
   ① the platform's prefix matching has **no "longest wins"**: a shorter `/myplugin-api` **swallows** `/myplugin-api/viewer/...` ⇒ the viewer proxy must live **inside the existing router's dispatch**;
   ② WS routes register **exact paths**, while the plugin's WS paths contain **dynamic segments** ⇒ they can only be **registered lazily per file** (seed on file open, de-duplicate with a Map, dispose them together).

## 5. Known limitations (recorded honestly)

- **Screenshots / PDF (`compile_svg` / `lint` / `screenshot` / `print_pdf`) are unavailable** — and this is **not** the glibc problem: the instance has **no browser**, and a headless Chromium would add **+200–400 MB** against a per-instance memory quota. It is an **environment** decision, not something the plugin can fix;
- **One dependency is only a *devDependency* upstream** — it resolves in production solely because the package manager hoists it into a shared directory. A clean install could remove it; declaring it properly is the fix;
- The WS layer for the worktree scenario registers only **file-level** paths;
- This is a **fork**: upstream updates have to be merged yourself.
- ✅ *Corrected from an earlier edition of this file:* it used to say "the plugin's **worker side still uses TCP**". That is **no longer true**. The worker's IPC shims had been **silently dead** — the defect fixed in the `0.2.24` round ([PLUGIN-PORTING.md](../../PLUGIN-PORTING.md) §4.5–§4.6). In socket mode the host hands the worker a **synthetic origin** (`http://unix`) and the shims route anything addressed to it over the unix socket, while every other URL is still passed to the original implementation.

## 6. How to verify (without touching production)

1. **Dependencies and build**: install dependencies → build (incremental, ~5–16 s);
2. **Regression**: run the plugin's own integration smoke suite (this plugin has **18 items**: create / status / import / export / screenshot / print / assets / worktree lifecycle…) — proving the change **did not break the original functionality**;
3. **Socket check on a real host**: put the build output in an **isolated temporary directory** (point native dependencies at the existing installation with read-only symlinks); after starting, confirm
   `listening on unix:…sock`, that `GET /` returns **200**, and that the data routes are reachable; **also run a TCP control case**;
4. **Clean up the temporary artefacts**.

> ⚠️ **unix sockets cannot be verified on Windows** (`AF_UNIX` gives `EACCES` directly, reproducible with plain `node:net` as well) — this is a **platform limitation, not a code problem**, and **it must be verified on Linux**.

---

## 7. Thanks again

- **The plugin itself**: [`dream-num/dsh-univer-office`](https://github.com/dream-num/dsh-univer-office) · **Apache-2.0** · **thanks to the author and the Univer community**.
- The patch and new modules in this directory are likewise offered under **Apache-2.0**, so they stay consistent with upstream and are easy to merge back.
- If upstream wants it, this patch can be taken as-is — it is designed so that **the default behaviour does not change**.
