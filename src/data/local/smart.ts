// The smart category (DATA-ENGINE-SPEC §6.6, track spec §8.10): core's exact mapping lookup first,
// then a fuzzy match over the mappings whose target is live. A stale mapping never files a new
// entry into a dead category (F-012). It is the one matcher behind every way in: the add itself,
// the Add sheet's suggestion, and the quick bar and palette on every keystroke (F-044), so the
// fuzzy step is fuzzy.ts's pruned search (Fuse's own ranking, without a full Fuse search). The
// names are made ready once per mappings and renames.
import { FUSE_SCORE_CUTOFF, FUSE_THRESHOLD } from '../../constants'
import { liveMappingEntries, mappingKey, mappingLookup } from '../core/categories'
import type { Doc, MapReg, RenameReg } from '../core/types'
import { closestKey, prepareNames, type PreparedNames } from './fuzzy'

/** As the Fuse index this replaced was set up: a match needs two matched characters in a row. */
const FUZZY = { threshold: FUSE_THRESHOLD, minMatchCharLength: 2 }

interface Live {
  readonly renames: ReadonlyMap<string, RenameReg>
  readonly names: PreparedNames
  readonly categories: ReadonlyMap<string, string>
}

const liveCache = new WeakMap<ReadonlyMap<string, MapReg>, Live>()

/** core exact lookup; otherwise fuzzy over the mappings whose target is live (§6.6). */
export function smartCategory(doc: Doc, itemName: string): string | null {
  const key = mappingKey(itemName)
  if (key === '') return null
  if (doc.mappings.has(key)) return mappingLookup(doc, itemName)
  let live = liveCache.get(doc.mappings)
  if (live?.renames !== doc.renames) {
    const entries = liveMappingEntries(doc)
    live = {
      renames: doc.renames,
      names: prepareNames(entries.map(([item]) => item)),
      categories: new Map(entries),
    }
    liveCache.set(doc.mappings, live)
  }
  const best = closestKey(live.names, key, FUZZY)
  return best !== null && best.score < FUSE_SCORE_CUTOFF
    ? (live.categories.get(best.key) ?? null)
    : null
}
