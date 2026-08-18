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
    const one = `http://localhost:${first.port}`
    const reg = (agent: string, role: string) =>
      new Promise<WebSocket>((done) => {
        const ws = new WebSocket(`ws://localhost:${first.port}/ws`)
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
    const two = `http://localhost:${second.port}`
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
