/**
 * Machine-global dojo registry — `~/.jean/dojos.json`.
 *
 * Records every dojo's {path, port, identity} so port allocation is
 * collision-safe across ALL dojos on the machine — including ones that are
 * currently *down*. A down dojo stays registered, so auto-picking a free port
 * never silently steals a port a stopped dojo will want back. This is what
 * lets `jean dojo init` choose a port for you safely.
 *
 * Location can be overridden with JEAN_REGISTRY_PATH (used by tests so they
 * never touch the real ~/.jean).
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

export type DojoEntry = {
  path: string
  port: number
  identity?: string
  updatedAt?: string
}

/** First port handed out when the registry is empty. */
export const FIRST_PORT = 8700

export function registryPath(): string {
  const override = process.env.JEAN_REGISTRY_PATH
  return override ? resolve(override) : resolve(homedir(), '.jean', 'dojos.json')
}

/** Normalize for identity comparison: realpath when the dir exists, else resolve. */
function normPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export function readRegistry(): DojoEntry[] {
  const path = registryPath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const dojos = parsed?.dojos
    if (!Array.isArray(dojos)) return []
    return dojos.filter((d) => typeof d?.path === 'string' && typeof d?.port === 'number')
  } catch {
    return []
  }
}

export function writeRegistry(entries: DojoEntry[]): void {
  const path = registryPath()
  mkdirSync(dirname(path), { recursive: true })
  // Atomic: write a temp sibling then rename (POSIX-atomic) so a concurrent
  // reader never observes a half-written file.
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ dojos: entries }, null, 2)}\n`)
  renameSync(tmp, path)
}

/** Drop entries whose path no longer exists on disk — self-cleaning so a
 *  deleted dojo can't block its old port forever. */
export function pruneStale(entries: DojoEntry[]): DojoEntry[] {
  return entries.filter((e) => existsSync(e.path))
}

/** Record (or update) a dojo. Matches existing entries by realpath. */
export function upsertDojo(entry: DojoEntry): void {
  const norm = normPath(entry.path)
  const stamped: DojoEntry = { ...entry, path: norm, updatedAt: new Date().toISOString() }
  const rest = pruneStale(readRegistry()).filter((e) => normPath(e.path) !== norm)
  writeRegistry([...rest, stamped])
}

export function removeDojo(path: string): void {
  const norm = normPath(path)
  writeRegistry(readRegistry().filter((e) => normPath(e.path) !== norm))
}

/**
 * Resolve a port for the dojo at `forPath`, ignoring that dojo's own entry.
 * - `preferred` given → ok unless a *different* live dojo holds it (then error,
 *   naming the holder).
 * - `preferred` omitted → the next free port >= FIRST_PORT not held by a live dojo.
 */
export function allocatePort(preferred: number | undefined, forPath: string): { port: number } | { error: string } {
  const norm = normPath(forPath)
  const taken = new Map<number, DojoEntry>()
  for (const e of pruneStale(readRegistry())) {
    if (normPath(e.path) !== norm) taken.set(e.port, e)
  }
  if (preferred !== undefined) {
    const holder = taken.get(preferred)
    if (holder) {
      return {
        error: `Port ${preferred} is already registered to ${holder.path}. Pick another, or omit --port to auto-allocate.`,
      }
    }
    return { port: preferred }
  }
  let port = FIRST_PORT
  while (taken.has(port)) port++
  return { port }
}
