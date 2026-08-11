/**
 * DELIVERY UNIFICATION — the fold side: queued sends enter pending, the
 * write site decides, and every admitted event lands in at least one mailbox.
 * LEVEL: projection (a log in → pending/mailboxes out; pure).
 *
 * Companion to `unification.wiring.test.ts` (the adapter half). The ruling,
 * 2026-08-11: "The message gets into the mailbox, and from there notifications
 * work the same for any agent."
 *
 * ── WRITE-SITE DECIDES, THE FOLD APPLIES (the applyAck pattern, again) ──
 *
 * The pending reducer is pure over events and cannot consult the registry, so
 * WHETHER a send queues is decided at `routeSend` and recorded ON the event
 * (`queued: true`). The fold admits exactly what the write site decided. That
 * is also what keeps history safe: every send already in every dojo's log
 * predates the flag, so replay admits none of them — the alternative (admit
 * all sends) would resurrect months of long-delivered messages into pending on
 * the first restart after the deploy.
 *
 * ── THE A2 INVARIANT, EXTENDED TO THE NEW TYPES ──
 *
 * Task 045's casualty round raised it: every event admitted to pending must be
 * in at least one agent's mailbox — an event in nobody's mailbox can never be
 * fetched, so it can never be acked, forever. The new admissions must honor
 * it: queued sends resolve to their addressee; `worker-status` and
 * `agent-unresponsive` are subject-self-events (the sensei's mailbox carries
 * them; the subject has no use for its own status notice).
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { pendingReducer } from '../infra/reducers.ts'
import { mailboxFor, type RuleContext } from '../infra/target/mailbox-rules.ts'
import { ev, foldWith } from './harness.ts'

const SENSEI = 'sensei'
const WORKER = 'builder'

const ROLES: Record<string, string> = { [SENSEI]: 'sensei', [WORKER]: 'worker', mason: 'worker' }
const ctx: RuleContext = {
  roleOf: (name) => ROLES[name],
  taskOwner: () => undefined,
}

const pendingOf = (log: StoredEvent[]) => foldWith(pendingReducer, [] as StoredEvent[], log)

describe('queued sends enter pending — the write site decides, the fold applies', () => {
  test('a send recorded `queued: true` is admitted', () => {
    const queued = ev('send', `agent-${WORKER}`, { agent: WORKER, from: 'api', text: 'do it', queued: true })
    expect(pendingOf([queued])).toContain(queued)
  })

  test('GUARD — a historical send (delivered, no flag) stays out on replay', () => {
    // The shape every dojo's log already holds. Admitting it would resurrect
    // long-delivered traffic into pending at the first post-deploy restart —
    // the historical-tolerance failure class, through a new door.
    const historical = ev('send', `agent-${WORKER}`, { agent: WORKER, from: SENSEI, text: 'old news', delivered: true })
    expect(pendingOf([historical])).not.toContain(historical)
  })

  test('a queued send is in its ADDRESSEE’s mailbox, and in the sensei’s — one list, two filters', () => {
    const queued = ev('send', `agent-${WORKER}`, { agent: WORKER, from: 'api', text: 'do it', queued: true })
    const pending = pendingOf([queued])
    expect(mailboxFor(pending, WORKER, ctx)).toContain(queued)
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(queued)
  })

  test('a SENSEI-authored queued send is not in the sensei’s own mailbox — but is in the worker’s', () => {
    // "Concerns me AND I did not produce it." The dispatch the sensei just
    // wrote is not something the sensei has to act on; the worker acts on it,
    // and acks it when done. This is the shape every dispatch takes now.
    const dispatch = ev('send', `agent-${WORKER}`, {
      agent: WORKER,
      from: SENSEI,
      text: 'task 9 is yours',
      queued: true,
    })
    const pending = pendingOf([dispatch])
    expect(mailboxFor(pending, WORKER, ctx)).toContain(dispatch)
    expect(mailboxFor(pending, SENSEI, ctx)).not.toContain(dispatch)
  })

  test('a queued send to a worker is NOT in another worker’s mailbox', () => {
    const forMason = ev('send', 'agent-mason', { agent: 'mason', from: SENSEI, text: 'yours', queued: true })
    const pending = pendingOf([forMason])
    expect(mailboxFor(pending, WORKER, ctx)).not.toContain(forMason)
    expect(mailboxFor(pending, 'mason', ctx)).toContain(forMason)
  })
})

describe('worker-status and agent-unresponsive ride the mailbox (H4)', () => {
  test('a worker-status event enters pending and lands in the sensei’s mailbox, not its subject’s', () => {
    // "The sensei receives worker status-change events." The mailbox IS the
    // receiving; a stuck worker's own mailbox must not carry its stuck notice
    // (the subject-self rule that already covers register/agent-idle).
    const down = ev('worker-status', `agent-${WORKER}`, { agent: WORKER, status: 'down' })
    const pending = pendingOf([down])
    expect(pending).toContain(down)
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(down)
    expect(mailboxFor(pending, WORKER, ctx)).not.toContain(down)
  })

  test('an agent-unresponsive report enters pending — the no-bridge fallback rides the mailbox', () => {
    // The H4 ruling's exact words: "the no-bridge fallback rides normal
    // mailbox + backstop." The event is the report; the sensei's mailbox and
    // the S2 clock are its delivery.
    const report = ev('agent-unresponsive', `agent-${WORKER}`, { agent: WORKER, to: SENSEI })
    const pending = pendingOf([report])
    expect(pending).toContain(report)
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(report)
  })

  test('the S7/S8 waiting-task nag enters pending and lands in the sensei’s mailbox (task 050)', () => {
    // The third supervision arm joins the other two. RULED 2026-08-11: the
    // mailbox is THE path for how agents receive messages — the nag's old life
    // as a bare channel push with a bookkeeping event was the defect, not the
    // design. `queued: true` is the write-site admission flag (the send
    // precedent); the nag rides the SYSTEM stream and names its task in data.
    const nag = ev('task-reminder', 'system', {
      taskId: '044',
      to: SENSEI,
      text: 'Task 044 (red suite) is waiting on sensei.',
      queued: true,
    })
    const pending = pendingOf([nag])
    expect(pending).toContain(nag)
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(nag)
  })

  test('GUARD — a historical task-reminder (bookkeeping, no flag) stays out on replay', () => {
    // Every dojo's log holds these: the pre-050 arm recorded `{taskId, to}`
    // AFTER each push, as bookkeeping. Admitting them would resurrect months
    // of long-stale nags into the sensei's mailbox at the first restart — the
    // queued-send hazard, through a new door.
    const historical = ev('task-reminder', 'system', { taskId: '007', to: SENSEI })
    expect(pendingOf([historical])).not.toContain(historical)
  })

  test('the nag is NOT in the parked worker’s mailbox — the S7 inversion survives the mailbox move', () => {
    // The one addressee rule that must not regress: the worker that parked the
    // task cannot be un-stuck by being asked again. Even with the board
    // attributing task 044 to the worker, the nag rides the system stream and
    // resolves to no worker — only the sensei's universal mailbox (or the
    // bridge push) carries it.
    const nag = ev('task-reminder', 'system', {
      taskId: '044',
      to: SENSEI,
      text: 'Task 044 (red suite) is waiting on sensei.',
      queued: true,
    })
    const owns: RuleContext = { roleOf: ctx.roleOf, taskOwner: (id) => (id === '044' ? { agent: WORKER } : undefined) }
    const pending = pendingOf([nag])
    expect(mailboxFor(pending, WORKER, owns)).not.toContain(nag)
    expect(mailboxFor(pending, SENSEI, owns)).toContain(nag)
  })

  test('a BRIDGE-addressed nag is claimable by the sensei — the human has no mailbox to orphan it in', () => {
    // S8's human holder: the push went to the bridge surface; the event is the
    // report of record, and the sensei's universal mailbox is where it can be
    // read and acked (A2: admitted ⇒ in at least one mailbox).
    const nag = ev('task-reminder', 'system', {
      taskId: '044',
      to: 'chat-human',
      text: 'Task 044 (red suite) is waiting on human.',
      queued: true,
    })
    const pending = pendingOf([nag])
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(nag)
    expect(mailboxFor(pending, WORKER, ctx)).not.toContain(nag)
  })

  test('a report about the SENSEI is claimable by the sensei — the disconnect precedent, not the self-event rule', () => {
    // AMENDED FROM THE FIRST RED DRAFT, which excluded every unresponsive
    // report from its subject's mailbox. The invariant test in
    // core/mailbox-rules.test.ts caught what that would do: S11 watches the
    // sensei too (E6), and the sensei's mailbox is the only universal one — a
    // sensei-subject report treated as a self-event would be in pending and in
    // NOBODY's mailbox, unclearable forever. Disconnect's reasoning applies
    // verbatim: the reader is a recovered session learning it was reported
    // broken while it was gone, and that is news.
    const report = ev('agent-unresponsive', `agent-${SENSEI}`, { agent: SENSEI, to: 'chat-human' })
    const pending = pendingOf([report])
    expect(pending).toContain(report)
    expect(mailboxFor(pending, SENSEI, ctx)).toContain(report)
  })
})
