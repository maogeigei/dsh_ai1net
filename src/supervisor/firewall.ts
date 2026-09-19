/**
 * Loopback port guard: an iptables OUTPUT owner-match rule that lets only the
 * orchestrator (root) open a connection to a per-user DSH's loopback RPC port.
 * Because every user DSH binds the shared 127.0.0.1 loopback on a dynamic port,
 * a co-tenant local user could otherwise `curl` another user's DSH directly and
 * bypass the orchestrator's session authentication. The owner match filters on
 * the *client* uid, which is only observable on the OUTPUT chain for a
 * same-host loopback connection (an INPUT rule would see the receiving DSH's
 * uid and block nothing selectively).
 *
 * The REJECT is inserted at the *top* of OUTPUT (`-I OUTPUT 1`), not appended:
 * iptables stops at the first match, so an earlier ACCEPT (ufw or a conntrack
 * `ESTABLISHED,RELATED -j ACCEPT`) would otherwise swallow the packet before an
 * appended `-A` REJECT is ever evaluated.
 *
 * Linux + root only; opt in via `config.portGuard` and fail loud when enabled
 * on a host that cannot apply it.
 * @module dsh_ai1net/supervisor/firewall
 */

import { execFileSync } from 'node:child_process'

/** One guarded loopback port with idempotent install/remove. */
export interface PortGuard {
  /** Add the OUTPUT owner-match REJECT rule (throws on failure). */
  install(port: number): void
  /** Remove the rule best-effort (a missing rule is not an error). */
  remove(port: number): void
}

/** iptables arguments (excluding the executable) for one insert/delete.
 * Install inserts at position 1 (`-I OUTPUT 1`) to stay ahead of any earlier
 * ACCEPT (ufw / conntrack ESTABLISHED); delete matches by rule spec (`-D
 * OUTPUT`), which works regardless of position. */
function ruleArgs(port: number, action: '-I' | '-D'): string[] {
  const insert = action === '-I' ? ['1'] : []
  return ['-t', 'filter', action, 'OUTPUT', ...insert, '-p', 'tcp', '--dport', String(port), '-m', 'owner', '!', '--uid-owner', '0', '-j', 'REJECT']
}

/** Whether this process can manage the loopback OUTPUT guard. */
function canGuard(): boolean {
  return process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0
}

/**
 * Create the port guard when enabled, or undefined. Fails loud when enabled on
 * a host that cannot apply it (non-Linux or non-root): a silently absent guard
 * would leave co-tenants able to reach each other's DSH.
 * @param enabled - deployment flag (`config.portGuard`).
 */
export function createPortGuard(enabled: boolean): PortGuard | undefined {
  if (!enabled) return undefined
  if (!canGuard()) {
    throw new Error('portGuard requires a Linux host running as root (iptables OUTPUT owner-match)')
  }
  const guarded = new Set<number>()
  return {
    install(port) {
      if (guarded.has(port)) return
      // Insert at position 1 so an earlier ACCEPT (ufw / conntrack) can't
      // swallow the packet before the REJECT is evaluated.
      execFileSync('iptables', ruleArgs(port, '-I'))
      guarded.add(port)
    },
    remove(port) {
      if (!guarded.has(port)) return
      try {
        execFileSync('iptables', ruleArgs(port, '-D'))
      } catch {
        // Best-effort teardown: a stale rule leaves the port closed to
        // co-tenants, which is fail-safe, and a dropped rule is already gone.
      } finally {
        guarded.delete(port)
      }
    },
  }
}
