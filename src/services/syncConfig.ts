// Build-time relay settings. Eager and tiny on purpose: a build without them constant-folds
// `syncEnabled` to false and drops the sync engine, and a build with them still loads the
// engine (src/stores/syncEngine.ts) and the Supabase SDK only when sync is used.

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const syncEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY)
