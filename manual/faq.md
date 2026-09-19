> **English (primary, this file)** ｜ **[中文文档](faq.zh-CN.md)**

[← Back to README](../README.md)

# FAQ

<details>
<summary><b>The DSH chat interface will not open after deployment (the admin console works)</b></summary>

**This is expected — the chat interface requires one host per user.** Without a domain the platform itself (login / approval / admin console / desktop / API) works, but DSH's SPA uses absolute paths ⇒ a pure sub-path cannot open it.

Three ways forward: ① your own domain plus a wildcard certificate (recommended, and the only route to HTTPS); ② a wildcard DNS service as a stopgap (`--domain <IP>.nip.io`, HTTP only); ③ skip it for now and just smoke-test login / approval / desktop. See [About domains](installation.md#about-domains-when-one-is-mandatory-and-what-to-do-without-one).
</details>

<details>
<summary><b>The service will not start and the log says <code>spawn dsh ENOENT</code></b></summary>

`DSH_AI1NET_DSH_BIN` must be an **absolute path** (the output of `which dsh`) — systemd's PATH is minimal, so plain `dsh` usually is not found.
</details>

<details>
<summary><b>An instance reports <code>no sandbox backend is usable</code> / tools are denied</b></summary>

Usually a mismatch between the isolation mode and the kernel's capabilities. Get it running with `--isolation soft` first, then harden item by item; account-level hard isolation needs `useradd` + `setpriv` + root.
</details>

<details>
<summary><b>The service refuses to start once <code>PORT_GUARD</code> is enabled</b></summary>

The port guard depends on iptables owner-match, and unsupported hosts **fail loud** (by design). Turn it off to get running, confirm the host supports it, then enable it.
</details>

<details>
<summary><b>502 / an instance is unresponsive</b></summary>

Check in order: `systemctl status dsh_ai1net` → `journalctl -u dsh_ai1net -n 100` → whether the instance is running under "Service management" in the admin console → the nginx `error_log`. Repeated restarts usually mean a plugin is incompatible with the current DSH version; disable it under "Feature management".
</details>

<details>
<summary><b>I changed a plugin package but the instance shows no change</b></summary>

The client bundle is loaded when an instance starts ⇒ **you must restart the instance after changing it**. The platform restarts it proactively after enabling a plugin; manual changes need a manual stop.
</details>
