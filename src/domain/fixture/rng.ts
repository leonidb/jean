/** Seeded deterministic rng (mulberry32). Same seed → same run, so every
 *  randomized case names its seed and replays exactly. */

export type Rng = {
  /** [0, 1) */
  next: () => number
  /** integer in [0, n) */
  int: (n: number) => number
  /** true with probability p */
  chance: (p: number) => boolean
  /** uniform pick */
  pick: <T>(items: readonly T[]) => T
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick from empty list')
      return items[Math.floor(next() * items.length)] as never
    },
  }
}
