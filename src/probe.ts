/**
 * Helpers for identifying Jean infrastructure instances.
 *
 * Used by both the infra server (single-instance enforcement) and the CLI
 * (duplicate detection before spawning).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const INFRA_IDENTITY = 'jean-infra'

export type InfraInfo = {
  name?: string
  dataDir?: string
  pid?: number
  port?: number
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function probeInfra(port: number, timeoutMs = 500): Promise<InfraInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return (await res.json()) as InfraInfo
  } catch {
    return null
  }
}

/** Does a `probeInfra` result identify THIS dojo's own infra — as opposed to
 *  no server, a foreign server, or another dojo's infra that happens to
 *  share a recycled port? The one question both `enforceSingleInstance`
 *  (refusing a second start) and `jean dojo repair` (deciding whether a
 *  copied dojo's runtime files are live) need answered the same way.
 *  `dataDir === ''` counts as a match too — a legacy server that never
 *  recorded one. */
export function isOwnInfra(info: InfraInfo | null, dataDir: string): boolean {
  return info?.name === INFRA_IDENTITY && (info.dataDir === '' || info.dataDir === dataDir)
}

/** Read the pid and port from `.jean/infra.pid` and `.jean/infra.port` in a data dir. */
export function readRuntimeFiles(dataDir: string): { pid: number | null; port: number | null } {
  const pidFile = resolve(dataDir, 'infra.pid')
  const portFile = resolve(dataDir, 'infra.port')
  const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null
  const port = existsSync(portFile) ? Number(readFileSync(portFile, 'utf8').trim()) : null
  return { pid, port }
}

/** Cheap (sync, no network) check: pid+port files present and the pid is alive. */
export function isLocalInfraAlive(dataDir: string): boolean {
  const { pid, port } = readRuntimeFiles(dataDir)
  return pid !== null && port !== null && isProcessAlive(pid)
}

/**
 * Walk up from a starting directory to the dojo root — the ancestor whose
 * `.jean/` holds `jean.config.json`. Agent worktrees also have a `.jean/` (with
 * `.jean-agent.json`, not `jean.config.json`), so a plain "first `.jean/`" walk
 * would stop at the worktree; keying on the dojo config file skips worktrees.
 * Shared by the CLI and the channel server so both resolve the root identically.
 */
export function findDojoRootFrom(startDir: string): string | null {
  let dir = resolve(startDir)
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, '.jean', 'jean.config.json'))) return dir
    dir = dirname(dir)
  }
  return null
}
