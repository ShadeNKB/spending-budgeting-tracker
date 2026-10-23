import { WifiOff } from 'lucide-react'
import { syncEnabled } from '../services/syncConfig'
import { isPaused, useSyncStore } from '../stores/useSyncStore'

/**
 * The strip under the top bar while the device is offline. It promises a sync only when one will
 * run by itself once the device is back: sync is set up, and not paused until the owner acts.
 */
export function OfflineBanner() {
  const willSync = useSyncStore(
    (s) =>
      syncEnabled && s.syncId !== null && !(s.lastError !== null && isPaused(s.lastError.kind)),
  )
  return (
    <div className="offline-banner-in">
      <div className="flex items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-center text-[12px] text-warning">
        <WifiOff size={12} className="shrink-0" aria-hidden="true" />
        {willSync
          ? "You're offline — changes are saved on this device and will sync when you're back"
          : "You're offline — changes are saved on this device"}
      </div>
    </div>
  )
}
