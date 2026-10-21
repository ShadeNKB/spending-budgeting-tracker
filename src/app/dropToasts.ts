import { useUIStore } from '../stores/useUIStore'

/**
 * Removes every queued toast. The toast host's error boundary calls it after a crash: the
 * toasts it held can no longer be shown and their dismiss timers died with it. While they
 * stay queued the boundary, which resets when the queue empties, would keep every later
 * toast hidden too, the storage-full warning included.
 */
export function dropToasts(): void {
  const { toasts, dismissToast } = useUIStore.getState()
  for (const toast of toasts) dismissToast(toast.id)
}
