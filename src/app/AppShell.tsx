import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { WifiOff, FlaskConical } from "lucide-react";
import { TopBar } from "./TopBar";
import { TabBar } from "./TabBar";
import { ToastHost } from "../ui/ToastHost";
import { CommandPalette } from "../features/entry/CommandPalette";
import { SettingsDrawer } from "../features/settings/SettingsDrawer";
import { AddExpenseSheet } from "../features/entry/AddExpenseSheet";
import { useExpenseStore, installPersistence, IS_DEMO } from "../stores/useExpenseStore";
import { useUIStore } from "../stores/useUIStore";
import { useHotkeys } from "../hooks/useHotkeys";

let storeBootstrapped = false;

function bootstrapClientStore() {
  if (storeBootstrapped || typeof window === "undefined") return;
  storeBootstrapped = true;
  useExpenseStore.getState().hydrate();
  installPersistence();
}

bootstrapClientStore();

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
            Demo mode — data is yours alone, stored locally on this device
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
                You're offline - changes will sync when connection is restored
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <TopBar />

        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-5 md:px-8 md:py-8 pb-[calc(env(safe-area-inset-bottom,0px)+96px)] md:pb-10">
          <AnimatePresence mode="wait" initial={false}>
            {hydrated && (
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
              >
                <Outlet />
              </motion.div>
            )}
            {!hydrated && (
              <motion.div
                key="loading"
                exit={{ opacity: 0 }}
                className="flex items-center justify-center py-32"
              >
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-accent/20 border-t-accent" />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <TabBar />
      </div>

      <CommandPalette />
      <SettingsDrawer />
      <AddExpenseSheet open={addSheetOpen} onClose={() => setAddSheetOpen(false)} />
      <ToastHost />
    </div>
  );
}
