/**
 * Routing conformance — the executable form of the routing contract.
 * RED BY ABSENCE until D6 lands `src/domain/routing/index.ts` exporting
 * `routing: RoutingContract`.
 */

import { describe, expect, test } from 'bun:test'
import type { RoutingContract, SendCommand } from './routing.ts'

const IMPL_PATH: string = '../routing/index.ts'
const routing: RoutingContract = await import(IMPL_PATH)
  .then((m) => (m as { routing: RoutingContract }).routing)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/routing/index.ts does not exist yet. ' +
          'Task D6 implements the RoutingContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const cmd: SendCommand = { from: 'orchestrator-o', to: 'worker-a', text: 'go' }

describe('streams', () => {
  test('a task-attributed send lands on the task stream; otherwise the target’s agent stream', () => {
    expect(routing.streamFor('worker-a', '101')).toBe('task-101')
    expect(routing.streamFor('worker-a')).toBe('agent-worker-a')
  })
})

describe('the queue-vs-adapter line: mailbox-holding, one question asked once', () => {
  test('a connected dojo agent queues — the mailbox is truth — for BOTH mailbox-holding roles', () => {
    const d = routing.decideSend(cmd, { liveRole: 'worker', isDojoAgentEver: true })
    expect(d.route).toBe('queue')
    if (d.route === 'queue') {
      expect(d.data.queued).toBe(true) // the admission flag, set here and only here
      expect(d.data.agent).toBe('worker-a')
      expect(d.stream).toBe('agent-worker-a')
    }
    const toSensei = routing.decideSend(
      { ...cmd, from: 'worker-a', to: 'orchestrator-o' },
      { liveRole: 'sensei', isDojoAgentEver: true },
    )
    expect(toSensei.route).toBe('queue')
    // A LIVE mailbox-holder queues regardless of the record — the live
    // session decides when present (codex pass, 092).
    const liveButUnrecorded = routing.decideSend(cmd, { liveRole: 'worker', isDojoAgentEver: false })
    expect(liveButUnrecorded.route).toBe('queue')
  })

  test('a DISCONNECTED dojo agent still queues — being away costs nothing, and the sender is never warned', () => {
    const d = routing.decideSend(cmd, { liveRole: undefined, isDojoAgentEver: true })
    expect(d.route).toBe('queue')
    // The queue branch has no notice mechanism at all — structurally: the
    // variant carries none. This assertion exists to keep it that way.
    expect('undeliveredNotice' in d).toBe(false)
  })

  test('THE PROVENANCE PIN (D6 hold): one record, two live states, two routes — the pair the conflated facts could not tell apart', () => {
    // The defect: a dojo agent whose record also holds a user registration.
    // CONNECTED as user → the live session is where the name is reachable →
    // adapter. DISCONNECTED → the record decides → QUEUE (the old contract
    // collapsed both into one tuple, and a merely-away mailbox-holder had
    // its mail handed to a dead adapter).
    const connectedAsUser = routing.decideSend(cmd, { liveRole: 'user', isDojoAgentEver: true })
    expect(connectedAsUser.route).toBe('adapter')
    const merelyAway = routing.decideSend(cmd, { liveRole: undefined, isDojoAgentEver: true })
    expect(merelyAway.route).toBe('queue')
  })

  test('a name connected as a NON-dojo role routes to the adapter even if its record says dojo (live precedence)', () => {
    const d = routing.decideSend(cmd, { liveRole: 'user', isDojoAgentEver: true })
    expect(d.route).toBe('adapter')
  })

  test('an unknown name routes to the adapter, and a failed handover tells the sender — never a silent success', () => {
    const d = routing.decideSend({ ...cmd, to: 'nobody-ever' }, { liveRole: undefined, isDojoAgentEver: false })
    expect(d.route).toBe('adapter')
    if (d.route === 'adapter') {
      const failed = d.data(false)
      expect(failed.delivered).toBe(false)
      expect(failed.queued).toBeUndefined() // never the admission flag on the adapter path
      expect(d.undeliveredNotice(false)).toBeTruthy()
      const landed = d.data(true)
      expect(landed.delivered).toBe(true)
      expect(d.undeliveredNotice(true)).toBeUndefined()
    }
  })
})

describe('enrichment and payload fidelity', () => {
  test('a peer sender is enriched from the receiver’s OWN record — frozen, not sender-supplied — on BOTH routes', () => {
    const d = routing.decideSend(
      { ...cmd, from: 'peer-dojo' },
      { liveRole: 'worker', isDojoAgentEver: true, senderPeerDescription: 'the demo dojo' },
    )
    expect(d.route).toBe('queue')
    if (d.route === 'queue') {
      expect(d.data.senderRole).toBe('peer')
      expect(d.data.peerDescription).toBe('the demo dojo')
    }
    const viaAdapter = routing.decideSend(
      { ...cmd, from: 'peer-dojo', to: 'bridge-user' },
      { liveRole: undefined, isDojoAgentEver: false, senderPeerDescription: 'the demo dojo' },
    )
    expect(viaAdapter.route).toBe('adapter')
    if (viaAdapter.route === 'adapter') {
      expect(viaAdapter.data(true).senderRole).toBe('peer')
      expect(viaAdapter.data(true).peerDescription).toBe('the demo dojo')
    }
  })

  test('attachments ride only when present; text and sender always do', () => {
    const bare = routing.decideSend(cmd, { liveRole: 'worker', isDojoAgentEver: true })
    if (bare.route === 'queue') expect('attachments' in bare.data).toBe(false)
    const withFiles = routing.decideSend(
      { ...cmd, attachments: ['/tmp/a.png'] },
      { liveRole: 'worker', isDojoAgentEver: true },
    )
    if (withFiles.route === 'queue') {
      expect(withFiles.data.attachments).toEqual(['/tmp/a.png'])
      expect(withFiles.data.from).toBe('orchestrator-o')
      expect(withFiles.data.text).toBe('go')
    }
  })
})
