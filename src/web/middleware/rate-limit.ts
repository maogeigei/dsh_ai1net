/**
 * Global rate limiting. The auth/admin surfaces get their own stricter limits
 * in P1; this baseline covers the whole server.
 * @module dsh_ai1net/web/middleware/rate-limit
 */

import type { FastifyPluginAsync } from 'fastify'
import fastifyRateLimit from '@fastify/rate-limit'

/** Register the baseline rate limiter (applies to all routes). */
export const rateLimit: FastifyPluginAsync = async (app) => {
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: '1 minute',
    global: true,
  })
}
