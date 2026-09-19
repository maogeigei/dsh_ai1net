/**
 * nginx `server {}` rendering and domain validation. (P6)
 *
 * `renderServerBlock` produces a per-custom-domain block that rewrites the
 * domain root onto the orchestrator's `/u/<userId>/dsh/` subpath (see
 * manual/installation.md).
 * @module dsh_ai1net/nginx/generate
 */

/** Render an nginx server block mapping a custom domain to a user's DSH. */
export function renderServerBlock(domain: string, userId: string, upstreamPort: number): string {
  return [
    `# ${domain} -> user ${userId}`,
    'server {',
    '  listen 443 ssl;',
    `  server_name ${domain};`,
    '',
    `  ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;`,
    `  ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`,
    '',
    '  location / {',
    `    proxy_pass http://127.0.0.1:${upstreamPort}/u/${userId}/dsh/;`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host              $host;',
    '    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_set_header Upgrade    $http_upgrade;',
    '    proxy_set_header Connection $connection_upgrade;',
    '    proxy_read_timeout 3600s;',
    '  }',
    '}',
  ].join('\n')
}

/**
 * Validate an ASCII hostname: dot-separated labels of alnum/hyphen, no leading
 * or trailing hyphen, no scheme/path/port.
 */
export function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false
  return domain.split('.').every((label) => {
    if (label.length === 0 || label.length > 63) return false
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
  })
}
