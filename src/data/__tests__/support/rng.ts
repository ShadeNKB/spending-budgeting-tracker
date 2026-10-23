/** Seeded PRNG (mulberry32): the only randomness allowed in data-engine tests. */
export interface Rng {
  /** Uniform in [0, 1). */
  readonly next: () => number
  /** Integer in [0, n). */
  readonly int: (n: number) => number
  /** Integer in [lo, hi] (inclusive). */
  readonly between: (lo: number, hi: number) => number
  /** True with probability p. */
  readonly chance: (p: number) => boolean
  /** One element of a non-empty list. */
  readonly pick: <T>(items: readonly T[]) => T
  /** A shuffled copy. */
  readonly shuffle: <T>(items: readonly T[]) => T[]
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed)
  const int = (n: number): number => Math.floor(next() * n)
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(items.length)]
    if (item === undefined) throw new Error('pick: empty list')
    return item
  }
  return {
    next,
    int,
    between: (lo, hi) => lo + int(hi - lo + 1),
    chance: (p) => next() < p,
    pick,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1)
        const a = out[i]
        const b = out[j]
        if (a === undefined || b === undefined) continue
        out[i] = b
        out[j] = a
      }
      return out
    },
  }
}

/**
 * An environment variable of the test process. Read through globalThis because the app's
 * tsconfig carries no Node types (tests still run under Node, where `process` exists).
 */
export function envVar(name: string): string | undefined {
  const proc: unknown = Reflect.get(globalThis, 'process')
  const env: unknown =
    typeof proc === 'object' && proc !== null ? Reflect.get(proc, 'env') : undefined
  const value: unknown =
    typeof env === 'object' && env !== null ? Reflect.get(env, name) : undefined
  return typeof value === 'string' ? value : undefined
}

/** Size knobs (spec P-30). Read from the environment so CI can scale the suites. */
function envInt(name: string, fallback: number): number {
  const raw = envVar(name)
  const n = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Seeds per simulation configuration. The default unit run (3 time zones in CI) uses 30; the CI job
 * `data-engine-sim` runs the full 150 once (P-30 fallback: a 4-vCPU runner would otherwise spend
 * most of the 15-minute validate budget on 3 × 150 seeds).
 */
export const SIM_SEEDS = envInt('ST5_SIM_SEEDS', 30)
export const PROP_SCALE = envInt('ST5_PROP_SCALE', 1)
export const BENCH_STRICT = envVar('BENCH_STRICT') === '1'

/** Per-test timeout of the property suites (they run thousands of cases). */
export const PROP_TIMEOUT = 300_000

/**
 * Describe-level timeout of the unit files with heavier cases (thousands of random inputs, 50,000
 * rows). Vitest's 5 s default leaves too little headroom on a shared 4-vCPU CI runner that runs the
 * whole suite once per time zone.
 */
export const HEAVY = { timeout: 60_000 } as const
