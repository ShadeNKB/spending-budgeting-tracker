// Invariant checks shared by the simulation and the probes (§1.2 I1, I3, I4).
import { digestDoc } from '../../core/doc'
import { recordString } from '../../core/record'
import type { Doc, MergeResult } from '../../core/types'
import { decodeWire } from '../../core/wire'

/** I1: every record that left the live set in a merge is reported in `removed`. */
export function checkI1(local: Doc, m: MergeResult): string[] {
  const removed = new Set(m.removed.map((r) => r.id))
  const out: string[] = []
  for (const id of local.expenses.keys()) {
    if (!m.doc.expenses.has(id) && !removed.has(id)) out.push(`I1: ${id} vanished without a report`)
  }
  return out
}

/** I3 + I-doc-1: a tombstone, once seen, stays and its id is never live again. */
export class TombWatch {
  private readonly seen = new Set<string>()

  check(doc: Doc): string[] {
    const out: string[] = []
    for (const id of this.seen) {
      if (!doc.tombs.has(id)) out.push(`I3: tombstone ${id} was dropped`)
      if (doc.expenses.has(id)) out.push(`I3: ${id} resurrected`)
    }
    for (const id of doc.tombs.keys()) {
      this.seen.add(id)
      if (doc.expenses.has(id)) out.push(`I-doc-1: ${id} live and tombstoned`)
    }
    return out
  }
}

/** I4: equal digests and byte-identical records on every replica and the relay. */
export function checkI4(docs: readonly Doc[], relayRow: string | null): string[] {
  const out: string[] = []
  const first = docs[0]
  if (first === undefined) return out
  const digest = digestDoc(first)
  docs.forEach((d, i) => {
    if (digestDoc(d) !== digest) out.push(`I4: replica ${i} digest ${digestDoc(d)} ≠ ${digest}`)
    for (const [id, rec] of first.expenses) {
      const other = d.expenses.get(id)
      if (other === undefined || recordString(other) !== recordString(rec))
        out.push(`I4: replica ${i} record ${id} differs`)
    }
  })
  if (relayRow !== null) {
    const parsed: unknown = JSON.parse(relayRow)
    const relay = decodeWire(parsed, 'remote').doc
    if (digestDoc(relay) !== digest) out.push(`I4: relay digest ${digestDoc(relay)} ≠ ${digest}`)
    const list: unknown =
      typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'expenses') : null
    const strings = new Set(Array.isArray(list) ? list.map((r: unknown) => JSON.stringify(r)) : [])
    for (const rec of first.expenses.values()) {
      if (!strings.has(recordString(rec))) out.push(`I4: relay record ${rec.id} not byte-equal`)
    }
  }
  return out
}
