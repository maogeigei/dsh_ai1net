import { parseUnixOrigin } from './gateway-socket.ts'
import { requestOverUnixSocket } from './unix-http.ts'
import type { MinimalHttpResponse } from './unix-http.ts'

export type { MinimalHttpResponse }

export interface GatewayRequestInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/**
 * Issue one request against a Gateway endpoint, choosing the transport from the endpoint itself.
 *
 * `endpoint` is either an `http(s)://host:port` origin or a `unix:<path>` tag — the same encoding
 * the supervisor hands out — so callers never branch on the transport themselves.
 */
export async function requestGateway(
  endpoint: string,
  requestPath: string,
  init: GatewayRequestInit
): Promise<MinimalHttpResponse> {
  const socketPath = parseUnixOrigin(endpoint)
  if (socketPath !== null) return requestOverUnixSocket(socketPath, requestPath, init)

  const timeout = AbortSignal.timeout(init.timeoutMs)
  const signal = init.signal === undefined ? timeout : AbortSignal.any([init.signal, timeout])
  const response = await fetch(`${endpoint}${requestPath}`, {
    method: init.method ?? 'GET',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
    signal
  })
  return {
    ok: response.ok,
    status: response.status,
    headers: { get: (name: string) => response.headers.get(name) },
    text: () => response.text(),
    json: () => response.json() as Promise<unknown>,
    arrayBuffer: () => response.arrayBuffer()
  }
}
