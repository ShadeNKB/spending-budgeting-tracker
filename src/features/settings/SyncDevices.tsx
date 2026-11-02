import { useId } from 'react'
import clsx from 'clsx'
import { useSyncStore, type DeviceRow, type SyncView } from '../../stores/useSyncStore'
import { timeAgo } from './previousCode'

const DAY = 24 * 60 * 60_000

/** "SpendTrack 0.10.0 · seen 3 days ago · update it". */
function meta(d: DeviceRow, now: number): string {
  let text = `SpendTrack ${d.app}`
  if (d.stale) return `${text} · not seen for ${String(Math.floor((now - d.seen) / DAY))} days`
  if (!d.me && d.seen > 0) text += ` · seen ${timeAgo(d.seen, now)}`
  return d.older ? `${text} · update it` : text
}

/** How changes arrive: live, or on open and every minute; and through the relay's functions. */
const LIVE: Partial<Record<SyncView['live'], string>> = {
  on: 'Live updates on',
  polling: 'Live updates unavailable · syncing on open and every minute',
}

/**
 * What the engine knows about live updates, the relay and readiness, in plain words; how changes
 * arrive is one line. Offline or paused, nothing syncs live or every minute, and what the devices
 * run waits for the next sync: those words wait too. While the channel joins, live updates are
 * neither on nor unavailable.
 */
function footnotes(v: SyncView, quiet: boolean): string[] {
  const notes: string[] = []
  if (!quiet && v.allCurrent) notes.push(`All your devices run SpendTrack ${__APP_VERSION__}.`)
  const live = quiet ? undefined : LIVE[v.live]
  const rpc = v.transport === 'rpc' ? "the relay's sync functions" : null
  if (live !== undefined) notes.push(rpc === null ? `${live}.` : `${live} · using ${rpc}.`)
  else if (rpc !== null) notes.push(`Using ${rpc}.`)
  if (v.lockdown) {
    notes.push(
      v.lockdown.ready || v.lockdown.reason === null
        ? 'Ready for the database lockdown.'
        : `Not ready for the database lockdown: ${v.lockdown.reason}`,
    )
  }
  return notes
}

/**
 * The devices on this sync, from the relay copy's registry (§11.10): this device first, then the
 * others, each with its version and when it was last seen. It is what the owner reads before an
 * update gate ("All your devices run SpendTrack …"). A device unseen for 60 days is greyed and
 * asks nothing; a device on a release that never registers itself comes named by that release
 * ("Older SpendTrack (0.9.2)").
 */
export function SyncDevices() {
  const view = useSyncStore((s) => s.view)
  const quiet = useSyncStore((s) => s.cloudStatus === 'offline' || s.cloudStatus === 'paused')
  const headingId = useId()
  if (view === null) return null
  const now = Date.now()
  return (
    <div className="flex flex-col gap-1.5">
      {view.devices.length > 0 && (
        <>
          <h3 id={headingId} className="text-[11px] font-normal text-[var(--text-tertiary)]">
            Devices
          </h3>
          <ul aria-labelledby={headingId} className="flex flex-col gap-1.5">
            {view.devices.map((d) => (
              <li
                key={d.id}
                className="rounded-md border border-white/[0.06] bg-surface-2 px-3 py-2"
              >
                <p
                  className={clsx(
                    'text-[13px] leading-snug',
                    d.stale ? 'text-[var(--text-tertiary)]' : d.me ? 'text-accent' : 'text-white',
                  )}
                >
                  {d.name}
                </p>
                <p className="text-[12px] leading-snug text-[var(--text-tertiary)]">
                  {meta(d, now)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      {footnotes(view, quiet).map((note) => (
        <p key={note} className="text-[12px] leading-relaxed text-[var(--text-tertiary)]">
          {note}
        </p>
      ))}
    </div>
  )
}
