/**
 * The fixture harness — spec §5, built fresh for the rewrite (design §7, §8:
 * not seeded from any prior suite).
 *
 * §5's rules, and where each lives here:
 *  - NON-COINCIDENCE: no two agents' answers may coincide, and no agent's may
 *    coincide with the dojo-wide total — asserted, not arranged
 *    (`assertNonCoincident`). A fixture whose numbers can coincide passes
 *    under both the correct and the broken implementation.
 *  - TYPED ROLES, including an agent failing at a rate (`cast`).
 *  - RANDOMIZED SCALED RUNS: five to ten agents, seeded traffic — the seeded
 *    rng and clock make every run replayable from its seed.
 *  - THE PER-PAIR REPLAY CHECKER: generic validity of the whole event state,
 *    walked event by event (`replayCheck`) — run alongside every specific
 *    assertion (design §7's two-kinds-of-assertion rule).
 *  - ANTI-VACUITY: a loop that asserted nothing is a failure, not a pass
 *    (`counted`).
 *
 * Deterministic by construction: instants come from the injected clock, ids
 * from the log builder, randomness from the seeded rng. Nothing here reads
 * ambient time or global state.
 */

export { type Capture, createCapture, type Emitted } from './capture.ts'
export {
  type Behaviour,
  type CastAgent,
  type CastSpec,
  type Conduct,
  conducts,
  createCast,
  echo,
  quiet,
  type Utterance,
} from './cast.ts'
export { type Clock, createClock } from './clock.ts'
export {
  assertNonCoincident,
  counted,
  type PendingPair,
  type ReplayResult,
  type ReplayRules,
  replayCheck,
} from './invariants.ts'
export { createLog, type EventLog } from './log.ts'
export { createRng, type Rng } from './rng.ts'
