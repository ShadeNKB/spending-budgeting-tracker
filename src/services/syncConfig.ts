// Build-time relay settings. Eager and tiny on purpose: a build without them constant-folds
// `syncEnabled` to false and drops the sync engine, and a build with them still loads the
// engine (src/stores/syncEngine.ts) and the Supabase SDK only when sync is used.

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const syncEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY)

/**
 * This build's relay can keep a private bucket safe (PRIVATE-SYNC 3.3, 3.6): it writes by
 * compare-and-set, through the sync functions (`auto`, `rpc`) or the table with CAS on. A new
 * sync made by such a build is private; on the upsert transport it is a plain one, as before.
 */
export const privateSyncReady: boolean =
  syncEnabled &&
  (import.meta.env.VITE_SYNC_RELAY === 'auto' ||
    import.meta.env.VITE_SYNC_RELAY === 'rpc' ||
    import.meta.env.VITE_SYNC_CAS === 'on')
