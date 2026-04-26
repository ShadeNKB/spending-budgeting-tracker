import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Wallet, BarChart3, CalendarRange, Target, ChevronLeft, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { format, subDays } from "date-fns";
import { useExpenseStore } from "../../stores/useExpenseStore";
import { computeMonthAnalytics, computeYearAnalytics } from "../../lib/analytics";
import { formatMoney } from "../../lib/format";
import { AnimatedNumber } from "../../ui/AnimatedNumber";
import { Card } from "../../ui/Card";
import { Pill } from "../../ui/Pill";
import { Segmented } from "../../ui/Segmented";
import { PaceRing } from "./PaceRing";
import { TopCategories } from "./TopCategories";
import { Heatmap } from "./Heatmap";
import { TodayStrip } from "./TodayStrip";
import { Sparkline } from "./Sparkline";
import { BudgetActual } from "./BudgetActual";
import { MonthlyBars } from "./MonthlyBars";
import { SmartInput } from "../entry/SmartInput";

type PeriodView = "month" | "year";

export function PulseScreen() {
  const expenses = useExpenseStore((s) => s.expenses);
  const budgets = useExpenseStore((s) => s.budgets);
  const [view, setView] = useState<PeriodView>("month");
  const [monthOffset, setMonthOffset] = useState(0);
  const [yearOffset, setYearOffset] = useState(0);

  const offset = view === "month" ? monthOffset : yearOffset;
  const isCurrentPeriod = offset === 0;

  const monthData = useMemo(
    () => computeMonthAnalytics(expenses, budgets, monthOffset),
    [expenses, budgets, monthOffset]
  );
  const yearData = useMemo(
    () => computeYearAnalytics(expenses, budgets, yearOffset),
    [expenses, budgets, yearOffset]
  );

  const a = view === "month" ? monthData : yearData;
  const trendDown = a.changePct < 0;
  const hasPrev = a.prevTotal > 0;
  const hasBudgets = monthData.categoryBudgets.length > 0;

  const container = { initial: {}, animate: { transition: { staggerChildren: 0.05 } } };
  const item = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } };

  return (
    <motion.div variants={container} initial="initial" animate="animate" className="flex flex-col gap-4">
      {/* Mobile quick-add */}
      <motion.div variants={item} className="md:hidden">
        <SmartInput />
      </motion.div>

      {/* Hero card */}
      <motion.div variants={item}>
        <Card glow className="relative overflow-hidden md:p-7">
          <div className="absolute -top-24 -right-16 h-72 w-72 rounded-full bg-accent/[0.07] blur-3xl pointer-events-none" />
          <div className="relative flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  <Wallet size={12} />
                  {view === "month" ? monthData.label : yearData.label}
                </div>
                <Segmented<PeriodView>
                  value={view}
                  onChange={(v) => { setView(v); }}
                  size="sm"
                  options={[
                    { value: "month", label: "Month" },
                    { value: "year", label: "Year" },
                  ]}
                />
                {/* Period navigation */}
                <div className="flex items-center gap-0.5 ml-auto">
                  <button
                    onClick={() => view === "month" ? setMonthOffset((o) => o + 1) : setYearOffset((o) => o + 1)}
                    className="h-6 w-6 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-surface-2 hover:text-white transition"
                    aria-label="Previous period"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    onClick={() => view === "month" ? setMonthOffset((o) => Math.max(0, o - 1)) : setYearOffset((o) => Math.max(0, o - 1))}
                    disabled={isCurrentPeriod}
                    className="h-6 w-6 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-surface-2 hover:text-white transition disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Next period"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={view}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                >
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <AnimatedNumber
                      value={a.periodTotal}
                      prefix="$"
                      format={(n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      className="font-mono tabular-nums tracking-[-0.035em] text-white font-semibold text-[clamp(2.2rem,6vw,3.2rem)] leading-[1.02]"
                    />
                    {hasPrev && (
                      <Pill tone={trendDown ? "positive" : "negative"}>
                        {trendDown ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                        {Math.abs(a.changePct * 100).toFixed(1)}% vs {view === "month" ? "last month" : "last year"}
                      </Pill>
                    )}
                  </div>

                  {view === "month" && (
                    <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                      {monthOffset === 0 ? (
                        <>
                          <span>Today <span className="text-white font-mono tabular-nums">{formatMoney(monthData.todayTotal)}</span></span>
                          <span className="text-[var(--text-tertiary)]">·</span>
                          <span>Avg <span className="text-white font-mono tabular-nums">
                            {formatMoney(monthData.periodTotal / Math.max(1, monthData.daysElapsed))}
                          </span>/day</span>
                        </>
                      ) : (
                        <>
                          <span>Daily avg <span className="text-white font-mono tabular-nums">
                            {formatMoney(monthData.periodTotal / Math.max(1, monthData.daysElapsed))}
                          </span></span>
                          <span className="text-[var(--text-tertiary)]">·</span>
                          <span><span className="text-white">{monthData.daysElapsed}</span> days</span>
                        </>
                      )}
                    </div>
                  )}

                  {view === "year" && (
                    <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                      <span>Monthly avg <span className="text-white font-mono tabular-nums">
                        {formatMoney(yearData.periodTotal / Math.max(1, yearOffset === 0 ? new Date().getMonth() + 1 : 12))}
                      </span></span>
                      <span className="text-[var(--text-tertiary)]">·</span>
                      <span>
                        {yearOffset === 0
                          ? <><span className="text-white">{new Date().getMonth() + 1}</span> of 12 months</>
                          : "Full year"
                        }
                      </span>
                    </div>
                  )}

                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-[0.07em] text-[var(--text-tertiary)]">
                        {view === "month" ? "Daily · 30 days" : "Monthly · 12 months"}
                      </span>
                    </div>
                    <Sparkline
                      data={view === "month" ? a.daily.map((d) => d.total) : yearData.monthlySparkline}
                      labels={view === "month"
                        ? a.daily.map((d) => format(new Date(d.date + "T12:00:00"), "MMM d"))
                        : ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
                      }
                      height={44}
                      className="max-w-sm"
                    />
                    {/* Date axis labels */}
                    <div className="flex justify-between mt-1 max-w-sm">
                      {view === "month" ? (
                        <>
                          <span className="text-[10px] text-[var(--text-tertiary)]">
                            {a.daily[0] ? format(new Date(a.daily[0].date + "T12:00:00"), "MMM d") : ""}
                          </span>
                          <span className="text-[10px] text-[var(--text-tertiary)]">
                            {a.daily[14] ? format(new Date(a.daily[14].date + "T12:00:00"), "MMM d") : ""}
                          </span>
                          <span className="text-[10px] text-accent">
                            {monthOffset === 0 ? "Today" : a.daily[29] ? format(new Date(a.daily[29].date + "T12:00:00"), "MMM d") : ""}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-[10px] text-[var(--text-tertiary)]">Jan</span>
                          <span className="text-[10px] text-[var(--text-tertiary)]">Jun</span>
                          <span className="text-[10px] text-accent">{format(new Date(), "MMM")}</span>
                        </>
                      )}
                    </div>
                  </div>
                </motion.div>
              </AnimatePresence>
            </div>

            {view === "month" && monthData.totalBudget > 0 && (
              <div className="shrink-0">
                <PaceRing ratio={monthData.paceRatio} daysLeft={monthData.daysLeft} />
              </div>
            )}
          </div>
        </Card>
      </motion.div>

      {/* Year: monthly bars */}
      <AnimatePresence>
        {view === "year" && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <BarChart3 size={13} className="text-accent/70" />
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  Monthly breakdown
                </h2>
              </div>
              <MonthlyBars data={yearData.monthlyTotals} />
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top categories + heatmap */}
      <div className="grid gap-4 md:grid-cols-2">
        <motion.div variants={item}>
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">Top categories</h2>
              <span className="text-[11px] text-[var(--text-tertiary)]">{a.label}</span>
            </div>
            <TopCategories items={a.topCategories} />
          </Card>
        </motion.div>

        <motion.div variants={item}>
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">Activity</h2>
              <span className="text-[11px] text-[var(--text-tertiary)] inline-flex items-center gap-1">
                <CalendarRange size={10} /> 14 weeks
              </span>
            </div>
            <Heatmap data={monthData.heatmap} />
          </Card>
        </motion.div>
      </div>

      {/* Budget vs actual — only when month view and budgets exist */}
      <AnimatePresence>
        {view === "month" && hasBudgets && (
          <motion.div
            variants={item}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
          >
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <Target size={13} className="text-accent/70" />
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  Budget vs actual
                </h2>
                <span className="ml-auto text-[11px] text-[var(--text-tertiary)]">
                  {monthData.daysLeft}d left in {monthData.label.split(" ")[0]}
                </span>
              </div>
              <BudgetActual items={monthData.categoryBudgets} daysLeft={monthData.daysLeft} />
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Today strip — only in month view */}
      <AnimatePresence>
        {view === "month" && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            <TodayStrip entries={monthData.todayEntries} total={monthData.todayTotal} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
