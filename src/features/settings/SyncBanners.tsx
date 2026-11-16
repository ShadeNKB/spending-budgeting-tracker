import { useId } from 'react'
import { AlertCircle, Download, Info, RefreshCw, type LucideIcon } from 'lucide-react'
import clsx from 'clsx'
import {
  OLD_DEVICE_WAITING,
  failureSeverity,
  needsReload,
  reloadSpendTrack,
  useSyncStore,
} from '../../stores/useSyncStore'
import { useUIStore } from '../../stores/useUIStore'
import { bannerText } from './syncPanelView'

const LEGACY_BANNER_MS = 24 * 60 * 60_000

type BannerTone = 'error' | 'warning' | 'info'

const BANNER_TONE: Record<BannerTone, string> = {
  error: 'border-negative/20 bg-negative/10 text-negative',
  warning: 'border-warning/25 bg-warning/10 text-warning',
  info: 'border-white/[0.1] bg-white/[0.03] text-[var(--text-secondary)]',
}

const ACTION_TONE: Record<Exclude<BannerTone, 'info'>, string> = {
  error: 'border-negative/30 text-negative hover:bg-negative/10',
  warning: 'border-warning/30 text-warning hover:bg-warning/10',
}

interface BannerView {
  key: 'reload' | 'failing' | 'old-device' | 'size'
  tone: BannerTone
  icon: LucideIcon
  text: string
  action?: { icon: LucideIcon; label: string; onClick: () => void }
}

const UNTIL_UPDATED =
  "Until then, don't rename categories, restore backups or delete everything on it."

/** What the old-device banner says: one sentence, the oldest writer seen first. */
function oldDeviceText(
  seen: { v084: boolean; v085: boolean; v5pre: boolean },
  waiting: boolean,
): string | null {
  if (seen.v084) {
    return `${
      waiting
        ? 'An older SpendTrack (0.8.4 or earlier) on your other device keeps overwriting the synced copy. Open it and reload; everything is saved here.'
        : 'A device still runs an old SpendTrack (0.8.4 or earlier). Open it and reload.'
    } ${UNTIL_UPDATED}`
  }
  if (waiting) return OLD_DEVICE_WAITING
  const version = seen.v085 ? '0.9.2' : seen.v5pre ? '0.10.0' : null
  return version === null
    ? null
    : `Your other device runs SpendTrack ${version}. Open it and reload to update.`
}

/** What the owner must know about sync right now, worst first. */
function useBanners(): BannerView[] {
  const lastError = useSyncStore((s) => s.lastError)
  const legacyWriterAt = useSyncStore((s) => s.legacyWriterAt)
  const waitingForOld = useSyncStore((s) => s.waitingForOld)
  const view = useSyncStore((s) => s.view)
  const focusSettings = useUIStore((s) => s.focusSettings)
  const banners: BannerView[] = []
  if (lastError && needsReload(lastError.kind)) {
    banners.push({
      key: 'reload',
      tone: 'warning',
      icon: AlertCircle,
      text: bannerText(lastError),
      // A new build that is already waiting takes over first; a plain reload would come back
      // on the old one, to the same pause.
      action: { icon: RefreshCw, label: 'Reload', onClick: reloadSpendTrack },
    })
  } else if (lastError && lastError.kind !== 'offline') {
    banners.push({
      key: 'failing',
      tone: failureSeverity(lastError) === 'warning' ? 'warning' : 'error',
      icon: AlertCircle,
      text: bannerText(lastError),
      // The message says to export a backup: one tap to the button that does it.
      action:
        lastError.kind === 'too-large'
          ? {
              icon: Download,
              label: 'Export backup',
              onClick: () => focusSettings('backup', 'backup-download'),
            }
          : undefined,
    })
  }
  const now = Date.now()
  const recent = (at: number | null | undefined) =>
    at !== null && at !== undefined && now - at < LEGACY_BANNER_MS
  const old = oldDeviceText(
    {
      v084: recent(legacyWriterAt) || recent(view?.legacy.v084At),
      v085: recent(view?.legacy.v085At),
      v5pre: recent(view?.legacy.v5preAt),
    },
    waitingForOld > 0,
  )
  if (old !== null) banners.push({ key: 'old-device', tone: 'info', icon: Info, text: old })
  const pct = view?.sizePct ?? null
  // Over 100 % the too-large pause says it already, with the size.
  if (pct !== null && pct >= 70 && lastError?.kind !== 'too-large') {
    banners.push({
      key: 'size',
      tone: pct >= 90 ? 'warning' : 'info',
      icon: pct >= 90 ? AlertCircle : Info,
      text: `Sync uses ${String(pct)} % of the relay limit. At 100 % sync pauses; your data stays on this device.`,
    })
  }
  return banners
}

/**
 * The banners, and one live region that is always mounted (empty when all is well), so a
 * banner that appears while the panel is open is announced: screen readers read what is added
 * to a region, not a region added with it. The region holds the sentences only, as the pill's
 * does: a button inside it would be read as part of the sentence ("…to update. Reload"). The
 * banner shows the same words to the eye, and its button is described by them.
 */
export function SyncBanners({ flush = false }: { flush?: boolean }) {
  const banners = useBanners()
  const idBase = useId()
  const textId = (key: BannerView['key']) => `${idBase}-${key}`
  return (
    <>
      <div role="status" className="sr-only">
        {banners.map((b) => (
          <p key={b.key} id={textId(b.key)}>
            {b.text}
          </p>
        ))}
      </div>
      {/* Empty, it takes no space; with a banner, the margin stands in for the card's gap. */}
      <div className={clsx('flex flex-col gap-2', !flush && '[&:not(:empty)]:mt-3')}>
        {banners.map(({ key, tone, icon: Icon, text, action }) => (
          <div
            key={key}
            className={clsx(
              'flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-2.5 py-2 text-[13px] leading-relaxed md:text-[11px]',
              BANNER_TONE[tone],
            )}
          >
            <Icon size={12} className="shrink-0" aria-hidden="true" />
            <span aria-hidden="true" className="min-w-0 flex-1 basis-40">
              {text}
            </span>
            {action && tone !== 'info' && (
              <button
                type="button"
                onClick={action.onClick}
                aria-describedby={textId(key)}
                className={clsx(
                  'tap-target inline-flex h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12px] font-medium transition md:h-8',
                  ACTION_TONE[tone],
                )}
              >
                <action.icon size={12} aria-hidden="true" /> {action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  )
}
