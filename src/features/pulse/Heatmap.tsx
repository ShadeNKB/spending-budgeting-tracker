import { useNavigate } from "react-router-dom";
import { format, parseISO, isToday, getDay } from "date-fns";
import clsx from "clsx";
import { formatMoney } from "../../lib/format";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({ data }: { data: { date: string; total: number }[] }) {
  const navigate = useNavigate();
  const max = Math.max(...data.map((d) => d.total), 1);

  // Break into weeks (7-row columns)
  const weeks: { date: string; total: number }[][] = [];
  for (let i = 0; i < data.length; i += 7) weeks.push(data.slice(i, i + 7));

  const level = (total: number) => {
    if (total === 0) return 0;
    const r = total / max;
    if (r < 0.25) return 1;
    if (r < 0.5) return 2;
    if (r < 0.75) return 3;
    return 4;
  };

  const colors = [
    "bg-surface-2 border-white/[0.04]",
    "bg-accent/15 border-accent/20",
    "bg-accent/30 border-accent/30",
    "bg-accent/55 border-accent/40",
    "bg-accent border-accent",
  ];

  // Determine month label for each column: show label when month changes
  const monthLabels: (string | null)[] = weeks.map((week, wi) => {
    const firstDay = week.find((d) => d);
    if (!firstDay) return null;
    const date = parseISO(firstDay.date);
    // Show label on first week or when month changes from previous week
    if (wi === 0) return format(date, "MMM");
    const prevWeek = weeks[wi - 1];
    const prevFirst = prevWeek?.find((d) => d);
    if (!prevFirst) return null;
    const prevDate = parseISO(prevFirst.date);
    if (format(date, "MMM") !== format(prevDate, "MMM")) {
      return format(date, "MMM");
    }
    return null;
  });

  // Day-of-week labels: show Mon, Wed, Fri (indices 1, 3, 5)
  const dayRows = [0, 1, 2, 3, 4, 5, 6];

  return (
    <div>
      <div className="flex gap-[3px]">
        {/* Day-of-week labels column */}
        <div className="flex flex-col gap-[3px] mr-1 shrink-0">
          {/* Spacer for month label row */}
          <div className="h-[14px]" />
          {dayRows.map((di) => (
            <div key={di} className="h-[13px] flex items-center">
              {(di === 1 || di === 3 || di === 5) ? (
                <span className="text-[9px] text-[var(--text-tertiary)] leading-none w-6 text-right pr-1">
                  {DAY_LABELS[di]}
                </span>
              ) : (
                <span className="w-6" />
              )}
            </div>
          ))}
        </div>

        {/* Grid */}
        <div className="flex gap-[3px] overflow-x-auto no-scrollbar pb-1 flex-1">
          {weeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px] shrink-0">
              {/* Month label */}
              <div className="h-[14px] flex items-end">
                {monthLabels[wi] && (
                  <span className="text-[9px] font-medium text-[var(--text-tertiary)] leading-none whitespace-nowrap">
                    {monthLabels[wi]}
                  </span>
                )}
              </div>
              {/* Day cells */}
              {Array.from({ length: 7 }).map((_, di) => {
                const d = week[di];
                if (!d) return <div key={di} className="h-[13px] w-[13px]" />;
                const todayCell = isToday(parseISO(d.date));
                const dayOfWeek = getDay(parseISO(d.date));
                const dayName = DAY_LABELS[dayOfWeek];
                return (
                  <button
                    key={d.date}
                    title={`${dayName}, ${format(parseISO(d.date), "MMM d")} · ${d.total > 0 ? formatMoney(d.total) : "No spending"}`}
                    onClick={() => d.total > 0 && navigate(`/ledger?date=${d.date}`)}
                    className={clsx(
                      "h-[13px] w-[13px] rounded-[3px] border transition-transform hover:scale-125",
                      colors[level(d.total)],
                      todayCell && "ring-1 ring-offset-1 ring-offset-surface-1 ring-white/70",
                      d.total > 0 ? "cursor-pointer" : "cursor-default"
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="mt-2.5 flex items-center justify-between text-[10px] text-[var(--text-tertiary)]">
        <span>
          {data.length > 0 && (
            <>
              {format(parseISO(data[0].date), "MMM d")}
              {" – "}
              {format(parseISO(data[data.length - 1].date), "MMM d, yyyy")}
            </>
          )}
        </span>
        <div className="flex items-center gap-1">
          <span>less</span>
          {colors.map((c, i) => (
            <span key={i} className={clsx("h-[10px] w-[10px] rounded-[2px] border", c)} />
          ))}
          <span>more</span>
        </div>
      </div>
    </div>
  );
}
