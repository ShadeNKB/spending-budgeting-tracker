import { parseISO, differenceInDays } from "date-fns";
import Fuse from "fuse.js";
import type { Expense } from "../types";

export interface RecurringGroup {
  key: string;              // normalized item name
  displayName: string;      // most recent original name
  category: string;
  occurrences: Expense[];
  avgAmount: number;
  avgGapDays: number;       // average spacing between instances
  periodicity: "weekly" | "biweekly" | "monthly" | "irregular";
  nextEstimatedDate: Date;  // predicted next hit
  confidence: number;       // 0–1 based on gap variance
}

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * Detects expenses that repeat 3+ times on similar dates.
 * Groups by fuzzy item name, then evaluates gap consistency.
 */
export function detectRecurring(expenses: Expense[]): RecurringGroup[] {
  if (expenses.length < 3) return [];

  // 1. Bucket by exact normalized name
  const buckets = new Map<string, Expense[]>();
  for (const e of expenses) {
    const k = norm(e.itemName);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(e);
  }

  // 2. Absorb near-identical buckets via fuzzy match (e.g. "spotify" vs "spotify premium")
  const keys = Array.from(buckets.keys());
  const merged = new Map<string, Expense[]>();
  const claimed = new Set<string>();
  const fuse = new Fuse(keys, { threshold: 0.25 });

  for (const k of keys) {
    if (claimed.has(k)) continue;
    const groupList = [...(buckets.get(k) ?? [])];
    const hits = fuse.search(k).map((h) => h.item).filter((k2) => k2 !== k && !claimed.has(k2));
    for (const h of hits) {
      groupList.push(...(buckets.get(h) ?? []));
      claimed.add(h);
    }
    claimed.add(k);
    merged.set(k, groupList);
  }

  const groups: RecurringGroup[] = [];

  for (const [key, items] of merged.entries()) {
    if (items.length < 3) continue;

    const sorted = [...items].sort(
      (a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime()
    );
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const g = differenceInDays(parseISO(sorted[i].date), parseISO(sorted[i - 1].date));
      if (g > 0) gaps.push(g);
    }
    if (gaps.length < 2) continue;

    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance =
      gaps.reduce((s, g) => s + (g - avgGap) ** 2, 0) / gaps.length;
    const stdDev = Math.sqrt(variance);
    // Confidence: low variance relative to mean → higher confidence
    const relativeStdDev = avgGap > 0 ? stdDev / avgGap : 1;
    const confidence = Math.max(0, Math.min(1, 1 - relativeStdDev));

    // Ignore groups where timing is too scattered
    if (confidence < 0.45) continue;

    let periodicity: RecurringGroup["periodicity"];
    if (avgGap <= 10) periodicity = "weekly";
    else if (avgGap <= 18) periodicity = "biweekly";
    else if (avgGap <= 45) periodicity = "monthly";
    else periodicity = "irregular";

    const lastDate = parseISO(sorted[sorted.length - 1].date);
    const nextEstimatedDate = new Date(lastDate);
    nextEstimatedDate.setDate(lastDate.getDate() + Math.round(avgGap));

    const avgAmount =
      items.reduce((s, e) => s + e.amount, 0) / items.length;

    groups.push({
      key,
      displayName: sorted[sorted.length - 1].itemName,
      category: sorted[sorted.length - 1].category,
      occurrences: sorted,
      avgAmount,
      avgGapDays: avgGap,
      periodicity,
      nextEstimatedDate,
      confidence,
    });
  }

  return groups.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Projects expected spending for the next N days based on recurring groups.
 * Returns one number per day (0-indexed from today = slot 0).
 */
export function forecastDailyFromRecurring(
  groups: RecurringGroup[],
  days: number
): number[] {
  const bins = new Array(days).fill(0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const g of groups) {
    if (g.confidence < 0.5) continue;
    const start = new Date(g.nextEstimatedDate);
    start.setHours(0, 0, 0, 0);
    // Place the first projected hit, then repeat every avgGap
    let d = start;
    while (true) {
      const offset = Math.round((d.getTime() - today.getTime()) / 86400000);
      if (offset >= days) break;
      if (offset >= 0) bins[offset] += g.avgAmount;
      d = new Date(d.getTime() + Math.round(g.avgGapDays) * 86400000);
    }
  }

  return bins;
}
