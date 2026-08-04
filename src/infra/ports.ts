/**
 * The port set — every ambient effect the infra reaches for, named and
 * injectable (refactor stage 2; spec = task 029 deliverable 2, STAGE 2).
 *
 * The point is not indirection for its own sake. Stage 3 moves the decision
 * logic (blocking backoff, nudge episodes, the stall predicate) into pure
 * functions, and those decisions are all clock-driven. Until the clock is a
 * port, "what does this decide at T+5m?" can only be asked by waiting five
 * minutes — which is why 31 of the suite's tests currently burn 46% of its wall
 * clock on real sleeps.
 *
 * DEFAULTS ARE TODAY'S BEHAVIOUR, EXACTLY. Every default here is the ambient
 * call it replaces, so an instance that injects nothing behaves identically to
 * the pre-port code. That is what makes stage 2 suite-green by construction.
 *
 * ── THE POSITION RULE, and why it is the whole review of stage 2 ──
 *
 * Replacing `Date.now()` with `ports.now()` is only safe if the call stays at
 * the SAME SYNTACTIC POSITION. Do not hoist it to the top of a function, and do
 * not thread one `now` value through `record()`.
 *
 * The concrete case: `pendingSince ??= Date.now()` runs AFTER `await
 * store.append(...)`. A `const now = ports.now()` hoisted to the top of
 * `record()` is read BEFORE that await — a different instant, by however long
 * the append took. Every test would still pass, because the suite's timing
 * assertions run on 500-900 ms windows and this difference is microseconds. The
 * semantics would have moved with nothing to catch it. A tidier-looking
 * refactor here is a wrong one.
 */

import type { EventStore } from '../es/index.ts'
import { probeAnthropicAPI, spawnHeadless } from './librarian.ts'
import type { DeliverMsg } from './protocol.ts'

export type InfraPorts = {
  /** Wall clock, epoch ms. Call it where `Date.now()` was called — see the
   *  position rule above. */
  now: () => number
  /** Diagnostic output. The message arrives fully formatted and already
   *  newline-terminated, exactly as it was handed to `process.stderr.write`, so
   *  the default is byte-identical to the ambient call.
   *
   *  THIS PORT CARRIES NO CONTRACT, and is deliberately untested. Leonid's
   *  ruling, 2026-08-04: logging is not logic — never relied on, nothing
   *  branches on it, nice-to-have only. It stays threaded because it is
   *  harmless and lets a caller capture output if it ever wants to, but do not
   *  write assertions against it; that would pin an implementation detail.
   *
   *  Consequently `log` is NOT one of the core's effects. The effect set going
   *  into stage 3 is FOUR emissions — `event` (append), `deliver`,
   *  `schedule`/`unschedule`, `spawn` — arrived at by three rulings against D1's
   *  original seven: `log` cut here (logging is not logic); `inboxChanged` cut
   *  because the inbox is core STATE (pull it with a query, push it with a
   *  `deliver`); `broadcast` cut with the SSE endpoint itself. Logging stays
   *  ambient wherever it is convenient. (D1 typed this as `log{level, message}`;
   *  the level never arrives, for the same reason.) */
  log: (message: string) => void
  /** Spawn a headless Claude run.
   *
   *  Injectable since stage 1, and it must stay that way: startup trigger
   *  catch-up fires overdue headless triggers straight out of whatever history
   *  it finds, so an in-process caller with a stale fixture would otherwise
   *  launch real `claude` processes. */
  spawn: typeof spawnHeadless
  /** Pre-flight reachability check before a headless run. Injectable for the
   *  same reason as `spawn`: it is a live network call on the retry path, and a
   *  test driving trigger catch-up must not make one. */
  probe: typeof probeAnthropicAPI
  /** The event log. Already port-shaped before stage 2 — `store` is referenced
   *  as a bare identifier throughout, so it needed no call-site rewrites, which
   *  is why it landed a stage before `deliver` and `schedule`. */
  store: EventStore
  /** Push a message to a locally-registered agent; returns whether the
   *  transport accepted it.
   *
   *  IT CAPTURES EVERY DELIVERY PATH, and that is the whole point — a port
   *  covering a third of delivery is worse than none, because it reads as
   *  complete. All of these go through here: the routed `send`, trigger
   *  dispatch, the undelivered-notice back to a sender, the three attention
   *  pushes (blocking wake, machine nudge, stall watchdog), and the
   *  duplicate-session notice.
   *
   *  Per-instance default (it closes over the agent registry), so the factory
   *  supplies it rather than `ambientPorts`. */
  deliver: (agent: string, msg: DeliverMsg) => boolean
  /** Run `fire` on a schedule — a cron expression or a one-off date. MECHANISM
   *  ONLY: whether a trigger is due, overdue, or should be cancelled is decided
   *  in core/triggers.ts. Re-scheduling an existing id is a no-op, matching the
   *  croner default it wraps. */
  schedule: (id: string, spec: { cron: string } | { at: string }, fire: () => void) => void
  unschedule: (id: string) => void
}

/**
 * The ambient defaults: real clock, real stderr, real spawner, real probe.
 *
 * `store`, `deliver`, `schedule` and `unschedule` are absent on purpose — every
 * one of them has a PER-INSTANCE default (a store bound to that dojo's
 * history.jsonl; the agent registry; that instance's croner job table), so only
 * the factory can build them.
 */
export const ambientPorts: Pick<InfraPorts, 'now' | 'log' | 'spawn' | 'probe'> = {
  now: () => Date.now(),
  log: (message: string) => {
    process.stderr.write(message)
  },
  spawn: spawnHeadless,
  probe: probeAnthropicAPI,
}
