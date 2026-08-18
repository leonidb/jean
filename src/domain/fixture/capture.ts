/**
 * Capturing executor — the test-side implementation of an executor port.
 * Records everything a decision asked to be performed, in order, so a test
 * asserts on intent (effects) rather than on side effects. This is the
 * second-real-implementation seat for executor conformance suites (design
 * §7): held to the same contract as the production executor.
 */

export type Emitted =
  | { kind: 'deliver'; to: string; text: string }
  | { kind: 'emit'; type: string; data: unknown }
  | { kind: 'stamp'; via: string; ids: readonly number[] }

export type Capture = {
  /** Everything performed, in exact order. */
  all: () => readonly Emitted[]
  deliveries: (to?: string) => Emitted[]
  emissions: (type?: string) => Emitted[]
  clear: () => void
  /** Port-shaped callables to hand to a decision runner. `deliver` returns
   *  `accept(to)` — default true; set per-name to model a dead transport. */
  deliver: (to: string, text: string) => boolean
  emit: (type: string, data: unknown) => void
  stamp: (via: string, ids: readonly number[]) => void
  /** Names whose transport refuses delivery (the push that lands nowhere). */
  refuse: (name: string, refused?: boolean) => void
}

export function createCapture(): Capture {
  const recorded: Emitted[] = []
  const refused = new Set<string>()
  return {
    all: () => recorded,
    deliveries: (to) =>
      recorded.filter((e): e is Extract<Emitted, { kind: 'deliver' }> => e.kind === 'deliver' && (!to || e.to === to)),
    emissions: (type) =>
      recorded.filter((e): e is Extract<Emitted, { kind: 'emit' }> => e.kind === 'emit' && (!type || e.type === type)),
    clear: () => {
      recorded.length = 0
    },
    deliver: (to, text) => {
      recorded.push({ kind: 'deliver', to, text })
      return !refused.has(to)
    },
    emit: (type, data) => {
      recorded.push({ kind: 'emit', type, data })
    },
    stamp: (via, ids) => {
      recorded.push({ kind: 'stamp', via, ids })
    },
    refuse: (name, isRefused = true) => {
      if (isRefused) refused.add(name)
      else refused.delete(name)
    },
  }
}
