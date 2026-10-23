// The field oracle (§16.4, P-17): every register value a v5 replica ever held, joined per field.
// After all replicas exchange, each live record's field must equal that join: exact (s, r, value)
// for n a d o x; for c exact (s, r) and the value after resolving through the final rename table
// (only (s, r) once a re-add happened in the run).
import { resolver } from '../../core/categories'
import { FIELD_KEYS } from '../../core/constants'
import { canon } from '../../core/hash'
import type { Doc, ExpenseRec, FieldKey, RenameReg } from '../../core/types'

interface Best {
  s: number
  r: number
  /** Canonical values seen at (s, r). */
  values: Set<string>
  /** Raw category names seen at (s, r) (field c only). */
  names: Set<string>
}

const cmp = (s: number, r: number, b: Best): number => (s !== b.s ? s - b.s : r - b.r)

export class FieldOracle {
  private readonly best = new Map<string, Map<FieldKey, Best>>()
  reAdd = false

  observeRecord(rec: ExpenseRec): void {
    let fields = this.best.get(rec.id)
    if (fields === undefined) {
      fields = new Map()
      this.best.set(rec.id, fields)
    }
    for (const f of FIELD_KEYS) {
      const g = rec[f]
      const v = canon(g.v)
      const name = f === 'c' ? rec.c.v : null
      const cur = fields.get(f)
      if (cur === undefined || cmp(g.s, g.r, cur) > 0) {
        fields.set(f, {
          s: g.s,
          r: g.r,
          values: new Set([v]),
          names: new Set(name === null ? [] : [name]),
        })
      } else if (cmp(g.s, g.r, cur) === 0) {
        cur.values.add(v)
        if (name !== null) cur.names.add(name)
      }
    }
  }

  /** Feed every record object that changed between two docs of one replica. */
  observe(before: Doc, after: Doc): void {
    for (const [id, rec] of after.expenses)
      if (before.expenses.get(id) !== rec) this.observeRecord(rec)
    for (const [k, g] of after.renames) {
      const prev: RenameReg | undefined = before.renames.get(k)
      if (g.to === null && prev !== undefined && prev.to !== null) this.reAdd = true
    }
  }

  /** Mismatches between a converged doc and the oracle (empty = I2 holds). */
  check(doc: Doc): string[] {
    const res = resolver(doc.renames)
    const out: string[] = []
    for (const [id, rec] of doc.expenses) {
      const fields = this.best.get(id)
      if (fields === undefined) {
        out.push(`${id}: never observed`)
        continue
      }
      for (const f of FIELD_KEYS) {
        const want = fields.get(f)
        const g = rec[f]
        if (want === undefined) continue
        if (g.s !== want.s || g.r !== want.r) {
          out.push(`${id}.${f}: (${g.s},${g.r}) vs oracle (${want.s},${want.r})`)
          continue
        }
        const v = canon(g.v)
        if (f !== 'c') {
          // ties at equal (s, r) resolve by the larger canonical value
          const top = [...want.values].sort().at(-1)
          if (v !== top) out.push(`${id}.${f}: ${v} vs oracle ${top ?? '?'}`)
        } else if (!this.reAdd) {
          const allowed = new Set([...want.names].map(res))
          if (!allowed.has(rec.c.v))
            out.push(`${id}.c: ${rec.c.v} not in ${[...allowed].join('|')}`)
        }
      }
    }
    return out
  }
}
