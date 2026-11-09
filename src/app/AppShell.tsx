import { lazy, useCallback, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { TopBar } from './TopBar'
import { TabBar } from './TabBar'
import { OfflineBanner } from './OfflineBanner'
import { BootFailure, DataNotices, QUOTA_TOAST } from './DataNotices'
import { OverlaySlot } from './OverlaySlot'
import { dropToasts } from './dropToasts'
import { useAppliedTheme } from './useAppliedTheme'
import { useLaunchActions } from './useLaunchActions'
import { ToastAnnouncer } from './ToastAnnouncer'
import { useRouteFocus } from './useRouteFocus'
import { useScreenTitle } from './useScreenTitle'
import { SAFE_GUTTER_X } from './safeArea'
import {
  IS_DEMO,
  installPersistence,
  isOwnRow,
  UNDO_TOO_LATE,
  undoOutcomeMessage,
  useExpenseStore,
  whenHydrated,
} from '../stores/useExpenseStore'
import { installSync } from '../stores/useSyncStore'
import { useUIStore } from '../stores/useUIStore'
import { useHotkeys } from '../hooks/useHotkeys'
import { useToast } from '../hooks/useToast'
import { useIdle } from '../hooks/useIdle'
import { useToday } from '../hooks/useToday'
import { importWithReload } from '../lib/chunkReload'
import { toDayKey } from '../lib/dates'

// Overlays hidden on first paint. lazy() alone does not keep them (or the motion runtime
// they share) off the critical path: a lazy component that is rendered at boot is fetched at
// boot. So each overlay mounts through an OverlaySlot, on its first open or once the app goes
// idle after load, whichever comes first. A stale chunk reloads once (each site spelled out:
// src/__tests__/lazy-imports.test.ts checks every one).
const SettingsDrawer = lazy(() =>
  importWithReload(() => import('../features/settings/SettingsDrawer')).then((m) => ({
    default: m.SettingsDrawer,
  })),
)
const CommandPalette = lazy(() =>
  importWithReload(() => import('../features/entry/CommandPalette')).then((m) => ({
    default: m.CommandPalette,
  })),
)
const AddExpenseSheet = lazy(() =>
  importWithReload(() => import('../features/entry/AddExpenseSheet')).then((m) => ({
    default: m.AddExpenseSheet,
  })),
)
const ToastHost = lazy(() =>
  importWithReload(() => import('../ui/ToastHost')).then((m) => ({ default: m.ToastHost })),
)
const HotkeyHints = lazy(() =>
  importWithReload(() => import('../ui/HotkeyHints')).then((m) => ({ default: m.HotkeyHints })),
)
// The first-run card and the backup nudge (PR-4): one chunk (its default export, so no wrapper
// here), fetched only when the cheap check in AppShell says a card may be wanted. It decides
// the rest itself.
const DataCards = lazy(() => importWithReload(() => import('./DataCards')))

/**
 * WebKit brings a text field that takes focus into view by its caret line and ignores the
 * field's scroll margin (index.css), so Shift+Tab could leave it under the sticky header: bring
 * the whole field, ring included, clear of it. A no-op where it already is.
 */
function revealTextField(e: React.FocusEvent): void {
  const field = e.target
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)
    field.scrollIntoView({ block: 'nearest' })
}

// Bootstrap runs once per page load — wired in a top-level useEffect rather than
// at module scope so React is fully mounted before we touch localStorage.
let bootstrapped = false
function bootstrap() {
  if (bootstrapped || typeof window === 'undefined') return
  bootstrapped = true

  // The engine chunk is already loading (main.tsx); the shell shows its status until it is in.
  void useExpenseStore.getState().hydrate()
  installPersistence()
  // Local changes, lifecycle events (hide/resume/online) and realtime drive sync from here.
  installSync()
}

export function AppShell() {
  const hydrated = useExpenseStore((s) => s.hydrated)
  const bootError = useExpenseStore((s) => s.bootError)
  const isOffline = useExpenseStore((s) => s.isOffline)
  const theme = useUIStore((s) => s.theme)
  const paletteOpen = useUIStore((s) => s.paletteOpen)
  const settingsOpen = useUIStore((s) => s.settingsOpen)
  const hasToasts = useUIStore((s) => s.toasts.length > 0)
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setHotkeysOpen = useUIStore((s) => s.setHotkeysOpen)
  const hotkeysOpen = useUIStore((s) => s.hotkeysOpen)
  const addSheetOpen = useUIStore((s) => s.addSheetOpen)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const toast = useToast()
  const today = useToday()
  // The cheap first look for the data cards, run on every store change: an empty device that is
  // saving (a first run, maybe), or own entries (only a demo build has rows that are not the
  // owner's: its sample data) with no backup for 29 days, the nudge's 30 local calendar days
  // less one for a DST hour either way. It may say yes early, never late: the chunk checks the
  // rest (stored data, a sync code, the calendar days, sync health and Later). Every byte here is
  // startup code, so nothing it can leave to the chunk is checked here. The build flag comes
  // first: a production build folds it away.
  const cards = useExpenseStore(
    (s) =>
      s.local === 'saved' &&
      (s.expenses.length === 0
        ? !IS_DEMO
        : (!IS_DEMO || s.expenses.some(isOwnRow)) &&
          (s.facts.lastBackupAt === null ||
            toDayKey(new Date(s.facts.lastBackupAt + 29 * 86_400_000)) <= today)),
  )

  const idle = useIdle()
  // Stable close handlers: the overlays get the same onClose on every shell render.
  const closeAddSheet = useCallback(() => setAddSheetOpen(false), [setAddSheetOpen])
  const closeHotkeys = useCallback(() => setHotkeysOpen(false), [setHotkeysOpen])

  useEffect(bootstrap, [])

  useAppliedTheme(theme)
  useLaunchActions()
  useRouteFocus()
  useScreenTitle()

  // Surface storage quota errors to the user — without this the app would
  // silently fail to persist, which is the worst possible UX for a finance
  // tracker. Listener fires once per session per quota incident.
  // A quota hit while the data loads waits for the boot's outcome: a boot that ends memory-only
  // says what to do in its own strip, and "clear old data" is the wrong advice there.
  useEffect(() => {
    const onQuota = () => {
      void whenHydrated().then(() => {
        if (useExpenseStore.getState().local === 'memory-only') return
        toast.error(QUOTA_TOAST, { duration: 12000 })
      })
    }
    window.addEventListener('spendtrack:quota-exceeded', onQuota)
    return () => window.removeEventListener('spendtrack:quota-exceeded', onQuota)
  }, [toast])

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    'mod+n': () => setAddSheetOpen(true),
    // A browser tab keeps Ctrl+N for a new window (only an installed app gets it): Alt+N works
    // there too. (On a Mac, Ctrl+N is free in a tab; Option+N types a character.)
    'alt+n': () => setAddSheetOpen(true),
    'mod+,': () => setSettingsOpen(true),
    '?': () => setHotkeysOpen(true),
    // Read the undo stack on demand: subscribing to it re-rendered the whole shell on every add.
    'mod+z': () => {
      const store = useExpenseStore.getState()
      const last = store.undoStack.at(-1)
      if (!last) return
      // Said every time: unlike an Undo button, the key press has nothing on screen to answer it.
      const outcome = store.consumeUndo(last.id)
      if (outcome === null) toast.info(UNDO_TOO_LATE)
      else if (outcome.skipped > 0) toast.warning(undoOutcomeMessage(outcome))
      else toast.info(undoOutcomeMessage(outcome))
    },
    // No Escape here: each sheet, the palette and the date picker close on it themselves, top
    // layer first (ui/modalLayer.ts). Closing them all at once lost the entry under a picker.
  })

  return (
    <div className="min-h-dvh bg-surface-0 text-[var(--text-primary)]">
      {/* The first stop for keyboard users: past the header and its controls, into the screen.
          Focus moves into main without changing the URL. Fixed to the screen even while hidden,
          so tabbing onto it from a scrolled page never scrolls the page to the top. */}
      <a
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main')?.focus()
        }}
        className="sr-only fixed left-[calc(env(safe-area-inset-left,0px)+12px)] top-[calc(env(safe-area-inset-top,0px)+12px)] z-[110] rounded-xl border border-white/[0.08] bg-surface-1 text-[13px] font-semibold text-white shadow-[var(--shadow-overlay)] focus:not-sr-only focus:fixed focus:px-4 focus:py-3"
      >
        Skip to content
      </a>
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: 'var(--app-sheen)' }}
      />

      <div className="relative z-10 flex min-h-dvh flex-col">
        {/* The sticky header comes first so it owns the status-bar area; the banners below
            it scroll away under it. */}
        <TopBar />

        <DataNotices />
        {isOffline && <OfflineBanner />}

        {/* Each screen names itself with its own h1 (tabIndex -1), where focus lands after a
            navigation that took the focused control away (useRouteFocus). */}
        <main
          id="main"
          tabIndex={-1}
          onFocus={revealTextField}
          className={`mx-auto w-full max-w-[1200px] flex-1 py-5 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:py-8 md:pb-10 ${SAFE_GUTTER_X}`}
        >
          {bootError !== null ? (
            <BootFailure />
          ) : !hydrated ? (
            <div
              role="status"
              aria-live="polite"
              className="flex flex-col items-center justify-center gap-3 py-32"
            >
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
              <span className="text-[12px] text-[var(--text-tertiary)]">
                Loading local spending data
              </span>
            </div>
          ) : (
            // No exit animation around routes: an animated route wrapper (framer-motion's
            // AnimatePresence, removed since) once left content stranded at opacity 0 when
            // rapid navigation overlapped its exit and enter, blanking Pulse + Insights.
            // Routes render synchronously; the `route-fade-in` CSS keyframe gives the
            // subtle fade without any React-state animation that can fail.
            <div key="route-content" className="route-fade-in">
              {/* Above the screen, never over it: the screen stays usable under the card. Mounted
                  the first time a card may be wanted, behind the slot's own error boundary (a
                  card that fails is left out); from then on the chunk decides what shows. */}
              <OverlaySlot open={cards}>
                <DataCards />
              </OverlaySlot>
              <Outlet />
            </div>
          )}
        </main>

        <TabBar />
      </div>

      {/* Outside main: the app-wide live regions toasts are spoken from. */}
      <ToastAnnouncer />

      <OverlaySlot open={paletteOpen} idle={idle} setOpen={setPaletteOpen}>
        <CommandPalette />
      </OverlaySlot>

      <OverlaySlot
        open={settingsOpen}
        idle={idle}
        setOpen={setSettingsOpen}
        mountClosed
        loading={
          <div role="status" className="sr-only">
            Loading settings
          </div>
        }
      >
        <SettingsDrawer />
      </OverlaySlot>

      <OverlaySlot open={addSheetOpen} idle={idle} setOpen={setAddSheetOpen}>
        <AddExpenseSheet open={addSheetOpen} onClose={closeAddSheet} />
      </OverlaySlot>

      <OverlaySlot open={hasToasts} idle={idle} onFail={dropToasts}>
        <ToastHost />
      </OverlaySlot>

      <OverlaySlot open={hotkeysOpen} idle={idle} setOpen={setHotkeysOpen}>
        <HotkeyHints open={hotkeysOpen} onClose={closeHotkeys} />
      </OverlaySlot>
    </div>
  )
}
