/**
 * WHEN THE PLUGIN SPEAKS TO INFRA (task 127).
 *
 * The plugin used to connect at module scope, so registration reached infra
 * before the MCP client had finished its own handshake — and infra announces
 * at the register instant. A tell emitted into that gap dies with nothing
 * reporting the loss: the server SDK resolves a notification on bytes written,
 * before the client has sent `initialize` at all.
 *
 * These walks drive the REAL plugin as a subprocess against a fake infra,
 * because the property is about a process's startup ordering and there is no
 * smaller thing to test. The fake speaks just enough WebSocket to record when
 * `register` arrives and what else the plugin says.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const PLUGIN = resolve(import.meta.dir, 'server.ts')

type Frame = { type?: string; agent?: string; text?: string }

/** The fake infra: a socket that records frames and the instant each arrived,
 *  measured from a `t0` the caller sets at spawn. */
function fakeInfra() {
  const frames: { at: number; frame: Frame }[] = []
  let t0 = 0
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined
      return new Response('no', { status: 400 })
    },
    websocket: {
      message(_ws, raw) {
        frames.push({ at: Date.now() - t0, frame: JSON.parse(String(raw)) as Frame })
      },
      open() {},
    },
  })
  return { frames, port: Number(server.port), stop: () => server.stop(true), mark: (at: number) => (t0 = at) }
}

const openDirs: string[] = []
const openServers: { stop: () => void }[] = []
const openProcs: { kill: () => void }[] = []

afterEach(() => {
  for (const p of openProcs.splice(0)) p.kill()
  for (const s of openServers.splice(0)) s.stop()
  for (const d of openDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A dojo just complete enough for the plugin's own discovery to resolve it:
 *  a `.jean/` with the config that marks a dojo root, and the port file the
 *  plugin reads to find infra. */
function dojo(port: number) {
  const root = mkdtempSync(resolve(tmpdir(), 'jean-127-plugin-'))
  openDirs.push(root)
  mkdirSync(resolve(root, '.jean'), { recursive: true })
  writeFileSync(resolve(root, '.jean', 'jean.config.json'), JSON.stringify({ port }))
  writeFileSync(resolve(root, '.jean', 'infra.port'), String(port))
  writeFileSync(resolve(root, '.jean', 'infra.pid'), String(process.pid))
  writeFileSync(
    resolve(root, '.jean', '.jean-agent.json'),
    JSON.stringify({ name: 'worker-p', role: 'worker', tags: [] }),
  )
  return root
}

/**
 * SPAWNING THE PLUGIN IS SPAWNING SOMETHING THAT WILL FIND A DOJO ON ITS OWN,
 * and this harness learned that the expensive way (2026-08-25).
 *
 * `discoverDojoRoot()` checks `process.env.JEAN_DOJO` FIRST (`server.ts:85`)
 * and only falls back to walking up from `sessionDir()`. A first version of
 * this file passed `...process.env` through and set `cwd` to a temp dojo —
 * and **an agent session exports `JEAN_DOJO` pointing at its own dojo**, so
 * the inherited value won outright. The plugin resolved the REAL dojo, read
 * its real `infra.port`, and registered a phantom agent against LIVE infra.
 * The temp dojo was never consulted, nothing errored, and the only signal was
 * a grep of the live event log.
 *
 * WORTH THE PRECISION, because the first diagnosis of this was wrong and was
 * reported confidently: the culprit is `JEAN_DOJO`, not `CLAUDE_PROJECT_DIR`.
 * That variable is unset in an agent session and never mattered here. It is
 * still cleared below because `sessionDir()` does consult it and a different
 * caller may set it — but the fix that works is pinning `JEAN_DOJO`, and
 * saying otherwise would leave the next reader guarding the wrong door.
 */
function launch(root: string, env: Record<string, string> = {}, prefill?: string) {
  const inherited = { ...process.env }
  // ABSENT, not empty: `sessionDir()` is `CLAUDE_PROJECT_DIR || cwd`, and an
  // empty string is falsy — but `undefined` is the honest state and reads as
  // one rather than as a value chosen to exploit coercion.
  inherited.CLAUDE_PROJECT_DIR = undefined

  // PRE-FLIGHT, AND THIS IS THE GUARD THAT MATTERS — checked BEFORE the
  // process exists, because a check afterwards is too late by exactly one
  // connection.
  //
  // `expectIsolated` below reads the plugin's stderr and fails loudly if it
  // reached the wrong dojo. That is worth having and it is NOT prevention: it
  // runs after a socket has already opened. Proven the hard way — verifying
  // that guard meant reintroducing the leak, and the leaked run registered
  // against LIVE infra three times before the assertion failed. A guard whose
  // own verification causes the harm it detects is the wrong shape.
  //
  // So the env is asserted here, where a bad value costs nothing: no
  // `CLAUDE_PROJECT_DIR` (it outranks `cwd` in `sessionDir()`), and
  // `JEAN_DOJO` pinned to this walk's temp root. A leak now fails before any
  // process is spawned, which is the only place a failure is free.
  const finalEnv: Record<string, string | undefined> = {
    ...inherited,
    JEAN_DOJO: root,
    JEAN_AGENT: 'worker-p',
    JEAN_ROLE: 'worker',
    JEAN_AGENT_DIR: resolve(root, '.jean'),
    ...env,
  }
  expect(
    finalEnv.JEAN_DOJO,
    'JEAN_DOJO must pin the temp dojo — an inherited one wins outright and IS how this reached live infra',
  ).toBe(root)
  expect(
    finalEnv.CLAUDE_PROJECT_DIR,
    'CLAUDE_PROJECT_DIR would reach the child and outrank cwd in sessionDir()',
  ).toBeUndefined()

  const proc = Bun.spawn(['bun', 'run', PLUGIN], {
    cwd: root,
    env: finalEnv as Record<string, string>,
    // PRE-FILLED when a walk needs the client's messages to be in the pipe
    // before the process starts reading it — the only way to stage a signal
    // that arrives during `mcp.connect()`.
    // PRE-FILLED when a walk needs the client's messages to be in the pipe
    // before the process starts reading it — the only way to stage a signal
    // that arrives during `mcp.connect()`. A Blob will NOT do: it ENDS the
    // stream, and the plugin treats a closed stdin as its parent dying and
    // shuts down. So: a stream that yields the content and then stays open,
    // which is what a real client's pipe looks like.
    stdin:
      prefill === undefined
        ? 'pipe'
        : new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(prefill))
              // deliberately never closed
            },
          }),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  openProcs.push(proc)
  return proc
}

/**
 * THE ISOLATION ASSERTION, and it is the rule rather than the env vars above.
 *
 * A harness that misses its own fake must FAIL, not quietly find production.
 * The plugin names the URL it connected to on stderr, so this asserts the port
 * is the fake's — checked before any conclusion is drawn from a frame, because
 * a frame that arrived at the fake is the only frame this file may reason
 * about. Any future walk that spawns the plugin calls this first.
 */
async function expectIsolated(proc: { stderr: ReadableStream }, fakePort: number): Promise<void> {
  const text = await readSome(proc.stderr)
  const connected = text.match(/connected to infra at ws:\/\/127\.0\.0\.1:(\d+)/)
  expect(connected, `the plugin never reported a connection; stderr was:\n${text}`).not.toBeNull()
  expect(Number(connected?.[1]), `THE HARNESS REACHED A DOJO THAT IS NOT ITS FAKE — stderr:\n${text}`).toBe(fakePort)
}

/** Drain what stderr has produced so far without waiting for the process to
 *  exit — it is still running, so the stream does not end. */
async function readSome(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (let i = 0; i < 40 && !out.includes('connected to infra'); i++) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: false }), 250)),
    ])
    if (value) out += dec.decode(value, { stream: true })
    if (done) break
  }
  reader.releaseLock()
  return out
}

const rpc = (proc: { stdin: unknown }, msg: unknown) =>
  (proc.stdin as { write: (s: string) => void }).write(`${JSON.stringify(msg)}\n`)

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
}
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' }

/** Poll rather than sleep: an arrival is a process round trip, and load can
 *  only ever push it later. */
async function until(cond: () => boolean, ms = 8_000): Promise<boolean> {
  const stop = Date.now() + ms
  while (Date.now() < stop) {
    if (cond()) return true
    await Bun.sleep(25)
  }
  return false
}

describe('registration waits for the client to be able to hear', () => {
  test('NOTHING IS SAID TO INFRA BEFORE `initialized` — the window, closed at its own end', async () => {
    const infra = fakeInfra()
    openServers.push(infra)
    const root = dojo(infra.port)
    infra.mark(Date.now())
    const proc = launch(root)

    // A generous stretch during which the OLD plugin would have registered:
    // it connected at module scope and reached the wire in ~450ms, dominated
    // by module load. Nothing may be said here.
    await Bun.sleep(2_000)
    expect(infra.frames, 'the plugin spoke to infra before the client was ready').toEqual([])

    // Now the handshake. `register` must follow it, not the clock.
    rpc(proc, INITIALIZE)
    await Bun.sleep(50)
    rpc(proc, INITIALIZED)

    const arrived = await until(() => infra.frames.some((f) => f.frame.type === 'register'))
    expect(arrived, 'the plugin never registered after the client was ready').toBe(true)
    await expectIsolated(proc, infra.port)
  }, 30_000)

  test('...and the GIVE-UP TIMER is not what caused it — a bound far beyond any handshake', async () => {
    // THE CASE THAT MUST NOT ROT: a give-up timer that silently becomes the
    // normal path. The bound is ten minutes here, so a register arriving at
    // all cannot be the timer's doing.
    //
    // NAMED FOR WHAT IT HOLDS, and the first name was wrong. It read
    // "registers on the SIGNAL, not on the give-up timer" — and MEASURED,
    // reverting the plugin to its old module-scope connect left this walk
    // GREEN while the other two went red. Module load takes ~450ms, which is
    // later than this walk can stamp anything, so "after I sent
    // `initialized`" is satisfied by a connect that never waited for it. The
    // discriminator against module-scope is the walk ABOVE — nothing may be
    // said before the signal — and it catches it. This one holds the timer's
    // absence and says so.
    const infra = fakeInfra()
    openServers.push(infra)
    const root = dojo(infra.port)
    infra.mark(Date.now())
    const proc = launch(root, { JEAN_READINESS_TIMEOUT_MS: '600000' })

    rpc(proc, INITIALIZE)
    await Bun.sleep(50)
    rpc(proc, INITIALIZED)

    const arrived = await until(() => infra.frames.some((f) => f.frame.type === 'register'))
    expect(arrived, 'with a ten-minute give-up bound, only the signal can have caused this').toBe(true)
    await expectIsolated(proc, infra.port)
  }, 30_000)

  test('A SIGNAL ALREADY IN THE PIPE AT SPAWN is honoured — no give-up, no blind report', async () => {
    // CODEX'S ORDERING FINDING, staged rather than argued. `mcp.connect()`
    // calls `transport.start()`, which begins reading stdin — so a client
    // whose `initialize` and `initialized` are ALREADY IN THE PIPE can have
    // both processed while `connect` is still awaiting. Arm `oninitialized`
    // after that and it is unset at the moment it would fire: the signal is
    // lost, and the give-up timer becomes the only path — a thirty-second
    // startup, reported as degraded, on a client that did nothing wrong.
    //
    // The other walks cannot reach this shape: they write to stdin after
    // spawning, and module load takes ~450ms, so their messages are always
    // read after `connect` resolves. Here the pipe is pre-filled at spawn.
    //
    // AND IT DOES NOT HOLD THE ORDERING FIX — said plainly, because the walk
    // was written believing it would. Moving the assignment back after
    // `mcp.connect()` leaves this GREEN: the race does not reproduce even
    // with the messages waiting in the pipe, so either the SDK does not
    // dispatch during `start()` or the timing does not line up. The
    // assignment stays where it is because arming a hook before the thing
    // that can fire it is free and removes the question — not because the
    // defect was demonstrated, and the difference belongs in writing.
    //
    // What this DOES hold is a real startup shape nothing else covered: a
    // client whose whole handshake is already buffered still gets a register
    // and no blind report. The give-up bound is ten minutes, so a register
    // arriving at all means the signal was seen.
    const infra = fakeInfra()
    openServers.push(infra)
    const root = dojo(infra.port)
    infra.mark(Date.now())
    const proc = launch(
      root,
      { JEAN_READINESS_TIMEOUT_MS: '600000' },
      `${JSON.stringify(INITIALIZE)}\n${JSON.stringify(INITIALIZED)}\n`,
    )

    const arrived = await until(() => infra.frames.some((f) => f.frame.type === 'register'))
    expect(arrived, 'the signal arrived during connect and was dropped — the hook was armed too late').toBe(true)
    await expectIsolated(proc, infra.port)
    expect(
      infra.frames.filter((f) => f.frame.type === 'reply'),
      'registered blind — the signal was in the pipe and nothing was listening for it',
    ).toEqual([])
  }, 30_000)

  test('A LATE SIGNAL UN-DEGRADES: the timer gave up, readiness arrived, and the report is not sent', async () => {
    // CODEX'S CASE, and it is a false report rather than a missed one — the
    // worse direction for the one message here whose entire purpose is to be
    // believed. The give-up timer fires while there is no infra port yet, so
    // `connectToInfra` returns early and schedules a 2s retry. `initialized`
    // then arrives before that retry opens a socket. The already-started
    // guard correctly suppresses a second connect — and the registration that
    // eventually happens would still have announced itself blind, about a
    // client that had signalled.
    //
    // Staged by starting with NO port file and writing it after the signal,
    // which is the ordinary "infra is not up yet" case rather than a
    // contrivance.
    const infra = fakeInfra()
    openServers.push(infra)
    const root = dojo(infra.port)
    rmSync(resolve(root, '.jean', 'infra.port'))
    infra.mark(Date.now())
    const proc = launch(root, { JEAN_READINESS_TIMEOUT_MS: '300' })

    // Let the timer give up against a dojo with no reachable infra.
    await Bun.sleep(700)
    expect(infra.frames, 'nothing should have reached infra — there was no port').toEqual([])

    // Readiness arrives late, then infra comes up.
    rpc(proc, INITIALIZE)
    await Bun.sleep(50)
    rpc(proc, INITIALIZED)
    await Bun.sleep(100)
    writeFileSync(resolve(root, '.jean', 'infra.port'), String(infra.port))

    const registered = await until(() => infra.frames.some((f) => f.frame.type === 'register'))
    expect(registered, 'the retry never registered once infra came up').toBe(true)
    await expectIsolated(proc, infra.port)

    // AND NO BLIND REPORT. The signal did arrive; saying otherwise would be a
    // lie told loudly.
    await Bun.sleep(300)
    expect(
      infra.frames.filter((f) => f.frame.type === 'reply'),
      'reported a blind registration for a client that had signalled',
    ).toEqual([])
  }, 30_000)

  test('A CLIENT THAT NEVER SAYS `initialized` STILL REGISTERS, and says that it did so blind', async () => {
    // RULED (2026-08-25): wait half a minute, then connect anyway and report
    // the problem. Never registering is not
    // the safe failure it looks like — an agent that never appears is
    // indistinguishable from an agent nobody started, which is the
    // fabricated-success shape inverted rather than fixed.
    //
    // The bound is injected short here; production's is thirty seconds and
    // deliberately untuned.
    const infra = fakeInfra()
    openServers.push(infra)
    const root = dojo(infra.port)
    infra.mark(Date.now())
    const proc = launch(root, { JEAN_READINESS_TIMEOUT_MS: '400' })

    const registered = await until(() => infra.frames.some((f) => f.frame.type === 'register'))
    expect(registered, 'a client that never initialized left its agent invisible').toBe(true)
    await expectIsolated(proc, infra.port)

    // AND IT REPORTED, on the wire rather than into a subprocess's stderr.
    // This is the highest rung reachable from the plugin alone: a flag on the
    // register RECORD is not, because the server builds that record from named
    // fields and drops the rest.
    const said = await until(() => infra.frames.some((f) => f.frame.type === 'reply'))
    expect(said, 'the blind connection was never reported anywhere infra can see').toBe(true)
    const reply = infra.frames.find((f) => f.frame.type === 'reply')
    expect(reply?.frame.text, 'the report does not say what happened').toContain('WITHOUT the client readiness signal')
  }, 30_000)
})
