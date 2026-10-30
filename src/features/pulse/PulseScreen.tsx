import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Wallet,
  BarChart3,
  Layers,
  Activity,
  Target,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { computeMonthAnalytics, computeYearAnalytics } from '../../lib/analytics'
import { makeKey, monthKeyOf, monthName, monthShortName, shortDate } from '../../lib/dates'
import { getLedgerIndex } from '../../lib/ledgerIndex'
import { importWithReload } from '../../lib/chunkReload'
import { whenIdle } from '../../lib/whenIdle'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { AnimatedNumber } from '../../ui/AnimatedNumber'
import { Card } from '../../ui/Card'
import { ChangePill } from '../../ui/ChangePill'
import { Segmented } from '../../ui/Segmented'
import { SectionHeader } from '../../ui/SectionHeader'
import { BudgetFinal, PaceRing } from './PaceRing'
import { TopCategories } from './TopCategories'
import { Heatmap } from './Heatmap'
import { TodayStrip } from './TodayStrip'
import { Sparkline, SparklineAxis } from './Sparkline'
import { BudgetActual } from './BudgetActual'
import { SmartInput } from '../entry/SmartInput'

type PeriodView = 'month' | 'year'

// The year's monthly bars are never on Pulse's first paint, so they load on the first switch to
// Year instead of growing the entry chunk. A stale chunk after a deploy reloads once.
const MonthlyBars = lazy(() =>
  importWithReload(() => import('./MonthlyBars')).then((m) => ({ default: m.MonthlyBars })),
)
/** The same chunk, fetched once the app is idle: the first switch to Year need not wait for it. */
const preloadMonthlyBars = () => {
  importWithReload(() => import('./MonthlyBars')).catch(() => undefined)
}

const statValue = 'mt-0.5 truncate font-mono text-[15px] tabular-nums text-white'
// 36 px arrows 8 px apart. On a touch screen of any width they stay 36 px with a 44 px hit area
// each (.tap-target), so the two hit areas meet but never overlap; a mouse gets 28 px from md.
const periodArrow =
  'tap-target inline-flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white md:[@media(pointer:fine)]:h-7 md:[@media(pointer:fine)]:w-7 md:[@media(pointer:fine)]:rounded-md'

export function PulseScreen() {
  // An add or a sync re-renders the figures in a deferred pass, so the quick-add toast and
  // the cleared input paint first; the numbers follow a frame later.
  const latestExpenses = useExpenseStore((s) => s.expenses)
  const expenses = useDeferredValue(latestExpenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const fmt = useFormatMoney()
  const today = useToday()
  const [view, setView] = useState<PeriodView>('month')
  // The switch shows the new choice at once; the screen follows in a deferred render, so the
  // first switch to Year keeps the month on screen until the bars' chunk is in (no placeholder).
  const shown = useDeferredValue(view)
  const [monthOffset, setMonthOffset] = useState(0)
  const [yearOffset, setYearOffset] = useState(0)
  useEffect(() => whenIdle(preloadMonthlyBars), [])

  const index = getLedgerIndex(expenses)
  // The arrows page the period the switch shows, also while the screen is catching up with it:
  // ← right after choosing Year goes back a year, never a month out of sight.
  const offset = view === 'month' ? monthOffset : yearOffset
  const isCurrentPeriod = offset === 0

  const monthData = useMemo(
    () => computeMonthAnalytics(index, budgets, today, monthOffset),
    [index, budgets, today, monthOffset],
  )
  // The year is only computed while it is on screen.
  const yearData = useMemo(
    () => (shown === 'year' ? computeYearAnalytics(index, today, yearOffset) : null),
    [shown, index, today, yearOffset],
  )

  const a = yearData ?? monthData
  // "Oct 2026" on phones keeps the header on one row; "October 2026" from sm.
  const shortLabel = yearData
    ? yearData.label
    : `${monthShortName(monthData.monthKey)} ${monthData.monthKey.slice(0, 4)}`
  const hasExpenses = expenses.length > 0
  const hasBudgets = monthData.categoryBudgets.length > 0
  const daily = monthData.daily
  const sparkValues = yearData ? yearData.sparkline.values : daily.map((d) => d.total)
  const sparkLabels = yearData ? yearData.sparkline.labels : daily.map((d) => shortDate(d.date))
  // The year's points are its months from January: the description names them in full.
  const sparkPeakAs = yearData
    ? {
        labels: sparkValues.map((_, i) => monthName(monthKeyOf(makeKey(yearData.year, i + 1, 1)))),
        preposition: 'in' as const,
      }
    : undefined
  // Phones get the short form, so the section title is never cut ("11 days left").
  const budgetMeta =
    monthData.daysLeft === null
      ? { short: 'Final', long: `Final · ${monthData.monthName}` }
      : monthData.daysLeft === 1
        ? { short: 'Last day', long: `Last day of ${monthData.monthName}` }
        : {
            short: `${String(monthData.daysLeft)} days left`,
            long: `${String(monthData.daysLeft)} days left in ${monthData.monthName}`,
          }

  // The trend chart's name. A past month carries its year: the arrows page across years.
  const trendLabel = yearData
    ? `Monthly spending, ${String(yearData.year)}`
    : monthData.isCurrent
      ? 'Daily spending, last 30 days'
      : `Daily spending, ${monthData.label}`

  return (
    <div className="flex flex-col gap-4">
      {/* The screen's heading: focus lands here after a navigation unmounts the focused control. */}
      <h1 tabIndex={-1} className="sr-only">
        Pulse
      </h1>

      {/* Mobile quick-add */}
      <div className="lg:hidden">
        <SmartInput />
      </div>

      {/* Hero card */}
      <div>
        <Card glow className="relative overflow-hidden md:p-7">
          <div className="relative flex flex-col items-start justify-between gap-5 md:flex-row">
            <div className="w-full min-w-0 flex-1">
              {/* One row on phones from 360 px: a short month label below sm, and the view
                  switch travels with the period arrows when the row has to wrap. The switch and
                  the arrows sit 4 px apart: the arrow's 44 px hit area reaches the switch's edge
                  without covering it. */}
              <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  <Wallet size={12} className="shrink-0" />
                  <span className="sm:hidden">{shortLabel}</span>
                  <span className="hidden sm:inline">{a.label}</span>
                </div>
                <div className="flex flex-1 items-center gap-1">
                  <Segmented<PeriodView>
                    label="Period"
                    value={view}
                    onChange={(v) => {
                      setView(v)
                    }}
                    size="sm"
                    options={[
                      { value: 'month', label: 'Month' },
                      { value: 'year', label: 'Year' },
                    ]}
                  />
                  {/* Period navigation: 36 px arrows, 44 px touch targets */}
                  <div className="ml-auto flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        view === 'month'
                          ? setMonthOffset((o) => o + 1)
                          : setYearOffset((o) => o + 1)
                      }
                      className={periodArrow}
                      aria-label={`View previous ${view}`}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        view === 'month'
                          ? setMonthOffset((o) => Math.max(0, o - 1))
                          : setYearOffset((o) => Math.max(0, o - 1))
                      }
                      disabled={isCurrentPeriod}
                      className={clsx(
                        periodArrow,
                        'disabled:cursor-not-allowed disabled:opacity-30',
                      )}
                      aria-label={`View next ${view}`}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>

              <div key={shown}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                  <AnimatedNumber
                    value={a.periodTotal}
                    format={fmt}
                    className="font-mono text-[clamp(1.75rem,9vw,2.35rem)] font-semibold tabular-nums leading-[1.02] tracking-normal text-white sm:text-[2.75rem] md:text-[3rem]"
                  />
                  {/* "▲ 41.0% vs Sep 1–18"; within ±0.5% "≈ same as Sep 1–18" */}
                  <ChangePill
                    change={a.comparison.changePct}
                    against={a.comparison.against}
                    label={a.comparison.label}
                  />
                </div>

                {!yearData && (
                  <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                    {monthData.isCurrent ? (
                      <>
                        <span>
                          Today{' '}
                          <span className="font-mono tabular-nums text-white">
                            {fmt(monthData.todayTotal)}
                          </span>
                        </span>
                        <span className="text-[var(--text-tertiary)]">/</span>
                        <span>
                          Avg{' '}
                          <span className="font-mono tabular-nums text-white">
                            {fmt(monthData.dailyAverage)}
                          </span>
                          /day
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          Daily avg{' '}
                          <span className="font-mono tabular-nums text-white">
                            {fmt(monthData.dailyAverage)}
                          </span>
                        </span>
                        <span className="text-[var(--text-tertiary)]">/</span>
                        <span>
                          <span className="text-white">{monthData.daysInPeriod}</span> days
                        </span>
                      </>
                    )}
                  </div>
                )}

                {yearData && (
                  <div className="mt-2 text-[12px] text-[var(--text-secondary)]">
                    Monthly avg{' '}
                    <span className="font-mono tabular-nums text-white">
                      {fmt(yearData.monthlyAverage)}
                    </span>
                    <span className="text-[var(--text-tertiary)]">
                      {' · '}
                      {yearData.isCurrent ? `to ${shortDate(today)}` : 'full year'}
                    </span>
                  </div>
                )}

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                      {yearData
                        ? 'By month'
                        : monthData.isCurrent
                          ? 'Last 30 days'
                          : `${monthData.monthName} by day`}
                    </span>
                  </div>
                  <Sparkline
                    data={sparkValues}
                    labels={sparkLabels}
                    label={trendLabel}
                    peakAs={sparkPeakAs}
                    height={44}
                    className="max-w-sm"
                  />
                  <SparklineAxis
                    labels={sparkLabels}
                    lastLabel={!yearData && monthData.isCurrent ? 'Today' : undefined}
                    highlightLast={a.isCurrent}
                    className="max-w-sm"
                  />
                </div>
                {!hasExpenses && (
                  <div className="mt-4 max-w-sm rounded-xl border border-accent/15 bg-accent/[0.06] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    Start with quick entry:{' '}
                    <span className="font-mono text-white">coffee 4.50 yesterday</span>
                  </div>
                )}
              </div>
            </div>

            {!yearData && (
              <div className="w-full shrink-0 md:w-auto">
                {monthData.budget && monthData.daysLeft !== null ? (
                  <PaceRing budget={monthData.budget} daysLeft={monthData.daysLeft} />
                ) : monthData.budget ? (
                  <BudgetFinal budget={monthData.budget} />
                ) : (
                  // Phones drop Avg/day: the line under the total already says it, and a
                  // four-digit S$ average would not fit a third of a 320 px card.
                  <div className="grid grid-cols-2 gap-2 rounded-xl border border-white/[0.06] bg-surface-2/55 p-3 sm:grid-cols-3 md:w-[190px] md:grid-cols-1">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        Entries
                      </div>
                      <div className={statValue}>{monthData.periodCount}</div>
                    </div>
                    <div className="hidden min-w-0 sm:block">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        Avg/day
                      </div>
                      <div className={statValue}>{fmt(monthData.dailyAverage)}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        {monthData.daysLeft === null ? 'Days' : 'Days left'}
                      </div>
                      <div className={statValue}>
                        {monthData.daysLeft ?? monthData.daysInPeriod}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Year: monthly bars. The boundary stays mounted in the month view: a deferred render
          that suspends under a boundary already on screen keeps the old screen, where one
          mounting with the bars would flash its fallback. */}
      <Suspense>
        {yearData && (
          <Card>
            <SectionHeader icon={BarChart3}>Monthly breakdown</SectionHeader>
            <MonthlyBars
              year={yearData.year}
              data={yearData.monthlyTotals}
              total={yearData.periodTotal}
              highest={yearData.highestMonth}
            />
          </Card>
        )}
      </Suspense>

      {/* Top categories + heatmap */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="min-w-0">
          <SectionHeader icon={Layers} meta={a.label}>
            Top categories
          </SectionHeader>
          <TopCategories items={a.topCategories} />
        </Card>

        <Card className="min-w-0">
          <SectionHeader icon={Activity} meta="14 weeks">
            Activity
          </SectionHeader>
          <Heatmap data={a.heatmap} today={today} />
        </Card>
      </div>

      {/* Budget vs actual — month view with budgets */}
      {!yearData && hasBudgets && (
        <Card>
          <SectionHeader
            icon={Target}
            meta={
              <>
                <span className="sm:hidden">{budgetMeta.short}</span>
                <span className="hidden sm:inline">{budgetMeta.long}</span>
              </>
            }
          >
            Budget vs actual
          </SectionHeader>
          <BudgetActual items={monthData.categoryBudgets} isFinal={!monthData.isCurrent} />
        </Card>
      )}

      {!yearData && !hasBudgets && hasExpenses && (
        <Card className="border-accent/15 bg-accent/[0.035]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Target size={15} />
              </span>
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold text-white">No monthly budgets set</h2>
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                  Add category caps to unlock pace rings, expected-spend markers, and budget alerts.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSettingsTab('budgets')
                setSettingsOpen(true)
              }}
              className="tap-target inline-flex h-10 items-center justify-center rounded-[10px] border border-accent/25 bg-accent/10 px-3 text-[12px] font-semibold text-accent transition hover:bg-accent/15"
            >
              Set budgets
            </button>
          </div>
        </Card>
      )}

      {/* Today strip — current month only */}
      {!yearData && monthData.isCurrent && (
        <TodayStrip entries={monthData.todayEntries} total={monthData.todayTotal} />
      )}
    </div>
  )
}
