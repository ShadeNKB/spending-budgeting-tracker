import { useMemo, useState } from 'react'
import { format, addDays, subDays } from 'date-fns'
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Info,
  Repeat,
  Calendar,
  ArrowUp,
  ArrowDown,
} from 'lucide-react'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { computeInsights } from '../../utils/insights'
import { detectRecurring, forecastDailyFromRecurring } from '../../utils/recurring'
import { computeMonthAnalytics, computeWeekAnalytics } from '../../lib/analytics'
import { Card } from '../../ui/Card'
import { Pill } from '../../ui/Pill'
import { EmptyState } from '../../ui/EmptyState'
import { Sparkline } from '../pulse/Sparkline'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { colorFromString } from '../../lib/analytics'
import { useUIStore } from '../../stores/useUIStore'

const toneIcon: Record<
  string,
  {
    Icon: React.ComponentType<{ size?: number; className?: string }>
    tone: 'negative' | 'positive' | 'warning' | 'info'
  }
> = {
  warn: { Icon: AlertTriangle, tone: 'warning' },
  up: { Icon: TrendingUp, tone: 'negative' },
  down: { Icon: TrendingDown, tone: 'positive' },
  good: { Icon: CheckCircle2, tone: 'positive' },
  info: { Icon: Info, tone: 'info' },
}

export function InsightsScreen() {
  const expenses = useExpenseStore((s) => s.expenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const fmt = useFormatMoney()

  const insights = useMemo(() => computeInsights(expenses, budgets), [expenses, budgets])
  const recurring = useMemo(() => detectRecurring(expenses), [expenses])
  const forecast14 = useMemo(() => forecastDailyFromRecurring(recurring, 14), [recurring])
  const monthAnalytics = useMemo(
    () => computeMonthAnalytics(expenses, budgets),
    [expenses, budgets],
  )
  const weekAnalytics = useMemo(() => computeWeekAnalytics(expenses), [expenses])
  const forecastTotal = forecast14.reduce((s, v) => s + v, 0)
  const weekTrendDown = weekAnalytics.changePct < 0
  const weekHasPrev = weekAnalytics.prevWeek > 0
  const [hoveredDay, setHoveredDay] = useState<number | null>(null)
  const hasEnoughSignal = expenses.length >= 3

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-white">Insights</h1>
          <p className="text-[13px] text-[var(--text-tertiary)]">
            Patterns, forecasts & spending trends.
          </p>
        </div>
      </div>

      {!hasEnoughSignal && (
        <EmptyState
          icon={Info}
          title="Insights need a few entries"
          description="Add at least three expenses to unlock patterns, forecasts, recurring charges, and trend comparisons."
          action={{ label: 'Add expense', onClick: () => setAddSheetOpen(true) }}
        />
      )}

      {hasEnoughSignal && (
        <>
          {/* Narrative insights */}
          <div className="grid gap-3 md:grid-cols-2">
            {insights.length === 0 ? (
              <div className="md:col-span-2">
                <EmptyState
                  icon={Info}
                  title="Not enough data yet"
                  description="Add a handful of expenses and come back - we'll surface patterns here."
                />
              </div>
            ) : (
              insights.map((ins) => {
                const tc = toneIcon[ins.tone] ?? toneIcon.info
                const { Icon } = tc
                return (
                  <div key={ins.id}>
                    <Card>
                      <div className="flex items-start gap-3">
                        <Pill tone={tc.tone}>
                          <Icon size={11} />
                        </Pill>
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px] font-semibold text-white">{ins.title}</div>
                          {ins.detail && (
                            <div className="mt-1 text-[12px] text-[var(--text-tertiary)]">
                              {ins.detail}
                            </div>
                          )}
                        </div>
                      </div>
                    </Card>
                  </div>
                )
              })
            )}
          </div>

          {/* Week vs last week */}
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <TrendingUp size={14} className="text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">Week vs last week</h2>
              </div>
              {weekHasPrev && (
                <Pill tone={weekTrendDown ? 'positive' : 'negative'}>
                  {weekTrendDown ? <ArrowDown size={10} /> : <ArrowUp size={10} />}
                  {Math.abs(weekAnalytics.changePct * 100).toFixed(0)}%
                </Pill>
              )}
            </div>
            {(() => {
              const BAR_H = 56 // px - fixed container height for bars
              const maxVal = Math.max(...weekAnalytics.dailyThisWeek.map((x) => x.total), 1)
              return (
                <div className="mb-3 flex items-end gap-1.5">
                  {weekAnalytics.dailyThisWeek.map((d, i) => {
                    const pct = d.total / maxVal
                    const barPx = Math.round(d.total > 0 ? Math.max(3, pct * BAR_H) : 0)
                    const isToday = d.date === format(new Date(), 'yyyy-MM-dd')
                    const isHovered = hoveredDay === i
                    return (
                      <div
                        key={d.date}
                        className="flex flex-1 cursor-default flex-col items-center gap-1"
                        onPointerEnter={() => setHoveredDay(i)}
                        onPointerLeave={() => setHoveredDay(null)}
                        onClick={() => setHoveredDay(hoveredDay === i ? null : i)}
                      >
                        <div
                          className="relative flex w-full flex-col justify-end"
                          style={{ height: BAR_H }}
                        >
                          {isHovered && (
                            <span className="pointer-events-none absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow">
                              ${d.total.toFixed(2)}
                            </span>
                          )}
                          <div
                            className={`w-full rounded-t transition-all duration-300 ${
                              isToday
                                ? 'bg-accent shadow-[0_0_8px_-2px_rgba(34,211,238,0.5)]'
                                : isHovered
                                  ? 'bg-white/30'
                                  : 'bg-white/15'
                            }`}
                            style={{ height: barPx }}
                          />
                        </div>
                        <span
                          className={`text-[9px] leading-none ${isToday ? 'font-semibold text-accent' : 'text-[var(--text-tertiary)]'}`}
                        >
                          {d.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            <div className="flex items-center justify-between text-[12px]">
              <div>
                <span className="text-[var(--text-tertiary)]">This week </span>
                <span className="font-mono font-semibold tabular-nums text-white">
                  {fmt(weekAnalytics.thisWeek)}
                </span>
              </div>
              {weekHasPrev && (
                <div>
                  <span className="text-[var(--text-tertiary)]">Last week </span>
                  <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                    {fmt(weekAnalytics.prevWeek)}
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Forecast */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar size={14} className="text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">14-day forecast</h2>
              </div>
              <span className="font-mono text-[13px] tabular-nums text-white">
                {fmt(forecastTotal)}
              </span>
            </div>
            {forecastTotal <= 0 ? (
              <p className="text-[12px] text-[var(--text-tertiary)]">
                {recurring.length > 0
                  ? 'No recurring charges due in the next 14 days.'
                  : "No recurring charges detected yet. After 3+ repeats of the same item we'll project them here."}
              </p>
            ) : (
              <>
                <div className="flex h-20 items-end justify-between gap-1">
                  {forecast14.map((v, i) => {
                    const max = Math.max(...forecast14, 1)
                    const pct = (v / max) * 100
                    return (
                      <div key={i} className="flex flex-1 flex-col items-center gap-1">
                        <div className="flex w-full flex-1 items-end">
                          <div
                            className="w-full rounded-t bg-gradient-to-t from-accent/40 to-accent/80 transition-all"
                            style={{ height: `${Math.max(2, pct)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
                  <span>{format(new Date(), 'MMM d')}</span>
                  <span>{format(addDays(new Date(), 13), 'MMM d')}</span>
                </div>
              </>
            )}
          </Card>

          {/* 30-day trend recap */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-white">Spending trend</h2>
              <span className="text-[11px] text-[var(--text-tertiary)]">Last 30 days</span>
            </div>
            <Sparkline
              data={monthAnalytics.daily.map((d) => d.total)}
              labels={monthAnalytics.daily.map((d) => {
                const dt = new Date(d.date + 'T12:00:00')
                return format(dt, 'MMM d')
              })}
              height={72}
            />
            <div className="mt-1.5 flex justify-between">
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {format(subDays(new Date(), 29), 'MMM d')}
              </span>
              <span className="text-[10px] text-[var(--text-tertiary)]">
                {format(subDays(new Date(), 14), 'MMM d')}
              </span>
              <span className="text-[10px] text-accent">Today</span>
            </div>
          </Card>

          {/* Recurring detection */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Repeat size={14} className="text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">Recurring patterns</h2>
              </div>
              <span className="text-[11px] text-[var(--text-tertiary)]">
                {recurring.length} detected
              </span>
            </div>
            {recurring.length === 0 ? (
              <p className="text-[12px] text-[var(--text-tertiary)]">
                No repeating charges detected yet.
              </p>
            ) : (
              <ul className="divide-y divide-white/[0.04]">
                {recurring.slice(0, 8).map((r) => (
                  <li key={r.key} className="flex items-center gap-3 py-2.5">
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colorFromString(r.category) }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-white">{r.displayName}</div>
                      <div className="text-[11px] text-[var(--text-tertiary)]">
                        {r.periodicity} / next ~{format(r.nextEstimatedDate, 'MMM d')} /{' '}
                        {r.occurrences.length} hits
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-[13px] tabular-nums text-white">
                        {fmt(r.avgAmount)}
                      </div>
                      <div className="ml-auto mt-0.5 h-1 w-16 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-500"
                          style={{ width: `${Math.round(r.confidence * 100)}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
