import { installPersistence, useExpenseStore } from '../stores/useExpenseStore'
import { installSync } from '../stores/useSyncStore'

// Bootstrap runs once per page load — wired in a top-level useEffect rather than
// at module scope so React is fully mounted before we touch localStorage.
let bootstrapped = false
export function bootstrap() {
  if (bootstrapped || typeof window === 'undefined') return
  bootstrapped = true

  // The engine chunk is already loading (main.tsx); the shell shows its status until it is in.
  void useExpenseStore.getState().hydrate()
  installPersistence()
  // Local changes, lifecycle events (hide/resume/online) and realtime drive sync from here.
  installSync()
}
