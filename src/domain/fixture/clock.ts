/** Deterministic clock. Instants are inputs everywhere in the domain
 *  (design §1 question 1); tests advance time, never wait for it. */

export type Clock = {
  now: () => number
  advance: (ms: number) => void
}

export function createClock(startMs = 1_755_500_000_000): Clock {
  let t = startMs
  return {
    now: () => t,
    advance: (ms) => {
      if (ms < 0) throw new Error('clocks do not run backwards')
      t += ms
    },
  }
}
