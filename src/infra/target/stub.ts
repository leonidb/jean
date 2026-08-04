/**
 * ██ TARGET API ██ — the shared "not built yet" throw.
 *
 * Every surface in `src/infra/target/` is a SIGNATURE WITH NO BODY. The red
 * scenario suite compiles against these so that a failing test means "this
 * requirement is not met", never "this file does not parse" (task 043 part 2;
 * task 044 deliverable 1).
 *
 * WHY THE MESSAGE CARRIES THE SCENARIO. `bun test src/scenarios` is the
 * transition's progress meter, so its output has to read as a to-do list rather
 * than a wall of identical stack traces. `NotImplemented: viewsFor — required by
 * S4 (triage)` tells the next session which requirement it is looking at without
 * opening the file.
 *
 * DO NOT give any of these a plausible body. A stub that returns something
 * reasonable turns a red test green without the requirement being met, and the
 * board — which counts red — would then report progress that does not exist. If
 * a surface here needs a body, that body belongs in the transition.
 */

export class NotImplemented extends Error {
  constructor(surface: string, scenario: string) {
    super(`TARGET API not implemented: ${surface} — required by ${scenario}`)
    this.name = 'NotImplemented'
  }
}

/** Throws. The return type is `never` so callers type-check as if it returned
 *  the real thing — which is what keeps the stubs' signatures honest. */
export function notImplemented(surface: string, scenario: string): never {
  throw new NotImplemented(surface, scenario)
}
