> **English (primary, this file)** ｜ **[中文文档](security.zh-CN.md)**

[← Back to README](../README.md)

# Security model

| Surface | Measure |
|---|---|
| Sessions | Opaque random tokens, only a SHA-256 hash stored; cookie `HttpOnly` + `SameSite`, plus `Secure` under HTTPS |
| Passwords | Salted scrypt hashes, compared in constant time |
| Secrets | Per-user API keys are stored AES-256-GCM encrypted; the master key comes from env or `<dataRoot>/secret.key` (0600) |
| Paths | Lexical containment checks plus per-segment rejection of symlink components |
| Isolation layers | Soft → OS-account hard isolation (dedicated uid + `setpriv`) → port guard |
| Same-host bypass | Port guard: by client uid, only the orchestrator is allowed, blocking other same-host accounts from connecting directly to instance loopback ports |
| Egress | Instance-side guard: cloud metadata endpoints, instances prevented from reaching the host, outbound observation |
| Requests into instances | The proxy strips `Origin` / `Referer` / `Sec-Fetch-*` / `X-Forwarded-For` and rewrites `Host` to loopback |
| Instance environment | The child process env is rebuilt from an allowlist; platform secrets never enter an instance |
| Uploads | Two-phase zip replacement plus symlink / zip-bomb protection; tiered scanning (P0 blocks / P1 records) |
| Audit | Sensitive actions are written to `audit_log` |

## Notes on the design

- **Isolation is a kernel boundary, not a file-permission convention.** Each user gets a deterministic uid and the instance starts de-privileged under it.
- **Guards fail loud rather than degrading silently.** Where the host cannot support the port guard, enabling it makes the service refuse to start — there is no quiet fallback.
- **The platform never stores a usable plaintext secret.** API keys are encrypted at rest, and the API that reports on them never returns the key itself.
