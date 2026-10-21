import { useMemo, useState } from 'react'
import {
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Info,
  Repeat,
  Calendar,
  Activity,
} from 'lucide-react'
import { useExpenseStore } from '../../stores/useExpenseStore'
import { computeInsights, type InsightTone } from '../../utils/insights'
import { detectRecurring, forecastDailyFromRecurring, upcomingDue } from '../../utils/recurring'
import { computeTrailingDaily, computeWeekAnalytics } from '../../lib/analytics'
import { addDays, formatRangeLabel, shortDate } from '../../lib/dates'
import { getLedgerIndex } from '../../lib/ledgerIndex'
import { Card } from '../../ui/Card'
import { ChangePill } from '../../ui/ChangePill'
import { Pill } from '../../ui/Pill'
import { EmptyState } from '../../ui/EmptyState'
import { Sparkline, SparklineAxis } from '../pulse/Sparkline'
import { ForecastChart } from './ForecastChart'
import { useFormatMoney } from '../../hooks/useFormatMoney'
import { useToday } from '../../hooks/useToday'
import { colorFromString } from '../../lib/analytics'
import { useUIStore } from '../../stores/useUIStore'

const toneIcon: Record<
  InsightTone,
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

const WEEK_BAR_H = 56 // px
const FORECAST_DAYS = 14

export function InsightsScreen() {
  const expenses = useExpenseStore((s) => s.expenses)
  const budgets = useExpenseStore((s) => s.budgets)
  const setAddSheetOpen = useUIStore((s) => s.setAddSheetOpen)
  const fmt = useFormatMoney()
  const today = useToday()
  const index = getLedgerIndex(expenses)

  const insights = useMemo(
    () => computeInsights(index, budgets, today, fmt),
    [index, budgets, today, fmt],
  )
  const recurring = detectRecurring(index) // memoised per index
  const forecast = useMemo(
    () => forecastDailyFromRecurring(recurring, today, FORECAST_DAYS),
    [recurring, today],
  )
  const week = useMemo(() => computeWeekAnalytics(index, today), [index, today])
  const { trendValues, trendLabels } = useMemo(() => {
    const trend = computeTrailingDaily(index, today, 30)
    return {
      trendValues: trend.map((d) => d.total),
      trendLabels: trend.map((d) => shortDate(d.date)),
    }
  }, [index, today])
  const forecastTotal = forecast.reduce((s, v) => s + v, 0)
  const weekMax = Math.max(...week.dailyThisWeek.map((x) => x.total), 1)
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
                const tc = toneIcon[ins.tone]
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

          {/* Last 7 days vs the previous 7 */}
          <Card>
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <TrendingUp size={14} className="shrink-0 text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">Last 7 days</h2>
                <span className="truncate text-[11px] text-[var(--text-tertiary)]">
                  {formatRangeLabel(week.range, today)}
                </span>
              </div>
              {/* Same rule as the Pulse pill: within ±0.5% it reads "≈ same as …" */}
              <ChangePill change={week.changePct} against="previous 7 days" digits={0} />
            </div>
            {/* The top padding holds a tall bar's amount, so it never covers the heading. */}
            <div className="mb-3 flex items-end gap-1.5 pt-6">
              {week.dailyThisWeek.map((d, i) => {
                const barPx = Math.round(
                  d.total > 0 ? Math.max(3, (d.total / weekMax) * WEEK_BAR_H) : 0,
                )
                const isToday = d.date === today
                const isHovered = hoveredDay === i
                return (
                  <div
                    key={d.date}
                    className="flex flex-1 cursor-default flex-col items-center gap-1"
                    // Hover reads a day with a mouse; a tap toggles it. A finger also fires
                    // pointerenter, which would open the amount and let the tap close it again.
                    onPointerEnter={(e) => {
                      if (e.pointerType === 'mouse') setHoveredDay(i)
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === 'mouse') setHoveredDay(null)
                    }}
                    onClick={() => {
                      setHoveredDay((h) => (h === i ? null : i))
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${d.label}, ${shortDate(d.date)}: ${fmt(d.total)}`}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setHoveredDay((h) => (h === i ? null : i))
                      }
                    }}
                  >
                    <div
                      className="relative flex w-full flex-col justify-end"
                      style={{ height: WEEK_BAR_H }}
                    >
                      {isHovered && (
                        <span className="pointer-events-none absolute -top-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-white/10 bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow">
                          {fmt(d.total)}
                        </span>
                      )}
                      <div
                        className={`w-full rounded-t transition-all duration-300 ${
                          isToday
                            ? 'bg-accent shadow-[0_0_8px_-2px_rgba(34,211,238,0.5)]'
                            : isHovered
                              ? 'bg-[var(--chart-bar-strong)]'
                              : 'bg-[var(--chart-bar)]'
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
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[12px]">
              <div>
                <span className="text-[var(--text-tertiary)]">Last 7 days </span>
                <span className="font-mono font-semibold tabular-nums text-white">
                  {fmt(week.thisWeek)}
                </span>
              </div>
              {week.prevWeek > 0 && (
                <div>
                  <span className="text-[var(--text-tertiary)]">Previous 7 days </span>
                  <span className="font-mono tabular-nums text-[var(--text-secondary)]">
                    {fmt(week.prevWeek)}
                  </span>
                </div>
              )}
            </div>
          </Card>

          {/* Forecast */}
          <Card>
            <div className="mb-1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Calendar size={14} className="text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">14-day forecast</h2>
              </div>
              <span className="font-mono text-[13px] tabular-nums text-white">
                {fmt(forecastTotal)}
              </span>
            </div>
            {forecastTotal <= 0 ? (
              <p className="mt-2 text-[12px] text-[var(--text-tertiary)]">
                {recurring.length > 0
                  ? 'No recurring charges due in the next 14 days.'
                  : "No recurring charges detected yet. After 3+ repeats of the same item we'll project them here."}
              </p>
            ) : (
              <>
                <ForecastChart forecast={forecast} today={today} fmt={fmt} />
                <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
                  <span className="text-accent">Today</span>
                  <span>{shortDate(addDays(today, 7))}</span>
                  <span>{shortDate(addDays(today, FORECAST_DAYS - 1))}</span>
                </div>
              </>
            )}
          </Card>

          {/* 30-day trend recap */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity size={14} className="text-accent/80" />
                <h2 className="text-[13px] font-semibold text-white">Spending trend</h2>
              </div>
              <span className="text-[11px] text-[var(--text-tertiary)]">Last 30 days</span>
            </div>
            <Sparkline data={trendValues} labels={trendLabels} height={72} />
            <SparklineAxis labels={trendLabels} lastLabel="Today" highlightLast />
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
                {recurring.slice(0, 8).map((r) => {
                  // A charge just missed is due today, as the forecast files it; never a past "next".
                  const due = upcomingDue(r, today)
                  const dueText =
                    due === null
                      ? ''
                      : due === today
                        ? ' / due today'
                        : ` / next ~${shortDate(due)}`
                  return (
                    <li key={r.key} className="flex items-center gap-3 py-2.5">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: colorFromString(r.category) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-white">{r.displayName}</div>
                        <div className="text-[11px] text-[var(--text-tertiary)]">
                          {r.periodicity}
                          {dueText} / {r.occurrences.length} hits
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[13px] tabular-nums text-white">
                          {fmt(r.avgAmount)}
                        </div>
                        <div className="ml-auto mt-0.5 h-1 w-16 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-accent transition-[width] duration-500"
                            style={{ width: `${String(Math.round(r.confidence * 100))}%` }}
                          />
                        </div>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
