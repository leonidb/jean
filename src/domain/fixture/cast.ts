/**
 * The cast — typed fixture agents (spec §5: "typed roles, including an agent
 * failing at a rate").
 *
 * A cast agent is a recipient with TWO ORTHOGONAL AXES, both declared, never
 * hardcoded (ruled, task 102):
 *
 *  - RELIABILITY: offered its mailbox, which events does it act on this
 *    round? Unreliability is baseline, not a defect (spec §0): a failing
 *    agent is the case the announcement ladder exists for.
 *  - CONDUCT: what does acting SAY? A pure function from the event to
 *    utterances the harness appends as the agent's own speech. Archetypes
 *    compose declaratively per scenario; `echo` is the seed one — its
 *    deterministic addition makes a full loop assertable by checking the
 *    transformed text arrived at the other end. A scenario needing a new
 *    archetype writes a Conduct value, never a new agent.
 *
 * The axes are independent on purpose: a failing echo agent and a reliable
 * silent-conduct agent are both one spec line, and every combination is a
 * legal cast member.
 */

import type { AgentName, AgentRole, KindDataMap, KnownKind, SendData, StoredEvent } from '../contracts/vocabulary.ts'
import type { Rng } from './rng.ts'

export type Behaviour =
  /** Acts on everything offered. */
  | { kind: 'reliable' }
  /** Each offered event is independently dropped with probability `rate` —
   *  the §5 failing-at-a-rate role. */
  | { kind: 'failing'; rate: number }
  /** Never acts. The down-agent case. */
  | { kind: 'silent' }
  /** §5's unresponsive role: HEARS every wake (delivery accepted) and acts
   *  on nothing — the accepted-but-ignored case the never-loud bounds
   *  measure, distinct from `silent` (whose deliveries are refused). */
  | { kind: 'unresponsive' }

/** One speech act a conduct produces — a census kind with its declared data
 *  shape, checked at construction. The harness appends it verbatim as the
 *  agent's own event. */
export type Utterance = { [K in KnownKind]: { type: K; stream: string; data: KindDataMap[K] } }[KnownKind]

/** The conduct axis: given an event this agent just read, what does it say?
 *  Pure — determinism comes from the event and the seeded rng, never from
 *  ambient anything. */
export type Conduct = (event: StoredEvent, self: AgentName, rng: Rng) => readonly Utterance[]

/** Says nothing, ever — the default conduct. Reading and acking still happen
 *  (reliability's axis); this agent just never speaks. */
export const quiet: Conduct = () => []

/**
 * The echo archetype (the ruling's seed): a queued `send` addressed to self
 * is answered with a `reply` carrying the text plus a DETERMINISTIC
 * ADDITION. The addition is the whole point: send "ping" through the
 * composed system and the loop is proven end to end by "ping" + addition
 * arriving in the orchestrator's mailbox — nothing needs to peek at
 * intermediate state.
 */
export function echo(addition: string): Conduct {
  return (event, self) => {
    if (event.type !== 'send') return []
    const data = event.data as Partial<SendData>
    if (data?.agent !== self || typeof data.text !== 'string') return []
    return [{ type: 'reply', stream: `agent-${self}`, data: { agent: self, text: `${data.text}${addition}` } }]
  }
}

/** Compose conducts: every constituent speaks; utterances concatenate in
 *  declaration order. */
export function conducts(...each: readonly Conduct[]): Conduct {
  return (event, self, rng) => each.flatMap((c) => c(event, self, rng))
}

export type CastSpec = {
  name: AgentName
  role: AgentRole
  behaviour: Behaviour
  /** The conduct axis; absent = `quiet`. */
  conduct?: Conduct
}

export type CastAgent = {
  name: AgentName
  role: AgentRole
  behaviour: Behaviour
  /** The events this agent chooses to act on, out of those offered. */
  actsOn: (offered: readonly StoredEvent[], rng: Rng) => StoredEvent[]
  /** What acting on one event says — the bound conduct. */
  speak: (event: StoredEvent, rng: Rng) => readonly Utterance[]
}

export function createCast(specs: readonly CastSpec[]): CastAgent[] {
  const names = new Set<string>()
  for (const s of specs) {
    if (names.has(s.name)) throw new Error(`duplicate cast name: ${s.name}`)
    names.add(s.name)
  }
  return specs.map((spec) => {
    const conduct = spec.conduct ?? quiet
    return {
      name: spec.name,
      role: spec.role,
      behaviour: spec.behaviour,
      actsOn: (offered, rng) => {
        switch (spec.behaviour.kind) {
          case 'reliable':
            return [...offered]
          case 'failing': {
            const rate = spec.behaviour.rate
            return offered.filter(() => !rng.chance(rate))
          }
          case 'silent':
          case 'unresponsive':
            return []
        }
      },
      speak: (event, rng) => conduct(event, spec.name, rng),
    }
  })
}
