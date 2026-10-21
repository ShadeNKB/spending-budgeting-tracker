import { lazy, useCallback, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { WifiOff, FlaskConical } from 'lucide-react'
import { TopBar } from './TopBar'
import { TabBar } from './TabBar'
import { OverlaySlot } from './OverlaySlot'
import { dropToasts } from './dropToasts'
import { useAppliedTheme } from './useAppliedTheme'
import { useLaunchActions } from './useLaunchActions'
import { SAFE_GUTTER_X } from './safeArea'
import { useExpenseStore, installPersistence, IS_DEMO } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'
import { syncApplying } from '../services/syncService'
import { useUIStore } from '../stores/useUIStore'
import { useHotkeys } from '../hooks/useHotkeys'
import { useToast } from '../hooks/useToast'
import { useIdle } from '../hooks/useIdle'
import { importWithReload } from '../lib/chunkReload'

// Overlays hidden on first paint. lazy() alone does not keep them (or framer-motion, which
// they all use) off the critical path: a lazy component that is rendered at boot is fetched
// at boot. So each overlay mounts through an OverlaySlot, on its first open or once the app
// goes idle after load, whichever comes first. A stale chunk reloads once.
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

// Bootstrap runs once per page load — wired in a top-level useEffect rather than
// at module scope so React is fully mounted before we touch localStorage.
let bootstrapped = false
function bootstrap() {
  if (bootstrapped || typeof window === 'undefined') return
  bootstrapped = true

  useExpenseStore.getState().hydrate()
  installPersistence()

  // Wire data changes → debounced cloud push (skipped while applying remote data).
  useExpenseStore.subscribe(
    (s) => ({
      expenses: s.expenses,
      categories: s.categories,
      categoryMappings: s.categoryMappings,
      budgets: s.budgets,
      deletedIds: s.deletedIds,
    }),
    () => {
      if (!useExpenseStore.getState().hydrated) return
      if (syncApplying.value) return
      useSyncStore.getState().scheduleSyncPush()
    },
    {
      equalityFn: (a, b) =>
        a.expenses === b.expenses &&
        a.categories === b.categories &&
        a.categoryMappings === b.categoryMappings &&
        a.budgets === b.budgets &&
        a.deletedIds === b.deletedIds,
    },
  )

  useSyncStore.getState().initSync()
}

export function AppShell() {
  const hydrated = useExpenseStore((s) => s.hydrated)
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

  const idle = useIdle()
  // Stable close handlers: Sheet re-runs its focus effect when onClose changes identity, which
  // pulled focus out of a field whenever the shell re-rendered with a sheet open.
  const closeAddSheet = useCallback(() => setAddSheetOpen(false), [setAddSheetOpen])
  const closeHotkeys = useCallback(() => setHotkeysOpen(false), [setHotkeysOpen])

  useEffect(bootstrap, [])

  useAppliedTheme(theme)
  useLaunchActions()

  // Surface storage quota errors to the user — without this the app would
  // silently fail to persist, which is the worst possible UX for a finance
  // tracker. Listener fires once per session per quota incident.
  useEffect(() => {
    const onQuota = () => {
      toast.error('Storage is full — export a backup and clear old data to keep saving.', {
        duration: 12000,
      })
    }
    window.addEventListener('spendtrack:quota-exceeded', onQuota)
    return () => window.removeEventListener('spendtrack:quota-exceeded', onQuota)
  }, [toast])

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    'mod+n': () => setAddSheetOpen(true),
    'mod+,': () => setSettingsOpen(true),
    '?': () => setHotkeysOpen(true),
    // Read the undo stack on demand: subscribing to it re-rendered the whole shell on every add.
    'mod+z': () => {
      const { undoStack, consumeUndo } = useExpenseStore.getState()
      const last = undoStack.at(-1)
      if (last) consumeUndo(last.id)
    },
    escape: () => {
      setPaletteOpen(false)
      setSettingsOpen(false)
      setAddSheetOpen(false)
      setHotkeysOpen(false)
    },
  })

  return (
    <div className="min-h-dvh bg-surface-0 text-[var(--text-primary)]">
      <div
        className="pointer-events-none fixed inset-0"
        style={{ background: 'var(--app-sheen)' }}
      />

      <div className="relative z-10 flex min-h-dvh flex-col">
        {/* The sticky header comes first so it owns the status-bar area; the banners below
            it scroll away under it. */}
        <TopBar />

        {IS_DEMO && (
          <div className="flex items-center justify-center gap-2 border-b border-accent/20 bg-accent/10 px-4 py-1.5 text-[12px] text-accent">
            <FlaskConical size={12} />
            <span>
              Demo mode — sample data loaded.{' '}
              <span className="text-accent/70">Data is stored locally on this device only.</span>{' '}
              Clear it in Settings → Backup and use for your own expenses.
            </span>
          </div>
        )}
        {isOffline && (
          <div className="offline-banner-in">
            <div className="flex items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-[12px] text-warning">
              <WifiOff size={12} />
              You're offline — changes will sync when connection is restored
            </div>
          </div>
        )}

        <main
          className={`mx-auto w-full max-w-[1200px] flex-1 py-5 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:py-8 md:pb-10 ${SAFE_GUTTER_X}`}
        >
          <h1 className="sr-only">SpendTrack — spending tracker</h1>
          {!hydrated ? (
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
            // No AnimatePresence around routes — rapid navigation could leave
            // motion.divs stranded with `initial: opacity 0` when framer-motion's
            // exit/enter lifecycle overlapped, blanking Pulse + Insights.
            // Routes now render synchronously; subtle CSS fade-in is applied
            // via the `route-fade-in` keyframe so transitions still feel polished
            // without any React-state animation that can fail.
            <div key="route-content" className="route-fade-in">
              <Outlet />
            </div>
          )}
        </main>

        <TabBar />
      </div>

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
