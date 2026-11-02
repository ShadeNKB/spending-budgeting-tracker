// Demo builds only (DATA-ENGINE-SPEC §7.11, P2-22): the sample data as the doc a pristine demo
// origin is seeded with, once ever. On every other build the engine never calls this, so the
// module and the seed data are dropped from the bundle.
import { DEMO_BUDGETS, DEMO_CATEGORIES, DEMO_EXPENSES, DEMO_MAPPINGS } from '../../demo/seedData'
import type { Doc } from '../core/types'
import { decodeWire } from '../core/wire'

/** The seed, read as a 0.9.x v4 save (rank 1) would be. */
export function decodeSeed(at: number): Doc {
  const seed = {
    version: '4.0',
    expenses: DEMO_EXPENSES,
    categories: DEMO_CATEGORIES,
    categoryMappings: DEMO_MAPPINGS,
    budgets: DEMO_BUDGETS,
  }
  return decodeWire(seed, 'local-v4', { legacyRank: 1, at }).doc
}
