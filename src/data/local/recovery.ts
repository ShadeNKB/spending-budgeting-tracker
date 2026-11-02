// The readers of the recovery ladder (DATA-ENGINE-SPEC §9.6.3, track spec §8.5): every copy that
// still reads joins the recovered doc. A damaged envelope is salvaged collection by collection,
// and a snapshot body is a wire doc or the raw v4 strings of the pre-v5 snapshot. Nothing here
// throws or deletes: what does not read contributes nothing.
import { EMPTY_DOC } from '../core/doc'
import { isPlainObject, own } from '../core/sanitize'
import type { Doc } from '../core/types'
import { decodeWire } from '../core/wire'
import { envelopeBody } from './envelope'
import { parseJson } from './json'
import { decodeV4, readV4 } from './migrate'
import { V4_SNAPSHOT_TAG } from './snapshots'

/** A snapshot body (§9.7): a wire doc, or the raw v4 strings of the pre-v5 snapshot. */
export function decodeSnapshot(body: string, at: number): Doc {
  const p = parseJson(body)
  if (p === null) return EMPTY_DOC
  const tagged = isPlainObject(p.value) ? own(p.value, V4_SNAPSHOT_TAG) : undefined
  if (isPlainObject(tagged)) {
    const rank = own(tagged, 'rank') === '0' ? 0 : 1
    const v4 = readV4((k) => {
      const v = own(tagged, k)
      return typeof v === 'string' ? v : null
    })
    return decodeV4(v4, { legacyRank: rank, at, fold: true }).doc
  }
  return decodeWire(p.value, 'snapshot', { at }).doc
}

/** salvageJsonArray on the damaged body's collections (§9.6.3 step 2), best effort. */
export function salvageEnvelope(raw: string, at: number, rank: 0 | 1): Doc {
  const body = envelopeBody(raw)?.body ?? raw
  const span = (name: string): string | undefined => {
    const marker = `"${name}":[`
    const i = body.indexOf(marker)
    return i < 0 ? undefined : body.slice(i + marker.length - 1)
  }
  const v4 = readV4((k) => {
    if (k === 'expenses') return span('expenses') ?? null
    if (k === 'deletedExpenseIds') return span('deletedIds') ?? null
    if (k === 'categories') return span('categories') ?? null
    return null
  })
  return decodeV4(v4, { legacyRank: rank, at, fold: true }).doc
}
