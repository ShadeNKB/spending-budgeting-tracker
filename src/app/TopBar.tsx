import { useEffect, useRef } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { Command, Plus, Settings2 } from 'lucide-react'
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

/**
 * Publishes the header's rendered height as `--app-header-h` on <html>, where the scroll margin
 * of the screen's controls (index.css) keeps a focused one from scrolling under the sticky
 * header. The height follows the safe area and the update banner.
 */
function usePublishedHeaderHeight(header: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = header.current
    if (!el) return
    const root = document.documentElement
    const publish = () => {
      root.style.setProperty('--app-header-h', `${Math.ceil(el.getBoundingClientRect().height)}px`)
    }
    publish()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.style.removeProperty('--app-header-h')
    }
  }, [header])
}

export function TopBar() {
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const header = useRef<HTMLElement>(null)
  usePublishedHeaderHeight(header)

  return (
    // The installed iOS app draws under the status bar (viewport-fit=cover + black-translucent),
    // so the sticky header owns the top inset; the side insets clear the notch in landscape.
    <header
      ref={header}
      className="sticky top-0 z-40 border-b border-white/[0.06] bg-surface-0/80 pt-[env(safe-area-inset-top,0px)] backdrop-blur-xl"
    >
      {/* Phones: 44 px touch targets in a 10 px padded row (the bar stays 64 px tall).
          md and up: the compact 40 px controls in a 12 px padded row, with a 44 px hit area on
          touch screens (tablets). */}
      <div
        className={`mx-auto flex max-w-[1200px] items-center gap-3 py-2.5 md:py-3 ${SAFE_GUTTER_X}`}
      >
        {/* A plain link: the logo is not a navigation item, so it never reads as "current page". */}
        <Link
          to="/pulse"
          className="tap-target flex min-h-11 shrink-0 items-center gap-2 rounded-lg md:min-h-0"
        >
          <SpendLogo size={28} animated />
          <span className="text-[15px] font-semibold tracking-tight text-white">SpendTrack</span>
        </Link>

        <nav
          aria-label="Primary"
          className="ml-2 hidden items-center gap-0.5 rounded-full border border-white/[0.06] bg-surface-1 p-1 md:flex"
        >
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                clsx(
                  'tap-target inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium transition',
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

        {/* The pill shows from 1280 px (display: none below, so never a hidden focus stop); its
            live region is rendered at every width, so it still says when saving or syncing goes
            wrong. */}
        <SyncPill />

        {/* 768 to 1023 px have neither the tab bar's + nor the quick-add field: Add gets a place
            of its own there (F-083). It pushes the controls after it to the right edge. */}
        <button
          type="button"
          onClick={() => setAddSheetOpen(true)}
          className="tap-target ml-auto hidden h-10 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[13px] font-semibold text-surface-0 transition hover:bg-accent-hover md:inline-flex lg:hidden"
          aria-label="Add expense"
        >
          <Plus size={15} strokeWidth={2.5} aria-hidden />
          Add
        </button>

        {/* Named by its visible word, so voice control ("click Search") finds it. On a phone it
            starts the row's right-hand group (F-111); from 1024 px the quick-add field fills the
            row before it. */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="tap-target ml-auto inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-white/[0.06] bg-surface-1 px-3 text-[12px] text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white md:ml-0 md:h-10"
          aria-label="Search"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Command size={13} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded border border-white/[0.06] bg-surface-2 px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)] sm:inline [@media(pointer:coarse)]:hidden">
            Ctrl+K
          </kbd>
        </button>

        {/* From 768 px, where there is no tab bar. On a phone Settings is in the tab bar, under
            the thumb: a second one up here was a desktop leftover (F-111). */}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="tap-target hidden h-10 w-10 items-center justify-center rounded-full text-[var(--text-secondary)] transition hover:bg-surface-2 hover:text-white md:inline-flex"
          aria-label="Settings"
        >
          <Settings2 size={16} />
        </button>
      </div>
      <UpdateBanner />
    </header>
  )
}
