/**
 * The cast — typed fixture agents (spec §5: "typed roles, including an agent
 * failing at a rate").
 *
 * A cast agent is a recipient with a BEHAVIOUR: offered its mailbox, which
 * events does it act on this round? Behaviours model the agent side of the
 * contract — including unreliability, which is baseline, not a defect
 * (spec §0): a failing agent is the case the announcement ladder exists for.
 */

import type { AgentName, AgentRole, StoredEvent } from '../contracts/vocabulary.ts'
import type { Rng } from './rng.ts'

export type Behaviour =
  /** Acts on everything offered. */
  | { kind: 'reliable' }
  /** Each offered event is independently dropped with probability `rate` —
   *  the §5 failing-at-a-rate role. */
  | { kind: 'failing'; rate: number }
  /** Never acts. The down-agent case. */
  | { kind: 'silent' }

export type CastSpec = {
  name: AgentName
  role: AgentRole
  behaviour: Behaviour
}

export type CastAgent = {
  name: AgentName
  role: AgentRole
  behaviour: Behaviour
  /** The events this agent chooses to act on, out of those offered. */
  actsOn: (offered: readonly StoredEvent[], rng: Rng) => StoredEvent[]
}

export function createCast(specs: readonly CastSpec[]): CastAgent[] {
  const names = new Set<string>()
  for (const s of specs) {
    if (names.has(s.name)) throw new Error(`duplicate cast name: ${s.name}`)
    names.add(s.name)
  }
  return specs.map((spec) => ({
    ...spec,
    actsOn: (offered, rng) => {
      switch (spec.behaviour.kind) {
        case 'reliable':
          return [...offered]
        case 'failing': {
          const rate = spec.behaviour.rate
          return offered.filter(() => !rng.chance(rate))
        }
        case 'silent':
          return []
      }
    },
  }))
}
