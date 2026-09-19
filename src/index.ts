/**
 * Cordis entry used only for marketplace recognition.
 *
 * The real product is the standalone `dsh_ai1net` binary (see
 * `./cli.js`), which runs its own Fastify server and spawns per-user DSH
 * processes. This `apply` is a guarded no-op: loading the bundle into any
 * profile must not start a server.
 * @module dsh_ai1net
 */

export const name = 'dsh_ai1net'

/** Options read by the Cordis loader. `serve` is reserved, not implemented. */
export interface Config {
  serve?: boolean
}

/**
 * Guarded no-op shim. Kept side-effect free so marketplace installs and
 * ordinary profiles never boot the orchestrator by accident.
 * @param _ctx - the Cordis context (unused).
 * @param _config - loader-supplied config (unused).
 */
export function apply(_ctx?: unknown, _config?: Config): void {
  // Intentionally empty.
}
