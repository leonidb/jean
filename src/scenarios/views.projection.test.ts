/**
 * THE THREE VIEWS + THE MAILBOX FILTER MECHANISM + OPAQUE PRIORITY.
 * LEVEL: projection (pending list in → view objects out; no listener, no server).
 *
 * CANON (013 VOCABULARY + S4): three views — **counts** (numbers by priority) →
 * **summary** (`priority · from · message` per event) → **fetch** (everything +
 * the ack code). "Priority is an opaque number … agents know only that higher
 * outranks lower — no semantics in any agent-facing surface or skill text."
 *
 * RULING (c), Leonid 2026-08-05, which dissolved the overlap-vs-partition
 * question this file was blocked on: the views are PROJECTIONS BASED ON FILTERS
 * over the same list; the answer can be in between; design it flexibly. So:
 * ONE pending list, each agent's mailbox is a named filter over it, the rules
 * live in one module and are DIALS.
 *
 * ── HOW THIS FILE SPLITS CONTRACT FROM DIAL, AND WHY IT MATTERS ──
 *
 * A dial that breaks a test is a dial nobody can turn. So:
 *   - CONTRACT cases assert the MECHANISM — views are consistent filters of the
 *     one list; an event is in a view iff the rule admits it; nothing is
 *     invented or rewritten. These must survive any rule-set.
 *   - DIAL cases assert the INITIAL rule-set (today's semantics) and say so at
 *     the assertion. If a ruling changes the rules, only these move.
 * If a rule change breaks a CONTRACT case, the change was not a dial.
 *
 * STATUS: RED — `viewsFor`, `mailboxFor`, `ruleFor`, `priorityOf` all throw.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { mailboxFor, type RuleContext, ruleFor } from '../infra/target/mailbox-rules.ts'
import { priorityOf } from '../infra/target/priority.ts'
import { viewsFor } from '../infra/target/views.ts'
import { ev, humanSays, workerSays } from './harness.ts'

const SENSEI = 'sensei'
const WORKER = 'builder'
const HUMAN = 'chat-human'

const ROLES: Record<string, string> = { [SENSEI]: 'sensei', [WORKER]: 'worker', [HUMAN]: 'user' }

const ctx: RuleContext = {
  roleOf: (name) => ROLES[name],
  taskOwner: (taskId) => (taskId === '001' ? { agent: WORKER, queue: 'builder' } : undefined),
}

/** One queue used by most cases below, deliberately mixed: a human, a worker,
 *  a task-scoped event, and one the sensei itself produced. */
function queue(): StoredEvent[] {
  return [
    humanSays(HUMAN, 'ship it?'),
    workerSays(WORKER, 'branch pushed'),
    ev('task-comment', 'task-001', { agent: WORKER, role: 'worker', text: 'found the leak' }),
    ev('task-comment', 'task-001', { agent: SENSEI, role: 'sensei', text: 'noted' }),
    // ADDRESSED to the worker rather than produced by it — it resolves to
    // `builder` through the task's queue, and nobody authored it. Added when
    // the rule became "concerns me AND I did not produce it": without an event
    // of this shape the worker case asserted a non-empty mailbox using only
    // events the worker had written itself.
    ev('task-created', 'task-001', { title: 'ship the suite', description: '', queue: 'builder' }),
  ]
}

// ── CONTRACT: the mailbox is a filter of the one list ────────────────

describe('CONTRACT — every mailbox is a consistent filter of one pending list', () => {
  test('a mailbox is a SUBSET of the list, in the list’s order, with nothing invented', () => {
    const pending = queue()
    const mine = mailboxFor(pending, SENSEI, ctx)

    // Identity, not equality: every element must BE an element of the input.
    // A view that rebuilt events (even into something equal) would be a second
    // projection wearing a filter's clothes, which is exactly what ruling (c)
    // says not to build.
    for (const e of mine) expect(pending).toContain(e)

    // ORDER PRESERVED, STATED AGAINST THE SOURCE LIST. The first draft compared
    // `mine`'s ids to `mine`'s own ids SORTED — which proves `mine` is sorted,
    // not that it preserves `pending`'s order. The two coincide only because
    // this fixture happens to be built in ascending id order, so the assertion
    // would have kept passing over a mailbox that had reordered the queue.
    // Codex's finding; the requirement is a filter, and a filter cannot reorder.
    expect(mine.map((e) => e.id)).toEqual(pending.filter((e) => mine.includes(e)).map((e) => e.id))
  })

  test('an event is in a mailbox IFF that agent’s rule admits it — no second condition', () => {
    // The failure this forbids: a view layer that quietly drops or adds one
    // event on top of the rule. Then counts and summary tell different stories
    // about the same queue and nobody can find out why from the rules module.
    const pending = queue()
    for (const agent of [SENSEI, WORKER]) {
      const rule = ruleFor(agent, ctx)
      const box = mailboxFor(pending, agent, ctx)
      for (const e of pending) {
        expect(box.includes(e)).toBe(rule(e, agent, ctx))
      }
    }
  })

  test('all three views describe the SAME membership — they differ in rendering only', () => {
    const pending = queue()
    const v = viewsFor(pending, SENSEI, ctx)
    const box = mailboxFor(pending, SENSEI, ctx)

    const total = Object.values(v.counts()).reduce((a, b) => a + b, 0)
    expect(total).toBe(box.length)
    expect(v.summary().map((l) => l.id)).toEqual(box.map((e) => e.id))
    expect(v.fetch().map((f) => f.id)).toEqual(box.map((e) => e.id))
  })

  test('an empty mailbox is an empty view, not an absent one', () => {
    const v = viewsFor([], WORKER, ctx)
    expect(v.summary()).toEqual([])
    expect(v.fetch()).toEqual([])
    expect(Object.values(v.counts()).reduce((a, b) => a + b, 0)).toBe(0)
  })
})

// ── DIAL: the initial rule-set is today's semantics ──────────────────

describe('DIAL — the initial rule-set (today’s semantics), turnable without architecture change', () => {
  test('DIAL: the sensei sees everything except its own self-events', () => {
    // CHARACTERIZATION OF A DIAL, not a contract. Leonid's example, verbatim
    // intent: "no need for the sensei to see a message he himself sent to a
    // worker as his own event — which is already today's behavior."
    const pending = queue()
    const box = mailboxFor(pending, SENSEI, ctx)
    const senseiAuthored = pending.filter((e) => (e.data as { role?: string }).role === 'sensei')
    expect(senseiAuthored.length).toBeGreaterThan(0) // the case would be vacuous otherwise
    for (const e of senseiAuthored) expect(box).not.toContain(e)
    expect(box).toHaveLength(pending.length - senseiAuthored.length)
  })

  test('DIAL: a worker sees its addressed slice', () => {
    // Also characterization. Under ruling (c) the sensei/worker overlap is
    // deliberately unfixed — what must hold is that BOTH answers come from the
    // same list through the same mechanism, which the CONTRACT block above pins.
    const pending = queue()
    const box = mailboxFor(pending, WORKER, ctx)
    expect(box).not.toContain(pending[0] as StoredEvent) // the human's message is not addressed to the worker
    // The task addressed to it, and ONLY that: its own reply and its own
    // comment are things it said, not things it has to act on.
    expect(box.map((e) => e.type)).toEqual(['task-created'])
  })
})

// ── THE LADDER: each rung costs more and tells more ──────────────────

describe('the three views — the triage ladder (S4, S5)', () => {
  test('counts carries NUMBERS BY PRIORITY and nothing else — no ids, no text', () => {
    const v = viewsFor(queue(), SENSEI, ctx)
    const counts = v.counts()
    for (const [key, value] of Object.entries(counts)) {
      // Keys are the opaque priority numbers themselves. A label key here
      // ("high", "urgent") is the exact leak the opacity requirement forbids.
      expect(key).toMatch(/^\d+$/)
      expect(typeof value).toBe('number')
    }
  })

  test('summary carries NO details and NO code — that is what makes it cheap', () => {
    // S4: "can read the summary view WITHOUT FETCHING BODIES". Details here
    // would defeat the purpose; a code here would defeat read-before-ack (S5) by
    // making the cheap rung sufficient to clear.
    const lines = viewsFor(queue(), SENSEI, ctx).summary()
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual(['from', 'id', 'message', 'priority'])
    }
  })

  test('fetch carries everything AND the code — the only rung that carries either', () => {
    const fetched = viewsFor(queue(), SENSEI, ctx).fetch()
    expect(fetched.length).toBeGreaterThan(0)
    for (const f of fetched) {
      expect(typeof f.code).toBe('string')
      expect(f.code.length).toBeGreaterThan(0)
    }
    // Codes are PER EVENT, not per response: two events must not share one, or
    // "acking is explicit {id, code} pairs" collapses into a single token that
    // clears the batch — `upToId` with extra steps.
    expect(new Set(fetched.map((f) => f.code)).size).toBe(fetched.length)
  })

  test('the summary’s message obeys the vocabulary — derived, with the marker’s promise intact', () => {
    const long = 'first line\nsecond line\nthird'
    const pending = [humanSays(HUMAN, long)]
    const v = viewsFor(pending, SENSEI, ctx)
    const line = v.summary()[0]
    const fetched = v.fetch()[0]
    expect(line?.message).toBe(fetched?.message)
    // The summary promised more; the fetch delivers the COMPLETE original.
    expect(fetched?.details).toBe(long)
  })
})

// ── OPAQUE PRIORITY ──────────────────────────────────────────────────

describe('priority is an opaque number — order only, no semantics anywhere agent-facing', () => {
  test('REQUIREMENT — an external channel outranks everything else', () => {
    // The requirement is the ORDER and nothing else: "agents know only that
    // higher outranks lower". Split from the literals below after Codex found
    // the contradiction — the original case said the numbers were not a
    // requirement and then asserted them, which is precisely the
    // over-specification the suite's own rule forbids.
    expect(priorityOf(humanSays(HUMAN), ctx)).toBeGreaterThan(priorityOf(workerSays(WORKER), ctx))
  })

  test('DIAL — today’s heuristic is 2 for external, 1 otherwise (config, not requirement)', () => {
    // Kept, but quarantined in its own case: 013 says config values "are
    // deliberately NOT requirements", so re-tuning the heuristic must break THIS
    // test and nothing else. If a dial change turns any other case red, the
    // change was not a dial.
    expect(priorityOf(humanSays(HUMAN), ctx)).toBe(2)
    expect(priorityOf(workerSays(WORKER), ctx)).toBe(1)
  })

  test('every event gets a number — the heuristic is total', () => {
    for (const e of queue()) expect(Number.isFinite(priorityOf(e, ctx))).toBe(true)
    expect(Number.isFinite(priorityOf(ev('wiki-consolidated', 'system', {}), ctx))).toBe(true)
  })

  // ── THE HEURISTIC READS THE SENDER — on every event shape (fix round,
  // 2026-08-11; sanctioned with the ruling on delivery unification).
  //
  // "External channel" is a fact about WHO PRODUCED the event. For `reply`
  // events `data.agent` IS the sender, so the heuristic was right by
  // coincidence. For `send` events `data.agent` is the ADDRESSEE — the
  // five-meanings trap (mailbox-rules.ts) — and reading it classifies a
  // message by who it is FOR. Inert while sends never entered pending; the
  // moment queued sends carry priorities into mailboxes, an addressee-read
  // would misprice exactly the class of event the unification adds.
  describe('the heuristic classifies by SENDER, never by addressee', () => {
    test('CHARACTERIZATION — a bridge human’s reply is EXTERNAL, end to end on the real recorded shape', () => {
      // The bridge records inbound human traffic as `reply` with
      // `data.agent = <user identity>` (server.ts onInbound). This is the shape
      // production actually writes, pinned so the human classification cannot
      // silently detach from it.
      expect(priorityOf(humanSays(HUMAN), ctx)).toBe(2)
    })

    test('a send AUTHORED by a user is EXTERNAL — the sender is what makes it external', () => {
      const fromHuman = ev('send', `agent-${WORKER}`, {
        agent: WORKER,
        from: HUMAN,
        text: 'please check',
        queued: true,
      })
      expect(priorityOf(fromHuman, ctx)).toBe(2)
    })

    test('a send ADDRESSED to a user is ROUTINE — the addressee must not inflate it', () => {
      // A sensei answering the human produces a send with `data.agent` = the
      // user identity. That message is dojo-authored machine traffic; reading
      // the addressee marks it EXTERNAL, which is a human-waiting signal for an
      // event where no human is waiting.
      const toHuman = ev('send', `agent-${HUMAN}`, { agent: HUMAN, from: SENSEI, text: 'done, shipping' })
      expect(priorityOf(toHuman, ctx)).toBe(1)
    })
  })

  // ── THE FROM COLUMN READS THE SENDER TOO (architect's F1, same round) ──
  //
  // `views.ts`'s `fromOf` had the identical addressee-read: a summary line for
  // a queued send would name who the message was FOR in the column that says
  // who it is FROM. Same five-meanings trap, fourth instance — and sharper
  // than the priority one, because this column is read by an AGENT deciding
  // whom it is talking to: a send addressed to the human would render as the
  // human having said something they never said.
  describe('the from column classifies by SENDER, never by addressee', () => {
    test('CHARACTERIZATION — a reply’s from column is its sender, on the real recorded shape', () => {
      const v = viewsFor([humanSays(HUMAN, 'ship it?')], SENSEI, ctx)
      expect(v.summary()[0]?.from).toBe(HUMAN)
    })

    test('a queued send’s from column is the SENDER, not the addressee', () => {
      const dispatch = ev('send', `agent-${WORKER}`, { agent: WORKER, from: 'api', text: 'do it', queued: true })
      const v = viewsFor([dispatch], SENSEI, ctx)
      expect(v.summary()[0]?.from).toBe('api')
      expect(v.fetch()[0]?.from).toBe('api')
    })

    test('a send ADDRESSED to a user is not misattributed to the human', () => {
      // The worst rendering of the addressee-read: the sensei's own outbound
      // answer, shown in a mailbox as words FROM the human. Driven through the
      // ADDRESSEE's mailbox — the one filter that admits this event (the
      // sensei's own excludes it as self-authored); the column rule is the
      // subject, and it must hold in every mailbox that renders the event.
      const toHuman = ev('send', `agent-${HUMAN}`, { agent: HUMAN, from: SENSEI, text: 'done, shipping', queued: true })
      const v = viewsFor([toHuman], HUMAN, ctx)
      expect(v.summary()).toHaveLength(1) // the premise, asserted not assumed
      expect(v.summary()[0]?.from).toBe(SENSEI)
    })
  })

  test('UNTESTED-1 — nor does the SKILL TEXT, which the canon names explicitly', async () => {
    // Canon, verbatim: "no semantics in any agent-facing surface **or skill
    // text**". The audit (task 046) found the second half untested — `views`
    // covered the surfaces and nothing covered the words we hand the agent.
    //
    // This is the half more likely to rot, not less: a view leaks a label only
    // if someone changes a renderer, while skill text is edited by hand, in
    // prose, by whoever is explaining priority to an agent that day. And the
    // consequence is worse — an agent taught the word "urgent" reasons about the
    // word, and infra's heuristic stops being a dial it can retune.
    const skills = await Array.fromAsync(new Bun.Glob('*.md').scan({ cwd: 'src/cli/skills', absolute: true }))
    expect(skills.length).toBeGreaterThan(0) // drift shows up here, not as a vacuous pass
    for (const path of skills) {
      const text = await Bun.file(path).text()
      // Bands and label-words for priority. Deliberately narrow: this must catch
      // "priority: urgent" without failing on the ordinary English "high" that
      // appears in unrelated prose, so it looks for the words in a priority
      // CONTEXT rather than anywhere.
      expect(text).not.toMatch(/priority[^.\n]{0,40}\b(urgent|critical|high|normal|low)\b/i)
      expect(text).not.toMatch(/\b(urgent|critical)\s+(priority|events?|messages?)\b/i)
    }
  })

  test('NO VIEW EXPOSES A LABEL — the opacity claim, checked where it can break', () => {
    // Opacity is not a style note: the moment a surface says "urgent", agents
    // and the skills written for them reason about the word instead of the
    // order, and infra's heuristic stops being a dial it can turn. The only
    // place this can actually break is the rendered output, so that is what is
    // scanned.
    const v = viewsFor(queue(), SENSEI, ctx)
    const rendered = JSON.stringify([v.counts(), v.summary(), v.fetch()])
    expect(rendered).not.toMatch(/urgent|critical|high|normal|\blow\b|priority[-_ ]?(name|label)/i)
  })
})
