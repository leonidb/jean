/**
 * The bind — an adapter law, not a domain rule: which address the socket
 * listens on is the shell's business, and nothing in `src/domain` can see it.
 *
 * Its own file because these tests start and stop their own servers, and a
 * suite that shares one server cannot also tear down two more.
 */

import { describe, expect, test } from 'bun:test'
import { networkInterfaces } from 'node:os'
import { createAdapterServer } from './server.ts'

/**
 * WHY THE ASSERTIONS LOOK LIKE THIS.
 *
 * `server.hostname` reports what Bun was TOLD, not what it bound — measured:
 * with no hostname Bun reports `localhost` while `lsof` shows `*:PORT` on
 * IPv6. So the string alone pins the plumbing and misses the point.
 *
 * The honest discriminator is a NON-LOOPBACK address of this machine. A
 * wildcard bind answers there; a loopback bind cannot. IPv6 loopback (`[::1]`)
 * is checked too, but only as a second signal: on an IPv6-disabled host it is
 * refused whatever the bind, so it can pass vacuously and must not be the
 * whole proof (codex pass, task 146).
 */
function firstExternalIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address
    }
  }
  return undefined
}

async function reachable(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(2000) })
    return res.status > 0
  } catch {
    return false
  }
}

const external = firstExternalIPv4()

describe('the infra binds loopback unless a dojo says otherwise', () => {
  test('with no configuration it answers on loopback and not on this machine’s network address', async () => {
    const server = await createAdapterServer({})

    expect(await reachable('127.0.0.1', server.port)).toBe(true)
    if (external !== undefined) {
      // THE GUARANTEE. A wildcard bind answers here; this must not.
      expect(await reachable(external, server.port)).toBe(false)
    }
    // Secondary, and vacuous without IPv6 — kept because it is free and it
    // catches an IPv6 wildcard, which the IPv4 check above would miss.
    expect(await reachable('[::1]', server.port)).toBe(false)
    expect(server.hostname).toBe('127.0.0.1')

    await server.stop()
  })

  test('0.0.0.0 exposes it — the opt-in is real, and it is the only other value a dojo should use', async () => {
    const server = await createAdapterServer({ hostname: '0.0.0.0' })
    expect(server.hostname).toBe('0.0.0.0')

    // Still answers on loopback: that is what makes 0.0.0.0 safe for the
    // CLI, the channel plugin, peer deliver and `probeInfra`, all of which
    // dial 127.0.0.1 and none of which learn the bind address.
    expect(await reachable('127.0.0.1', server.port)).toBe(true)
    if (external !== undefined) {
      expect(await reachable(external, server.port)).toBe(true)
    }

    await server.stop()
  })
})
