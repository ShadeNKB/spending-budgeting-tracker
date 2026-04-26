import { create } from "zustand";

export interface Toast {
  id: string;
  kind: "success" | "error" | "info" | "warning";
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface UIState {
  toasts: Toast[];
  paletteOpen: boolean;
  settingsOpen: boolean;
  addSheetOpen: boolean;
  smartInputFocused: boolean;

  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;

  setPaletteOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setAddSheetOpen: (v: boolean) => void;
  setSmartInputFocused: (v: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  toasts: [],
  paletteOpen: false,
  settingsOpen: false,
  addSheetOpen: false,
  smartInputFocused: false,

  pushToast: (t) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  setPaletteOpen: (v) => set({ paletteOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setAddSheetOpen: (v) => set({ addSheetOpen: v }),
  setSmartInputFocused: (v) => set({ smartInputFocused: v }),
}));
