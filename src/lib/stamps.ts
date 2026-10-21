// Write stamps (`updatedAt`, budget stamps). Ordering only honours instants in a fixed
// window, so a hostile or corrupt far-future stamp cannot pin a record, and every device
// orders the same stamps the same way whatever its own clock says.

export const STAMP_MIN = Date.UTC(2000, 0, 1)
export const STAMP_MAX = Date.UTC(2100, 0, 1)
/** Written for budgets whose set time is unknown. Orders as 0. */
export const LEGACY_STAMP_ISO = '1970-01-01T00:00:00.000Z'

/** Epoch ms of an ISO stamp inside [2000, 2100), else 0 ("unknown", loses to every real stamp). */
export function stampMs(value: unknown): number {
  if (typeof value !== 'string') return 0
  const t = Date.parse(value)
  return Number.isFinite(t) && t >= STAMP_MIN && t < STAMP_MAX ? Math.floor(t) : 0
}

/** A stamp at `now`, but strictly after every base it supersedes (a slow clock still wins). */
export function nextStampIso(now: number, ...bases: number[]): string {
  const t = Math.min(STAMP_MAX - 1, Math.max(Math.floor(now), ...bases.map((b) => b + 1)))
  return new Date(t).toISOString()
}
