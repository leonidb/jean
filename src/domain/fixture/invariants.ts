/**
 * Generic validity — the per-pair replay checker and the two fixture
 * assertions §5 makes mandatory.
 *
 * Every composed test carries TWO kinds of assertion (design §7): the
 * specific outcome it exists for, and generic validity — the event state as
 * a whole still satisfies the invariants. `replayCheck` is the generic half:
 * it walks the log event by event, maintains the ground-truth pending pairs
 * from the resolution contract, and asserts the definitions of spec §1/§2
 * at every step. Run over long randomized multi-agent traffic it is also the
 * P2-class detector (design §11): a divergent second membership path must
 * disagree with it as soon as traffic distinguishes them.
 *
 * The checker is parameterized over CLEARING (`clearedPairsOf`) because the
 * ack shape with per-pair attribution is the mailbox contract's to declare
 * (A2) — this harness must not pre-empt it. A1 wires resolution; A2 wires
 * clearing.
 */

import type { ResolutionContext, ResolutionContract } from '../contracts/resolution.ts'
import type { AgentName, StoredEvent } from '../contracts/vocabulary.ts'

export type PendingPair = { recipient: AgentName; eventId: number }

export type ReplayRules = {
  resolution: ResolutionContract
  /** The resolution context. COMPOSED walks (A6): resolution reads state
   *  AS OF each event — a subscriber added later must not retro-address
   *  earlier comments — so `ctx` may be a mutable object that `observe`
   *  advances; replayCheck reads it fresh per event and never copies it. */
  ctx: ResolutionContext
  /** Called FIRST for every event, before it is resolved — the caller's
   *  hook to advance an evolving context (fold shadow states, reseat the
   *  orchestrator). Absent for static-context walks. */
  observe?: (event: StoredEvent) => void
  /** The pairs an event clears, per the mailbox contract. Return [] for
   *  events that clear nothing. */
  clearedPairsOf: (event: StoredEvent, pending: readonly PendingPair[]) => readonly PendingPair[]
}

export type ReplayResult = {
  /** Ground-truth pending pairs after folding the whole log. */
  pending: readonly PendingPair[]
  /** Total pairs ever created — anti-vacuity raw material: a run that never
   *  created a pair proved nothing about clearing. */
  pairsCreated: number
  pairsCleared: number
  /** Events that resolved to at least two recipients — the §5 multi-recipient
   *  observability counter. Counts the OVERLAP actually held, not the
   *  declaration (a lesson paid for once: declared-to-many and delivered-to-
   *  many can both hold while the intersection is one). */
  observedJointHolds: number
}

/**
 * Walk the log, maintaining ground truth and asserting at every event:
 *  - P1/§1: recipients come from the declared resolution — and never include
 *    the author (author exclusion is part of every resolution);
 *  - §2: clearing removes only pairs that exist, only one recipient's at a
 *    time — no clearing ever removes another recipient's pair for reasons of
 *    the same event (independent acknowledgement);
 *  - P4: pending is exactly the accumulated unacked pairs — an event with no
 *    recipients never contributes, so orphans cannot exist by construction.
 * Throws with the offending event id on the first violation.
 */
export function replayCheck(log: readonly StoredEvent[], rules: ReplayRules): ReplayResult {
  // Pending as a keyed map: membership checks and removals stay O(1), so a
  // long randomized run does not go quadratic (codex pass, task 077).
  const pairKey = (p: PendingPair) => `${p.recipient}\u0000${p.eventId}`
  const pending = new Map<string, PendingPair>()
  let pairsCreated = 0
  let pairsCleared = 0
  let observedJointHolds = 0

  for (const event of log) {
    rules.observe?.(event)
    const author = rules.resolution.authorOf(event)
    const recipients = rules.resolution.resolve(event, rules.ctx)

    const unique = new Set(recipients)
    if (unique.size !== recipients.length) {
      throw new Error(`event ${event.id} (${event.type}): resolution repeats a recipient`)
    }
    if (author !== undefined && unique.has(author)) {
      throw new Error(`event ${event.id} (${event.type}): resolved to its own author "${author}" — spec §1`)
    }

    for (const recipient of recipients) {
      const pair = { recipient, eventId: event.id }
      pending.set(pairKey(pair), pair)
      pairsCreated++
    }
    if (recipients.length >= 2) observedJointHolds++

    const cleared = rules.clearedPairsOf(event, [...pending.values()])
    // §2's floor, enforced rather than narrated: one clearing event acts for
    // ONE agent. Cleared pairs spanning two recipients would mean one
    // caller's act consumed another agent's mail — the exact defect
    // independent acknowledgement abolishes (codex pass, task 077: the
    // earlier version documented this and checked only existence).
    const clearedRecipients = new Set(cleared.map((p) => p.recipient))
    if (clearedRecipients.size > 1) {
      throw new Error(
        `event ${event.id} (${event.type}): one clearing act cleared pairs of ` +
          `${[...clearedRecipients].join(', ')} — §2: an ack clears one agent's pairs only`,
      )
    }
    for (const pair of cleared) {
      const key = pairKey(pair)
      if (!pending.has(key)) {
        throw new Error(
          `event ${event.id} (${event.type}): cleared a pair that does not exist ` +
            `(${pair.recipient}, ${pair.eventId}) — §2 independent acknowledgement`,
        )
      }
      pending.delete(key)
      pairsCleared++
    }
  }

  return { pending: [...pending.values()], pairsCreated, pairsCleared, observedJointHolds }
}

/** Structural stringify with sorted object keys, so two structurally equal
 *  objects compare equal regardless of property insertion order (codex pass,
 *  task 077 — plain JSON.stringify missed that coincidence class). */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`).join(',')}}`
}

/**
 * §5's non-coincidence rule, as the reusable assertion: no two agents'
 * answers coincide, and no agent's answer coincides with the dojo-wide
 * total. Call it on whatever per-agent answer the test compares (mailbox
 * ids, counts as singleton arrays, view lines) — a fixture that cannot
 * satisfy it is a fixture that cannot detect per-agent defects.
 */
export function assertNonCoincident(
  perAgent: ReadonlyMap<AgentName, readonly unknown[]>,
  global: readonly unknown[],
): void {
  const entries = [...perAgent.entries()]
  const key = (xs: readonly unknown[]) => [...xs].map(stableKey).sort().join('|')
  const globalKey = key(global)
  for (let i = 0; i < entries.length; i++) {
    const [nameA, a] = entries[i] as [AgentName, readonly unknown[]]
    if (key(a) === globalKey) {
      throw new Error(`fixture defect: ${nameA}'s answer coincides with the dojo-wide total — §5 non-coincidence`)
    }
    for (let j = i + 1; j < entries.length; j++) {
      const [nameB, b] = entries[j] as [AgentName, readonly unknown[]]
      if (key(a) === key(b)) {
        throw new Error(`fixture defect: ${nameA}'s and ${nameB}'s answers coincide — §5 non-coincidence`)
      }
    }
  }
}

/**
 * Anti-vacuity: wrap a loop's assertion count; a body that never ran (or a
 * guard that filtered everything) fails instead of passing silently. The §5
 * rule that once caught a defect in the very checker written to enforce it.
 */
export function counted(label: string, times: number, atLeast = 1): void {
  if (times < atLeast) {
    throw new Error(
      `anti-vacuity: "${label}" asserted ${times} time(s), needs >= ${atLeast} — the check checked nothing`,
    )
  }
}
