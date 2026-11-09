// The smart category (DATA-ENGINE-SPEC §6.6, track spec §8.10): core's exact mapping lookup first,
// then a fuzzy match over the mappings whose target is live. A stale mapping never files a new
// entry into a dead category (F-012). The Fuse index is built once per mappings and renames.
import Fuse from 'fuse.js/basic'
import { FUSE_SCORE_CUTOFF, FUSE_THRESHOLD } from '../../constants'
import { liveMappingEntries, mappingKey, mappingLookup } from '../core/categories'
import type { Doc, MapReg, RenameReg } from '../core/types'

interface FuseItem {
  readonly item: string
  readonly category: string
}

const fuseCache = new WeakMap<
  ReadonlyMap<string, MapReg>,
  { readonly renames: ReadonlyMap<string, RenameReg>; readonly fuse: Fuse<FuseItem> | null }
>()

/** core exact lookup; otherwise fuzzy over the mappings whose target is live (§6.6). */
export function smartCategory(doc: Doc, itemName: string): string | null {
  const key = mappingKey(itemName)
  if (key === '') return null
  if (doc.mappings.has(key)) return mappingLookup(doc, itemName)
  let hit = fuseCache.get(doc.mappings)
  if (hit?.renames !== doc.renames) {
    const items = liveMappingEntries(doc).map(([item, category]) => ({ item, category }))
    hit = {
      renames: doc.renames,
      fuse:
        items.length === 0
          ? null
          : new Fuse(items, {
              keys: ['item'],
              threshold: FUSE_THRESHOLD,
              includeScore: true,
              minMatchCharLength: 2,
            }),
    }
    fuseCache.set(doc.mappings, hit)
  }
  const best = hit.fuse?.search(key)[0]
  return best !== undefined && (best.score ?? 1) < FUSE_SCORE_CUTOFF ? best.item.category : null
}
