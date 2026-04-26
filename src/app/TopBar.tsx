import { NavLink } from "react-router-dom";
import { Command, Settings2 } from "lucide-react";
import clsx from "clsx";
import { SmartInput } from "../features/entry/SmartInput";
import { SyncPill } from "./SyncPill";
import { useUIStore } from "../stores/useUIStore";
import { SpendLogo } from "../ui/SpendLogo";

const links = [
  { to: "/pulse", label: "Pulse" },
  { to: "/ledger", label: "Ledger" },
  { to: "/insights", label: "Insights" },
];

export function TopBar() {
  const setPaletteOpen = useUIStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-surface-0/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1200px] items-center gap-3 px-4 py-3 md:px-8">
        <NavLink to="/pulse" className="flex items-center gap-2 shrink-0">
          <SpendLogo size={28} animated />
          <span className="text-[15px] font-semibold tracking-tight text-white hidden sm:inline">SpendTrack</span>
        </NavLink>

        <nav className="hidden md:flex items-center gap-0.5 rounded-full border border-white/[0.06] bg-surface-1 p-1 ml-2">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) =>
                clsx(
                  "inline-flex h-8 items-center rounded-full px-3.5 text-[13px] font-medium transition",
                  isActive ? "bg-white text-surface-0" : "text-[var(--text-secondary)] hover:text-white"
                )
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1 min-w-0 hidden md:block">
          <SmartInput dense className="max-w-[520px] mx-auto" />
        </div>

        <div className="hidden lg:block">
          <SyncPill />
        </div>

        <button
          onClick={() => setPaletteOpen(true)}
          className="inline-flex h-9 items-center gap-2 rounded-full border border-white/[0.06] bg-surface-1 px-3 text-[12px] text-[var(--text-secondary)] hover:bg-surface-2 hover:text-white transition"
          aria-label="Open command palette"
        >
          <Command size={13} />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline rounded bg-surface-2 border border-white/[0.06] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">⌘K</kbd>
        </button>

        <button
          onClick={() => setSettingsOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-surface-2 hover:text-white transition"
          aria-label="Settings"
        >
          <Settings2 size={16} />
        </button>
      </div>
    </header>
  );
}
