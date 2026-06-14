import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Wallet,
  BarChart3,
  Layers,
  Activity,
  Target,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { format, subDays } from 'date-fns'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { useUIStore } from '../../stores/useUIStore'
import { computeMonthAnalytics, computeYearAnalytics } from '../../lib/analytics'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { AnimatedNumber } from '../../ui/AnimatedNumber'
import { Card } from '../../ui/Card'
import { Pill } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'
import { SectionHeader } from '../../ui/SectionHeader'
import { PaceRing } from './PaceRing'
import { TopCategories } from './TopCategories'
import { Heatmap } from './Heatmap'
import { TodayStrip } from './TodayStrip'
import { Sparkline } from './Sparkline'
import { BudgetActual } from './BudgetActual'
import { MonthlyBars } from './MonthlyBars'
import { SmartInput } from '../entry/SmartInput'

type PeriodView = 'month' | 'year'

export function PulseScreen() {
  const expenses = useExpenseStore((s) => s.expenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen)
  const setSettingsTab = useUIStore((s) => s.setSettingsTab)
  const fmt = useFormatMoney()
  const [view, setView] = useState<PeriodView>('month')
  const [monthOffset, setMonthOffset] = useState(0)
  const [yearOffset, setYearOffset] = useState(0)

  const offset = view === 'month' ? monthOffset : yearOffset
  const isCurrentPeriod = offset === 0

  const monthData = useMemo(
    () => computeMonthAnalytics(expenses, budgets, monthOffset),
    [expenses, budgets, monthOffset],
  )
  const yearData = useMemo(
    () => computeYearAnalytics(expenses, budgets, yearOffset),
    [expenses, budgets, yearOffset],
  )

  const a = view === 'month' ? monthData : yearData
  const trendDown = a.changePct < 0
  const hasPrev = a.prevTotal > 0
  const hasBudgets = monthData.categoryBudgets.length > 0
  const hasExpenses = expenses.length > 0

  return (
    <div className="flex flex-col gap-4">
      {/* Mobile quick-add */}
      <div className="lg:hidden">
        <SmartInput />
      </div>

      {/* Hero card */}
      <div>
        <Card glow className="relative overflow-hidden md:p-7">
          <div className="relative flex flex-col items-start justify-between gap-5 md:flex-row">
            <div className="min-w-0 flex-1">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  <Wallet size={12} />
                  {view === 'month' ? monthData.label : yearData.label}
                </div>
                <Segmented<PeriodView>
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
                {/* Period navigation */}
                <div className="ml-auto flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      view === 'month' ? setMonthOffset((o) => o + 1) : setYearOffset((o) => o + 1)
                    }
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white"
                    aria-label={`View previous ${view}`}
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      view === 'month'
                        ? setMonthOffset((o) => Math.max(0, o - 1))
                        : setYearOffset((o) => Math.max(0, o - 1))
                    }
                    disabled={isCurrentPeriod}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-tertiary)] transition hover:bg-surface-2 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                    aria-label={`View next ${view}`}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <div key={view}>
                <div className="flex flex-wrap items-baseline gap-3">
                  <AnimatedNumber
                    value={a.periodTotal}
                    prefix="$"
                    format={(n) =>
                      n.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    }
                    className="font-mono text-[2.35rem] font-semibold tabular-nums leading-[1.02] tracking-normal text-white sm:text-[2.75rem] md:text-[3rem]"
                  />
                  {hasPrev && (
                    <Pill tone={trendDown ? 'positive' : 'negative'}>
                      {trendDown ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                      {Math.abs(a.changePct * 100).toFixed(1)}% vs{' '}
                      {view === 'month' ? 'last month' : 'last year'}
                    </Pill>
                  )}
                </div>

                {view === 'month' && (
                  <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                    {monthOffset === 0 ? (
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
                            {fmt(monthData.periodTotal / Math.max(1, monthData.daysElapsed))}
                          </span>
                          /day
                        </span>
                      </>
                    ) : (
                      <>
                        <span>
                          Daily avg{' '}
                          <span className="font-mono tabular-nums text-white">
                            {fmt(monthData.periodTotal / Math.max(1, monthData.daysElapsed))}
                          </span>
                        </span>
                        <span className="text-[var(--text-tertiary)]">/</span>
                        <span>
                          <span className="text-white">{monthData.daysElapsed}</span> days
                        </span>
                      </>
                    )}
                  </div>
                )}

                {view === 'year' && (
                  <div className="mt-2 flex items-center gap-3 text-[12px] text-[var(--text-secondary)]">
                    <span>
                      Monthly avg{' '}
                      <span className="font-mono tabular-nums text-white">
                        {fmt(
                          yearData.periodTotal /
                            Math.max(1, yearOffset === 0 ? new Date().getMonth() + 1 : 12),
                        )}
                      </span>
                    </span>
                    <span className="text-[var(--text-tertiary)]">/</span>
                    <span>
                      {yearOffset === 0 ? (
                        <>
                          <span className="text-white">{new Date().getMonth() + 1}</span> of 12
                          months
                        </>
                      ) : (
                        'Full year'
                      )}
                    </span>
                  </div>
                )}

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                      {view === 'month' ? 'Last 30 days' : 'Monthly / 12 months'}
                    </span>
                  </div>
                  <Sparkline
                    data={
                      view === 'month' ? a.daily.map((d) => d.total) : yearData.monthlySparkline
                    }
                    labels={
                      view === 'month'
                        ? a.daily.map((d) => format(new Date(d.date + 'T12:00:00'), 'MMM d'))
                        : [
                            'Jan',
                            'Feb',
                            'Mar',
                            'Apr',
                            'May',
                            'Jun',
                            'Jul',
                            'Aug',
                            'Sep',
                            'Oct',
                            'Nov',
                            'Dec',
                          ]
                    }
                    height={44}
                    className="max-w-sm"
                  />
                  {/* Date axis labels */}
                  <div className="mt-1 flex max-w-sm justify-between">
                    {view === 'month' ? (
                      <>
                        <span className="text-[10px] text-[var(--text-tertiary)]">
                          {a.daily[0]
                            ? format(new Date(a.daily[0].date + 'T12:00:00'), 'MMM d')
                            : ''}
                        </span>
                        <span className="text-[10px] text-[var(--text-tertiary)]">
                          {a.daily[14]
                            ? format(new Date(a.daily[14].date + 'T12:00:00'), 'MMM d')
                            : ''}
                        </span>
                        <span className="text-[10px] text-accent">
                          {monthOffset === 0
                            ? 'Today'
                            : a.daily[29]
                              ? format(new Date(a.daily[29].date + 'T12:00:00'), 'MMM d')
                              : ''}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Jan</span>
                        <span className="text-[10px] text-[var(--text-tertiary)]">Jun</span>
                        <span className="text-[10px] text-accent">{format(new Date(), 'MMM')}</span>
                      </>
                    )}
                  </div>
                </div>
                {!hasExpenses && (
                  <div className="mt-4 max-w-sm rounded-xl border border-accent/15 bg-accent/[0.06] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    Start with quick entry:{' '}
                    <span className="font-mono text-white">coffee 4.50 yesterday</span>
                  </div>
                )}
              </div>
            </div>

            {view === 'month' && (
              <div className="w-full shrink-0 md:w-auto">
                {monthData.totalBudget > 0 ? (
                  <PaceRing ratio={monthData.paceRatio} daysLeft={monthData.daysLeft} />
                ) : (
                  <div className="grid grid-cols-3 gap-2 rounded-xl border border-white/[0.06] bg-surface-2/55 p-3 md:w-[190px] md:grid-cols-1">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        Entries
                      </div>
                      <div className="mt-0.5 font-mono text-[15px] tabular-nums text-white">
                        {monthData.periodCount}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        Avg/day
                      </div>
                      <div className="mt-0.5 font-mono text-[15px] tabular-nums text-white">
                        {fmt(monthData.periodTotal / Math.max(1, monthData.daysElapsed))}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                        Days left
                      </div>
                      <div className="mt-0.5 font-mono text-[15px] tabular-nums text-white">
                        {monthData.daysLeft}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Year: monthly bars */}
      {view === 'year' && (
        <Card>
          <SectionHeader icon={BarChart3}>Monthly breakdown</SectionHeader>
          <MonthlyBars data={yearData.monthlyTotals} />
        </Card>
      )}

      {/* Top categories + heatmap */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <SectionHeader icon={Layers} meta={a.label}>
            Top categories
          </SectionHeader>
          <TopCategories items={a.topCategories} />
        </Card>

        <Card>
          <SectionHeader icon={Activity} meta="14 weeks">
            Activity
          </SectionHeader>
          <Heatmap data={monthData.heatmap} />
        </Card>
      </div>

      {/* Budget vs actual — only when month view and budgets exist */}
      {view === 'month' && hasBudgets && (
        <Card>
          <SectionHeader
            icon={Target}
            meta={`${monthData.daysLeft}d left in ${monthData.label.split(' ')[0]}`}
          >
            Budget vs actual
          </SectionHeader>
          <BudgetActual items={monthData.categoryBudgets} daysLeft={monthData.daysLeft} />
        </Card>
      )}

      {view === 'month' && !hasBudgets && hasExpenses && (
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
              className="inline-flex h-10 items-center justify-center rounded-[10px] border border-accent/25 bg-accent/10 px-3 text-[12px] font-semibold text-accent transition hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              Set budgets
            </button>
          </div>
        </Card>
      )}

      {/* Today strip — only in month view */}
      {view === 'month' && (
        <TodayStrip entries={monthData.todayEntries} total={monthData.todayTotal} />
      )}
    </div>
  )
}
