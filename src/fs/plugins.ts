/**
 * Per-user plugin discovery: read the resident DSH profile's `dsh.profile.bundles`
 * and surface user-installed bundles, filtering out installation-owned
 * `@deepseek-ai/*` bundles. Name/description come from each bundle's own
 * package.json.
 * @module dsh_ai1net/fs/plugins
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeRoot } from './workspace.js'

/** A plugin the user may enable per folder (`id` doubles as the package name). */
export interface PluginInfo {
  id: string
  name: string
  description: string
}

/** Profile name the resident main DSH is launched with (see supervisor). */
export const MAIN_PROFILE = 'web'

/** Bundles under this scope come from the dsh installation, not the user. */
const INSTALLATION_SCOPE = '@deepseek-ai/'

/** Absolute profile directory within a user root (`<root>/home/profiles/web`). */
function profileDir(root: string): string {
  return join(homeRoot(root), 'profiles', MAIN_PROFILE)
}

/** Read a package.json `description`, tolerating a missing/empty field or file. */
function readDescription(manifestPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { description?: unknown }
    return typeof parsed.description === 'string' ? parsed.description : ''
  } catch {
    return ''
  }
}

/**
 * List a user's installed plugins from their profile's `dsh.profile.bundles`,
 * minus installation-owned bundles. Returns `[]` when the profile (or a listed
 * package) has not been installed yet. Order follows the bundle layer order.
 * @param root - the user's data root (see {@link userRoot}).
 */
export function listInstalledPlugins(root: string): PluginInfo[] {
  const dir = profileDir(root)
  let manifest: { dsh?: { profile?: { bundles?: string[] } } }
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const plugins: PluginInfo[] = []
  for (const packageName of bundles) {
    if (packageName.startsWith(INSTALLATION_SCOPE)) continue
    plugins.push({
      id: packageName,
      name: packageName,
      description: readDescription(join(dir, 'node_modules', packageName, 'package.json')),
    })
  }
  return plugins
}
