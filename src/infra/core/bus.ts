/**
 * The in-process event bus (refactor stage 3, commit 1 — task 033; contract =
 * task 034 deliverable 2).
 *
 * This is not new machinery. `record()` already WAS a hand-rolled bus: append,
 * then five consecutive `projection.apply(event)` calls against a fixed list.
 * All this does is name the list and make it extensible, so the attention logic
 * can join it as a subscriber in commit 2 instead of being hard-wired into
 * `record()`'s tail.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────
 *
 * SYNCHRONOUS AND ORDERED. `publish()` runs every subscriber, in registration
 * order, to completion, before it returns. This is load-bearing, not a
 * simplification: `record()` has seven documented race guards that exist
 * precisely because things straddling its `await` can interleave. An async
 * subscriber would reintroduce that entire class of bug, one level down and
 * harder to see. Subscribers must therefore be synchronous — the type says so,
 * and a subscriber that returns a promise is silently not awaited.
 *
 * REGISTRATION ORDER IS SEMANTICS. Subscribe at factory construction only, in
 * the order `record()` used to apply: board, pending, lastTaskContext,
 * taskActivity, triggers, playbooks — and the attention listener LAST. That
 * last part is the non-obvious one: the dispatch tail reads
 * `pendingProjection.state` AFTER all the applies, so a listener registered
 * earlier would decide against pre-apply state and skip wakes. Nothing in the
 * type system enforces it; this paragraph is the enforcement.
 *
 * ERRORS ARE FATAL, ON PURPOSE — DO NOT ADD A try/catch. What happens today
 * when a projection's `apply` throws: the append has already landed and is
 * durable; projections registered before the thrower are updated and those
 * after are not; everything downstream in `record()` is skipped; and the
 * rejection propagates out of `record()`, whose 16 `void record(...)` call
 * sites turn it into an unhandled rejection, which Bun answers by exiting(1).
 *
 * So the in-memory divergence never outlives the crash — restart re-folds from
 * the log and is correct again. Wrapping subscribers in a try/catch LOOKS like
 * hardening and is strictly worse: it converts a loud crash-then-correct-refold
 * into silent, persistent projection divergence. A throwing subscriber is a
 * programming error, and it should stay as loud as it is now.
 *
 * (Pre-existing, and unchanged by the bus so it doesn't get blamed on it:
 * `projection.apply` fires `void projection.snapshot()`, so a snapshot failure
 * is already an unhandled rejection on that same fatal path.)
 *
 * REPLAY NEVER PUBLISHES. `catchUp()` folds history through the projections
 * DIRECTLY and must keep doing so. That is what makes cold start safe: the
 * attention listener has no replay path at all, so it cannot re-emit historical
 * wakes on restart. The separation is structural — two different code paths —
 * rather than a replay/live flag, and that is deliberate: a flag puts a
 * restart-time nudge storm one boolean away, and no test would catch it (L2
 * folds start from empty state and never replay). If you are here to route
 * catch-up through the bus "for uniformity", this paragraph is the reason not
 * to.
 */

import type { StoredEvent } from '../../es/index.ts'

/** Projections already satisfy this shape, so they need no adapter — only a
 *  name, which `Projection<S>` does not carry. */
export type Subscriber = {
  /** Diagnostic only: it names the subscriber in error messages and lets a test
   *  assert registration ORDER, which is semantics (see above). */
  name: string
  apply: (event: StoredEvent) => void
}

export type EventBus = {
  subscribe: (sub: Subscriber) => void
  publish: (event: StoredEvent) => void
  /** Registered names, in order. For assertions and diagnostics. */
  names: () => string[]
}

export function createEventBus(): EventBus {
  const subscribers: Subscriber[] = []
  let publishing = false

  return {
    subscribe(sub) {
      // Subscribing from inside a subscriber would mutate the list mid-publish:
      // the newcomer would or wouldn't see the in-flight event depending on
      // where it landed relative to the loop index. Refuse loudly rather than
      // pick one — construction-time registration is the whole contract.
      if (publishing) throw new Error(`bus: cannot subscribe "${sub.name}" during publish`)
      subscribers.push(sub)
    },

    publish(event) {
      publishing = true
      try {
        // NOT a try/catch around the subscribers — see the contract above. This
        // `finally` only clears the re-entrancy flag, so that a throwing
        // subscriber (which kills the process) doesn't first leave the bus in a
        // state where the crash path's own bookkeeping is refused.
        for (const sub of subscribers) sub.apply(event)
      } finally {
        publishing = false
      }
    },

    names() {
      return subscribers.map((s) => s.name)
    },
  }
}
