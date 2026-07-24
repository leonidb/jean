/**
 * Test isolation preload (wired via bunfig.toml `[test] preload`).
 *
 * The dojo registry is machine-global (~/.jean/dojos.json), and both the CLI
 * and any infra server a test spawns will write to it. Without isolation, the
 * test suite pollutes the developer's real registry (and spawned servers,
 * which inherit this process's env, write bogus /tmp entries that never prune).
 *
 * Point JEAN_REGISTRY_PATH at a throwaway location for the whole run. Tests
 * that assert on registry contents (registry.test.ts, dojo-init.test.ts)
 * override this per-test in beforeEach.
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const throwaway = resolve(tmpdir(), 'jean-test-registry', 'dojos.json')
// Fresh per run — the file otherwise persists across runs, and a server
// spawned by one run (which self-registers its /tmp dojo+port) can make a
// LATER run's `dojo init --port` fail on a phantom port collision.
try {
  rmSync(throwaway, { force: true })
} catch {}
process.env.JEAN_REGISTRY_PATH = throwaway
