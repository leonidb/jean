/**
 * THE NO-ORPHANS PROPERTY: every event in pending is in somebody's mailbox.
 *
 * ── WHY THIS FILE EXISTS ──
 *
 * Found by reading `pendingReducer` against `ruleFor` during the transition
 * (task 045), not by a failing test — and neither suite could have found it,
 * which is the reason it gets its own file rather than a line in an existing
 * one. The scenario suite tests the rules against a hand-built queue; the
 * integration tests never assert that the queue can be fully drained. The bug
 * lives exactly in the gap: between what the reducer ADMITS and what the rules
 * ADMIT TO.
 *
 * ── THE MECHANISM, WHICH IS WORTH UNDERSTANDING BEFORE CHANGING EITHER SIDE ──
 *
 * A mailbox is `concerns me AND I did not produce it`. The sensei's "concerns
 * me" is universal — it is the orchestrator — so the sensei is the only agent
 * that can be the last resort for an event nobody else claims. Which means: an
 * event the SENSEI authored, that nevertheless enters pending, is in NO
 * mailbox at all. Not the sensei's (it produced it), not any worker's (it does
 * not concern them).
 *
 * And an event in no mailbox is UNCLEARABLE, not merely unread. Under S5 a code
 * exists only in a fetch response, and a fetch returns a mailbox — so an event
 * outside every mailbox can never be fetched, can never yield a code, and can
 * never be acked. It sits in pending forever, inflating every count and every
 * `oldest` age, for the life of the dojo.
 *
 * The reducer already knows this and drops the sensei's own `task-comment` and
 * `register`. It KEEPS the sensei's `disconnect` on purpose. So the rules must
 * not treat that one as a self-event — see the note on `authorOf`.
 *
 * ── THE INVARIANT IS HELD HERE, NOT JUST THE INSTANCE ──
 *
 * Fixing one event type would leave the next one to be added exactly as exposed.
 * So the last case DERIVES the admitted types from the reducer's own source and
 * demands a fixture for each: adding a `case` to `pendingReducer` without
 * thinking about whose mailbox the event lands in turns this file red with the
 * type named. That is deliberately a source read — the same justification
 * `core/boundary.test.ts` gives for its guards: the property is invisible at
 * runtime until it costs something, and a table that drifts silently out of date
 * is worse than no table.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import { type PendingState, pendingReducer } from '../reducers.ts'
import { mailboxFor, type RuleContext } from './mailbox-rules.ts'

const SENSEI = 'sensei'
const WORKER = 'w1'
const ROLES: Record<string, string> = { [SENSEI]: 'sensei', [WORKER]: 'worker' }
const ctx: RuleContext = { roleOf: (name) => ROLES[name], taskOwner: () => undefined }

function ev(id: number, type: string, data: Record<string, unknown>): StoredEvent {
  return { id, stream: 'system', type, ts: new Date(id * 1000).toISOString(), data } as StoredEvent
}

/** Fold a log the way infra does, so the input to the rules is exactly what the
 *  reducer admits — the whole point is to test the two TOGETHER. */
function pendingFrom(log: StoredEvent[]): PendingState {
  let state: PendingState = []
  for (const e of log) state = pendingReducer(state, e)
  return state
}

function orphans(pending: PendingState, agents: string[]): StoredEvent[] {
  const claimed = new Set(agents.flatMap((a) => mailboxFor(pending, a, ctx).map((e) => e.id)))
  return pending.filter((e) => !claimed.has(e.id))
}

describe('no event admitted to pending is orphaned', () => {
  test("the sensei's OWN disconnect is claimable — the instance that was broken", () => {
    // One sensei restart. Before the fix this event was in pending and in no
    // mailbox, so it accumulated one per restart, permanently.
    const pending = pendingFrom([ev(1, 'disconnect', { agent: SENSEI })])
    expect(pending).toHaveLength(1) // the reducer keeps it, deliberately
    expect(orphans(pending, [SENSEI, WORKER])).toEqual([])
    // And it is the SENSEI that can clear it: a new session learning it was
    // restarted, which is the reducer's stated reason for keeping it.
    expect(mailboxFor(pending, SENSEI, ctx).map((e) => e.id)).toEqual([1])
  })

  test('a mixed log leaves nothing unclaimed', () => {
    const pending = pendingFrom([
      ev(1, 'disconnect', { agent: SENSEI }),
      ev(2, 'disconnect', { agent: WORKER }),
      ev(3, 'register', { agent: WORKER, role: 'worker', idle: true }),
      ev(4, 'register', { agent: SENSEI, role: 'sensei', idle: true }),
      ev(5, 'reply', { agent: WORKER, text: 'done' }),
      ev(6, 'task-comment', { agent: SENSEI, role: 'sensei', text: 'noted' }),
      ev(7, 'task-comment', { agent: WORKER, role: 'worker', text: 'found it' }),
      ev(8, 'task-created', { title: 't', description: '', queue: 'w1' }),
      ev(9, 'trigger-fired', { agent: SENSEI, kind: 'prompt' }),
    ])
    expect(pending.length).toBeGreaterThan(0)
    expect(orphans(pending, [SENSEI, WORKER])).toEqual([])
  })

  test("an agent's own utterances stay OUT of its mailbox — the rule this must not undo", () => {
    // The fix narrows one case; it must not have widened the self-event rule
    // into uselessness. A worker's own reply is still not its own inbox item.
    const pending = pendingFrom([ev(1, 'reply', { agent: WORKER, text: 'done' })])
    expect(mailboxFor(pending, WORKER, ctx)).toEqual([])
    expect(mailboxFor(pending, SENSEI, ctx).map((e) => e.id)).toEqual([1])
  })

  /**
   * EVERY type the reducer admits, in its most adversarial form.
   *
   * The sensei-authored variant is the one that can orphan, because the sensei's
   * mailbox is the only universal one — so each type gets both, and a type with
   * no meaningful author gets the same fixture twice (harmless, and cheaper than
   * a second table saying which is which).
   */
  const FIXTURES: Record<string, Array<Record<string, unknown>>> = {
    // WORKER ONLY, and the omission is the finding. This table's first version
    // included a sensei-authored `reply` and it came back ORPHANED — correctly,
    // because `pendingReducer` admits every reply unconditionally while the
    // mailbox rules treat it as a self-event.
    //
    // It is unreachable, but NOT by anything the reducer can see: a `reply`
    // carries no role, so the projection cannot tell who wrote it. The drop
    // happens at the WS boundary ("dropping reply from sensei … sensei must use
    // `send` with an explicit recipient", server.ts) and is asserted
    // behaviourally in `flow.test.ts` — "ws reply from sensei is dropped — no
    // reply or send event recorded".
    //
    // So the invariant is held JOINTLY here, by one adapter branch plus these
    // rules, and that is worth knowing rather than papering over: if a second
    // path ever records a sensei reply — an HTTP route, a bridge, a peer — it
    // orphans one event per reply and nothing in the projection layer can catch
    // it. RAISED alongside the general invariant.
    reply: [{ agent: WORKER, text: 'x' }],
    'task-created': [{ title: 't', description: '', queue: WORKER, actor: SENSEI }],
    'playbook-created': [{ id: 'p', name: 'p' }],
    'playbook-updated': [{ id: 'p', name: 'p' }],
    'playbook-removed': [{ id: 'p' }],
    // Headless firings never enter pending; the prompt kind does, addressed to
    // an agent — `data.agent` is the TARGET here, not an author, which is the
    // `data.agent`-means-five-things trap `authorOf` switches on type to avoid.
    'trigger-fired': [
      { agent: SENSEI, kind: 'prompt' },
      { agent: WORKER, kind: 'prompt' },
    ],
    'wiki-consolidated': [{ pagesUpdated: 1 }],
    'task-comment': [
      { agent: SENSEI, role: 'sensei', text: 'x' },
      { agent: WORKER, role: 'worker', text: 'x' },
    ],
    register: [
      { agent: SENSEI, role: 'sensei', idle: true },
      { agent: WORKER, role: 'worker', idle: true },
    ],
    disconnect: [{ agent: SENSEI }, { agent: WORKER }],
    // QUEUED sends only — an unflagged send never enters pending, so its
    // author cannot orphan it. The sensei-authored form is the adversarial
    // one: self-excluded from the universal mailbox, claimed by its addressee.
    // The remaining hazard is held JOINTLY at the adapter, like the
    // sensei-reply above: `routeSend` sets `queued` only for names with dojo
    // register history, so a sensei send to a typo'd name records unflagged
    // and stays out of pending — if a second path ever writes `queued: true`
    // without that check, a sensei send to nobody orphans.
    send: [
      { agent: WORKER, from: SENSEI, text: 'x', queued: true },
      { agent: WORKER, from: 'api', text: 'x', queued: true },
    ],
    // Subject is only ever a WORKER (the supervisor watches role 'worker'
    // exclusively), so the sensei's universal mailbox always claims these —
    // jointly held, like the sensei-reply. A sensei-subject fixture here would
    // demand support for an event the system cannot emit.
    'worker-status': [{ agent: WORKER, status: 'down' }],
    // BOTH subjects, and the sensei one is load-bearing: S11 watches the
    // sensei too (E6), so the report about it must be claimable BY it — which
    // is why authorOf treats this type like `disconnect`, not like a
    // self-event. The first draft of the unification excluded it and THIS
    // test's invariant caught the orphan before it shipped.
    'agent-unresponsive': [
      { agent: SENSEI, to: 'chat-human' },
      { agent: WORKER, to: SENSEI },
    ],
    // The S7/S8 nag (task 050). Infra-authored — `data.agent` deliberately
    // absent (five-meanings trap: the addressee lives in `to`) — so no
    // self-event rule can drop it. The BRIDGE-addressed form is the
    // adversarial one: its addressee has no mailbox at all, and the sensei's
    // universal claim is the whole of what keeps it clearable. Held jointly
    // with the adapter, like the queued send: the supervisor only ever
    // addresses a resolved holder, and a holderless dojo emits nothing.
    'task-reminder': [
      { taskId: '044', to: SENSEI, text: 'Task 044 (t) is waiting on sensei.', queued: true },
      { taskId: '044', to: 'chat-human', text: 'Task 044 (t) is waiting on human.', queued: true },
    ],
  }

  test('THE INVARIANT: no admitted event type can be orphaned — checked against the reducer itself', async () => {
    // Derived, not listed. A `case` added to `pendingReducer` with no fixture
    // here fails THIS assertion by name, which is the whole point: the next type
    // to be added is the next chance to orphan something.
    const source = await Bun.file(new URL('../reducers.ts', import.meta.url)).text()
    const start = source.indexOf('export const pendingReducer')
    expect(start).toBeGreaterThan(-1) // drift shows up here, not as a silent pass
    // BOUNDED AT THE NEXT TOP-LEVEL EXPORT. The first draft sliced to end-of-file
    // and swept in the TRIGGER reducer's cases — the test caught its own
    // over-reach by demanding fixtures for `trigger-created`/`-updated`/
    // `-removed`, which `pendingReducer` never sees. An unbounded slice would
    // have kept working right up until someone wrote the fixtures it asked for.
    const end = source.indexOf('\nexport ', start + 1)
    const body = source.slice(start, end === -1 ? undefined : end)
    const admitted = [...body.matchAll(/case '([\w-]+)'/g)]
      .map((m) => m[1] as string)
      // `ack` REMOVES from pending rather than admitting to it — the one case in
      // the switch that is not an admission.
      .filter((type) => type !== 'ack')

    expect(admitted.length).toBeGreaterThan(0) // the slice found the reducer at all
    expect(admitted.filter((t) => !(t in FIXTURES))).toEqual([])

    const log = admitted.flatMap((type, i) =>
      (FIXTURES[type] as Array<Record<string, unknown>>).map((data, j) => ev(i * 10 + j + 1, type, data)),
    )
    const pending = pendingFrom(log)
    // Not vacuous: the reducer must actually have admitted a useful share of
    // them, or "nothing is orphaned" would be true of an empty queue.
    expect(pending.length).toBeGreaterThan(admitted.length / 2)
    expect(orphans(pending, [SENSEI, WORKER]).map((e) => `${e.id}:${e.type}`)).toEqual([])
  })
})
