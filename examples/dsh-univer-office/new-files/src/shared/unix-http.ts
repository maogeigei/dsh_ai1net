import http from 'node:http'

/**
 * Minimal HTTP response surface — just the three things the Gateway callers actually use.
 *
 * Deliberately not the full `Response` interface: `fetch` cannot address a unix domain socket,
 * so this covers the socket transport without pulling in a dependency.
 */
export interface MinimalHttpResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

export interface UnixSocketRequestInit {
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/**
 * Issue one HTTP request over a unix domain socket.
 *
 * Mirrors the failure shape of `fetch` + `AbortSignal.timeout` closely enough for the existing
 * timeout detection (`name === 'TimeoutError'`) to keep working unchanged.
 */
export function requestOverUnixSocket(
  socketPath: string,
  requestPath: string,
  init: UnixSocketRequestInit
): Promise<MinimalHttpResponse> {
  return new Promise<MinimalHttpResponse>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: requestPath,
        method: init.method ?? 'GET',
        ...(init.headers === undefined ? {} : { headers: init.headers }),
        timeout: init.timeoutMs
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const status = response.statusCode ?? 0
          const body = Buffer.concat(chunks)
          resolve({
            ok: status >= 200 && status < 300,
            status,
            headers: {
              get: (name: string) => {
                const value = response.headers[name.toLowerCase()]
                return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
              }
            },
            text: () => Promise.resolve(body.toString('utf8')),
            json: () => Promise.resolve(JSON.parse(body.toString('utf8')) as unknown),
            arrayBuffer: () =>
              Promise.resolve(
                body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
              )
          })
        })
        response.on('error', reject)
      }
    )
    request.on('timeout', () => {
      request.destroy(Object.assign(new Error('Gateway request timed out.'), { name: 'TimeoutError' }))
    })
    if (init.signal !== undefined) {
      const abort = (): void => request.destroy(init.signal?.reason)
      if (init.signal.aborted) abort()
      else init.signal.addEventListener('abort', abort, { once: true })
    }
    request.on('error', reject)
    if (init.body !== undefined) request.write(init.body)
    request.end()
  })
}
