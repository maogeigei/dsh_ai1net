import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { parseUnixOrigin } from '../../shared/gateway-socket.ts'
import { GATEWAY_DATA_PREFIX, VIEWER_PROXY_PREFIX } from '../../shared/viewer-paths.ts'
import type { UniverService } from '../service/univer-service.ts'

export {
  GATEWAY_DATA_PREFIX,
  VIEWER_PAGE_PATH,
  VIEWER_PROXY_PREFIX
} from '../../shared/viewer-paths.ts'

/** Headers that must not be forwarded by a reverse proxy (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/**
 * Serve the bundled Viewer — both its page/static assets and its `/uf` data plane — through the
 * host webserver.
 *
 * Why this exists: the Viewer addresses its own backend with an absolute `http://127.0.0.1:<port>`
 * URL. In a hosted deployment that address belongs to the *user's* machine, so the iframe can
 * never load it; and inside a sandboxed tenant the host cannot dial its own loopback either.
 * Proxying both prefixes through the host keeps every browser request same-origin, so the existing
 * platform reverse proxy carries it without exposing any extra port.
 *
 * WebSocket upgrades are intentionally out of scope here: the host webserver registers upgrade
 * routes by exact path, while the gateway's sockets live under `/uf/<enc>/...`, so they need
 * per-file dynamic registration.
 */
export function createGatewayViewerProxy(
  service: UniverService,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const upstreamPath = pathname.startsWith(VIEWER_PROXY_PREFIX)
    ? pathname.slice(VIEWER_PROXY_PREFIX.length) || '/'
    : pathname
  return proxyToGateway(service, request, response, upstreamPath)
}

async function proxyToGateway(
  service: UniverService,
  request: IncomingMessage,
  response: ServerResponse,
  upstreamPath: string
): Promise<void> {
  const available = await service.ensureGateway()
  if (!available.ok) {
    response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(available.reason)
    return
  }

  const socketPath = parseUnixOrigin(available.gateway)
  const target = socketPath === null ? new URL(available.gateway) : undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }

  await new Promise<void>((resolve) => {
    const upstream = http.request(
      {
        path: upstreamPath,
        method: request.method,
        headers,
        ...(socketPath === null
          ? { host: target?.hostname, port: target?.port ?? 80 }
          : { socketPath })
      },
      (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[]> = {}
        for (const [key, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue
          responseHeaders[key] = value
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)
        upstreamResponse.on('end', resolve)
        upstreamResponse.on('error', () => {
          response.end()
          resolve()
        })
      }
    )
    upstream.on('error', () => {
      if (!response.headersSent)
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Univer Gateway request failed.')
      resolve()
    })
    request.pipe(upstream)
  })
}

/**
 * Concrete upgrade paths the Viewer dials for one univerfile.
 *
 * The gateway exposes two sockets per file (see `gateway-app/transport/ws.ts`):
 *  - `…/universer-api/comb/connect` — presence / changeset relay
 *  - `…/events` — worktree lifecycle events
 *
 * The host webserver matches upgrade routes by **exact path** and these embed the encoded
 * univerfile, so they can only be registered once the file is known.
 */
export function viewerSocketPaths(fileKey: string): readonly string[] {
  return [
    `${GATEWAY_DATA_PREFIX}/${fileKey}/universer-api/comb/connect`,
    `${GATEWAY_DATA_PREFIX}/${fileKey}/events`
  ]
}

/**
 * Proxy one WebSocket upgrade through to the Gateway.
 *
 * Needed for the same reason as the HTTP proxy: the Viewer dials its sockets at the gateway's own
 * loopback origin, which neither the browser nor a sandboxed host can reach directly.
 */
export async function createGatewayUpgradeProxy(
  service: UniverService,
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer
): Promise<void> {
  const available = await service.ensureGateway()
  if (!available.ok) {
    clientSocket.destroy()
    return
  }
  const socketPath = parseUnixOrigin(available.gateway)
  const target = socketPath === null ? new URL(available.gateway) : undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }

  const upstream = http.request({
    path: request.url ?? '/',
    method: request.method ?? 'GET',
    headers,
    ...(socketPath === null
      ? { host: target?.hostname, port: target?.port ?? 80 }
      : { socketPath })
  })

  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    const lines = [
      `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`
    ]
    for (const [key, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined) continue
      if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
      else lines.push(`${key}: ${value}`)
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstreamSocket.destroy())
  })
  // An upgrade that did not switch protocols answers with a normal response: relay the status and
  // close, so the browser sees a failed handshake rather than a hang.
  upstream.on('response', (upstreamResponse) => {
    clientSocket.write(
      `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 502)} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}\r\n\r\n`
    )
    clientSocket.destroy()
  })
  upstream.on('error', () => clientSocket.destroy())
  upstream.end()
}
