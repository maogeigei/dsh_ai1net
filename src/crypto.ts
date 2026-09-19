/**
 * Symmetric encryption for per-user secrets at rest. AES-256-GCM with a
 * key derived from the deployment secret, so a DB leak does not yield usable
 * API keys (references-not-secrets).
 * @module dsh_ai1net/crypto
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12

/** Derive a 32-byte AES key from the deployment secret (sha-256). */
export function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/** Encrypt a plaintext secret into a base64 payload `iv.tag.data`. */
export function encrypt(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.')
}

/** Decrypt a payload produced by {@link encrypt}. */
export function decrypt(payload: string, key: Buffer): string {
  const parts = payload.split('.')
  if (parts.length !== 3) throw new Error('malformed encrypted payload')
  const [ivB, tagB, dataB] = parts as [string, string, string]
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8')
}
