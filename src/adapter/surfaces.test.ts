/**
 * E2's live smoke — the tasks/board, triggers and knowledge surfaces over a
 * real socket, plus the send surface's completion (task E2).
 *
 * ── WHAT THIS FILE IS ALLOWED TO ASSERT ──
 *
 * Transport, wiring, and executor laws. NEVER a domain rule. So: that a
 * request reaches its decision, that a typed refusal arrives as the status
 * the rename table gives it, that a handler appends the event the decision
 * returned and nothing else, that a refused request writes NOTHING. What the
 * system DECIDES — which transitions are legal, who may drive them, what
 * ranks above what — is core's, is already pinned there, and restating it
 * here would only mean two places to update and one of them wrong.
 *
 * The seam that reveals the difference: `PATCH /tasks/ghost/status` asserting
 * 404 is wiring (the refusal reached the rename table); `PATCH` a done task
 * to in-progress asserting 400 would be the DAG, which is not this file's.
 *
 * ── SOCKET HYGIENE ──
 *
 * Every socket opened here is closed AND AWAITED in teardown. `ws.close()`
 * only REQUESTS a close, and a socket still closing when `server.stop()` runs
 * holds the hook to its timeout — which reads as a hanging product bug and is
 * not one (measured at E1).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AdapterHandle, createAdapterServer } from './server.ts'

let server: AdapterHandle
let base: string
const opened: WebSocket[] = []

beforeAll(async () => {
  server = await createAdapterServer()
  base = `http://localhost:${server.port}`
  await connect('orchestrator-o', 'sensei')
  await connect('worker-a', 'worker')
})

afterAll(async () => {
  await Promise.all(
    opened.map(
      (ws) =>
        new Promise<void>((done) => {
          if (ws.readyState === WebSocket.CLOSED) return done()
          ws.onclose = () => done()
          ws.close()
        }),
    ),
  )
  server.stop()
})

const sockets = new Map<string, WebSocket>()
/** Every frame the server PUSHED to a session, per agent — the only window
 *  onto what a live delivery actually carried, as opposed to what the record
 *  says it carried. */
const pushed = new Map<string, Record<string, unknown>[]>()

function connect(agent: string, role: string): Promise<WebSocket> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    opened.push(ws)
    pushed.set(agent, [])
    const timer = setTimeout(() => fail(new Error(`register timed out for ${agent}`)), 4_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role }))
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>
      if (frame.type !== 'registered') {
        pushed.get(agent)?.push(frame)
        return
      }
      clearTimeout(timer)
      sockets.set(agent, ws)
      done(ws)
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
}

/** Wait for a pushed frame to arrive, rather than sleeping for one. */
async function pushedTo(agent: string, predicate: (f: Record<string, unknown>) => boolean) {
  for (let i = 0; i < 40; i++) {
    const found = pushed.get(agent)?.find(predicate)
    if (found !== undefined) return found
    await new Promise((r) => setTimeout(r, 25))
  }
  return undefined
}

type Json = Record<string, never>
const get = async (path: string) => {
  const res = await fetch(`${base}${path}`)
  return { status: res.status, body: (await res.json()) as Json }
}
const call = async (method: string, path: string, body?: unknown, agent?: string) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(agent !== undefined && { 'x-jean-agent': agent }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: (await res.json()) as Json }
}

/** The events currently in an agent's mailbox — the only window this suite
 *  has onto what a handler appended, and the one that matters: an event
 *  nobody can read is an event that did not arrive. */
const mailboxOf = async (agent: string) =>
  ((await get(`/events?agent=${agent}`)).body as unknown as { events: { id: number; type: string; data: Json }[] })
    .events

describe('the tasks surface', () => {
  let id: string

  test('create → 201, and the task comes back through the board’s own reader', async () => {
    const created = await call(
      'POST',
      '/tasks',
      { title: 'wire E2', queue: 'worker-a', description: 'the surfaces' },
      'orchestrator-o',
    )
    expect(created.status).toBe(201)
    const task = created.body as unknown as { id: string; title: string; status: string; queue: string }
    expect(task.title).toBe('wire E2')
    expect(task.queue).toBe('worker-a')
    id = task.id

    const one = await get(`/tasks/${id}`)
    expect(one.status).toBe(200)
    expect((one.body as unknown as { id: string }).id).toBe(id)
  })

  test('a refused request writes NOTHING — the log does not move on a 400', async () => {
    const before = (await get('/tasks')).body as unknown as { tasks: unknown[] }
    const bad = await call('POST', '/tasks', { title: 'no queue named' }, 'orchestrator-o')
    expect(bad.status).toBe(400)
    const after = (await get('/tasks')).body as unknown as { tasks: unknown[] }
    expect(after.tasks.length).toBe(before.tasks.length)
  })

  test('a typed refusal arrives as the status the rename table gives it, carrying its kind', async () => {
    const ghost = await call('PATCH', '/tasks/ghost/status', { status: 'done' }, 'orchestrator-o')
    expect(ghost.status).toBe(404)
    expect((ghost.body as unknown as { refusal: string }).refusal).toBe('unknown-task')
  })

  test('an unparseable status value never reaches the decision — grammar is the adapter’s', async () => {
    const bad = await call('PATCH', `/tasks/${id}/status`, { status: 'sideways' }, 'orchestrator-o')
    expect(bad.status).toBe(400)
    // THE STATUS CODE ALONE PROVES NOTHING HERE, and this test was written
    // believing it did: a `sideways` that reaches `decideStatus` comes back
    // as `illegal-transition`, which is ALSO a 400. What separates the two is
    // WHO authored the refusal — a domain refusal carries its own `kind`, and
    // the adapter's own grammar error does not. (Measured: removing the
    // grammar check left the first version of this test green.)
    expect((bad.body as unknown as { refusal?: string }).refusal).toBeUndefined()
    expect((bad.body as unknown as { error: string }).error).toContain('in-progress') // the valid values, listed
    // And the task did not move.
    expect((await get(`/tasks/${id}`)).body as unknown as { status: string }).toMatchObject({ status: 'todo' })
  })

  test('a legal transition appends and the read surface shows it', async () => {
    const moved = await call('PATCH', `/tasks/${id}/status`, { status: 'in-progress' }, 'orchestrator-o')
    expect(moved.status).toBe(200)
    expect((moved.body as unknown as { status: string }).status).toBe('in-progress')
  })

  test('revert answers with what it undid — the decision’s own from/to, serialized', async () => {
    const back = await call('POST', `/tasks/${id}/revert`, { actor: 'orchestrator-o' }, 'orchestrator-o')
    expect(back.status).toBe(200)
    const body = back.body as unknown as { status: string; reverted: { from: string; to: string } }
    expect(body.reverted).toEqual({ from: 'in-progress', to: 'todo' })
    expect(body.status).toBe('todo')
  })

  test('handoff refuses on a task that is not parked, and the refusal is a CONFLICT not a 400', async () => {
    const early = await call('POST', `/tasks/${id}/handoff`, { blockedOn: 'human' }, 'orchestrator-o')
    expect(early.status).toBe(409)
    expect((early.body as unknown as { refusal: string }).refusal).toBe('not-waiting')
  })

  test('park → handoff writes the historical kind the old system could only READ', async () => {
    await call('PATCH', `/tasks/${id}/status`, { status: 'in-progress' }, 'orchestrator-o')
    await call('PATCH', `/tasks/${id}/status`, { status: 'waiting', blockedOn: 'sensei' }, 'orchestrator-o')
    const moved = await call(
      'POST',
      `/tasks/${id}/handoff`,
      { blockedOn: 'human', note: 'needs a ruling' },
      'orchestrator-o',
    )
    expect(moved.status).toBe(200)
    expect((moved.body as unknown as { blockedOn: string }).blockedOn).toBe('human')
  })

  test('subscribe and unsubscribe round-trip through the subscriber set', async () => {
    // worker-a is already subscribed (the automatic surface), so this proves
    // the OFF direction as well as the ON one.
    const off = await call('POST', `/tasks/${id}/unsubscribe`, { agent: 'worker-a' }, 'orchestrator-o')
    expect(off.status).toBe(200)
    expect((off.body as unknown as { subscribers: string[] }).subscribers).not.toContain('worker-a')

    const on = await call('POST', `/tasks/${id}/subscribe`, { agent: 'worker-a' }, 'orchestrator-o')
    expect(on.status).toBe(200)
    expect((on.body as unknown as { subscribers: string[] }).subscribers).toContain('worker-a')

    const again = await call('POST', `/tasks/${id}/subscribe`, { agent: 'worker-a' }, 'orchestrator-o')
    expect(again.status).toBe(409)
    expect((again.body as unknown as { refusal: string }).refusal).toBe('already-subscribed')
  })

  test('`agent` in a task body is the ASSIGNEE — a reassignment is not authored by its subject', async () => {
    // Header-less on purpose. Read as the caller, `body.agent` would make
    // every reassignment look self-authored: the new owner recorded as having
    // moved the task to itself, and credited with the activity for it.
    const moved = await call('PATCH', `/tasks/${id}`, { agent: 'worker-b' })
    expect(moved.status).toBe(200)
    const update = (await mailboxOf('worker-a')).filter((e) => e.type === 'task-updated').pop()
    expect(update).toBeDefined()
    expect((update?.data as unknown as { actor: string }).actor).not.toBe('worker-b')
    expect((update?.data as unknown as { actor: string }).actor).toBe('api')
  })

  test('an unknown include is REFUSED; a task with no playbook simply gets no include', async () => {
    const bad = await get(`/tasks/${id}?include=comments,history`)
    expect(bad.status).toBe(400)
    expect((bad.body as unknown as { error: string }).error).toContain('history')

    const asked = await get(`/tasks/${id}?include=comments,messages,playbook`)
    expect(asked.status).toBe(200)
    const body = asked.body as unknown as { comments: unknown[]; messages: unknown[]; playbook?: unknown }
    expect(Array.isArray(body.comments)).toBe(true)
    expect(Array.isArray(body.messages)).toBe(true)
    // E2 answered this flag with `unavailable: ["playbook"]` because no
    // module owned playbooks. D-PB closed that; this task has no playbook
    // REFERENCE, so there is simply nothing to attach — an empty
    // `Task.playbook` means absent, not "look up the empty id". The live
    // include has its own suite (`playbooks.test.ts`).
    expect(body.playbook).toBeUndefined()
    expect(body).not.toHaveProperty('unavailable')
  })

  test('a comment frame lands on the task’s stream and comes back through include=comments', async () => {
    const ws = sockets.get('worker-a')
    if (ws === undefined) throw new Error('fixture: worker-a not connected')
    ws.send(JSON.stringify({ type: 'task-comment', taskId: id, text: 'found the seam' }))
    // The frame is fire-and-forget; poll the read surface rather than sleep.
    let comments: { text: string }[] = []
    for (let i = 0; i < 40 && comments.length === 0; i++) {
      const body = (await get(`/tasks/${id}?include=comments`)).body as unknown as { comments: { text: string }[] }
      comments = body.comments
      if (comments.length === 0) await new Promise((r) => setTimeout(r, 25))
    }
    expect(comments.map((c) => c.text)).toEqual(['found the seam'])

    // THE ROLE ON THE RECORD IS THE SESSION'S. The read view above does not
    // carry it, so the assertion goes to the one window that does — the event
    // itself, in the OTHER party's mailbox, because a task comment resolves
    // to the task's parties minus its author. And the commenter here is the
    // SENSEI on purpose: asserted on the worker's own comment, a hardcoded
    // `role: 'worker'` at the write site would agree with the truth by
    // accident and pass unnoticed (measured).
    const orch = sockets.get('orchestrator-o')
    if (orch === undefined) throw new Error('fixture: orchestrator not connected')
    orch.send(JSON.stringify({ type: 'task-comment', taskId: id, text: 'noted' }))
    let comment: { agent: string; role: string; text: string } | undefined
    for (let i = 0; i < 40 && comment === undefined; i++) {
      const mine = await mailboxOf('worker-a')
      comment = mine.filter((e) => e.type === 'task-comment').pop()?.data as unknown as
        | { agent: string; role: string; text: string }
        | undefined
      if (comment === undefined) await new Promise((r) => setTimeout(r, 25))
    }
    expect(comment).toMatchObject({ agent: 'orchestrator-o', role: 'sensei', text: 'noted' })
  })

  test('the board serves per-task activity, and the domain’s staleness arithmetic drives the flag', async () => {
    const board = (await get('/board')).body as unknown as {
      tasks: { id: string; lastEventAt: string; stale?: true }[]
    }
    const row = board.tasks.find((t) => t.id === id)
    expect(row).toBeDefined()
    expect(Number.isNaN(Date.parse(row?.lastEventAt ?? ''))).toBe(false)
    // A day-old bound over a second-old task: nothing is stale.
    expect(board.tasks.some((t) => t.stale === true)).toBe(false)
  })
})

describe('the triggers surface', () => {
  test('create → get → list → patch → fire → delete, each a rename of one decision', async () => {
    const made = await call(
      'POST',
      '/triggers',
      { id: 'nightly', cron: '0 3 * * *', agent: 'worker-a', prompt: 'sweep' },
      'orchestrator-o',
    )
    expect(made.status).toBe(201)
    expect((made.body as unknown as { id: string; status: string }).status).toBe('active')

    expect((await get('/triggers/nightly')).status).toBe(200)
    const listed = (await get('/triggers?agent=worker-a')).body as unknown as { triggers: { id: string }[] }
    expect(listed.triggers.map((t) => t.id)).toContain('nightly')

    const patched = await call('PATCH', '/triggers/nightly', { status: 'disabled' })
    expect(patched.status).toBe(200)
    expect((patched.body as unknown as { status: string }).status).toBe('disabled')

    const gone = await call('DELETE', '/triggers/nightly')
    expect(gone.status).toBe(200)
    expect((await get('/triggers/nightly')).status).toBe(404)
  })

  test('a taken id CONFLICTS and an unknown one is NOT FOUND — both from the decision', async () => {
    await call('POST', '/triggers', { id: 'weekly', cron: '0 4 * * 1', agent: 'worker-a', prompt: 'review' })
    const dup = await call('POST', '/triggers', { id: 'weekly', cron: '0 5 * * 1', agent: 'worker-a', prompt: 'again' })
    expect(dup.status).toBe(409)
    expect((dup.body as unknown as { refusal: string }).refusal).toBe('duplicate-id')

    const ghost = await call('PATCH', '/triggers/ghost', { status: 'disabled' })
    expect(ghost.status).toBe(404)
  })

  test('the update body reaches the decision RAW, so an unknown field is refused and not dropped', async () => {
    const bad = await call('PATCH', '/triggers/weekly', { cadence: 'often' })
    expect(bad.status).toBe(400)
    expect((bad.body as unknown as { refusal: string }).refusal).toBe('unknown-fields')
    expect((bad.body as unknown as { error: string }).error).toContain('cadence')
  })

  test('metadata that is not an object is refused TYPED — the adapter renames, it does not judge', async () => {
    // E2 checked this at the door because the domain had no create-time
    // check; the architect added one (the task-103 ruling batch) and the door-check went. The
    // status is the same, the `refusal` is what proves which half decided.
    const bad = await call('POST', '/triggers', {
      id: 'bad-meta',
      cron: '0 6 * * *',
      agent: 'worker-a',
      prompt: 'x',
      metadata: ['not', 'an', 'object'],
    })
    expect(bad.status).toBe(400)
    expect((bad.body as unknown as { refusal: string }).refusal).toBe('invalid-metadata')
    expect((await get('/triggers/bad-meta')).status).toBe(404) // and nothing was written
  })

  test('`agent` in a trigger body is its TARGET — it must never be read as the caller', async () => {
    // No `x-jean-agent` header on purpose: this is the CLI-shaped call. The
    // first version of `callerOf` fell back to `body.agent`, which on this
    // route is the trigger's target — so the trigger recorded itself as
    // having been created by the agent it fires at (codex pass).
    const made = await call('POST', '/triggers', { id: 'authored', cron: '0 7 * * *', agent: 'worker-a', prompt: 'y' })
    expect(made.status).toBe(201)
    expect((made.body as unknown as { actor: string }).actor).not.toBe('worker-a')
    expect((made.body as unknown as { actor: string }).actor).toBe('api')
  })

  test('firing puts the prompt in the target’s mailbox exactly ONCE', async () => {
    const before = await mailboxOf('worker-a')
    const fired = await call('POST', '/triggers/weekly/fire', {})
    expect(fired.status).toBe(200)
    const after = await mailboxOf('worker-a')

    // THE WHOLE MAILBOX, not just the firings. Counting `trigger-fired` alone
    // would miss precisely the failure this test exists for: the old fire
    // wrote a `send` ALONGSIDE the firing so the prompt would reach a live
    // session, and under the rewrite's resolution table an agent-kind firing
    // already resolves to the target — so keeping both puts the same prompt
    // in the same mailbox twice, under two kinds. (Measured: a kind-filtered
    // count let that mutation through.)
    expect(after.length).toBe(before.length + 1)
    const arrived = after[after.length - 1]
    expect(arrived?.type).toBe('trigger-fired')
    expect((arrived?.data as unknown as { prompt: string }).prompt).toBe('review')
  })
})

describe('the knowledge surface', () => {
  test('memorize → the fact is findable, without waiting for a consolidation run', async () => {
    const written = await call(
      'POST',
      '/context/memorize',
      { agent: 'worker-a', role: 'worker', text: 'the kirkwall relay uses a rotating bearer token' },
      'worker-a',
    )
    expect(written.status).toBe(200)

    const found = (await get('/context/search?q=kirkwall%20relay&scope=knowledge')).body as unknown as {
      hits: { page: string }[]
      empty: boolean
    }
    expect(found.empty).toBe(false)
    expect(found.hits.length).toBeGreaterThan(0)
  })

  test('a query with nothing behind it is EMPTY, and empty is the signal it promises to be', async () => {
    const none = (await get('/context/search?q=zzyzx%20quicksilver')).body as unknown as { empty: boolean }
    expect(none.empty).toBe(true)
  })

  test('`?scope=` is REFUSED — an empty string is a value the caller sent, not an absent one', async () => {
    const blank = await get('/context/search?q=relay&scope=')
    expect(blank.status).toBe(400)
    expect((blank.body as unknown as { refusal: string }).refusal).toBe('invalid-scope')

    const typo = await get('/context/search?q=relay&scope=knowlege')
    expect(typo.status).toBe(400)
    expect((typo.body as unknown as { validScopes: string[] }).validScopes).toContain('knowledge')

    // …and an ABSENT scope is the default, not a refusal. The two cases the
    // polarity ruling separates, separated on the wire.
    expect((await get('/context/search?q=relay')).status).toBe(200)
  })

  test('a memory with no text is refused, and the refusal names itself', async () => {
    const bad = await call('POST', '/context/memorize', { agent: 'worker-a', role: 'worker', text: '   ' })
    expect(bad.status).toBe(400)
    expect((bad.body as unknown as { refusal: string }).refusal).toBe('missing-fields')
  })
})

describe('the send surface, completed', () => {
  test('`from` in the body is the author — the CLI has no session to be identified by', async () => {
    const sent = await call('POST', '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'ping' })
    expect(sent.status).toBe(200)
    expect((sent.body as unknown as { queued: boolean }).queued).toBe(true)
    const mail = await mailboxOf('worker-a')
    const last = mail[mail.length - 1]
    expect((last?.data as unknown as { from: string }).from).toBe('orchestrator-o')
  })

  test('attachments ride into the record instead of being dropped at the door', async () => {
    const sent = await call('POST', '/send', {
      from: 'orchestrator-o',
      to: 'worker-a',
      text: 'see the diff',
      attachments: ['docs/notes.md'],
    })
    expect(sent.status).toBe(200)
    const mail = await mailboxOf('worker-a')
    const last = mail[mail.length - 1]
    expect((last?.data as unknown as { attachments: string[] }).attachments).toEqual(['docs/notes.md'])
  })

  test('a malformed attachments field is the adapter’s own 400', async () => {
    const bad = await call('POST', '/send', { from: 'cli', to: 'worker-a', text: 'x', attachments: 'one-string' })
    expect(bad.status).toBe(400)
  })

  test('a LIVE delivery carries what the record carries — the whole message, not just its text', async () => {
    // The bridge is a `user` session: not a mailbox-holder, so this send goes
    // the adapter leg and is handed to the socket synchronously. That is the
    // only path where the payload's shape is observable — and it was
    // `{from, text}` while the record it wrote held taskId and attachments,
    // so a receiver reading `taskId` off the frame to attribute its reply got
    // nothing (codex pass). Recorded-with-context, delivered-without is the
    // exact asymmetry.
    await connect('chat-human', 'user')
    const sent = await call('POST', '/send', {
      from: 'orchestrator-o',
      to: 'chat-human',
      text: 'over to you',
      taskId: '042',
      attachments: ['notes.md'],
    })
    expect((sent.body as unknown as { delivered: boolean }).delivered).toBe(true)
    const frame = await pushedTo('chat-human', (f) => f.type === 'deliver')
    expect(frame).toBeDefined()
    expect(frame).toMatchObject({
      from: 'orchestrator-o',
      text: 'over to you',
      taskId: '042',
      attachments: ['notes.md'],
    })
  })

  test('an unroutable path still answers 404 — the surfaces do not swallow unknown routes', async () => {
    expect((await get('/nowhere')).status).toBe(404)
  })
})

describe('telemetry never takes an answer away', () => {
  test('a throwing retrieval log leaves the search it was recording untouched', async () => {
    // The port is best-effort by contract: it writes private query text to a
    // gitignored file. Unguarded, a full disk turns a search that already
    // succeeded into a 500 (codex pass).
    const own = await createAdapterServer({
      ports: {
        logRetrieval: () => {
          throw new Error('disk full')
        },
      },
    })
    const res = await fetch(`http://localhost:${own.port}/context/search?q=anything`)
    expect(res.status).toBe(200)
    expect((await res.json()) as { empty: boolean }).toMatchObject({ empty: true })
    own.stop()
  })
})
