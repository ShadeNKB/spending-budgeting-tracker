import { Suspense, lazy, useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { WifiOff, FlaskConical } from "lucide-react";
import { TopBar } from "./TopBar";
import { TabBar } from "./TabBar";
import { ToastHost } from "../ui/ToastHost";
import { CommandPalette } from "../features/entry/CommandPalette";
import { AddExpenseSheet } from "../features/entry/AddExpenseSheet";
import { useExpenseStore, installPersistence, IS_DEMO } from "../stores/useExpenseStore";
import { useSyncStore } from "../stores/useSyncStore";
import { syncApplying } from "../services/syncService";
import { useUIStore } from "../stores/useUIStore";
import { useHotkeys } from "../hooks/useHotkeys";

// Lazy-load the Settings drawer — it's hidden by default and contains 4 panels
// (Categories, Budgets, Backup, Sync) plus the Supabase-aware SyncPanel, so
// shaving it from the initial bundle is a real win.
const SettingsDrawer = lazy(() =>
  import("../features/settings/SettingsDrawer").then((m) => ({ default: m.SettingsDrawer }))
);

// Bootstrap runs once per page load — wired in a top-level useEffect rather than
// at module scope so React is fully mounted before we touch localStorage.
let bootstrapped = false;
function bootstrap() {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;

  useExpenseStore.getState().hydrate();
  installPersistence();

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
      if (!useExpenseStore.getState().hydrated) return;
      if (syncApplying.value) return;
      useSyncStore.getState().scheduleSyncPush();
    },
    {
      equalityFn: (a, b) =>
        a.expenses === b.expenses &&
        a.categories === b.categories &&
        a.categoryMappings === b.categoryMappings &&
        a.budgets === b.budgets &&
        a.deletedIds === b.deletedIds,
    }
  );

  // Init sync from stored sync code (after hydrate so local data is ready).
  useSyncStore.getState().initSync();
}

export function AppShell() {
  const hydrated = useExpenseStore((s) => s.hydrated);
  const isOffline = useExpenseStore((s) => s.isOffline);
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const addSheetOpen = useUIStore((s) => s.addSheetOpen);
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen);
  const undoStack = useExpenseStore((s) => s.undoStack);
  const consumeUndo = useExpenseStore((s) => s.consumeUndo);
  const location = useLocation();

  useEffect(bootstrap, []);

  useHotkeys({
    "mod+k": () => setPaletteOpen(true),
    "mod+n": () => setAddSheetOpen(true),
    "mod+,": () => setSettingsOpen(true),
    "mod+z": () => {
      const last = undoStack[undoStack.length - 1];
      if (last) consumeUndo(last.id);
    },
    escape: () => {
      setPaletteOpen(false);
      setSettingsOpen(false);
      setAddSheetOpen(false);
    },
  });

  return (
    <div className="min-h-dvh bg-surface-0 text-white">
      {/* Ambient gradients */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div
          className="absolute -top-40 left-[8%] h-[720px] w-[720px] rounded-full opacity-[0.07]"
          style={{ background: "radial-gradient(circle, #22d3ee, transparent 62%)" }}
        />
        <div
          className="absolute -bottom-32 right-[4%] h-[560px] w-[560px] rounded-full opacity-[0.05]"
          style={{ background: "radial-gradient(circle, #818cf8, transparent 62%)" }}
        />
      </div>

      <div className="relative z-10 flex min-h-dvh flex-col">
        {IS_DEMO && (
          <div className="flex items-center justify-center gap-2 bg-accent/10 border-b border-accent/20 px-4 py-1.5 text-[12px] text-accent">
            <FlaskConical size={12} />
            <span>
              Demo mode — sample data loaded.{" "}
              <span className="text-accent/70">Data is stored locally on this device only.</span>{" "}
              Clear it in Settings → Backup and use for your own expenses.
            </span>
          </div>
        )}
        <AnimatePresence>
          {isOffline && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="relative z-50 overflow-hidden"
            >
              <div className="flex items-center justify-center gap-2 bg-warning/10 border-b border-warning/20 px-4 py-1.5 text-[12px] text-warning">
                <WifiOff size={12} />
                You're offline — changes will sync when connection is restored
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <TopBar />

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 md:px-8 md:py-8 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:pb-10">
          {!hydrated ? (
            <div className="flex items-center justify-center py-32">
              <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
            </div>
          ) : (
            // One AnimatePresence with a single keyed child = no nested-mode-wait edge cases.
            // Routes cross-fade instead of mode="wait" exit-then-enter, which previously
            // could leave Pulse in a half-mounted state after a route round-trip.
            <AnimatePresence initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          )}
        </main>

        <TabBar />
      </div>

      <CommandPalette />

      <Suspense fallback={null}>
        <SettingsDrawer />
      </Suspense>
      <AddExpenseSheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} />

      <ToastHost />
    </div>
  );
}
