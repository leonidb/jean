/**
 * The restart fixture — its own file because it creates and stops its own
 * servers, and a suite that shares one server cannot also tear down two more
 * without its teardown racing them.
 */

import { describe, expect, test } from 'bun:test'
import { createAdapterServer } from './server.ts'

describe('the log is the state — a restart answers from it', () => {
  test('mail queued before a restart is still there after one, and its ack still clears', async () => {
    const dir = `/tmp/jean-e1-${Date.now()}`
    await Bun.write(`${dir}/.keep`, '')

    const first = await createAdapterServer({ dataDir: dir })
    const one = `http://127.0.0.1:${first.port}`
    const reg = (agent: string, role: string) =>
      new Promise<WebSocket>((done) => {
        const ws = new WebSocket(`ws://127.0.0.1:${first.port}/ws`)
        ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role }))
        ws.onmessage = () => done(ws)
      })
    const a = await reg('orchestrator-r', 'sensei')
    const b = await reg('worker-r', 'worker')
    await fetch(`${one}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-r' },
      body: JSON.stringify({ to: 'worker-r', text: 'survive the restart' }),
    })
    a.close()
    b.close()
    first.stop()

    // A NEW server over the SAME log. Without the boot replay this answered
    // from an empty projection while the store kept counting ids from disk —
    // state and log disagreeing, silently.
    const second = await createAdapterServer({ dataDir: dir })
    const two = `http://127.0.0.1:${second.port}`
    const box = (await (await fetch(`${two}/events?agent=worker-r`)).json()) as {
      events: { id: number; code: string }[]
    }
    expect(box.events.length).toBe(1)

    const survivor = box.events[0]
    if (survivor === undefined) throw new Error('unreachable')
    const acked = (await (
      await fetch(`${two}/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jean-agent': 'worker-r' },
        body: JSON.stringify({ pairs: [{ id: survivor.id, code: survivor.code }] }),
      })
    ).json()) as { acknowledged?: number }
    // The code minted before the restart still opens it: codes are derived
    // from content, so they survive the process that issued them.
    expect(acked.acknowledged).toBe(1)
    second.stop()
  })
})

describe('a register written before task 139 is history on replay; one written after is still mail', () => {
  test('a log of unflagged registers replays to an empty orchestrator mailbox — the seat is greeted, not handed its fleet’s past', async () => {
    // Every real log holds dozens of pre-139 registers, all unacked (they
    // were history when written, and nothing acks history). Without the
    // admission flag on the row the first restart after 139 would resurrect
    // every one of them into the orchestrator's mailbox.
    const dir = `/tmp/jean-139-${Date.now()}`
    const good = new Date(1_700_000_000_000).toISOString()
    const lines = [
      {
        id: 1,
        ts: good,
        type: 'register',
        stream: 'agent-orchestrator-r',
        data: { agent: 'orchestrator-r', role: 'sensei', idle: false },
      },
      {
        id: 2,
        ts: good,
        type: 'register',
        stream: 'agent-worker-a',
        data: { agent: 'worker-a', role: 'worker', idle: false },
      },
      {
        id: 3,
        ts: good,
        type: 'register',
        stream: 'agent-worker-b',
        data: { agent: 'worker-b', role: 'worker', idle: false },
      },
      {
        id: 4,
        ts: good,
        type: 'register',
        stream: 'agent-bridge-u',
        data: { agent: 'bridge-u', role: 'user', idle: true },
      },
      // …and ONE written by a 139 process before this restart: mail that
      // survives, because the log is the state.
      {
        id: 5,
        ts: good,
        type: 'register',
        stream: 'agent-worker-c',
        data: { agent: 'worker-c', role: 'worker', idle: true, queued: true },
      },
    ]
    await Bun.write(`${dir}/history.jsonl`, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

    const server = await createAdapterServer({ dataDir: dir })
    const base = `http://127.0.0.1:${server.port}`
    const box = (await (await fetch(`${base}/events?agent=orchestrator-r`)).json()) as {
      events: { id: number; type: string; data: { agent?: string } }[]
    }
    // Exactly the flagged one — three unflagged registers and the sensei's
    // own resolved to nobody.
    expect(box.events.map((e) => [e.type, e.data.agent])).toEqual([['register', 'worker-c']])

    // The seat connects: mail waiting (the flagged register) → announced,
    // not greeted, and its own fresh register is not added to its mailbox.
    const ws = await new Promise<WebSocket>((done) => {
      const s = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
      s.onopen = () => s.send(JSON.stringify({ type: 'register', agent: 'orchestrator-r', role: 'sensei' }))
      s.onmessage = (ev) => {
        if ((JSON.parse(String(ev.data)) as { type: string }).type === 'registered') done(s)
      }
    })
    const after = (await (await fetch(`${base}/events?agent=orchestrator-r`)).json()) as {
      events: { type: string; data: { agent?: string } }[]
    }
    expect(after.events.map((e) => [e.type, e.data.agent])).toEqual([['register', 'worker-c']])
    ws.close()
    await server.stop()
  })
})
