import { Suspense, lazy, useEffect } from 'react'
import { Outlet } from 'react-router-dom'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import { WifiOff, FlaskConical } from 'lucide-react'
import { TopBar } from './TopBar'
import { TabBar } from './TabBar'
import { ToastHost } from '../ui/ToastHost'
import { CommandPalette } from '../features/entry/CommandPalette'
import { AddExpenseSheet } from '../features/entry/AddExpenseSheet'
import { useExpenseStore, installPersistence, IS_DEMO } from '../stores/useExpenseStore'
import { useSyncStore } from '../stores/useSyncStore'
import { syncApplying } from '../services/syncService'
import { useUIStore } from '../stores/useUIStore'
import { useHotkeys } from '../hooks/useHotkeys'
import { useToast } from '../hooks/useToast'

// Lazy-load the Settings drawer — it's hidden by default and contains 4 panels
// (Categories, Budgets, Backup, Sync), so shaving it from the initial bundle is a real win.
const SettingsDrawer = lazy(() =>
  import('../features/settings/SettingsDrawer').then((m) => ({ default: m.SettingsDrawer })),
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
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const addSheetOpen = useUIStore((s) => s.addSheetOpen)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const undoStack = useExpenseStore((s) => s.undoStack)
  const consumeUndo = useExpenseStore((s) => s.consumeUndo)
  const toast = useToast()

  useEffect(bootstrap, [])

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
    'mod+z': () => {
      const last = undoStack[undoStack.length - 1]
      if (last) consumeUndo(last.id)
    },
    escape: () => {
      setPaletteOpen(false)
      setSettingsOpen(false)
      setAddSheetOpen(false)
    },
  })

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-dvh bg-surface-0 text-white">
        <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.035),transparent_280px)]" />

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
          <AnimatePresence>
            {isOffline && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="relative z-50 overflow-hidden"
              >
                <div className="flex items-center justify-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-1.5 text-[12px] text-warning">
                  <WifiOff size={12} />
                  You're offline — changes will sync when connection is restored
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <TopBar />

          <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:px-8 md:py-8 md:pb-10">
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

        <CommandPalette />

        <Suspense
          fallback={
            <div role="status" className="sr-only">
              Loading settings
            </div>
          }
        >
          <SettingsDrawer />
        </Suspense>
        <AddExpenseSheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} />

        <ToastHost />
      </div>
    </MotionConfig>
  )
}
