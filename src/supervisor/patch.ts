/**
 * cordis patch rendering for a child DSH. Always mounts the runtime plugin
 * (`dsh_ai1net/runtime`) so every child injects the watchdog contract,
 * plus one row per enabled folder plugin (id doubles as package name). The real
 * harness loads this via `--patch <file>`.
 * @module dsh_ai1net/supervisor/patch
 */

/** The runtime plugin patch row, mounted in every child DSH. */
const RUNTIME_ROW = '    - id: dsh_ai1net-runtime\n      name: dsh_ai1net/runtime'

/** Render a patch YAML always enabling the runtime plugin plus `enabledPlugins`. */
export function renderPatch(enabledPlugins: readonly string[]): string {
  const rows = [RUNTIME_ROW, ...enabledPlugins.map((id) => `    - id: ${id}\n      name: ${id}`)]
  return `- insert:\n${rows.join('\n')}\n`
}
