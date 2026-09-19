import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Env var that switches the bundled Gateway from TCP loopback to a unix domain socket.
 *
 * Set it to a concrete path, or to `auto` for a per-process path under the private temp dir.
 * Unset (the default) keeps the original TCP loopback behaviour.
 */
export const GATEWAY_SOCKET_ENV = 'UNIVER_DSH_GATEWAY_SOCKET'

/** Env var the launcher uses to hand the resolved path to the Gateway child process. */
export const GATEWAY_CHILD_SOCKET_ENV = 'UNIVER_COLLAB_GATEWAY_SOCKET'

/**
 * Resolve the unix socket path for the bundled Gateway, or `undefined` to keep TCP loopback.
 *
 * Why this exists: a sandboxed multi-tenant host may reject `connect()` to `127.0.0.0/8` for the
 * tenant uid — and the Gateway is a child of the host process, so it inherits that uid. The host
 * then cannot reach the very Gateway it spawned, even though the child is listening. A unix
 * socket is resolved through the filesystem rather than the network layer, so no egress rule can
 * block it, it needs no port, and nothing is exposed to other tenants.
 */
export function resolveGatewaySocketPath(): string | undefined {
  const raw = process.env[GATEWAY_SOCKET_ENV]
  if (raw === undefined || raw === '') return undefined
  return raw === 'auto'
    ? join(tmpdir(), `dsh-univer-gateway-${String(process.pid)}.sock`)
    : raw
}

/** Socket-transport endpoints are tagged with this prefix: `unix:<path>`. */
export const UNIX_ORIGIN_PREFIX = 'unix:'

/** Tag a socket path as a Gateway endpoint, for callers that exchange endpoints as strings. */
export function unixOrigin(socketPath: string): string {
  return `${UNIX_ORIGIN_PREFIX}${socketPath}`
}

/** Extract the socket path from a `unix:<path>` endpoint, or null for a TCP endpoint. */
export function parseUnixOrigin(origin: string): string | null {
  return origin.startsWith(UNIX_ORIGIN_PREFIX)
    ? origin.slice(UNIX_ORIGIN_PREFIX.length)
    : null
}
