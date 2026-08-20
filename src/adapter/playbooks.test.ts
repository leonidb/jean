/**
 * The playbooks wiring — the directory walk, the reconcile, the two read
 * surfaces, and the task include (task D-PB).
 *
 * WHAT THIS FILE ASSERTS: transport and wiring. That a directory of markdown
 * becomes events in the log, that a quiet directory stays quiet, that the
 * views serve what the registry holds, and that a task's `playbook` reference
 * comes back as a body. WHAT THE REGISTRY DOES with those events — the two
 * tolerance rulings, the diff's order, the id fallback — belongs to
 * `playbooks.conformance.test.ts` and is green there.
 *
 * It runs against a real directory because the walk is the half that lives
 * here, and because the idempotence claim is only worth anything over the
 * real thing: hashes computed at this write site, files read off a disk.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { StoredEvent } from '../es/index.ts'
import { type AdapterHandle, createAdapterServer } from './server.ts'

const openServers: AdapterHandle[] = []
const openDirs: string[] = []

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.stop()
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NAMED = ['---', 'name: Deploy Checklist', 'description: how we ship', '---', '', '# Steps', 'do the steps'].join(
  '\n',
)
const BARE = 'no frontmatter at all'

/** A dojo directory with a playbooks folder in it. */
function dojo(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'jean-dpb-'))
  openDirs.push(dir)
  mkdirSync(resolve(dir, 'playbooks'), { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(dir, 'playbooks', name), content)
  return dir
}

async function boot(dataDir: string): Promise<AdapterHandle> {
  const server = await createAdapterServer({ dataDir })
  openServers.push(server)
  return server
}

async function logged(dir: string): Promise<StoredEvent[]> {
  const file = Bun.file(resolve(dir, 'history.jsonl'))
  if (!(await file.exists())) return []
  return (await file.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredEvent)
}

const get = async (server: AdapterHandle, path: string) => {
  const res = await fetch(`http://localhost:${server.port}${path}`)
  return { status: res.status, body: (await res.json()) as Record<string, never> }
}

describe('the directory becomes the registry', () => {
  test('boot reconciles the files into the log, and the views serve them', async () => {
    const dir = dojo({ 'deploy.md': NAMED, 'notes.md': BARE, 'ignore.txt': 'not a playbook' })
    const server = await boot(dir)

    const created = (await logged(dir)).filter((e) => e.type === 'playbook-created')
    expect(created.map((e) => (e.data as { id: string }).id).sort()).toEqual(['deploy', 'notes'])
    // The identity is the FILENAME, which is why a non-markdown file is not
    // a playbook with a strange id — it is not a playbook.

    const list = (await get(server, '/playbooks')).body as unknown as {
      playbooks: { id: string; name: string; description: string }[]
    }
    expect(list.playbooks.map((p) => p.id).sort()).toEqual(['deploy', 'notes'])
    expect(list.playbooks.find((p) => p.id === 'deploy')?.name).toBe('Deploy Checklist')
    expect(list.playbooks.find((p) => p.id === 'notes')?.name).toBe('notes') // the id fallback
    // Content-free by contract: the cheap read stays cheap.
    for (const row of list.playbooks) expect(row).not.toHaveProperty('content')

    const one = (await get(server, '/playbooks/deploy')).body as unknown as { content: string; hash: string }
    expect(one.content).toBe(NAMED)
    expect(one.hash.length).toBeGreaterThan(0) // the write site's fact, carried

    expect((await get(server, '/playbooks/no-such')).status).toBe(404)
  })

  test('a QUIET directory stays quiet across a restart — the mirror direction, over real files', async () => {
    const dir = dojo({ 'deploy.md': NAMED })
    const first = await boot(dir)
    const afterFirst = (await logged(dir)).length
    expect(afterFirst).toBeGreaterThan(0) // anti-vacuity: something really was recorded
    await first.stop()
    openServers.length = 0

    // Same files, same hashes, new process: nothing changed, so nothing is
    // appended. A reconciler that re-emitted would grow the log on every
    // boot — and on every debounce of the watcher, which fires on any
    // filesystem event in that directory.
    const second = await boot(dir)
    expect((await logged(dir)).length).toBe(afterFirst)
    expect(((await get(second, '/playbooks')).body as unknown as { playbooks: unknown[] }).playbooks.length).toBe(1)
  })

  test('an edited file updates and a deleted one removes — carrying what was replaced', async () => {
    const dir = dojo({ 'deploy.md': NAMED, 'gone.md': BARE })
    const first = await boot(dir)
    await first.stop()
    openServers.length = 0

    writeFileSync(resolve(dir, 'playbooks', 'deploy.md'), `${NAMED}\nand one more step`)
    rmSync(resolve(dir, 'playbooks', 'gone.md'))
    const second = await boot(dir)

    const events = await logged(dir)
    const update = events.filter((e) => e.type === 'playbook-updated').pop()
    const removal = events.filter((e) => e.type === 'playbook-removed').pop()
    expect((update?.data as { id: string; prevHash?: string }).id).toBe('deploy')
    // The audit trail: what this update replaced.
    expect((update?.data as { prevHash?: string }).prevHash).toBeTruthy()
    expect((removal?.data as { id: string; lastHash?: string }).id).toBe('gone')
    expect((removal?.data as { lastHash?: string }).lastHash).toBeTruthy()

    const one = (await get(second, '/playbooks/deploy')).body as unknown as { content: string }
    expect(one.content).toContain('and one more step')
    expect((await get(second, '/playbooks/gone')).status).toBe(404)
  })

  test('a directory that DISAPPEARS reads as an empty one — the entries go, the files being the truth', async () => {
    // The distinction this pins: a FILE that cannot be read is not a file
    // that is gone (a permissions blip must not emit removals), but a
    // MISSING DIRECTORY is an empty scan. That is the old behaviour — it
    // created the directory when absent and then read it — and it means a
    // playbooks folder moved aside is a registry that empties. Visible in
    // the log, and reversible by putting it back.
    const dir = dojo({ 'deploy.md': NAMED })
    const first = await boot(dir)
    expect(((await get(first, '/playbooks')).body as unknown as { playbooks: unknown[] }).playbooks.length).toBe(1)
    await first.stop()
    openServers.length = 0

    rmSync(resolve(dir, 'playbooks'), { recursive: true })
    const second = await boot(dir)
    expect(((await get(second, '/playbooks')).body as unknown as { playbooks: unknown[] }).playbooks).toEqual([])
    expect((await logged(dir)).filter((e) => e.type === 'playbook-removed').length).toBe(1)
  })

  test('a dojo with no playbooks directory boots quietly rather than reporting a mass deletion', async () => {
    const bare = mkdtempSync(resolve(tmpdir(), 'jean-dpb-empty-'))
    openDirs.push(bare)
    const server = await boot(bare) // no playbooks/ at all
    expect((await logged(bare)).filter((e) => e.type.startsWith('playbook-'))).toEqual([])
    expect(((await get(server, '/playbooks')).body as unknown as { playbooks: unknown[] }).playbooks).toEqual([])
  })
})

describe('the watcher', () => {
  test('a dojo with no playbooks directory still notices its FIRST playbook, without a restart', async () => {
    // The directory is created at boot precisely so there is something to
    // watch: with none, a fresh dojo's first playbook was invisible until
    // the next restart (codex pass). This is also the only test that drives
    // the watcher end to end.
    const bare = mkdtempSync(resolve(tmpdir(), 'jean-dpb-watch-'))
    openDirs.push(bare)
    const server = await boot(bare)

    writeFileSync(resolve(bare, 'playbooks', 'late.md'), NAMED)
    let listed: unknown[] = []
    for (let i = 0; i < 40 && listed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50))
      listed = ((await get(server, '/playbooks')).body as unknown as { playbooks: unknown[] }).playbooks
    }
    expect(listed.length).toBe(1)
  })

  test('a file named `.md` has no identity, and does not flood the log trying to get one', async () => {
    // It scans to an EMPTY id: `decideReconcile` would emit a create, the
    // fold would drop it as malformed, and the next pass would emit it
    // again — every boot, every debounce, forever (codex pass). The scan
    // refuses to name it at all.
    const dir = dojo({ '.md': NAMED, 'real.md': BARE })
    const first = await boot(dir)
    const afterFirst = (await logged(dir)).length
    const listed = ((await get(first, '/playbooks')).body as unknown as { playbooks: { id: string }[] }).playbooks
    expect(listed.map((p) => p.id)).toEqual(['real']) // the `.md` file is not a playbook with a blank name
    await first.stop()
    openServers.length = 0

    await boot(dir)
    expect((await logged(dir)).length).toBe(afterFirst) // quiet, not one more create
  })
})

describe('the task include — composed from the two owning modules', () => {
  test('a task naming a playbook gets its body; one naming nothing gets no key at all', async () => {
    const dir = dojo({ 'deploy.md': NAMED })
    const server = await boot(dir)

    const withPlaybook = (await (
      await fetch(`http://localhost:${server.port}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'ship it', queue: 'worker-a', playbook: 'deploy' }),
      })
    ).json()) as { id: string }
    const without = (await (
      await fetch(`http://localhost:${server.port}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'just do it', queue: 'worker-a' }),
      })
    ).json()) as { id: string }

    const attached = (await get(server, `/tasks/${withPlaybook.id}?include=playbook`)).body as unknown as {
      playbook?: { id: string; name: string; content: string }
    }
    // The reference is the ID; the body comes from the registry. Neither
    // module imports the other — the shell holds them together.
    expect(attached.playbook).toEqual({ id: 'deploy', name: 'Deploy Checklist', content: NAMED })

    const plain = (await get(server, `/tasks/${without.id}?include=playbook`)).body as unknown as {
      playbook?: unknown
    }
    expect(plain.playbook).toBeUndefined() // no reference, so nothing to resolve and nothing to carry
  })

  test('a reference to a playbook that is not there attaches nothing — and does not fail the read', async () => {
    const dir = dojo()
    const server = await boot(dir)
    const task = (await (
      await fetch(`http://localhost:${server.port}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'orphaned', queue: 'worker-a', playbook: 'deleted-last-week' }),
      })
    ).json()) as { id: string }

    const read = await get(server, `/tasks/${task.id}?include=comments,messages,playbook`)
    expect(read.status).toBe(200)
    // THE FIELD IS THE TASK'S OWN REFERENCE until a body replaces it — one
    // key carrying an id string OR a body object, which is the shape the
    // contract pins ("exactly what E2's `enriched.playbook` serves") and the
    // old adapter's behaviour. So an unresolvable reference leaves the id
    // standing: the caller keeps what the task says, and gets no body.
    expect((read.body as unknown as { playbook?: unknown }).playbook).toBe('deleted-last-week')
  })
})
