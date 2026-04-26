import { NavLink } from "react-router-dom";
import { Activity, ListOrdered, Sparkles, Plus, LineChart } from "lucide-react";
import clsx from "clsx";
import { useUIStore } from "../stores/useUIStore";

export function TabBar() {
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen);

  const tab = (to: string, Icon: typeof Activity, label: string) => (
    <NavLink
      to={to}
      key={to}
      className={({ isActive }) =>
        clsx(
          "flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition",
          isActive ? "text-white" : "text-[var(--text-tertiary)]"
        )
      }
    >
      {({ isActive }) => (
        <>
          <div className={clsx("rounded-full px-3 py-1 transition", isActive && "bg-accent/10")}>
            <Icon size={18} className={isActive ? "text-accent" : ""} />
          </div>
          <span className="text-[10px] font-medium">{label}</span>
        </>
      )}
    </NavLink>
  );

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-white/[0.06] bg-surface-0/90 backdrop-blur-xl pb-[env(safe-area-inset-bottom)]"
    >
      <div className="relative flex items-end px-2 pt-1">
        {tab("/pulse", Activity, "Pulse")}
        {tab("/ledger", ListOrdered, "Ledger")}

        <button
          onClick={() => setAddSheetOpen(true)}
          className="mx-2 -mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-surface-0 shadow-[0_10px_30px_-6px_rgba(34,211,238,0.6)] active:scale-95 transition"
          aria-label="Add expense"
        >
          <Plus size={22} strokeWidth={2.5} />
        </button>

        {tab("/insights", LineChart, "Insights")}
        <button
          onClick={() => useUIStore.getState().setSettingsOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[var(--text-tertiary)] transition hover:text-white"
        >
          <div className="rounded-full px-3 py-1">
            <Sparkles size={18} />
          </div>
          <span className="text-[10px] font-medium">More</span>
        </button>
      </div>
    </nav>
  );
}
