import { WifiOff } from 'lucide-react'
import { syncEnabled } from '../services/syncConfig'
import { syncsWhenOnline, useSyncStore } from '../stores/useSyncStore'

/**
 * The strip under the top bar while the device is offline. It promises a sync only when one will
 * run by itself once the device is back: sync is set up and loaded, and nothing it knows (a
 * pause, refused access, a long failure streak) stands in the way.
 */
export function OfflineBanner() {
  const willSync = useSyncStore((s) => syncEnabled && syncsWhenOnline(s))
  return (
    <div className="offline-banner-in">
      {/* In the light theme amber-700 on this tint measured 4.29:1; the pill's amber-800 clears 4.5:1. */}
      <div className="flex items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-center text-[12px] text-warning [[data-theme=light]_&]:text-[#92400e]">
        <WifiOff size={12} className="shrink-0" aria-hidden="true" />
        {willSync
          ? "You're offline — changes are saved on this device and will sync when you're back"
          : "You're offline — changes are saved on this device"}
      </div>
    </div>
  )
}
