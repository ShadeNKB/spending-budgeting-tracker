// The closest of a list of names to a typed one, exactly as Fuse ranks them, without running
// Fuse's bitap over every name on every keystroke (F-044, AC-22).
//
// `closestKey(prepared, query, options)` returns the top hit of
// `new Fuse(names, { ...options, includeScore: true }).search(query)` (same name, same score; a
// seeded test checks this against Fuse):
//
// - Fuse accepts a name only when part of it is within `floor(threshold × length)` edits of the
//   query (score = edits / length + start / 100 ≤ threshold). Myers' bit-vector algorithm gives
//   the fewest edits against any part of a name in one pass, which rules most names out and
//   gives a floor for the rest. Queries longer than Fuse's 32-character word are not pruned.
// - The rest are scored best-first with `Fuse.match` (the same bitap, the same options) and
//   Fuse's field-length norm (`score ^ (1 / √words)`), stopping once no remaining name can beat
//   the best. Ties keep the earlier name, as Fuse does.
import Fuse from 'fuse.js/basic'

export interface FuzzyOptions {
  /** Fuse's `threshold`: 0 is an exact match only, 1 matches anything. */
  readonly threshold: number
  /** Fuse's `minMatchCharLength`: a match needs a run of this many matched characters. */
  readonly minMatchCharLength?: number
}

interface Name {
  readonly key: string
  readonly lower: string
  readonly norm: number
}

/** A list of names made ready for `closestKey` (their lower case and field-length norm). */
export type PreparedNames = readonly Name[]

const FUSE_MAX_PATTERN = 32

// Myers' match masks: bit i is set for the query's i-th character, by UTF-16 code unit. 256 KB,
// so it is allocated on the first fuzzy lookup rather than when the engine loads.
let queryMasks: Int32Array | null = null

/** Fuse's field-length norm: 1 / √(word count), words split on runs of spaces, 3 decimals. */
function fuseNorm(text: string): number {
  return Math.round(1000 / Math.sqrt(text.split(/ +/).length)) / 1000
}

export function prepareNames(keys: readonly string[]): PreparedNames {
  return keys.map((key) => {
    const lower = key.toLowerCase()
    return { key, lower, norm: fuseNorm(lower) }
  })
}

/** Fewest edits between the query loaded in `masks` (length 1-32) and any part of `text`. */
function fewestEdits(masks: Int32Array, text: string, length: number): number {
  const last = 1 << (length - 1)
  let pv = -1
  let mv = 0
  let edits = length
  let fewest = length
  for (let j = 0; j < text.length; j++) {
    const eq = masks[text.charCodeAt(j)] ?? 0
    const xv = eq | mv
    const xh = (((eq & pv) + pv) ^ pv) | eq
    let ph = mv | ~(xh | pv)
    let mh = pv & xh
    if (ph & last) edits++
    else if (mh & last) edits--
    fewest = Math.min(fewest, edits)
    ph <<= 1
    mh <<= 1
    pv = mh | ~(xv | ph)
    mv = ph & xv
  }
  return fewest
}

/** The lowest final score Fuse could give this name, or null when Fuse cannot match it. */
function scoreFloor(
  masks: Int32Array,
  entry: Name,
  query: string,
  maxEdits: number,
  threshold: number,
): number | null {
  if (entry.lower === query || query.length > FUSE_MAX_PATTERN) return 0
  const edits = fewestEdits(masks, entry.lower, query.length)
  if (edits > maxEdits) return null
  if (maxEdits > 0) return Math.pow(Math.max(0.001, edits / query.length), entry.norm)
  // So short a query allows no edits: Fuse scores the first exact occurrence by its start.
  const start = entry.lower.indexOf(query) / 100
  return start > threshold ? null : Math.pow(Math.max(0.001, start), entry.norm)
}

/** The name Fuse would rank first for `query` (lower case), with Fuse's score; null for none. */
export function closestKey(
  names: PreparedNames,
  query: string,
  options: FuzzyOptions,
): { key: string; score: number } | null {
  if (query === '' || names.length === 0) return null
  const { threshold } = options
  const maxEdits = Math.floor(query.length * threshold)
  const candidates: { entry: Name; order: number; floor: number }[] = []
  const loaded = query.length <= FUSE_MAX_PATTERN
  const masks = (queryMasks ??= new Int32Array(65536))
  try {
    if (loaded) {
      for (let i = 0; i < query.length; i++) {
        const c = query.charCodeAt(i)
        masks[c] = (masks[c] ?? 0) | (1 << i)
      }
    }
    names.forEach((entry, order) => {
      const floor = scoreFloor(masks, entry, query, maxEdits, threshold)
      if (floor !== null) candidates.push({ entry, order, floor })
    })
  } finally {
    if (loaded) for (let i = 0; i < query.length; i++) masks[query.charCodeAt(i)] = 0
  }

  candidates.sort((a, b) => a.floor - b.floor || a.order - b.order)
  let best: { key: string; score: number; order: number } | null = null
  for (const { entry, order, floor } of candidates) {
    if (best && (floor > best.score || (floor === best.score && order > best.order))) break
    const match = Fuse.match(query, entry.key, options)
    if (!match.isMatch) continue
    const score = Math.pow(match.score, entry.norm)
    if (!best || score < best.score || (score === best.score && order < best.order)) {
      best = { key: entry.key, score, order }
    }
  }
  return best === null ? null : { key: best.key, score: best.score }
}
