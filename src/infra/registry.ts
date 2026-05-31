/**
 * Machine-global dojo registry — `~/.jean/dojos.json`.
 *
 * Records each dojo's {path, port, identity} so port allocation can avoid
 * every *registered* dojo — including ones currently *down* (a down dojo stays
 * registered, so auto-pick never silently steals a stopped dojo's port). A dojo
 * enters the registry at `jean dojo init`, on `infra start` (self-register), or
 * via `jean dojo register`; one that has never done any of those is invisible
 * here, and infra start's bind check remains the backstop.
 *
 * Writes are atomic (temp + rename) but unlocked: concurrent writers are
 * last-write-wins. Fine for a single-user machine; the next `infra start`
 * re-registers anything a race dropped.
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

/** Record (or update) a dojo. Matches existing entries by realpath. Replaces
 *  only this dojo's own entry — it does NOT prune neighbors, so a write never
 *  silently drops a dojo whose volume is briefly unmounted. Stale entries are
 *  ignored at allocation time and surfaced by `jean dojo list`. */
export function upsertDojo(entry: DojoEntry): void {
  const norm = normPath(entry.path)
  const stamped: DojoEntry = { ...entry, path: norm, updatedAt: new Date().toISOString() }
  const rest = readRegistry().filter((e) => normPath(e.path) !== norm)
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
    if (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535) {
      return { error: `Port ${preferred} is not a valid TCP port (must be an integer 1–65535).` }
    }
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
