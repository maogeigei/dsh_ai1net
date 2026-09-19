/**
 * Password hashing, session-token helpers, and cookie assembly.
 *
 * Uses `node:crypto` scrypt so the scaffold has zero native dependency beyond
 * SQLite; production may swap in argon2id without changing call sites.
 * @module dsh_ai1net/web/auth
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

const KEY_LENGTH = 64

/** Hash a password into a `scrypt$<salt>$<hash>` string. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

/** Constant-time password verification against a stored `scrypt$...` string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split('$')
  if (scheme !== 'scrypt' || saltHex === undefined || hashHex === undefined) return false
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

/** Generate a fresh opaque session token. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Hash a session token for storage; the DB never holds the raw token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Extract a named cookie value from a `Cookie` header. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

/** Build a `Set-Cookie` value for the session token.
 *
 * `SameSite=None` (with `Secure`) when behind HTTPS so the cookie survives the
 * cross-subdomain hop `dsh.<domain>` → `<user>.dsh.<domain>`; `SameSite=Lax`
 * otherwise. The subdomain auth check still validates cookie ↔ slug, so the
 * looser SameSite does not widen who a session can reach.
 */
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean, domain?: string): string {
  const flags = ['sid=' + token, 'HttpOnly', secure ? 'SameSite=None' : 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`]
  if (secure) flags.push('Secure')
  if (domain !== undefined && domain !== '') flags.push(`Domain=${domain}`)
  return flags.join('; ')
}

/** Build a `Set-Cookie` value that expires the session cookie. */
export function clearSessionCookie(secure: boolean, domain?: string): string {
  const flags = ['sid=', 'HttpOnly', secure ? 'SameSite=None' : 'SameSite=Lax', 'Path=/', 'Max-Age=0']
  if (secure) flags.push('Secure')
  if (domain !== undefined && domain !== '') flags.push(`Domain=${domain}`)
  return flags.join('; ')
}
