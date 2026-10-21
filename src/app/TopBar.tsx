import { NavLink } from 'react-router-dom'
import { Command, Settings2 } from 'lucide-react'
import clsx from 'clsx'
import { SmartInput } from '../features/entry/SmartInput'
import { SyncPill } from './SyncPill'
import { useUIStore } from '../stores/useUIStore'
import { SpendLogo } from '../ui/SpendLogo'
import { UpdateBanner } from './UpdateBanner'
import { SAFE_GUTTER_X } from './safeArea'

const links = [
  { to: '/pulse', label: 'Pulse' },
  { to: '/ledger', label: 'Ledger' },
  { to: '/insights', label: 'Insights' },
]

export function TopBar() {
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)

  return (
    // The installed iOS app draws under the status bar (viewport-fit=cover + black-translucent),
    // so the sticky header owns the top inset; the side insets clear the notch in landscape.
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-surface-0/80 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl">
      {/* Phones: 44 px touch targets in a 10 px padded row (the bar stays 64 px tall).
          md and up: the compact 40 px controls in a 12 px padded row. */}
      <div
        className={`mx-auto flex max-w-[1200px] items-center gap-3 py-2.5 md:py-3 ${SAFE_GUTTER_X}`}
      >
        <NavLink to="/pulse" className="flex min-h-11 shrink-0 items-center gap-2 md:min-h-0">
          <SpendLogo size={28} animated />
          <span className="text-[15px] font-semibold tracking-tight text-white">SpendTrack</span>
        </NavLink>

        <nav className="ml-2 hidden items-center gap-0.5 rounded-full border border-white/[0.06] bg-surface-1 p-1 md:flex">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                clsx(
                  'inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium transition',
                  isActive
                    ? 'bg-accent/12 text-accent shadow-[inset_0_0_0_1px_rgba(34,211,238,0.18)]'
                    : 'text-[var(--text-secondary)] hover:text-white',
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden min-w-0 flex-1 lg:block">
          <SmartInput dense className="mx-auto max-w-[520px]" />
        </div>

        <div className="hidden xl:block">
          <SyncPill />
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-white/[0.06] bg-surface-1 px-3 text-[12px] text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white md:h-10"
          aria-label="Open command palette"
        >
          <Command size={13} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-white/[0.06] bg-surface-2 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] sm:inline">
            Ctrl+K
          </kbd>
        </button>

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white md:h-10 md:w-10"
          aria-label="Settings"
        >
          <Settings2 size={16} />
        </button>
      </div>
      <UpdateBanner />
    </header>
  )
}
