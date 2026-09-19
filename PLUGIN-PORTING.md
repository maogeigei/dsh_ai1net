> **English (primary, this file)** ｜ **[中文文档](PLUGIN-PORTING.zh-CN.md)**

# Making an open-source plugin work on a multi-tenant platform

> For **DSH plugin authors** and **maintainers of self-hosted platforms**.
> It answers one question: **why do so many plugins run fine locally and break completely once hosted**, and **exactly what to change**.
> Everything is grounded in one real case, **`dsh-univer-office`** (a 41 MB online spreadsheet plugin) — it went the whole way through "static pre-check passes → completely unusable on the platform → **six follow-up rounds** → ported → regression green". The first fix is almost never the last one; §4.5 lists all of them.

---

## 0. The conclusion first

| Symptom | Root-cause class | Fix | Can platform configuration work around it? |
|---|---|---|---|
| The plugin UI opens but data/charts never load | The address handed to the browser is an **absolute URL** | Make it a **same-origin relative path** | ❌ No — the plugin must change |
| The plugin's internal service never starts / health check times out | Internal communication over **TCP loopback** | Switch to a **unix domain socket** or stdio | ❌ No (the isolation layer exists precisely for this) |
| The instance **crashes and restarts repeatedly** after installing the plugin | **Version incompatibility** with the platform's bundled `@deepseek-ai/*` | Align the dependency range / exported symbols | ❌ No |
| One plugin eats a sixth of the instance's memory | A **heavy dependency statically imported at the entry point** | Switch to `await import()` **lazy loading** | ❌ No |
| Tenants interfere with each other | A **self-created listening port** | Reuse the host's single entry point | ❌ No |
| An operation **reports an error yet the effect really happened** (or the internal service dies mid-request) | A **native binding linked against a newer glibc than the host** | Ship a **bundled glibc runtime** and start that process through it | ❌ No — the plugin must change (or the base image must) |
| The plugin "loads" but its UI never appears | A UI package in `dsh.client.inject` that is **not delivered in that role** | Remove it from `inject` | ❌ No — the plugin must change |

> **Passing every static pre-check is not the finish line.** This plugin passed all of them and still needed **six follow-up rounds** (0.2.24 → 0.2.29) on top of the first port: a bundling-order defect that silently disabled the plugin's own socket shims; a native binding needing a newer glibc than the host; a crash in the *second* process that surfaced as **false errors on writes**; a client-side `inject` that could never be satisfied; a bundled glibc runtime that unblocked native Office import/export; and finally **widening the peer ranges ahead of a platform upgrade**. §4.5 has them round by round.

**The one-line criterion:**

> **Can every outward interaction of the plugin go through "the one entry point the platform already has"?**
> That is — **on the browser side, relative paths only; on the instance side, no dependency on a network service on local loopback.**

---

## 1. How a hosting platform differs from "running locally"

Every assumption a plugin developer makes locally is **false** on a hosting platform:

| Local assumption | The hosting platform's reality |
|---|---|
| "`127.0.0.1` is my machine" | `127.0.0.1` on the server side = **the server**; `127.0.0.1` in the browser = **the user's own computer** — two different places |
| "The web page and the data service are on one machine, connect freely" | The instance process uid is constrained by the **egress guard**; it may not even reach a child process it spawned itself (see §4.1) |
| "Pick any port; if it collides, pick another" | Multi-tenant **shared host**: ports are a shared resource, and port drift plus cross-tenant reachability are real risks |
| "HTTP is fine" | Users visit an **HTTPS domain**; an HTTP resource inside an HTTPS page is **hard-blocked** by the browser (mixed content) |
| "The process is mine, memory is free" | Each user instance has a **memory quota**; a single plugin can bring the whole instance down |
| "Installing a plugin is just a directory" | The platform **pre-checks, enables, isolates and rolls back** plugins; an incompatible one drags the instance down |
| "The host has everything my dependencies need" | The base image is **fixed**; a prebuilt native addon may need a *newer* system library than the host ships (§2 H8) |

---

## 2. Eight failure modes (self-check before you publish)

### H1 · Hard-coded loopback service address

```js
// ❌ the in-instance service address is hard-coded
const gateway = `http://127.0.0.1:${port}`
```

**Symptom**: the host process cannot reach the child process it spawned itself (the health check always times out).
**Why**: the hosting platform rejects **outbound connections** from the instance uid range to `127.0.0.0/8` (only outbound initiation is rejected; replies are unaffected — otherwise the instance would be entirely unusable).
**Severity**: 🟡 warning (if it is internal only, switch to a socket; if it also goes to the browser → upgrade to 🔴)

### H2 · An absolute URL in the client bundle 🔴 **blocking**

```js
// ❌ this URL gets put into an iframe src and makes **the user's browser** connect to it
viewerUrl = `${gateway}/?file=${fileKey}`
```

**Symptom**: the page frame renders, but the content stays blank / spins forever.
**Why**: once a URL is handed to the browser it is **guaranteed to fail**: cross-machine (`127.0.0.1` means the user's computer) plus mixed content being blocked.
**The key point**: **the platform has no remedy whatsoever** — not configuration, not a reverse proxy, and certainly not "just use the server IP" (see §4.2).
**Criterion**: scan the **client-side artefacts only**; a literal `http://` hit counts as "will be handed to the browser" → **reject the upload**.

### H3 · Creating your own network listener

Scan the arguments of `listen(` / `createServer`:
- listening on a unix socket / stdio → ✅ good
- listening on loopback TCP → 🟡 a human must confirm whether it is the single entry point (if it is, handle it as H1/H2)

### H4 · The browser address is assembled by the client

The server returns a **path** (relative) and the client assembles an absolute address — same failure.
**Criterion**: any address handed to the browser **must be produced by the host and be relative**.

### H5 · Incompatible with the platform's bundled packages → crash loop

A hosting platform **bundles** the DSH-related packages in a fixed location. When a plugin declares or imports them, two conditions must both hold:

| Criterion | Explanation |
|---|---|
| **A. Dependency range** (semver, **default semantics**, no `includePrerelease`) | The `@deepseek-ai/*` range the plugin declares must **accept** the platform's bundled version. Declaring `>=0.1.1-rc.1 <0.1.2` while the platform is `0.1.2-rc.1` ⇒ not satisfied ⇒ the package manager installs the plugin's own **older** copy → conflict with the platform package |
| **B. Exported symbols** (runtime truth) | When the plugin does `import { X } from '@deepseek-ai/Y'`, `X` must exist in the **actual runtime exports** of the platform package Y. Obtain them via `await import()` then `Object.keys()` — more reliable than parsing `.d.ts` |

**Why default semantics are mandatory**: the package manager's real install decision *is* default semantics. Passing `includePrerelease` **misjudges** these bugs as satisfied and misses them.
**The easiest one to miss**: a platform API call hidden inside a **transitive dependency** (not inside the tgz you built) — static scanning cannot see it, so you must install and then re-scan `node_modules`.

> ⚠️ **A peer range is a forward-looking declaration, not a statement about today.** When the platform you run on is about to move to a new version line, the range must be widened **before** the upgrade — otherwise the pre-check rejects a plugin that has not changed at all. Widening a range is a **declaration-only** change (zero behaviour change on the version actually running), which is exactly what makes it a cheap, reversible thing to do *early* — and an expensive thing to remember *late*.

> 📌 **For platform builders**: a pre-check gate that applies *strict* default semantics produces false positives when the platform itself is a prerelease — a measurement over a 300-plugin sample found roughly a **39% false-positive rate**, including plugins that were installed and running fine. The workable design is **"default semantics first; if unsatisfied, re-check with prerelease semantics and *count* rather than block"**. That softening changes what the **gate blocks**; it does not change the **package manager's** own install decision, which is still default semantics.

**Symptom**: once installed the instance reports `plugin tree failed to load` → **crash loop** (it dies on every start, and the platform's crash restart only cuts losses, it does not disable anything).

### H6 · Heavy dependencies statically imported at the entry point

| Plugin | `rss` increase after loading |
|---|---|
| A heavy spreadsheet plugin | **+65.1 MiB** |
| Its indirect dependency (an embedded database) | +7.8 MiB |
| Three in-house lightweight plugins | **0.0 MiB** |
| A browser-automation library (**entry imported only, browser never launched**) | **0.0 MiB** |

**Conclusion**: **cost is decided by *what* is installed, not *how many*** — one heavy plugin is worth infinitely many lightweight ones.
**What to do**: for heavyweights such as native bindings, engines and browsers, switch to `await import()` and load them only when actually used.

---

### H7 · The client half "hangs silently": `inject` is never satisfied 🔴 **no error, no log**

**Symptom**: the server side is perfectly healthy (tools callable, data genuinely written to disk), but **there is nothing in the browser** — no preview UI, no error in the console, no trace in the logs.

**Mechanism**: the client plugin's `package.json` lists some **UI package** under `dsh.client.inject`, but that package is **never delivered in that role's page** (for example because the platform's role patch disables it) ⇒ cordis's `inject waiting` **is never satisfied** ⇒ **the client fiber is suspended forever ⇒ `apply()` never runs**.

**Criterion (the general diagnostic technique)**: take the instance page → parse `__DSH_BOOT__` → compute the **set difference** between every `inject` line and **the set of client plugins actually delivered in the page**;
**a non-empty difference = that client fiber hangs forever**. An A/B comparison makes it obvious: the same plugin under different roles is missing exactly those "disabled packages".

**Fix**: **remove** from `dsh.client.inject` any package that is not guaranteed to exist in the target role.

> ⚠️ **Hard rule**: a third-party client plugin **must not put "official UI packages" into `dsh.client.inject`** unless that package is confirmed to always exist in the **target role** —
> the platform's role patch disables these: `dsh-client-ui-settings-models` / `-settings-plugins` / `-settings-plugin-inventory` / `-cordis` / `dsh-client-hmr` / `dsh-host-directory-picker-auto`.
> **A typical case**: a plugin listed `@deepseek-ai/dsh-client-runtime` — that package **does not exist at all** in the current dsh version ⇒ its browser half hangs silently in exactly the same way.

> 📌 **What users should expect**: such plugins **do not register `tool.*.toolview`** ⇒ **tool cards look no different**; the only three places where content shows up are the session **turn-end card**, the **dock** above the input box, and the full-screen review overlay.
> **Old turns are not re-rendered** — after a hard refresh you must **run a new turn** that contains the tool call.

### H8 · A native binding linked against a newer glibc than the host

**Symptom A — the process dies *after* doing the work.** An operation returns an error (`Collaboration HTTP request failed`, `ECONNRESET`, a health check that times out) **yet the effect really happened** — the data is on disk, the changeset was committed. That combination is the tell: the process was killed mid-request, *after* the work.
**Symptom B — an operation takes the whole process down with an *uncaught* error** (it is not a degradable one): `Error: … version 'GLIBC_2.35' not found`.

**Why**: prebuilt native addons (Rust/Node) are linked against a **minimum glibc**. On an older host `require()` throws; and if the library is loaded while building a projection, the crash takes the process with it.
**⚠️ More than one process can hit it** — do **not** assume the other one is read-only (see §4.6 ③). Attach the fix to **every** build that loads the dependency, and verify by **counting crashes**, not by reading code.

**Detection (before you ship)** — compare what the addon needs with what the host has:

```sh
ldd --version | head -1
objdump -T <binding>.node | grep -oE 'GLIBC_[0-9.]+' | sort -u | tail
```

**Fix — two options**

- **(a) Platform level**: move to a base image whose glibc is new enough. An infrastructure decision, with blast radius over **every** tenant.
- **(b) Plugin level**: **ship the runtime you need** and start the affected processes through the loader that comes with it —
  `<runtime>/ld-linux-x86-64.so.2 --library-path <runtime>/lib:/usr/lib64:/lib64 <node> <entry>` —
  auto-detected, with an env override, so that **when the runtime is absent the behaviour is byte-for-byte the old one** (zero regression; and deleting the directory is a complete rollback).

**⚠️ Two traps when shipping a glibc**:
1. Ship the **whole** set — a newer glibc merges `libpthread` into `libc`, so handing over only `libc`/`libm` while still using the host's `/lib64` collides on `GLIBC_PRIVATE` / `__libc_siglongjmp`.
2. Put it somewhere the sandbox can actually see — if `/usr` is mounted read-only into the instance, `/usr/local` is visible and much else is not.

⚠️ **Do not redistribute such a runtime with an open-source export** if it is LGPL and server-only — it is an environment asset, not part of the plugin.

**A fallback may already exist**: some libraries expose an off switch (for example an engine config selecting a pure-JS implementation). If so, gate it on **"the native binding genuinely failed to load"** rather than hard-coding it — then a host upgrade restores the fast path with **no code change**.

## 3. Six porting rules (R-a to R-f)

> Satisfy these six and the plugin runs on any hosting platform that is "single entry point + multi-tenant + HTTPS".

| # | Rule | How | Why |
|---|---|---|---|
| **R-a** | **One outward entry point** | Everything the browser can reach hangs off the host's webServer, under a **same-origin relative path** (e.g. `/myplugin-api/**`) | Reuses the platform's reverse proxy ⇒ **zero new exposed surface** |
| **R-b** | **Internal communication over IPC** | Use a **unix domain socket** or **stdio**, **not TCP loopback** | Never touches the IP layer ⇒ the egress guard cannot see it; **no port conflicts** by construction |
| **R-c** | **No new listening ports** | Need more processes? Use a socket / stdio. If TCP is genuinely required, it **must** bind `127.0.0.1` with the port passed in via env | On a shared multi-tenant host, a port = cross-tenant risk plus drift |
| **R-d** | **Lazy-load heavy dependencies** | Native bindings, engines, browsers and large parsers move to `await import()` | Measured: +65 MiB down to 0 MiB (when unused) |
| **R-e** | **Every browser-bound address is relative** | The server returns paths only; the client never assembles an absolute address | Absolute addresses are guaranteed to fail on a hosting platform |
| **R-f** | **Fail loud — never silently degrade** | A compatibility shim that cannot do its job must throw or log **at the point of failure**; 🚫 never `return` quietly into the "normal" path. Make an unresolvable dependency an explicit error, not a silent skip | A silently dead shim is indistinguishable from a *generic* upstream bug: this case spent rounds chasing a generic `COLLABORATION_UNAVAILABLE` while its own shim had never worked (§4.6 ①) |

**Compatibility (H5) is a release gate of its own**: the `@deepseek-ai/*` dependency range must accept the platform version under **default semantics**, and every imported symbol must genuinely exist in the platform package.

---

## 4. Case study: porting `dsh-univer-office`

> 📦 **The artefacts for this case** → [`examples/dsh-univer-office/`](examples/dsh-univer-office/)
> (the porting patch + new modules + companion skill, with the upstream baseline and how to apply it)
> ⚠️ The **bundled glibc runtime is deliberately not included** — it is an environment asset (see §4.9).
> 🙏 The original plugin is open-sourced by **[dream-num](https://github.com/dream-num)** (**Apache-2.0**) — **thanks to the author**.

### 4.1 The **two independent obstacles** behind the symptom

The plugin **passed every static pre-check** (dependency range ✅, exported symbols ✅) yet was completely unusable on the platform. The cause was two **mutually independent** obstacles — **either one alone is enough to break it**:

| Obstacle | Mechanism | Measured evidence |
|---|---|---|
| **① Host → Gateway** | The gateway is `spawn`ed by the host and **inherits the same uid**; the platform's egress guard answers the instance uid range → `127.0.0.0/8` with `reject with tcp reset` ⇒ **the host cannot reach the gateway it started itself** | Creating a document always reported `bundled Gateway did not become ready within 10000ms` |
| **② Browser → Viewer** | The source **hard-codes** `gateway = http://127.0.0.1:${port}` and `viewerUrl = ${gateway}/?file=…`, and the client uses it as an **iframe src** ⇒ the browser goes looking for the Viewer on **the user's own computer** at `127.0.0.1` | `grep -o "viewerUrl: [^,]*" lib/index.js` |

**⇒ Even unblocking the loopback in ① would not help** (② blocks on the browser side). **The plugin has to change.**

> ⚠️ Passing the pre-check told us nothing about the **two further obstacles hidden behind these two** — §4.5 rounds 2 and 3 are exactly that. **A green pre-check means "nothing statically detectable is wrong", not "it works".**

### 4.2 Why "just use the server IP" does not work

It is the first idea most people have, and the wrongest:

1. The egress guard's block list **already contains the server's own IP** — switching to it is rejected just the same;
2. On a shared multi-tenant host, **binding a port leaks across tenants**;
3. An HTTP iframe inside an HTTPS page is **hard-blocked by the browser**.

**The right answer is not "a different address" but "a different path".**

### 4.3 The change list (a realistic scale reference)

**New modules**

| Module | Purpose |
|---|---|
| `shared/gateway-socket` | Parses `UNIVER_DSH_GATEWAY_SOCKET` (a path value or `auto`) and defines the `unix:<path>` endpoint identity |
| `shared/unix-http` | A minimal **HTTP over unix socket** client (`status` / `headers` / `text` / `json` / `arrayBuffer` / `signal`) — **zero new dependencies** |
| `shared/gateway-request` | The **unified transport entry point** `requestGateway(endpoint, path, init)`: picks socket or TCP automatically from the endpoint prefix |
| `host/webServer/viewer-proxy` | A **same-origin reverse proxy**: HTTP (streaming, stripping hop-by-hop headers) plus **WebSocket upgrade forwarding** |
| `shared/viewer-paths` | Browser-side path constants (kept independent of webServer to avoid a reverse dependency) |

**Changed files**: the gateway listener gains unix socket support (**TCP default behaviour unchanged**), the launcher passes the socket path to the child through env, endpoints are tagged by transport (`http://127.0.0.1:<port>` or `unix:<path>`), health checks and probes support sockets, client call sites all go through `requestGateway`, the webServer registers the viewer proxy and data-plane routes, and **`viewerUrl` becomes a relative path**.

### 4.4 Three key design decisions (all learned the hard way)

**① The socket is an *optional transport*, not a replacement for TCP**

Enabled by env (either set a path, or set `auto` to derive a process-level path under a private temporary directory); **leave it unset and upstream behaviour is preserved exactly**.
The payoff: **upstream-friendly — the default behaviour is unchanged, so it can be merged safely**; rolling back means simply **deleting that env**.

**② Only two proxy rules**

Because **all data-plane requests** of this plugin live under one prefix (WebSocket included):

```
/uf/**                  → forward to the gateway (HTTP + WS upgrade)
/<plugin>-api/viewer/** → forward to the gateway's / and /assets/** (page + static assets)
```

⚠️ **The critical point**: once the Viewer page has loaded it requests `/uf/*` **using absolute paths**, so the proxy **must take over `/uf/*`** — otherwise the page opens but the data never arrives (the classic "half-working" state).

**③ Two subtle platform-side pitfalls**

| Pitfall | Symptom | Fix |
|---|---|---|
| **Prefix matching has no "longest wins"** | A shorter `/myplugin-api` **swallows** `/myplugin-api/viewer/...`; registering it separately gets hijacked by a 404 | The viewer proxy must live **inside the existing router's dispatch**; only non-conflicting prefixes get registered separately |
| **WS routes register exact paths** | The plugin's WS paths contain **dynamic segments** (`/uf/<enc>[/worktrees/<id>]/…`) ⇒ they cannot be registered all at once | **Register lazily per file**: seed on file open, de-duplicate with a Map, dispose them together |

### 4.5 The six follow-up rounds the first port was not enough for

> The first port shipped as **0.2.15**. What follows is **six more rounds** — five driven by production findings (each fix uncovered the next obstacle) and the last one by a platform upgrade.
> Builds **0.2.16 – 0.2.23** carried the same silent shim defect described in the second row below.

| # | What the user saw | Root cause | How it was closed | Shipped |
|---|---|---|---|---|
| **1** | The Viewer page opened but the content never loaded; creating a document always timed out | **Two independent obstacles** — the egress guard rejecting host → gateway loopback, and a hard-coded absolute `viewerUrl` handed to the browser (§4.1) | unix socket transport + same-origin viewer proxy + relative paths | 0.2.15 |
| **2** | Content operations all failed with a **generic** `COLLABORATION_UNAVAILABLE`, while `new` / `status` / `worktree` kept working | **Two *further* independent causes — and the second only became visible once the first was fixed**: ① the plugin's **own IPC shims were silently dead** (§4.6 ①); ② a native binding needing **glibc ≥ 2.35** on a 2.32 host crashed the process while building a projection (§2 H8) | ① install the shims **above** the top-level `await`, and make the failure loud; ② add a host-compat layer that selects the pure-JS engine **only when the binding genuinely cannot load** | **0.2.24** |
| **3** | Writes returned `Collaboration HTTP request failed` — **but the data was saved** | The **gateway** *also* builds a projection when committing a changeset ⇒ the same crash ⇒ the gateway process dies mid-request ⇒ the client reads a reset ⇒ a **false error**. This **overturned** the round-1 conclusion that the gateway needed no patch (§4.6 ③) | Attach the host-compat layer to the **gateway** build as well; fix the CJS `import.meta` trap (§4.6 ②) | **0.2.25** |
| **4** | "Can the AI produce a docx/xlsx for me?" — it could not | Not a defect: the instance ships **no Office library**. But **"no library" ≠ "cannot generate"** — OOXML is zip + XML, and the Python standard library is enough | Ship a **zero-dependency** Office-generation skill inside the plugin (⚠️ the skill manifest must be updated too — §4.6 ④) | **0.2.26** |
| **5** | The server half was perfectly healthy, yet **nothing appeared in the browser** — no error, no log | `dsh.client.inject` listed a UI package that the platform's role patch disables ⇒ the client fiber waits forever (§2 H7) | Remove that package from `inject` | **0.2.27** |
| **6** | External xlsx/docx → Univer **import**, and `.univer` → Office **export**, still impossible | Native bindings linked against **glibc ≥ 2.35** on a 2.32 host (§2 H8) | Ship a **bundled glibc 2.35 runtime** (5 MB) and launch both processes through it — **zero platform changes**, delete-the-directory rollback | **0.2.28** |
| **7** | *Nothing broke.* The platform itself was about to be upgraded to a new dsh line | Not a defect: the plugin's **seven** peer ranges on `@deepseek-ai/dsh-*` were pinned to the versions running at the time ⇒ the **next** platform version would be judged **incompatible** and the plugin refused | **Widen the declaration before the move**: append the incoming version to all seven ranges. Declaration-only — **zero behaviour change** on the version actually running | **0.2.29** |

**The shape of the lesson**: rows 2–6 are **not** the same bug recurring — they are four *different* failure classes (a bundler artefact, a system-library mismatch, a process-lifetime problem, a dependency-injection contract) **stacked behind one another**; each was invisible until the one in front of it was removed. Row 7 is a different kind again: **not a defect, but a maintenance obligation** — a plugin that declares its compatibility narrowly will be *correctly* rejected the moment the platform moves, and the only way to avoid that is to widen the declaration **before** the platform moves.

### 4.6 Four traps that each cost a round

**① The bundler silently disabled the plugin's own shims**

The plugin installed its IPC shims (`fetch` / `http.request` / `WebSocket`) at **module scope**, and called `await main()` at **top level**. The bundler **downgraded a module-level `const` to a function-scoped `var` and hoisted it**, so by the time `main()` ran the shim read `undefined` ⇒ `'http://unix/…'.startsWith(undefined)` was **always false** ⇒ the shim quietly handed the request back to the **real** `fetch`, which then dialled a host literally named `unix`.

⇒ The only visible symptom was a **generic** error, and **every build from the first one was affected** — the shim logic itself was correct; the **bundling order** had defeated it.

**Fix**: install the shims **above** the top-level `await`; read the origin from a **function-local** expression (defence in depth against re-ordering); accept both `http.request` signatures; and **make the "cannot resolve the WS package" case loud** — it used to be swallowed silently, which is precisely what hid the whole thing.

**② `import.meta` is `{}` in a CJS artefact**

In a **CJS** build, esbuild downgrades `import.meta` to an empty object (`var import_meta = {}`) ⇒ `createRequire(import.meta.url)` throws `ERR_INVALID_ARG_VALUE` ⇒ **the process crashes on startup**.
**Fix**: `typeof __filename === 'string' ? __filename : import.meta.url`, and in a CJS artefact point the shim's own import at the package's **CJS** entry (an ESM entry that locates a native binding through `import.meta.url` cannot work there).
⇒ **Exercise both artefacts.** "It works in the ESM build" proves nothing about the CJS one.

**③ The crash is not where you think it is**

Round 1 concluded "the gateway only reads snapshots, builds no projection, and needs no patch". **That was wrong**: the gateway builds a workbook projection **when committing a changeset**, so a *different* process crashed on the *same* native binding — and because it died mid-request, the client saw a connection reset and reported **failure for an operation that had actually succeeded**.

⇒ **Rule**: when a native dependency is involved, attach the fix to **every** build that loads it, and verify by **counting crashes** — not by reading the code. A "false error" is the signature of a process that died *after* doing the work.

**④ Skills are registered from an explicit manifest**

A plugin's skills are **not** discovered by scanning a directory. They are listed in the host's skill manifest (`src/host/skills/plugin.ts` → `DEFINITIONS`). Dropping a skill folder into the package **does nothing** — you must add it to the manifest **and rebuild** the host half.

⇒ Same family as H7: **the artefact is present, but nothing wires it up.** Whenever a capability "isn't working", first ask whether it was ever *registered* — not whether the file exists.

Also fixed along the way (caught by a **strict** parser, not by the code that wrote the file): the generated OOXML table was missing its **required** `w:tblGrid` child element — `python-docx` refuses to open such a file. **Generate a format, then read it back with an independent strict parser.**

### 4.7 Locating an in-instance fault without touching production

> A reusable recipe for "**the service is up, but content operations fail**". Everything happens under `/tmp/<name>/` — **no instance, no tenant data**. Clean up afterwards.

1. **Start your own gateway** (socket mode) from the **shipped artefacts**, with an isolated env:
   `env -i HOME=<tmp> PATH=/usr/local/bin:/usr/bin:/bin UNIVER_COLLAB_GATEWAY_SOCKET=<tmp>/gw.sock … setsid nohup node <pkg>/artifacts/gateway.cjs > <tmp>/gw.log 2>&1 &`
   If it comes up (`listening on unix:…`) and `curl --unix-socket <sock> http://localhost/` returns **200** with the page marker, **the gateway side is fine**.
2. **Hand-craft the worker request** as the **tenant uid** (`setpriv --reuid=<uid> --regid=<uid> --clear-groups`), with the gateway endpoint identity in the payload and a `fileKey` that is **`base64url(absolute path)` with the `=` stripped**.
3. **Watch the shim trace** (enable the plugin's debug flag): each step of the chain should appear (`fetch-called → fetch-result status=… / ws-construct / http-request host=…`). **If it stops right after the first line, the shim returned early** — that is exactly how trap ① was caught.
4. **Fallback criterion**: replace the gateway with a **fake socket server that answers 200 and logs every request**. If the fake server receives **nothing** while the worker still errors, the fault is on the **worker** side — the request never left.
5. **Clean up** — and remember that starting an instance is a side effect of traffic: some setups will bring the instance back up on any request carrying its host name (a 401 still counts).

⚠️ Two more gotchas that made this harder than it needed to be: a worker running out of a temporary directory **cannot resolve hoisted dependencies** (point the module resolution path at the package manager's hoist directory), and a **half-finished** env will produce a `Cannot find module` that looks like a broken plugin when the real cause is a missing path.

### 4.8 How to verify (without touching production)

1. **Dependencies and build**: install dependencies → build (incremental, ~5–16 s);
2. **Regression**: run the plugin's own integration smoke suite (this plugin has **18 items**: create / status / import / export / screenshot / print / assets / worktree lifecycle…) — **proving the change did not break the original functionality**;
3. **Socket check on a real host**: put the build output in an **isolated temporary directory** (point native dependencies at the existing installation with read-only symlinks); after starting, confirm `listening on unix:…sock`, that `GET /` returns **200** with the page marker present, and that the data routes are reachable (a 4xx means the route works and only the parameters are wrong); **also run a TCP control case**;
4. **Clean up the temporary artefacts**.

> ⚠️ **unix sockets cannot be verified on Windows** (`AF_UNIX` gives `EACCES` directly, reproducible with plain `node:net` as well) — this is a **platform limitation, not a code problem**. **It must be verified on Linux.**

### 4.9 Known limitations (recorded honestly)

- **Screenshots / PDF (`compile_svg` / `lint` / `screenshot` / `print_pdf`) are still unavailable** — and it is **not** a glibc problem: the instance has **no browser**, and a headless Chromium would add **+200–400 MB** against a per-instance memory quota. This is an **environment** decision (ship a browser, or accept the gap); the plugin cannot fix it.
- **One dependency is only a *devDependency* upstream.** It resolves in production solely because the package manager hoists it into a shared directory. That is a standing fragility — a clean install could remove it. Declaring it properly is the fix.
- The WS layer for the worktree scenario registers only **file-level** paths.
- This is a **fork**: upstream updates have to be merged (see §7).
- ⚠️ **The bundled glibc runtime is not part of the artefacts in `examples/`** — it is an environment asset (LGPL, server-only), and it is deliberately not redistributed here.
- ✅ *Corrected from the first edition of this document*: "the worker side still uses TCP" is **no longer true**. The worker's shims were the very defect fixed in round 2 (§4.5); once they worked, the worker reaches the gateway over the socket as well.

### 4.10 Rollback

- **At the code level**: leave the socket env unset ⇒ back to the original TCP behaviour immediately;
- **The glibc runtime**: **delete the runtime directory** ⇒ every process returns to the plain `<node> <entry>` launch. No code change, no platform restart;
- **At the platform level**: rolling the version in the candidate pool back to the upstream release retires the whole thing.

---

## 5. The other half the platform must provide

Porting the plugin is not enough — the platform must also leave the interfaces open, or the work is wasted:

| Platform capability | Requirement |
|---|---|
| **env pass-through** | Platform → instance → plugin child process, so configuration such as "the socket path" or "the runtime directory" reaches the plugin |
| **Same-origin reverse proxy** | Forward the plugin's path prefix to the in-instance service, **support WebSocket upgrade**, set `Host` / `X-Forwarded-*` correctly, and **not buffer** streaming responses |
| **Memory budgeting** | **Annotate the loading cost** of every plugin (measured `rss` increase) and do the **estimate and interception before enabling** (require confirmation beyond the per-instance cap) |
| **Compatibility pre-check** | On import, decide "dependency range + exported symbols"; when incompatible, **reject by default** and show the per-item evidence back to the admin. ⚠️ Apply **default semantics first, then re-check with prerelease semantics and count instead of blocking** — on a prerelease platform strict semantics produce large false-positive rates (§2 H5) |
| **Safe enable/disable** | After enabling, **probe**; on failure **roll back to a snapshot**; keep a per-plugin **isolation flag** (disable the incompatible plugin alone instead of the whole instance) |
| **Hostability and cost as evaluation dimensions** | "Compatible" ≠ "usable": add **hostability** (does every outward interaction go through the single entry point?) and **resource cost** to the plugin-review criteria, not just dependency resolution |
| **A place for a plugin to ship a runtime** | If a plugin may bring its own runtime (a newer glibc, a JDK, a browser), leave it a path the sandbox can **see** — with `/usr` mounted read-only, `/usr/local` works and much else does not |
| **The boundaries of the isolation model** | Egress guard (instances may not connect out to loopback / metadata endpoints), the `/etc` allowlist, read-only platform policy files — a plugin must not assume these do not exist |

### 5.1 What this rollout exposed on the platform side

Rolling a plugin out safely turned out to be as much the platform's problem as the plugin's:

| Defect | Why it matters | The fix |
|---|---|---|
| An `async uninstall(...)` was called **without `await` inside a synchronous `try/catch`** | The rejection escapes the `catch` ⇒ **unhandled rejection ⇒ the whole platform process exits** — every tenant is disconnected and every instance stops, and the failing profile is left **half-applied** (that instance then dies on every subsequent start) | `await` it, and add an outer `.catch()` on the route so the same omission cannot kill the process again |
| The removal path passed a package-manager flag that **only exists on the install subcommand** | The disable path could therefore **never** succeed ⇒ it always reached the defect above | Use the flag set the removal subcommand actually accepts — and note that the install side's flag is legitimate, so do not "fix" both |
| **Applying a plugin is a no-op for an already-enabled plugin** | You cannot roll out a new *version* of a live plugin in one step: the platform reports success while nothing changed | Count already-enabled items as targets, or make "update = disable → enable" explicit — and ⚠️ **document it**, or every operator will do it wrong once |
| The task **terminal state is `success`, not `done`** | Any polling loop that waits for `done` spins forever | One name, applied consistently |
| A failed probe can be a **capacity** problem, not a compatibility one | If the instance's heap cannot fit the plugin set, the platform enters its isolation path — which is what triggered the two defects above | Compute the budget from the plugin set (do not hard-code it), and say so in the error message |

⚠️ The discipline that follows: **enabling or disabling a plugin must never be able to take the platform down.** Contain it — per-plugin isolation, rollback to a snapshot, bounded retry — rather than trusting every call site to be written correctly.

---

## 6. Pre-release self-check

```
[ ] No absolute URL on the browser side (grep the client artefacts for literal `http://` / `https://`)
[ ] Every resource address handed to the browser is produced by the host and relative
[ ] Internal process-to-process communication uses a unix socket / stdio, not TCP loopback
[ ] No new listening ports (when genuinely needed, bind 127.0.0.1 with the port passed in via env)
[ ] Heavy dependencies (native bindings / engines / browsers) are lazily loaded via await import()
[ ] The @deepseek-ai/* dependency range accepts the platform's bundled version under "default semantics"
[ ] ...and it will also accept the NEXT platform version — widen the declaration BEFORE the platform
    moves, not after (a declaration-only change, so it is cheap to do early)
[ ] Every imported platform symbol has a runtime export in the platform package (including the transitive layer)
[ ] The measured load memory increase (annotate above 30 MiB / be careful above 60 MiB)
[ ] Every native binding loads on the host as it is — or the plugin ships the runtime it needs and
    launches through it, with the fix attached to EVERY process that loads it (not just the first one)
[ ] No UI package in dsh.client.inject unless it is guaranteed to exist in the target role
[ ] Every compatibility shim is PROVEN to take effect (a shim that silently falls back to the
    "normal" path is worse than no shim at all)
[ ] No error path is silently swallowed: an unresolvable dependency fails loudly
[ ] Adding a skill or asset also updates its explicit manifest, not just the package contents
[ ] Both build flavours (ESM and CJS) were exercised — import.meta is empty in a CJS artefact
[ ] Every generated file format was read back with an independent strict parser
[ ] The bundled regression tests pass, with identical results before and after the change
[ ] There is a way to fall back to the original behaviour when the plugin-specific env is not set
```

---

## 7. A better path: offer the port upstream

A fork is a **long-term cost** (who maintains it, how upstream updates get merged). The better move is to offer the change upstream as an **issue plus a patch**.

**Framing matters a lot**: do not say "please support our platform". Say —

> **"Your architecture can be simpler and safer in containerised / hosted / multi-tenant environments: replacing loopback TCP with a unix socket plus same-origin relative paths removes the assumptions about IPs and ports."**

Framed that way it is a **pure technical win for upstream** (fewer assumptions, fewer ports, safer) — and they will be happy to take it even without a hosting use case of their own.

> ⚠️ **Be selective about *what* you offer upstream.** The unix-socket plus relative-path change is a genuine simplification for anyone. The **bundled-glibc runtime is not** — it is a workaround for one host's base image, and a library that offers a pure-JS fallback should simply be *configured* to use it (§2 H8). Sending an environment workaround upstream gets it rejected, and rightly so.

---

## Appendix · quick self-check commands

```sh
# 1) Any absolute URL in the client artefacts (H2, blocking)
grep -rInoE "https?://[A-Za-z0-9._:/-]+" lib/ dist/ | grep -v "://127\.0\.0\.1" || true
grep -rIn  "127\.0\.0\.1:[0-9]" lib/ dist/ || true

# 2) Any self-created listener (H3)
grep -rInE "\.listen\(|createServer\(" lib/ dist/ | head

# 3) Which platform packages are declared (H5 criterion A)
node -e "const p=require('./package.json');console.log(p.dependencies,p.peerDependencies)"

# 4) Load memory (H6 — measure inside an **isolated cgroup**, never on a production instance)
node --expose-gc -e "const m0=process.memoryUsage().rss;import('./lib/index.js').then(()=>{global.gc();console.log('rss +' + ((process.memoryUsage().rss-m0)/1048576).toFixed(1) + ' MiB')})"

# 5) Native bindings vs the host glibc (H8)
ldd --version | head -1
objdump -T <binding>.node | grep -oE 'GLIBC_[0-9.]+' | sort -u | tail

# 6) Did the CJS artefact erase import.meta? (H8 / §4.6 ②)
grep -rn "import_meta = {}" lib/cjs/ 2>/dev/null | head   # ⇒ anything relying on it will throw
```

---

**Related**: the feature list and deployment options are in [`README.md`](README.md).
