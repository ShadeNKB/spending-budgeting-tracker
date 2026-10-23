// Ids (DATA-ENGINE-SPEC §4.3, P-7, P-20). Randomness is injected; derived ids are deterministic.
import { canon, fnv36 } from './hash'
import type { ExpenseRec } from './types'

const HEX = '0123456789abcdef'
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** The last char of 16 bytes in base64url carries 2 bits only. */
const B64URL_LAST = 'AQgw'

const byte = (rng: () => number): number => Math.floor(rng() * 256) & 0xff

/** RFC 4122 v4 UUID from 16 rng bytes. v0.8 ids remain valid as-is. */
export function newId(rng: () => number): string {
  let out = ''
  for (let i = 0; i < 16; i++) {
    let b = byte(rng)
    if (i === 6) b = (b & 0x0f) | 0x40
    if (i === 8) b = (b & 0x3f) | 0x80
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-'
    out += (HEX[b >> 4] ?? '0') + (HEX[b & 15] ?? '0')
  }
  return out
}

/** 22 base64url chars, format-identical to 16 random bytes (push revisions, undo ids). */
export function newRev(rng: () => number): string {
  let out = ''
  for (let i = 0; i < 21; i++) out += B64URL[Math.floor(rng() * 64) & 63] ?? 'A'
  return out + (B64URL_LAST[Math.floor(rng() * 4) & 3] ?? 'A')
}

const DERIVED_SUFFIX = /~[rd][0-9a-z]{1,7}(\.[0-9]{1,3})?$/
const DEDUPE_SUFFIX = /~d[0-9a-z]{1,7}(\.[0-9]{1,3})?$/
/** Highest `.N` disambiguator a derived id may carry. */
const SUFFIX_MAX = 999

export const rootId = (id: string): string => id.replace(DERIVED_SUFFIX, '')

/**
 * The first free id among the candidate, `.2` … `.999`, or null when every one is taken. Never a
 * taken id: that would revive a row under a tombstone (I3) or overwrite a different live row.
 * Callers keep the record and report it instead (reachable only after ~1,000 revives of one entry).
 */
function firstFree(candidate: string, taken: (id: string) => boolean): string | null {
  if (!taken(candidate)) return candidate
  for (let n = 2; n <= SUFFIX_MAX; n++) {
    const id = `${candidate}.${n}`
    if (!taken(id)) return id
  }
  return null
}

/** The root part of every id derived from `id`. Keeps derived ids ≤ 64 chars: 48 + '~r' + 7 + '.999'. */
export const rootKey = (id: string): string => rootId(id).slice(0, 48)

/** The rootKey a dedupe-derived id (`<root>~d…`) was split from, or null for any other id. */
export function dedupeRoot(id: string): string | null {
  const m = DEDUPE_SUFFIX.exec(id)
  return m === null ? null : id.slice(0, m.index)
}

/**
 * Deterministic id for a re-created (revived) record. Same content → same id on every device, so
 * restoring the same backup twice never multiplies rows. `taken(id)` = tombstoned, or live with
 * different content (a live copy with identical content means the revive is a no-op).
 */
export function reviveId(
  rec: ExpenseRec,
  resolvedCategory: string,
  taken: (id: string) => boolean,
): string | null {
  return firstFree(`${rootKey(rec.id)}~r${fnv36(contentKey(rec, resolvedCategory))}`, taken)
}

/** contentOf(rec) of §4.3 as canonical text: no stamps, so equal content means the same entry. */
export const contentKey = (rec: ExpenseRec, resolvedCategory: string): string =>
  canon([rec.n.v, rec.a.v, resolvedCategory, rec.d.v.date, rec.o.v, rec.x.v])

/** Deterministic id for one of several differing copies sharing an id within one source (§7.9). */
export function dedupeId(
  raw: { readonly id: string } & Readonly<Record<string, unknown>>,
  taken: (id: string) => boolean,
): string | null {
  return firstFree(`${rootKey(raw.id)}~d${fnv36(canon(raw))}`, taken)
}
