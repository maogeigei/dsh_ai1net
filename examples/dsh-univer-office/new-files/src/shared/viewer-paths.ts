/**
 * Browser-facing paths for the bundled Viewer.
 *
 * Kept in `shared` because both sides need them: the host provider mints the viewer URL, and the
 * webserver seats the routes that serve it.
 */

/** Prefix serving the Viewer page and its static assets, proxied through the host webserver. */
export const VIEWER_PROXY_PREFIX = '/univer-api/viewer'

/**
 * Viewer page path handed to the browser.
 *
 * Relative (same-origin) on purpose: an absolute `http://127.0.0.1:<port>` URL would be resolved
 * against the *user's* machine, where nothing is listening. Staying same-origin lets the platform
 * reverse proxy carry it without exposing any extra port.
 */
export const VIEWER_PAGE_PATH = `${VIEWER_PROXY_PREFIX}/`

/**
 * Gateway data-plane prefix.
 *
 * Once loaded, the Viewer addresses its backend by absolute path under this prefix
 * (`/uf/<base64url(univerfile)>/...`), so it needs its own seat to remain same-origin.
 */
export const GATEWAY_DATA_PREFIX = '/uf'
