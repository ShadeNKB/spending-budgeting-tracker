import { Suspense, lazy, useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { WifiOff, FlaskConical } from 'lucide-react'
import { TopBar } from './TopBar'
import { TabBar } from './TabBar'
import { useExpenseStore, installPersistence, IS_DEMO } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'
import { syncApplying } from '../services/syncService'
import { useUIStore } from '../stores/useUIStore'
import { useHotkeys } from '../hooks/useHotkeys'
import { useToast } from '../hooks/useToast'

// Lazy-load heavy components that are hidden on first paint — keeps framer-motion
// out of the critical bundle path and shaves the initial JS parse budget.
const SettingsDrawer = lazy(() =>
  import('../features/settings/SettingsDrawer').then((m) => ({ default: m.SettingsDrawer })),
)
const CommandPalette = lazy(() =>
  import('../features/entry/CommandPalette').then((m) => ({ default: m.CommandPalette })),
)
const AddExpenseSheet = lazy(() =>
  import('../features/entry/AddExpenseSheet').then((m) => ({ default: m.AddExpenseSheet })),
)
const ToastHost = lazy(() => import('../ui/ToastHost').then((m) => ({ default: m.ToastHost })))
const HotkeyHints = lazy(() =>
  import('../ui/HotkeyHints').then((m) => ({ default: m.HotkeyHints })),
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
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setHotkeysOpen = useUIStore((s) => s.setHotkeysOpen)
  const hotkeysOpen = useUIStore((s) => s.hotkeysOpen)
  const addSheetOpen = useUIStore((s) => s.addSheetOpen)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const undoStack = useExpenseStore((s) => s.undoStack)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(bootstrap, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const apply = () => {
        root.dataset.theme = mq.matches ? 'dark' : 'light'
      }
      apply()
      mq.addEventListener('change', apply)
      return () => mq.removeEventListener('change', apply)
    }
    root.dataset.theme = theme
  }, [theme])

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

  // Show a reload prompt when the service worker updates (new version deployed).
  // Uses a ref so the effect doesn't re-register on every toast reference change.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    let prevController = navigator.serviceWorker.controller
    const onController = () => {
      if (prevController) {
        toastRef.current.info('App updated — reload for the latest version.', {
          duration: 0,
          action: { label: 'Reload', onClick: () => window.location.reload() },
        })
      }
      prevController = navigator.serviceWorker.controller
    }
    navigator.serviceWorker.addEventListener('controllerchange', onController)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onController)
  }, [])

  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    'mod+n': () => setAddSheetOpen(true),
    'mod+,': () => setSettingsOpen(true),
    '?': () => setHotkeysOpen(true),
    'mod+z': () => {
      const last = undoStack[undoStack.length - 1]
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
          <div className="offline-banner-in relative z-50">
            <div className="flex items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-[12px] text-warning">
              <WifiOff size={12} />
              You're offline — changes will sync when connection is restored
            </div>
          </div>
        )}
        <TopBar />

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:px-8 md:py-8 md:pb-10">
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

      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>

      <Suspense
        fallback={
          <div role="status" className="sr-only">
            Loading settings
          </div>
        }
      >
        <SettingsDrawer />
      </Suspense>

      <Suspense fallback={null}>
        <AddExpenseSheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} />
      </Suspense>

      <Suspense fallback={null}>
        <ToastHost />
      </Suspense>

      <Suspense fallback={null}>
        <HotkeyHints open={hotkeysOpen} onClose={() => setHotkeysOpen(false)} />
      </Suspense>
    </div>
  )
}
